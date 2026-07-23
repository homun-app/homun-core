use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const MAX_PROMPT_SNAPSHOT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptMessageSnapshot {
    pub role: String,
    pub content: Value,
    pub chars: usize,
    pub sha256: String,
    pub redacted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptToolSnapshot {
    pub name: Option<String>,
    pub schema: Value,
    pub chars: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptSnapshot {
    pub model: String,
    pub provider: String,
    pub is_final_round: bool,
    pub forced_tool: Option<String>,
    pub messages: Vec<PromptMessageSnapshot>,
    pub tools: Vec<PromptToolSnapshot>,
    pub original_chars: usize,
    pub fingerprint: String,
    pub truncated: bool,
    pub omitted_messages: usize,
    pub omitted_tools: usize,
    #[serde(default)]
    pub packets: Vec<crate::PromptPacketMetadata>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentExecutionEvent {
    SemanticDecision {
        payload: Value,
    },
    PromptSnapshot {
        round: usize,
        snapshot: PromptSnapshot,
    },
    ModelResponse {
        round: usize,
        finish_reason: Option<String>,
        content_chars: usize,
        tool_calls: usize,
    },
    ToolCallStarted {
        round: usize,
        call_id: String,
        name: String,
    },
    ToolCallCompleted {
        round: usize,
        call_id: String,
        name: String,
        result_chars: usize,
        outcome: String,
        result_fingerprint: String,
    },
    PlanUpdated {
        round: usize,
        source: String,
    },
    ContextCompacted {
        round: usize,
        reason: String,
    },
    ForcedSynthesis {
        round: Option<usize>,
        reason: String,
    },
    BrowserBudgetExceeded {
        round: usize,
        reason: String,
        elapsed_ms: u64,
        failed_navigations: u32,
        no_progress: u32,
    },
    /// A redacted browser-protocol boundary summary (observation/action_bundle/
    /// browser_done/terminal_result/etc). Callers must pre-redact `payload` —
    /// this variant does not filter its contents, it only tags the boundary.
    BrowserProtocol {
        round: usize,
        boundary: String,
        payload: Value,
    },
    RunCompleted {
        reason: String,
    },
    RunFailed {
        reason: String,
    },
    RunAborted {
        reason: String,
    },
}

impl AgentExecutionEvent {
    pub fn into_parts(self) -> (&'static str, Option<usize>, Value) {
        match self {
            Self::SemanticDecision { payload } => ("semantic_decision", None, payload),
            Self::PromptSnapshot { round, snapshot } => (
                "prompt_snapshot",
                Some(round),
                serde_json::to_value(snapshot)
                    .unwrap_or_else(|_| json!({"serialization_error": true})),
            ),
            Self::ModelResponse {
                round,
                finish_reason,
                content_chars,
                tool_calls,
            } => (
                "model_response",
                Some(round),
                json!({
                    "finish_reason": finish_reason,
                    "content_chars": content_chars,
                    "tool_calls": tool_calls,
                }),
            ),
            Self::ToolCallStarted {
                round,
                call_id,
                name,
            } => (
                "tool_call_started",
                Some(round),
                json!({"call_id": call_id, "name": name}),
            ),
            Self::ToolCallCompleted {
                round,
                call_id,
                name,
                result_chars,
                outcome,
                result_fingerprint,
            } => (
                "tool_call_completed",
                Some(round),
                json!({
                    "call_id": call_id,
                    "name": name,
                    "result_chars": result_chars,
                    "outcome": outcome,
                    "result_fingerprint": result_fingerprint,
                }),
            ),
            Self::PlanUpdated { round, source } => {
                ("plan_updated", Some(round), json!({"source": source}))
            }
            Self::ContextCompacted { round, reason } => {
                ("context_compacted", Some(round), json!({"reason": reason}))
            }
            Self::ForcedSynthesis { round, reason } => {
                ("forced_synthesis", round, json!({"reason": reason}))
            }
            Self::BrowserBudgetExceeded {
                round,
                reason,
                elapsed_ms,
                failed_navigations,
                no_progress,
            } => (
                "browser_budget_exceeded",
                Some(round),
                json!({
                    "reason": reason,
                    "elapsed_ms": elapsed_ms,
                    "failed_navigations": failed_navigations,
                    "no_progress": no_progress,
                }),
            ),
            Self::BrowserProtocol {
                round,
                boundary,
                payload,
            } => (
                "browser_protocol",
                Some(round),
                {
                    let mut obj = payload.as_object().cloned().unwrap_or_default();
                    obj.insert("boundary".to_string(), Value::String(boundary));
                    Value::Object(obj)
                },
            ),
            Self::RunCompleted { reason } => ("run_completed", None, json!({"reason": reason})),
            Self::RunFailed { reason } => ("run_failed", None, json!({"reason": reason})),
            Self::RunAborted { reason } => ("run_aborted", None, json!({"reason": reason})),
        }
    }
}

/// Compact, non-secret execution evidence for the journal and convergence guard.
/// Classification uses structured result fields when available; unknown prose is
/// treated as progress so a legitimate tool chain is never stopped heuristically.
pub fn classify_tool_result(result: &str) -> &'static str {
    let trimmed = result.trim();
    if trimmed.is_empty() {
        return "empty";
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return "success";
    };
    if value.get("ok").and_then(Value::as_bool) == Some(false)
        || value.get("success").and_then(Value::as_bool) == Some(false)
        || value.get("error").is_some_and(|error| !error.is_null())
    {
        return "error";
    }
    if let Some(status) = value.get("status").and_then(Value::as_str) {
        if matches!(status.to_ascii_lowercase().as_str(), "blocked" | "denied") {
            return "blocked";
        }
        if matches!(
            status.to_ascii_lowercase().as_str(),
            "error" | "failed" | "failure"
        ) {
            return "error";
        }
        if matches!(
            status.to_ascii_lowercase().as_str(),
            "no_progress" | "unchanged"
        ) {
            return "no_progress";
        }
    }
    if value.as_array().is_some_and(Vec::is_empty)
        || ["items", "results", "data"].into_iter().any(|key| {
            value
                .get(key)
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
        })
    {
        return "empty";
    }
    "success"
}

pub fn tool_result_fingerprint(result: &str) -> String {
    format!("{:x}", Sha256::digest(result.as_bytes()))
}

pub fn tool_family(name: &str) -> String {
    name.split_once('_')
        .map(|(family, _)| family)
        .unwrap_or(name)
        .to_string()
}

#[derive(Debug, Default, Clone, Copy)]
pub struct NoopExecutionJournal;

impl crate::contract::ExecutionJournal for NoopExecutionJournal {
    fn record(&self, _event: AgentExecutionEvent) {}
}

pub fn build_prompt_snapshot(
    model: &str,
    provider: &str,
    messages: &[Value],
    tools: &[Value],
    is_final_round: bool,
    forced_tool: Option<&str>,
) -> PromptSnapshot {
    build_prompt_snapshot_with_packets(
        model,
        provider,
        messages,
        tools,
        is_final_round,
        forced_tool,
        &[],
    )
}

pub fn build_prompt_snapshot_with_packets(
    model: &str,
    provider: &str,
    messages: &[Value],
    tools: &[Value],
    is_final_round: bool,
    forced_tool: Option<&str>,
    packets: &[crate::PromptPacketMetadata],
) -> PromptSnapshot {
    let message_snapshots = messages
        .iter()
        .map(|message| {
            let content =
                sanitize_data_urls(message.get("content").cloned().unwrap_or(Value::Null));
            let raw = serde_json::to_vec(message).unwrap_or_default();
            PromptMessageSnapshot {
                role: message
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                chars: raw.len(),
                sha256: sha256_hex(&raw),
                content,
                redacted: false,
            }
        })
        .collect::<Vec<_>>();
    let tool_snapshots = tools
        .iter()
        .map(|tool| {
            let raw = serde_json::to_vec(tool).unwrap_or_default();
            PromptToolSnapshot {
                name: tool
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                schema: sanitize_data_urls(tool.clone()),
                chars: raw.len(),
                sha256: sha256_hex(&raw),
            }
        })
        .collect::<Vec<_>>();
    let original_chars = message_snapshots.iter().map(|m| m.chars).sum::<usize>()
        + tool_snapshots.iter().map(|t| t.chars).sum::<usize>();
    let fingerprint = sha256_hex(
        &serde_json::to_vec(&json!({
            "model": model,
            "provider": provider,
            "messages": messages,
            "tools": tools,
            "is_final_round": is_final_round,
            "forced_tool": forced_tool,
        }))
        .unwrap_or_default(),
    );
    let mut snapshot = PromptSnapshot {
        model: model.to_string(),
        provider: provider.to_string(),
        is_final_round,
        forced_tool: forced_tool.map(str::to_string),
        messages: message_snapshots,
        tools: tool_snapshots,
        original_chars,
        fingerprint,
        truncated: false,
        omitted_messages: 0,
        omitted_tools: 0,
        packets: packets.to_vec(),
    };
    bound_snapshot(&mut snapshot);
    snapshot
}

fn bound_snapshot(snapshot: &mut PromptSnapshot) {
    if serialized_len(snapshot) <= MAX_PROMPT_SNAPSHOT_BYTES {
        return;
    }
    snapshot.truncated = true;
    for message in &mut snapshot.messages {
        if serialized_len_value(&message.content) > 512 {
            message.content = json!({
                "truncated": true,
                "chars": message.chars,
                "sha256": message.sha256,
            });
        }
    }
    for tool in &mut snapshot.tools {
        if serialized_len_value(&tool.schema) > 512 {
            tool.schema = json!({
                "truncated": true,
                "chars": tool.chars,
                "sha256": tool.sha256,
            });
        }
    }
    while serialized_len(snapshot) > MAX_PROMPT_SNAPSHOT_BYTES && !snapshot.messages.is_empty() {
        snapshot.messages.pop();
        snapshot.omitted_messages += 1;
    }
    while serialized_len(snapshot) > MAX_PROMPT_SNAPSHOT_BYTES && !snapshot.tools.is_empty() {
        snapshot.tools.pop();
        snapshot.omitted_tools += 1;
    }
}

fn sanitize_data_urls(value: Value) -> Value {
    match value {
        Value::String(text) if text.starts_with("data:") && text.contains(";base64,") => {
            let (header, body) = text.split_once(',').unwrap_or((&text, ""));
            json!({
                "data_url": true,
                "media_type": header.trim_start_matches("data:").trim_end_matches(";base64"),
                "encoded_chars": body.len(),
                "sha256": sha256_hex(body.as_bytes()),
            })
        }
        Value::Array(values) => Value::Array(values.into_iter().map(sanitize_data_urls).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, sanitize_data_urls(value)))
                .collect(),
        ),
        other => other,
    }
}

fn serialized_len<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value).map_or(0, |bytes| bytes.len())
}

fn serialized_len_value(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(0, |bytes| bytes.len())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prompt_snapshot_is_stable_ordered_and_strips_data_url_bodies() {
        let messages = vec![
            json!({"role": "system", "content": "rules"}),
            json!({"role": "user", "content": [
                {"type": "text", "text": "inspect"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJDREVGRw=="}}
            ]}),
        ];
        let tools = vec![
            json!({"type": "function", "function": {"name": "first", "parameters": {}}}),
            json!({"type": "function", "function": {"name": "second", "parameters": {}}}),
        ];

        let a = build_prompt_snapshot("model-a", "provider-a", &messages, &tools, false, None);
        let b = build_prompt_snapshot("model-a", "provider-a", &messages, &tools, false, None);
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_eq!(a.messages[0].role, "system");
        assert_eq!(a.messages[1].role, "user");
        assert_eq!(a.tools[0].name.as_deref(), Some("first"));
        assert_eq!(a.tools[1].name.as_deref(), Some("second"));
        let encoded = serde_json::to_string(&a).unwrap();
        assert!(!encoded.contains("QUJDREVGRw=="));
        assert!(encoded.contains("image/png"));
    }

    #[test]
    fn prompt_snapshot_is_bounded_and_marks_truncation() {
        let messages = vec![json!({"role": "user", "content": "x".repeat(100_000)})];
        let snapshot = build_prompt_snapshot("m", "p", &messages, &[], false, None);
        let encoded = serde_json::to_vec(&snapshot).unwrap();
        assert!(encoded.len() <= MAX_PROMPT_SNAPSHOT_BYTES);
        assert!(snapshot.truncated);
        assert!(snapshot.original_chars >= 100_000);
    }

    #[test]
    fn event_parts_keep_prompt_fingerprint_at_payload_root() {
        let snapshot = build_prompt_snapshot("m", "p", &[], &[], true, Some("tool"));
        let expected = snapshot.fingerprint.clone();
        let (kind, round, payload) =
            AgentExecutionEvent::PromptSnapshot { round: 7, snapshot }.into_parts();
        assert_eq!(kind, "prompt_snapshot");
        assert_eq!(round, Some(7));
        assert_eq!(payload["fingerprint"], expected);
    }

    #[test]
    fn browser_protocol_event_maps_to_parts() {
        let event = AgentExecutionEvent::BrowserProtocol {
            round: 2,
            boundary: "action_bundle".to_string(),
            payload: serde_json::json!({ "action_kinds": ["click"], "stop_reason": "completed" }),
        };
        let (kind, round, value) = event.into_parts();
        assert_eq!(kind, "browser_protocol");
        assert_eq!(round, Some(2));
        assert_eq!(value["boundary"], "action_bundle");
    }

    #[test]
    fn tool_outcomes_use_structured_signals_and_fingerprints_hide_content() {
        assert_eq!(classify_tool_result(""), "empty");
        assert_eq!(
            classify_tool_result(r#"{"ok":false,"error":"denied"}"#),
            "error"
        );
        assert_eq!(classify_tool_result(r#"{"status":"blocked"}"#), "blocked");
        assert_eq!(classify_tool_result(r#"{"results":[]}"#), "empty");
        assert_eq!(classify_tool_result("ordinary useful prose"), "success");
        let fingerprint = tool_result_fingerprint("secret result");
        assert_eq!(fingerprint.len(), 64);
        assert!(!fingerprint.contains("secret"));
        assert_eq!(tool_family("browser_navigate"), "browser");
        assert_eq!(tool_family("shell"), "shell");
    }
}
