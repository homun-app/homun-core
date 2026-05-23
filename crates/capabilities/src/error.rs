use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", content = "message", rename_all = "snake_case")]
pub enum CapabilityError {
    ProviderUnavailable(String),
    ProviderNotEnabled(String),
    ConnectionRequired(String),
    AuthorizationRequired(String),
    PermissionDenied(String),
    PolicyDenied(String),
    SchemaValidationFailed(String),
    ToolExecutionFailed(String),
    TriggerFailed(String),
    SecretUnavailable(String),
    ManagedProviderBoundary(String),
}

pub type CapabilityResult<T> = Result<T, CapabilityError>;

impl CapabilityError {
    pub fn as_str(&self) -> &str {
        match self {
            Self::ProviderUnavailable(message)
            | Self::ProviderNotEnabled(message)
            | Self::ConnectionRequired(message)
            | Self::AuthorizationRequired(message)
            | Self::PermissionDenied(message)
            | Self::PolicyDenied(message)
            | Self::SchemaValidationFailed(message)
            | Self::ToolExecutionFailed(message)
            | Self::TriggerFailed(message)
            | Self::SecretUnavailable(message)
            | Self::ManagedProviderBoundary(message) => message,
        }
    }
}

impl Display for CapabilityError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl std::error::Error for CapabilityError {}
