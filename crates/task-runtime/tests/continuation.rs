use local_first_execution_protocol::{
    ContinuationRef, ExecutionContract, ExecutionOutcome, ExecutionScope,
    ValidatedExecutionContract, ValidatedExecutionOutcome,
};
use local_first_task_runtime::{ContinueAsNewCommit, TaskStore};
use serde_json::json;

fn contract(execution_id: &str) -> ValidatedExecutionContract {
    ValidatedExecutionContract::try_from(ExecutionContract::new(
        execution_id,
        "agent_loop",
        ExecutionScope {
            user_id: "user-1".into(),
            workspace_id: "workspace-1".into(),
            thread_id: Some("thread-1".into()),
        },
        json!({"history": [1, 2, 3]}),
    ))
    .unwrap()
}

#[test]
fn continue_as_new_completes_parent_and_creates_linked_child_atomically() {
    let store = TaskStore::open_in_memory().unwrap();
    let parent = contract("execution-parent");
    store.create_execution(&parent).unwrap();
    let outcome = ValidatedExecutionOutcome::new(
        ExecutionOutcome::Completed {
            output: json!({"compacted": true}),
            continuation: Some(ContinuationRef {
                execution_id: "execution-child".into(),
            }),
        },
        &parent,
    )
    .unwrap();
    let mut child = parent.as_ref().clone();
    child.execution_id = "execution-child".into();
    child.parent_execution_id = Some("execution-parent".into());
    child.input = json!({"history": ["compacted"]});
    let child = ValidatedExecutionContract::try_from(child).unwrap();

    let committed = store.continue_execution_as_new(&outcome, &child).unwrap();
    assert!(matches!(committed, ContinueAsNewCommit::Inserted { .. }));
    let parent_record = store.execution("execution-parent").unwrap().unwrap();
    assert!(matches!(
        parent_record.outcome.unwrap().as_ref(),
        ExecutionOutcome::Completed {
            continuation: Some(ContinuationRef { execution_id }),
            ..
        } if execution_id == "execution-child"
    ));
    let child_record = store.execution("execution-child").unwrap().unwrap();
    assert_eq!(
        child_record
            .contract
            .as_ref()
            .parent_execution_id
            .as_deref(),
        Some("execution-parent")
    );
    assert!(child_record.outcome.is_none());

    assert!(matches!(
        store.continue_execution_as_new(&outcome, &child).unwrap(),
        ContinueAsNewCommit::Existing { .. }
    ));
}

#[test]
fn continue_as_new_rejects_divergent_lineage_without_completing_parent() {
    let store = TaskStore::open_in_memory().unwrap();
    let parent = contract("execution-parent");
    store.create_execution(&parent).unwrap();
    let outcome = ValidatedExecutionOutcome::new(
        ExecutionOutcome::Completed {
            output: json!({}),
            continuation: Some(ContinuationRef {
                execution_id: "execution-child".into(),
            }),
        },
        &parent,
    )
    .unwrap();
    let mut child = parent.as_ref().clone();
    child.execution_id = "execution-child".into();
    child.parent_execution_id = Some("different-parent".into());
    let child = ValidatedExecutionContract::try_from(child).unwrap();

    assert!(store.continue_execution_as_new(&outcome, &child).is_err());
    assert!(
        store
            .execution("execution-parent")
            .unwrap()
            .unwrap()
            .outcome
            .is_none()
    );
    assert!(store.execution("execution-child").unwrap().is_none());
}
