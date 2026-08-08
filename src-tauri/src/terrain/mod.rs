//! Terrain slope from AWS Terrarium elevation tiles.
//!
//! Fetches Mapzen/Tilezen Terrarium PNGs for a WGS84 bbox, decodes metres,
//! computes finite-difference slope, and returns either a colourised preview
//! (map paint) or zonal mean/max for site screening. Tiles cache under
//! `{dataDir}/cache/elevation/{z}/{x}/{y}.png`.

use std::f64::consts::PI;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::raster::preview::{GeoBounds, ViewportPreview};
use crate::USER_AGENT;

const TILE_SIZE: u32 = 256;
const MAX_TILES: u32 = 64;
const MAX_OUTPUT_PIXELS: u64 = 262_144;
const EARTH_RADIUS_M: f64 = 6_378_137.0;

/// Flat (green) → steep (amber/red) ramp for slope percent display.
const SLOPE_RAMP: &[(f64, u8, u8, u8)] = &[
    (0.00, 0x2d, 0x6a, 0x4f),
    (0.25, 0x95, 0xd5, 0xb2),
    (0.50, 0xd9, 0xa4, 0x41),
    (0.75, 0xe0, 0x7a, 0x45),
    (1.00, 0x9b, 0x22, 0x26),
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerrainBounds {
    pub min_lon: f64,
    pub min_lat: f64,
    pub max_lon: f64,
    pub max_lat: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerrainSlopePreviewRequest {
    pub min_lon: f64,
    pub min_lat: f64,
    pub max_lon: f64,
    pub max_lat: f64,
    #[serde(default = "default_max_tiles")]
    pub max_tiles: u32,
}

fn default_max_tiles() -> u32 {
    MAX_TILES
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerrainSlopeZonalRequest {
    /// Outer ring first (GeoJSON-style); closing vertex optional.
    pub rings: Vec<Vec<[f64; 2]>>,
    #[serde(default = "default_max_tiles")]
    pub max_tiles: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerrainSlopeZonalResult {
    pub mean_slope_degrees: f64,
    pub max_slope_degrees: f64,
    pub mean_elevation_m: Option<f64>,
    pub sample_count: u64,
    pub method: String,
    pub zoom: u32,
}

struct ElevationGrid {
    width: u32,
    height: u32,
    /// Row-major elevations in metres; NaN = missing.
    data: Vec<f64>,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    zoom: u32,
}

impl ElevationGrid {
    fn lon_lat_of(&self, col: u32, row: u32) -> (f64, f64) {
        let lon = self.west + (col as f64 + 0.5) / self.width as f64 * (self.east - self.west);
        let lat = self.north - (row as f64 + 0.5) / self.height as f64 * (self.north - self.south);
        (lon, lat)
    }

    fn elev(&self, col: i32, row: i32) -> Option<f64> {
        if col < 0 || row < 0 || col as u32 >= self.width || row as u32 >= self.height {
            return None;
        }
        let v = self.data[row as usize * self.width as usize + col as usize];
        if v.is_finite() {
            Some(v)
        } else {
            None
        }
    }
}

/// Decode Terrarium RGB → elevation metres.
pub fn terrarium_decode(r: u8, g: u8, b: u8) -> f64 {
    (r as f64) * 256.0 + (g as f64) + (b as f64) / 256.0 - 32_768.0
}

fn lon_to_tile_x(lon: f64, z: u32) -> f64 {
    let n = (1u32 << z) as f64;
    (lon + 180.0) / 360.0 * n
}

fn lat_to_tile_y(lat: f64, z: u32) -> f64 {
    let lat = lat.clamp(-85.051_128_78, 85.051_128_78);
    let n = (1u32 << z) as f64;
    let lat_rad = lat.to_radians();
    (1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / PI) / 2.0 * n
}

fn tile_west(x: u32, z: u32) -> f64 {
    let n = (1u32 << z) as f64;
    x as f64 / n * 360.0 - 180.0
}

fn tile_north(y: u32, z: u32) -> f64 {
    let n = (1u32 << z) as f64;
    let y_n = y as f64 / n;
    let lat_rad = (PI * (1.0 - 2.0 * y_n)).sinh().atan();
    lat_rad.to_degrees()
}

fn tile_south(y: u32, z: u32) -> f64 {
    tile_north(y + 1, z)
}

fn tile_east(x: u32, z: u32) -> f64 {
    tile_west(x + 1, z)
}

fn pick_zoom(bounds: &TerrainBounds, max_tiles: u32) -> u32 {
    let max_tiles = max_tiles.max(1);
    for z in (0..=14).rev() {
        let x0 = lon_to_tile_x(bounds.min_lon, z).floor() as i64;
        let x1 = lon_to_tile_x(bounds.max_lon, z).floor() as i64;
        let y0 = lat_to_tile_y(bounds.max_lat, z).floor() as i64;
        let y1 = lat_to_tile_y(bounds.min_lat, z).floor() as i64;
        let nx = (x1 - x0 + 1).max(1) as u32;
        let ny = (y1 - y0 + 1).max(1) as u32;
        if nx.saturating_mul(ny) <= max_tiles {
            return z;
        }
    }
    0
}

fn tile_url(z: u32, x: u32, y: u32) -> String {
    format!("https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png")
}

fn tile_cache_path(cache_root: &Path, z: u32, x: u32, y: u32) -> PathBuf {
    cache_root
        .join("elevation")
        .join(z.to_string())
        .join(x.to_string())
        .join(format!("{y}.png"))
}

fn fetch_tile_bytes(cache_root: &Path, z: u32, x: u32, y: u32) -> Result<Vec<u8>> {
    let path = tile_cache_path(cache_root, z, x, y);
    if path.exists() {
        return Ok(fs::read(&path)?);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let url = tile_url(z, x, y);
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
    let response = client.get(&url).send()?;
    if !response.status().is_success() {
        return Err(Error::Http(format!(
            "Terrarium tile {z}/{x}/{y} returned {}",
            response.status()
        )));
    }
    let bytes = response.bytes()?.to_vec();
    if let Err(error) = fs::write(&path, &bytes) {
        eprintln!("[sunday terrain] cache write failed: {error}");
    }
    Ok(bytes)
}

fn decode_terrarium_png(bytes: &[u8]) -> Result<Vec<f64>> {
    let decoder = png::Decoder::new(Cursor::new(bytes));
    let mut reader = decoder
        .read_info()
        .map_err(|e| Error::Invalid(format!("PNG decode failed: {e}")))?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| Error::Invalid(format!("PNG frame failed: {e}")))?;
    let width = info.width;
    let height = info.height;
    if width != TILE_SIZE || height != TILE_SIZE {
        return Err(Error::Invalid(format!(
            "expected {TILE_SIZE}×{TILE_SIZE} Terrarium tile, got {width}×{height}"
        )));
    }
    let mut elev = Vec::with_capacity((TILE_SIZE * TILE_SIZE) as usize);
    match info.color_type {
        png::ColorType::Rgb => {
            for chunk in buf[..info.buffer_size()].chunks_exact(3) {
                elev.push(terrarium_decode(chunk[0], chunk[1], chunk[2]));
            }
        }
        png::ColorType::Rgba => {
            for chunk in buf[..info.buffer_size()].chunks_exact(4) {
                elev.push(terrarium_decode(chunk[0], chunk[1], chunk[2]));
            }
        }
        other => {
            return Err(Error::Invalid(format!(
                "unsupported Terrarium colour type: {other:?}"
            )));
        }
    }
    Ok(elev)
}

fn build_elevation_grid(cache_root: &Path, bounds: &TerrainBounds, max_tiles: u32) -> Result<ElevationGrid> {
    if !(bounds.min_lon < bounds.max_lon && bounds.min_lat < bounds.max_lat) {
        return Err(Error::Invalid("bounding box is inverted".into()));
    }
    let z = pick_zoom(bounds, max_tiles);
    let x0 = lon_to_tile_x(bounds.min_lon, z).floor().max(0.0) as u32;
    let x1 = lon_to_tile_x(bounds.max_lon, z).floor() as u32;
    let y0 = lat_to_tile_y(bounds.max_lat, z).floor().max(0.0) as u32;
    let y1 = lat_to_tile_y(bounds.min_lat, z).floor() as u32;
    let n = 1u32 << z;
    let x1 = x1.min(n.saturating_sub(1));
    let y1 = y1.min(n.saturating_sub(1));
    let nx = x1.saturating_sub(x0) + 1;
    let ny = y1.saturating_sub(y0) + 1;
    if nx.saturating_mul(ny) > max_tiles.max(1) {
        return Err(Error::Invalid(format!(
            "Screening area needs too many elevation tiles ({nx}×{ny}). Zoom in or draw a smaller area."
        )));
    }

    let width = nx * TILE_SIZE;
    let height = ny * TILE_SIZE;
    let mut data = vec![f64::NAN; (width * height) as usize];

    for ty in y0..=y1 {
        for tx in x0..=x1 {
            let bytes = fetch_tile_bytes(cache_root, z, tx, ty)?;
            let tile = decode_terrarium_png(&bytes)?;
            let ox = (tx - x0) * TILE_SIZE;
            let oy = (ty - y0) * TILE_SIZE;
            for row in 0..TILE_SIZE {
                for col in 0..TILE_SIZE {
                    let src = (row * TILE_SIZE + col) as usize;
                    let dst = ((oy + row) * width + (ox + col)) as usize;
                    data[dst] = tile[src];
                }
            }
        }
    }

    Ok(ElevationGrid {
        width,
        height,
        data,
        west: tile_west(x0, z),
        east: tile_east(x1, z),
        north: tile_north(y0, z),
        south: tile_south(y1, z),
        zoom: z,
    })
}

/// Horn finite-difference slope in degrees.
fn slope_degrees_grid(elev: &ElevationGrid) -> Vec<f64> {
    let mut out = vec![f64::NAN; elev.data.len()];
    let mid_lat = (elev.north + elev.south) / 2.0;
    let dlon = (elev.east - elev.west) / elev.width as f64;
    let dlat = (elev.north - elev.south) / elev.height as f64;
    let dx = (dlon.to_radians() * EARTH_RADIUS_M * mid_lat.to_radians().cos()).abs().max(1e-3);
    let dy = (dlat.to_radians() * EARTH_RADIUS_M).abs().max(1e-3);

    for row in 1..elev.height.saturating_sub(1) {
        for col in 1..elev.width.saturating_sub(1) {
            let c = col as i32;
            let r = row as i32;
            let Some(z1) = elev.elev(c - 1, r - 1) else { continue };
            let Some(z2) = elev.elev(c, r - 1) else { continue };
            let Some(z3) = elev.elev(c + 1, r - 1) else { continue };
            let Some(z4) = elev.elev(c - 1, r) else { continue };
            let Some(z6) = elev.elev(c + 1, r) else { continue };
            let Some(z7) = elev.elev(c - 1, r + 1) else { continue };
            let Some(z8) = elev.elev(c, r + 1) else { continue };
            let Some(z9) = elev.elev(c + 1, r + 1) else { continue };
            // Horn (1981)
            let dzdx = ((z3 + 2.0 * z6 + z9) - (z1 + 2.0 * z4 + z7)) / (8.0 * dx);
            let dzdy = ((z7 + 2.0 * z8 + z9) - (z1 + 2.0 * z2 + z3)) / (8.0 * dy);
            let slope_rad = (dzdx * dzdx + dzdy * dzdy).sqrt().atan();
            out[row as usize * elev.width as usize + col as usize] = slope_rad.to_degrees();
        }
    }
    out
}

fn lerp_ramp(t: f64) -> (u8, u8, u8) {
    let t = t.clamp(0.0, 1.0);
    for window in SLOPE_RAMP.windows(2) {
        let (t0, r0, g0, b0) = window[0];
        let (t1, r1, g1, b1) = window[1];
        if t <= t1 {
            let u = if (t1 - t0).abs() < 1e-9 {
                0.0
            } else {
                (t - t0) / (t1 - t0)
            };
            let r = r0 as f64 + (r1 as f64 - r0 as f64) * u;
            let g = g0 as f64 + (g1 as f64 - g0 as f64) * u;
            let b = b0 as f64 + (b1 as f64 - b0 as f64) * u;
            return (r as u8, g as u8, b as u8);
        }
    }
    let last = SLOPE_RAMP[SLOPE_RAMP.len() - 1];
    (last.1, last.2, last.3)
}

fn encode_base64(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let (b0, b1, b2) = (
            chunk[0] as u32,
            chunk.get(1).copied().unwrap_or(0) as u32,
            chunk.get(2).copied().unwrap_or(0) as u32,
        );
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn point_in_ring(lon: f64, lat: f64, ring: &[[f64; 2]]) -> bool {
    // Ray casting; ring may or may not be closed.
    let n = ring.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (ring[i][0], ring[i][1]);
        let (xj, yj) = (ring[j][0], ring[j][1]);
        let intersect = ((yi > lat) != (yj > lat))
            && (lon < (xj - xi) * (lat - yi) / (yj - yi + f64::EPSILON) + xi);
        if intersect {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn ring_bounds(ring: &[[f64; 2]]) -> Option<TerrainBounds> {
    if ring.len() < 3 {
        return None;
    }
    let mut min_lon = f64::INFINITY;
    let mut min_lat = f64::INFINITY;
    let mut max_lon = f64::NEG_INFINITY;
    let mut max_lat = f64::NEG_INFINITY;
    for pt in ring {
        min_lon = min_lon.min(pt[0]);
        min_lat = min_lat.min(pt[1]);
        max_lon = max_lon.max(pt[0]);
        max_lat = max_lat.max(pt[1]);
    }
    if !min_lon.is_finite() {
        return None;
    }
    Some(TerrainBounds {
        min_lon,
        min_lat,
        max_lon,
        max_lat,
    })
}

/// Colourised slope preview for MapLibre (values stretched to viewport % domain).
pub fn slope_preview(cache_root: &Path, request: &TerrainSlopePreviewRequest) -> Result<ViewportPreview> {
    let bounds = TerrainBounds {
        min_lon: request.min_lon,
        min_lat: request.min_lat,
        max_lon: request.max_lon,
        max_lat: request.max_lat,
    };
    let elev = build_elevation_grid(cache_root, &bounds, request.max_tiles)?;
    let slope = slope_degrees_grid(&elev);

    // Downsample if needed.
    let total = elev.width as u64 * elev.height as u64;
    let step = if total > MAX_OUTPUT_PIXELS {
        ((total as f64 / MAX_OUTPUT_PIXELS as f64).sqrt().ceil() as u32).max(1)
    } else {
        1
    };
    let out_w = (elev.width + step - 1) / step;
    let out_h = (elev.height + step - 1) / step;

    let mut samples = Vec::new();
    for row in (0..elev.height).step_by(step as usize) {
        for col in (0..elev.width).step_by(step as usize) {
            let v = slope[row as usize * elev.width as usize + col as usize];
            if v.is_finite() {
                // Store as percent for colour stretch / legend.
                samples.push(v.to_radians().tan() * 100.0);
            }
        }
    }
    if samples.is_empty() {
        return Err(Error::NoData(
            "No elevation samples in this screening area. Check network access to AWS Terrarium tiles.".into(),
        ));
    }
    let min = samples.iter().copied().fold(f64::INFINITY, f64::min);
    let max = samples.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let span = (max - min).max(1e-6);

    let mut rgba = vec![0u8; (out_w * out_h * 4) as usize];
    let mut valid = 0u64;
    let mut oi = 0usize;
    for row in (0..elev.height).step_by(step as usize) {
        for col in (0..elev.width).step_by(step as usize) {
            let deg = slope[row as usize * elev.width as usize + col as usize];
            if deg.is_finite() {
                let pct = deg.to_radians().tan() * 100.0;
                let t = ((pct - min) / span).clamp(0.0, 1.0);
                let (r, g, b) = lerp_ramp(t);
                rgba[oi] = r;
                rgba[oi + 1] = g;
                rgba[oi + 2] = b;
                rgba[oi + 3] = 200;
                valid += 1;
            } else {
                rgba[oi + 3] = 0;
            }
            oi += 4;
        }
    }

    Ok(ViewportPreview {
        width: out_w,
        height: out_h,
        rgba_base64: encode_base64(&rgba),
        bounds: GeoBounds {
            west: elev.west,
            south: elev.south,
            east: elev.east,
            north: elev.north,
        },
        min,
        max,
        method: format!("terrarium-z{}-finite-difference", elev.zoom),
        level_scale: step as f64,
        valid_count: valid,
    })
}

/// Mean / max slope inside the first ring (degrees).
pub fn slope_zonal(cache_root: &Path, request: &TerrainSlopeZonalRequest) -> Result<TerrainSlopeZonalResult> {
    let ring = request
        .rings
        .first()
        .ok_or_else(|| Error::Invalid("site ring is required for terrain zonal stats".into()))?;
    let bounds = ring_bounds(ring)
        .ok_or_else(|| Error::Invalid("site ring is too small for terrain sampling".into()))?;
    // Slight pad so edge cells have neighbours for Horn.
    let pad = ((bounds.max_lon - bounds.min_lon) * 0.05)
        .max((bounds.max_lat - bounds.min_lat) * 0.05)
        .max(0.002);
    let padded = TerrainBounds {
        min_lon: bounds.min_lon - pad,
        min_lat: bounds.min_lat - pad,
        max_lon: bounds.max_lon + pad,
        max_lat: bounds.max_lat + pad,
    };
    let elev = build_elevation_grid(cache_root, &padded, request.max_tiles)?;
    let slope = slope_degrees_grid(&elev);

    let mut sum = 0.0_f64;
    let mut max_s = 0.0_f64;
    let mut elev_sum = 0.0_f64;
    let mut elev_n = 0u64;
    let mut n = 0u64;
    for row in 0..elev.height {
        for col in 0..elev.width {
            let (lon, lat) = elev.lon_lat_of(col, row);
            if !point_in_ring(lon, lat, ring) {
                continue;
            }
            let idx = row as usize * elev.width as usize + col as usize;
            let s = slope[idx];
            if s.is_finite() {
                sum += s;
                max_s = max_s.max(s);
                n += 1;
            }
            let e = elev.data[idx];
            if e.is_finite() {
                elev_sum += e;
                elev_n += 1;
            }
        }
    }
    if n == 0 {
        return Err(Error::NoData(
            "No slope samples inside the site boundary. Try a larger site or check network/cache.".into(),
        ));
    }
    Ok(TerrainSlopeZonalResult {
        mean_slope_degrees: sum / n as f64,
        max_slope_degrees: max_s,
        mean_elevation_m: if elev_n > 0 {
            Some(elev_sum / elev_n as f64)
        } else {
            None
        },
        sample_count: n,
        method: format!("terrarium-z{}-zonal", elev.zoom),
        zoom: elev.zoom,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terrarium_sea_level_decode() {
        // Common sea-level encoding around 32768 → 0 m.
        assert!((terrarium_decode(128, 0, 0) - 0.0).abs() < 1e-6);
    }

    #[test]
    fn pick_zoom_respects_tile_budget() {
        let bounds = TerrainBounds {
            min_lon: 24.0,
            min_lat: 60.0,
            max_lon: 25.0,
            max_lat: 61.0,
        };
        let z = pick_zoom(&bounds, 64);
        let x0 = lon_to_tile_x(bounds.min_lon, z).floor() as i64;
        let x1 = lon_to_tile_x(bounds.max_lon, z).floor() as i64;
        let y0 = lat_to_tile_y(bounds.max_lat, z).floor() as i64;
        let y1 = lat_to_tile_y(bounds.min_lat, z).floor() as i64;
        let count = ((x1 - x0 + 1) * (y1 - y0 + 1)) as u32;
        assert!(count <= 64, "z={z} count={count}");
    }

    #[test]
    fn flat_grid_has_near_zero_slope() {
        let w = 16u32;
        let h = 16u32;
        let elev = ElevationGrid {
            width: w,
            height: h,
            data: vec![100.0; (w * h) as usize],
            west: 0.0,
            east: 0.01,
            south: 0.0,
            north: 0.01,
            zoom: 10,
        };
        let slope = slope_degrees_grid(&elev);
        let mid = slope[(h / 2 * w + w / 2) as usize];
        assert!(mid.is_finite());
        assert!(mid < 0.5, "flat DEM should be near-level, got {mid}");
    }

    #[test]
    fn point_in_square_ring() {
        let ring = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.0, 0.0]];
        assert!(point_in_ring(0.5, 0.5, &ring));
        assert!(!point_in_ring(1.5, 0.5, &ring));
    }
}
