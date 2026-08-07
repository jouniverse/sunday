//! Vector data store for plant inventories and other point/polygon datasets.
//!
//! The dataset review is explicit that a 109 MB GEM GeoJSON must not be handed
//! to the map: it is preprocessed into SQLite with an R*Tree index, and the map
//! asks for the current viewport only. Attributes stay as JSON so a dataset can
//! evolve without a schema migration, while the columns we filter and rank on
//! are promoted to real columns.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// A feature as stored and returned. `geometry` is GeoJSON; for large polygon
/// datasets it is only populated on demand (`include_geometry`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feature {
    pub id: String,
    pub dataset: String,
    pub lon: f64,
    pub lat: f64,
    /// Nameplate or estimated capacity in MW, when the dataset carries one.
    pub capacity_mw: Option<f64>,
    pub status: Option<String>,
    pub technology: Option<String>,
    pub country: Option<String>,
    pub name: Option<String>,
    /// Provenance, never optional in practice: the UI renders a trust badge from it.
    pub source: String,
    pub vintage: Option<String>,
    pub properties: serde_json::Value,
    pub geometry: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BboxQuery {
    pub dataset: String,
    pub min_lon: f64,
    pub min_lat: f64,
    pub max_lon: f64,
    pub max_lat: f64,
    /// Cap on returned rows; the caller pairs this with `total` to show "showing
    /// N of M" rather than silently truncating.
    pub limit: u32,
    pub include_geometry: bool,
    pub statuses: Option<Vec<String>>,
    pub technologies: Option<Vec<String>>,
    pub min_capacity_mw: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BboxResult {
    pub features: Vec<Feature>,
    /// Rows matching the query before `limit` was applied.
    pub total: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSummary {
    pub dataset: String,
    pub source: String,
    pub vintage: Option<String>,
    pub license: Option<String>,
    pub feature_count: u64,
    pub total_capacity_mw: Option<f64>,
}

/// Lean point for clustered map display — no properties JSON, no geometry blob.
///
/// Dense geospatial display loads these once into a client-side cluster index
/// instead of re-querying the viewport on every pan/zoom.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlantCentroid {
    pub id: String,
    pub lon: f64,
    pub lat: f64,
    pub capacity_mw: Option<f64>,
    pub status: Option<String>,
    pub technology: Option<String>,
    pub country: Option<String>,
    pub name: Option<String>,
    pub source: String,
    pub vintage: Option<String>,
}

pub struct VectorStore {
    conn: Connection,
}

impl VectorStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self> {
        let store = Self { conn: Connection::open_in_memory()? };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS datasets (
                 dataset      TEXT PRIMARY KEY,
                 source       TEXT NOT NULL,
                 vintage      TEXT,
                 license      TEXT,
                 metadata     TEXT
             );
             CREATE TABLE IF NOT EXISTS features (
                 rowid        INTEGER PRIMARY KEY,
                 id           TEXT NOT NULL,
                 dataset      TEXT NOT NULL,
                 lon          REAL NOT NULL,
                 lat          REAL NOT NULL,
                 capacity_mw  REAL,
                 status       TEXT,
                 technology   TEXT,
                 country      TEXT,
                 name         TEXT,
                 properties   TEXT NOT NULL DEFAULT '{}',
                 geometry     TEXT,
                 UNIQUE(dataset, id)
             );
             CREATE INDEX IF NOT EXISTS features_dataset ON features(dataset);
             CREATE INDEX IF NOT EXISTS features_country ON features(dataset, country);
             CREATE INDEX IF NOT EXISTS features_capacity ON features(dataset, capacity_mw);",
        )?;

        // R*Tree makes viewport queries O(log n); if this SQLite build lacks the
        // module we fall back to the lon/lat index rather than failing to open.
        let rtree = self.conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS features_index USING rtree(
                 id, min_lon, max_lon, min_lat, max_lat
             );",
        );
        if rtree.is_err() {
            self.conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS features_lonlat ON features(dataset, lon, lat);",
            )?;
        }

        // Older installs labelled GM-SEUS as v2.0; features already carry version v2_1.
        let _ = self.conn.execute(
            "UPDATE datasets SET source = 'GM-SEUS v2.1', vintage = '2025'
             WHERE dataset = 'gmseus-arrays' AND source != 'GM-SEUS v2.1'",
            [],
        );

        // TZ-SAM GeoJSON has no release stamp; drop invented Q1/Q2 labels from older installs.
        let _ = self.conn.execute(
            "UPDATE datasets SET vintage = NULL WHERE dataset = 'tz-sam'",
            [],
        );

        Ok(())
    }

    fn has_rtree(&self) -> bool {
        self.conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE name = 'features_index'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .ok()
            .flatten()
            .is_some()
    }

    pub fn register_dataset(
        &self,
        dataset: &str,
        source: &str,
        vintage: Option<&str>,
        license: Option<&str>,
        metadata: Option<&serde_json::Value>,
    ) -> Result<()> {
        let metadata = metadata.map(|m| m.to_string());
        self.conn.execute(
            "INSERT INTO datasets (dataset, source, vintage, license, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(dataset) DO UPDATE SET
                 source = excluded.source,
                 vintage = excluded.vintage,
                 license = excluded.license,
                 metadata = excluded.metadata",
            params![dataset, source, vintage, license, metadata],
        )?;
        Ok(())
    }

    /// Remove all features for a dataset before a full re-install.
    pub fn delete_dataset_features(&self, dataset: &str) -> Result<usize> {
        if self.has_rtree() {
            self.conn.execute(
                "DELETE FROM features_index WHERE id IN (
                     SELECT rowid FROM features WHERE dataset = ?1
                 )",
                params![dataset],
            )?;
        }
        let n = self
            .conn
            .execute("DELETE FROM features WHERE dataset = ?1", params![dataset])?;
        Ok(n)
    }

    /// Bulk insert inside one transaction. Ingestion of ~100k GEM rows is a
    /// single statement loop, not 100k transactions.
    pub fn insert_features(&mut self, features: &[Feature]) -> Result<usize> {
        let use_rtree = self.has_rtree();
        let tx = self.conn.transaction()?;
        let mut inserted = 0usize;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO features
                     (id, dataset, lon, lat, capacity_mw, status, technology, country, name,
                      properties, geometry)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(dataset, id) DO UPDATE SET
                     lon = excluded.lon, lat = excluded.lat,
                     capacity_mw = excluded.capacity_mw, status = excluded.status,
                     technology = excluded.technology, country = excluded.country,
                     name = excluded.name, properties = excluded.properties,
                     geometry = excluded.geometry
                 RETURNING rowid",
            )?;
            let mut index_stmt = if use_rtree {
                Some(tx.prepare(
                    "INSERT OR REPLACE INTO features_index (id, min_lon, max_lon, min_lat, max_lat)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )?)
            } else {
                None
            };

            for feature in features {
                if !feature.lon.is_finite() || !feature.lat.is_finite() {
                    return Err(Error::Invalid(format!(
                        "feature {} has non-finite coordinates",
                        feature.id
                    )));
                }
                let geometry = feature.geometry.as_ref().map(|g| g.to_string());
                let rowid: i64 = stmt.query_row(
                    params![
                        feature.id,
                        feature.dataset,
                        feature.lon,
                        feature.lat,
                        feature.capacity_mw,
                        feature.status,
                        feature.technology,
                        feature.country,
                        feature.name,
                        feature.properties.to_string(),
                        geometry,
                    ],
                    |row| row.get(0),
                )?;
                if let Some(index_stmt) = index_stmt.as_mut() {
                    index_stmt.execute(params![
                        rowid,
                        feature.lon,
                        feature.lon,
                        feature.lat,
                        feature.lat
                    ])?;
                }
                inserted += 1;
            }
        }
        tx.commit()?;
        Ok(inserted)
    }

    pub fn query_bbox(&self, query: &BboxQuery) -> Result<BboxResult> {
        let mut sql = String::from(
            "SELECT f.id, f.dataset, f.lon, f.lat, f.capacity_mw, f.status, f.technology,
                    f.country, f.name, f.properties, f.geometry,
                    COALESCE(d.source, 'unknown'), d.vintage
             FROM features f
             LEFT JOIN datasets d ON d.dataset = f.dataset ",
        );
        if self.has_rtree() {
            sql.push_str(
                "JOIN features_index x ON x.id = f.rowid
                 WHERE x.max_lon >= :min_lon AND x.min_lon <= :max_lon
                   AND x.max_lat >= :min_lat AND x.min_lat <= :max_lat
                   AND f.dataset = :dataset ",
            );
        } else {
            sql.push_str(
                "WHERE f.lon BETWEEN :min_lon AND :max_lon
                   AND f.lat BETWEEN :min_lat AND :max_lat
                   AND f.dataset = :dataset ",
            );
        }

        // Filters are inlined as literals only for numeric values and as bound
        // parameters for text, so user-provided strings never reach the SQL text.
        let mut extra = String::new();
        if let Some(min_capacity) = query.min_capacity_mw {
            extra.push_str(&format!(" AND COALESCE(f.capacity_mw, 0) >= {min_capacity} "));
        }
        let status_list = placeholder_list(query.statuses.as_deref(), "s");
        if let Some((clause, _)) = &status_list {
            extra.push_str(&format!(" AND f.status IN ({clause}) "));
        }
        let tech_list = placeholder_list(query.technologies.as_deref(), "t");
        if let Some((clause, _)) = &tech_list {
            extra.push_str(&format!(" AND f.technology IN ({clause}) "));
        }
        sql.push_str(&extra);

        // Largest first: at low zoom the plants that matter are the big ones.
        sql.push_str(" ORDER BY COALESCE(f.capacity_mw, 0) DESC, f.id ASC LIMIT :limit");

        let mut params: Vec<(&str, Box<dyn rusqlite::ToSql>)> = vec![
            (":min_lon", Box::new(query.min_lon)),
            (":max_lon", Box::new(query.max_lon)),
            (":min_lat", Box::new(query.min_lat)),
            (":max_lat", Box::new(query.max_lat)),
            (":dataset", Box::new(query.dataset.clone())),
        ];
        if let Some((_, names)) = &status_list {
            for (name, value) in names {
                params.push((name.as_str(), Box::new(value.clone())));
            }
        }
        if let Some((_, names)) = &tech_list {
            for (name, value) in names {
                params.push((name.as_str(), Box::new(value.clone())));
            }
        }

        let count_sql = sql
            .replace(
                "SELECT f.id, f.dataset, f.lon, f.lat, f.capacity_mw, f.status, f.technology,\n                    f.country, f.name, f.properties, f.geometry,\n                    COALESCE(d.source, 'unknown'), d.vintage",
                "SELECT COUNT(*)",
            )
            .replace(" ORDER BY COALESCE(f.capacity_mw, 0) DESC, f.id ASC LIMIT :limit", "");

        let include_geometry = query.include_geometry;
        let mut bound: Vec<(&str, &dyn rusqlite::ToSql)> =
            params.iter().map(|(n, v)| (*n, v.as_ref() as &dyn rusqlite::ToSql)).collect();

        let total: u64 = {
            let mut stmt = self.conn.prepare(&count_sql)?;
            stmt.query_row(&bound[..], |row| row.get::<_, i64>(0))? as u64
        };

        bound.push((":limit", &query.limit));
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(&bound[..], |row| {
            let properties: String = row.get(9)?;
            let geometry: Option<String> = row.get(10)?;
            Ok(Feature {
                id: row.get(0)?,
                dataset: row.get(1)?,
                lon: row.get(2)?,
                lat: row.get(3)?,
                capacity_mw: row.get(4)?,
                status: row.get(5)?,
                technology: row.get(6)?,
                country: row.get(7)?,
                name: row.get(8)?,
                source: row.get(11)?,
                vintage: row.get(12)?,
                properties: serde_json::from_str(&properties).unwrap_or(serde_json::Value::Null),
                geometry: if include_geometry {
                    geometry.and_then(|g| serde_json::from_str(&g).ok())
                } else {
                    None
                },
            })
        })?;

        let features: Vec<Feature> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let truncated = (features.len() as u64) < total;
        Ok(BboxResult { features, total, truncated })
    }

    /// All centroids for a dataset — one shot for client-side clustering.
    ///
    /// Deliberately omits `properties` and `geometry` so ~100k GEM rows stay a
    /// few megabytes over IPC rather than tens.
    pub fn list_centroids(&self, dataset: &str) -> Result<Vec<PlantCentroid>> {
        let mut stmt = self.conn.prepare(
            "SELECT f.id, f.lon, f.lat, f.capacity_mw, f.status, f.technology,
                    f.country, f.name, COALESCE(d.source, 'unknown'), d.vintage
             FROM features f
             LEFT JOIN datasets d ON d.dataset = f.dataset
             WHERE f.dataset = ?1
             ORDER BY COALESCE(f.capacity_mw, 0) DESC, f.id ASC",
        )?;
        let rows = stmt.query_map(params![dataset], |row| {
            Ok(PlantCentroid {
                id: row.get(0)?,
                lon: row.get(1)?,
                lat: row.get(2)?,
                capacity_mw: row.get(3)?,
                status: row.get(4)?,
                technology: row.get(5)?,
                country: row.get(6)?,
                name: row.get(7)?,
                source: row.get(8)?,
                vintage: row.get(9)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Full geometry and attributes for one feature: the plant inspector path.
    pub fn get_feature(&self, dataset: &str, id: &str) -> Result<Option<Feature>> {
        let mut stmt = self.conn.prepare(
            "SELECT f.id, f.dataset, f.lon, f.lat, f.capacity_mw, f.status, f.technology,
                    f.country, f.name, f.properties, f.geometry,
                    COALESCE(d.source, 'unknown'), d.vintage
             FROM features f LEFT JOIN datasets d ON d.dataset = f.dataset
             WHERE f.dataset = ?1 AND f.id = ?2",
        )?;
        let feature = stmt
            .query_row(params![dataset, id], |row| {
                let properties: String = row.get(9)?;
                let geometry: Option<String> = row.get(10)?;
                Ok(Feature {
                    id: row.get(0)?,
                    dataset: row.get(1)?,
                    lon: row.get(2)?,
                    lat: row.get(3)?,
                    capacity_mw: row.get(4)?,
                    status: row.get(5)?,
                    technology: row.get(6)?,
                    country: row.get(7)?,
                    name: row.get(8)?,
                    source: row.get(11)?,
                    vintage: row.get(12)?,
                    properties: serde_json::from_str(&properties)
                        .unwrap_or(serde_json::Value::Null),
                    geometry: geometry.and_then(|g| serde_json::from_str(&g).ok()),
                })
            })
            .optional()?;
        Ok(feature)
    }

    pub fn datasets(&self) -> Result<Vec<DatasetSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT d.dataset, d.source, d.vintage, d.license,
                    (SELECT COUNT(*) FROM features f WHERE f.dataset = d.dataset),
                    (SELECT SUM(f.capacity_mw) FROM features f WHERE f.dataset = d.dataset)
             FROM datasets d ORDER BY d.dataset",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(DatasetSummary {
                dataset: row.get(0)?,
                source: row.get(1)?,
                vintage: row.get(2)?,
                license: row.get(3)?,
                feature_count: row.get::<_, i64>(4)? as u64,
                total_capacity_mw: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Nearest features to a point, used for brownfield proximity context.
    /// Bounded by a degree box first so it never scans the table.
    pub fn nearest(
        &self,
        dataset: &str,
        lon: f64,
        lat: f64,
        radius_deg: f64,
        limit: u32,
    ) -> Result<Vec<(Feature, f64)>> {
        let query = BboxQuery {
            dataset: dataset.to_string(),
            min_lon: lon - radius_deg,
            min_lat: lat - radius_deg,
            max_lon: lon + radius_deg,
            max_lat: lat + radius_deg,
            limit: limit.max(1) * 20,
            include_geometry: false,
            statuses: None,
            technologies: None,
            min_capacity_mw: None,
        };
        let mut scored: Vec<(Feature, f64)> = self
            .query_bbox(&query)?
            .features
            .into_iter()
            .map(|f| {
                let distance = haversine_km(lat, lon, f.lat, f.lon);
                (f, distance)
            })
            .collect();
        scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(limit as usize);
        Ok(scored)
    }
}

fn placeholder_list(values: Option<&[String]>, prefix: &str) -> Option<(String, Vec<(String, String)>)> {
    let values = values?;
    if values.is_empty() {
        return None;
    }
    let mut clause = Vec::new();
    let mut names = Vec::new();
    for (i, value) in values.iter().enumerate() {
        let name = format!(":{prefix}{i}");
        clause.push(name.clone());
        names.push((name, value.clone()));
    }
    Some((clause.join(", "), names))
}

pub fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6371.0088;
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = p2 - p1;
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * R * a.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feature(id: &str, lon: f64, lat: f64, mw: f64, status: &str) -> Feature {
        Feature {
            id: id.to_string(),
            dataset: "gem-solar".to_string(),
            lon,
            lat,
            capacity_mw: Some(mw),
            status: Some(status.to_string()),
            technology: Some("PV".to_string()),
            country: Some("USA".to_string()),
            name: Some(format!("Plant {id}")),
            source: "GEM".to_string(),
            vintage: Some("2026-02".to_string()),
            properties: serde_json::json!({ "rating": "MWac" }),
            geometry: Some(serde_json::json!({ "type": "Point", "coordinates": [lon, lat] })),
        }
    }

    fn seeded() -> VectorStore {
        let mut store = VectorStore::open_in_memory().unwrap();
        store
            .register_dataset("gem-solar", "GEM", Some("2026-02"), Some("CC BY 4.0"), None)
            .unwrap();
        let features = vec![
            feature("a", -118.0, 34.0, 250.0, "operating"),
            feature("b", -118.1, 34.1, 80.0, "operating"),
            feature("c", -117.0, 33.0, 500.0, "announced"),
            feature("d", 12.0, 55.0, 30.0, "operating"),
        ];
        store.insert_features(&features).unwrap();
        store
    }

    #[test]
    fn queries_by_viewport() {
        let store = seeded();
        let result = store
            .query_bbox(&BboxQuery {
                dataset: "gem-solar".into(),
                min_lon: -119.0,
                min_lat: 33.5,
                max_lon: -117.5,
                max_lat: 34.5,
                limit: 10,
                include_geometry: false,
                statuses: None,
                technologies: None,
                min_capacity_mw: None,
            })
            .unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.features.len(), 2);
        // Largest capacity first.
        assert_eq!(result.features[0].id, "a");
        assert!(result.features[0].geometry.is_none());
        assert!(!result.truncated);
    }

    #[test]
    fn applies_status_and_capacity_filters() {
        let store = seeded();
        let result = store
            .query_bbox(&BboxQuery {
                dataset: "gem-solar".into(),
                min_lon: -180.0,
                min_lat: -90.0,
                max_lon: 180.0,
                max_lat: 90.0,
                limit: 100,
                include_geometry: false,
                statuses: Some(vec!["operating".into()]),
                technologies: None,
                min_capacity_mw: Some(100.0),
            })
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.features[0].id, "a");
    }

    #[test]
    fn reports_truncation_against_the_true_total() {
        let store = seeded();
        let result = store
            .query_bbox(&BboxQuery {
                dataset: "gem-solar".into(),
                min_lon: -180.0,
                min_lat: -90.0,
                max_lon: 180.0,
                max_lat: 90.0,
                limit: 2,
                include_geometry: false,
                statuses: None,
                technologies: None,
                min_capacity_mw: None,
            })
            .unwrap();
        assert_eq!(result.total, 4);
        assert_eq!(result.features.len(), 2);
        assert!(result.truncated);
    }

    #[test]
    fn fetches_one_feature_with_geometry_and_provenance() {
        let store = seeded();
        let feature = store.get_feature("gem-solar", "c").unwrap().unwrap();
        assert_eq!(feature.status.as_deref(), Some("announced"));
        assert_eq!(feature.source, "GEM");
        assert_eq!(feature.vintage.as_deref(), Some("2026-02"));
        assert!(feature.geometry.is_some());
        assert!(store.get_feature("gem-solar", "missing").unwrap().is_none());
    }

    #[test]
    fn upsert_replaces_existing_rows() {
        let mut store = seeded();
        let mut updated = feature("a", -118.0, 34.0, 275.0, "operating");
        updated.name = Some("Renamed".into());
        store.insert_features(&[updated]).unwrap();
        let stored = store.get_feature("gem-solar", "a").unwrap().unwrap();
        assert_eq!(stored.capacity_mw, Some(275.0));
        assert_eq!(stored.name.as_deref(), Some("Renamed"));
        let datasets = store.datasets().unwrap();
        assert_eq!(datasets[0].feature_count, 4);
    }

    #[test]
    fn nearest_returns_sorted_distances() {
        let store = seeded();
        let found = store.nearest("gem-solar", -118.05, 34.05, 1.0, 2).unwrap();
        assert_eq!(found.len(), 2);
        assert!(found[0].1 <= found[1].1);
    }

    #[test]
    fn lists_centroids_largest_first_without_geometry() {
        let store = seeded();
        let centroids = store.list_centroids("gem-solar").unwrap();
        assert_eq!(centroids.len(), 4);
        assert_eq!(centroids[0].id, "c"); // 500 MW
        assert_eq!(centroids[0].source, "GEM");
        assert!(store.list_centroids("missing").unwrap().is_empty());
    }

    #[test]
    fn haversine_matches_known_distance() {
        // Los Angeles to New York, ~3936 km.
        let d = haversine_km(34.0522, -118.2437, 40.7128, -74.0060);
        assert!((d - 3936.0).abs() < 20.0, "got {d}");
    }

    #[test]
    fn rejects_non_finite_coordinates() {
        let mut store = VectorStore::open_in_memory().unwrap();
        let mut bad = feature("x", f64::NAN, 0.0, 1.0, "operating");
        bad.dataset = "gem-solar".into();
        assert!(store.insert_features(&[bad]).is_err());
    }
}
