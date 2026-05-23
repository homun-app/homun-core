use local_first_task_runtime::{
    LeaseManager, ResourceClass, ResourceGovernor, ResourceLimits, ResourceRequirement, TaskId,
    TaskRecord, TaskStatus, TaskStore, UserId, WorkspaceId,
};
use serde_json::json;
use time::{Duration, OffsetDateTime};

#[test]
fn lease_manager_acquires_and_heartbeats_a_task() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    store
        .insert_task(&task("task_1", &user, &workspace))
        .unwrap();
    let manager = LeaseManager::new(Duration::minutes(5));
    let now = OffsetDateTime::now_utc();

    assert!(
        manager
            .acquire(
                &store,
                &TaskId::new("task_1"),
                &user,
                &workspace,
                "worker_a",
                now
            )
            .unwrap()
    );
    manager
        .heartbeat(
            &store,
            &TaskId::new("task_1"),
            &user,
            &workspace,
            "worker_a",
            now + Duration::minutes(1),
        )
        .unwrap();
    let leased = store
        .get_task(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(leased.status, TaskStatus::Running);
    assert_eq!(leased.lease_owner.as_deref(), Some("worker_a"));
    assert_eq!(leased.last_heartbeat_at, Some(now + Duration::minutes(1)));
    assert_eq!(leased.lease_expires_at, Some(now + Duration::minutes(6)));
}

#[test]
fn lease_manager_prevents_duplicate_execution() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    store
        .insert_task(&task("task_1", &user, &workspace))
        .unwrap();
    let manager = LeaseManager::new(Duration::minutes(5));
    let now = OffsetDateTime::now_utc();

    assert!(
        manager
            .acquire(
                &store,
                &TaskId::new("task_1"),
                &user,
                &workspace,
                "worker_a",
                now
            )
            .unwrap()
    );
    assert!(
        !manager
            .acquire(
                &store,
                &TaskId::new("task_1"),
                &user,
                &workspace,
                "worker_b",
                now + Duration::minutes(1),
            )
            .unwrap()
    );
}

#[test]
fn lease_recovery_requeues_stale_running_tasks_and_releases_resources() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let task = task("task_1", &user, &workspace)
        .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1));
    store.insert_task(&task).unwrap();
    let governor =
        ResourceGovernor::new(ResourceLimits::new().with_limit(ResourceClass::LlmInference, 1));
    let manager = LeaseManager::new(Duration::minutes(5));
    let now = OffsetDateTime::now_utc();

    manager
        .acquire(
            &store,
            &TaskId::new("task_1"),
            &user,
            &workspace,
            "worker_a",
            now,
        )
        .unwrap();
    let leased = store
        .get_task(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();
    governor.reserve(&store, &leased, "worker_a").unwrap();
    assert_eq!(
        store
            .resource_usage(&user, &workspace, ResourceClass::LlmInference)
            .unwrap(),
        1
    );

    let recovered = manager
        .recover_stale_leases(&store, &user, &workspace, now + Duration::minutes(6))
        .unwrap();
    let reloaded = store
        .get_task(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(recovered, vec![TaskId::new("task_1")]);
    assert_eq!(reloaded.status, TaskStatus::Queued);
    assert_eq!(reloaded.lease_owner, None);
    assert_eq!(
        store
            .resource_usage(&user, &workspace, ResourceClass::LlmInference)
            .unwrap(),
        0
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
