use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubagentError {
    PermissionDenied(String),
    PromptBlocked(String),
    Runtime(String),
    Timeout(String),
    Cancelled(String),
    CircuitOpen(String),
}

impl SubagentError {
    pub fn as_str(&self) -> &str {
        match self {
            SubagentError::PermissionDenied(message)
            | SubagentError::PromptBlocked(message)
            | SubagentError::Runtime(message)
            | SubagentError::Timeout(message)
            | SubagentError::Cancelled(message)
            | SubagentError::CircuitOpen(message) => message,
        }
    }

    /// Returns `true` if the error is transient and the operation may succeed on retry.
    ///
    /// Transient errors: network timeouts, model 5xx, circuit-open (may close later).
    /// Non-transient errors: auth/permission failures, prompt blocks, invalid requests.
    pub fn is_transient(&self) -> bool {
        match self {
            SubagentError::Timeout(_) | SubagentError::CircuitOpen(_) => true,
            SubagentError::Runtime(msg) => is_transient_runtime_message(msg),
            SubagentError::PermissionDenied(_)
            | SubagentError::PromptBlocked(_)
            | SubagentError::Cancelled(_) => false,
        }
    }
}

fn is_transient_runtime_message(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("status(5")
        || lower.contains("status: 5")
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("connection")
        || lower.contains("dns")
        || lower.contains("unavailable")
}

impl Display for SubagentError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl std::error::Error for SubagentError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_classification() {
        assert!(SubagentError::Timeout("t".into()).is_transient());
        assert!(SubagentError::CircuitOpen("c".into()).is_transient());
        assert!(SubagentError::Runtime("Status(503)".into()).is_transient());
        assert!(SubagentError::Runtime("status: 503".into()).is_transient());
        assert!(SubagentError::Runtime("connection refused".into()).is_transient());
        assert!(SubagentError::Runtime("timed out waiting".into()).is_transient());
        assert!(!SubagentError::Runtime("status: 400".into()).is_transient());
        assert!(!SubagentError::PermissionDenied("p".into()).is_transient());
        assert!(!SubagentError::PromptBlocked("b".into()).is_transient());
    }
}
