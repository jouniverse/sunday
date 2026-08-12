//! Dataset discovery and install into the app data directory.
//!
//! The user points Settings at a raw datasets folder (QGIS exports, GEM CSV/JSONL,
//! Solargis GeoTIFFs). Install copies/converts into `{dataDir}/rasters` or the
//! SQLite vector store. GDAL is optional: used for COG conversion and GPKG→GeoJSON.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{Error, Result};
use crate::settings::Paths;
use crate::vector::{Feature, VectorStore};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverResult {
    pub dataset: String,
    pub path: Option<String>,
    pub kind: Option<String>,
    pub expected: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub dataset: String,
    pub installed_path: String,
    pub feature_count: Option<u64>,
    pub size_mb: f64,
    pub used_gdal: bool,
    pub detail: String,
}

/// Basenames accepted for each dataset, first match wins (recursive search).
///
/// Preferred names match layer labels in the app (except Solargis rasters, which
/// keep the GSA abbreviations). Legacy download names remain as fallbacks.
fn candidates(dataset: &str) -> &'static [&'static str] {
    match dataset {
        "gsa-ghi" => &["GHI_cog.tif", "GHI.tif"],
        "gsa-dni" => &["DNI_cog.tif", "DNI.tif"],
        "gsa-pvout" => &["PVOUT_cog.tif", "PVOUT.tif"],
        "gem-solar" => &[
            "Solar power plants.jsonl",
            "Solar power plants.csv",
            "gem-solar.jsonl",
            "GEM utility-scale.csv",
            "solar-power-plants-utility-scale-2-2026.csv",
        ],
        // Prefer GeoJSON (direct import) over GPKG (needs ogr2ogr) so a folder
        // that still contains an upstream Arrays GPKG does not win over the
        // renamed layer GeoJSON the user prepared for Install.
        "tz-sam" => &[
            "Global PV footprints.geojson",
            "Global PV footprints.gpkg",
            "global-pv-footprints.geojson",
            "tz-final-analysis-polygons.geojson",
            "2024Q1_final_analysis_polygons.gpkg",
        ],
        "gmseus-arrays" => &[
            "US ground-mounted arrays.geojson",
            "US ground-mounted arrays.gpkg",
            "gmseus.geojson",
            "GMSEUS_Arrays_Final_2025_v2_1.gpkg",
            "GMSEUS_Arrays_Final_2025_v2_0.gpkg",
        ],
        // Prefer a complete Shapefile over multi-GB GeoJSON when both exist.
        "wdpa" => &[
            "Protected areas.shp",
            "wdpa.shp",
            "Protected areas.geojson",
            "wdpa-poly.geojson",
        ],
        _ => &[],
    }
}

pub fn gdal_available() -> bool {
    which("gdal_translate").is_some() && which("ogr2ogr").is_some()
}

fn tippecanoe_available() -> bool {
    which("tippecanoe").is_some()
}

/// Shapefile needs .shp + .shx + .dbf beside each other.
fn shapefile_complete(shp: &Path) -> bool {
    if shp.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase() != "shp" {
        return false;
    }
    let shx = shp.with_extension("shx");
    let dbf = shp.with_extension("dbf");
    shx.exists() && dbf.exists()
}

fn which(bin: &str) -> Option<PathBuf> {
    Command::new("which")
        .arg(bin)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if path.is_empty() {
                None
            } else {
                Some(PathBuf::from(path))
            }
        })
}

pub fn discover(root: &Path, dataset: &str) -> Result<DiscoverResult> {
    let expected: Vec<String> = candidates(dataset).iter().map(|s| (*s).to_string()).collect();
    if expected.is_empty() {
        return Err(Error::Invalid(format!("unknown dataset id '{dataset}'")));
    }
    if !root.is_dir() {
        return Ok(DiscoverResult {
            dataset: dataset.into(),
            path: None,
            kind: None,
            expected,
        });
    }
    for name in candidates(dataset) {
        if let Some(path) = find_basename(root, name) {
            let kind = match Path::new(name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
            {
                "tif" | "tiff" => "raster",
                "gpkg" => "gpkg",
                "geojson" | "json" => "geojson",
                "jsonl" => "jsonl",
                "csv" => "csv",
                "shp" => "shapefile",
                other => other,
            };
            // Incomplete WDPA shapefile → keep looking (often a lone .shp next to GeoJSON).
            if dataset == "wdpa" && kind == "shapefile" && !shapefile_complete(&path) {
                continue;
            }
            return Ok(DiscoverResult {
                dataset: dataset.into(),
                path: Some(path.display().to_string()),
                kind: Some(kind.into()),
                expected,
            });
        }
    }
    Ok(DiscoverResult {
        dataset: dataset.into(),
        path: None,
        kind: None,
        expected,
    })
}

fn find_basename(root: &Path, basename: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // Skip huge trees that are never install sources.
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                stack.push(path);
            } else if path.file_name().and_then(|n| n.to_str()) == Some(basename) {
                return Some(path);
            }
        }
    }
    None
}

pub fn install(paths: &Paths, dataset: &str, source_path: &Path) -> Result<InstallResult> {
    if !source_path.exists() {
        return Err(Error::Invalid(format!(
            "source file not found: {}",
            source_path.display()
        )));
    }
    match dataset {
        "gsa-ghi" | "gsa-dni" | "gsa-pvout" => install_raster(paths, dataset, source_path),
        "gem-solar" => install_gem(paths, source_path),
        "tz-sam" => install_polygons(
            paths,
            "tz-sam",
            source_path,
            "TransitionZero Solar Asset Mapper",
            // Release quarter is not present in the GeoJSON; do not invent one.
            None,
            Some("CC BY-NC 4.0"),
        ),
        "gmseus-arrays" => install_polygons(
            paths,
            "gmseus-arrays",
            source_path,
            "GM-SEUS",
            // Catalog vintage is not required; users install local files.
            None,
            Some("CC BY 4.0"),
        ),
        "wdpa" => install_wdpa(paths, source_path),
        "osm-power" | "landcover" => Err(Error::Unsupported(format!(
            "{dataset} install is not wired yet — export/setup will land in a later build"
        ))),
        _ => Err(Error::Invalid(format!("unknown dataset id '{dataset}'"))),
    }
}

/// WDPA → local PMTiles (map paint) + simplified geometries in SQLite (screening).
///
/// Requires system `ogr2ogr` and `tippecanoe`. Prefers a complete Shapefile;
/// multi-GB GeoJSON works but is slow. Never loads the full source into memory.
fn install_wdpa(paths: &Paths, source: &Path) -> Result<InstallResult> {
    if which("ogr2ogr").is_none() {
        return Err(Error::Invalid(
            "WDPA install needs GDAL ogr2ogr on PATH. Install GDAL (e.g. brew install gdal) and try again.".into(),
        ));
    }
    if !tippecanoe_available() {
        return Err(Error::Invalid(
            "WDPA install needs tippecanoe on PATH. Install it (e.g. brew install tippecanoe) and try again.".into(),
        ));
    }

    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == "shp" && !shapefile_complete(source) {
        return Err(Error::Invalid(
            "Shapefile is incomplete — need .shp, .shx and .dbf together. Or Install from Protected areas.geojson.".into(),
        ));
    }
    if !matches!(ext.as_str(), "shp" | "geojson" | "json" | "gpkg") {
        return Err(Error::Invalid(
            "WDPA install expects a .shp, .geojson or .gpkg file".into(),
        ));
    }

    fs::create_dir_all(paths.cache_dir())?;
    fs::create_dir_all(paths.vector_dir())?;

    // Simplify + reproject to a line-delimited GeoJSON for streaming SQLite import
    // and tippecanoe. 0.01° ≈ 1 km — fine for screening and low-zoom paint.
    //
    // WDPA is WGS84. Exports often omit .prj; ogr2ogr then refuses -t_srs unless
    // we declare -s_srs. Always set source SRS so Install works without a .prj.
    let simplified = paths.cache_dir().join("wdpa-simplified.jsonl");
    if simplified.exists() {
        let _ = fs::remove_file(&simplified);
    }
    let status = Command::new("ogr2ogr")
        .args([
            "-f",
            "GeoJSONSeq",
            "-s_srs",
            "EPSG:4326",
            "-t_srs",
            "EPSG:4326",
            "-simplify",
            "0.01",
            "-nlt",
            "PROMOTE_TO_MULTI",
            "-overwrite",
        ])
        .arg(&simplified)
        .arg(source)
        .status()
        .map_err(|e| Error::Invalid(format!("failed to run ogr2ogr: {e}")))?;
    if !status.success() {
        return Err(Error::Invalid(
            "ogr2ogr failed simplifying WDPA. If the shapefile has no .prj, rebuild the app (Install now assumes WGS84). Otherwise check the source file and GDAL install.".into(),
        ));
    }

    let pmtiles = paths.vector_dir().join("protected_areas.pmtiles");
    if pmtiles.exists() {
        let _ = fs::remove_file(&pmtiles);
    }
    let tippe = Command::new("tippecanoe")
        .args([
            "-o",
        ])
        .arg(&pmtiles)
        .args([
            "-zg",
            "--drop-densest-as-needed",
            "--extend-zooms-if-still-dropping",
            "-l",
            "protected_areas",
            "-y",
            "NAME",
            "-y",
            "IUCN_CAT",
            "-y",
            "DESIG_ENG",
            "-y",
            "STATUS",
            "-y",
            "MARINE",
            "-y",
            "WDPAID",
            "--force",
        ])
        .arg(&simplified)
        .status()
        .map_err(|e| Error::Invalid(format!("failed to run tippecanoe: {e}")))?;
    if !tippe.success() {
        let _ = fs::remove_file(&pmtiles);
        return Err(Error::Invalid(
            "tippecanoe failed building protected_areas.pmtiles. Check tippecanoe output in the terminal.".into(),
        ));
    }

    let count = import_wdpa_jsonl(paths, &simplified)?;
    let _ = fs::remove_file(&simplified);

    let size_mb = file_size_mb(&pmtiles).unwrap_or(0.0);
    Ok(InstallResult {
        dataset: "wdpa".into(),
        installed_path: pmtiles.display().to_string(),
        feature_count: Some(count),
        size_mb,
        used_gdal: true,
        detail: format!(
            "Built PMTiles at {} and imported {count} simplified polygons for screening",
            pmtiles.display()
        ),
    })
}

fn import_wdpa_jsonl(paths: &Paths, path: &Path) -> Result<u64> {
    use std::io::{BufRead, BufReader};

    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut store = VectorStore::open(&paths.vector_store())?;
    store.register_dataset(
        "wdpa",
        "World Database on Protected Areas",
        None,
        Some("WDPA terms of use (non-commercial)"),
        None,
    )?;
    store.delete_dataset_features("wdpa")?;

    let mut batch: Vec<Feature> = Vec::with_capacity(2_000);
    let mut count = 0u64;
    let mut index = 0usize;

    for line in reader.lines() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(line)
            .map_err(|e| Error::Invalid(format!("invalid WDPA GeoJSONSeq line: {e}")))?;
        if let Some(mut feature) = geojson_feature_to_store("wdpa", &value, index) {
            // Promote common WDPA fields into the columns screening/UI already read.
            if feature.name.is_none() {
                feature.name = feature
                    .properties
                    .get("NAME")
                    .or_else(|| feature.properties.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
            if feature.status.is_none() {
                feature.status = feature
                    .properties
                    .get("STATUS")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
            if feature.technology.is_none() {
                feature.technology = feature
                    .properties
                    .get("IUCN_CAT")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
            if feature.country.is_none() {
                feature.country = feature
                    .properties
                    .get("ISO3")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
            // Keep a lean properties bag for click/inspect.
            feature.properties = json!({
                "name": feature.name,
                "iucnCat": feature.technology,
                "designation": feature.properties.get("DESIG_ENG").or_else(|| feature.properties.get("DESIG")).cloned().unwrap_or(serde_json::Value::Null),
                "status": feature.status,
                "marine": feature.properties.get("MARINE").cloned().unwrap_or(serde_json::Value::Null),
            });
            batch.push(feature);
            count += 1;
        }
        index += 1;
        if batch.len() >= 2_000 {
            store.insert_features(&batch)?;
            batch.clear();
        }
    }
    if !batch.is_empty() {
        store.insert_features(&batch)?;
    }
    if count == 0 {
        return Err(Error::Invalid(
            "No polygon features found after simplifying WDPA".into(),
        ));
    }
    Ok(count)
}

fn install_raster(paths: &Paths, dataset: &str, source: &Path) -> Result<InstallResult> {
    let raster_dir = paths.raster_dir();
    fs::create_dir_all(&raster_dir)?;
    let stem = match dataset {
        "gsa-ghi" => "GHI",
        "gsa-dni" => "DNI",
        "gsa-pvout" => "PVOUT",
        _ => "RASTER",
    };
    let src_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    let already_cog = src_name.contains("_cog");
    let dest = raster_dir.join(format!("{stem}_cog.tif"));
    let mut used_gdal = false;

    if already_cog || !gdal_available() {
        fs::copy(source, &dest)?;
    } else {
        // Convert raw GeoTIFF → COG. BIGTIFF is required for multi-GB GSA rasters
        // (classic TIFF tops out around 4 GiB and fails mid-write).
        let status = Command::new("gdal_translate")
            .args([
                "-of",
                "COG",
                "-co",
                "COMPRESS=DEFLATE",
                "-co",
                "BIGTIFF=YES",
                "-co",
                "OVERVIEWS=IGNORE_EXISTING",
            ])
            .arg(source)
            .arg(&dest)
            .status()
            .map_err(|e| Error::Invalid(format!("failed to run gdal_translate: {e}")))?;
        if !status.success() {
            let _ = fs::remove_file(&dest);
            // Fall back to a plain copy so Install still succeeds.
            fs::copy(source, &dest)?;
        } else {
            used_gdal = true;
        }
    }

    let size_mb = file_size_mb(&dest)?;
    Ok(InstallResult {
        dataset: dataset.into(),
        installed_path: dest.display().to_string(),
        feature_count: None,
        size_mb,
        used_gdal,
        detail: if used_gdal {
            format!("Converted to COG at {}", dest.display())
        } else {
            format!("Registered raster at {}", dest.display())
        },
    })
}

fn install_gem(paths: &Paths, source: &Path) -> Result<InstallResult> {
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let features = if ext == "jsonl" || ext == "json" && source_looks_like_jsonl(source)? {
        read_jsonl_features(source)?
    } else if ext == "csv" {
        read_gem_csv(source)?
    } else if ext == "json" {
        // Single FeatureCollection unlikely for GEM; try JSONL-style lines first.
        read_jsonl_features(source).or_else(|_| read_geojson_features(source, "gem-solar"))?
    } else {
        return Err(Error::Invalid(
            "GEM install expects gem-solar.jsonl or the utility-scale CSV".into(),
        ));
    };

    let count = features.len() as u64;
    let mut store = VectorStore::open(&paths.vector_store())?;
    store.register_dataset(
        "gem-solar",
        "Global Energy Monitor, Global Solar Power Tracker",
        Some("2026-02"),
        Some("CC BY 4.0"),
        None,
    )?;
    store.delete_dataset_features("gem-solar")?;
    store.insert_features(&features)?;
    let size_mb = (count as f64) * 0.0003; // rough; real size is in SQLite
    Ok(InstallResult {
        dataset: "gem-solar".into(),
        installed_path: paths.vector_store().display().to_string(),
        feature_count: Some(count),
        size_mb,
        used_gdal: false,
        detail: format!("Imported {count} plant phases into the vector store"),
    })
}

fn install_polygons(
    paths: &Paths,
    dataset: &str,
    source: &Path,
    source_label: &str,
    vintage: Option<&str>,
    license: Option<&str>,
) -> Result<InstallResult> {
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let (geojson_path, used_gdal, cleanup): (PathBuf, bool, Option<PathBuf>) = if ext == "gpkg" {
        if !gdal_available() {
            return Err(Error::Invalid(
                "Found a GeoPackage but GDAL/ogr2ogr is not installed. Export GeoJSON from QGIS, or install GDAL and try again.".into(),
            ));
        }
        let tmp = paths.cache_dir().join(format!("{dataset}-import.geojson"));
        fs::create_dir_all(paths.cache_dir())?;
        let status = Command::new("ogr2ogr")
            .args(["-f", "GeoJSON", "-t_srs", "EPSG:4326"])
            .arg(&tmp)
            .arg(source)
            .status()
            .map_err(|e| Error::Invalid(format!("failed to run ogr2ogr: {e}")))?;
        if !status.success() {
            return Err(Error::Invalid(
                "ogr2ogr failed converting the GeoPackage. Export GeoJSON from QGIS and Install that file.".into(),
            ));
        }
        (tmp.clone(), true, Some(tmp))
    } else if ext == "geojson" || ext == "json" {
        (source.to_path_buf(), false, None)
    } else {
        return Err(Error::Invalid(format!(
            "{dataset} install expects a .gpkg or .geojson file"
        )));
    };

    let features = read_geojson_features(&geojson_path, dataset)?;
    let count = features.len() as u64;
    if count == 0 {
        if let Some(tmp) = cleanup {
            let _ = fs::remove_file(tmp);
        }
        return Err(Error::Invalid(
            "No polygon features found in the source file".into(),
        ));
    }

    let mut store = VectorStore::open(&paths.vector_store())?;
    store.register_dataset(dataset, source_label, vintage, license, None)?;
    // Replace prior install of the same dataset.
    store.delete_dataset_features(dataset)?;
    store.insert_features(&features)?;

    if let Some(tmp) = cleanup {
        let _ = fs::remove_file(tmp);
    }

    Ok(InstallResult {
        dataset: dataset.into(),
        installed_path: paths.vector_store().display().to_string(),
        feature_count: Some(count),
        size_mb: file_size_mb(source).unwrap_or(0.0),
        used_gdal,
        detail: format!("Imported {count} footprints into the vector store"),
    })
}

fn file_size_mb(path: &Path) -> Result<f64> {
    let meta = fs::metadata(path)?;
    Ok((meta.len() as f64) / (1024.0 * 1024.0))
}

fn source_looks_like_jsonl(path: &Path) -> Result<bool> {
    let text = fs::read_to_string(path)?;
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    Ok(first.starts_with('{') && !first.contains("FeatureCollection"))
}

fn read_jsonl_features(path: &Path) -> Result<Vec<Feature>> {
    let text = fs::read_to_string(path)?;
    let mut features = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let feature: Feature = serde_json::from_str(line).map_err(|e| {
            Error::Invalid(format!("JSONL line {}: {e}", i + 1))
        })?;
        features.push(feature);
    }
    Ok(features)
}

fn read_geojson_features(path: &Path, dataset: &str) -> Result<Vec<Feature>> {
    let text = fs::read_to_string(path)?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| Error::Invalid(format!("invalid GeoJSON: {e}")))?;
    let collection = if value.get("type").and_then(|t| t.as_str()) == Some("FeatureCollection") {
        value
            .get("features")
            .and_then(|f| f.as_array())
            .cloned()
            .unwrap_or_default()
    } else if value.get("type").and_then(|t| t.as_str()) == Some("Feature") {
        vec![value]
    } else {
        return Err(Error::Invalid(
            "expected a GeoJSON FeatureCollection or Feature".into(),
        ));
    };

    let mut features = Vec::with_capacity(collection.len());
    for (i, item) in collection.into_iter().enumerate() {
        let Some(feature) = geojson_feature_to_store(dataset, &item, i) else {
            continue;
        };
        features.push(feature);
    }
    Ok(features)
}

fn geojson_feature_to_store(dataset: &str, item: &serde_json::Value, index: usize) -> Option<Feature> {
    let geometry = item.get("geometry")?;
    let geom_type = geometry.get("type")?.as_str()?;
    let (lon, lat) = centroid_of_geometry(geometry)?;
    let props = item.get("properties").cloned().unwrap_or(json!({}));
    let id = props
        .get("id")
        .or_else(|| props.get("ID"))
        .or_else(|| props.get("WDPAID"))
        .or_else(|| props.get("wdpaid"))
        .or_else(|| props.get("arrayID"))
        .or_else(|| props.get("ArrayID"))
        .or_else(|| props.get("uid"))
        .or_else(|| props.get("UID"))
        .and_then(|v| match v {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .unwrap_or_else(|| format!("{dataset}-{index}"));

    let capacity = props
        .get("capacity_mw")
        .or_else(|| props.get("capacityMw"))
        .or_else(|| props.get("Capacity_MW"))
        // GM-SEUS: estimated DC is the figure we show; nameplate is secondary.
        .or_else(|| props.get("capMWDCest"))
        .or_else(|| props.get("capMWDC"))
        .or_else(|| props.get("cap_mw"))
        .or_else(|| props.get("mw"))
        .or_else(|| props.get("p_cap_mw"))
        .and_then(|v| v.as_f64());

    let name = props
        .get("name")
        .or_else(|| props.get("Name"))
        .or_else(|| props.get("project"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let status = props
        .get("status")
        .or_else(|| props.get("Status"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let technology = props
        .get("technology")
        .or_else(|| props.get("mount"))
        .or_else(|| props.get("Mount"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let country = props
        .get("country")
        .or_else(|| props.get("Country"))
        .or_else(|| props.get("iso3"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Only store polygon/multipolygon geometry blobs; points keep null geometry.
    let geometry_out = if matches!(geom_type, "Polygon" | "MultiPolygon") {
        Some(geometry.clone())
    } else {
        None
    };

    Some(Feature {
        id,
        dataset: dataset.to_string(),
        lon,
        lat,
        capacity_mw: capacity,
        status,
        technology,
        country,
        name,
        source: String::new(), // filled from datasets table on read
        vintage: None,
        properties: props,
        geometry: geometry_out,
    })
}

fn centroid_of_geometry(geometry: &serde_json::Value) -> Option<(f64, f64)> {
    let geom_type = geometry.get("type")?.as_str()?;
    let coords = geometry.get("coordinates")?;
    match geom_type {
        "Point" => {
            let arr = coords.as_array()?;
            Some((arr.first()?.as_f64()?, arr.get(1)?.as_f64()?))
        }
        "Polygon" => {
            let ring = coords.as_array()?.first()?.as_array()?;
            average_ring(ring)
        }
        "MultiPolygon" => {
            // Use the first polygon's exterior ring.
            let ring = coords
                .as_array()?
                .first()?
                .as_array()?
                .first()?
                .as_array()?;
            average_ring(ring)
        }
        _ => None,
    }
}

fn average_ring(ring: &[serde_json::Value]) -> Option<(f64, f64)> {
    // GeoJSON rings close by repeating the first vertex — omit the duplicate.
    let end = if ring.len() >= 2 {
        let first = ring.first()?.as_array()?;
        let last = ring.last()?.as_array()?;
        if first.len() >= 2
            && last.len() >= 2
            && first.first()?.as_f64() == last.first()?.as_f64()
            && first.get(1)?.as_f64() == last.get(1)?.as_f64()
        {
            ring.len() - 1
        } else {
            ring.len()
        }
    } else {
        ring.len()
    };
    let mut sx = 0.0;
    let mut sy = 0.0;
    let mut n = 0.0;
    for pt in &ring[..end] {
        let arr = pt.as_array()?;
        let x = arr.first()?.as_f64()?;
        let y = arr.get(1)?.as_f64()?;
        sx += x;
        sy += y;
        n += 1.0;
    }
    if n < 1.0 {
        return None;
    }
    Some((sx / n, sy / n))
}

/// Minimal GEM CSV → features (Longitude/Latitude/Capacity columns vary by release).
fn read_gem_csv(path: &Path) -> Result<Vec<Feature>> {
    let text = fs::read_to_string(path)?;
    let mut lines = text.lines();
    let header = lines
        .next()
        .ok_or_else(|| Error::Invalid("GEM CSV is empty".into()))?;
    let headers = parse_csv_line(header);
    let idx = |names: &[&str]| {
        headers.iter().position(|h| {
            let lower = h.to_lowercase();
            names.iter().any(|n| lower.contains(&n.to_lowercase()))
        })
    };
    let lon_i = idx(&["longitude", "lng", "lon"]).ok_or_else(|| {
        Error::Invalid("GEM CSV missing a Longitude column".into())
    })?;
    let lat_i = idx(&["latitude", "lat"]).ok_or_else(|| {
        Error::Invalid("GEM CSV missing a Latitude column".into())
    })?;
    let id_i = idx(&["gem phase id", "phase id", "id"]);
    let cap_i = idx(&["capacity", "mw"]);
    let name_i = idx(&["project name", "name"]);
    let status_i = idx(&["status"]);
    let tech_i = idx(&["technology", "type"]);
    let country_i = idx(&["country"]);

    let mut features = Vec::new();
    for (row_i, line) in lines.enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let fields = parse_csv_line(line);
        let lon: f64 = fields.get(lon_i).and_then(|s| s.parse().ok()).unwrap_or(f64::NAN);
        let lat: f64 = fields.get(lat_i).and_then(|s| s.parse().ok()).unwrap_or(f64::NAN);
        if !lon.is_finite() || !lat.is_finite() {
            continue;
        }
        let id = id_i
            .and_then(|i| fields.get(i).cloned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("gem-{row_i}"));
        let capacity = cap_i.and_then(|i| fields.get(i)).and_then(|s| {
            s.replace(',', "").parse::<f64>().ok()
        });
        features.push(Feature {
            id,
            dataset: "gem-solar".into(),
            lon,
            lat,
            capacity_mw: capacity,
            status: status_i.and_then(|i| fields.get(i).cloned()),
            technology: tech_i.and_then(|i| fields.get(i).cloned()),
            country: country_i.and_then(|i| fields.get(i).cloned()),
            name: name_i.and_then(|i| fields.get(i).cloned()),
            source: "Global Energy Monitor, Global Solar Power Tracker".into(),
            vintage: Some("2026-02".into()),
            properties: json!({}),
            geometry: Some(json!({ "type": "Point", "coordinates": [lon, lat] })),
        });
    }
    Ok(features)
}

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            if in_quotes && chars.peek() == Some(&'"') {
                current.push('"');
                chars.next();
            } else {
                in_quotes = !in_quotes;
            }
        } else if ch == ',' && !in_quotes {
            fields.push(current);
            current = String::new();
        } else {
            current.push(ch);
        }
    }
    fields.push(current);
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn average_ring_centroid() {
        let ring = vec![
            json!([0.0, 0.0]),
            json!([2.0, 0.0]),
            json!([2.0, 2.0]),
            json!([0.0, 2.0]),
            json!([0.0, 0.0]),
        ];
        let (x, y) = average_ring(&ring).unwrap();
        assert!((x - 1.0).abs() < 1e-9);
        assert!((y - 1.0).abs() < 1e-9);
    }

    #[test]
    fn candidates_known() {
        assert_eq!(candidates("tz-sam")[0], "Global PV footprints.geojson");
        assert!(candidates("tz-sam").contains(&"global-pv-footprints.geojson"));
        assert_eq!(candidates("gmseus-arrays")[0], "US ground-mounted arrays.geojson");
        assert!(candidates("gem-solar").contains(&"Solar power plants.csv"));
    }
}
