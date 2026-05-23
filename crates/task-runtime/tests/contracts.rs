use local_first_task_runtime::{
    ResourceClass, ResourceRequirement, RetryPolicy, TaskPriority, TaskRecord, TaskStatus, UserId,
    WorkspaceId,
};
use serde_json::json;

#[test]
fn task_contract_captures_identity_priority_resources_and_retry_policy() {
    let task = TaskRecord::new(
        "task_1",
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        "subagent.workflow",
        "Summarize project state",
        json!({"project": "acme"}),
    )
    .with_priority(TaskPriority::High)
    .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1))
    .with_resource(ResourceRequirement::new(ResourceClass::NetworkIo, 2))
    .with_retry_policy(RetryPolicy {
        max_attempts: 3,
        backoff_seconds: 30,
    });

    assert_eq!(task.task_id.as_str(), "task_1");
    assert_eq!(task.user_id.as_str(), "user_1");
    assert_eq!(task.workspace_id.as_str(), "workspace_1");
    assert_eq!(task.kind, "subagent.workflow");
    assert_eq!(task.status, TaskStatus::Queued);
    assert_eq!(task.priority, TaskPriority::High);
    assert_eq!(task.resource_requirements.len(), 2);
    assert_eq!(task.retry_policy.max_attempts, 3);
    assert_eq!(task.retry_policy.backoff_seconds, 30);
    assert!(task.workflow_id.is_none());
}

#[test]
fn task_status_and_priority_serialize_as_snake_case() {
    assert_eq!(
        serde_json::to_value(TaskStatus::WaitingUserApproval).unwrap(),
        "waiting_user_approval"
    );
    assert_eq!(
        serde_json::to_value(TaskPriority::Background).unwrap(),
        "background"
    );
    assert_eq!(
        serde_json::to_value(ResourceClass::BrowserSession).unwrap(),
        "browser_session"
    );
}

#[test]
fn local_computer_resources_serialize_for_governance() {
    assert_eq!(
        serde_json::to_value(ResourceClass::ComputerSession).unwrap(),
        "computer_session"
    );
    assert_eq!(
        serde_json::to_value(ResourceClass::ShellProcess).unwrap(),
        "shell_process"
    );
}
