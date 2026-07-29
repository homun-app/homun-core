use local_first_execution_protocol::{
    CheckpointDataRef, CheckpointEnvelope, DurableDataRef, EffectClass, EffectReceiptRef,
    EffectReceiptResolution, EffectReceiptStatus, ExecutionContract, ExecutionOutcome,
    ExecutionScope, ExecutionState, ValidatedExecutionContract, ValidatedExecutionOutcome,
    WakeCondition,
};
use local_first_task_runtime::{
    EffectReceiptClaim, ExecutionEffectReceipt, NewExecutionEffectReceipt, TaskStore,
};
use serde_json::json;

const DURABLE_STORE_ID: &str = "0123456789abcdef0123456789abcdef";

fn new_receipt() -> NewExecutionEffectReceipt {
    NewExecutionEffectReceipt {
        receipt_ref: EffectReceiptRef::from_store_id("11111111111111111111111111111111").unwrap(),
        execution_id: "execution-1".into(),
        revision: 1,
        run_id: Some("run-1".into()),
        thread_id: Some("thread-1".into()),
        user_id: "user-1".into(),
        workspace_id: "workspace-1".into(),
        effect_class: EffectClass::ExternalWrite,
        operation: "connector.send".into(),
        arguments_hash: "sha256:abc".into(),
        idempotency_key: "connector.send:abc".into(),
        compensation: Some(json!({"operation": "connector.delete"})),
    }
}

#[test]
fn receipt_is_prepared_claimed_completed_and_replayed() {
    let store = TaskStore::open_in_memory().unwrap();
    let prepared = store.prepare_effect_receipt(&new_receipt()).unwrap();
    assert_eq!(prepared.status, EffectReceiptStatus::Prepared);

    assert!(matches!(
        store.claim_effect_receipt(&prepared.receipt_ref).unwrap(),
        EffectReceiptClaim::Execute(ExecutionEffectReceipt {
            status: EffectReceiptStatus::Started,
            ..
        })
    ));

    let completed = store
        .complete_effect_receipt(
            &prepared.receipt_ref,
            &json!({"remote_id": "msg-1"}),
            &json!({"delivered": true}),
        )
        .unwrap();
    assert_eq!(completed.status, EffectReceiptStatus::Completed);
    assert!(matches!(
        store.claim_effect_receipt(&prepared.receipt_ref).unwrap(),
        EffectReceiptClaim::Replay(ExecutionEffectReceipt {
            status: EffectReceiptStatus::Completed,
            ..
        })
    ));
}

#[test]
fn interrupted_started_receipt_becomes_uncertain_and_never_executes_again() {
    let store = TaskStore::open_in_memory().unwrap();
    let prepared = store.prepare_effect_receipt(&new_receipt()).unwrap();
    assert!(matches!(
        store.claim_effect_receipt(&prepared.receipt_ref).unwrap(),
        EffectReceiptClaim::Execute(_)
    ));

    let uncertain = store.claim_effect_receipt(&prepared.receipt_ref).unwrap();
    assert!(matches!(
        uncertain,
        EffectReceiptClaim::Resolve(ExecutionEffectReceipt {
            status: EffectReceiptStatus::Uncertain,
            ..
        })
    ));
    assert!(matches!(
        store.claim_effect_receipt(&prepared.receipt_ref).unwrap(),
        EffectReceiptClaim::Resolve(ExecutionEffectReceipt {
            status: EffectReceiptStatus::Uncertain,
            ..
        })
    ));
}

fn suspend_for_effect_resolution(store: &TaskStore, receipt_ref: &EffectReceiptRef) {
    let contract = ValidatedExecutionContract::try_from(ExecutionContract::new(
        "execution-1",
        "chat_turn",
        ExecutionScope {
            user_id: "user-1".into(),
            workspace_id: "workspace-1".into(),
            thread_id: Some("thread-1".into()),
        },
        json!({"prompt": "send it"}),
    ))
    .unwrap();
    store.create_execution(&contract).unwrap();
    let outcome = ValidatedExecutionOutcome::new(
        ExecutionOutcome::Suspended {
            wake: WakeCondition::EffectResolution {
                receipt_ref: receipt_ref.clone(),
            },
            checkpoint: CheckpointEnvelope::new(
                "execution-1",
                1,
                "chat_turn",
                1,
                CheckpointDataRef::Public {
                    record_ref: DurableDataRef::from_store_id(DURABLE_STORE_ID).unwrap(),
                },
            ),
        },
        &contract,
    )
    .unwrap();
    store.commit_execution_outcome(&outcome).unwrap();
}

#[test]
fn resolving_uncertain_effect_and_delivering_wake_is_one_transition() {
    let store = TaskStore::open_in_memory().unwrap();
    let prepared = store.prepare_effect_receipt(&new_receipt()).unwrap();
    store.claim_effect_receipt(&prepared.receipt_ref).unwrap();
    store.claim_effect_receipt(&prepared.receipt_ref).unwrap();
    suspend_for_effect_resolution(&store, &prepared.receipt_ref);

    let resolved = store
        .resolve_effect_receipt(
            &prepared.receipt_ref,
            &EffectReceiptResolution::Applied {
                result: json!({"remote_id": "msg-1"}),
                effects: json!({"delivered": true}),
            },
        )
        .unwrap();

    assert_eq!(resolved.status, EffectReceiptStatus::Completed);
    let execution = store.execution("execution-1").unwrap().unwrap();
    assert_eq!(execution.state, ExecutionState::Ready);
    assert_eq!(execution.contract.as_ref().revision, 2);
    assert_eq!(
        execution.contract.as_ref().wake.as_ref().unwrap().payload,
        json!({
            "resolution": {
                "type": "applied",
                "result": {"remote_id": "msg-1"},
                "effects": {"delivered": true}
            },
            "type": "effect_resolution"
        })
    );

    let replayed = store
        .resolve_effect_receipt(
            &prepared.receipt_ref,
            &EffectReceiptResolution::Applied {
                result: json!({"remote_id": "msg-1"}),
                effects: json!({"delivered": true}),
            },
        )
        .unwrap();
    assert_eq!(replayed, resolved);
}

#[test]
fn not_applied_resolution_records_failure_before_resuming() {
    let store = TaskStore::open_in_memory().unwrap();
    let prepared = store.prepare_effect_receipt(&new_receipt()).unwrap();
    store.claim_effect_receipt(&prepared.receipt_ref).unwrap();
    store.claim_effect_receipt(&prepared.receipt_ref).unwrap();
    suspend_for_effect_resolution(&store, &prepared.receipt_ref);

    let resolved = store
        .resolve_effect_receipt(
            &prepared.receipt_ref,
            &EffectReceiptResolution::NotApplied {
                error: json!({"code": "verified_absent"}),
            },
        )
        .unwrap();

    assert_eq!(resolved.status, EffectReceiptStatus::Failed);
    assert_eq!(
        resolved.error_json,
        Some(json!({"code": "verified_absent"}))
    );
    assert_eq!(
        store
            .execution("execution-1")
            .unwrap()
            .unwrap()
            .contract
            .as_ref()
            .revision,
        2
    );
}
