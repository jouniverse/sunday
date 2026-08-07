//! Zonal statistics: summarise raster pixels inside a polygon.
//!
//! Two details matter for correctness and are easy to get wrong:
//!
//! 1. **Latitude weighting.** In EPSG:4326 a pixel near 60N covers about half
//!    the ground area of a pixel at the equator. An unweighted mean of an
//!    irradiance raster over a tall polygon is therefore biased. Weighted and
//!    unweighted means are both reported so the difference is visible.
//! 2. **Small polygons.** A site smaller than a pixel would otherwise return
//!    "no data". When no pixel centre falls inside, we fall back to sampling the
//!    polygon centroid and label the result accordingly.

use geo::algorithm::contains::Contains;
use geo::{Coord, LineString, MultiPolygon, Point, Polygon};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

use super::geotransform::GeoTransform;
use super::{read_window, OpenRaster, RasterLevel, Window};

/// How a statistic was obtained, so the UI never presents a fallback as a
/// full-fidelity result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ZonalMethod {
    /// Pixel centres inside the polygon.
    PixelsInPolygon,
    /// Polygon smaller than one pixel: nearest single pixel to its centroid.
    CentroidSample,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZonalStats {
    pub method: ZonalMethod,
    /// Pixels that contributed a value.
    pub count: u64,
    /// Pixels inside the polygon that were nodata.
    pub nodata_count: u64,
    pub min: f64,
    pub max: f64,
    /// Arithmetic mean of contributing pixels.
    pub mean: f64,
    /// Mean weighted by cos(latitude) cell area; equals `mean` for projected data.
    pub area_weighted_mean: f64,
    pub median: f64,
    /// Population standard deviation.
    pub std_dev: f64,
    pub sum: f64,
    /// Level actually read, so cost and resolution are auditable.
    pub level_scale: f64,
    pub pixel_area_km2: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct ZonalOptions {
    pub band: u32,
    /// Treat coordinates as degrees and apply cos(latitude) weighting.
    pub geographic: bool,
    /// Minimum sample count that drives overview selection.
    pub min_pixels: f64,
    /// Hard ceiling on pixels read in one query.
    pub max_pixels: u64,
}

impl Default for ZonalOptions {
    fn default() -> Self {
        Self { band: 0, geographic: true, min_pixels: 400.0, max_pixels: 4_000_000 }
    }
}

/// Builds a `geo` multipolygon from GeoJSON-style coordinate rings.
/// Outer ring first, any following rings are holes.
pub fn multipolygon_from_rings(rings: &[Vec<[f64; 2]>]) -> Result<MultiPolygon<f64>> {
    if rings.is_empty() {
        return Err(Error::Invalid("polygon has no rings".into()));
    }
    let to_line = |ring: &Vec<[f64; 2]>| -> LineString<f64> {
        LineString::from(ring.iter().map(|c| Coord { x: c[0], y: c[1] }).collect::<Vec<_>>())
    };
    let exterior = to_line(&rings[0]);
    if exterior.0.len() < 4 {
        return Err(Error::Invalid("polygon ring needs at least three distinct vertices".into()));
    }
    let holes: Vec<LineString<f64>> = rings[1..].iter().map(to_line).collect();
    Ok(MultiPolygon(vec![Polygon::new(exterior, holes)]))
}

fn bounds(polygon: &MultiPolygon<f64>) -> Option<(f64, f64, f64, f64)> {
    use geo::algorithm::bounding_rect::BoundingRect;
    let rect = polygon.bounding_rect()?;
    Some((rect.min().x, rect.min().y, rect.max().x, rect.max().y))
}

pub fn compute<R: std::io::Read + std::io::Seek>(
    raster: &mut OpenRaster<R>,
    polygon: &MultiPolygon<f64>,
    options: ZonalOptions,
) -> Result<ZonalStats> {
    let (min_x, min_y, max_x, max_y) =
        bounds(polygon).ok_or_else(|| Error::Invalid("polygon has no bounding box".into()))?;

    let base = raster.info.transform;
    let (bx0, by0, bx1, by1) = base.bbox_to_pixels(min_x, min_y, max_x, max_y);
    let bbox_px = ((bx1 - bx0 + 1).max(1) as f64) * ((by1 - by0 + 1).max(1) as f64);

    let mut level = raster.info.choose_level(bbox_px, options.min_pixels);
    let mut transform = base.for_overview(
        raster.info.width,
        raster.info.height,
        level.width,
        level.height,
    );
    let mut window = pixel_window(&transform, min_x, min_y, max_x, max_y, level)
        .ok_or_else(|| Error::NoData("polygon does not overlap the raster".into()))?;

    // Guard rail: if even the chosen level would read too much, step coarser.
    while window.pixel_count() > options.max_pixels {
        let coarser = raster
            .info
            .levels
            .iter()
            .filter(|l| l.scale > level.scale)
            .min_by(|a, b| a.scale.partial_cmp(&b.scale).unwrap_or(std::cmp::Ordering::Equal))
            .copied();
        match coarser {
            Some(next) => {
                level = next;
                transform = base.for_overview(
                    raster.info.width,
                    raster.info.height,
                    level.width,
                    level.height,
                );
                window = pixel_window(&transform, min_x, min_y, max_x, max_y, level)
                    .ok_or_else(|| Error::NoData("polygon does not overlap the raster".into()))?;
            }
            None => {
                return Err(Error::Invalid(format!(
                    "query would read {} pixels, above the {} pixel limit, and the raster has no \
                     coarser overview; draw a smaller area or use an overview-enabled COG",
                    window.pixel_count(),
                    options.max_pixels
                )));
            }
        }
    }

    let values = read_window(raster, level, window, options.band)?;
    let mut samples: Vec<(f64, f64)> = Vec::new(); // (value, weight)
    let mut nodata_count = 0u64;

    for row in 0..window.height {
        for col in 0..window.width {
            let (x, y) = transform.pixel_center(window.x + col, window.y + row);
            if !polygon.contains(&Point::new(x, y)) {
                continue;
            }
            let value = values[(row * window.width + col) as usize];
            if value.is_nan() {
                nodata_count += 1;
                continue;
            }
            let weight = if options.geographic { y.to_radians().cos().max(0.0) } else { 1.0 };
            samples.push((value, weight));
        }
    }

    let pixel_area_km2 = cell_area_km2(&transform, (min_y + max_y) / 2.0, options.geographic);

    if samples.is_empty() {
        // Sub-pixel polygon, or entirely nodata.
        let (cx, cy) = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
        let (fcol, frow) = transform.world_to_pixel(cx, cy);
        let col = fcol.floor() as i64;
        let row = frow.floor() as i64;
        let single = Window::clip(col, row, col, row, level.width, level.height).ok_or_else(|| {
            Error::NoData("polygon centroid falls outside the raster".into())
        })?;
        let value = read_window(raster, level, single, options.band)?
            .first()
            .copied()
            .unwrap_or(f64::NAN);
        if value.is_nan() {
            return Err(Error::NoData(
                "no valid raster pixels inside the area (all nodata)".into(),
            ));
        }
        return Ok(ZonalStats {
            method: ZonalMethod::CentroidSample,
            count: 1,
            nodata_count,
            min: value,
            max: value,
            mean: value,
            area_weighted_mean: value,
            median: value,
            std_dev: 0.0,
            sum: value,
            level_scale: level.scale,
            pixel_area_km2,
        });
    }

    Ok(summarise(samples, nodata_count, level.scale, pixel_area_km2))
}

fn pixel_window(
    transform: &GeoTransform,
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
    level: RasterLevel,
) -> Option<Window> {
    let (x0, y0, x1, y1) = transform.bbox_to_pixels(min_x, min_y, max_x, max_y);
    Window::clip(x0, y0, x1, y1, level.width, level.height)
}

fn cell_area_km2(transform: &GeoTransform, mid_lat: f64, geographic: bool) -> f64 {
    if !geographic {
        return transform.pixel_width.abs() * transform.pixel_height.abs() / 1_000_000.0;
    }
    // Degree lengths on a sphere of mean Earth radius.
    const KM_PER_DEG: f64 = 111.319_491;
    let height_km = transform.pixel_height.abs() * KM_PER_DEG;
    let width_km = transform.pixel_width.abs() * KM_PER_DEG * mid_lat.to_radians().cos().abs();
    width_km * height_km
}

fn summarise(
    mut samples: Vec<(f64, f64)>,
    nodata_count: u64,
    level_scale: f64,
    pixel_area_km2: f64,
) -> ZonalStats {
    let count = samples.len() as u64;
    let sum: f64 = samples.iter().map(|(v, _)| *v).sum();
    let mean = sum / count as f64;

    let weight_sum: f64 = samples.iter().map(|(_, w)| *w).sum();
    let area_weighted_mean = if weight_sum > 0.0 {
        samples.iter().map(|(v, w)| v * w).sum::<f64>() / weight_sum
    } else {
        mean
    };

    let variance = samples.iter().map(|(v, _)| (v - mean).powi(2)).sum::<f64>() / count as f64;

    samples.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let median = if count % 2 == 1 {
        samples[(count / 2) as usize].0
    } else {
        let hi = (count / 2) as usize;
        (samples[hi - 1].0 + samples[hi].0) / 2.0
    };

    ZonalStats {
        method: ZonalMethod::PixelsInPolygon,
        count,
        nodata_count,
        min: samples.first().map(|s| s.0).unwrap_or(f64::NAN),
        max: samples.last().map(|s| s.0).unwrap_or(f64::NAN),
        mean,
        area_weighted_mean,
        median,
        std_dev: variance.sqrt(),
        sum,
        level_scale,
        pixel_area_km2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(min: f64, max: f64) -> Vec<Vec<[f64; 2]>> {
        vec![vec![[min, min], [max, min], [max, max], [min, max], [min, min]]]
    }

    #[test]
    fn builds_multipolygon_from_rings() {
        let mp = multipolygon_from_rings(&square(0.0, 1.0)).unwrap();
        assert!(mp.contains(&Point::new(0.5, 0.5)));
        assert!(!mp.contains(&Point::new(1.5, 0.5)));
    }

    #[test]
    fn rejects_degenerate_rings() {
        let rings = vec![vec![[0.0, 0.0], [1.0, 1.0]]];
        assert!(multipolygon_from_rings(&rings).is_err());
    }

    #[test]
    fn summarises_values_with_latitude_weighting() {
        // Equal values must give identical weighted and unweighted means.
        let samples = vec![(1000.0, 1.0), (1200.0, 0.5)];
        let stats = summarise(samples, 0, 1.0, 1.0);
        assert_eq!(stats.count, 2);
        assert!((stats.mean - 1100.0).abs() < 1e-9);
        // Weighted mean leans toward the higher-weight (lower latitude) sample.
        assert!(stats.area_weighted_mean < stats.mean);
        assert!((stats.median - 1100.0).abs() < 1e-9);
        assert!((stats.sum - 2200.0).abs() < 1e-9);
        assert!(stats.std_dev > 0.0);
    }

    #[test]
    fn median_of_odd_sample_count_is_middle_value() {
        let samples = vec![(3.0, 1.0), (1.0, 1.0), (2.0, 1.0)];
        let stats = summarise(samples, 1, 2.0, 0.5);
        assert_eq!(stats.median, 2.0);
        assert_eq!(stats.min, 1.0);
        assert_eq!(stats.max, 3.0);
        assert_eq!(stats.nodata_count, 1);
        assert_eq!(stats.level_scale, 2.0);
    }

    #[test]
    fn geographic_cell_area_shrinks_towards_the_poles() {
        let t = GeoTransform::new(0.0, 0.0, 0.01, -0.01);
        let equator = cell_area_km2(&t, 0.0, true);
        let high_lat = cell_area_km2(&t, 60.0, true);
        assert!(high_lat < equator);
        assert!((high_lat / equator - 0.5).abs() < 0.01);
    }
}
