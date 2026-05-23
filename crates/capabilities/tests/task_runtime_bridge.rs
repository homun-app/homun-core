use local_first_capabilities::{
    ActionClass, CapabilityCall, CapabilityProviderKind, CapabilityTaskRuntimeBridge,
    CapabilityTool, PolicyContext, ProviderId, UserId, WorkspaceId,
};
use local_first_task_runtime::{
    ResourceClass, TaskId, TaskStatus, TaskStore, UserId as TaskUserId,
    WorkspaceId as TaskWorkspaceId,
};

#[test]
fn bridge_enqueues_capability_call_with_policy_payload_and_resource() {
    let store = TaskStore::open_in_memory().unwrap();
    let context = policy_context(false);
    let task_user = TaskUserId::new(context.user_id.as_str());
    let task_workspace = TaskWorkspaceId::new(context.workspace_id.as_str());
    let call = CapabilityCall {
        provider_id: ProviderId::new("github"),
        tool_name: "github.search".to_string(),
        arguments: serde_json::json!({"query": "bug"}),
    };
    let tool = tool(
        "github.search",
        "github",
        CapabilityProviderKind::Native,
        ActionClass::Read,
    );

    let record = CapabilityTaskRuntimeBridge::new()
        .enqueue_call(&store, "capability.task.1", &context, &call, &tool)
        .unwrap();
    let reloaded = store
        .get_task(
            &TaskId::new("capability.task.1"),
            &task_user,
            &task_workspace,
        )
        .unwrap()
        .unwrap();

    assert_eq!(record.task_id, TaskId::new("capability.task.1"));
    assert_eq!(reloaded.kind, "capability.github.github.search");
    assert_eq!(reloaded.status, TaskStatus::Queued);
    assert_eq!(reloaded.input_json["call"]["tool_name"], "github.search");
    assert_eq!(reloaded.input_json["context"]["max_autonomy_level"], 2);
    assert_eq!(reloaded.permission_context["allow_managed_cloud"], false);
    assert_eq!(
        reloaded.resource_requirements[0].class,
        ResourceClass::FilesystemIo
    );
    assert_eq!(reloaded.resource_requirements[0].units, 1);
}

#[test]
fn bridge_assigns_resource_by_provider_kind() {
    let bridge = CapabilityTaskRuntimeBridge::new();

    assert_eq!(
        bridge.resource_for_provider_kind(CapabilityProviderKind::Mcp),
        ResourceClass::ConnectorApi
    );
    assert_eq!(
        bridge.resource_for_provider_kind(CapabilityProviderKind::Managed),
        ResourceClass::ConnectorApi
    );
    assert_eq!(
        bridge.resource_for_provider_kind(CapabilityProviderKind::Browser),
        ResourceClass::BrowserSession
    );
}

fn policy_context(allow_managed_cloud: bool) -> PolicyContext {
    PolicyContext {
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        enabled_providers: vec![ProviderId::new("github"), ProviderId::new("composio")],
        privacy_domains: vec!["work".to_string()],
        allowed_actions: vec![ActionClass::Read],
        max_autonomy_level: 2,
        allow_managed_cloud,
    }
}

fn tool(
    name: impl Into<String>,
    provider: impl Into<String>,
    provider_kind: CapabilityProviderKind,
    action: ActionClass,
) -> CapabilityTool {
    CapabilityTool {
        name: name.into(),
        provider_id: ProviderId::new(provider),
        provider_kind,
        action,
        description: "Capability tool".to_string(),
        privacy_domains: vec!["work".to_string()],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({"type": "object"}),
    }
}
