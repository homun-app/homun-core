use crate::LoopState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

/// Serializable state captured only at safe round boundaries. Provider credentials,
/// pending screenshots and vault markers are intentionally excluded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoopCheckpoint {
    pub schema_version: u32,
    pub round: usize,
    pub messages: Vec<Value>,
    pub step_messages_start: usize,
    pub accumulated: String,
    pub tool_trace: Vec<String>,
    pub last_round_sig: String,
    pub repeat_count: u32,
    #[serde(default)]
    pub last_no_progress_family: String,
    #[serde(default)]
    pub no_progress_count: u32,
    pub progress_anchor_round: usize,
    pub progress_verify_anchor: usize,
    pub step_evidence: Vec<String>,
    pub pending_compaction: bool,
    pub loaded_tools: BTreeSet<String>,
    pub active_sensitive: Vec<String>,
    pub plan: Value,
    pub provider_model: String,
    pub provider_base_url: String,
    pub browser_used: bool,
    pub browser_tool_call_ids: BTreeSet<String>,
}

impl LoopCheckpoint {
    pub fn from_state(round: usize, state: &LoopState) -> Self {
        Self {
            schema_version: 1,
            round,
            messages: state
                .messages
                .iter()
                .cloned()
                .map(sanitize_data_urls)
                .collect(),
            step_messages_start: state.step_messages_start,
            accumulated: state.accumulated.clone(),
            tool_trace: state.tool_trace.clone(),
            last_round_sig: state.last_round_sig.clone(),
            repeat_count: state.repeat_count,
            last_no_progress_family: state.last_no_progress_family.clone(),
            no_progress_count: state.no_progress_count,
            progress_anchor_round: state.progress_anchor_round,
            progress_verify_anchor: state.progress_verify_anchor,
            step_evidence: state.step_evidence.clone(),
            pending_compaction: state.pending_compaction,
            loaded_tools: state.loaded_tools.clone(),
            active_sensitive: state.active_sensitive.clone(),
            plan: state.plan.clone(),
            provider_model: state.provider.model.clone(),
            provider_base_url: state.provider.base_url.clone(),
            browser_used: state.browser_used,
            browser_tool_call_ids: state.browser_tool_call_ids.clone(),
        }
    }

    pub fn apply_to(self, state: &mut LoopState) {
        state.messages = self.messages;
        state.step_messages_start = self.step_messages_start.min(state.messages.len());
        state.accumulated = self.accumulated;
        state.tool_trace = self.tool_trace;
        state.last_round_sig = self.last_round_sig;
        state.repeat_count = self.repeat_count;
        state.last_no_progress_family = self.last_no_progress_family;
        state.no_progress_count = self.no_progress_count;
        state.progress_anchor_round = self.progress_anchor_round;
        state.progress_verify_anchor = self.progress_verify_anchor;
        state.step_evidence = self.step_evidence;
        state.pending_compaction = self.pending_compaction;
        state.loaded_tools = self.loaded_tools;
        state.active_sensitive = self.active_sensitive;
        state.plan = self.plan;
        // Provider binding is always the freshly resolved gateway configuration.
        // The checkpoint fields are inspection metadata only.
        state.browser_used = self.browser_used;
        state.browser_tool_call_ids = self.browser_tool_call_ids;
        state.pending_browser_image = None;
    }

    pub fn fingerprint(&self) -> String {
        let bytes = serde_json::to_vec(self).unwrap_or_default();
        format!("{:x}", Sha256::digest(bytes))
    }
}

fn sanitize_data_urls(value: Value) -> Value {
    match value {
        Value::String(text) if text.starts_with("data:") && text.contains(";base64,") => {
            json!({"redacted_data_url": true, "chars": text.len()})
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_roundtrip_excludes_provider_secret_and_image_body() {
        let mut state = LoopState::new();
        state.provider.api_key = Some("sk-secret".into());
        state.provider.model = "model".into();
        state.messages = vec![json!({"role":"user","content":"data:image/png;base64,QUJD"})];
        state.pending_browser_image = Some("data:image/png;base64,SECRET".into());
        let checkpoint = LoopCheckpoint::from_state(3, &state);
        let encoded = serde_json::to_string(&checkpoint).unwrap();
        assert!(!encoded.contains("sk-secret"));
        assert!(!encoded.contains("QUJD"));
        assert!(!encoded.contains("SECRET"));
        assert_eq!(checkpoint.round, 3);
        assert_eq!(checkpoint.fingerprint(), checkpoint.fingerprint());
    }
}
