use local_first_capabilities::{
    ActionClass, CapabilityCall, CapabilityFacade, CapabilityPolicy, CapabilityProviderGrant,
    CapabilityTaskExecutor, CapabilityTaskRuntimeBridge, InMemoryCapabilityAudit, ProviderId,
    SkillManifest, SkillPermissions, SkillToolManifest, UserId, WorkspaceId,
};
use local_first_skill_runtime::{
    InMemorySkillRunner, SkillExecutionTrace, SkillRuntimeCapabilityProvider, SkillRuntimeOutput,
};
use local_first_task_runtime::{ExecutorResult, TaskExecutor, TaskStore};
use std::sync::Arc;

#[test]
fn skill_runtime_completes_through_capability_task_executor() {
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let manifest = sample_skill_manifest();
    let provider_id = ProviderId::new("skill:calendar-local");
    let runner = Arc::new(InMemorySkillRunner::new());
    runner.set_response(
        "calendar-local",
        "calendar.search",
        SkillRuntimeOutput {
            output: serde_json::json!({"events": [{"title": "Standup"}]}),
            trace: SkillExecutionTrace::empty(),
        },
    );
    let provider = SkillRuntimeCapabilityProvider::new(manifest.clone(), runner);
    let mut facade = CapabilityFacade::new(CapabilityPolicy::new(), InMemoryCapabilityAudit::new());
    facade.register_provider(provider);
    let context =
        CapabilityProviderGrant::new(provider_id.clone(), user.clone(), workspace.clone())
            .with_privacy_domains(vec!["work".to_string()])
            .with_allowed_actions(vec![ActionClass::Read])
            .with_max_autonomy_level(0);
    let policy_context = local_first_capabilities::PolicyContext {
        user_id: user,
        workspace_id: workspace,
        enabled_providers: vec![provider_id.clone()],
        privacy_domains: context.privacy_domains,
        allowed_actions: context.allowed_actions,
        max_autonomy_level: context.max_autonomy_level,
        allow_managed_cloud: false,
    };
    let tool = local_first_capabilities::CapabilityTool {
        name: "calendar.search".to_string(),
        provider_id: provider_id.clone(),
        provider_kind: local_first_capabilities::CapabilityProviderKind::Skill,
        action: ActionClass::Read,
        description: "Search local calendar events".to_string(),
        privacy_domains: vec!["work".to_string()],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({"type": "object", "required": ["query"]}),
    };
    let call = CapabilityCall {
        provider_id,
        tool_name: "calendar.search".to_string(),
        arguments: serde_json::json!({"query": "standup"}),
    };
    let store = TaskStore::open_in_memory().unwrap();
    let bridge = CapabilityTaskRuntimeBridge::new();
    let task = bridge
        .enqueue_call(&store, "task_1", &policy_context, &call, &tool)
        .unwrap();
    let mut executor = CapabilityTaskExecutor::new(facade);

    let result = executor.execute_step(&task, None).unwrap();

    match result {
        ExecutorResult::Completed { output } => {
            assert_eq!(output["output"]["events"][0]["title"], "Standup");
        }
        other => panic!("expected completed skill task, got {other:?}"),
    }
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
