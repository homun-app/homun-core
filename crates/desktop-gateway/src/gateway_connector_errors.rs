//! Shared connector diagnostics for Composio and MCP execution paths.

use super::*;

/// Actionable category of a connector tool failure, classified from provider
/// text because connectors do not expose a stable cross-provider machine code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConnectorErrorKind {
    /// 401, expired token, or no connected account: reconnect.
    Auth,
    /// 429 or quota exceeded: wait and retry later.
    RateLimit,
    /// 403 or missing scope: reconnect granting more permissions.
    Forbidden,
    /// Transport down, unreachable, or closed: the service/server is offline.
    Unavailable,
}

pub(crate) fn classify_connector_error(error: &str) -> Option<ConnectorErrorKind> {
    let e = error.to_lowercase();
    if e.contains("401")
        || e.contains("unauthorized")
        || e.contains("expired")
        || e.contains("invalid_grant")
        || e.contains("not connected")
        || e.contains("no connected account")
    {
        Some(ConnectorErrorKind::Auth)
    } else if e.contains("429") || e.contains("rate limit") || e.contains("too many requests") {
        Some(ConnectorErrorKind::RateLimit)
    } else if e.contains("403")
        || e.contains("forbidden")
        || e.contains("permission")
        || e.contains("scope")
    {
        Some(ConnectorErrorKind::Forbidden)
    } else if e.contains("connection refused")
        || e.contains("econnrefused")
        || e.contains("unreachable")
        || e.contains("connection closed")
        || e.contains("broken pipe")
        || e.contains("transport")
        || e.contains("server disconnected")
    {
        Some(ConnectorErrorKind::Unavailable)
    } else {
        None
    }
}

/// Composio-flavored actionable hint. Auth failures still emit the reconnect
/// marker because the chat surface owns rendering the in-chat reconnect card.
pub(crate) fn connector_error_hint(error: &str) -> Option<&'static str> {
    match classify_connector_error(error)? {
        ConnectorErrorKind::Auth => Some(
            "The connection has EXPIRED or is not authorized: tell the user to RECONNECT the service \
and emit on its own line the marker ‹‹COMPOSIO_RECONNECT››<slug>‹‹/COMPOSIO_RECONNECT›› with the toolkit \
slug. Do NOT retry the call.",
        ),
        ConnectorErrorKind::RateLimit => Some(
            "Rate limit reached: tell the user and suggest trying again in \
a few minutes. Do NOT retry immediately.",
        ),
        ConnectorErrorKind::Forbidden => Some(
            "Permission denied (insufficient scope): the connected account lacks the required permissions; \
suggest reconnecting the service granting the necessary scopes.",
        ),
        ConnectorErrorKind::Unavailable => Some(
            "The service is currently unreachable: tell the user and suggest trying again \
later. Do NOT retry immediately in a loop.",
        ),
    }
}

/// Stable string for the audit log and UI badge.
pub(crate) fn connector_error_kind_str(k: ConnectorErrorKind) -> &'static str {
    match k {
        ConnectorErrorKind::Auth => "auth",
        ConnectorErrorKind::RateLimit => "rate_limit",
        ConnectorErrorKind::Forbidden => "forbidden",
        ConnectorErrorKind::Unavailable => "unavailable",
    }
}

/// Append a connector tool execution to the audit log. Logging is best-effort
/// because a failed audit insert must never break the original tool call.
pub(crate) fn record_connector_run(
    state: &AppState,
    thread_id: Option<&str>,
    tool: &str,
    kind: &str,
    ok: bool,
    error_kind: Option<&str>,
    dur: std::time::Duration,
) {
    if let Ok(store) = lock_store(state) {
        let _ = store.record_tool_run(&chat_store::ToolRunInput {
            thread_id,
            tool,
            kind,
            ok,
            error_kind,
            duration_ms: Some(dur.as_millis() as i64),
            summary: None,
        });
    }
}

/// MCP-flavored actionable hint. MCP servers do not have an OAuth toolkit slug,
/// so reconnect points to connector settings instead of emitting a Composio card.
pub(crate) fn mcp_error_hint(error: &str) -> Option<&'static str> {
    match classify_connector_error(error)? {
        ConnectorErrorKind::Auth | ConnectorErrorKind::Forbidden => Some(
            "The MCP server rejected the credentials (expired or without permissions): tell the user to \
RECONNECT the server from Settings -> Connectors -> MCP (updating token/permissions). Do NOT retry.",
        ),
        ConnectorErrorKind::RateLimit => Some(
            "MCP server rate limit: tell the user and suggest trying again in a few \
minutes. Do NOT retry immediately.",
        ),
        ConnectorErrorKind::Unavailable => Some(
            "The MCP server is unreachable (off or disconnected): tell the user to check it / \
reconnect it from Settings -> Connectors -> MCP. Do NOT retry in a loop.",
        ),
    }
}

pub(crate) fn composio_execution_error(output: &serde_json::Value) -> Option<String> {
    if output.get("successful").and_then(|v| v.as_bool()) == Some(false) {
        let message = output
            .get("error")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .or_else(|| {
                output
                    .get("error")
                    .filter(|v| !v.is_null())
                    .map(|v| v.to_string())
            })
            .unwrap_or_else(|| "the service rejected the action".to_string());
        return Some(message.chars().take(400).collect());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connector_errors_owner_classifies_and_summarizes_failures() {
        assert_eq!(
            classify_connector_error("401 expired token"),
            Some(ConnectorErrorKind::Auth)
        );
        assert_eq!(
            classify_connector_error("429 Too Many Requests"),
            Some(ConnectorErrorKind::RateLimit)
        );
        assert_eq!(
            classify_connector_error("403 missing scope"),
            Some(ConnectorErrorKind::Forbidden)
        );
        assert_eq!(
            classify_connector_error("connection refused"),
            Some(ConnectorErrorKind::Unavailable)
        );
        assert!(
            connector_error_hint("expired")
                .unwrap()
                .contains("RECONNECT")
        );
        assert!(
            mcp_error_hint("connection refused")
                .unwrap()
                .contains("unreachable")
        );
        assert_eq!(
            connector_error_kind_str(ConnectorErrorKind::RateLimit),
            "rate_limit"
        );
        assert_eq!(
            composio_execution_error(&serde_json::json!({
                "successful": false,
                "error": "bad token"
            }))
            .as_deref(),
            Some("bad token")
        );
        assert!(composio_execution_error(&serde_json::json!({"successful": true})).is_none());
    }
}
