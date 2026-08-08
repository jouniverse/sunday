//! ESA WorldCover 2021 (v200) land-cover preview for screening AOIs.
//!
//! Streams classified Map COGs from the public AWS Open Data bucket via HTTP
//! range reads (same raster engine as GSA). No Install — paints only inside
//! the requested WGS84 bbox. Class colours match the ESA PUM Table 3 legend.

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::raster::preview::{
    self, encode_base64, lat_to_merc_y, lon_to_merc_x, merc_y_to_lat, output_dimensions,
    pick_level_for_budget, GeoBounds, ViewportPreview,
};
use crate::raster::{self, Window};

/// Hard ceiling on output RGBA pixels (~512²), matching terrain slope / GSA.
const MAX_OUTPUT_PIXELS: u64 = 262_144;
/// Cap pixels decoded from a single tile before resampling.
const MAX_READ_PIXELS: u64 = 1_500_000;
/// Screening AOIs rarely span many 3° tiles; keep fetches bounded.
const MAX_TILES: usize = 4;

const TILE_SIZE_DEG: f64 = 3.0;
const S3_PREFIX: &str =
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map";

/// Official ESA WorldCover Map codes → RGB (PUM Table 3).
const PALETTE: &[(u8, u8, u8, u8)] = &[
    (10, 0x00, 0x64, 0x00),   // Tree cover
    (20, 0xff, 0xbb, 0x22),   // Shrubland
    (30, 0xff, 0xff, 0x4c),   // Grassland
    (40, 0xf0, 0x96, 0xff),   // Cropland
    (50, 0xfa, 0x00, 0x00),   // Built-up
    (60, 0xb4, 0xb4, 0xb4),   // Bare / sparse
    (70, 0xf0, 0xf0, 0xf0),   // Snow and ice
    (80, 0x00, 0x64, 0xc8),   // Permanent water
    (90, 0x00, 0x96, 0xa0),   // Herbaceous wetland
    (95, 0x00, 0xcf, 0x75),   // Mangroves
    (100, 0xfa, 0xe6, 0xa0),  // Moss and lichen
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandcoverPreviewRequest {
    pub min_lon: f64,
    pub min_lat: f64,
    pub max_lon: f64,
    pub max_lat: f64,
    #[serde(default = "default_max_pixels")]
    pub max_pixels: u64,
}

fn default_max_pixels() -> u64 {
    MAX_OUTPUT_PIXELS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct TileOrigin {
    lat0: i32,
    lon0: i32,
}

impl TileOrigin {
    fn id(self) -> String {
        let ns = if self.lat0 >= 0 { 'N' } else { 'S' };
        let ew = if self.lon0 >= 0 { 'E' } else { 'W' };
        format!(
            "{}{:02}{}{:03}",
            ns,
            self.lat0.unsigned_abs(),
            ew,
            self.lon0.unsigned_abs()
        )
    }

    fn url(self) -> String {
        format!(
            "{S3_PREFIX}/ESA_WorldCover_10m_2021_v200_{}_Map.tif",
            self.id()
        )
    }

    fn west(self) -> f64 {
        self.lon0 as f64
    }
    fn south(self) -> f64 {
        self.lat0 as f64
    }
    fn east(self) -> f64 {
        self.lon0 as f64 + TILE_SIZE_DEG
    }
    fn north(self) -> f64 {
        self.lat0 as f64 + TILE_SIZE_DEG
    }
}

/// Lower-left 3° tile origin containing `(lon, lat)`.
fn tile_origin_for(lon: f64, lat: f64) -> TileOrigin {
    let lat0 = (lat.div_euclid(TILE_SIZE_DEG) * TILE_SIZE_DEG).round() as i32;
    let lon0 = (lon.div_euclid(TILE_SIZE_DEG) * TILE_SIZE_DEG).round() as i32;
    TileOrigin { lat0, lon0 }
}

/// All 3° tiles that intersect the closed bbox `[min, max)` / edges inclusive.
fn tiles_for_bbox(min_lon: f64, min_lat: f64, max_lon: f64, max_lat: f64) -> Result<Vec<TileOrigin>> {
    if min_lon > max_lon || min_lat > max_lat {
        return Err(Error::Invalid("bounding box is inverted".into()));
    }
    // Nudge max inward so a bbox ending exactly on a tile edge does not pull
    // an empty neighbouring tile.
    let max_lon_i = if max_lon > min_lon {
        max_lon - 1e-9
    } else {
        max_lon
    };
    let max_lat_i = if max_lat > min_lat {
        max_lat - 1e-9
    } else {
        max_lat
    };

    let sw = tile_origin_for(min_lon, min_lat);
    let ne = tile_origin_for(max_lon_i, max_lat_i);

    let mut tiles = Vec::new();
    let mut lat = sw.lat0;
    while lat <= ne.lat0 {
        let mut lon = sw.lon0;
        while lon <= ne.lon0 {
            tiles.push(TileOrigin { lat0: lat, lon0: lon });
            lon += TILE_SIZE_DEG as i32;
        }
        lat += TILE_SIZE_DEG as i32;
    }

    if tiles.is_empty() {
        return Err(Error::Invalid("bounding box covers no WorldCover tiles".into()));
    }
    if tiles.len() > MAX_TILES {
        return Err(Error::Invalid(format!(
            "screening area spans {} WorldCover tiles (max {MAX_TILES}); draw a smaller area",
            tiles.len()
        )));
    }
    Ok(tiles)
}

pub(crate) fn class_rgb(code: u8) -> Option<(u8, u8, u8)> {
    for &(c, r, g, b) in PALETTE {
        if c == code {
            return Some((r, g, b));
        }
    }
    None
}

/// Colourised categorical preview for a screening AOI bbox.
pub fn preview(request: &LandcoverPreviewRequest) -> Result<ViewportPreview> {
    if request.min_lon > request.max_lon || request.min_lat > request.max_lat {
        return Err(Error::Invalid("bounding box is inverted".into()));
    }
    if request.max_pixels == 0 {
        return Err(Error::Invalid("maxPixels must be > 0".into()));
    }

    let west = request.min_lon;
    let east = request.max_lon;
    let south = request.min_lat;
    let north = request.max_lat;
    let tiles = tiles_for_bbox(west, south, east, north)?;

    let (out_w, out_h) = output_dimensions(west, south, east, north, request.max_pixels);
    let mut rgba = vec![0u8; (out_w * out_h) as usize * 4];
    let mut class_buf = vec![0u8; (out_w * out_h) as usize];
    let mut valid_count = 0u64;

    let y_north = lat_to_merc_y(north);
    let y_south = lat_to_merc_y(south);
    let x_west = lon_to_merc_x(west);
    let x_east = lon_to_merc_x(east);

    for tile in &tiles {
        let clip_w = west.max(tile.west());
        let clip_e = east.min(tile.east());
        let clip_s = south.max(tile.south());
        let clip_n = north.min(tile.north());
        if clip_w >= clip_e || clip_s >= clip_n {
            continue;
        }

        let url = tile.url();
        let mut open = raster::open_http(&url).map_err(|e| {
            Error::Http(format!(
                "WorldCover tile {} unavailable ({e}). Check network access to AWS Open Data.",
                tile.id()
            ))
        })?;

        if open.info.levels.is_empty() {
            return Err(Error::Invalid(format!(
                "WorldCover tile {} has no resolution levels",
                tile.id()
            )));
        }

        let base = open.info.transform;
        let full_w = open.info.width;
        let full_h = open.info.height;
        let (fx0, fy0, fx1, fy1) = base.bbox_to_pixels(clip_w, clip_s, clip_e, clip_n);
        let bbox_w = (fx1 - fx0 + 1).max(1) as f64;
        let bbox_h = (fy1 - fy0 + 1).max(1) as f64;

        let level = pick_level_for_budget(
            &open.info.levels,
            full_w,
            full_h,
            bbox_w,
            bbox_h,
            MAX_READ_PIXELS,
        );
        let level_tf = base.for_overview(full_w, full_h, level.width, level.height);
        let (x0, y0, x1, y1) = level_tf.bbox_to_pixels(clip_w, clip_s, clip_e, clip_n);
        let window = match Window::clip(x0, y0, x1, y1, level.width, level.height) {
            Some(w) => w,
            None => continue,
        };

        if window.pixel_count() > 4_000_000 {
            return Err(Error::Invalid(format!(
                "land cover preview would decode {} pixels from {}; draw a smaller screening area",
                window.pixel_count(),
                tile.id()
            )));
        }

        let raw = raster::read_window(&mut open, level, window, 0)?;
        let (src_w, src_h, src_values, stride) =
            preview::decimate_window(&raw, window.width, window.height, MAX_READ_PIXELS);

        let src_tf = crate::raster::geotransform::GeoTransform {
            origin_x: level_tf.origin_x + window.x as f64 * level_tf.pixel_width,
            origin_y: level_tf.origin_y + window.y as f64 * level_tf.pixel_height,
            pixel_width: level_tf.pixel_width * stride as f64,
            pixel_height: level_tf.pixel_height * stride as f64,
        };

        // Paint only output pixels whose centres fall inside this tile clip.
        for row in 0..out_h {
            let y = y_north - (row as f64 + 0.5) / out_h as f64 * (y_north - y_south);
            let lat = merc_y_to_lat(y);
            if lat < clip_s || lat > clip_n {
                continue;
            }
            for col in 0..out_w {
                let lon = x_west + (col as f64 + 0.5) / out_w as f64 * (x_east - x_west);
                if lon < clip_w || lon > clip_e {
                    continue;
                }
                let idx = (row * out_w + col) as usize;
                if class_buf[idx] != 0 {
                    continue;
                }
                let (fx, fy) = src_tf.world_to_pixel(lon, lat);
                let c = fx.floor() as i64;
                let r = fy.floor() as i64;
                if c < 0 || r < 0 || c >= src_w as i64 || r >= src_h as i64 {
                    continue;
                }
                let v = src_values[(r as u32 * src_w + c as u32) as usize];
                if !v.is_finite() || v <= 0.0 {
                    continue;
                }
                let code = v.round().clamp(0.0, 255.0) as u8;
                if let Some((cr, cg, cb)) = class_rgb(code) {
                    class_buf[idx] = code;
                    let o = idx * 4;
                    rgba[o] = cr;
                    rgba[o + 1] = cg;
                    rgba[o + 2] = cb;
                    rgba[o + 3] = 200;
                    valid_count += 1;
                }
            }
        }
    }

    if valid_count == 0 {
        return Err(Error::NoData(
            "no WorldCover land-cover pixels in the screening area".into(),
        ));
    }

    Ok(ViewportPreview {
        width: out_w,
        height: out_h,
        rgba_base64: encode_base64(&rgba),
        bounds: GeoBounds {
            west,
            south,
            east,
            north,
        },
        min: 10.0,
        max: 100.0,
        method: format!(
            "esa-worldcover-2021-v200-http-window;tiles={}",
            tiles.len()
        ),
        level_scale: 1.0,
        valid_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_id_helsinki_area() {
        // ~60.17°N, 24.94°E → N60E024
        let t = tile_origin_for(24.94, 60.17);
        assert_eq!(t.id(), "N60E024");
        assert_eq!(t.west(), 24.0);
        assert_eq!(t.south(), 60.0);
        assert_eq!(t.east(), 27.0);
        assert_eq!(t.north(), 63.0);
    }

    #[test]
    fn tile_id_southern_western() {
        // Example from ESA docs: S48E036
        let t = tile_origin_for(36.1, -47.5);
        assert_eq!(t.id(), "S48E036");
        let w = tile_origin_for(-11.2, 1.5);
        assert_eq!(w.id(), "N00W012");
    }

    #[test]
    fn tiles_for_small_bbox_is_one() {
        let tiles = tiles_for_bbox(24.5, 60.1, 25.0, 60.4).unwrap();
        assert_eq!(tiles.len(), 1);
        assert_eq!(tiles[0].id(), "N60E024");
    }

    #[test]
    fn tiles_reject_too_many() {
        // Spans more than 4 tiles of 3° (~9° × 9° → 9 tiles).
        let err = tiles_for_bbox(0.0, 0.0, 9.5, 9.5).unwrap_err();
        assert!(err.to_string().contains("spans"));
    }

    #[test]
    fn palette_maps_known_classes() {
        assert_eq!(class_rgb(10), Some((0x00, 0x64, 0x00)));
        assert_eq!(class_rgb(40), Some((0xf0, 0x96, 0xff)));
        assert_eq!(class_rgb(80), Some((0x00, 0x64, 0xc8)));
        assert_eq!(class_rgb(0), None);
        assert_eq!(class_rgb(11), None);
    }
}
