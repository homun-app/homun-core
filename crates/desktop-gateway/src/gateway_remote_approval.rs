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

pub(crate) async fn activate_remote_approvals_from_message(
    state: &AppState,
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
    projection_claim: Option<&local_first_task_runtime::ProjectionClaim>,
    thread_id: &str,
    message: &ChatMessage,
) -> Result<Option<local_first_execution_protocol::EffectReceiptRef>, String> {
    for intent in remote_approval_intents_from_message(message) {
        let Some(approval_id) = intent.approval_id.as_deref() else {
            continue;
        };
        let row = lock_store(state).ok().and_then(|store| {
            let pending = store.remote_approval_by_id(approval_id).ok().flatten()?;
            let expected_protocol = if pending.tool.starts_with("mcp__") {
                "mcp"
            } else {
                "composio"
            };
            if pending.tool != intent.tool
                || pending.arguments != intent.arguments
                || expected_protocol != intent.protocol
            {
                return None;
            }
            store
                .bind_remote_approval_source(approval_id, thread_id, &message.id)
                .ok()
                .flatten()
        });
        let Some(row) = row else {
            continue;
        };
        if lock_store(state)
            .map_err(|error| error.message)?
            .expire_remote_approval_if_due(
                &row.approval_id,
                OffsetDateTime::now_utc().unix_timestamp(),
            )
            .map_err(|error| format!("remote approval expiry failed: {error}"))?
        {
            continue;
        }
        if row.status != "pending"
            || !row.requires_source
            || row.dispatched_at.is_some()
            || row.source_message_id.as_deref() != Some(message.id.as_str())
        {
            continue;
        }
        let projection_claim = projection_claim
            .ok_or_else(|| "remote approval dispatch requires a projection claim".to_string())?;
        match dispatch_remote_approval(state, contract, projection_claim, &row).await? {
            ChannelProjectionDelivery::NotApplicable => {}
            ChannelProjectionDelivery::Pending(receipt_ref) => return Ok(Some(receipt_ref)),
            ChannelProjectionDelivery::Delivered(_) => {
                lock_store(state)
                    .map_err(|error| error.message)?
                    .mark_remote_approval_dispatched(&row.approval_id)
                    .map_err(|error| format!("remote approval dispatch marker failed: {error}"))?;
            }
        }
    }
    Ok(None)
}

fn approval_expires_at_secs() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp() + 600
}

/// Register a durable remote approval. For chat-originated cards
/// `requires_source=true`: the row is not executable until the persisted
/// assistant message binds to the same approval_id marker.
pub(crate) fn create_pending_approval(
    state: &AppState,
    tool: &str,
    args: &serde_json::Value,
    label: &str,
    thread_id: Option<&str>,
    requires_source: bool,
) -> Option<RemoteApprovalRow> {
    let prefs = load_user_prefs();
    let channel = prefs.approval_channel.as_deref().unwrap_or("in_app");
    let target = prefs.approval_target.unwrap_or_default();
    if target.trim().is_empty() || channel == "in_app" {
        return None;
    }
    if requires_source && thread_id.is_none() {
        return None;
    }
    for _ in 0..8 {
        let raw = uuid::Uuid::new_v4().simple().to_string();
        let approval_id = format!("approval_{raw}");
        let code = raw[..6].to_uppercase();
        let expires_at = approval_expires_at_secs();
        let objective_revision = thread_id
            .and_then(|thread_id| objective_contract_for_execution(state, Some(thread_id)))
            .map(|objective| objective.revision);
        let input = RemoteApprovalInput {
            approval_id: &approval_id,
            code: &code,
            tool,
            arguments: args,
            label,
            thread_id,
            objective_revision,
            requires_source,
            expires_at,
        };
        match lock_store(state).and_then(|store| {
            store
                .create_remote_approval(&input)
                .map_err(GatewayError::store)
        }) {
            Ok(()) => {
                return Some(RemoteApprovalRow {
                    approval_id,
                    code,
                    tool: tool.to_string(),
                    arguments: args.clone(),
                    label: label.to_string(),
                    thread_id: thread_id.map(ToString::to_string),
                    objective_revision,
                    source_message_id: None,
                    requires_source,
                    status: "pending".to_string(),
                    expires_at,
                    dispatched_at: None,
                });
            }
            Err(error) => {
                if std::env::var("HOMUN_DEBUG").is_ok() {
                    eprintln!("remote approval create failed: {}", error.message);
                }
            }
        }
    }
    None
}

/// Non-consuming check: is there a live pending approval with this code? Lets
/// channel handlers treat `OK/NO <word>` as control replies only for real codes.
pub(crate) fn pending_approval_exists(state: &AppState, code: &str) -> bool {
    lock_store(state)
        .ok()
        .and_then(|store| store.pending_remote_approval(code).ok().flatten())
        .is_some()
}

pub(crate) fn approval_progress_reply(code: &str) -> String {
    format!("⏳ Ricevuto ({code}). Verifico la card salvata e avvio l'azione…")
}

/// Parse a remote-approval control reply: `OK 7F3` / `SI 7F3` (approve) or `NO 7F3` (cancel).
/// Returns `(approve, code)`. Tolerant of leading emoji/spacing; case-insensitive.
pub(crate) fn parse_approval_reply(text: &str) -> Option<(bool, String)> {
    let t = text.trim();
    let mut it = t.split_whitespace();
    let verb = it.next()?.to_ascii_uppercase();
    let code = it.next()?.trim().to_ascii_uppercase();
    if code.is_empty() {
        return None;
    }
    match verb.as_str() {
        "OK" | "SI" | "SÌ" | "YES" | "APPROVA" => Some((true, code)),
        "NO" | "ANNULLA" | "CANCEL" => Some((false, code)),
        _ => None,
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

    #[test]
    fn gateway_remote_approval_parses_control_replies() {
        assert_eq!(
            parse_approval_reply(" ok ab12 "),
            Some((true, "AB12".to_string()))
        );
        assert_eq!(
            parse_approval_reply("NO 7f3"),
            Some((false, "7F3".to_string()))
        );
        assert_eq!(parse_approval_reply("maybe 7f3"), None);
        assert_eq!(parse_approval_reply("OK"), None);
    }
}
