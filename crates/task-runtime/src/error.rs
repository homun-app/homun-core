use std::fmt;

pub type TaskRuntimeResult<T> = Result<T, TaskRuntimeError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskRuntimeError {
    NotFound(String),
    InvalidTransition(String),
    Store(String),
    ResourceUnavailable(String),
    LeaseConflict(String),
    ApprovalRequired(String),
}

impl fmt::Display for TaskRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TaskRuntimeError::NotFound(message) => write!(formatter, "not found: {message}"),
            TaskRuntimeError::InvalidTransition(message) => {
                write!(formatter, "invalid transition: {message}")
            }
            TaskRuntimeError::Store(message) => write!(formatter, "store error: {message}"),
            TaskRuntimeError::ResourceUnavailable(message) => {
                write!(formatter, "resource unavailable: {message}")
            }
            TaskRuntimeError::LeaseConflict(message) => {
                write!(formatter, "lease conflict: {message}")
            }
            TaskRuntimeError::ApprovalRequired(message) => {
                write!(formatter, "approval required: {message}")
            }
        }
    }
}

impl std::error::Error for TaskRuntimeError {}

impl From<rusqlite::Error> for TaskRuntimeError {
    fn from(error: rusqlite::Error) -> Self {
        TaskRuntimeError::Store(error.to_string())
    }
}

impl From<serde_json::Error> for TaskRuntimeError {
    fn from(error: serde_json::Error) -> Self {
        TaskRuntimeError::Store(error.to_string())
    }
}
