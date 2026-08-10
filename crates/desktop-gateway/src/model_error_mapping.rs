//! Maps common model transport errors to user-facing messages.
//!
//! The model client ([`crate::model_client`]) handles HTTP, retries, and provider
//! fallbacks. When a transport error survives all recovery attempts, this module
//! provides the canonical user-readable message, a short machine code, and a
//! `retryable` flag so the frontend can render a structured `Error` event instead
//! of relying on free-form delta text alone.
//!
//! The transient/terminal classification mirrors the EXISTING retry set in
//! `model_client.rs` (`408 | 429 | 500 | 502 | 503 | 504` for HTTP; `is_timeout`
//! or `is_connect` for transport). This module does NOT change retry behavior —
//! it only classifies for messaging.

/// Classified transport error kind. Each variant maps 1:1 to a canonical
/// user-facing message and a short machine-readable code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransportErrorKind {
    /// The model took too long to respond (request timeout, headers timeout,
    /// first-token timeout, or idle timeout).
    Timeout,
    /// Connection refused — the provider rejected or dropped the TCP connection.
    ConnectionRefused,
    /// No internet connection — the network is unreachable.
    NetworkUnreachable,
    /// HTTP 5xx server error.
    HttpServer(u16),
    /// HTTP 401 / 403 — authentication or authorization failure.
    HttpAuth,
    /// HTTP 429 — rate limited.
    HttpRateLimit,
    /// Any other HTTP status not covered above.
    HttpOther(u16),
    /// The stream was interrupted or could not be decoded mid-response.
    StreamInterrupt,
}

impl TransportErrorKind {
    /// Classify from an HTTP status code returned by the model provider.
    ///
    /// Matches the existing transient set in `model_client.rs`:
    /// `408 | 429 | 500 | 502 | 503 | 504`.
    pub(crate) fn from_http_status(code: u16) -> Self {
        match code {
            401 | 403 => Self::HttpAuth,
            429 => Self::HttpRateLimit,
            408 => Self::Timeout,
            500..=599 => Self::HttpServer(code),
            other => Self::HttpOther(other),
        }
    }

    /// Classify from transport-level error flags.
    ///
    /// `is_timeout` and `is_connect` correspond to reqwest's
    /// [`Error::is_timeout`] and [`Error::is_connect`]. `is_headers_timeout`
    /// is the gateway's own pre-stream deadline ([`SendOutcome::HeadersTimeout`]).
    pub(crate) fn from_transport(
        is_timeout: bool,
        is_connect: bool,
        is_headers_timeout: bool,
    ) -> Self {
        if is_timeout || is_headers_timeout {
            Self::Timeout
        } else if is_connect {
            Self::ConnectionRefused
        } else {
            // A transport error that is neither timeout nor connect — treat as
            // a generic connection issue.
            Self::ConnectionRefused
        }
    }

    /// Best-effort refinement of a connect error: tries to distinguish
    /// "network unreachable" (no internet) from "connection refused" by walking
    /// the reqwest error's source chain for a `std::io::Error` with a matching
    /// kind. Returns `Self::ConnectionRefused` as the fallback.
    #[allow(dead_code)]
    pub(crate) fn refine_connect_error(error: &reqwest::Error) -> Self {
        let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
        while let Some(err) = source {
            if let Some(io_err) = err.downcast_ref::<std::io::Error>()
                && io_err.kind() == std::io::ErrorKind::NetworkUnreachable
            {
                return Self::NetworkUnreachable;
            }
            source = err.source();
        }
        Self::ConnectionRefused
    }

    /// Classify from a stream-collection error message string (produced by
    /// `collect_openai_stream` / `collect_ollama_native_stream`).
    ///
    /// First-token and idle timeouts are really timeouts; anything else is a
    /// stream decode interruption.
    pub(crate) fn from_stream_error(error: &str) -> Self {
        if error.contains("first token")
            || error.contains("idle")
            || error.contains("stalled")
            || error.contains("timeout")
        {
            Self::Timeout
        } else {
            Self::StreamInterrupt
        }
    }

    /// The canonical user-facing message for this error kind.
    pub(crate) fn user_message(self) -> &'static str {
        match self {
            Self::Timeout => "The model took too long to respond. Please try again.",
            Self::ConnectionRefused => {
                "Cannot connect to the model provider. Check your connection and try again."
            }
            Self::NetworkUnreachable => "No internet connection. Check your network and try again.",
            Self::HttpServer(_) => {
                "The model provider is experiencing issues. Please try again in a moment."
            }
            Self::HttpAuth => {
                "Authentication with the model provider failed. Check your API key in settings."
            }
            Self::HttpRateLimit => "Model provider rate limit reached. Waiting before retrying...",
            Self::HttpOther(_) => {
                "The model provider returned an error. Please try again or select a different model in Settings."
            }
            Self::StreamInterrupt => {
                "The model interrupted the response. Please try again shortly."
            }
        }
    }

    /// A short machine-readable code for the frontend.
    pub(crate) fn error_code(self) -> &'static str {
        match self {
            Self::Timeout => "model_timeout",
            Self::ConnectionRefused => "model_connection_refused",
            Self::NetworkUnreachable => "model_network_unreachable",
            Self::HttpServer(_) => "model_server_error",
            Self::HttpAuth => "model_auth_failed",
            Self::HttpRateLimit => "model_rate_limited",
            Self::HttpOther(_) => "model_http_error",
            Self::StreamInterrupt => "model_stream_interrupted",
        }
    }

    /// Whether this error kind is transient and the system should retry.
    ///
    /// Matches the existing retry set in `model_client.rs`:
    /// - Transient HTTP: `408 | 429 | 500 | 502 | 503 | 504`
    /// - Transient transport: timeout, connect
    /// - Headers timeout: always transient
    /// - Auth (401, 403): terminal
    /// - Other HTTP errors: terminal
    /// - Stream interruptions: terminal
    // Referenced only by unit tests below until the retry loop adopts this
    // classification; keep the contract stable meanwhile.
    #[allow(dead_code)]
    pub(crate) fn is_transient(self) -> bool {
        match self {
            Self::Timeout | Self::ConnectionRefused | Self::NetworkUnreachable => true,
            Self::HttpServer(code) => matches!(code, 500 | 502 | 503 | 504),
            Self::HttpRateLimit => true,
            Self::HttpAuth | Self::HttpOther(_) | Self::StreamInterrupt => false,
        }
    }

    /// Whether this error kind is terminal — the turn should terminate
    /// gracefully with no further retries.
    #[allow(dead_code)]
    pub(crate) fn is_terminal(self) -> bool {
        !self.is_transient()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── from_http_status ────────────────────────────────────────────────────

    #[test]
    fn http_401_classifies_as_auth() {
        assert_eq!(
            TransportErrorKind::from_http_status(401),
            TransportErrorKind::HttpAuth
        );
    }

    #[test]
    fn http_403_classifies_as_auth() {
        assert_eq!(
            TransportErrorKind::from_http_status(403),
            TransportErrorKind::HttpAuth
        );
    }

    #[test]
    fn http_429_classifies_as_rate_limit() {
        assert_eq!(
            TransportErrorKind::from_http_status(429),
            TransportErrorKind::HttpRateLimit
        );
    }

    #[test]
    fn http_408_classifies_as_timeout() {
        assert_eq!(
            TransportErrorKind::from_http_status(408),
            TransportErrorKind::Timeout
        );
    }

    #[test]
    fn http_500_classifies_as_server() {
        assert_eq!(
            TransportErrorKind::from_http_status(500),
            TransportErrorKind::HttpServer(500)
        );
    }

    #[test]
    fn http_503_classifies_as_server() {
        assert_eq!(
            TransportErrorKind::from_http_status(503),
            TransportErrorKind::HttpServer(503)
        );
    }

    #[test]
    fn http_400_classifies_as_other() {
        assert_eq!(
            TransportErrorKind::from_http_status(400),
            TransportErrorKind::HttpOther(400)
        );
    }

    #[test]
    fn http_404_classifies_as_other() {
        assert_eq!(
            TransportErrorKind::from_http_status(404),
            TransportErrorKind::HttpOther(404)
        );
    }

    #[test]
    fn http_501_classifies_as_server() {
        assert_eq!(
            TransportErrorKind::from_http_status(501),
            TransportErrorKind::HttpServer(501)
        );
    }

    // ── from_transport ───────────────────────────────────────────────────────

    #[test]
    fn transport_timeout_classifies_as_timeout() {
        assert_eq!(
            TransportErrorKind::from_transport(true, false, false),
            TransportErrorKind::Timeout
        );
    }

    #[test]
    fn headers_timeout_classifies_as_timeout() {
        assert_eq!(
            TransportErrorKind::from_transport(false, false, true),
            TransportErrorKind::Timeout
        );
    }

    #[test]
    fn connect_error_classifies_as_connection_refused() {
        assert_eq!(
            TransportErrorKind::from_transport(false, true, false),
            TransportErrorKind::ConnectionRefused
        );
    }

    #[test]
    fn generic_transport_classifies_as_connection_refused() {
        assert_eq!(
            TransportErrorKind::from_transport(false, false, false),
            TransportErrorKind::ConnectionRefused
        );
    }

    // ── from_stream_error ────────────────────────────────────────────────────

    #[test]
    fn first_token_error_classifies_as_timeout() {
        assert_eq!(
            TransportErrorKind::from_stream_error("first token timeout after 300s"),
            TransportErrorKind::Timeout
        );
    }

    #[test]
    fn idle_error_classifies_as_timeout() {
        assert_eq!(
            TransportErrorKind::from_stream_error("idle timeout: stream stalled"),
            TransportErrorKind::Timeout
        );
    }

    #[test]
    fn decode_error_classifies_as_stream_interrupt() {
        assert_eq!(
            TransportErrorKind::from_stream_error("invalid JSON in stream"),
            TransportErrorKind::StreamInterrupt
        );
    }

    // ── user_message ─────────────────────────────────────────────────────────

    #[test]
    fn timeout_message_matches_spec() {
        assert_eq!(
            TransportErrorKind::Timeout.user_message(),
            "The model took too long to respond. Please try again."
        );
    }

    #[test]
    fn connection_refused_message_matches_spec() {
        assert_eq!(
            TransportErrorKind::ConnectionRefused.user_message(),
            "Cannot connect to the model provider. Check your connection and try again."
        );
    }

    #[test]
    fn network_unreachable_message_matches_spec() {
        assert_eq!(
            TransportErrorKind::NetworkUnreachable.user_message(),
            "No internet connection. Check your network and try again."
        );
    }

    #[test]
    fn http_server_message_matches_spec() {
        assert_eq!(
            TransportErrorKind::HttpServer(503).user_message(),
            "The model provider is experiencing issues. Please try again in a moment."
        );
    }

    #[test]
    fn http_auth_message_matches_spec() {
        assert_eq!(
            TransportErrorKind::HttpAuth.user_message(),
            "Authentication with the model provider failed. Check your API key in settings."
        );
    }

    #[test]
    fn http_rate_limit_message_matches_spec() {
        assert_eq!(
            TransportErrorKind::HttpRateLimit.user_message(),
            "Model provider rate limit reached. Waiting before retrying..."
        );
    }

    // ── error_code ───────────────────────────────────────────────────────────

    #[test]
    fn error_codes_are_distinct() {
        let kinds = [
            TransportErrorKind::Timeout,
            TransportErrorKind::ConnectionRefused,
            TransportErrorKind::NetworkUnreachable,
            TransportErrorKind::HttpServer(500),
            TransportErrorKind::HttpAuth,
            TransportErrorKind::HttpRateLimit,
            TransportErrorKind::HttpOther(400),
            TransportErrorKind::StreamInterrupt,
        ];
        let codes: Vec<&str> = kinds.iter().map(|k| k.error_code()).collect();
        let unique: std::collections::HashSet<&str> = codes.iter().copied().collect();
        assert_eq!(
            unique.len(),
            kinds.len(),
            "all error codes must be distinct"
        );
    }

    // ── is_transient / is_terminal ───────────────────────────────────────────

    #[test]
    fn transient_http_errors_match_existing_retry_set() {
        // The existing code retries: 408 | 429 | 500 | 502 | 503 | 504
        for code in [408, 429, 500, 502, 503, 504] {
            let kind = TransportErrorKind::from_http_status(code);
            assert!(
                kind.is_transient(),
                "HTTP {code} should be transient (retryable)"
            );
            assert!(!kind.is_terminal(), "HTTP {code} should not be terminal");
        }
    }

    #[test]
    fn terminal_http_errors_are_not_retried() {
        for code in [400, 401, 403, 404, 422, 501] {
            let kind = TransportErrorKind::from_http_status(code);
            assert!(
                kind.is_terminal(),
                "HTTP {code} should be terminal (not retryable)"
            );
        }
    }

    #[test]
    fn transport_timeout_is_transient() {
        let kind = TransportErrorKind::from_transport(true, false, false);
        assert!(kind.is_transient());
        assert!(!kind.is_terminal());
    }

    #[test]
    fn transport_connect_is_transient() {
        let kind = TransportErrorKind::from_transport(false, true, false);
        assert!(kind.is_transient());
    }

    #[test]
    fn headers_timeout_is_transient() {
        let kind = TransportErrorKind::from_transport(false, false, true);
        assert!(kind.is_transient());
    }

    #[test]
    fn stream_interrupt_is_terminal() {
        let kind = TransportErrorKind::from_stream_error("decode error");
        assert!(kind.is_terminal());
        assert!(!kind.is_transient());
    }

    #[test]
    fn stream_first_token_timeout_is_transient() {
        let kind = TransportErrorKind::from_stream_error("first token timeout");
        assert!(kind.is_transient());
    }

    #[test]
    fn http_501_is_terminal_but_classified_as_server() {
        // 501 is a 5xx but NOT in the existing transient set (408|429|500|502|503|504),
        // so it must be terminal — the existing code does not retry it.
        let kind = TransportErrorKind::from_http_status(501);
        assert_eq!(kind, TransportErrorKind::HttpServer(501));
        assert!(
            kind.is_terminal(),
            "501 should be terminal (not in retry set)"
        );
    }

    #[test]
    fn http_505_is_terminal() {
        let kind = TransportErrorKind::from_http_status(505);
        assert_eq!(kind, TransportErrorKind::HttpServer(505));
        assert!(kind.is_terminal());
    }

    // ── round-trip: from_http_status → user_message ──────────────────────────

    #[test]
    fn each_http_status_has_a_user_message() {
        for code in 400..=599 {
            let kind = TransportErrorKind::from_http_status(code);
            let msg = kind.user_message();
            assert!(
                !msg.is_empty(),
                "HTTP {code} must have a non-empty user message"
            );
        }
    }
}
