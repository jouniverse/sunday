//! Persistent multi-project library index under the app data directory.
//!
//! Each entry points at a `.sunday` document in `data_dir/projects/`. The index
//! itself is small JSON so switching projects does not require scanning the folder
//! on every launch, and so the last-active id survives relaunch.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::project::{self, Project};
use crate::settings::Paths;

const INDEX_FILE: &str = "library.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryIndex {
    #[serde(default)]
    pub active_id: Option<String>,
    #[serde(default)]
    pub entries: Vec<LibraryEntry>,
}

impl Paths {
    pub fn projects_dir(&self) -> PathBuf {
        self.data_dir.join("projects")
    }

    pub fn library_index(&self) -> PathBuf {
        self.projects_dir().join(INDEX_FILE)
    }

    pub fn library_project_path(&self, id: &str) -> PathBuf {
        self.projects_dir().join(format!("{id}.sunday"))
    }
}

pub fn load_index(paths: &Paths) -> Result<LibraryIndex> {
    let file = paths.library_index();
    if !file.exists() {
        return Ok(LibraryIndex::default());
    }
    let text = fs::read_to_string(&file)?;
    serde_json::from_str(&text).map_err(|e| Error::Invalid(format!("library index is corrupt: {e}")))
}

fn write_index(paths: &Paths, index: &LibraryIndex) -> Result<()> {
    fs::create_dir_all(paths.projects_dir())?;
    let file = paths.library_index();
    let temp = file.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(index)?;
    fs::write(&temp, json.as_bytes())?;
    fs::rename(&temp, &file)?;
    Ok(())
}

pub fn list(paths: &Paths) -> Result<LibraryIndex> {
    load_index(paths)
}

pub fn set_active(paths: &Paths, id: Option<String>) -> Result<LibraryIndex> {
    let mut index = load_index(paths)?;
    if let Some(ref active) = id {
        if !index.entries.iter().any(|entry| entry.id == *active) {
            return Err(Error::Invalid(format!("unknown library project id {active}")));
        }
    }
    index.active_id = id;
    write_index(paths, &index)?;
    Ok(index)
}

/// Writes the project document and upserts the library index entry.
pub fn save_entry(paths: &Paths, id: &str, project: &Project) -> Result<LibraryIndex> {
    fs::create_dir_all(paths.projects_dir())?;
    let path = paths.library_project_path(id);
    let saved = project::save(&path, project)?;

    let mut index = load_index(paths)?;
    let entry = LibraryEntry {
        id: id.to_string(),
        name: project.name.clone(),
        path: saved.display().to_string(),
        updated_at: project.updated_at.clone(),
    };
    if let Some(existing) = index.entries.iter_mut().find(|e| e.id == id) {
        *existing = entry;
    } else {
        index.entries.push(entry);
    }
    index.active_id = Some(id.to_string());
    write_index(paths, &index)?;
    Ok(index)
}

pub fn delete_entry(paths: &Paths, id: &str) -> Result<LibraryIndex> {
    let mut index = load_index(paths)?;
    let path = index
        .entries
        .iter()
        .find(|entry| entry.id == id)
        .map(|entry| PathBuf::from(&entry.path))
        .unwrap_or_else(|| paths.library_project_path(id));

    index.entries.retain(|entry| entry.id != id);
    if index.active_id.as_deref() == Some(id) {
        index.active_id = index.entries.first().map(|entry| entry.id.clone());
    }
    write_index(paths, &index)?;

    if path.exists() {
        fs::remove_file(&path)?;
    }
    // Also remove the canonical library path if it differed from the indexed path.
    let canonical = paths.library_project_path(id);
    if canonical != path && canonical.exists() {
        let _ = fs::remove_file(&canonical);
    }
    Ok(index)
}

pub fn entry_path(paths: &Paths, id: &str) -> Result<PathBuf> {
    let index = load_index(paths)?;
    index
        .entries
        .iter()
        .find(|entry| entry.id == id)
        .map(|entry| PathBuf::from(&entry.path))
        .or_else(|| {
            let candidate = paths.library_project_path(id);
            candidate.exists().then_some(candidate)
        })
        .ok_or_else(|| Error::Invalid(format!("unknown library project id {id}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use crate::project::CURRENT_SCHEMA;

    fn temp_paths() -> Paths {
        let base = std::env::temp_dir().join(format!("sunday-lib-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        Paths {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
        }
    }

    fn sample_project(name: &str) -> Project {
        Project {
            schema: CURRENT_SCHEMA,
            name: name.into(),
            created_at: "2026-07-30T12:00:00Z".into(),
            updated_at: "2026-07-30T12:30:00Z".into(),
            app_version: "0.1.0".into(),
            sites: serde_json::json!([]),
            designs: serde_json::json!([]),
            layers: serde_json::json!({}),
            view: serde_json::json!({}),
            extra: serde_json::Map::new(),
        }
    }

    #[test]
    fn save_list_delete_round_trip() {
        let paths = temp_paths();
        let index = save_entry(&paths, "p1", &sample_project("Alpha")).unwrap();
        assert_eq!(index.entries.len(), 1);
        assert_eq!(index.active_id.as_deref(), Some("p1"));
        assert!(Path::new(&index.entries[0].path).exists());

        save_entry(&paths, "p2", &sample_project("Beta")).unwrap();
        let listed = list(&paths).unwrap();
        assert_eq!(listed.entries.len(), 2);

        let after = delete_entry(&paths, "p1").unwrap();
        assert_eq!(after.entries.len(), 1);
        assert_eq!(after.active_id.as_deref(), Some("p2"));
    }
}
