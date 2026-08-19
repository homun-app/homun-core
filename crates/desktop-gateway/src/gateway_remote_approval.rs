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

fn remote_approval_effect_request(
    approval: &RemoteApprovalRow,
    thread_id: &str,
) -> crate::effect_host::EffectRequest {
    crate::effect_host::EffectRequest::adapter_output(
        "channel.remote_approval",
        approval.approval_id.clone(),
        local_first_execution_protocol::EffectClass::ExternalWrite,
        serde_json::json!({
            "thread_id": thread_id,
            "approval_id": approval.approval_id,
            "label": approval.label,
        }),
    )
}

pub(crate) async fn dispatch_remote_approval(
    state: &AppState,
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
    projection_claim: &local_first_task_runtime::ProjectionClaim,
    approval: &RemoteApprovalRow,
) -> Result<ChannelProjectionDelivery, String> {
    let prefs = load_user_prefs();
    let channel = prefs
        .approval_channel
        .as_deref()
        .unwrap_or("in_app")
        .to_string();
    let target = prefs.approval_target.unwrap_or_default();
    if target.trim().is_empty() || channel == "in_app" {
        return Ok(ChannelProjectionDelivery::NotApplicable);
    }
    let thread_id = approval
        .thread_id
        .as_deref()
        .ok_or_else(|| "remote approval dispatch has no thread".to_string())?;
    if contract.as_ref().scope.thread_id.as_deref() != Some(thread_id) {
        return Err("remote approval thread does not match execution scope".to_string());
    }
    if !matches!(channel.as_str(), "telegram" | "whatsapp") {
        return Ok(ChannelProjectionDelivery::NotApplicable);
    }
    let effect_host = crate::effect_host::EffectHost::for_projection(
        state.task_store.as_ref(),
        contract,
        projection_claim,
    );
    let lease = match effect_host.begin(remote_approval_effect_request(approval, thread_id))? {
        crate::effect_host::EffectDecision::Replay(receipt) => {
            return Ok(ChannelProjectionDelivery::Delivered(serde_json::json!({
                "receipt_ref": receipt.receipt_ref.as_ref(),
                "channel": channel,
                "status": "completed",
            })));
        }
        crate::effect_host::EffectDecision::Resolve(receipt) => {
            return Ok(ChannelProjectionDelivery::Pending(receipt.receipt_ref));
        }
        crate::effect_host::EffectDecision::Execute(lease) => lease,
    };
    let code = approval.code.as_str();
    let send_result = match channel.as_str() {
        "telegram" => {
            let text = format!(
                "🔐 Homun is asking for your confirmation:\n{}\n\n(or reply: OK {code} / NO {code} — expires in 10 min)",
                approval.label
            );
            let buttons = vec![
                ["✅ Authorize".to_string(), format!("approve:{code}")],
                ["❌ Cancel".to_string(), format!("cancel:{code}")],
            ];
            telegram_send_buttons_with_rebind(state, target.trim(), &text, buttons).await
        }
        "whatsapp" => {
            let text = format!(
                "🔐 Homun is asking for your confirmation:\n{}\n\nAuthorize: OK {code}\nCancel: NO {code}\n(expires in 10 minutes)",
                approval.label
            );
            channel_send_classified(state, WHATSAPP_HTTP_PORT, target.trim(), &text).await
        }
        _ => unreachable!("approval channel was validated before receipt preparation"),
    };
    if let Err(error) = send_result {
        let detail = redact_sensitive_text(&error.message);
        if error.kind == ChannelSendFailureKind::UnknownRemoteOutcome {
            let receipt = effect_host.mark_uncertain_with_evidence(
                &lease,
                &serde_json::json!({
                    "channel": channel,
                    "recipient_fingerprint": recipient_fingerprint(target.trim()),
                    "approval_id": approval.approval_id,
                    "attempted": true,
                }),
            )?;
            return Ok(ChannelProjectionDelivery::Pending(receipt.receipt_ref));
        }
        effect_host.release_not_applied(&lease, error.kind.as_str(), &detail)?;
        return Err(format!(
            "channel/{channel} approval was verified not applied: {detail}"
        ));
    }
    let receipt = effect_host.complete(
        &lease,
        &serde_json::json!({"delivered": true}),
        &serde_json::json!({
            "channel": channel,
            "recipient_fingerprint": recipient_fingerprint(target.trim()),
            "approval_id": approval.approval_id,
        }),
    )?;
    Ok(ChannelProjectionDelivery::Delivered(serde_json::json!({
        "receipt_ref": receipt.receipt_ref.as_ref(),
        "channel": channel,
        "status": "completed",
    })))
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

fn approval_action_target(args: &serde_json::Value) -> Option<String> {
    args.get("path")
        .and_then(serde_json::Value::as_str)
        .or_else(|| args.get("to").and_then(serde_json::Value::as_str))
        .map(|value| value.chars().take(180).collect())
}

pub(crate) fn remote_approval_thread_status(
    approval: &RemoteApprovalRow,
    phase: &str,
    detail: Option<&str>,
) -> String {
    let target = approval_action_target(&approval.arguments)
        .map(|target| format!(" su `{target}`"))
        .unwrap_or_default();
    let detail = detail
        .filter(|text| !text.trim().is_empty())
        .map(|text| format!("\n\n{text}"))
        .unwrap_or_default();
    match phase {
        "running" => format!(
            "⏳ Approvazione Telegram ricevuta. Eseguo `{}`{}…{}",
            approval.tool, target, detail
        ),
        "executed" => format!(
            "✅ Azione approvata da Telegram eseguita: `{}`{}. Riprendo il task…{}",
            approval.tool, target, detail
        ),
        "failed" => format!(
            "⚠️ Azione approvata da Telegram fallita: `{}`{}.{}",
            approval.tool, target, detail
        ),
        _ => format!(
            "ℹ️ Stato approvazione Telegram: `{phase}` per `{}`{}.{detail}",
            approval.tool, target
        ),
    }
}

pub(crate) fn append_remote_approval_thread_status(
    state: &AppState,
    approval: &RemoteApprovalRow,
    phase: &str,
    detail: Option<&str>,
) {
    let Some(thread_id) = approval.thread_id.as_deref() else {
        return;
    };
    let text = remote_approval_thread_status(approval, phase, detail);
    if let Ok(store) = lock_store(state) {
        let _ =
            store.append_assistant_message(thread_id, &channel_chat_message("assistant", &text));
    }
    publish_app_event(serde_json::json!({
        "type": "thread.updated",
        "thread_id": thread_id,
        "workspace": base_workspace_id(),
    }));
}

pub(crate) fn approval_resume_prompt(
    tool: &str,
    result: &str,
    approved_args: Option<&serde_json::Value>,
    source_user_text: Option<&str>,
) -> String {
    let source = source_user_text
        .map(|text| text.chars().take(1200).collect::<String>())
        .unwrap_or_else(|| "(source user request unavailable)".to_string());
    let args = approved_args
        .map(|value| value.to_string().chars().take(1600).collect::<String>())
        .unwrap_or_else(|| "{}".to_string());
    let result_snip: String = result.chars().take(1200).collect();
    format!(
        "A user-approved action has just executed in the CURRENT chat task.\n\n\
         ORIGINAL USER REQUEST:\n{source}\n\n\
         APPROVED TOOL ACTION:\n{tool}\n\n\
         APPROVED ARGUMENTS JSON:\n{args}\n\n\
         EXECUTION RESULT:\n{result_snip}\n\n\
         Continue ONLY this original request. Do not switch to any other file, path, \
         task, memory, or open loop. Do not mention or act on paths that are not in \
         the original request or approved arguments. If the approved action satisfies \
         the request, answer with a concise completion message using the exact \
         approved path/content/result. Continue with another tool only if the original \
         request clearly has unfinished steps."
    )
}

fn approval_source_user_text(
    state: &AppState,
    thread_id: &str,
    source_message_id: Option<&str>,
) -> Option<String> {
    let source_message_id = source_message_id?;
    let snapshot = lock_store(state).ok()?.messages(thread_id).ok()?;
    let source_idx = snapshot
        .messages
        .iter()
        .position(|message| message.id == source_message_id)?;
    snapshot.messages[..source_idx]
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .map(|message| message.text.clone())
}

pub(crate) fn approval_continuation_visible_text(tool: &str) -> String {
    let tool: String = tool.trim().chars().take(80).collect();
    if tool.is_empty() {
        "Continue after the approved action.".to_string()
    } else {
        format!("Continue after approved action `{tool}`.")
    }
}

pub(crate) fn approval_continuation_turn_input(
    thread_id: &str,
    tool: &str,
    prompt: String,
) -> local_first_task_runtime::broker::ChatTurnInput {
    let request_id = format!(
        "approval_{}_{}",
        now_epoch_secs(),
        uuid::Uuid::new_v4().simple()
    );
    local_first_task_runtime::broker::ChatTurnInput {
        thread_id: thread_id.to_string(),
        assistant_message_id: format!("local_assistant_{request_id}"),
        request_id,
        prompt,
        visible_prompt: Some(approval_continuation_visible_text(tool)),
        images: Vec::new(),
        attachments: None,
        mode: None,
        model: None,
        source: local_first_task_runtime::broker::ChatTurnSource::Interactive,
        approval: local_first_task_runtime::broker::TurnApproval::Full,
    }
}

pub(crate) fn resume_thread_after_approval(
    state: &AppState,
    thread_id: Option<String>,
    tool: &str,
    result: &str,
    approved_args: Option<serde_json::Value>,
    source_message_id: Option<String>,
) {
    let Some(thread_id) = thread_id else {
        return;
    };
    let st = state.clone();
    let tool = tool.to_string();
    let result = result.to_string();
    tokio::spawn(async move {
        let source_user_text =
            approval_source_user_text(&st, &thread_id, source_message_id.as_deref());
        let prompt = approval_resume_prompt(
            &tool,
            &result,
            approved_args.as_ref(),
            source_user_text.as_deref(),
        );
        match resume_suspended_approval_turn_core(
            &st,
            &thread_id,
            true,
            &tool,
            &result,
            approved_args.as_ref(),
            &prompt,
        ) {
            Ok(Some(resumed)) => {
                publish_app_event(serde_json::json!({
                    "type": "thread.turn_resumed",
                    "thread_id": thread_id,
                    "turn_id": resumed.execution_id,
                    "revision": resumed.revision,
                }));
                return;
            }
            Ok(None) => {}
            Err(error) => {
                tracing::error!(
                    target: "approval::continuation",
                    %thread_id,
                    %tool,
                    %error,
                    "could not deliver the approved-action wake"
                );
                return;
            }
        }
        let input = approval_continuation_turn_input(&thread_id, &tool, prompt);
        if let Err(error) = enqueue_chat_turn_core(&st, &input) {
            tracing::error!(
                target: "approval::continuation",
                %thread_id,
                %tool,
                %error,
                "could not enqueue the approved-action continuation"
            );
        }
    });
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
