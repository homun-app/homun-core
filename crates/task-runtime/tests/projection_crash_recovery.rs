use local_first_execution_protocol::{
    EffectClass, EffectReceiptRef, EffectReceiptResolution, ExecutionContract, ExecutionOutcome,
    ExecutionScope, ValidatedExecutionContract, ValidatedExecutionOutcome,
};
use local_first_task_runtime::{
    NewExecutionEffectReceipt, ProjectionStatus, TaskStore,
    projection_outbox::{CHAT_LIFECYCLE_PROJECTION, projection_ref},
};
use serde_json::json;
use std::path::PathBuf;
use uuid::Uuid;

fn store_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "homun-projection-crash-recovery-{}.sqlite",
        Uuid::new_v4()
    ))
}

fn contract(execution_id: &str) -> ValidatedExecutionContract {
    ExecutionContract::new(
        execution_id,
        "chat_turn",
        ExecutionScope {
            user_id: "user-1".into(),
            workspace_id: "workspace-1".into(),
            thread_id: Some("thread-1".into()),
        },
        json!({"prompt": "hello"}),
    )
    .try_into()
    .expect("valid contract")
}

fn commit_projection(store: &TaskStore, execution_id: &str) -> String {
    let contract = contract(execution_id);
    store.create_execution(&contract).expect("create execution");
    let outcome = ValidatedExecutionOutcome::new(
        ExecutionOutcome::completed(json!({"answer": "done"})),
        &contract,
    )
    .expect("valid outcome");
    store
        .commit_execution_outcome(&outcome)
        .expect("commit outcome");
    projection_ref(execution_id, 1, CHAT_LIFECYCLE_PROJECTION)
}

#[test]
fn restart_after_outcome_commit_recovers_pending_projection() {
    let path = store_path();
    let store = TaskStore::open(&path).expect("open store");
    let reference = commit_projection(&store, "turn-after-commit");
    drop(store);

    let reopened = TaskStore::open(&path).expect("reopen store");
    let pending = reopened
        .projection_outbox_record(&reference)
        .expect("read row")
        .expect("pending row");
    assert_eq!(pending.status, ProjectionStatus::Pending);
    let claim = reopened
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector", 2, 100)
        .expect("claim after restart")
        .expect("projection is claimable");
    reopened
        .complete_projection(&claim, 101)
        .expect("complete projection");
    drop(reopened);

    let verified = TaskStore::open(&path).expect("verify persisted completion");
    assert_eq!(
        verified
            .projection_outbox_record(&reference)
            .expect("read row")
            .expect("completed row")
            .status,
        ProjectionStatus::Completed
    );
    drop(verified);
    std::fs::remove_file(path).ok();
}

#[test]
fn restart_reclaims_stale_claim_and_rejects_old_acknowledgement() {
    let path = store_path();
    let store = TaskStore::open(&path).expect("open store");
    commit_projection(&store, "turn-after-claim");
    let stale = store
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector-old", 1, 100)
        .expect("claim")
        .expect("pending row");
    drop(store);

    let reopened = TaskStore::open(&path).expect("reopen store");
    let fresh = reopened
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector-new", 2, 200)
        .expect("reclaim")
        .expect("stale claim recovered");
    assert!(reopened.complete_projection(&stale, 201).is_err());
    reopened
        .complete_projection(&fresh, 202)
        .expect("fresh claim completes");
    drop(reopened);
    std::fs::remove_file(path).ok();
}

#[test]
fn resolved_terminal_effect_and_projection_requeue_survive_restart_together() {
    let path = store_path();
    let store = TaskStore::open(&path).expect("open store");
    let reference = commit_projection(&store, "execution-1");
    let receipt_ref =
        EffectReceiptRef::from_store_id("11111111111111111111111111111111").expect("receipt ref");
    let receipt = NewExecutionEffectReceipt {
        receipt_ref: receipt_ref.clone(),
        execution_id: "execution-1".into(),
        revision: 1,
        run_id: Some("run-1".into()),
        thread_id: Some("thread-1".into()),
        user_id: "user-1".into(),
        workspace_id: "workspace-1".into(),
        effect_class: EffectClass::ExternalWrite,
        operation: "channel.reply".into(),
        arguments_hash: "sha256:channel".into(),
        idempotency_key: "channel.reply:1".into(),
        compensation: None,
    };
    let prepared = store
        .prepare_effect_receipt(&receipt)
        .expect("prepare receipt");
    store
        .claim_effect_receipt(&prepared.receipt_ref)
        .expect("start receipt");
    store
        .claim_effect_receipt(&prepared.receipt_ref)
        .expect("mark receipt uncertain");
    let claim = store
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector", 1, 1)
        .expect("claim projection")
        .expect("pending projection");
    store
        .block_projection(&claim, &receipt_ref, 2)
        .expect("block projection");
    drop(store);

    let reopened = TaskStore::open(&path).expect("reopen store");
    let commit = reopened
        .resolve_effect_receipt(
            &receipt_ref,
            &EffectReceiptResolution::Applied {
                result: json!({"remote_id": "message-1"}),
                effects: json!({"delivered": true}),
            },
        )
        .expect("resolve receipt");
    assert_eq!(commit.requeued_projections, 1);
    drop(reopened);

    let verified = TaskStore::open(&path).expect("verify atomic recovery");
    assert_eq!(
        verified
            .effect_receipt(&receipt_ref)
            .expect("read receipt")
            .expect("receipt exists")
            .status,
        local_first_execution_protocol::EffectReceiptStatus::Completed
    );
    assert_eq!(
        verified
            .projection_outbox_record(&reference)
            .expect("read row")
            .expect("projection exists")
            .status,
        ProjectionStatus::Pending
    );
    drop(verified);
    std::fs::remove_file(path).ok();
}
