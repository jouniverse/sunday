//! Windowed reads for palette (RGBPalette) GeoTIFFs.
//!
//! The `tiff` crate cannot decode PhotometricInterpretation::RGBPalette, but
//! ESA WorldCover (and similar classified COGs) store **class codes as the
//! palette indices** — we never need the ColorMap. This module inflates tiles
//! as raw u8 indices and feeds the same windowed API as greyscale rasters.

use std::io::{Read, Seek, SeekFrom};

use flate2::read::ZlibDecoder;
use tiff::decoder::Decoder;
use tiff::tags::Tag;

use super::Window;
use crate::error::{Error, Result};

/// TIFF PhotometricInterpretation value for RGB Palette.
const PHOTOMETRIC_RGB_PALETTE: u32 = 3;
/// Compression: Adobe-style zlib Deflate (also used as tag 8).
const COMPRESSION_ADOBE_DEFLATE: u32 = 8;
/// Compression: legacy Deflate.
const COMPRESSION_DEFLATE: u32 = 32946;
const COMPRESSION_NONE: u32 = 1;
/// Predictor: none / horizontal differencing.
const PREDICTOR_NONE: u32 = 1;
const PREDICTOR_HORIZONTAL: u32 = 2;

pub(crate) fn is_palette_u8<R: Read + Seek>(decoder: &mut Decoder<R>) -> Result<bool> {
    let photo = match decoder.find_tag(Tag::PhotometricInterpretation)? {
        Some(v) => v.into_u32()?,
        None => return Ok(false),
    };
    if photo != PHOTOMETRIC_RGB_PALETTE {
        return Ok(false);
    }
    let bits = decoder
        .find_tag(Tag::BitsPerSample)?
        .map(|v| v.into_u32())
        .transpose()?
        .unwrap_or(8);
    let samples = decoder
        .find_tag(Tag::SamplesPerPixel)?
        .map(|v| v.into_u32())
        .transpose()?
        .unwrap_or(1);
    Ok(bits == 8 && samples == 1)
}

/// Read a window of palette indices as `f64` (NaN = nodata), row-major.
pub(crate) fn read_window_indices<R: Read + Seek>(
    decoder: &mut Decoder<R>,
    window: Window,
    level_w: u32,
    level_h: u32,
    nodata: Option<f64>,
) -> Result<Vec<f64>> {
    if window.x + window.width > level_w || window.y + window.height > level_h {
        return Err(Error::Invalid("window outside raster level".into()));
    }

    let (tile_w, tile_h) = decoder.chunk_dimensions();
    if tile_w == 0 || tile_h == 0 {
        return Err(Error::Unsupported("raster reports a zero-sized chunk".into()));
    }

    let compression = decoder
        .find_tag(Tag::Compression)?
        .map(|v| v.into_u32())
        .transpose()?
        .unwrap_or(COMPRESSION_NONE);
    let predictor = decoder
        .find_tag(Tag::Predictor)?
        .map(|v| v.into_u32())
        .transpose()?
        .unwrap_or(PREDICTOR_NONE);

    let offsets = decoder
        .get_tag(Tag::TileOffsets)
        .or_else(|_| decoder.get_tag(Tag::StripOffsets))?
        .into_u64_vec()?;
    let byte_counts = decoder
        .get_tag(Tag::TileByteCounts)
        .or_else(|_| decoder.get_tag(Tag::StripByteCounts))?
        .into_u64_vec()?;

    if offsets.len() != byte_counts.len() || offsets.is_empty() {
        return Err(Error::Invalid(
            "palette raster has inconsistent tile/strip offset tables".into(),
        ));
    }

    let tiles_across = level_w.div_ceil(tile_w);
    let mut out = vec![f64::NAN; window.pixel_count() as usize];

    let first_cx = window.x / tile_w;
    let last_cx = (window.x + window.width - 1) / tile_w;
    let first_cy = window.y / tile_h;
    let last_cy = (window.y + window.height - 1) / tile_h;

    for cy in first_cy..=last_cy {
        for cx in first_cx..=last_cx {
            let chunk_index = (cy * tiles_across + cx) as usize;
            if chunk_index >= offsets.len() {
                continue;
            }
            let (data_w, data_h) = decoder.chunk_data_dimensions(chunk_index as u32);
            if data_w == 0 || data_h == 0 {
                continue;
            }

            let mut tile = decode_chunk(
                decoder,
                offsets[chunk_index],
                byte_counts[chunk_index],
                compression,
                tile_w,
                data_h,
            )?;

            if predictor == PREDICTOR_HORIZONTAL {
                apply_horizontal_predictor(&mut tile, tile_w, data_h);
            } else if predictor != PREDICTOR_NONE {
                return Err(Error::Unsupported(format!(
                    "palette raster predictor {predictor} is not supported"
                )));
            }

            let origin_x = cx * tile_w;
            let origin_y = cy * tile_h;
            let x_start = window.x.max(origin_x);
            let x_end = (window.x + window.width).min(origin_x + data_w);
            let y_start = window.y.max(origin_y);
            let y_end = (window.y + window.height).min(origin_y + data_h);
            if x_start >= x_end || y_start >= y_end {
                continue;
            }

            for y in y_start..y_end {
                let tile_row = (y - origin_y) as usize;
                let out_row = (y - window.y) as usize;
                for x in x_start..x_end {
                    let tile_col = (x - origin_x) as usize;
                    let idx = tile_row * tile_w as usize + tile_col;
                    let value = tile.get(idx).copied().map(|b| b as f64);
                    let out_index = out_row * window.width as usize + (x - window.x) as usize;
                    out[out_index] = normalise_index(value, nodata);
                }
            }
        }
    }

    Ok(out)
}

fn decode_chunk<R: Read + Seek>(
    decoder: &mut Decoder<R>,
    offset: u64,
    compressed_len: u64,
    compression: u32,
    tile_w: u32,
    data_h: u32,
) -> Result<Vec<u8>> {
    // Row stride is the full tile width; height is the unpadded data height.
    let expected = (tile_w as usize).saturating_mul(data_h as usize);
    if expected == 0 {
        return Ok(Vec::new());
    }
    if compressed_len == 0 {
        return Ok(vec![0u8; expected]);
    }

    let reader = decoder.inner();
    reader.seek(SeekFrom::Start(offset))?;
    let mut compressed = vec![0u8; compressed_len as usize];
    reader.read_exact(&mut compressed)?;

    let mut decoded = match compression {
        COMPRESSION_NONE => {
            if compressed.len() < expected {
                return Err(Error::Invalid(format!(
                    "uncompressed palette tile is {} bytes, expected at least {expected}",
                    compressed.len()
                )));
            }
            compressed[..expected].to_vec()
        }
        COMPRESSION_ADOBE_DEFLATE | COMPRESSION_DEFLATE => {
            let mut zlib = ZlibDecoder::new(&compressed[..]);
            let mut out = Vec::with_capacity(expected);
            zlib.read_to_end(&mut out).map_err(|e| {
                Error::Invalid(format!("deflate decode failed for palette tile: {e}"))
            })?;
            if out.len() < expected {
                return Err(Error::Invalid(format!(
                    "deflated palette tile is {} bytes, expected at least {expected}",
                    out.len()
                )));
            }
            out.truncate(expected);
            out
        }
        other => {
            return Err(Error::Unsupported(format!(
                "palette raster compression {other} is not supported (need Deflate or none)"
            )));
        }
    };

    // Ensure exact length for indexing even if the compressor emitted a full padded tile.
    if decoded.len() > expected {
        decoded.truncate(expected);
    }
    Ok(decoded)
}

fn apply_horizontal_predictor(tile: &mut [u8], tile_w: u32, data_h: u32) {
    let stride = tile_w as usize;
    for row in 0..data_h as usize {
        let start = row * stride;
        let end = start + stride;
        if end > tile.len() {
            break;
        }
        let row_buf = &mut tile[start..end];
        for i in 1..row_buf.len() {
            row_buf[i] = row_buf[i].wrapping_add(row_buf[i - 1]);
        }
    }
}

fn normalise_index(value: Option<f64>, nodata: Option<f64>) -> f64 {
    match value {
        None => f64::NAN,
        Some(v) => match nodata {
            Some(nd) if (v - nd).abs() <= 1e-9 => f64::NAN,
            _ => v,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn horizontal_predictor_restores_deltas() {
        let original = vec![10u8, 0, 5, 250];
        let mut encoded = original.clone();
        for i in (1..encoded.len()).rev() {
            encoded[i] = encoded[i].wrapping_sub(encoded[i - 1]);
        }
        apply_horizontal_predictor(&mut encoded, 4, 1);
        assert_eq!(encoded, original);
    }

    /// Live AWS Open Data check — run with `cargo test -- --ignored`.
    #[test]
    #[ignore = "network: ESA WorldCover S3"]
    fn worldcover_http_window_reads_class_indices() {
        use crate::raster::{self, Window};

        let url = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N60E024_Map.tif";
        let mut open = raster::open_http(url).expect("open WorldCover");
        assert!(is_palette_u8(&mut open.decoder).expect("palette check"));
        // Pixel (100,100) is class 10 (tree cover) on this tile.
        let window = Window {
            x: 100,
            y: 100,
            width: 4,
            height: 4,
        };
        let level = open.info.levels[0];
        let values = raster::read_window(&mut open, level, window, 0).expect("read window");
        assert_eq!(values.len(), 16);
        assert!(
            values.iter().all(|v| v.is_finite()),
            "got non-finite {:?}",
            values
        );
        assert!(
            values.iter().any(|v| (*v - 10.0).abs() < 1e-9),
            "expected class 10, got {:?}",
            values
        );
    }
}
