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

#[test]
fn scheduler_expires_tasks_past_their_time_budget() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let now = OffsetDateTime::now_utc();

    let mut past_expires = task("past_expires", &user, &workspace);
    past_expires.expires_at = Some(now - Duration::minutes(1));
    store.insert_task(&past_expires).unwrap();

    let mut past_deadline = task("past_deadline", &user, &workspace);
    past_deadline.deadline = Some(now - Duration::seconds(1));
    store.insert_task(&past_deadline).unwrap();

    let mut healthy = task("healthy", &user, &workspace);
    healthy.deadline = Some(now + Duration::hours(1));
    store.insert_task(&healthy).unwrap();

    let expired = TaskScheduler::new()
        .expire_overdue_tasks(&store, &user, &workspace, now)
        .unwrap();
    assert_eq!(expired, 2);

    for id in ["past_expires", "past_deadline"] {
        let task = store
            .get_task(&TaskId::new(id), &user, &workspace)
            .unwrap()
            .unwrap();
        assert_eq!(task.status, TaskStatus::Expired, "{id} should be expired");
        assert!(task.blocked_reason.is_some());
    }
    let healthy = store
        .get_task(&TaskId::new("healthy"), &user, &workspace)
        .unwrap()
        .unwrap();
    assert_eq!(healthy.status, TaskStatus::Queued);
}

#[test]
fn scheduler_does_not_schedule_overdue_tasks() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let now = OffsetDateTime::now_utc();

    let mut overdue = task("overdue", &user, &workspace);
    overdue.deadline = Some(now - Duration::minutes(5));
    store.insert_task(&overdue).unwrap();
    store.insert_task(&task("ready", &user, &workspace)).unwrap();

    let ready = TaskScheduler::new()
        .ready_tasks(&store, &user, &workspace, now, 10)
        .unwrap();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].task_id.as_str(), "ready");
}

#[test]
fn scheduler_materializes_next_recurring_occurrence() {
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let now = OffsetDateTime::now_utc();
    let completed = task("daily", &user, &workspace).with_recurrence("every 1d", None);

    let next = TaskScheduler::new()
        .next_recurrence(&completed, now)
        .expect("a recurring task yields a next occurrence");

    assert_eq!(next.status, TaskStatus::Queued);
    assert_ne!(next.task_id.as_str(), "daily");
    assert!(next.task_id.as_str().starts_with("daily@occ@"));
    assert_eq!(next.recurrence.as_deref(), Some("every 1d"));
    assert!(next.not_before.expect("not_before set") > now);
    assert_eq!(next.goal, completed.goal);

    // A second materialization strips the prior "@occ@" suffix (ids stay bounded).
    let third = TaskScheduler::new()
        .next_recurrence(&next, now)
        .expect("second occurrence");
    assert!(third.task_id.as_str().starts_with("daily@occ@"));
    assert_eq!(third.task_id.as_str().matches("@occ@").count(), 1);

    // Non-recurring tasks produce nothing.
    let one_shot = task("oneshot", &user, &workspace);
    assert!(TaskScheduler::new().next_recurrence(&one_shot, now).is_none());
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
