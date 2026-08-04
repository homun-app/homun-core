use crate::model_registry::{ProviderEntry, ProviderRegistry, canonical_provider_base_url};
use crate::usage_store::RunTokenUsage;
use local_first_task_runtime::AgentRun;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum RuntimeContextProvenance {
    ProviderReported,
    PromptSnapshotEstimate,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuntimeContextContribution {
    pub estimated_tokens: u64,
    pub source: RuntimeContextProvenance,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeContextResponse {
    pub run_id: Option<String>,
    pub turn_id: Option<String>,
    pub role: Option<String>,
    pub effective_model: Option<String>,
    pub provider: Option<String>,
    pub locality: Option<String>,
    pub context_window: Option<u32>,
    pub used_input_tokens: Option<u64>,
    pub compacted: bool,
    pub contributions: RuntimeContextContributions,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RuntimeContextContributions {
    pub conversation: Option<RuntimeContextContribution>,
    pub compacted_summary: Option<RuntimeContextContribution>,
    pub files_artifacts: Option<RuntimeContextContribution>,
    pub authorized_memory: Option<RuntimeContextContribution>,
    pub system_tools: Option<RuntimeContextContribution>,
}

impl RuntimeContextResponse {
    pub fn unavailable() -> Self {
        Self {
            run_id: None,
            turn_id: None,
            role: None,
            effective_model: None,
            provider: None,
            locality: None,
            context_window: None,
            used_input_tokens: None,
            compacted: false,
            contributions: RuntimeContextContributions::default(),
        }
    }
}

pub fn project_runtime_context(
    run: Option<&AgentRun>,
    prompt_snapshot: Option<&Value>,
    compacted: bool,
    usage: Option<&RunTokenUsage>,
    registry: &ProviderRegistry,
) -> RuntimeContextResponse {
    let Some(run) = run else {
        return RuntimeContextResponse::unavailable();
    };
    let snapshot_model = prompt_snapshot.and_then(|snapshot| string_field(snapshot, "model"));
    let effective_model = snapshot_model
        .clone()
        .or_else(|| nonempty(run.model.as_deref()))
        .or_else(|| usage.and_then(|usage| nonempty(usage.model_id.as_deref())));
    let snapshot_provider = prompt_snapshot.and_then(|snapshot| string_field(snapshot, "provider"));
    let registry_match = registry_match(
        registry,
        effective_model.as_deref(),
        snapshot_provider.as_deref(),
        usage.and_then(|usage| usage.provider_id.as_deref()),
    );
    let (provider, locality) = match usage {
        Some(usage) => (usage.provider_id.clone(), usage.locality.clone()),
        None => registry_match
            .map(|(provider, _)| {
                (
                    Some(provider.id.clone()),
                    Some(provider_locality(&provider.base_url).to_string()),
                )
            })
            .unwrap_or((None, None)),
    };
    let context_window = registry_match.and_then(|(_, model)| model.context_window);

    RuntimeContextResponse {
        run_id: Some(run.run_id.clone()),
        turn_id: Some(run.turn_id.clone()),
        role: run.role.clone(),
        effective_model,
        provider,
        locality,
        context_window,
        used_input_tokens: usage.and_then(|usage| usage.input_tokens),
        compacted,
        contributions: prompt_snapshot
            .and_then(snapshot_contributions)
            .unwrap_or_default(),
    }
}

fn snapshot_contributions(snapshot: &Value) -> Option<RuntimeContextContributions> {
    let messages = snapshot.get("messages")?.as_array()?;
    let omitted_messages = snapshot
        .get("omitted_messages")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let omitted_tools = snapshot
        .get("omitted_tools")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let conversation_chars = messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) != Some("system"))
        .filter_map(|message| message.get("chars").and_then(Value::as_u64))
        .sum::<u64>();
    let system_chars = messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("system"))
        .filter_map(|message| message.get("chars").and_then(Value::as_u64))
        .sum::<u64>();
    let tool_chars = snapshot
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| tool.get("chars").and_then(Value::as_u64))
        .sum::<u64>();
    Some(RuntimeContextContributions {
        conversation: (omitted_messages == 0).then(|| prompt_estimate(conversation_chars)),
        system_tools: (omitted_messages == 0 && omitted_tools == 0)
            .then(|| prompt_estimate(system_chars.saturating_add(tool_chars))),
        ..RuntimeContextContributions::default()
    })
}

fn prompt_estimate(chars: u64) -> RuntimeContextContribution {
    RuntimeContextContribution {
        estimated_tokens: chars / 4,
        source: RuntimeContextProvenance::PromptSnapshotEstimate,
    }
}

fn registry_match<'a>(
    registry: &'a ProviderRegistry,
    model_id: Option<&str>,
    snapshot_provider: Option<&str>,
    usage_provider_id: Option<&str>,
) -> Option<(&'a ProviderEntry, &'a crate::model_registry::ModelEntry)> {
    let model_id = model_id?;
    let from_usage = usage_provider_id
        .and_then(|provider_id| registry.get(provider_id))
        .and_then(|provider| {
            provider
                .models
                .iter()
                .find(|model| model.id == model_id)
                .map(|model| (provider, model))
        });
    if from_usage.is_some() {
        return from_usage;
    }
    let snapshot_provider = canonical_provider_base_url(snapshot_provider?);
    registry.providers.iter().find_map(|provider| {
        if canonical_provider_base_url(&provider.base_url) != snapshot_provider {
            return None;
        }
        provider
            .models
            .iter()
            .find(|model| model.id == model_id)
            .map(|model| (provider, model))
    })
}

fn provider_locality(base_url: &str) -> &'static str {
    let base_url = base_url.to_ascii_lowercase();
    if base_url.contains("127.0.0.1")
        || base_url.contains("localhost")
        || base_url.contains("[::1]")
    {
        "local"
    } else {
        "cloud"
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    nonempty(value.get(key).and_then(Value::as_str))
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_registry::{ModelEntry, ProviderEntry, ProviderKind, ProviderRegistry};
    use crate::usage_store::RunTokenUsage;
    use local_first_task_runtime::{AgentRun, AgentRunStatus};
    use serde_json::json;

    fn run() -> AgentRun {
        AgentRun {
            run_id: "run-1".into(),
            turn_id: "turn-1".into(),
            thread_id: "thread-1".into(),
            user_id: "u".into(),
            workspace_id: "w".into(),
            attempt: 1,
            status: AgentRunStatus::Completed,
            role: Some("coding".into()),
            model: Some("run-model".into()),
            provider: Some("internal-provider-value".into()),
            prompt_fingerprint: Some("secret-hash".into()),
            started_at: 1,
            completed_at: Some(2),
            terminal_reason: None,
            schema_version: 1,
        }
    }

    fn registry() -> ProviderRegistry {
        let mut provider = ProviderEntry::new(
            "registry-provider".into(),
            "Registry Provider".into(),
            ProviderKind::OpenaiCompat,
            "https://private.example/v1".into(),
        );
        let mut model = ModelEntry::inferred("snapshot-model");
        model.context_window = Some(16_384);
        provider.models.push(model);
        ProviderRegistry {
            providers: vec![provider],
            ..ProviderRegistry::default()
        }
    }

    fn snapshot() -> serde_json::Value {
        json!({
            "model": "snapshot-model",
            "provider": "https://private.example/v1",
            "messages": [
                {"role": "system", "chars": 40, "content": "system-secret"},
                {"role": "user", "chars": 80, "content": "user-secret"},
                {"role": "assistant", "chars": 20, "content": "assistant-secret"}
            ],
            "tools": [
                {"name": "secret_tool", "chars": 20, "schema": {"api_key": "secret"}}
            ],
            "fingerprint": "secret-hash",
            "packets": [{"path": "/private/path", "memory": "private-memory"}]
        })
    }

    #[test]
    fn runtime_context_prefers_canonical_snapshot_and_scoped_usage() {
        let usage = RunTokenUsage {
            provider_id: Some("usage-provider".into()),
            model_id: Some("usage-model".into()),
            locality: Some("cloud".into()),
            input_tokens: Some(321),
            ..RunTokenUsage::default()
        };

        let response = project_runtime_context(
            Some(&run()),
            Some(&snapshot()),
            true,
            Some(&usage),
            &registry(),
        );

        assert_eq!(response.run_id.as_deref(), Some("run-1"));
        assert_eq!(response.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(response.role.as_deref(), Some("coding"));
        assert_eq!(response.effective_model.as_deref(), Some("snapshot-model"));
        assert_eq!(response.provider.as_deref(), Some("usage-provider"));
        assert_eq!(response.locality.as_deref(), Some("cloud"));
        assert_eq!(response.context_window, Some(16_384));
        assert_eq!(response.used_input_tokens, Some(321));
        assert!(response.compacted);
        assert_eq!(
            response.contributions.conversation,
            Some(RuntimeContextContribution {
                estimated_tokens: 25,
                source: RuntimeContextProvenance::PromptSnapshotEstimate,
            })
        );
        assert_eq!(
            response.contributions.system_tools,
            Some(RuntimeContextContribution {
                estimated_tokens: 15,
                source: RuntimeContextProvenance::PromptSnapshotEstimate,
            })
        );
        assert!(response.contributions.compacted_summary.is_none());
        assert!(response.contributions.files_artifacts.is_none());
        assert!(response.contributions.authorized_memory.is_none());
    }

    #[test]
    fn runtime_context_registry_fallback_never_exposes_internal_endpoint() {
        let response =
            project_runtime_context(Some(&run()), Some(&snapshot()), false, None, &registry());
        let encoded = serde_json::to_string(&response).unwrap();

        assert_eq!(response.provider.as_deref(), Some("registry-provider"));
        assert_eq!(response.locality.as_deref(), Some("cloud"));
        assert_eq!(response.used_input_tokens, None);
        for forbidden in [
            "system-secret",
            "user-secret",
            "assistant-secret",
            "secret_tool",
            "api_key",
            "secret-hash",
            "/private/path",
            "private-memory",
            "https://private.example/v1",
            "base_url",
            "\"messages\":",
            "\"tools\":",
            "\"packets\":",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "leaked {forbidden}: {encoded}"
            );
        }
    }

    #[test]
    fn runtime_context_keeps_only_unaffected_categories_when_tools_were_omitted() {
        let mut partial = snapshot();
        partial["truncated"] = json!(true);
        partial["omitted_messages"] = json!(0);
        partial["omitted_tools"] = json!(1);

        let response =
            project_runtime_context(Some(&run()), Some(&partial), false, None, &registry());

        assert_eq!(
            response.contributions.conversation,
            Some(RuntimeContextContribution {
                estimated_tokens: 25,
                source: RuntimeContextProvenance::PromptSnapshotEstimate,
            })
        );
        assert_eq!(response.contributions.system_tools, None);
    }

    #[test]
    fn runtime_context_marks_message_affected_categories_unavailable() {
        let mut omitted = snapshot();
        omitted["truncated"] = json!(true);
        omitted["omitted_messages"] = json!(1);
        omitted["omitted_tools"] = json!(0);

        let response =
            project_runtime_context(Some(&run()), Some(&omitted), false, None, &registry());

        assert_eq!(response.contributions.conversation, None);
        assert_eq!(response.contributions.system_tools, None);
    }

    #[test]
    fn runtime_context_without_a_run_is_stable_and_unavailable() {
        let response =
            project_runtime_context(None, None, false, None, &ProviderRegistry::default());
        let value = serde_json::to_value(response).unwrap();

        assert!(value["run_id"].is_null());
        assert!(value["turn_id"].is_null());
        assert!(value["role"].is_null());
        assert!(value["effective_model"].is_null());
        assert!(value["provider"].is_null());
        assert!(value["locality"].is_null());
        assert!(value["context_window"].is_null());
        assert!(value["used_input_tokens"].is_null());
        assert_eq!(value["compacted"], false);
        assert!(value["contributions"]["conversation"].is_null());
        assert!(value["contributions"]["system_tools"].is_null());
    }
}
