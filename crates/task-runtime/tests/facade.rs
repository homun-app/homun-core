use local_first_task_runtime::{
    ExecutorResult, FakeTaskExecutor, ResourceClass, ResourceLimits, ResourceRequirement, TaskId,
    TaskRecord, TaskRuntime, TaskStatus, TaskStore, UserId, WorkspaceId,
};
use serde_json::json;
use time::{Duration, OffsetDateTime};

#[test]
fn task_runtime_completes_ready_task_and_releases_resources() {
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let store = TaskStore::open_in_memory().unwrap();
    let task = task("task_1", &user, &workspace)
        .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1));
    store.insert_task(&task).unwrap();
    let executor = FakeTaskExecutor::new(vec![ExecutorResult::Completed {
        output: json!({"ok": true}),
    }]);
    let mut runtime = TaskRuntime::new(
        store,
        Box::new(executor),
        ResourceLimits::new().with_limit(ResourceClass::LlmInference, 1),
        "worker_a",
    );

    let summary = runtime
        .run_ready_once(&user, &workspace, OffsetDateTime::now_utc())
        .unwrap();
    let reloaded = runtime
        .store()
        .get_task(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(summary.completed, 1);
    assert_eq!(reloaded.status, TaskStatus::Completed);
    assert_eq!(reloaded.lease_owner, None);
    assert_eq!(
        runtime
            .store()
            .resource_usage(&user, &workspace, ResourceClass::LlmInference)
            .unwrap(),
        0
    );
}

#[test]
fn task_runtime_records_checkpoint_and_requeues_task() {
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let store = TaskStore::open_in_memory().unwrap();
    store
        .insert_task(&task("task_1", &user, &workspace))
        .unwrap();
    let executor = FakeTaskExecutor::new(vec![ExecutorResult::Checkpoint {
        payload: json!({"step": "raw"}),
        redacted_payload: json!({"step": "redacted"}),
    }]);
    let mut runtime =
        TaskRuntime::new(store, Box::new(executor), ResourceLimits::new(), "worker_a");

    let summary = runtime
        .run_ready_once(&user, &workspace, OffsetDateTime::now_utc())
        .unwrap();
    let reloaded = runtime
        .store()
        .get_task(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();
    let checkpoint = runtime
        .store()
        .latest_checkpoint(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(summary.checkpointed, 1);
    assert_eq!(reloaded.status, TaskStatus::Queued);
    assert_eq!(checkpoint.redacted_payload, json!({"step": "redacted"}));
}

#[test]
fn task_runtime_waits_for_time_or_user_approval() {
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let now = OffsetDateTime::now_utc();
    let store = TaskStore::open_in_memory().unwrap();
    store
        .insert_task(&task("wait_time", &user, &workspace))
        .unwrap();
    store
        .insert_task(&task("approval", &user, &workspace))
        .unwrap();
    let executor = FakeTaskExecutor::new(vec![
        ExecutorResult::WaitUntil {
            not_before: now + Duration::minutes(10),
            reason: "slot not available".to_string(),
        },
        ExecutorResult::NeedsApproval {
            action: "submit booking form".to_string(),
            risk_level: "high".to_string(),
            data_boundary: "local".to_string(),
            explanation: "Submit booking".to_string(),
        },
    ]);
    let mut runtime =
        TaskRuntime::new(store, Box::new(executor), ResourceLimits::new(), "worker_a");

    let summary = runtime.run_ready_once(&user, &workspace, now).unwrap();
    let waiting = runtime
        .store()
        .get_task(&TaskId::new("wait_time"), &user, &workspace)
        .unwrap()
        .unwrap();
    let approval = runtime
        .store()
        .get_task(&TaskId::new("approval"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(summary.waiting, 2);
    assert_eq!(waiting.status, TaskStatus::WaitingTime);
    assert_eq!(waiting.not_before, Some(now + Duration::minutes(10)));
    assert_eq!(approval.status, TaskStatus::WaitingUserApproval);
}

#[test]
fn task_runtime_records_retryable_failure() {
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let store = TaskStore::open_in_memory().unwrap();
    let task = task("task_1", &user, &workspace).with_retry_policy(
        local_first_task_runtime::RetryPolicy {
            max_attempts: 2,
            backoff_seconds: 30,
        },
    );
    store.insert_task(&task).unwrap();
    let executor = FakeTaskExecutor::new(vec![ExecutorResult::RetryableFailure {
        reason: "network timeout".to_string(),
    }]);
    let mut runtime =
        TaskRuntime::new(store, Box::new(executor), ResourceLimits::new(), "worker_a");
    let now = OffsetDateTime::now_utc();

    let summary = runtime.run_ready_once(&user, &workspace, now).unwrap();
    let reloaded = runtime
        .store()
        .get_task(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(summary.failed_retryable, 1);
    assert_eq!(reloaded.status, TaskStatus::WaitingTime);
    assert_eq!(reloaded.not_before, Some(now + Duration::seconds(30)));
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
