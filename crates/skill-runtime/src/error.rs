use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SkillRuntimeError {
    #[error("tool_not_found:{0}")]
    ToolNotFound(String),
    #[error("schema_validation_failed:{0}")]
    SchemaValidationFailed(String),
    #[error("network_denied:{0}")]
    NetworkDenied(String),
    #[error("filesystem_denied:{0}")]
    FilesystemDenied(String),
    #[error("output_too_large:{0}")]
    OutputTooLarge(usize),
    #[error("runner_failed:{0}")]
    RunnerFailed(String),
}

pub type SkillRuntimeResult<T> = Result<T, SkillRuntimeError>;
