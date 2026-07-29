use local_first_execution_protocol::{
    EffectClass, EffectReceiptRef, EffectReceiptStatus, ExecutionContract, ExecutionOutcome,
    ExecutionScope, ValidatedExecutionContract, ValidatedExecutionOutcome,
};
use local_first_task_runtime::{NewExecutionEffectReceipt, TaskStore};
use serde_json::json;

fn contract(execution_id: &str, parent: Option<&str>) -> ValidatedExecutionContract {
    let mut contract = ExecutionContract::new(
        execution_id,
        "external_workflow",
        ExecutionScope {
            user_id: "user-1".into(),
            workspace_id: "workspace-1".into(),
            thread_id: Some("thread-1".into()),
        },
        json!({}),
    );
    contract.parent_execution_id = parent.map(str::to_string);
    ValidatedExecutionContract::try_from(contract).unwrap()
}

fn complete_receipt(store: &TaskStore, store_id: &str, order: u8) -> EffectReceiptRef {
    let receipt_ref = EffectReceiptRef::from_store_id(store_id).unwrap();
    store
        .prepare_effect_receipt(&NewExecutionEffectReceipt {
            receipt_ref: receipt_ref.clone(),
            execution_id: "workflow-1".into(),
            revision: 1,
            run_id: None,
            thread_id: Some("thread-1".into()),
            user_id: "user-1".into(),
            workspace_id: "workspace-1".into(),
            effect_class: EffectClass::ExternalWrite,
            operation: format!("step-{order}"),
            arguments_hash: format!("hash-{order}"),
            idempotency_key: format!("step-{order}"),
            compensation: Some(json!({"operation": format!("undo-{order}")})),
        })
        .unwrap();
    store.claim_effect_receipt(&receipt_ref).unwrap();
    store
        .complete_effect_receipt(
            &receipt_ref,
            &json!({"step": order}),
            &json!({"applied": true}),
        )
        .unwrap();
    receipt_ref
}

#[test]
fn compensations_are_planned_in_reverse_and_closed_by_a_completed_child_execution() {
    let store = TaskStore::open_in_memory().unwrap();
    store
        .create_execution(&contract("workflow-1", None))
        .unwrap();
    let first = complete_receipt(&store, "11111111111111111111111111111111", 1);
    let second = complete_receipt(&store, "22222222222222222222222222222222", 2);

    assert_eq!(
        store
            .pending_compensations("workflow-1")
            .unwrap()
            .into_iter()
            .map(|receipt| receipt.receipt_ref)
            .collect::<Vec<_>>(),
        vec![second.clone(), first]
    );

    let compensation = contract("compensation-2", Some("workflow-1"));
    store.create_execution(&compensation).unwrap();
    let outcome = ValidatedExecutionOutcome::new(
        ExecutionOutcome::completed(json!({"undone": true})),
        &compensation,
    )
    .unwrap();
    store.commit_execution_outcome(&outcome).unwrap();

    let compensated = store
        .mark_effect_compensated(&second, "compensation-2")
        .unwrap();
    assert_eq!(compensated.status, EffectReceiptStatus::Compensated);
    assert_eq!(store.pending_compensations("workflow-1").unwrap().len(), 1);
    assert_eq!(
        store
            .mark_effect_compensated(&second, "compensation-2")
            .unwrap()
            .status,
        EffectReceiptStatus::Compensated
    );
}
