use serde::Serialize;

/// Every fallible Tauri command returns this so the frontend gets a stable,
/// serialisable error shape instead of a stringly-typed panic message.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("tiff decode error: {0}")]
    Tiff(#[from] tiff::TiffError),

    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("http error: {0}")]
    Http(String),

    /// The request was well formed but the data cannot satisfy it, e.g. a
    /// polygon that does not intersect the raster.
    #[error("{0}")]
    NoData(String),

    #[error("invalid request: {0}")]
    Invalid(String),

    #[error("unsupported: {0}")]
    Unsupported(String),

    #[error("solar engine unavailable: {0}")]
    EngineUnavailable(String),
}

impl From<reqwest::Error> for Error {
    fn from(value: reqwest::Error) -> Self {
        Error::Http(value.to_string())
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        let kind = match self {
            Error::Io(_) => "io",
            Error::Tiff(_) => "tiff",
            Error::Sqlite(_) => "sqlite",
            Error::Json(_) => "json",
            Error::Http(_) => "http",
            Error::NoData(_) => "no_data",
            Error::Invalid(_) => "invalid",
            Error::Unsupported(_) => "unsupported",
            Error::EngineUnavailable(_) => "engine_unavailable",
        };
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("SundayError", 2)?;
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

pub type Result<T> = std::result::Result<T, Error>;
