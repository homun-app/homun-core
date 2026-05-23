use std::fmt::{Display, Formatter};

pub type BrowserResult<T> = Result<T, BrowserAutomationError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserAutomationError {
    InvalidRequest(String),
    InvalidResponse(String),
    Sidecar(String),
    NavigationBlocked(String),
    PrivateNetworkBlocked(String),
    ArtifactPath(String),
}

impl Display for BrowserAutomationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(message) => write!(formatter, "invalid_request:{message}"),
            Self::InvalidResponse(message) => write!(formatter, "invalid_response:{message}"),
            Self::Sidecar(message) => write!(formatter, "sidecar:{message}"),
            Self::NavigationBlocked(message) => write!(formatter, "navigation_blocked:{message}"),
            Self::PrivateNetworkBlocked(message) => {
                write!(formatter, "private_network_blocked:{message}")
            }
            Self::ArtifactPath(message) => write!(formatter, "artifact_path:{message}"),
        }
    }
}

impl std::error::Error for BrowserAutomationError {}

impl From<serde_json::Error> for BrowserAutomationError {
    fn from(error: serde_json::Error) -> Self {
        Self::InvalidResponse(error.to_string())
    }
}
