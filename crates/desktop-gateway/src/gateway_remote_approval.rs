//! Remote approval marker parsing and actionable-card extraction.
//!
//! This module owns the conversion from model-visible marker text or persisted
//! event parts into the typed remote-approval/card structures consumed by chat
//! finalization and approval dispatch.

use crate::*;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RemoteApprovalIntent {
    pub(crate) protocol: &'static str,
    pub(crate) approval_id: Option<String>,
    pub(crate) tool: String,
    pub(crate) arguments: serde_json::Value,
}

fn remote_approval_intent_from_marker(
    text: &str,
    protocol: &'static str,
    open_tag: &str,
    close_tag: &str,
) -> Option<RemoteApprovalIntent> {
    let marker = confirm_marker_value(text, open_tag, close_tag)?;
    let approval_id = marker
        .get("approval_id")
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string);
    let tool = marker.get("tool")?.as_str()?.to_string();
    let arguments = marker
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let valid = if protocol == "mcp" {
        mcp_confirm_matches(text, &tool, &arguments)
    } else {
        composio_confirm_matches(text, &tool, &arguments)
    };
    valid.then_some(RemoteApprovalIntent {
        protocol,
        approval_id,
        tool,
        arguments,
    })
}

pub(crate) fn remote_approval_intent_from_raw_text(text: &str) -> Option<RemoteApprovalIntent> {
    remote_approval_intent_from_marker(text, "mcp", MCP_CONFIRM_OPEN, MCP_CONFIRM_CLOSE).or_else(
        || {
            remote_approval_intent_from_marker(
                text,
                "composio",
                COMPOSIO_CONFIRM_OPEN,
                COMPOSIO_CONFIRM_CLOSE,
            )
        },
    )
}

pub(crate) fn remote_approval_event_part(intent: &RemoteApprovalIntent) -> serde_json::Value {
    serde_json::json!({
        "type": "remote_approval",
        "protocol": intent.protocol,
        "approval_id": intent.approval_id,
        "tool": intent.tool,
        "arguments": intent.arguments,
    })
}

#[derive(Debug, Clone)]
pub(crate) struct ActionableCard {
    pub(crate) kind: &'static str,
    pub(crate) raw: String,
    pub(crate) payload: serde_json::Value,
}

pub(crate) fn actionable_cards_from_raw_text(text: &str) -> Vec<ActionableCard> {
    local_first_desktop_gateway::markers::validated_actionable_marker_blocks(text)
        .into_iter()
        .map(|block| ActionableCard {
            kind: block.marker,
            raw: block.raw,
            payload: block.payload,
        })
        .collect()
}

pub(crate) fn remote_approval_intents_from_message(
    message: &ChatMessage,
) -> Vec<RemoteApprovalIntent> {
    let structured: Vec<_> = message
        .event_parts
        .iter()
        .filter(|part| {
            part.get("type").and_then(serde_json::Value::as_str) == Some("remote_approval")
        })
        .filter_map(|part| {
            let protocol = match part.get("protocol").and_then(serde_json::Value::as_str) {
                Some("mcp") => "mcp",
                Some("composio") => "composio",
                _ => return None,
            };
            Some(RemoteApprovalIntent {
                protocol,
                approval_id: part
                    .get("approval_id")
                    .and_then(serde_json::Value::as_str)
                    .map(ToString::to_string),
                tool: part.get("tool")?.as_str()?.to_string(),
                arguments: part
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})),
            })
        })
        .collect();
    if structured.is_empty() {
        remote_approval_intent_from_raw_text(&message.text)
            .into_iter()
            .collect()
    } else {
        structured
    }
}

#[cfg(test)]
pub(crate) fn remote_approval_matches_persisted_message(
    message: &ChatMessage,
    approval_id: &str,
    tool: &str,
    arguments: &serde_json::Value,
) -> bool {
    remote_approval_intents_from_message(message)
        .iter()
        .any(|intent| {
            intent.approval_id.as_deref() == Some(approval_id)
                && intent.tool == tool
                && &intent.arguments == arguments
                && (if tool.starts_with("mcp__") {
                    intent.protocol == "mcp"
                } else {
                    intent.protocol == "composio"
                })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_remote_approval_prefers_structured_event_parts_over_text_markers() {
        let mut message = channel_chat_message_with_id(
            "assistant",
            "fallback ‹‹MCP_CONFIRM››{\"approval_id\":\"text-id\",\"tool\":\"mcp__filesystem__create\",\"arguments\":{\"path\":\"/tmp/text\"}}‹‹/MCP_CONFIRM››",
            "assistant-structured-approval",
        );
        message.event_parts.push(serde_json::json!({
            "type": "remote_approval",
            "protocol": "mcp",
            "approval_id": "event-id",
            "tool": "mcp__filesystem__create",
            "arguments": { "path": "/tmp/event" },
        }));

        let intents = remote_approval_intents_from_message(&message);

        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].approval_id.as_deref(), Some("event-id"));
        assert_eq!(
            intents[0].arguments,
            serde_json::json!({ "path": "/tmp/event" })
        );
    }
}
