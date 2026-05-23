use local_first_capabilities::{
    ActionClass, CapabilityCall, CapabilityFacade, CapabilityPolicy, CapabilityProviderKind,
    CapabilityTaskExecutor, CapabilityTaskRuntimeBridge, CapabilityTool, FakeCapabilityProvider,
    InMemoryCapabilityAudit, PolicyContext, ProviderId, UserId, WorkspaceId,
};
use local_first_task_runtime::{
    ResourceClass, ResourceLimits, TaskId, TaskRuntime, TaskStatus, TaskStore,
    UserId as TaskUserId, WorkspaceId as TaskWorkspaceId,
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

#[test]
fn capability_task_executor_completes_successful_tool_call() {
    let store = TaskStore::open_in_memory().unwrap();
    let context = policy_context(false);
    let task_user = TaskUserId::new(context.user_id.as_str());
    let task_workspace = TaskWorkspaceId::new(context.workspace_id.as_str());
    let call = CapabilityCall {
        provider_id: ProviderId::new("github"),
        tool_name: "github.search".to_string(),
        arguments: serde_json::json!({"query": "bug"}),
    };
    let search_tool = tool(
        "github.search",
        "github",
        CapabilityProviderKind::Native,
        ActionClass::Read,
    );
    CapabilityTaskRuntimeBridge::new()
        .enqueue_call(&store, "capability.task.1", &context, &call, &search_tool)
        .unwrap();

    let mut provider = FakeCapabilityProvider::new(
        ProviderId::new("github"),
        CapabilityProviderKind::Native,
        true,
        None,
        vec![search_tool],
    );
    provider.set_tool_response(
        "github.search",
        serde_json::json!({"items": [{"title": "Bug"}]}),
    );
    let mut facade = CapabilityFacade::new(CapabilityPolicy::new(), InMemoryCapabilityAudit::new());
    facade.register_provider(provider);
    let executor = CapabilityTaskExecutor::new(facade);
    let mut runtime = TaskRuntime::new(
        store,
        Box::new(executor),
        ResourceLimits::new().with_limit(ResourceClass::FilesystemIo, 1),
        "worker_a",
    );

    let summary = runtime
        .run_ready_once(&task_user, &task_workspace, time::OffsetDateTime::now_utc())
        .unwrap();
    let task = runtime
        .store()
        .get_task(
            &TaskId::new("capability.task.1"),
            &task_user,
            &task_workspace,
        )
        .unwrap()
        .unwrap();

    assert_eq!(summary.completed, 1);
    assert_eq!(task.status, TaskStatus::Completed);
}

#[test]
fn capability_task_executor_maps_policy_denial_to_retryable_failure() {
    let store = TaskStore::open_in_memory().unwrap();
    let context = policy_context(false);
    let task_user = TaskUserId::new(context.user_id.as_str());
    let task_workspace = TaskWorkspaceId::new(context.workspace_id.as_str());
    let call = CapabilityCall {
        provider_id: ProviderId::new("composio"),
        tool_name: "gmail.search".to_string(),
        arguments: serde_json::json!({"query": "from:alice"}),
    };
    let managed_tool = tool(
        "gmail.search",
        "composio",
        CapabilityProviderKind::Managed,
        ActionClass::Read,
    );
    CapabilityTaskRuntimeBridge::new()
        .enqueue_call(
            &store,
            "capability.task.denied",
            &context,
            &call,
            &managed_tool,
        )
        .unwrap();

    let provider = FakeCapabilityProvider::new(
        ProviderId::new("composio"),
        CapabilityProviderKind::Managed,
        true,
        None,
        vec![managed_tool],
    );
    let mut facade = CapabilityFacade::new(CapabilityPolicy::new(), InMemoryCapabilityAudit::new());
    facade.register_provider(provider);
    let executor = CapabilityTaskExecutor::new(facade);
    let mut runtime = TaskRuntime::new(
        store,
        Box::new(executor),
        ResourceLimits::new().with_limit(ResourceClass::ConnectorApi, 1),
        "worker_a",
    );

    let summary = runtime
        .run_ready_once(&task_user, &task_workspace, time::OffsetDateTime::now_utc())
        .unwrap();
    let task = runtime
        .store()
        .get_task(
            &TaskId::new("capability.task.denied"),
            &task_user,
            &task_workspace,
        )
        .unwrap()
        .unwrap();

    assert_eq!(summary.failed_retryable, 1);
    assert_eq!(task.status, TaskStatus::WaitingTime);
    assert_eq!(
        task.blocked_reason.as_deref(),
        Some("managed_cloud_not_allowed:composio")
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
