//! Agent stream persistence and fanout helpers.
//!
//! Owns assistant message updates/finalization plus durable turn-event fanout
//! for raw agent stream lines. Stream draining, HITL wait snapshots, and browser
//! liveness remain separate owners.

use super::*;

pub(crate) fn update_channel_assistant_message(
    state: &AppState,
    thread_id: &str,
    message_id: &str,
    text: &str,
) {
    if let Ok(store) = lock_store(state) {
        let _ = store.set_message_text(thread_id, message_id, text);
    }
    publish_app_event(serde_json::json!({
        "type": "thread.updated",
        "thread_id": thread_id,
        "workspace": base_workspace_id(),
    }));
}

pub(crate) fn finalize_streamed_assistant_message(
    state: &AppState,
    turn_id: &str,
    thread_id: &str,
    message_id: &str,
    text: &str,
    collector: &StreamMemoryReuseCollector,
    requested_delivery_state: local_first_desktop_gateway::MessageDeliveryState,
) -> Result<(), String> {
    let mut event_parts = collector.event_parts().to_vec();
    merge_turn_payment_event_parts(state, turn_id, &mut event_parts);
    let store = lock_store(state).map_err(|error| error.message)?;
    store
        .finalize_assistant_message_with_delivery_state(
            thread_id,
            message_id,
            text,
            &event_parts,
            &collector.envelope(),
            requested_delivery_state,
        )
        .map_err(|error| error.to_string())?;
    publish_app_event(serde_json::json!({
        "type": "thread.updated",
        "thread_id": thread_id,
        "workspace": base_workspace_id(),
    }));
    Ok(())
}

fn merge_turn_payment_event_parts(
    state: &AppState,
    turn_id: &str,
    event_parts: &mut Vec<serde_json::Value>,
) {
    let Ok(store) = state.task_store.lock() else {
        return;
    };
    let Ok(events) = store.read_turn_events(turn_id, 0) else {
        return;
    };
    for event in events {
        if event.kind != local_first_task_runtime::TurnEventKind::PaymentApproval {
            continue;
        }
        if !local_first_desktop_gateway::valid_payment_approval_payload(&event.payload) {
            continue;
        }
        let part = serde_json::json!({
            "type": "payment_approval",
            "payload": event.payload,
        });
        if !event_parts.iter().any(|existing| existing == &part) {
            event_parts.push(part);
        }
    }
}

/// Stores an emitted Recall part with the assistant message. This is deliberately
/// idempotent because a stream snapshot and its broadcast tail can overlap.
pub(crate) fn persist_recall_event_part(
    state: &AppState,
    thread_id: &str,
    assistant_message_id: &str,
    line: &str,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return;
    };
    if value.get("type").and_then(|kind| kind.as_str()) != Some("recall") {
        return;
    }
    let Some(payload) = value.get("payload") else {
        return;
    };
    let part = serde_json::json!({ "type": "recall", "payload": payload });
    if let Ok(store) = lock_store(state) {
        let _ = store.append_assistant_event_part(thread_id, assistant_message_id, &part);
    }
}

pub(crate) fn persist_redacted_user_text_from_stream_line(
    state: &AppState,
    thread_id: &str,
    user_message_id: &str,
    line: &str,
) {
    let Some(redacted) = redacted_user_text_from_stream_line(line) else {
        return;
    };
    if let Ok(store) = lock_store(state) {
        let _ = store.set_message_text(thread_id, user_message_id, &redacted);
    }
}

pub(crate) fn fanout_legacy_card_markers_from_text(state: &AppState, turn_id: &str, text: &str) {
    for (open, close, kind) in [
        (
            "‹‹CHOICES››",
            "‹‹/CHOICES››",
            local_first_task_runtime::TurnEventKind::ChoicePrompt,
        ),
        (
            "‹‹VAULT_PROPOSE››",
            "‹‹/VAULT_PROPOSE››",
            local_first_task_runtime::TurnEventKind::VaultPropose,
        ),
        (
            "‹‹VAULT_REVEAL››",
            "‹‹/VAULT_REVEAL››",
            local_first_task_runtime::TurnEventKind::VaultReveal,
        ),
        (
            "‹‹PAYMENT_APPROVAL››",
            "‹‹/PAYMENT_APPROVAL››",
            local_first_task_runtime::TurnEventKind::PaymentApproval,
        ),
    ] {
        let mut cursor = text;
        while let Some(start) = cursor.find(open) {
            let after_open = start + open.len();
            let Some(close_rel) = cursor[after_open..].find(close) else {
                break;
            };
            let payload_text = &cursor[after_open..after_open + close_rel];
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(payload_text)
                && (kind != local_first_task_runtime::TurnEventKind::PaymentApproval
                    || local_first_desktop_gateway::valid_payment_approval_payload(&payload))
                && let Ok(store) = state.task_store.lock()
            {
                let already_present = store
                    .read_turn_events(turn_id, 0)
                    .map(|events| {
                        events
                            .iter()
                            .any(|event| event.kind == kind && event.payload == payload)
                    })
                    .unwrap_or(false);
                if !already_present {
                    let _ = crate::turn_executor::emit_turn_event(
                        state, &store, turn_id, kind, payload,
                    );
                }
            }
            cursor = &cursor[after_open + close_rel + close.len()..];
        }
    }
}

/// Maps a raw stream NDJSON line to a TurnEventKind + payload and emits it via
/// the turn_executor fan-out (durable turn_events + live broadcast). Best-effort:
/// unparseable lines or unknown types are silently skipped (they don't affect the
/// assistant message accumulation either).
pub(crate) fn fanout_turn_event(state: &AppState, turn_id: &str, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    let kind_str = value
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("unknown");
    tracing::debug!(target: "broker::fanout", turn_id = %turn_id, kind = %kind_str, "stream event");
    if kind_str == "done"
        && let Some(text) = value.get("text").and_then(serde_json::Value::as_str)
    {
        fanout_legacy_card_markers_from_text(state, turn_id, text);
    }
    let Some((kind, payload)) = turn_event_from_stream_value(&value) else {
        return;
    };
    if local_first_task_runtime::turn_event_kind_is_terminal(kind) {
        return;
    }
    if let Ok(store) = state.task_store.lock() {
        let _ = crate::turn_executor::emit_turn_event(state, &store, turn_id, kind, payload);
    }
}
