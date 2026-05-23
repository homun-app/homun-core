use local_first_task_runtime::{
    ResourceClass, ResourceGovernor, ResourceLimits, ResourceRequirement, TaskId, TaskRecord,
    TaskStatus, TaskStore, UserId, WorkspaceId,
};
use serde_json::json;

#[test]
fn resource_governor_reserves_and_releases_limited_resources() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let first = task("first", &user, &workspace)
        .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1));
    let second = task("second", &user, &workspace)
        .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1));
    store.insert_task(&first).unwrap();
    store.insert_task(&second).unwrap();
    let governor =
        ResourceGovernor::new(ResourceLimits::new().with_limit(ResourceClass::LlmInference, 1));

    assert!(governor.can_start(&store, &first).unwrap());
    governor.reserve(&store, &first, "worker_a").unwrap();
    assert!(!governor.can_start(&store, &second).unwrap());

    governor.release(&store, &first).unwrap();
    assert!(governor.can_start(&store, &second).unwrap());
}

#[test]
fn resource_governor_marks_task_waiting_resource_with_reason() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let running = task("running", &user, &workspace)
        .with_resource(ResourceRequirement::new(ResourceClass::BrowserSession, 1));
    let blocked = task("blocked", &user, &workspace)
        .with_resource(ResourceRequirement::new(ResourceClass::BrowserSession, 1));
    store.insert_task(&running).unwrap();
    store.insert_task(&blocked).unwrap();
    let governor =
        ResourceGovernor::new(ResourceLimits::new().with_limit(ResourceClass::BrowserSession, 1));

    governor.reserve(&store, &running, "worker_a").unwrap();
    governor
        .mark_waiting_if_unavailable(&store, &blocked)
        .unwrap();
    let reloaded = store
        .get_task(&TaskId::new("blocked"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(reloaded.status, TaskStatus::WaitingResource);
    assert_eq!(
        reloaded.blocked_reason.as_deref(),
        Some("resource browser_session requires 1 units but only 0 available")
    );
}

#[test]
fn resource_governor_tracks_multiple_resource_classes() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let indexing = task("graph", &user, &workspace)
        .with_resource(ResourceRequirement::new(ResourceClass::GraphIndexing, 1));
    let connector = task("connector", &user, &workspace)
        .with_resource(ResourceRequirement::new(ResourceClass::ConnectorApi, 2));
    store.insert_task(&indexing).unwrap();
    store.insert_task(&connector).unwrap();
    let governor = ResourceGovernor::new(
        ResourceLimits::new()
            .with_limit(ResourceClass::GraphIndexing, 1)
            .with_limit(ResourceClass::ConnectorApi, 2),
    );

    governor.reserve(&store, &indexing, "worker_a").unwrap();
    governor.reserve(&store, &connector, "worker_b").unwrap();

    assert_eq!(
        store
            .resource_usage(&user, &workspace, ResourceClass::GraphIndexing)
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .resource_usage(&user, &workspace, ResourceClass::ConnectorApi)
            .unwrap(),
        2
    );
}

fn task(id: &str, user: &UserId, workspace: &WorkspaceId) -> TaskRecord {
    TaskRecord::new(
        id,
        user.clone(),
        workspace.clone(),
        "test.task",
        format!("Run {id}"),
        json!({}),
    )
}
