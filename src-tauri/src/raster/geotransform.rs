//! GeoTIFF pixel <-> world coordinate mapping.
//!
//! Sunday only needs the north-up, axis-aligned case, which is what every
//! source we integrate uses (Solargis/GSA world layers and Google Solar
//! GeoTIFFs). Rotated or sheared transforms are rejected explicitly rather than
//! silently mis-sampled.

use std::io::{Read, Seek};

use serde::{Deserialize, Serialize};
use tiff::decoder::Decoder;
use tiff::tags::Tag;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoTransform {
    /// World x of the upper-left corner of the upper-left pixel.
    pub origin_x: f64,
    /// World y of the upper-left corner of the upper-left pixel.
    pub origin_y: f64,
    /// Pixel width in world units (positive eastwards).
    pub pixel_width: f64,
    /// Pixel height in world units, negative for the usual north-up raster.
    pub pixel_height: f64,
}

impl GeoTransform {
    pub fn new(origin_x: f64, origin_y: f64, pixel_width: f64, pixel_height: f64) -> Self {
        Self { origin_x, origin_y, pixel_width, pixel_height }
    }

    /// Derives the transform of an overview level from the full-resolution one.
    ///
    /// Prefer [`Self::for_overview`] when both dimensions are known — COG
    /// overviews are not always exactly square-scaled, and using a single
    /// `width/overview_width` factor for Y shifts the paint north/south.
    pub fn scaled(&self, scale: f64) -> Self {
        Self {
            origin_x: self.origin_x,
            origin_y: self.origin_y,
            pixel_width: self.pixel_width * scale,
            pixel_height: self.pixel_height * scale,
        }
    }

    /// Geotransform for an overview IFD that covers the same geographic extent
    /// as the full-resolution image with fewer pixels.
    pub fn for_overview(
        &self,
        full_width: u32,
        full_height: u32,
        overview_width: u32,
        overview_height: u32,
    ) -> Self {
        let ow = overview_width.max(1) as f64;
        let oh = overview_height.max(1) as f64;
        Self {
            origin_x: self.origin_x,
            origin_y: self.origin_y,
            pixel_width: self.pixel_width * (full_width as f64 / ow),
            pixel_height: self.pixel_height * (full_height as f64 / oh),
        }
    }

    /// World coordinate of a pixel centre.
    pub fn pixel_center(&self, col: u32, row: u32) -> (f64, f64) {
        (
            self.origin_x + (col as f64 + 0.5) * self.pixel_width,
            self.origin_y + (row as f64 + 0.5) * self.pixel_height,
        )
    }

    /// Fractional pixel coordinate of a world position.
    pub fn world_to_pixel(&self, x: f64, y: f64) -> (f64, f64) {
        (
            (x - self.origin_x) / self.pixel_width,
            (y - self.origin_y) / self.pixel_height,
        )
    }

    /// Integer pixel range covering a world-space bounding box, inclusive.
    /// Values may fall outside the raster; clip with `Window::clip`.
    pub fn bbox_to_pixels(&self, min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> (i64, i64, i64, i64) {
        let (ax, ay) = self.world_to_pixel(min_x, max_y);
        let (bx, by) = self.world_to_pixel(max_x, min_y);
        let x0 = snap(ax.min(bx)).floor() as i64;
        let x1 = snap(ax.max(bx)).ceil() as i64;
        let y0 = snap(ay.min(by)).floor() as i64;
        let y1 = snap(ay.max(by)).ceil() as i64;
        (x0, y0, x1, y1)
    }
}

/// A bbox edge that lies exactly on a pixel boundary comes out of the division
/// as 1.9999999999999574 rather than 2.0, which would shift the whole window by
/// a pixel. Snap values that are within a rounding error of an integer.
fn snap(value: f64) -> f64 {
    let nearest = value.round();
    if (value - nearest).abs() < 1e-9 {
        nearest
    } else {
        value
    }
}

/// Reads the transform from tags 33550 (ModelPixelScale) and 33922
/// (ModelTiepoint). Falls back to a whole-world 4326 grid only when the raster
/// carries no georeferencing at all, and says so through `Error::Invalid`
/// otherwise.
pub fn read<R: Read + Seek>(
    decoder: &mut Decoder<R>,
    width: u32,
    height: u32,
) -> Result<GeoTransform> {
    let scale = decoder
        .find_tag(Tag::ModelPixelScaleTag)
        .ok()
        .flatten()
        .and_then(|v| v.into_f64_vec().ok());
    let tiepoint = decoder
        .find_tag(Tag::ModelTiepointTag)
        .ok()
        .flatten()
        .and_then(|v| v.into_f64_vec().ok());

    match (scale, tiepoint) {
        (Some(scale), Some(tie)) if scale.len() >= 2 && tie.len() >= 6 => {
            let (sx, sy) = (scale[0], scale[1]);
            // Tiepoint maps raster (i,j,k) to world (x,y,z).
            let (i, j, x, y) = (tie[0], tie[1], tie[3], tie[4]);
            if sx <= 0.0 || sy <= 0.0 {
                return Err(Error::Invalid("raster has a non-positive pixel scale".into()));
            }
            Ok(GeoTransform {
                origin_x: x - i * sx,
                origin_y: y + j * sy,
                pixel_width: sx,
                pixel_height: -sy,
            })
        }
        _ => {
            if width == 0 || height == 0 {
                return Err(Error::Invalid("raster has zero extent".into()));
            }
            Err(Error::Invalid(
                "raster has no ModelPixelScale/ModelTiepoint georeferencing; \
                 convert it with gdal_translate before use"
                    .into(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transform() -> GeoTransform {
        // A 0.01 degree grid whose upper-left corner is at 10E, 50N.
        GeoTransform::new(10.0, 50.0, 0.01, -0.01)
    }

    #[test]
    fn maps_pixel_centres_to_world() {
        let t = transform();
        let (x, y) = t.pixel_center(0, 0);
        assert!((x - 10.005).abs() < 1e-12);
        assert!((y - 49.995).abs() < 1e-12);
    }

    #[test]
    fn round_trips_world_and_pixel_coordinates() {
        let t = transform();
        let (col, row) = t.world_to_pixel(10.005, 49.995);
        assert!((col - 0.5).abs() < 1e-12);
        assert!((row - 0.5).abs() < 1e-12);
    }

    #[test]
    fn converts_bbox_to_inclusive_pixel_range() {
        let t = transform();
        let (x0, y0, x1, y1) = t.bbox_to_pixels(10.02, 49.95, 10.05, 49.98);
        assert_eq!((x0, y0), (2, 2));
        assert!(x1 >= 5 && y1 >= 5);
    }

    #[test]
    fn snaps_boundary_values_that_land_just_below_an_integer() {
        // (10.02 - 10.0) / 0.01 evaluates to 1.9999999999999574 in binary floats.
        assert_eq!(snap(1.9999999999999574), 2.0);
        // Genuine fractions must be left alone.
        assert_eq!(snap(1.5), 1.5);
    }

    #[test]
    fn scales_transform_for_overviews() {
        let t = transform().scaled(4.0);
        assert!((t.pixel_width - 0.04).abs() < 1e-12);
        assert!((t.pixel_height + 0.04).abs() < 1e-12);
        assert_eq!(t.origin_x, 10.0);
    }

    #[test]
    fn overview_transform_uses_independent_xy_scales() {
        let t = transform().for_overview(1000, 500, 250, 100);
        // scale_x = 4, scale_y = 5
        assert!((t.pixel_width - 0.04).abs() < 1e-12);
        assert!((t.pixel_height + 0.05).abs() < 1e-12);
        assert_eq!(t.origin_y, 50.0);
    }
}
