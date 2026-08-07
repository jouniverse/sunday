//! Viewport colourised preview of a COG for MapLibre image overlays.
//!
//! Renders into a grid that matches the **request bbox exactly** (not the
//! pixel-snapped raster window). That keeps the overlay locked to the basemap
//! when overview level changes. Oversized windows are decimated rather than
//! rejected — coarse browse must work even when COG overviews are sparse.

use std::io::{Read, Seek};

use serde::{Deserialize, Serialize};

use super::{read_window, OpenRaster, RasterLevel, Window};
use crate::error::{Error, Result};

/// Default hard ceiling for the *output* image (~512²).
pub const DEFAULT_MAX_PIXELS: u64 = 262_144;
/// Cap on pixels decoded from the COG before resampling into the output grid.
const MAX_READ_PIXELS: u64 = 1_500_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportPreviewRequest {
    pub min_lon: f64,
    pub min_lat: f64,
    pub max_lon: f64,
    pub max_lat: f64,
    #[serde(default)]
    pub band: u32,
    #[serde(default = "default_max_pixels")]
    pub max_pixels: u64,
}

fn default_max_pixels() -> u64 {
    DEFAULT_MAX_PIXELS
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoBounds {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportPreview {
    pub width: u32,
    pub height: u32,
    /// RGBA8 pixels, base64-encoded (avoids huge JSON number arrays).
    pub rgba_base64: String,
    pub bounds: GeoBounds,
    pub min: f64,
    pub max: f64,
    pub method: String,
    pub level_scale: f64,
    pub valid_count: u64,
}

/// Stops matching the GHI catalogue legend colours (t in \[0, 1\]).
const RAMP: &[(f64, u8, u8, u8)] = &[
    (0.00, 0x3b, 0x2f, 0x6b),
    (0.25, 0x6b, 0x4f, 0xa0),
    (0.50, 0xd9, 0xa4, 0x41),
    (0.75, 0xf7, 0xbf, 0x59),
    (1.00, 0xff, 0xf0, 0xc2),
];

/// Picks the finest overview whose estimated window still fits `max_read`.
pub fn pick_level_for_budget(
    levels: &[RasterLevel],
    full_width: u32,
    full_height: u32,
    bbox_w_full: f64,
    bbox_h_full: f64,
    max_read: u64,
) -> RasterLevel {
    let mut best: Option<RasterLevel> = None;
    for level in levels {
        let scale_x = full_width as f64 / level.width.max(1) as f64;
        let scale_y = full_height as f64 / level.height.max(1) as f64;
        let available = (bbox_w_full / scale_x) * (bbox_h_full / scale_y);
        if available <= max_read as f64 {
            best = match best {
                Some(current) if level.scale < current.scale => Some(*level),
                Some(current) => Some(current),
                None => Some(*level),
            };
        }
    }
    if let Some(level) = best {
        return level;
    }
    let mut coarsest = levels[0];
    for level in levels {
        if level.scale >= coarsest.scale {
            coarsest = *level;
        }
    }
    coarsest
}

fn sample_ramp(t: f64) -> (u8, u8, u8) {
    let t = t.clamp(0.0, 1.0);
    for window in RAMP.windows(2) {
        let (t0, r0, g0, b0) = window[0];
        let (t1, r1, g1, b1) = window[1];
        if t <= t1 {
            let u = if (t1 - t0).abs() < f64::EPSILON {
                0.0
            } else {
                (t - t0) / (t1 - t0)
            };
            let lerp = |a: u8, b: u8| -> u8 { (a as f64 + (b as f64 - a as f64) * u).round() as u8 };
            return (lerp(r0, r1), lerp(g0, g1), lerp(b0, b1));
        }
    }
    let last = RAMP[RAMP.len() - 1];
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

/// Web Mercator helpers — MapLibre image quads are linear in mercator, not latitude.
const MERCATOR_MAX_LAT: f64 = 85.051_128_78;

fn clamp_lat(lat: f64) -> f64 {
    lat.clamp(-MERCATOR_MAX_LAT, MERCATOR_MAX_LAT)
}

fn lon_to_merc_x(lon: f64) -> f64 {
    lon
}

fn lat_to_merc_y(lat: f64) -> f64 {
    let lat = clamp_lat(lat).to_radians();
    lat.tan().asinh().to_degrees()
}

fn merc_y_to_lat(y: f64) -> f64 {
    y.to_radians().sinh().atan().to_degrees()
}

/// Output grid size fitting `max_pixels` with the viewport's **mercator** aspect.
fn output_dimensions(min_lon: f64, min_lat: f64, max_lon: f64, max_lat: f64, max_pixels: u64) -> (u32, u32) {
    let span_x = (max_lon - min_lon).abs().max(1e-9);
    let span_y = (lat_to_merc_y(max_lat) - lat_to_merc_y(min_lat)).abs().max(1e-9);
    let aspect = span_x / span_y;
    let max_p = max_pixels.max(1) as f64;
    let mut out_h = (max_p / aspect).sqrt().floor().max(1.0);
    let mut out_w = (out_h * aspect).floor().max(1.0);
    while out_w * out_h > max_p {
        if out_w >= out_h && out_w > 1.0 {
            out_w -= 1.0;
        } else if out_h > 1.0 {
            out_h -= 1.0;
        } else {
            break;
        }
    }
    (out_w as u32, out_h as u32)
}

/// Nearest-neighbour sample from a row-major window buffer.
fn sample_window(
    values: &[f64],
    window: Window,
    level_tf: &super::geotransform::GeoTransform,
    lon: f64,
    lat: f64,
) -> f64 {
    let (fx, fy) = level_tf.world_to_pixel(lon, lat);
    let col = fx.floor() as i64;
    let row = fy.floor() as i64;
    if col < window.x as i64
        || row < window.y as i64
        || col >= (window.x + window.width) as i64
        || row >= (window.y + window.height) as i64
    {
        return f64::NAN;
    }
    let local_x = (col as u32) - window.x;
    let local_y = (row as u32) - window.y;
    values[(local_y * window.width + local_x) as usize]
}

/// Decimate a window buffer by integer stride (nearest).
fn decimate_window(values: &[f64], width: u32, height: u32, max_pixels: u64) -> (u32, u32, Vec<f64>, u32) {
    let count = width as u64 * height as u64;
    if count <= max_pixels || width == 0 || height == 0 {
        return (width, height, values.to_vec(), 1);
    }
    let mut stride = 1u32;
    while ((width as u64).div_ceil(stride as u64)) * ((height as u64).div_ceil(stride as u64))
        > max_pixels
    {
        stride += 1;
        if stride > width.max(height) {
            break;
        }
    }
    let out_w = width.div_ceil(stride);
    let out_h = height.div_ceil(stride);
    let mut out = Vec::with_capacity((out_w * out_h) as usize);
    for row in 0..out_h {
        for col in 0..out_w {
            let src_x = (col * stride).min(width - 1);
            let src_y = (row * stride).min(height - 1);
            out.push(values[(src_y * width + src_x) as usize]);
        }
    }
    (out_w, out_h, out, stride)
}

pub fn compute<R: Read + Seek>(
    raster: &mut OpenRaster<R>,
    request: &ViewportPreviewRequest,
) -> Result<ViewportPreview> {
    if request.min_lon > request.max_lon || request.min_lat > request.max_lat {
        return Err(Error::Invalid("bounding box is inverted".into()));
    }
    if request.max_pixels == 0 {
        return Err(Error::Invalid("maxPixels must be > 0".into()));
    }
    if raster.info.levels.is_empty() {
        return Err(Error::Invalid("raster has no resolution levels".into()));
    }

    let west = request.min_lon;
    let east = request.max_lon;
    let south = request.min_lat;
    let north = request.max_lat;

    let base = raster.info.transform;
    let full_w = raster.info.width;
    let full_h = raster.info.height;
    let (fx0, fy0, fx1, fy1) = base.bbox_to_pixels(west, south, east, north);
    let bbox_w = (fx1 - fx0 + 1).max(1) as f64;
    let bbox_h = (fy1 - fy0 + 1).max(1) as f64;

    let level = pick_level_for_budget(
        &raster.info.levels,
        full_w,
        full_h,
        bbox_w,
        bbox_h,
        MAX_READ_PIXELS,
    );
    let level_tf = base.for_overview(full_w, full_h, level.width, level.height);
    let (x0, y0, x1, y1) = level_tf.bbox_to_pixels(west, south, east, north);
    let window = Window::clip(x0, y0, x1, y1, level.width, level.height).ok_or_else(|| {
        Error::NoData("viewport does not overlap the raster".into())
    })?;

    // Hard stop only for pathological non-COG full-res world reads.
    if window.pixel_count() > 4_000_000 {
        return Err(Error::Invalid(format!(
            "viewport preview would decode {} pixels; reinstall the raster as a COG with overviews \
             (Settings → Install) or zoom in",
            window.pixel_count()
        )));
    }

    // Decode then decimate so sparse-overview COGs still paint at world zoom.
    let raw = read_window(raster, level, window, request.band)?;
    let (src_w, src_h, src_values, stride) =
        decimate_window(&raw, window.width, window.height, MAX_READ_PIXELS);

    // Geotransform of the (possibly decimated) source grid (origin = window UL).
    let src_tf = super::geotransform::GeoTransform {
        origin_x: level_tf.origin_x + window.x as f64 * level_tf.pixel_width,
        origin_y: level_tf.origin_y + window.y as f64 * level_tf.pixel_height,
        pixel_width: level_tf.pixel_width * stride as f64,
        pixel_height: level_tf.pixel_height * stride as f64,
    };
    let src_window = Window {
        x: 0,
        y: 0,
        width: src_w,
        height: src_h,
    };

    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut valid_count = 0u64;
    for &v in &src_values {
        if v.is_finite() {
            valid_count += 1;
            if v < min {
                min = v;
            }
            if v > max {
                max = v;
            }
        }
    }
    if valid_count == 0 {
        return Err(Error::NoData("no valid raster pixels in the viewport".into()));
    }
    let span = (max - min).max(1e-9);

    // Paint in Web Mercator row spacing — MapLibre stretches the image linearly
    // in mercator space, so lat-linear sampling looked like vertical drift on zoom.
    let (out_w, out_h) = output_dimensions(west, south, east, north, request.max_pixels);
    let y_north = lat_to_merc_y(north);
    let y_south = lat_to_merc_y(south);
    let mut rgba = vec![0u8; (out_w * out_h) as usize * 4];
    for row in 0..out_h {
        let y = y_north - (row as f64 + 0.5) / out_h as f64 * (y_north - y_south);
        let lat = merc_y_to_lat(y);
        for col in 0..out_w {
            let lon = lon_to_merc_x(west)
                + (col as f64 + 0.5) / out_w as f64 * (lon_to_merc_x(east) - lon_to_merc_x(west));
            let v = sample_window(&src_values, src_window, &src_tf, lon, lat);
            let o = ((row * out_w + col) * 4) as usize;
            if !v.is_finite() {
                continue;
            }
            let t = (v - min) / span;
            let (r, g, b) = sample_ramp(t);
            rgba[o] = r;
            rgba[o + 1] = g;
            rgba[o + 2] = b;
            rgba[o + 3] = 200;
        }
    }

    let scale_x = full_w as f64 / level.width.max(1) as f64;
    let scale_y = full_h as f64 / level.height.max(1) as f64;

    Ok(ViewportPreview {
        width: out_w,
        height: out_h,
        rgba_base64: encode_base64(&rgba),
        // Exact camera bbox — no pixel-edge snap, so zoom changes do not drift.
        bounds: GeoBounds {
            west,
            south,
            east,
            north,
        },
        min,
        max,
        method: format!(
            "gsa-viewport-mercator@overview={:.0}x{:.0}{}",
            scale_x.round(),
            scale_y.round(),
            if stride > 1 {
                format!(";decimate={stride}")
            } else {
                String::new()
            }
        ),
        level_scale: scale_x,
        valid_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ramp_endpoints_match_catalogue() {
        assert_eq!(sample_ramp(0.0), (0x3b, 0x2f, 0x6b));
        assert_eq!(sample_ramp(1.0), (0xff, 0xf0, 0xc2));
    }

    #[test]
    fn base64_empty_and_short() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
    }

    #[test]
    fn pick_level_prefers_budget_fit() {
        let levels = vec![
            RasterLevel {
                ifd: 0,
                width: 1000,
                height: 1000,
                scale: 1.0,
            },
            RasterLevel {
                ifd: 1,
                width: 250,
                height: 250,
                scale: 4.0,
            },
            RasterLevel {
                ifd: 2,
                width: 62,
                height: 62,
                scale: 16.0,
            },
        ];
        let chosen = pick_level_for_budget(&levels, 1000, 1000, 1000.0, 1000.0, 100_000);
        assert_eq!(chosen.scale, 4.0);
    }

    #[test]
    fn decimate_reduces_below_budget() {
        let values: Vec<f64> = (0..1000).map(|i| i as f64).collect();
        let (w, h, out, stride) = decimate_window(&values, 50, 20, 100);
        assert!(stride > 1);
        assert!(u64::from(w) * u64::from(h) <= 100);
        assert_eq!(out.len(), (w * h) as usize);
    }

    #[test]
    fn output_dimensions_respect_budget() {
        let (w, h) = output_dimensions(-180.0, -85.0, 180.0, 85.0, 10_000);
        assert!(u64::from(w) * u64::from(h) <= 10_000);
        assert!(w >= 1 && h >= 1);
    }

    #[test]
    fn mercator_round_trip_latitude() {
        for lat in [-60.0, -30.0, 0.0, 30.0, 60.0] {
            let y = lat_to_merc_y(lat);
            let back = merc_y_to_lat(y);
            assert!((back - lat).abs() < 1e-9, "lat {lat} -> {back}");
        }
    }
}
