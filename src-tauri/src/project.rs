//! Project files: `.sunday` documents holding sites, designs and layer state.
//!
//! A desktop app should let people keep their work in ordinary files they can
//! move, back up and diff. The format is therefore plain pretty-printed JSON
//! with an explicit schema version and a forward-compatible `extra` bag, so an
//! older build never destroys data written by a newer one.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

pub const CURRENT_SCHEMA: u32 = 1;
pub const FILE_EXTENSION: &str = "sunday";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Schema version of the document as read from disk.
    pub schema: u32,
    pub name: String,
    /// RFC 3339 timestamps, written by the frontend which owns the clock.
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub app_version: String,
    /// Sites, designs, layers and view state. Kept opaque here on purpose: the
    /// frontend owns these schemas, and Rust must not need a release to store a
    /// new field.
    #[serde(default)]
    pub sites: serde_json::Value,
    #[serde(default)]
    pub designs: serde_json::Value,
    #[serde(default)]
    pub layers: serde_json::Value,
    #[serde(default)]
    pub view: serde_json::Value,
    /// Anything a newer build wrote that this one does not understand.
    #[serde(default, flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProject {
    pub path: PathBuf,
    pub project: Project,
    /// True when the file was written by a newer schema and fields were kept
    /// verbatim; the UI warns before overwriting.
    pub from_newer_schema: bool,
}

pub fn save(path: &Path, project: &Project) -> Result<PathBuf> {
    let path = with_extension(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut document = project.clone();
    document.schema = CURRENT_SCHEMA;
    let json = serde_json::to_string_pretty(&document)?;

    // Write to a sibling temp file and rename, so a crash mid-write cannot
    // truncate an existing project.
    let temp = path.with_extension(format!("{FILE_EXTENSION}.tmp"));
    std::fs::write(&temp, json.as_bytes())?;
    std::fs::rename(&temp, &path)?;
    Ok(path)
}

pub fn load(path: &Path) -> Result<LoadedProject> {
    let text = std::fs::read_to_string(path)?;
    let project: Project = serde_json::from_str(&text).map_err(|e| {
        Error::Invalid(format!("{} is not a readable Sunday project: {e}", path.display()))
    })?;
    Ok(LoadedProject {
        path: path.to_path_buf(),
        from_newer_schema: project.schema > CURRENT_SCHEMA,
        project,
    })
}

fn with_extension(path: &Path) -> PathBuf {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext == FILE_EXTENSION => path.to_path_buf(),
        _ => {
            let mut owned = path.as_os_str().to_owned();
            owned.push(".");
            owned.push(FILE_EXTENSION);
            PathBuf::from(owned)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Project {
        Project {
            schema: CURRENT_SCHEMA,
            name: "Mojave Site B".into(),
            created_at: "2026-07-29T12:00:00Z".into(),
            updated_at: "2026-07-29T12:30:00Z".into(),
            app_version: "0.1.0".into(),
            sites: serde_json::json!([{ "id": "s1", "area_m2": 842_000.0 }]),
            designs: serde_json::json!([]),
            layers: serde_json::json!({ "satellite": true }),
            view: serde_json::json!({ "zoom": 14.5 }),
            extra: serde_json::Map::new(),
        }
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("sunday-test-{}", std::process::id()));
        let path = dir.join("site");
        let saved = save(&path, &sample()).unwrap();
        assert_eq!(saved.extension().unwrap(), FILE_EXTENSION);

        let loaded = load(&saved).unwrap();
        assert_eq!(loaded.project.name, "Mojave Site B");
        assert_eq!(loaded.project.schema, CURRENT_SCHEMA);
        assert!(!loaded.from_newer_schema);
        assert_eq!(loaded.project.view["zoom"], 14.5);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn appends_extension_only_when_missing() {
        assert_eq!(with_extension(Path::new("a/b")), PathBuf::from("a/b.sunday"));
        assert_eq!(with_extension(Path::new("a/b.sunday")), PathBuf::from("a/b.sunday"));
        assert_eq!(with_extension(Path::new("a/b.json")), PathBuf::from("a/b.json.sunday"));
    }

    #[test]
    fn preserves_unknown_fields_from_newer_versions() {
        let text = r#"{
            "schema": 99,
            "name": "Future",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "cspHeliostats": [{ "id": "h1" }]
        }"#;
        let dir = std::env::temp_dir().join(format!("sunday-future-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("future.sunday");
        std::fs::write(&path, text).unwrap();

        let loaded = load(&path).unwrap();
        assert!(loaded.from_newer_schema);
        assert!(loaded.project.extra.contains_key("cspHeliostats"));

        // Re-saving must not drop the unknown field.
        let saved = save(&path, &loaded.project).unwrap();
        let text = std::fs::read_to_string(&saved).unwrap();
        assert!(text.contains("cspHeliostats"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rejects_files_that_are_not_projects() {
        let dir = std::env::temp_dir().join(format!("sunday-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bad.sunday");
        std::fs::write(&path, "not json").unwrap();
        assert!(load(&path).is_err());
        std::fs::remove_dir_all(dir).ok();
    }
}
