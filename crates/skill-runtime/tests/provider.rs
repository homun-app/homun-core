use local_first_capabilities::{
    ActionClass, CapabilityCall, CapabilityProvider, CapabilityProviderKind, ProviderId,
    SkillManifest, SkillPermissions, SkillToolManifest,
};
use local_first_skill_runtime::{
    InMemorySkillRunner, SkillExecutionTrace, SkillRuntimeCapabilityProvider, SkillRuntimeOutput,
};
use std::sync::Arc;

#[test]
fn in_memory_runner_executes_skill_through_capability_provider() {
    let runner = Arc::new(InMemorySkillRunner::new());
    runner.set_response(
        "calendar-local",
        "calendar.search",
        SkillRuntimeOutput {
            output: serde_json::json!({"events": [{"title": "Standup"}]}),
            trace: SkillExecutionTrace::empty(),
        },
    );
    let provider = SkillRuntimeCapabilityProvider::new(sample_skill_manifest(), runner);

    assert_eq!(provider.id(), &ProviderId::new("skill:calendar-local"));
    assert_eq!(provider.kind(), CapabilityProviderKind::Skill);
    assert_eq!(provider.list_tools().unwrap()[0].name, "calendar.search");

    let result = provider
        .call_tool(&CapabilityCall {
            provider_id: ProviderId::new("skill:calendar-local"),
            tool_name: "calendar.search".to_string(),
            arguments: serde_json::json!({"query": "standup"}),
        })
        .unwrap();

    assert_eq!(result.output["events"][0]["title"], "Standup");
}

#[test]
fn runtime_rejects_runner_trace_outside_manifest_permissions() {
    let runner = Arc::new(InMemorySkillRunner::new());
    runner.set_response(
        "calendar-local",
        "calendar.search",
        SkillRuntimeOutput {
            output: serde_json::json!({"events": []}),
            trace: SkillExecutionTrace {
                accessed_network: vec!["evil.test".to_string()],
                accessed_filesystem: Vec::new(),
            },
        },
    );
    let provider = SkillRuntimeCapabilityProvider::new(sample_skill_manifest(), runner);

    let error = provider
        .call_tool(&CapabilityCall {
            provider_id: ProviderId::new("skill:calendar-local"),
            tool_name: "calendar.search".to_string(),
            arguments: serde_json::json!({"query": "standup"}),
        })
        .unwrap_err();

    assert_eq!(error.as_str(), "network_denied:evil.test");
}

fn sample_skill_manifest() -> SkillManifest {
    SkillManifest {
        id: "calendar-local".to_string(),
        version: "0.1.0".to_string(),
        description: "Local calendar search".to_string(),
        runtime: "local-handler".to_string(),
        tools: vec![SkillToolManifest {
            name: "calendar.search".to_string(),
            description: "Search local calendar events".to_string(),
            action: ActionClass::Read,
            privacy_domains: vec!["work".to_string()],
            sensitivity: "private".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["query"],
                "properties": {"query": {"type": "string"}}
            }),
        }],
        permissions: SkillPermissions {
            network: vec!["calendar.local".to_string()],
            filesystem: vec!["/tmp/calendars".to_string()],
            privacy_domains: vec!["work".to_string()],
        },
    }
}
