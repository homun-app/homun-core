use local_first_task_runtime::{
    ResourceClass, ResourceRequirement, TaskId, TaskPriority, TaskRecord, TaskStatus, TaskStore,
    UserId, WorkspaceId,
};
use serde_json::json;

#[test]
fn store_creates_schema_and_migrations_are_idempotent() {
    let store = TaskStore::open_in_memory().unwrap();
    assert_eq!(store.schema_version().unwrap(), 3);
    store.run_migrations().unwrap();
    assert_eq!(store.schema_version().unwrap(), 3);
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

#[test]
fn automation_runs_record_recent_and_retention() {
    use time::OffsetDateTime;
    let store = TaskStore::open_in_memory().unwrap();
    let base = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();

    // Record an ok, a late, and a failed run.
    store
        .record_automation_run("auto_x", base, true, false, None)
        .unwrap();
    store
        .record_automation_run(
            "auto_x",
            base + time::Duration::minutes(1),
            true,
            true,
            None,
        )
        .unwrap();
    store
        .record_automation_run(
            "auto_x",
            base + time::Duration::minutes(2),
            false,
            false,
            Some("boom"),
        )
        .unwrap();

    let runs = store.recent_automation_runs("auto_x", 10).unwrap();
    assert_eq!(runs.len(), 3);
    // Newest first: the failed run.
    assert!(!runs[0].ok);
    assert_eq!(runs[0].detail.as_deref(), Some("boom"));
    assert!(runs[1].late);
    assert!(runs[2].ok && !runs[2].late);

    // Scope isolation: another automation has its own history.
    assert!(
        store
            .recent_automation_runs("auto_y", 10)
            .unwrap()
            .is_empty()
    );

    // Retention: keep at most 50 per automation.
    for i in 0..60i64 {
        store
            .record_automation_run(
                "auto_z",
                base + time::Duration::seconds(i),
                true,
                false,
                None,
            )
            .unwrap();
    }
    assert_eq!(
        store.recent_automation_runs("auto_z", 100).unwrap().len(),
        50
    );
}

#[test]
fn automation_event_dedup_is_scoped_per_rule() {
    use time::OffsetDateTime;
    let store = TaskStore::open_in_memory().unwrap();
    let now = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();

    assert!(
        store
            .mark_automation_event_seen("auto_a", "whatsapp:message:42", now)
            .unwrap()
    );
    assert!(
        !store
            .mark_automation_event_seen("auto_a", "whatsapp:message:42", now)
            .unwrap()
    );
    assert!(
        store
            .mark_automation_event_seen("auto_b", "whatsapp:message:42", now)
            .unwrap()
    );
}
