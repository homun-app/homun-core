//! HTTP trace-ID propagation middleware (OBS-2).
//!
//! Layered on every request that enters the web router. Reads an inbound
//! `X-Request-ID` header if the client sent one (for correlation with
//! upstream systems like a reverse proxy or mobile client), otherwise
//! generates a fresh short trace ID via [`crate::logs::new_trace_id`].
//!
//! The resolved trace ID is:
//!   1. Set in the [`crate::logs::TASK_TRACE_ID`] task-local for the
//!      entire duration of `next.run(req).await`, so every log record
//!      emitted during request handling (including downstream agent loop,
//!      tool calls, LLM provider calls) is tagged with it.
//!   2. Echoed back to the client as `X-Request-ID` on the response, so
//!      clients can surface it in error UIs or paste it into bug reports.
//!
//! This pairs with Step 2's non-HTTP channel instrumentation (CLI, Telegram,
//! Discord, Slack, WhatsApp, Email): those channels each generate their own
//! trace ID and enter the same task-local scope before dispatching to the
//! agent gateway.

use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;

/// Canonical header name used by most web frameworks and proxies for request
/// correlation IDs. We accept this inbound and always emit it outbound.
const HEADER_NAME: &str = "x-request-id";

/// Maximum inbound header length accepted. Anything longer is treated as
/// malformed and we generate a fresh ID instead — prevents log pollution
/// from attacker-controlled oversized identifiers.
const MAX_INBOUND_LEN: usize = 128;

/// Minimum inbound header length accepted. Defensive against empty/whitespace
/// values that some proxies forward unfiltered.
const MIN_INBOUND_LEN: usize = 4;

/// Middleware that propagates a trace ID through the request task-local and
/// echoes it on the response.
///
/// # Panics
/// Never. Header-value construction is guarded by ASCII validation of the
/// generated/forwarded ID; invalid inbound headers fall through to a fresh
/// generated ID.
pub async fn trace_id_middleware(req: Request, next: Next) -> Response {
    let inbound = req
        .headers()
        .get(HEADER_NAME)
        .and_then(|v| v.to_str().ok())
        .filter(|s| is_well_formed(s))
        .map(|s| s.to_string());

    let trace_id = inbound.unwrap_or_else(crate::logs::new_trace_id);

    // Run the downstream handler inside the task-local scope so every
    // tracing event (including from spawned nested tasks that inherit the
    // context via structured concurrency) sees the same trace ID.
    let trace_id_for_scope = trace_id.clone();
    let mut response = crate::logs::TASK_TRACE_ID
        .scope(trace_id_for_scope, async move { next.run(req).await })
        .await;

    // Echo on response. We built trace_id ourselves from either a validated
    // inbound header or new_trace_id() (which returns 8 hex chars) — both
    // are valid HTTP header values, so HeaderValue::from_str cannot fail,
    // but we still match to avoid unwrap on the impossible case.
    if let Ok(value) = HeaderValue::from_str(&trace_id) {
        response
            .headers_mut()
            .insert(HeaderName::from_static(HEADER_NAME), value);
    }

    response
}

/// Conservative validation for inbound `X-Request-ID` header values.
///
/// Accepts only ASCII alphanumerics, `-` and `_`, bounded by length.
/// Rejects anything that could pollute log files, shell-escape, or render
/// as something misleading in the Homun dashboard. If rejected, we silently
/// generate a fresh ID — the client is not informed (prevents probing).
fn is_well_formed(s: &str) -> bool {
    let len = s.len();
    if !(MIN_INBOUND_LEN..=MAX_INBOUND_LEN).contains(&len) {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_formed_accepts_common_formats() {
        assert!(is_well_formed("abc12345")); // short Homun-native
        assert!(is_well_formed("550e8400-e29b-41d4-a716-446655440000")); // full UUID
        assert!(is_well_formed("req_01h9xyz1234567890abcdefghijk")); // ULID-like
        assert!(is_well_formed("trace-AB-CD-12")); // mixed
    }

    #[test]
    fn well_formed_rejects_hostile_values() {
        assert!(!is_well_formed("")); // empty
        assert!(!is_well_formed("ab")); // too short
        assert!(!is_well_formed(&"x".repeat(200))); // too long
        assert!(!is_well_formed("has space")); // whitespace
        assert!(!is_well_formed("has\nnewline")); // log injection attempt
        assert!(!is_well_formed("has\"quote")); // JSON escape attempt
        assert!(!is_well_formed("drop/table")); // SQL-ish
        assert!(!is_well_formed("../etc/passwd")); // path traversal
        assert!(!is_well_formed("🚀emoji")); // non-ASCII
    }

    #[test]
    fn well_formed_boundary_lengths() {
        // At MIN_INBOUND_LEN (4), accepted.
        assert!(is_well_formed("abcd"));
        // Below, rejected.
        assert!(!is_well_formed("abc"));
        // At MAX_INBOUND_LEN (128), accepted.
        assert!(is_well_formed(&"a".repeat(128)));
        // Above, rejected.
        assert!(!is_well_formed(&"a".repeat(129)));
    }
}
