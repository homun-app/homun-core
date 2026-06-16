use local_first_task_runtime::{
    ResourceClass, ResourceRequirement, TaskId, TaskPriority, TaskRecord, TaskStatus, TaskStore,
    UserId, WorkspaceId,
};
use serde_json::json;

#[test]
fn store_creates_schema_and_migrations_are_idempotent() {
    let store = TaskStore::open_in_memory().unwrap();
    assert_eq!(store.schema_version().unwrap(), 2);
    store.run_migrations().unwrap();
    assert_eq!(store.schema_version().unwrap(), 2);
}

#[test]
fn store_inserts_loads_and_updates_task_status() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let task = TaskRecord::new(
        "task_1",
        user.clone(),
        workspace.clone(),
        "capability.call",
        "Read assigned cards",
        json!({"provider": "trello"}),
    )
    .with_priority(TaskPriority::Critical)
    .with_resource(ResourceRequirement::new(ResourceClass::ConnectorApi, 1));

    store.insert_task(&task).unwrap();
    let loaded = store
        .get_task(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(loaded.task_id, task.task_id);
    assert_eq!(loaded.priority, TaskPriority::Critical);
    assert_eq!(loaded.resource_requirements, task.resource_requirements);
    assert_eq!(loaded.input_json, json!({"provider": "trello"}));

    store
        .update_task_status(
            &TaskId::new("task_1"),
            &user,
            &workspace,
            TaskStatus::WaitingResource,
            Some("connector_api capacity exhausted"),
        )
        .unwrap();

    let updated = store
        .get_task(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();
    assert_eq!(updated.status, TaskStatus::WaitingResource);
    assert_eq!(
        updated.blocked_reason.as_deref(),
        Some("connector_api capacity exhausted")
    );
    assert!(updated.updated_at >= loaded.updated_at);
}

#[test]
fn store_isolates_tasks_by_user_and_workspace() {
    let store = TaskStore::open_in_memory().unwrap();
    let task = TaskRecord::new(
        "task_1",
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        "memory.maintenance",
        "Rebuild search index",
        json!({}),
    );
    store.insert_task(&task).unwrap();

    assert!(
        store
            .get_task(
                &TaskId::new("task_1"),
                &UserId::new("user_2"),
                &WorkspaceId::new("workspace_1"),
            )
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .get_task(
                &TaskId::new("task_1"),
                &UserId::new("user_1"),
                &WorkspaceId::new("workspace_2"),
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn store_lists_tasks_for_user_workspace_in_creation_order() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    store
        .insert_task(&TaskRecord::new(
            "task_1",
            user.clone(),
            workspace.clone(),
            "kind",
            "First",
            json!({}),
        ))
        .unwrap();
    store
        .insert_task(&TaskRecord::new(
            "task_2",
            user.clone(),
            workspace.clone(),
            "kind",
            "Second",
            json!({}),
        ))
        .unwrap();
    store
        .insert_task(&TaskRecord::new(
            "task_other",
            UserId::new("user_2"),
            workspace.clone(),
            "kind",
            "Other",
            json!({}),
        ))
        .unwrap();

    let tasks = store.list_tasks(&user, &workspace).unwrap();
    let ids = tasks
        .iter()
        .map(|task| task.task_id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["task_1", "task_2"]);
}
