//! Sunday native core.
//!
//! Responsibilities: raster I/O over (Cloud-Optimized) GeoTIFFs, the spatial
//! vector store, project files, settings and API keys, and supervision of the
//! Python solar-physics sidecar. Everything that is pure engineering maths lives
//! in the frontend's `domain/` layer or in the sidecar; this crate is I/O.

pub mod commands;
pub mod datasets;
pub mod error;
pub mod library;
pub mod project;
pub mod raster;
pub mod settings;
pub mod sidecar;
pub mod vector;

use std::sync::{Arc, Mutex};

use error::Result;
use settings::{Paths, Settings};
use sidecar::{EngineCommand, Sidecar};
use vector::VectorStore;

pub const USER_AGENT: &str = concat!("Sunday/", env!("CARGO_PKG_VERSION"));

/// Shared native state. The vector store is opened lazily because a fresh
/// install has no datasets, and opening SQLite eagerly would create an empty
/// file before the user has chosen anything.
pub struct AppState {
    pub paths: Paths,
    pub settings: Mutex<Settings>,
    pub sidecar: Arc<Sidecar>,
    vector: Mutex<Option<VectorStore>>,
    engine_dir: Option<std::path::PathBuf>,
}

impl AppState {
    pub fn new(paths: Paths, engine_dir: Option<std::path::PathBuf>) -> Result<Self> {
        let settings = settings::load(&paths)?;
        Ok(Self {
            paths,
            settings: Mutex::new(settings),
            sidecar: Arc::new(Sidecar::default()),
            vector: Mutex::new(None),
            engine_dir,
        })
    }

    pub fn engine_command(&self) -> EngineCommand {
        commands::default_engine_command(self.engine_dir.clone())
    }

    pub fn with_vector_store<T>(&self, f: impl FnOnce(&VectorStore) -> Result<T>) -> Result<T> {
        let mut guard = self.vector.lock().expect("vector mutex");
        if guard.is_none() {
            *guard = Some(VectorStore::open(&self.paths.vector_store())?);
        }
        f(guard.as_ref().expect("store opened"))
    }

    pub fn with_vector_store_mut<T>(
        &self,
        f: impl FnOnce(&mut VectorStore) -> Result<T>,
    ) -> Result<T> {
        let mut guard = self.vector.lock().expect("vector mutex");
        if guard.is_none() {
            *guard = Some(VectorStore::open(&self.paths.vector_store())?);
        }
        f(guard.as_mut().expect("store opened"))
    }

    /// Drop the cached SQLite handle so the next query reopens after an Install
    /// that wrote through a separate connection.
    pub fn invalidate_vector_store(&self) {
        let mut guard = self.vector.lock().expect("vector mutex");
        *guard = None;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let paths = Paths::resolve().expect("application directories");
    let state = AppState::new(paths, resolve_engine_dir()).expect("application state");
    let sidecar = state.sidecar.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::raster_info,
            commands::raster_zonal_stats,
            commands::raster_viewport_preview,
            commands::vector_datasets,
            commands::vector_query_bbox,
            commands::vector_list_centroids,
            commands::vector_get_feature,
            commands::vector_nearest,
            commands::vector_import_features,
            commands::gdal_available,
            commands::dataset_discover,
            commands::dataset_install,
            commands::project_save,
            commands::project_load,
            commands::library_list,
            commands::library_save_entry,
            commands::library_delete_entry,
            commands::library_set_active,
            commands::write_file_text,
            commands::write_file_bytes,
            commands::settings_get,
            commands::settings_set_api_key,
            commands::settings_reveal_api_key,
            commands::settings_update,
            commands::engine_status,
            commands::engine_start,
            commands::engine_stop,
            commands::http_fetch_text,
        ])
        .on_window_event(move |_window, event| {
            // Never leave an orphaned Python process behind.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                sidecar.shutdown();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Sunday");
}

/// In a packaged app the sidecar binary sits next to the executable; in
/// development we run it from source with the interpreter.
fn resolve_engine_dir() -> Option<std::path::PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}
