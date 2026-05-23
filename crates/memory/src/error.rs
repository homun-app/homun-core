use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MemoryError {
    Store(String),
    Policy(String),
    Validation(String),
    NotFound(String),
}

pub type MemoryResult<T> = Result<T, MemoryError>;

impl MemoryError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    pub fn policy(message: impl Into<String>) -> Self {
        Self::Policy(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn as_str(&self) -> &str {
        match self {
            MemoryError::Store(message)
            | MemoryError::Policy(message)
            | MemoryError::Validation(message)
            | MemoryError::NotFound(message) => message,
        }
    }
}

impl From<String> for MemoryError {
    fn from(value: String) -> Self {
        Self::Store(value)
    }
}

impl From<&str> for MemoryError {
    fn from(value: &str) -> Self {
        Self::Store(value.to_string())
    }
}

impl From<MemoryError> for String {
    fn from(value: MemoryError) -> Self {
        value.as_str().to_string()
    }
}

impl PartialEq<&str> for MemoryError {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl Display for MemoryError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl std::error::Error for MemoryError {}
