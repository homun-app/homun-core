use local_first_task_runtime::{
    TaskId, TaskPriority, TaskRecord, TaskScheduler, TaskStatus, TaskStore, UserId, WorkspaceId,
};
use serde_json::json;
use time::{Duration, OffsetDateTime};

#[test]
fn scheduler_selects_ready_tasks_by_priority_and_creation_order() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    store
        .insert_task(&task("task_low", &user, &workspace).with_priority(TaskPriority::Low))
        .unwrap();
    store
        .insert_task(&task("task_high", &user, &workspace).with_priority(TaskPriority::High))
        .unwrap();
    store
        .insert_task(
            &task("task_critical", &user, &workspace).with_priority(TaskPriority::Critical),
        )
        .unwrap();

    let ready = TaskScheduler::new()
        .ready_tasks(&store, &user, &workspace, OffsetDateTime::now_utc(), 10)
        .unwrap();
    let ids = ready
        .iter()
        .map(|task| task.task_id.as_str())
        .collect::<Vec<_>>();

    assert_eq!(ids, vec!["task_critical", "task_high", "task_low"]);
}

#[test]
fn scheduler_skips_tasks_before_not_before_time() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let now = OffsetDateTime::now_utc();
    let mut future = task("future", &user, &workspace);
    future.not_before = Some(now + Duration::hours(1));
    store.insert_task(&future).unwrap();
    store
        .insert_task(&task("ready", &user, &workspace))
        .unwrap();

    let ready = TaskScheduler::new()
        .ready_tasks(&store, &user, &workspace, now, 10)
        .unwrap();

    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task_id.as_str(), "ready");
}

#[test]
fn scheduler_waits_for_dependencies_to_complete() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    store
        .insert_task(&task("parent", &user, &workspace))
        .unwrap();
    store
        .insert_task(&task("child", &user, &workspace))
        .unwrap();
    store
        .add_dependency(
            &TaskId::new("child"),
            &TaskId::new("parent"),
            &user,
            &workspace,
        )
        .unwrap();

    let before_parent = TaskScheduler::new()
        .ready_tasks(&store, &user, &workspace, OffsetDateTime::now_utc(), 10)
        .unwrap();
    assert_eq!(
        before_parent
            .iter()
            .map(|task| task.task_id.as_str())
            .collect::<Vec<_>>(),
        vec!["parent"]
    );

    store
        .update_task_status(
            &TaskId::new("parent"),
            &user,
            &workspace,
            TaskStatus::Completed,
            None,
        )
        .unwrap();
    let after_parent = TaskScheduler::new()
        .ready_tasks(&store, &user, &workspace, OffsetDateTime::now_utc(), 10)
        .unwrap();
    assert_eq!(
        after_parent
            .iter()
            .map(|task| task.task_id.as_str())
            .collect::<Vec<_>>(),
        vec!["child"]
    );
}

#[test]
fn scheduler_marks_dependents_waiting_when_dependency_failed() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    store
        .insert_task(&task("parent", &user, &workspace))
        .unwrap();
    store
        .insert_task(&task("child", &user, &workspace))
        .unwrap();
    store
        .add_dependency(
            &TaskId::new("child"),
            &TaskId::new("parent"),
            &user,
            &workspace,
        )
        .unwrap();
    store
        .update_task_status(
            &TaskId::new("parent"),
            &user,
            &workspace,
            TaskStatus::Failed,
            Some("runtime error"),
        )
        .unwrap();

    TaskScheduler::new()
        .mark_blocked_by_terminal_dependencies(&store, &user, &workspace)
        .unwrap();
    let child = store
        .get_task(&TaskId::new("child"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(child.status, TaskStatus::WaitingExternalEvent);
    assert_eq!(
        child.blocked_reason.as_deref(),
        Some("dependency parent is failed")
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
