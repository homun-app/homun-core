//! Chat tool perimeter owner.
//!
//! Applies a contact's tool allow/deny perimeter to the turn-local manager
//! toolset. The toolset assembly remains in `gateway_chat_toolset`; this owner
//! only narrows the already assembled schemas for a channel/contact turn.

use super::*;

pub(crate) struct ChatToolPerimeterInput<'a> {
    pub(crate) contact: Option<&'a ContactTurnContext>,
    pub(crate) tool_schemas: &'a mut Vec<serde_json::Value>,
}

pub(crate) fn apply_chat_tool_perimeter(input: ChatToolPerimeterInput<'_>) {
    let Some(cx) = input.contact else {
        return;
    };
    let denied = &cx.perimeter.tools_denied;
    let allowed = &cx.perimeter.tools_allowed;
    if denied.is_empty() && allowed.is_empty() {
        return;
    }

    let mut dropped: Vec<String> = Vec::new();
    input.tool_schemas.retain(|schema| {
        let name = schema
            .pointer("/function/name")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if denied.iter().any(|deny| name.contains(deny.as_str())) {
            dropped.push(name.to_string());
            return false;
        }
        // Allowlist scopes capabilities, not the loop's own machinery.
        // Harness tools stay unless explicitly denied above.
        if !allowed.is_empty()
            && !HARNESS_CONTROL_TOOLS.contains(&name)
            && !allowed.iter().any(|allow| name.contains(allow.as_str()))
        {
            dropped.push(name.to_string());
            return false;
        }
        true
    });
    if !dropped.is_empty() {
        tracing::warn!(
            target: "perimeter::tools",
            dropped = %dropped.join(","),
            "contact perimeter withheld tools from this turn"
        );
    }
}
