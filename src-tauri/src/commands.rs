//! The Tauri command surface: the only way the frontend reaches native code.
//!
//! Commands stay thin. They validate input, move blocking work off the async
//! runtime, and return serialisable results. All real logic lives in the
//! modules they call, which is what makes it unit-testable without a webview.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{Error, Result};
use crate::raster::zonal::{self, ZonalOptions, ZonalStats};
use crate::raster::{self, RasterInfo, RasterSource};
use crate::sidecar::{EngineCommand, EngineStatus};
use crate::vector::{BboxQuery, BboxResult, DatasetSummary, Feature};
use crate::AppState;

// ---------------------------------------------------------------------------
// Raster
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZonalRequest {
    pub source: RasterSource,
    /// GeoJSON-style rings: outer ring first, subsequent rings are holes.
    pub rings: Vec<Vec<[f64; 2]>>,
    #[serde(default)]
    pub band: u32,
    /// Coordinates are degrees (EPSG:4326) and get cos(latitude) weighting.
    #[serde(default = "default_true")]
    pub geographic: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZonalResponse {
    pub stats: ZonalStats,
    pub raster: RasterInfo,
}

#[tauri::command]
pub async fn raster_info(source: RasterSource) -> Result<RasterInfo> {
    // Raster I/O is blocking and can be slow over HTTP; keep it off the runtime.
    tauri::async_runtime::spawn_blocking(move || match &source {
        RasterSource::Local { path } => raster::open_local(path).map(|r| r.info),
        RasterSource::Http { url } => raster::open_http(url).map(|r| r.info),
    })
    .await
    .map_err(|e| Error::Invalid(format!("raster task failed: {e}")))?
}

#[tauri::command]
pub async fn raster_zonal_stats(request: ZonalRequest) -> Result<ZonalResponse> {
    tauri::async_runtime::spawn_blocking(move || {
        let polygon = zonal::multipolygon_from_rings(&request.rings)?;
        let options = ZonalOptions {
            band: request.band,
            geographic: request.geographic,
            ..ZonalOptions::default()
        };
        match &request.source {
            RasterSource::Local { path } => {
                let mut open = raster::open_local(path)?;
                let stats = zonal::compute(&mut open, &polygon, options)?;
                Ok(ZonalResponse { stats, raster: open.info })
            }
            RasterSource::Http { url } => {
                let mut open = raster::open_http(url)?;
                let stats = zonal::compute(&mut open, &polygon, options)?;
                Ok(ZonalResponse { stats, raster: open.info })
            }
        }
    })
    .await
    .map_err(|e| Error::Invalid(format!("zonal statistics task failed: {e}")))?
}

// ---------------------------------------------------------------------------
// Vector datasets
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn vector_datasets(state: State<'_, AppState>) -> Result<Vec<DatasetSummary>> {
    state.with_vector_store(|store| store.datasets())
}

#[tauri::command]
pub fn vector_query_bbox(state: State<'_, AppState>, query: BboxQuery) -> Result<BboxResult> {
    if query.min_lon > query.max_lon || query.min_lat > query.max_lat {
        return Err(Error::Invalid("bounding box is inverted".into()));
    }
    state.with_vector_store(|store| store.query_bbox(&query))
}

#[tauri::command]
pub fn vector_get_feature(
    state: State<'_, AppState>,
    dataset: String,
    id: String,
) -> Result<Option<Feature>> {
    state.with_vector_store(|store| store.get_feature(&dataset, &id))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyFeature {
    #[serde(flatten)]
    pub feature: Feature,
    pub distance_km: f64,
}

#[tauri::command]
pub fn vector_nearest(
    state: State<'_, AppState>,
    dataset: String,
    lon: f64,
    lat: f64,
    radius_km: f64,
    limit: u32,
) -> Result<Vec<NearbyFeature>> {
    // Convert the search radius to degrees using the worst case (a degree of
    // longitude shrinks with latitude), so the box never excludes a hit.
    let lat_pad = radius_km / 111.32;
    let lon_pad = radius_km / (111.32 * lat.to_radians().cos().abs().max(0.05));
    let radius_deg = lat_pad.max(lon_pad);
    let found = state.with_vector_store(|store| {
        store.nearest(&dataset, lon, lat, radius_deg, limit.clamp(1, 200))
    })?;
    Ok(found
        .into_iter()
        .filter(|(_, distance)| *distance <= radius_km)
        .map(|(feature, distance_km)| NearbyFeature { feature, distance_km })
        .collect())
}

#[tauri::command]
pub fn vector_import_features(
    state: State<'_, AppState>,
    dataset: String,
    source: String,
    vintage: Option<String>,
    license: Option<String>,
    features: Vec<Feature>,
) -> Result<usize> {
    state.with_vector_store_mut(|store| {
        store.register_dataset(&dataset, &source, vintage.as_deref(), license.as_deref(), None)?;
        store.insert_features(&features)
    })
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn project_save(path: String, project: crate::project::Project) -> Result<String> {
    let saved = crate::project::save(&PathBuf::from(path), &project)?;
    Ok(saved.display().to_string())
}

#[tauri::command]
pub fn project_load(path: String) -> Result<crate::project::LoadedProject> {
    crate::project::load(&PathBuf::from(path))
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/// Writes an export to a path the user has just chosen in the native save
/// dialog. Deliberately narrower than granting the frontend filesystem scope.
#[tauri::command]
pub fn write_file_text(path: String, contents: String) -> Result<()> {
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, contents)?;
    Ok(())
}

#[tauri::command]
pub fn write_file_bytes(path: String, contents: Vec<u8>) -> Result<()> {
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, contents)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Result<crate::settings::SettingsView> {
    let settings = state.settings.lock().expect("settings mutex");
    Ok(settings.view(&state.paths))
}

#[tauri::command]
pub fn settings_set_api_key(
    state: State<'_, AppState>,
    provider: String,
    key: Option<String>,
) -> Result<crate::settings::SettingsView> {
    let mut settings = state.settings.lock().expect("settings mutex");
    match key {
        Some(value) if !value.trim().is_empty() => {
            settings.api_keys.insert(provider, value.trim().to_string());
        }
        _ => {
            settings.api_keys.remove(&provider);
        }
    }
    crate::settings::save(&state.paths, &settings)?;
    Ok(settings.view(&state.paths))
}

/// Hands a key to the frontend for one outbound API call.
///
/// Keys have to reach the provider somehow; the frontend performs the requests,
/// so it must be able to ask for a specific key by name. Requesting is explicit
/// and per-provider, and keys are never included in bulk settings reads.
#[tauri::command]
pub fn settings_reveal_api_key(
    state: State<'_, AppState>,
    provider: String,
) -> Result<Option<String>> {
    let settings = state.settings.lock().expect("settings mutex");
    Ok(settings.api_keys.get(&provider).cloned())
}

#[tauri::command]
pub fn settings_update(
    state: State<'_, AppState>,
    preferences: Option<serde_json::Value>,
    raster_sources: Option<serde_json::Value>,
    datasets: Option<serde_json::Value>,
    onboarding_complete: Option<bool>,
) -> Result<crate::settings::SettingsView> {
    let mut settings = state.settings.lock().expect("settings mutex");
    if let Some(preferences) = preferences {
        settings.preferences = preferences;
    }
    if let Some(raster_sources) = raster_sources {
        settings.raster_sources = raster_sources;
    }
    if let Some(datasets) = datasets {
        settings.datasets = datasets;
    }
    if let Some(done) = onboarding_complete {
        settings.onboarding_complete = done;
    }
    crate::settings::save(&state.paths, &settings)?;
    Ok(settings.view(&state.paths))
}

// ---------------------------------------------------------------------------
// Solar engine sidecar
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn engine_status(state: State<'_, AppState>) -> EngineStatus {
    state.sidecar.status()
}

#[tauri::command]
pub async fn engine_start(state: State<'_, AppState>) -> Result<EngineStatus> {
    let command = state.engine_command();
    let sidecar = state.sidecar.clone();
    tauri::async_runtime::spawn_blocking(move || sidecar.ensure_started(command))
        .await
        .map_err(|e| Error::Invalid(format!("engine start task failed: {e}")))
}

#[tauri::command]
pub fn engine_stop(state: State<'_, AppState>) -> EngineStatus {
    state.sidecar.shutdown();
    state.sidecar.status()
}

/// Paths and capabilities the frontend needs to render the Settings view.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub config_dir: String,
    pub raster_dir: String,
    pub vector_store: String,
    pub engine: EngineStatus,
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: state.paths.data_dir.display().to_string(),
        config_dir: state.paths.config_dir.display().to_string(),
        raster_dir: state.paths.raster_dir().display().to_string(),
        vector_store: state.paths.vector_store().display().to_string(),
        engine: state.sidecar.status(),
    }
}

/// Signals that a nominally interpreter-based launch is what a dev build uses.
pub fn default_engine_command(app_dir: Option<PathBuf>) -> EngineCommand {
    match app_dir {
        Some(dir) => EngineCommand::Bundled { executable: dir.join("sunday-solar-engine") },
        None => EngineCommand::Interpreter {
            python: std::env::var("SUNDAY_PYTHON").unwrap_or_else(|_| "python3".into()),
            working_dir: PathBuf::from("../src-python"),
        },
    }
}
