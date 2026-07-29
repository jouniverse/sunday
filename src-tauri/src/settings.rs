//! Application settings and API keys.
//!
//! Keys stay on the user's machine in the OS application-support directory and
//! are never written into a project file or an export. `SettingsView` is what
//! the frontend receives: it reports *which* keys are present, never their
//! values, so a key cannot leak through a screenshot, a log line or a bug report.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

pub const APP_DIR: &str = "Sunday";
const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Settings {
    /// Secret values, keyed by provider id (`google_solar`, `nrel`, ...).
    pub api_keys: std::collections::BTreeMap<String, String>,
    /// Non-secret preferences owned by the frontend (units, basemap, defaults).
    pub preferences: serde_json::Value,
    /// Configured raster sources, e.g. the Solargis COG base URL or a local dir.
    pub raster_sources: serde_json::Value,
    /// Datasets the user has downloaded, keyed by dataset id.
    pub datasets: serde_json::Value,
    /// Whether first-run onboarding has been completed.
    pub onboarding_complete: bool,
}

/// The redacted projection of settings that crosses the IPC boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub configured_keys: Vec<String>,
    pub preferences: serde_json::Value,
    pub raster_sources: serde_json::Value,
    pub datasets: serde_json::Value,
    pub onboarding_complete: bool,
    pub settings_path: String,
    pub data_dir: String,
}

impl Settings {
    pub fn view(&self, paths: &Paths) -> SettingsView {
        SettingsView {
            configured_keys: self
                .api_keys
                .iter()
                .filter(|(_, value)| !value.trim().is_empty())
                .map(|(name, _)| name.clone())
                .collect(),
            preferences: self.preferences.clone(),
            raster_sources: self.raster_sources.clone(),
            datasets: self.datasets.clone(),
            onboarding_complete: self.onboarding_complete,
            settings_path: paths.settings_file().display().to_string(),
            data_dir: paths.data_dir.display().to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Paths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
}

impl Paths {
    /// macOS: `~/Library/Application Support/Sunday`. Other platforms use their
    /// own conventions via `dirs`.
    pub fn resolve() -> Result<Self> {
        let config_dir = dirs::config_dir()
            .ok_or_else(|| Error::Invalid("cannot locate a config directory".into()))?
            .join(APP_DIR);
        let data_dir = dirs::data_dir()
            .ok_or_else(|| Error::Invalid("cannot locate a data directory".into()))?
            .join(APP_DIR);
        Ok(Self { config_dir, data_dir })
    }

    pub fn settings_file(&self) -> PathBuf {
        self.config_dir.join(FILE_NAME)
    }

    pub fn vector_store(&self) -> PathBuf {
        self.data_dir.join("vector").join("sunday.sqlite")
    }

    pub fn raster_dir(&self) -> PathBuf {
        self.data_dir.join("rasters")
    }

    pub fn cache_dir(&self) -> PathBuf {
        self.data_dir.join("cache")
    }
}

pub fn load(paths: &Paths) -> Result<Settings> {
    let file = paths.settings_file();
    if !file.exists() {
        return Ok(Settings::default());
    }
    let text = std::fs::read_to_string(&file)?;
    // A corrupt settings file must not brick the app; start clean but keep a copy.
    match serde_json::from_str(&text) {
        Ok(settings) => Ok(settings),
        Err(_) => {
            let backup = file.with_extension("json.corrupt");
            std::fs::rename(&file, &backup).ok();
            Ok(Settings::default())
        }
    }
}

pub fn save(paths: &Paths, settings: &Settings) -> Result<()> {
    std::fs::create_dir_all(&paths.config_dir)?;
    let file = paths.settings_file();
    let temp = file.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_string_pretty(settings)?)?;
    std::fs::rename(&temp, &file)?;
    restrict_permissions(&file);
    Ok(())
}

/// Settings hold API keys, so the file is owner-only.
#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = std::fs::metadata(path) {
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o600);
        std::fs::set_permissions(path, permissions).ok();
    }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> Paths {
        let base = std::env::temp_dir().join(format!("sunday-settings-{}", std::process::id()));
        Paths { config_dir: base.join("config"), data_dir: base.join("data") }
    }

    #[test]
    fn view_redacts_key_values_and_lists_names() {
        let mut settings = Settings::default();
        settings.api_keys.insert("google_solar".into(), "AIzaSECRET".into());
        settings.api_keys.insert("nrel".into(), "   ".into());

        let view = settings.view(&paths());
        let json = serde_json::to_string(&view).unwrap();
        assert!(json.contains("google_solar"));
        assert!(!json.contains("AIzaSECRET"), "secret leaked into the view");
        // A blank key counts as not configured.
        assert_eq!(view.configured_keys, vec!["google_solar".to_string()]);
    }

    #[test]
    fn round_trips_settings_on_disk() {
        let paths = paths();
        let mut settings = Settings::default();
        settings.api_keys.insert("nrel".into(), "abc123".into());
        settings.preferences = serde_json::json!({ "units": "metric" });
        settings.onboarding_complete = true;

        save(&paths, &settings).unwrap();
        let loaded = load(&paths).unwrap();
        assert_eq!(loaded.api_keys.get("nrel").map(String::as_str), Some("abc123"));
        assert_eq!(loaded.preferences["units"], "metric");
        assert!(loaded.onboarding_complete);
        std::fs::remove_dir_all(paths.config_dir.parent().unwrap()).ok();
    }

    #[test]
    fn missing_file_yields_defaults() {
        let paths = Paths {
            config_dir: std::env::temp_dir().join("sunday-absent-config"),
            data_dir: std::env::temp_dir().join("sunday-absent-data"),
        };
        std::fs::remove_dir_all(&paths.config_dir).ok();
        let settings = load(&paths).unwrap();
        assert!(settings.api_keys.is_empty());
        assert!(!settings.onboarding_complete);
    }

    #[test]
    fn corrupt_file_is_quarantined_not_fatal() {
        let paths = Paths {
            config_dir: std::env::temp_dir().join(format!("sunday-corrupt-{}", std::process::id())),
            data_dir: std::env::temp_dir().join("sunday-corrupt-data"),
        };
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        std::fs::write(paths.settings_file(), "{ broken").unwrap();

        let settings = load(&paths).unwrap();
        assert!(settings.api_keys.is_empty());
        assert!(paths.settings_file().with_extension("json.corrupt").exists());
        std::fs::remove_dir_all(&paths.config_dir).ok();
    }
}
