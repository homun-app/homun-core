use local_first_task_runtime::{
    RetryController, RetryPolicy, TaskCheckpoint, TaskId, TaskRecord, TaskStatus, TaskStore,
    UserId, WorkspaceId,
};
use serde_json::json;
use time::{Duration, OffsetDateTime};

#[test]
fn store_appends_and_loads_latest_checkpoint_with_redacted_payload() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let task = task("task_1", &user, &workspace);
    store.insert_task(&task).unwrap();

    store
        .append_checkpoint(
            &TaskId::new("task_1"),
            &user,
            &workspace,
            json!({"step": 1, "token": "secret"}),
            json!({"step": 1, "token": "[REDACTED]"}),
        )
        .unwrap();
    let second = store
        .append_checkpoint(
            &TaskId::new("task_1"),
            &user,
            &workspace,
            json!({"step": 2, "password": "secret"}),
            json!({"step": 2, "password": "[REDACTED]"}),
        )
        .unwrap();

    let latest = store
        .latest_checkpoint(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(second.sequence, 2);
    assert_eq!(latest.sequence, 2);
    assert_eq!(latest.payload, json!({"step": 2, "password": "secret"}));
    assert_eq!(
        latest.redacted_payload,
        json!({"step": 2, "password": "[REDACTED]"})
    );
}

#[test]
fn retry_controller_applies_backoff_before_terminal_failure() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let task = task("task_1", &user, &workspace).with_retry_policy(RetryPolicy {
        max_attempts: 2,
        backoff_seconds: 45,
    });
    store.insert_task(&task).unwrap();
    let retry = RetryController::new();
    let now = OffsetDateTime::now_utc();

    retry
        .record_failure(
            &store,
            &TaskId::new("task_1"),
            &user,
            &workspace,
            "transient connector error",
            now,
        )
        .unwrap();
    let waiting = store
        .get_task(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();
    assert_eq!(waiting.status, TaskStatus::WaitingTime);
    assert_eq!(waiting.attempt_count, 1);
    assert_eq!(waiting.not_before, Some(now + Duration::seconds(45)));

    retry
        .record_failure(
            &store,
            &TaskId::new("task_1"),
            &user,
            &workspace,
            "transient connector error",
            now + Duration::seconds(45),
        )
        .unwrap();
    let failed = store
        .get_task(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();
    assert_eq!(failed.status, TaskStatus::Failed);
    assert_eq!(failed.attempt_count, 2);
    assert_eq!(
        failed.blocked_reason.as_deref(),
        Some("transient connector error")
    );
}

#[test]
fn checkpoint_contract_keeps_task_scope() {
    let checkpoint = TaskCheckpoint::new(
        "checkpoint_1",
        TaskId::new("task_1"),
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        1,
        json!({"state": "raw"}),
        json!({"state": "redacted"}),
    );

    assert_eq!(checkpoint.task_id.as_str(), "task_1");
    assert_eq!(checkpoint.user_id.as_str(), "user_1");
    assert_eq!(checkpoint.workspace_id.as_str(), "workspace_1");
    assert_eq!(checkpoint.sequence, 1);
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
