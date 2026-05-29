use local_first_task_runtime::{
    TaskId, TaskRecord, TaskRuntimeError, TaskStore, UserId, WorkspaceId,
};

#[test]
fn dependency_outputs_resolve_latest_completed_output() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user");
    let workspace = WorkspaceId::new("workspace");
    let parent = TaskRecord::new(
        "step_1",
        user.clone(),
        workspace.clone(),
        "capability.browser.browser.open",
        "Open train site",
        serde_json::json!({}),
    );
    let child = TaskRecord::new(
        "step_2",
        user.clone(),
        workspace.clone(),
        "capability.browser.browser.snapshot",
        "Read train results",
        serde_json::json!({}),
    );
    store.insert_task(&parent).unwrap();
    store.insert_task(&child).unwrap();
    store
        .add_dependency(&child.task_id, &parent.task_id, &user, &workspace)
        .unwrap();
    store
        .append_checkpoint(
            &parent.task_id,
            &user,
            &workspace,
            serde_json::json!({
                "kind": "executor_completed",
                "output": {"url": "https://example.test/results"}
            }),
            serde_json::json!({
                "kind": "executor_completed",
                "output": {"url": "https://example.test/results"}
            }),
        )
        .unwrap();

    let outputs = store
        .dependency_outputs_for(&child.task_id, &user, &workspace)
        .unwrap();

    assert_eq!(outputs.len(), 1);
    assert_eq!(outputs[0].task_id, TaskId::new("step_1"));
    assert_eq!(outputs[0].output["url"], "https://example.test/results");
    assert_eq!(
        outputs[0].redacted_output["url"],
        "https://example.test/results"
    );
}

#[test]
fn dependency_outputs_fail_when_dependency_has_no_checkpoint() {
    let store = TaskStore::open_in_memory().unwrap();
    let user = UserId::new("user");
    let workspace = WorkspaceId::new("workspace");
    let parent = TaskRecord::new(
        "step_1",
        user.clone(),
        workspace.clone(),
        "capability.browser.browser.open",
        "Open train site",
        serde_json::json!({}),
    );
    let child = TaskRecord::new(
        "step_2",
        user.clone(),
        workspace.clone(),
        "capability.browser.browser.snapshot",
        "Read train results",
        serde_json::json!({}),
    );
    store.insert_task(&parent).unwrap();
    store.insert_task(&child).unwrap();
    store
        .add_dependency(&child.task_id, &parent.task_id, &user, &workspace)
        .unwrap();

    let error = store
        .dependency_outputs_for(&child.task_id, &user, &workspace)
        .unwrap_err();

    assert!(
        matches!(error, TaskRuntimeError::Store(message) if message.contains("dependency_output_missing:step_1"))
    );
}
