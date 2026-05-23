use local_first_task_runtime::{
    ApprovalGate, ResourceClass, ResourceRequirement, TaskId, TaskRecord, TaskStatus, TaskStore,
    TaskUiReadModel, UserId, WorkspaceId,
};
use serde_json::json;

#[test]
fn ui_read_model_reports_queue_active_blocked_approvals_and_failures() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    store
        .insert_task(&task("queued", &user, &workspace))
        .unwrap();
    let mut active = task("active", &user, &workspace)
        .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1));
    active.status = TaskStatus::Running;
    store.insert_task(&active).unwrap();
    store.reserve_resources(&active, "worker_a").unwrap();
    store
        .insert_task(&task("blocked", &user, &workspace))
        .unwrap();
    store
        .update_task_status(
            &TaskId::new("blocked"),
            &user,
            &workspace,
            TaskStatus::WaitingResource,
            Some("resource llm_inference saturated"),
        )
        .unwrap();
    store
        .insert_task(&task("approval", &user, &workspace))
        .unwrap();
    ApprovalGate::new()
        .request_approval(
            &store,
            &TaskId::new("approval"),
            &user,
            &workspace,
            "send message",
            "high",
            "managed_cloud",
            "Send message",
        )
        .unwrap();
    store
        .insert_task(&task("failed", &user, &workspace))
        .unwrap();
    store
        .update_task_status(
            &TaskId::new("failed"),
            &user,
            &workspace,
            TaskStatus::Failed,
            Some("network timeout"),
        )
        .unwrap();

    let snapshot = TaskUiReadModel::new(&store)
        .queue_snapshot(&user, &workspace)
        .unwrap();

    assert_eq!(snapshot.queued.len(), 1);
    assert_eq!(snapshot.active.len(), 1);
    assert_eq!(snapshot.blocked.len(), 1);
    assert_eq!(snapshot.waiting_approvals.len(), 1);
    assert_eq!(snapshot.recent_failures.len(), 1);
    assert_eq!(
        snapshot.resource_usage.get(&ResourceClass::LlmInference),
        Some(&1)
    );
    assert_eq!(
        snapshot.blocked[0].blocked_reason.as_deref(),
        Some("resource llm_inference saturated")
    );
}

#[test]
fn ui_task_detail_uses_redacted_checkpoint_and_omits_raw_input() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let task = TaskRecord::new(
        "task_1",
        user.clone(),
        workspace.clone(),
        "browser.form",
        "Submit booking",
        json!({"password": "secret"}),
    );
    store.insert_task(&task).unwrap();
    store
        .append_checkpoint(
            &TaskId::new("task_1"),
            &user,
            &workspace,
            json!({"dom": "raw", "token": "secret"}),
            json!({"dom": "summary", "token": "[REDACTED]"}),
        )
        .unwrap();

    let detail = TaskUiReadModel::new(&store)
        .task_detail(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(detail.task_id.as_str(), "task_1");
    assert_eq!(
        detail.latest_checkpoint,
        Some(json!({"dom": "summary", "token": "[REDACTED]"}))
    );
    assert!(!detail.exposes_raw_input);
}

#[test]
fn ui_task_detail_exposes_browser_metadata_without_raw_input() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let task = TaskRecord::new(
        "browser_task_1",
        user.clone(),
        workspace.clone(),
        "browser_automation",
        "Inspect booking page",
        json!({
            "method": "browser.snapshot",
            "params": {
                "target_id": "booking",
                "secret": "raw input must stay hidden"
            }
        }),
    );
    store.insert_task(&task).unwrap();
    store
        .append_checkpoint(
            &TaskId::new("browser_task_1"),
            &user,
            &workspace,
            json!({"snapshot": "raw page text"}),
            json!({
                "browser": {
                    "method": "browser.snapshot",
                    "target_id": "booking",
                    "url": "https://example.test/booking"
                },
                "result": {"snapshot": "summary"}
            }),
        )
        .unwrap();

    let detail = TaskUiReadModel::new(&store)
        .task_detail(&TaskId::new("browser_task_1"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(
        detail.runtime_metadata,
        Some(json!({
            "browser": {
                "method": "browser.snapshot",
                "target_id": "booking",
                "url": "https://example.test/booking"
            }
        }))
    );
    assert!(!detail.exposes_raw_input);
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
