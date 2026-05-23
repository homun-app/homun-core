use std::fmt::{Display, Formatter};

pub type SecretResult<T> = Result<T, SecretError>;

#[derive(Debug)]
pub enum SecretError {
    InvalidRef(String),
    Utf8(std::string::FromUtf8Error),
    Json(serde_json::Error),
    Io(std::io::Error),
    Crypto(String),
    Unsupported(String),
}

impl Display for SecretError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRef(message) => write!(f, "invalid secret ref: {message}"),
            Self::Utf8(error) => write!(f, "utf8 error: {error}"),
            Self::Json(error) => write!(f, "json error: {error}"),
            Self::Io(error) => write!(f, "io error: {error}"),
            Self::Crypto(message) => write!(f, "crypto error: {message}"),
            Self::Unsupported(message) => write!(f, "unsupported secret backend: {message}"),
        }
    }
}

impl std::error::Error for SecretError {}

impl From<std::string::FromUtf8Error> for SecretError {
    fn from(value: std::string::FromUtf8Error) -> Self {
        Self::Utf8(value)
    }
}

impl From<serde_json::Error> for SecretError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

impl From<std::io::Error> for SecretError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}
