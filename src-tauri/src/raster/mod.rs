//! Raster engine: windowed reads and zonal statistics over (Cloud-Optimized)
//! GeoTIFFs, local or remote.
//!
//! Sunday's greenfield workflow needs one number out of a multi-gigabyte
//! irradiance raster: the statistics of the pixels inside a drawn polygon.
//! Nothing here ever loads a whole raster. A query resolves to
//! bbox -> pixel window -> the chunks that intersect it -> masked statistics.

pub mod geotransform;
pub mod range_reader;
pub mod zonal;

use std::fs::File;
use std::io::{BufReader, Read, Seek};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

use crate::error::{Error, Result};
use geotransform::GeoTransform;
use range_reader::HttpRangeReader;

/// Where a raster lives. The two variants share the entire decode path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RasterSource {
    Local { path: PathBuf },
    Http { url: String },
}

impl RasterSource {
    pub fn label(&self) -> String {
        match self {
            RasterSource::Local { path } => path.display().to_string(),
            RasterSource::Http { url } => url.clone(),
        }
    }
}

/// One resolution level of a raster. COG overviews are stored as additional
/// IFDs, so a level is identified by its IFD index.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterLevel {
    pub ifd: usize,
    pub width: u32,
    pub height: u32,
    /// Linear downsampling factor relative to the full-resolution level.
    pub scale: f64,
}

/// Everything the frontend needs to describe a raster and reason about cost.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterInfo {
    pub source: RasterSource,
    pub width: u32,
    pub height: u32,
    pub transform: GeoTransform,
    pub nodata: Option<f64>,
    pub samples_per_pixel: u32,
    pub tiled: bool,
    pub chunk_width: u32,
    pub chunk_height: u32,
    pub levels: Vec<RasterLevel>,
}

impl RasterInfo {
    /// Picks the coarsest level that still yields at least `min_pixels` samples
    /// across `bbox_px` full-resolution pixels, so a continental polygon reads
    /// an overview instead of millions of native pixels.
    pub fn choose_level(&self, bbox_px: f64, min_pixels: f64) -> RasterLevel {
        let mut chosen = self.levels[0];
        for level in &self.levels {
            let available = bbox_px / (level.scale * level.scale);
            if available >= min_pixels && level.scale >= chosen.scale {
                chosen = *level;
            }
        }
        chosen
    }
}

/// An open raster. Generic over the reader so local files and HTTP ranges are
/// the same code.
pub struct OpenRaster<R: Read + Seek> {
    pub decoder: Decoder<R>,
    pub info: RasterInfo,
}

pub fn open_local(path: &PathBuf) -> Result<OpenRaster<BufReader<File>>> {
    let file = File::open(path)?;
    let decoder = Decoder::new(BufReader::new(file))?;
    let source = RasterSource::Local { path: path.clone() };
    finish_open(decoder, source)
}

pub fn open_http(url: &str) -> Result<OpenRaster<HttpRangeReader>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(crate::USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let reader = HttpRangeReader::new(client, url)?;
    let decoder = Decoder::new(reader)?;
    finish_open(decoder, RasterSource::Http { url: url.to_string() })
}

fn finish_open<R: Read + Seek>(
    mut decoder: Decoder<R>,
    source: RasterSource,
) -> Result<OpenRaster<R>> {
    let (width, height) = decoder.dimensions()?;
    let transform = geotransform::read(&mut decoder, width, height)?;
    let nodata = read_nodata(&mut decoder);
    let samples_per_pixel = decoder
        .find_tag(Tag::SamplesPerPixel)
        .ok()
        .flatten()
        .and_then(|v| v.into_u32().ok())
        .unwrap_or(1);
    let tiled = matches!(decoder.get_chunk_type(), tiff::decoder::ChunkType::Tile);
    let (chunk_width, chunk_height) = decoder.chunk_dimensions();

    // Walk the IFD chain to catalogue overview levels, then return to the base
    // image so the decoder is left in a predictable state.
    let mut levels = vec![RasterLevel { ifd: 0, width, height, scale: 1.0 }];
    let mut ifd = 0usize;
    while decoder.more_images() {
        decoder.next_image()?;
        ifd += 1;
        let (lw, lh) = decoder.dimensions()?;
        if lw == 0 || lh == 0 {
            continue;
        }
        let scale = width as f64 / lw as f64;
        // Ignore masks and other same-size auxiliary IFDs.
        if scale > 1.05 {
            levels.push(RasterLevel { ifd, width: lw, height: lh, scale });
        }
    }
    decoder.seek_to_image(0)?;
    levels.sort_by(|a, b| a.scale.partial_cmp(&b.scale).unwrap_or(std::cmp::Ordering::Equal));

    Ok(OpenRaster {
        decoder,
        info: RasterInfo {
            source,
            width,
            height,
            transform,
            nodata,
            samples_per_pixel,
            tiled,
            chunk_width,
            chunk_height,
            levels,
        },
    })
}

/// GDAL writes its nodata value as an ASCII string in tag 42113.
fn read_nodata<R: Read + Seek>(decoder: &mut Decoder<R>) -> Option<f64> {
    let value = decoder.find_tag(Tag::GdalNodata).ok().flatten()?;
    let text = value.into_string().ok()?;
    let trimmed = text.trim().trim_end_matches('\0').trim();
    if trimmed.eq_ignore_ascii_case("nan") {
        return Some(f64::NAN);
    }
    trimmed.parse::<f64>().ok()
}

/// A rectangular pixel window, clipped to the raster.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl Window {
    pub fn clip(x0: i64, y0: i64, x1: i64, y1: i64, width: u32, height: u32) -> Option<Window> {
        let x_min = x0.max(0);
        let y_min = y0.max(0);
        let x_max = x1.min(width as i64 - 1);
        let y_max = y1.min(height as i64 - 1);
        if x_min > x_max || y_min > y_max {
            return None;
        }
        Some(Window {
            x: x_min as u32,
            y: y_min as u32,
            width: (x_max - x_min + 1) as u32,
            height: (y_max - y_min + 1) as u32,
        })
    }

    pub fn pixel_count(&self) -> u64 {
        self.width as u64 * self.height as u64
    }
}

/// Reads a pixel window of one band as `f64`, row-major, `NaN` where nodata.
///
/// Only the chunks that intersect the window are decoded.
pub fn read_window<R: Read + Seek>(
    raster: &mut OpenRaster<R>,
    level: RasterLevel,
    window: Window,
    band: u32,
) -> Result<Vec<f64>> {
    raster.decoder.seek_to_image(level.ifd)?;
    let (level_w, level_h) = raster.decoder.dimensions()?;
    if window.x + window.width > level_w || window.y + window.height > level_h {
        return Err(Error::Invalid("window outside raster level".into()));
    }

    let samples = raster.info.samples_per_pixel.max(1);
    if band >= samples {
        return Err(Error::Invalid(format!(
            "band {band} requested but raster has {samples} sample(s) per pixel"
        )));
    }

    let (chunk_w, chunk_h) = raster.decoder.chunk_dimensions();
    if chunk_w == 0 || chunk_h == 0 {
        return Err(Error::Unsupported("raster reports a zero-sized chunk".into()));
    }
    let chunks_across = level_w.div_ceil(chunk_w);

    let mut out = vec![f64::NAN; window.pixel_count() as usize];
    let nodata = raster.info.nodata;

    let first_cx = window.x / chunk_w;
    let last_cx = (window.x + window.width - 1) / chunk_w;
    let first_cy = window.y / chunk_h;
    let last_cy = (window.y + window.height - 1) / chunk_h;

    for cy in first_cy..=last_cy {
        for cx in first_cx..=last_cx {
            let chunk_index = cy * chunks_across + cx;
            let (data_w, data_h) = raster.decoder.chunk_data_dimensions(chunk_index);
            if data_w == 0 || data_h == 0 {
                continue;
            }
            let chunk = raster.decoder.read_chunk(chunk_index)?;
            let origin_x = cx * chunk_w;
            let origin_y = cy * chunk_h;

            // Intersection of this chunk's data extent with the window.
            let x_start = window.x.max(origin_x);
            let x_end = (window.x + window.width).min(origin_x + data_w);
            let y_start = window.y.max(origin_y);
            let y_end = (window.y + window.height).min(origin_y + data_h);
            if x_start >= x_end || y_start >= y_end {
                continue;
            }

            for y in y_start..y_end {
                let chunk_row = (y - origin_y) as usize;
                let out_row = (y - window.y) as usize;
                for x in x_start..x_end {
                    let chunk_col = (x - origin_x) as usize;
                    let index =
                        (chunk_row * data_w as usize + chunk_col) * samples as usize + band as usize;
                    let value = sample_at(&chunk, index);
                    let out_index = out_row * window.width as usize + (x - window.x) as usize;
                    out[out_index] = normalise(value, nodata);
                }
            }
        }
    }

    Ok(out)
}

fn normalise(value: Option<f64>, nodata: Option<f64>) -> f64 {
    match value {
        None => f64::NAN,
        Some(v) => {
            if !v.is_finite() {
                return f64::NAN;
            }
            match nodata {
                Some(nd) if nd.is_nan() => v,
                // Rasters store nodata exactly, but compare with a tolerance so
                // float32 -> float64 widening cannot miss it.
                Some(nd) if (v - nd).abs() <= nd.abs().max(1.0) * 1e-9 => f64::NAN,
                _ => v,
            }
        }
    }
}

fn sample_at(chunk: &DecodingResult, index: usize) -> Option<f64> {
    match chunk {
        DecodingResult::U8(v) => v.get(index).map(|x| *x as f64),
        DecodingResult::U16(v) => v.get(index).map(|x| *x as f64),
        DecodingResult::U32(v) => v.get(index).map(|x| *x as f64),
        DecodingResult::U64(v) => v.get(index).map(|x| *x as f64),
        DecodingResult::I8(v) => v.get(index).map(|x| *x as f64),
        DecodingResult::I16(v) => v.get(index).map(|x| *x as f64),
        DecodingResult::I32(v) => v.get(index).map(|x| *x as f64),
        DecodingResult::I64(v) => v.get(index).map(|x| *x as f64),
        DecodingResult::F32(v) => v.get(index).map(|x| *x as f64),
        DecodingResult::F64(v) => v.get(index).copied(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips_windows_to_raster_bounds() {
        assert_eq!(
            Window::clip(-5, -5, 3, 2, 10, 10),
            Some(Window { x: 0, y: 0, width: 4, height: 3 })
        );
        assert_eq!(
            Window::clip(8, 8, 40, 40, 10, 10),
            Some(Window { x: 8, y: 8, width: 2, height: 2 })
        );
        assert_eq!(Window::clip(20, 20, 30, 30, 10, 10), None);
    }

    #[test]
    fn treats_nodata_and_non_finite_as_missing() {
        assert!(normalise(Some(-9999.0), Some(-9999.0)).is_nan());
        assert!(normalise(Some(f64::INFINITY), None).is_nan());
        assert!(normalise(None, None).is_nan());
        assert_eq!(normalise(Some(1200.5), Some(-9999.0)), 1200.5);
        // A NaN nodata declaration must not discard real values.
        assert_eq!(normalise(Some(3.0), Some(f64::NAN)), 3.0);
    }

    #[test]
    fn chooses_coarser_levels_for_large_areas() {
        let info = RasterInfo {
            source: RasterSource::Local { path: PathBuf::from("x.tif") },
            width: 4000,
            height: 4000,
            transform: GeoTransform::new(0.0, 0.0, 0.01, -0.01),
            nodata: None,
            samples_per_pixel: 1,
            tiled: true,
            chunk_width: 256,
            chunk_height: 256,
            levels: vec![
                RasterLevel { ifd: 0, width: 4000, height: 4000, scale: 1.0 },
                RasterLevel { ifd: 1, width: 2000, height: 2000, scale: 2.0 },
                RasterLevel { ifd: 2, width: 1000, height: 1000, scale: 4.0 },
            ],
        };
        // A huge area can be answered from the coarsest overview.
        assert_eq!(info.choose_level(4_000_000.0, 1000.0).scale, 4.0);
        // A small area must stay at full resolution to keep enough samples.
        assert_eq!(info.choose_level(500.0, 1000.0).scale, 1.0);
    }
}
