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
fn task_runtime_materializes_next_recurrence_after_completion() {
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let store = TaskStore::open_in_memory().unwrap();
    let now = OffsetDateTime::now_utc();
    let recurring = task("daily", &user, &workspace).with_recurrence("every 1d", None);
    store.insert_task(&recurring).unwrap();
    let executor = FakeTaskExecutor::new(vec![ExecutorResult::Completed {
        output: json!({"ok": true}),
    }]);
    let mut runtime = TaskRuntime::new(
        store,
        Box::new(executor),
        ResourceLimits::new().with_limit(ResourceClass::LlmInference, 1),
        "worker_a",
    );

    let summary = runtime.run_ready_once(&user, &workspace, now).unwrap();
    let tasks = runtime.store().list_tasks(&user, &workspace).unwrap();
    let next = tasks
        .iter()
        .find(|task| task.task_id.as_str().starts_with("daily@occ@"))
        .expect("next recurring occurrence inserted");

    assert_eq!(summary.completed, 1);
    assert_eq!(next.status, TaskStatus::Queued);
    assert_eq!(next.recurrence.as_deref(), Some("every 1d"));
    assert!(next.not_before.expect("next occurrence time") > now);
}

#[test]
fn task_runtime_requeues_waiting_resource_before_scheduling() {
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let store = TaskStore::open_in_memory().unwrap();
    let running = task("running", &user, &workspace)
        .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1));
    let blocked = task("blocked", &user, &workspace)
        .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1));
    store.insert_task(&running).unwrap();
    store.insert_task(&blocked).unwrap();
    let governor =
        local_first_task_runtime::ResourceGovernor::new(
            ResourceLimits::new().with_limit(ResourceClass::LlmInference, 1),
        );

    governor.reserve(&store, &running, "worker_a").unwrap();
    governor
        .mark_waiting_if_unavailable(&store, &blocked)
        .unwrap();
    store
        .update_task_status(
            &running.task_id,
            &user,
            &workspace,
            TaskStatus::Completed,
            None,
        )
        .unwrap();
    governor.release(&store, &running).unwrap();

    let executor = FakeTaskExecutor::new(vec![ExecutorResult::Completed {
        output: json!({"ok": true}),
    }]);
    let mut runtime = TaskRuntime::new(
        store,
        Box::new(executor),
        ResourceLimits::new().with_limit(ResourceClass::LlmInference, 1),
        "worker_b",
    );

    let summary = runtime
        .run_ready_once(&user, &workspace, OffsetDateTime::now_utc())
        .unwrap();
    let reloaded = runtime
        .store()
        .get_task(&TaskId::new("blocked"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(summary.completed, 1);
    assert_eq!(reloaded.status, TaskStatus::Completed);
}

#[test]
fn task_runtime_recovers_resource_wait_across_worker_connections() {
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let path = std::env::temp_dir().join(format!(
        "homun-task-runtime-{}.sqlite",
        uuid::Uuid::new_v4()
    ));

    let seed = TaskStore::open(&path).unwrap();
    let running = task("running", &user, &workspace)
        .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1));
    let blocked = task("blocked", &user, &workspace)
        .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1));
    seed.insert_task(&running).unwrap();
    seed.insert_task(&blocked).unwrap();
    drop(seed);

    let owner_store = TaskStore::open(&path).unwrap();
    let governor =
        local_first_task_runtime::ResourceGovernor::new(
            ResourceLimits::new().with_limit(ResourceClass::LlmInference, 1),
        );
    let now = OffsetDateTime::now_utc();
    local_first_task_runtime::LeaseManager::new(Duration::minutes(5))
        .acquire(
            &owner_store,
            &running.task_id,
            &user,
            &workspace,
            "worker_a",
            now,
        )
        .unwrap();
    let leased = owner_store
        .get_task(&running.task_id, &user, &workspace)
        .unwrap()
        .unwrap();
    governor.reserve(&owner_store, &leased, "worker_a").unwrap();

    let executor = FakeTaskExecutor::new(vec![ExecutorResult::Completed {
        output: json!({"ok": true}),
    }]);
    let mut worker_b = TaskRuntime::new(
        TaskStore::open(&path).unwrap(),
        Box::new(executor),
        ResourceLimits::new().with_limit(ResourceClass::LlmInference, 1),
        "worker_b",
    );

    let first = worker_b.run_ready_once(&user, &workspace, now).unwrap();
    let blocked_waiting = worker_b
        .store()
        .get_task(&TaskId::new("blocked"), &user, &workspace)
        .unwrap()
        .unwrap();
    assert_eq!(first.completed, 0);
    assert_eq!(first.skipped, 1);
    assert_eq!(blocked_waiting.status, TaskStatus::WaitingResource);

    owner_store
        .update_task_status(&running.task_id, &user, &workspace, TaskStatus::Completed, None)
        .unwrap();
    governor.release(&owner_store, &leased).unwrap();

    let second = worker_b
        .run_ready_once(&user, &workspace, now + Duration::seconds(1))
        .unwrap();
    let reloaded = worker_b
        .store()
        .get_task(&TaskId::new("blocked"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(second.completed, 1);
    assert_eq!(reloaded.status, TaskStatus::Completed);
    assert_eq!(
        worker_b
            .store()
            .resource_usage(&user, &workspace, ResourceClass::LlmInference)
            .unwrap(),
        0
    );

    drop(worker_b);
    drop(owner_store);
    let _ = std::fs::remove_file(path);
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

#[test]
fn task_runtime_materializes_next_recurrence_after_terminal_failure() {
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let store = TaskStore::open_in_memory().unwrap();
    let now = OffsetDateTime::now_utc();
    let task = task("daily", &user, &workspace)
        .with_recurrence("every 1d", None)
        .with_retry_policy(local_first_task_runtime::RetryPolicy {
            max_attempts: 1,
            backoff_seconds: 30,
        });
    store.insert_task(&task).unwrap();
    let executor = FakeTaskExecutor::new(vec![ExecutorResult::RetryableFailure {
        reason: "network timeout".to_string(),
    }]);
    let mut runtime =
        TaskRuntime::new(store, Box::new(executor), ResourceLimits::new(), "worker_a");

    let summary = runtime.run_ready_once(&user, &workspace, now).unwrap();
    let failed = runtime
        .store()
        .get_task(&TaskId::new("daily"), &user, &workspace)
        .unwrap()
        .unwrap();
    let tasks = runtime.store().list_tasks(&user, &workspace).unwrap();
    let next = tasks
        .iter()
        .find(|task| task.task_id.as_str().starts_with("daily@occ@"))
        .expect("next recurring occurrence inserted after terminal failure");

    assert_eq!(summary.failed_retryable, 1);
    assert_eq!(failed.status, TaskStatus::Failed);
    assert_eq!(next.status, TaskStatus::Queued);
    assert_eq!(next.recurrence.as_deref(), Some("every 1d"));
    assert!(next.not_before.expect("next occurrence time") > now);
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
