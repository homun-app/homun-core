use local_first_execution_protocol::{
    CheckpointDataRef, CheckpointEnvelope, DurableDataRef, EffectClass, EffectReceiptRef,
    EffectReceiptResolution, EffectReceiptStatus, ExecutionContract, ExecutionOutcome,
    ExecutionScope, ExecutionState, ValidatedExecutionContract, ValidatedExecutionOutcome,
    WakeCondition,
};
use local_first_task_runtime::{
    EffectReceiptClaim, ExecutionEffectReceipt, NewExecutionEffectReceipt, TaskRecord, TaskStatus,
    TaskStore, UserId, WorkspaceId,
};
use serde_json::json;
use time::{Duration, OffsetDateTime};

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

fn running_attempt(store: &TaskStore) -> (ValidatedExecutionContract, String) {
    let now = OffsetDateTime::now_utc();
    let owner = "worker-1".to_string();
    let mut task = TaskRecord::new(
        "execution-1",
        UserId::new("user-1"),
        WorkspaceId::new("workspace-1"),
        "chat_turn",
        "send",
        json!({"thread_id": "thread-1"}),
    );
    task.status = TaskStatus::Running;
    task.lease_owner = Some(owner.clone());
    task.last_heartbeat_at = Some(now);
    task.lease_expires_at = Some(now + Duration::minutes(5));
    task.lease_fencing_token = Some(u64::try_from(now.unix_timestamp_nanos()).unwrap());
    store.insert_task(&task).unwrap();

    let mut raw = ExecutionContract::new(
        "execution-1",
        "chat_turn",
        ExecutionScope {
            user_id: "user-1".into(),
            workspace_id: "workspace-1".into(),
            thread_id: Some("thread-1".into()),
        },
        serde_json::to_value(task).unwrap(),
    );
    raw.fencing_token = u64::try_from(now.unix_timestamp_nanos()).unwrap();
    raw.policy.allowed_effects = vec![EffectClass::Read, EffectClass::ExternalWrite];
    let contract = ValidatedExecutionContract::try_from(raw).unwrap();
    store.create_execution(&contract).unwrap();
    store
        .start_execution_attempt("execution-1", 1, contract.as_ref().fencing_token, &owner)
        .unwrap();
    (contract, owner)
}

#[test]
fn effect_claim_is_rejected_after_attempt_is_reclaimed() {
    let store = TaskStore::open_in_memory().unwrap();
    let (contract, owner) = running_attempt(&store);
    let old_fence = contract.as_ref().fencing_token;
    let replacement_fence = old_fence + 1;
    let mut replacement =
        serde_json::from_value::<TaskRecord>(contract.as_ref().input.clone()).expect("task input");
    replacement.lease_owner = Some("worker-2".into());
    replacement.last_heartbeat_at =
        Some(OffsetDateTime::from_unix_timestamp_nanos(i128::from(replacement_fence)).unwrap());
    replacement.lease_expires_at = Some(OffsetDateTime::now_utc() + Duration::minutes(5));
    replacement.lease_fencing_token = Some(replacement_fence);
    store.insert_task(&replacement).unwrap();
    store
        .reclaim_execution_attempt("execution-1", 1, old_fence, replacement_fence, "worker-2")
        .unwrap();

    let error = store
        .prepare_and_claim_effect_receipt(&new_receipt(), &owner, old_fence)
        .expect_err("a reclaimed worker must not dispatch an effect");

    assert!(error.to_string().contains("stale execution attempt"));
    assert!(
        store
            .list_effect_receipts_for_execution("execution-1", 1)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn effect_claim_is_rejected_after_same_owner_reacquires_the_task() {
    let store = TaskStore::open_in_memory().unwrap();
    let (contract, owner) = running_attempt(&store);
    let old_fence = contract.as_ref().fencing_token;
    let mut reacquired =
        serde_json::from_value::<TaskRecord>(contract.as_ref().input.clone()).expect("task input");
    reacquired.lease_owner = Some(owner.clone());
    reacquired.last_heartbeat_at =
        Some(OffsetDateTime::from_unix_timestamp_nanos(i128::from(old_fence + 1)).unwrap());
    reacquired.lease_expires_at = Some(OffsetDateTime::now_utc() + Duration::minutes(5));
    reacquired.lease_fencing_token = Some(old_fence + 1);
    store.insert_task(&reacquired).unwrap();

    let error = store
        .prepare_and_claim_effect_receipt(&new_receipt(), &owner, old_fence)
        .expect_err("an expired lease generation must not dispatch after reacquisition");

    assert!(error.to_string().contains("stale execution attempt"));
    assert!(
        store
            .list_effect_receipts_for_execution("execution-1", 1)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn effect_claim_is_rejected_after_task_deadline() {
    let store = TaskStore::open_in_memory().unwrap();
    let (contract, owner) = running_attempt(&store);
    let fence = contract.as_ref().fencing_token;
    let mut expired =
        serde_json::from_value::<TaskRecord>(contract.as_ref().input.clone()).expect("task input");
    expired.deadline = Some(OffsetDateTime::now_utc() - Duration::seconds(1));
    store.insert_task(&expired).unwrap();

    let error = store
        .prepare_and_claim_effect_receipt(&new_receipt(), &owner, fence)
        .expect_err("a task past its deadline must not dispatch an effect");

    assert!(error.to_string().contains("stale execution attempt"));
    assert!(
        store
            .list_effect_receipts_for_execution("execution-1", 1)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn effect_claim_is_rejected_after_task_expiry() {
    let store = TaskStore::open_in_memory().unwrap();
    let (contract, owner) = running_attempt(&store);
    let fence = contract.as_ref().fencing_token;
    let mut expired =
        serde_json::from_value::<TaskRecord>(contract.as_ref().input.clone()).expect("task input");
    expired.expires_at = Some(OffsetDateTime::now_utc() - Duration::seconds(1));
    store.insert_task(&expired).unwrap();

    let error = store
        .prepare_and_claim_effect_receipt(&new_receipt(), &owner, fence)
        .expect_err("an expired task must not dispatch an effect");

    assert!(error.to_string().contains("stale execution attempt"));
    assert!(
        store
            .list_effect_receipts_for_execution("execution-1", 1)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn completed_effect_replays_after_attempt_is_reclaimed() {
    let store = TaskStore::open_in_memory().unwrap();
    let (contract, owner) = running_attempt(&store);
    let old_fence = contract.as_ref().fencing_token;
    let receipt = new_receipt();
    assert!(matches!(
        store
            .prepare_and_claim_effect_receipt(&receipt, &owner, old_fence)
            .unwrap(),
        EffectReceiptClaim::Execute(_)
    ));
    store
        .complete_effect_receipt(
            &receipt.receipt_ref,
            &json!({"remote_id": "msg-1"}),
            &json!({"delivered": true}),
        )
        .unwrap();

    let replacement_fence = old_fence + 1;
    let mut replacement =
        serde_json::from_value::<TaskRecord>(contract.as_ref().input.clone()).expect("task input");
    replacement.lease_owner = Some("worker-2".into());
    replacement.last_heartbeat_at =
        Some(OffsetDateTime::from_unix_timestamp_nanos(i128::from(replacement_fence)).unwrap());
    replacement.lease_expires_at = Some(OffsetDateTime::now_utc() + Duration::minutes(5));
    replacement.lease_fencing_token = Some(replacement_fence);
    store.insert_task(&replacement).unwrap();
    store
        .reclaim_execution_attempt("execution-1", 1, old_fence, replacement_fence, "worker-2")
        .unwrap();

    assert!(matches!(
        store
            .prepare_and_claim_effect_receipt(&receipt, &owner, old_fence)
            .unwrap(),
        EffectReceiptClaim::Replay(ExecutionEffectReceipt {
            status: EffectReceiptStatus::Completed,
            ..
        })
    ));
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
fn verified_not_dispatched_receipt_returns_to_prepared_for_same_identity_retry() {
    let store = TaskStore::open_in_memory().unwrap();
    let prepared = store.prepare_effect_receipt(&new_receipt()).unwrap();
    assert!(matches!(
        store.claim_effect_receipt(&prepared.receipt_ref).unwrap(),
        EffectReceiptClaim::Execute(_)
    ));

    let released = store
        .release_effect_receipt_not_applied(
            &prepared.receipt_ref,
            &json!({"code": "connect_failed_before_dispatch"}),
        )
        .unwrap();
    assert_eq!(released.status, EffectReceiptStatus::Prepared);
    assert!(matches!(
        store.claim_effect_receipt(&prepared.receipt_ref).unwrap(),
        EffectReceiptClaim::Execute(ExecutionEffectReceipt {
            status: EffectReceiptStatus::Started,
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

#[test]
fn uncertain_receipt_persists_redacted_dispatch_evidence() {
    let store = TaskStore::open_in_memory().unwrap();
    let prepared = store.prepare_effect_receipt(&new_receipt()).unwrap();
    assert!(matches!(
        store.claim_effect_receipt(&prepared.receipt_ref).unwrap(),
        EffectReceiptClaim::Execute(_)
    ));
    let evidence = json!({
        "channel": "telegram",
        "recipient_fingerprint": "sha256:abc",
        "attempted": true
    });

    let uncertain = store
        .mark_effect_receipt_uncertain(&prepared.receipt_ref, &evidence)
        .expect("started receipt becomes uncertain with evidence");

    assert_eq!(uncertain.status, EffectReceiptStatus::Uncertain);
    assert_eq!(uncertain.effects_json, Some(evidence));
    assert!(matches!(
        store.claim_effect_receipt(&prepared.receipt_ref).unwrap(),
        EffectReceiptClaim::Resolve(ExecutionEffectReceipt {
            status: EffectReceiptStatus::Uncertain,
            ..
        })
    ));
}

#[test]
fn an_orphaned_uncertain_receipt_can_be_resolved_without_recreating_its_execution() {
    let store = TaskStore::open_in_memory().unwrap();
    let prepared = store.prepare_effect_receipt(&new_receipt()).unwrap();
    store.claim_effect_receipt(&prepared.receipt_ref).unwrap();
    store.claim_effect_receipt(&prepared.receipt_ref).unwrap();
    let resolution = EffectReceiptResolution::Applied {
        result: json!({"verified": true}),
        effects: json!({"applied": true}),
    };

    let strict_error = store
        .resolve_effect_receipt(&prepared.receipt_ref, &resolution)
        .expect_err("the normal path must still require an authoritative owner journal");
    assert!(strict_error.to_string().contains("not found: execution-1"));

    let resolved = store
        .resolve_orphaned_effect_receipt(&prepared.receipt_ref, &resolution)
        .expect("an explicitly orphaned receipt remains user-resolvable");

    assert_eq!(resolved.receipt.status, EffectReceiptStatus::Completed);
    assert_eq!(
        resolved.receipt.result_json,
        Some(json!({"verified": true}))
    );
    assert_eq!(
        resolved.receipt.effects_json,
        Some(json!({"applied": true}))
    );
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

    assert_eq!(resolved.receipt.status, EffectReceiptStatus::Completed);
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
fn not_applied_resolution_makes_the_verified_absent_effect_retryable() {
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

    assert_eq!(resolved.receipt.status, EffectReceiptStatus::Prepared);
    assert_eq!(
        resolved.receipt.error_json,
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
    assert!(matches!(
        store.claim_effect_receipt(&prepared.receipt_ref).unwrap(),
        EffectReceiptClaim::Execute(ExecutionEffectReceipt {
            status: EffectReceiptStatus::Started,
            ..
        })
    ));
}

#[test]
fn terminal_adapter_effect_can_be_resolved_without_fabricating_a_wake() {
    let store = TaskStore::open_in_memory().unwrap();
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
    let completed = ValidatedExecutionOutcome::new(
        ExecutionOutcome::completed(json!({"answer": "done"})),
        &contract,
    )
    .unwrap();
    store.commit_execution_outcome(&completed).unwrap();
    let prepared = store.prepare_effect_receipt(&new_receipt()).unwrap();
    store.claim_effect_receipt(&prepared.receipt_ref).unwrap();
    store.claim_effect_receipt(&prepared.receipt_ref).unwrap();
    let projection = store
        .claim_projection("chat_lifecycle", "projector", 1, 1)
        .unwrap()
        .expect("terminal projection");
    store
        .block_projection(&projection, &prepared.receipt_ref, 2)
        .unwrap();

    let resolved = store
        .resolve_effect_receipt(
            &prepared.receipt_ref,
            &EffectReceiptResolution::Applied {
                result: json!({"remote_id": "msg-1"}),
                effects: json!({"delivered": true}),
            },
        )
        .unwrap();

    assert_eq!(resolved.receipt.status, EffectReceiptStatus::Completed);
    assert_eq!(resolved.requeued_projections, 1);
    let projection_ref = local_first_task_runtime::projection_outbox::projection_ref(
        "execution-1",
        1,
        local_first_task_runtime::projection_outbox::CHAT_LIFECYCLE_PROJECTION,
    );
    assert_eq!(
        store
            .projection_outbox_record(&projection_ref)
            .unwrap()
            .unwrap()
            .status,
        local_first_task_runtime::ProjectionStatus::Pending
    );
    let execution = store.execution("execution-1").unwrap().unwrap();
    assert_eq!(execution.state, ExecutionState::Completed);
    assert_eq!(execution.contract.as_ref().revision, 1);
}
