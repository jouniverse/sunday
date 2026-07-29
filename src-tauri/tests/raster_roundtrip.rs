//! End-to-end raster test: write a georeferenced GeoTIFF, then read windows and
//! zonal statistics back out of it.
//!
//! This is the test that would catch a geotransform sign error or an off-by-one
//! in chunk indexing — the failure modes that would silently attribute the wrong
//! irradiance to a site.

use std::io::{BufWriter, Cursor};
use std::path::PathBuf;

use sunday_lib::raster::zonal::{self, ZonalMethod, ZonalOptions};
use sunday_lib::raster::{self, Window};
use tiff::encoder::{colortype, TiffEncoder};
use tiff::tags::Tag;

const WIDTH: u32 = 40;
const HEIGHT: u32 = 20;
/// Upper-left corner at 10E, 50N on a 0.01 degree grid.
const ORIGIN_X: f64 = 10.0;
const ORIGIN_Y: f64 = 50.0;
const PIXEL: f64 = 0.01;
const NODATA: f64 = -9999.0;

/// Pixel value encodes its own column and row so any mis-indexing is obvious:
/// `value = 1000 + col + 100 * row`. One pixel is nodata.
fn expected_value(col: u32, row: u32) -> f64 {
    if col == 5 && row == 5 {
        return NODATA;
    }
    1000.0 + col as f64 + 100.0 * row as f64
}

/// Each test gets its own directory: the suite runs in parallel, and a shared
/// path would let one test's cleanup truncate another's file mid-read.
fn write_geotiff(case: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("sunday-raster-{}-{case}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("resource.tif");

    let mut data = Vec::with_capacity((WIDTH * HEIGHT) as usize);
    for row in 0..HEIGHT {
        for col in 0..WIDTH {
            data.push(expected_value(col, row) as f32);
        }
    }

    let file = std::fs::File::create(&path).unwrap();
    let mut encoder = TiffEncoder::new(BufWriter::new(file)).unwrap();
    let mut image = encoder
        .new_image::<colortype::Gray32Float>(WIDTH, HEIGHT)
        .unwrap();
    image
        .encoder()
        .write_tag(Tag::ModelPixelScaleTag, &[PIXEL, PIXEL, 0.0][..])
        .unwrap();
    image
        .encoder()
        .write_tag(
            Tag::ModelTiepointTag,
            &[0.0, 0.0, 0.0, ORIGIN_X, ORIGIN_Y, 0.0][..],
        )
        .unwrap();
    image
        .encoder()
        .write_tag(Tag::GdalNodata, format!("{NODATA}").as_str())
        .unwrap();
    image.write_data(&data).unwrap();
    drop(encoder);

    path
}

fn cleanup(path: &PathBuf) {
    if let Some(parent) = path.parent() {
        std::fs::remove_dir_all(parent).ok();
    }
}

#[test]
fn reads_geotransform_and_nodata_from_tags() {
    const CASE: &str = "reads_geotransform_and_nodata_from_tags";
    let path = write_geotiff(CASE);
    let open = raster::open_local(&path).unwrap();

    assert_eq!(open.info.width, WIDTH);
    assert_eq!(open.info.height, HEIGHT);
    assert_eq!(open.info.nodata, Some(NODATA));
    assert_eq!(open.info.samples_per_pixel, 1);
    assert!((open.info.transform.origin_x - ORIGIN_X).abs() < 1e-12);
    assert!((open.info.transform.origin_y - ORIGIN_Y).abs() < 1e-12);
    assert!((open.info.transform.pixel_width - PIXEL).abs() < 1e-12);
    // North-up rasters have a negative pixel height.
    assert!((open.info.transform.pixel_height + PIXEL).abs() < 1e-12);

    cleanup(&path);
}

#[test]
fn reads_an_interior_window_at_the_right_offsets() {
    const CASE: &str = "reads_an_interior_window_at_the_right_offsets";
    let path = write_geotiff(CASE);
    let mut open = raster::open_local(&path).unwrap();
    let level = open.info.levels[0];

    let window = Window { x: 3, y: 2, width: 4, height: 3 };
    let values = raster::read_window(&mut open, level, window, 0).unwrap();
    assert_eq!(values.len(), 12);

    for row in 0..window.height {
        for col in 0..window.width {
            let value = values[(row * window.width + col) as usize];
            let expected = expected_value(window.x + col, window.y + row);
            if expected == NODATA {
                assert!(value.is_nan(), "nodata pixel should read as NaN");
            } else {
                assert!((value - expected).abs() < 1e-6, "got {value}, want {expected}");
            }
        }
    }

    cleanup(&path);
}

#[test]
fn zonal_statistics_cover_exactly_the_pixels_inside_the_polygon() {
    const CASE: &str = "zonal_statistics_cover_exactly_the_pixels_inside_the_polygon";
    let path = write_geotiff(CASE);
    let mut open = raster::open_local(&path).unwrap();

    // A rectangle spanning columns 10..=13 and rows 3..=4, chosen to sit on
    // pixel boundaries so the expected pixel set is unambiguous.
    let min_x = ORIGIN_X + 10.0 * PIXEL;
    let max_x = ORIGIN_X + 14.0 * PIXEL;
    let max_y = ORIGIN_Y - 3.0 * PIXEL;
    let min_y = ORIGIN_Y - 5.0 * PIXEL;
    let rings = vec![vec![
        [min_x, min_y],
        [max_x, min_y],
        [max_x, max_y],
        [min_x, max_y],
        [min_x, min_y],
    ]];

    let polygon = zonal::multipolygon_from_rings(&rings).unwrap();
    let stats = zonal::compute(&mut open, &polygon, ZonalOptions::default()).unwrap();

    assert_eq!(stats.method, ZonalMethod::PixelsInPolygon);
    assert_eq!(stats.count, 8, "4 columns x 2 rows");
    assert_eq!(stats.nodata_count, 0);

    let mut expected: Vec<f64> = Vec::new();
    for row in 3..=4 {
        for col in 10..=13 {
            expected.push(expected_value(col, row));
        }
    }
    let expected_mean = expected.iter().sum::<f64>() / expected.len() as f64;
    assert!((stats.mean - expected_mean).abs() < 1e-6, "mean {}", stats.mean);
    assert!((stats.min - 1310.0).abs() < 1e-6);
    assert!((stats.max - 1413.0).abs() < 1e-6);
    // Latitude weighting shifts the mean slightly but must stay in range.
    assert!(stats.area_weighted_mean >= stats.min && stats.area_weighted_mean <= stats.max);
    assert!(stats.pixel_area_km2 > 0.0);

    cleanup(&path);
}

#[test]
fn nodata_pixels_are_counted_but_excluded_from_statistics() {
    const CASE: &str = "nodata_pixels_are_counted_but_excluded_from_statistics";
    let path = write_geotiff(CASE);
    let mut open = raster::open_local(&path).unwrap();

    // Columns 4..=6, rows 4..=6 — a 3x3 block containing the single nodata pixel.
    let min_x = ORIGIN_X + 4.0 * PIXEL;
    let max_x = ORIGIN_X + 7.0 * PIXEL;
    let max_y = ORIGIN_Y - 4.0 * PIXEL;
    let min_y = ORIGIN_Y - 7.0 * PIXEL;
    let rings = vec![vec![
        [min_x, min_y],
        [max_x, min_y],
        [max_x, max_y],
        [min_x, max_y],
        [min_x, min_y],
    ]];

    let polygon = zonal::multipolygon_from_rings(&rings).unwrap();
    let stats = zonal::compute(&mut open, &polygon, ZonalOptions::default()).unwrap();

    assert_eq!(stats.count, 8, "9 pixels minus 1 nodata");
    assert_eq!(stats.nodata_count, 1);
    assert!(stats.min > 0.0, "the -9999 sentinel must not enter the statistics");

    cleanup(&path);
}

#[test]
fn a_sub_pixel_polygon_falls_back_to_a_centroid_sample() {
    const CASE: &str = "a_sub_pixel_polygon_falls_back_to_a_centroid_sample";
    let path = write_geotiff(CASE);
    let mut open = raster::open_local(&path).unwrap();

    // A tiny square inside pixel (20, 10) but offset from its centre, so no
    // pixel centre falls within the polygon.
    let cx = ORIGIN_X + 20.2 * PIXEL;
    let cy = ORIGIN_Y - 10.2 * PIXEL;
    let d = PIXEL / 100.0;
    let rings = vec![vec![
        [cx - d, cy - d],
        [cx + d, cy - d],
        [cx + d, cy + d],
        [cx - d, cy + d],
        [cx - d, cy - d],
    ]];

    let polygon = zonal::multipolygon_from_rings(&rings).unwrap();
    let stats = zonal::compute(&mut open, &polygon, ZonalOptions::default()).unwrap();

    assert_eq!(stats.method, ZonalMethod::CentroidSample);
    assert_eq!(stats.count, 1);
    assert!((stats.mean - expected_value(20, 10)).abs() < 1e-6);
    assert_eq!(stats.std_dev, 0.0);

    cleanup(&path);
}

#[test]
fn a_polygon_outside_the_raster_reports_no_data() {
    const CASE: &str = "a_polygon_outside_the_raster_reports_no_data";
    let path = write_geotiff(CASE);
    let mut open = raster::open_local(&path).unwrap();

    let rings = vec![vec![
        [100.0, 10.0],
        [100.1, 10.0],
        [100.1, 10.1],
        [100.0, 10.1],
        [100.0, 10.0],
    ]];
    let polygon = zonal::multipolygon_from_rings(&rings).unwrap();
    let error = zonal::compute(&mut open, &polygon, ZonalOptions::default()).unwrap_err();
    assert!(error.to_string().contains("overlap"), "got: {error}");

    cleanup(&path);
}

#[test]
fn a_raster_without_georeferencing_is_rejected_with_guidance() {
    // A plain TIFF with no GeoTIFF tags must fail loudly, not be assumed to be
    // a whole-world 4326 grid.
    let mut buffer = Cursor::new(Vec::new());
    {
        let mut encoder = TiffEncoder::new(&mut buffer).unwrap();
        encoder
            .write_image::<colortype::Gray32Float>(4, 4, &[1.0f32; 16])
            .unwrap();
    }
    let dir = std::env::temp_dir().join(format!("sunday-plain-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("plain.tif");
    std::fs::write(&path, buffer.into_inner()).unwrap();

    let error = match raster::open_local(&path) {
        Ok(_) => panic!("a TIFF without GeoTIFF tags must not open as georeferenced"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("georeferencing"), "got: {error}");

    std::fs::remove_dir_all(dir).ok();
}
