use std::fmt::{Display, Formatter};

pub type ProcessManagerResult<T> = Result<T, ProcessManagerError>;

#[derive(Debug)]
pub enum ProcessManagerError {
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    NotFound(String),
    InvalidSpec(String),
    Io(std::io::Error),
    Health(String),
}

impl Display for ProcessManagerError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(error) => write!(f, "sqlite error: {error}"),
            Self::Json(error) => write!(f, "json error: {error}"),
            Self::NotFound(id) => write!(f, "process not found: {id}"),
            Self::InvalidSpec(message) => write!(f, "invalid process spec: {message}"),
            Self::Io(error) => write!(f, "io error: {error}"),
            Self::Health(message) => write!(f, "health check failed: {message}"),
        }
    }
}

impl std::error::Error for ProcessManagerError {}

impl From<rusqlite::Error> for ProcessManagerError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

impl From<serde_json::Error> for ProcessManagerError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

impl From<std::io::Error> for ProcessManagerError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}
