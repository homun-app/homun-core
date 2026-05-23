use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubagentError {
    PermissionDenied(String),
    PromptBlocked(String),
    Runtime(String),
    Timeout(String),
    Cancelled(String),
}

impl SubagentError {
    pub fn as_str(&self) -> &str {
        match self {
            SubagentError::PermissionDenied(message)
            | SubagentError::PromptBlocked(message)
            | SubagentError::Runtime(message)
            | SubagentError::Timeout(message)
            | SubagentError::Cancelled(message) => message,
        }
    }
}

impl Display for SubagentError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl std::error::Error for SubagentError {}
