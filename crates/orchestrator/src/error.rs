use std::fmt::{Display, Formatter};

#[derive(Debug)]
pub enum OrchestratorError {
    Capability(String),
    Memory(String),
    Planner(String),
    Store(String),
}

impl Display for OrchestratorError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            OrchestratorError::Capability(message) => {
                write!(formatter, "capability error: {message}")
            }
            OrchestratorError::Memory(message) => write!(formatter, "memory error: {message}"),
            OrchestratorError::Planner(message) => write!(formatter, "planner error: {message}"),
            OrchestratorError::Store(message) => write!(formatter, "store error: {message}"),
        }
    }
}

impl std::error::Error for OrchestratorError {}

pub type OrchestratorResult<T> = Result<T, OrchestratorError>;

impl From<local_first_capabilities::CapabilityError> for OrchestratorError {
    fn from(error: local_first_capabilities::CapabilityError) -> Self {
        OrchestratorError::Capability(error.as_str().to_string())
    }
}

impl From<local_first_task_runtime::TaskRuntimeError> for OrchestratorError {
    fn from(error: local_first_task_runtime::TaskRuntimeError) -> Self {
        OrchestratorError::Store(error.to_string())
    }
}

impl From<rusqlite::Error> for OrchestratorError {
    fn from(error: rusqlite::Error) -> Self {
        OrchestratorError::Store(error.to_string())
    }
}

impl From<serde_json::Error> for OrchestratorError {
    fn from(error: serde_json::Error) -> Self {
        OrchestratorError::Planner(error.to_string())
    }
}
