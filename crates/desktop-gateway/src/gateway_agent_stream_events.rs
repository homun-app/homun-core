use serde_json::Value;

pub(crate) fn apply_agent_stream_line(
    line: &str,
    streamed_text: &mut String,
    final_text: &mut Option<String>,
) -> bool {
    let line = line.trim();
    if line.is_empty() {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    match value.get("type").and_then(|t| t.as_str()) {
        Some("delta") => {
            if let Some(text) = value.get("text").and_then(|t| t.as_str()) {
                streamed_text.push_str(text);
            }
            false
        }
        Some("done") => {
            if let Some(text) = value.get("text").and_then(|t| t.as_str()) {
                *final_text = Some(text.to_string());
            } else if !streamed_text.trim().is_empty() {
                *final_text = Some(streamed_text.clone());
            }
            true
        }
        Some("error") => true,
        _ => false,
    }
}

/// Maps a raw stream value to a durable TurnEventKind and its transport payload.
pub(crate) fn turn_event_from_stream_value(
    value: &serde_json::Value,
) -> Option<(local_first_task_runtime::TurnEventKind, serde_json::Value)> {
    let kind_str = value.get("type").and_then(|t| t.as_str())?;
    let (kind, payload) = match kind_str {
        "delta" => (
            local_first_task_runtime::TurnEventKind::Delta,
            serde_json::json!({ "text": value.get("text").and_then(|t| t.as_str()).unwrap_or("") }),
        ),
        "reasoning" => (
            local_first_task_runtime::TurnEventKind::Reasoning,
            serde_json::json!({ "text": value.get("text").and_then(|t| t.as_str()).unwrap_or("") }),
        ),
        "activity" => (
            local_first_task_runtime::TurnEventKind::Activity,
            serde_json::json!({ "text": value.get("text").and_then(|t| t.as_str()).unwrap_or("") }),
        ),
        "plan_update" => (
            local_first_task_runtime::TurnEventKind::PlanUpdate,
            serde_json::json!({ "markdown": value.get("markdown").and_then(|t| t.as_str()).unwrap_or("") }),
        ),
        "tool_result" => (local_first_task_runtime::TurnEventKind::Tool, value.clone()),
        "step_advance" => (
            local_first_task_runtime::TurnEventKind::StepAdvance,
            // Frontend contract (exact): step_id, title, from (null for a new step), to,
            // verified (F2 verdict, null for plain moves), note.
            serde_json::json!({
                "step_id": value.get("step_id").and_then(|v| v.as_str()).unwrap_or(""),
                "title": value.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                "from": value.get("from").cloned().filter(|v| !v.is_null()).unwrap_or(serde_json::Value::Null),
                "to": value.get("to").and_then(|v| v.as_str()).unwrap_or(""),
                "verified": value.get("verified").cloned().filter(|v| !v.is_null()).unwrap_or(serde_json::Value::Null),
                "note": value.get("note").cloned().filter(|v| !v.is_null()).unwrap_or(serde_json::Value::Null),
            }),
        ),
        "recall" => (
            local_first_task_runtime::TurnEventKind::Recall,
            value
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        ),
        "choice_prompt" => (
            local_first_task_runtime::TurnEventKind::ChoicePrompt,
            value
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        ),
        "vault_propose" => (
            local_first_task_runtime::TurnEventKind::VaultPropose,
            value
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        ),
        "vault_reveal" => (
            local_first_task_runtime::TurnEventKind::VaultReveal,
            value
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        ),
        "payment_approval" => (local_first_task_runtime::TurnEventKind::PaymentApproval, {
            let payload = value
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            if !local_first_desktop_gateway::valid_payment_approval_payload(&payload) {
                return None;
            }
            payload
        }),
        "done" => (
            local_first_task_runtime::TurnEventKind::Done,
            serde_json::json!({
                "text": value.get("text").and_then(Value::as_str).unwrap_or(""),
                "redacted_user_text": value
                    .get("redacted_user_text")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            }),
        ),
        "error" => (
            local_first_task_runtime::TurnEventKind::Error,
            serde_json::json!({
                "code": value.get("code").and_then(Value::as_str).unwrap_or(""),
                "message": value.get("message").and_then(Value::as_str).unwrap_or(""),
                "retryable": value.get("retryable").and_then(Value::as_bool).unwrap_or(false),
            }),
        ),
        // Unknown event types are not turn events.
        _ => return None,
    };
    Some((kind, payload))
}

pub(crate) fn redacted_user_text_from_stream_line(line: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
    if value.get("type").and_then(|kind| kind.as_str()) != Some("done") {
        return None;
    }
    value
        .get("redacted_user_text")
        .and_then(|text| text.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}
