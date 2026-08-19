pub(crate) const MCP_CONFIRM_OPEN: &str = "‹‹MCP_CONFIRM››";
pub(crate) const MCP_CONFIRM_CLOSE: &str = "‹‹/MCP_CONFIRM››";
pub(crate) const COMPOSIO_CONFIRM_OPEN: &str = "‹‹COMPOSIO_CONFIRM››";
pub(crate) const COMPOSIO_CONFIRM_CLOSE: &str = "‹‹/COMPOSIO_CONFIRM››";

pub(crate) fn confirm_marker_value(
    text: &str,
    open_tag: &str,
    close_tag: &str,
) -> Option<serde_json::Value> {
    let open = text.find(open_tag)?;
    let start = open + open_tag.len();
    let close_rel = text[start..].find(close_tag)?;
    serde_json::from_str::<serde_json::Value>(&text[start..start + close_rel]).ok()
}

pub(crate) fn confirm_marker_matches_approval(
    text: &str,
    open_tag: &str,
    close_tag: &str,
    approval_id: &str,
    tool: &str,
    arguments: &serde_json::Value,
) -> bool {
    let Some(marker) = confirm_marker_value(text, open_tag, close_tag) else {
        return false;
    };
    marker
        .get("approval_id")
        .and_then(serde_json::Value::as_str)
        == Some(approval_id)
        && marker.get("tool").and_then(serde_json::Value::as_str) == Some(tool)
        && marker.get("arguments") == Some(arguments)
}

pub(crate) fn mcp_confirm_matches(text: &str, tool: &str, arguments: &serde_json::Value) -> bool {
    let Some(marker) = confirm_marker_value(text, MCP_CONFIRM_OPEN, MCP_CONFIRM_CLOSE) else {
        return false;
    };
    marker.get("tool").and_then(serde_json::Value::as_str) == Some(tool)
        && marker.get("arguments") == Some(arguments)
}

pub(crate) fn composio_confirm_matches(
    text: &str,
    tool: &str,
    arguments: &serde_json::Value,
) -> bool {
    let Some(marker) = confirm_marker_value(text, COMPOSIO_CONFIRM_OPEN, COMPOSIO_CONFIRM_CLOSE)
    else {
        return false;
    };
    marker.get("tool").and_then(serde_json::Value::as_str) == Some(tool)
        && marker.get("arguments") == Some(arguments)
}

/// Remote approvals additionally carry a random, durable ID. Tool + arguments
/// are not enough provenance: another equal-looking card (or an unpersisted
/// streamed response) must never authorize this specific request.
pub(crate) fn mcp_confirm_matches_approval(
    text: &str,
    approval_id: &str,
    tool: &str,
    arguments: &serde_json::Value,
) -> bool {
    confirm_marker_matches_approval(
        text,
        MCP_CONFIRM_OPEN,
        MCP_CONFIRM_CLOSE,
        approval_id,
        tool,
        arguments,
    )
}

/// Replaces the pending-confirmation card with a plain executed note so
/// reopening the chat cannot re-trigger the action.
pub(crate) fn rewrite_mcp_confirm_to_done(text: &str, tool: &str) -> String {
    let Some(open) = text.find(MCP_CONFIRM_OPEN) else {
        return text.to_string();
    };
    let Some(close_rel) = text[open..].find(MCP_CONFIRM_CLOSE) else {
        return text.to_string();
    };
    let close = open + close_rel + MCP_CONFIRM_CLOSE.len();
    let head_end = text[..open]
        .rfind("I need your confirmation")
        .unwrap_or(open);
    let mut out = text[..head_end].trim_end().to_string();
    let tail = text[close..].trim();
    if !tail.is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(tail);
    }
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&format!("✓ MCP tool executed: {tool}"));
    out
}

/// Rewrites a message that carries a Composio pending-confirmation marker into
/// a done marker. Idempotent if no confirm marker is present.
pub(crate) fn rewrite_confirm_to_done(text: &str, tool: &str) -> String {
    let Some(open) = text.find(COMPOSIO_CONFIRM_OPEN) else {
        return text.to_string();
    };
    let Some(close_rel) = text[open..].find(COMPOSIO_CONFIRM_CLOSE) else {
        return text.to_string();
    };
    let close = open + close_rel + COMPOSIO_CONFIRM_CLOSE.len();
    let head_end = text[..open]
        .rfind("I need your confirmation")
        .unwrap_or(open);
    let mut out = text[..head_end].trim_end().to_string();
    let tail = text[close..].trim();
    if !tail.is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(tail);
    }
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&format!("‹‹COMPOSIO_DONE››{tool}‹‹/COMPOSIO_DONE››"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirm_marker_value_extracts_valid_json_between_tags() {
        let text = "before ‹‹X››{\"tool\":\"demo\",\"arguments\":{}}‹‹/X›› after";

        let parsed = confirm_marker_value(text, "‹‹X››", "‹‹/X››").expect("marker");

        assert_eq!(parsed["tool"], "demo");
        assert_eq!(parsed["arguments"], serde_json::json!({}));
    }

    #[test]
    fn mcp_confirm_match_requires_exact_tool_and_arguments() {
        let text = "I need your confirmation\n‹‹MCP_CONFIRM››{\"tool\":\"mcp__filesystem__create\",\"arguments\":{\"path\":\"/tmp/a\",\"content\":\"x\"}}‹‹/MCP_CONFIRM››";
        let args = serde_json::json!({ "path": "/tmp/a", "content": "x" });

        assert!(mcp_confirm_matches(text, "mcp__filesystem__create", &args));
        assert!(!mcp_confirm_matches(
            text,
            "mcp__filesystem__create",
            &serde_json::json!({ "path": "/tmp/b", "content": "x" })
        ));
        assert!(!mcp_confirm_matches(text, "mcp__filesystem__insert", &args));
    }

    #[test]
    fn composio_confirm_match_requires_exact_tool_and_arguments() {
        let text = "I need your confirmation\n‹‹COMPOSIO_CONFIRM››{\"tool\":\"GMAIL_SEND_EMAIL\",\"arguments\":{\"to\":\"a@example.test\"}}‹‹/COMPOSIO_CONFIRM››";
        let args = serde_json::json!({ "to": "a@example.test" });

        assert!(composio_confirm_matches(text, "GMAIL_SEND_EMAIL", &args));
        assert!(!composio_confirm_matches(
            text,
            "GMAIL_SEND_EMAIL",
            &serde_json::json!({ "to": "b@example.test" })
        ));
        assert!(!composio_confirm_matches(text, "GMAIL_CREATE_DRAFT", &args));
    }

    #[test]
    fn mcp_remote_approval_requires_exact_persisted_card_id() {
        let text = "I need your confirmation\n‹‹MCP_CONFIRM››{\"approval_id\":\"approval-a\",\"tool\":\"mcp__filesystem__create\",\"arguments\":{\"path\":\"/tmp/a\",\"content\":\"x\"}}‹‹/MCP_CONFIRM››";
        let args = serde_json::json!({ "path": "/tmp/a", "content": "x" });

        assert!(mcp_confirm_matches_approval(
            text,
            "approval-a",
            "mcp__filesystem__create",
            &args
        ));
        assert!(!mcp_confirm_matches_approval(
            text,
            "approval-b",
            "mcp__filesystem__create",
            &args
        ));
        assert!(!mcp_confirm_matches_approval(
            "‹‹MCP_CONFIRM››{\"tool\":\"mcp__filesystem__create\",\"arguments\":{\"path\":\"/tmp/a\",\"content\":\"x\"}}‹‹/MCP_CONFIRM››",
            "approval-a",
            "mcp__filesystem__create",
            &args
        ));
    }

    #[test]
    fn rewrite_mcp_confirm_to_done_removes_marker_and_preserves_tail() {
        let text = "I need your confirmation\n‹‹MCP_CONFIRM››{\"tool\":\"mcp__filesystem__create\",\"arguments\":{}}‹‹/MCP_CONFIRM››\n\nThen continue.";

        let rewritten = rewrite_mcp_confirm_to_done(text, "mcp__filesystem__create");

        assert!(!rewritten.contains("MCP_CONFIRM"));
        assert!(rewritten.contains("✓ MCP tool executed: mcp__filesystem__create"));
        assert!(rewritten.contains("Then continue."));
    }

    #[test]
    fn rewrite_composio_confirm_to_done_removes_marker_and_preserves_tail() {
        let text = "I need your confirmation\n‹‹COMPOSIO_CONFIRM››{\"tool\":\"GMAIL_SEND_EMAIL\",\"arguments\":{}}‹‹/COMPOSIO_CONFIRM››\n\nThen continue.";

        let rewritten = rewrite_confirm_to_done(text, "GMAIL_SEND_EMAIL");

        assert!(!rewritten.contains("COMPOSIO_CONFIRM"));
        assert!(rewritten.contains("‹‹COMPOSIO_DONE››GMAIL_SEND_EMAIL‹‹/COMPOSIO_DONE››"));
        assert!(rewritten.contains("Then continue."));
    }
}
