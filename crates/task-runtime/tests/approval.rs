use local_first_task_runtime::{
    ApprovalGate, ApprovalStatus, TaskId, TaskRecord, TaskStatus, TaskStore, UserId, WorkspaceId,
};
use serde_json::json;

#[test]
fn approval_gate_moves_high_risk_task_to_waiting_user_approval() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    store
        .insert_task(&task("task_1", &user, &workspace))
        .unwrap();
    let gate = ApprovalGate::new();

    let approval = gate
        .request_approval(
            &store,
            &TaskId::new("task_1"),
            &user,
            &workspace,
            "submit booking form",
            "high",
            "local",
            "Submit the appointment booking form",
        )
        .unwrap();
    let reloaded = store
        .get_task(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(approval.status, ApprovalStatus::Pending);
    assert_eq!(reloaded.status, TaskStatus::WaitingUserApproval);
    assert_eq!(
        reloaded.blocked_reason.as_deref(),
        Some("approval required: submit booking form")
    );
}

#[test]
fn approval_gate_approves_task_back_to_queue() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    store
        .insert_task(&task("task_1", &user, &workspace))
        .unwrap();
    let gate = ApprovalGate::new();
    let approval = gate
        .request_approval(
            &store,
            &TaskId::new("task_1"),
            &user,
            &workspace,
            "send message",
            "high",
            "managed_cloud",
            "Send the prepared message",
        )
        .unwrap();

    gate.approve(&store, &approval.approval_id, "user_1")
        .unwrap();
    let approved = store
        .latest_approval(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();
    let task = store
        .get_task(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(approved.status, ApprovalStatus::Approved);
    assert_eq!(approved.approver_id.as_deref(), Some("user_1"));
    assert_eq!(task.status, TaskStatus::Queued);
    assert_eq!(task.blocked_reason, None);
}

#[test]
fn approval_gate_rejects_task_without_execution() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    store
        .insert_task(&task("task_1", &user, &workspace))
        .unwrap();
    let gate = ApprovalGate::new();
    let approval = gate
        .request_approval(
            &store,
            &TaskId::new("task_1"),
            &user,
            &workspace,
            "delete remote card",
            "critical",
            "managed_cloud",
            "Delete a remote project card",
        )
        .unwrap();

    gate.reject(&store, &approval.approval_id, "user_1", "not safe")
        .unwrap();
    let rejected = store
        .latest_approval(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();
    let task = store
        .get_task(&TaskId::new("task_1"), &user, &workspace)
        .unwrap()
        .unwrap();

    assert_eq!(rejected.status, ApprovalStatus::Rejected);
    assert_eq!(task.status, TaskStatus::Cancelled);
    assert_eq!(
        task.blocked_reason.as_deref(),
        Some("approval rejected: not safe")
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
