use local_first_execution_protocol::{
    ExecutionContract, ExecutionOutcome, ExecutionScope, ValidatedExecutionContract,
    ValidatedExecutionOutcome,
};
use local_first_task_runtime::{
    ProjectionErrorEvidence, ProjectionStatus, TaskStore,
    projection_outbox::{CHAT_LIFECYCLE_PROJECTION, projection_ref},
};
use rusqlite::{Connection, params};
use std::path::PathBuf;
use std::sync::{Arc, Barrier};
use std::thread;
use uuid::Uuid;

fn file_store() -> (PathBuf, TaskStore) {
    let path = std::env::temp_dir().join(format!(
        "homun-projection-outbox-test-{}.sqlite",
        Uuid::new_v4()
    ));
    let store = TaskStore::open(&path).expect("open task store");
    (path, store)
}

fn contract(execution_id: &str, kind: &str) -> ValidatedExecutionContract {
    ExecutionContract::new(
        execution_id,
        kind,
        ExecutionScope {
            user_id: "user-1".into(),
            workspace_id: "workspace-1".into(),
            thread_id: Some("thread-1".into()),
        },
        serde_json::json!({"prompt": "hello"}),
    )
    .try_into()
    .expect("valid contract")
}

fn commit_chat_projection(store: &TaskStore, execution_id: &str) -> String {
    let contract = contract(execution_id, "chat_turn");
    store.create_execution(&contract).expect("create execution");
    let outcome = ValidatedExecutionOutcome::new(
        ExecutionOutcome::completed(serde_json::json!({"answer": "done"})),
        &contract,
    )
    .expect("valid outcome");
    store
        .commit_execution_outcome(&outcome)
        .expect("commit outcome");
    projection_ref(execution_id, 1, CHAT_LIFECYCLE_PROJECTION)
}

#[test]
fn projection_outbox_schema_round_trips_pending_rows() {
    let (path, store) = file_store();
    let reference = projection_ref("turn-1", 1, CHAT_LIFECYCLE_PROJECTION);
    let connection = Connection::open(&path).expect("open raw connection");
    connection
        .execute(
            "INSERT INTO execution_projection_outbox (
                projection_ref, execution_id, revision, projection_kind, status,
                attempt_count, claim_token, created_at, updated_at
             ) VALUES (?1, ?2, 1, ?3, 'pending', 0, 0, 1, 1)",
            params![reference, "turn-1", CHAT_LIFECYCLE_PROJECTION],
        )
        .expect("seed pending projection");

    let row = store
        .projection_outbox_record(&reference)
        .expect("read projection")
        .expect("projection exists");

    assert_eq!(row.projection_ref, reference);
    assert_eq!(row.execution_id, "turn-1");
    assert_eq!(row.revision, 1);
    assert_eq!(row.projection_kind, CHAT_LIFECYCLE_PROJECTION);
    assert_eq!(row.status, ProjectionStatus::Pending);
    assert_eq!(row.attempt_count, 0);
    assert_eq!(row.claim_token, 0);
    assert_eq!(row.claim_owner, None);
    assert_eq!(row.blocked_on_ref, None);

    std::fs::remove_file(path).ok();
}

#[test]
fn projection_outbox_rejects_invalid_status_and_duplicate_source() {
    let (path, _store) = file_store();
    let connection = Connection::open(&path).expect("open raw connection");
    let reference = projection_ref("turn-1", 1, CHAT_LIFECYCLE_PROJECTION);
    connection
        .execute(
            "INSERT INTO execution_projection_outbox (
                projection_ref, execution_id, revision, projection_kind, status,
                attempt_count, claim_token, created_at, updated_at
             ) VALUES (?1, ?2, 1, ?3, 'pending', 0, 0, 1, 1)",
            params![reference, "turn-1", CHAT_LIFECYCLE_PROJECTION],
        )
        .expect("seed projection");

    let invalid = connection.execute(
        "INSERT INTO execution_projection_outbox (
            projection_ref, execution_id, revision, projection_kind, status,
            attempt_count, claim_token, created_at, updated_at
         ) VALUES ('invalid', 'turn-2', 1, 'chat_lifecycle', 'lost', 0, 0, 1, 1)",
        [],
    );
    assert!(invalid.is_err());

    let duplicate = connection.execute(
        "INSERT INTO execution_projection_outbox (
            projection_ref, execution_id, revision, projection_kind, status,
            attempt_count, claim_token, created_at, updated_at
         ) VALUES ('different-ref', 'turn-1', 1, 'chat_lifecycle', 'pending', 0, 0, 1, 1)",
        [],
    );
    assert!(duplicate.is_err());

    std::fs::remove_file(path).ok();
}

#[test]
fn outcome_commit_enqueues_one_projection_atomically_and_idempotently() {
    let store = TaskStore::open_in_memory().expect("store");
    let contract = contract("turn-commit-1", "chat_turn");
    store.create_execution(&contract).expect("create execution");
    let outcome = ValidatedExecutionOutcome::new(
        ExecutionOutcome::completed(serde_json::json!({"answer": "done"})),
        &contract,
    )
    .expect("valid outcome");

    store
        .commit_execution_outcome(&outcome)
        .expect("first commit");
    store
        .commit_execution_outcome(&outcome)
        .expect("idempotent commit");

    let reference = projection_ref("turn-commit-1", 1, CHAT_LIFECYCLE_PROJECTION);
    let row = store
        .projection_outbox_record(&reference)
        .expect("read outbox")
        .expect("projection enqueued");
    assert_eq!(row.status, ProjectionStatus::Pending);
    assert_eq!(row.attempt_count, 0);
    assert_eq!(
        store
            .execution_revision("turn-commit-1", 1)
            .expect("read exact revision")
            .expect("revision exists")
            .outcome,
        Some(outcome)
    );
}

#[test]
fn unprojected_execution_kind_does_not_enqueue_chat_projection() {
    let store = TaskStore::open_in_memory().expect("store");
    let contract = contract("capability-commit-1", "capability.test");
    store.create_execution(&contract).expect("create execution");
    let outcome = ValidatedExecutionOutcome::new(
        ExecutionOutcome::completed(serde_json::json!({"ok": true})),
        &contract,
    )
    .expect("valid outcome");

    store
        .commit_execution_outcome(&outcome)
        .expect("commit outcome");

    let reference = projection_ref("capability-commit-1", 1, CHAT_LIFECYCLE_PROJECTION);
    assert_eq!(
        store
            .projection_outbox_record(&reference)
            .expect("read outbox"),
        None
    );
}

#[test]
fn reopening_legacy_committed_history_backfills_projection_once() {
    let (path, store) = file_store();
    let contract = contract("turn-backfill-1", "chat_turn");
    store.create_execution(&contract).expect("create execution");
    let outcome = ValidatedExecutionOutcome::new(
        ExecutionOutcome::completed(serde_json::json!({"answer": "legacy"})),
        &contract,
    )
    .expect("valid outcome");
    store
        .commit_execution_outcome(&outcome)
        .expect("commit outcome");
    drop(store);

    let connection = Connection::open(&path).expect("open legacy fixture");
    connection
        .execute_batch("DROP TABLE execution_projection_outbox;")
        .expect("remove outbox to emulate legacy database");
    drop(connection);

    let reopened = TaskStore::open(&path).expect("migrate legacy database");
    let reference = projection_ref("turn-backfill-1", 1, CHAT_LIFECYCLE_PROJECTION);
    assert_eq!(
        reopened
            .projection_outbox_record(&reference)
            .expect("read backfill")
            .expect("backfilled row")
            .status,
        ProjectionStatus::Pending
    );
    drop(reopened);

    let reopened_again = TaskStore::open(&path).expect("idempotent migration");
    assert!(
        reopened_again
            .projection_outbox_record(&reference)
            .expect("read backfill again")
            .is_some()
    );
    drop(reopened_again);
    std::fs::remove_file(path).ok();
}

#[test]
fn concurrent_workers_claim_one_projection_once() {
    let (path, store) = file_store();
    let reference = commit_chat_projection(&store, "turn-claim-race");
    drop(store);
    let barrier = Arc::new(Barrier::new(2));
    let mut workers = Vec::new();
    for owner in ["projector-a", "projector-b"] {
        let path = path.clone();
        let barrier = Arc::clone(&barrier);
        workers.push(thread::spawn(move || {
            let store = TaskStore::open(path).expect("open racing store");
            barrier.wait();
            store
                .claim_projection(CHAT_LIFECYCLE_PROJECTION, owner, 1, 100)
                .expect("claim projection")
        }));
    }
    let claims = workers
        .into_iter()
        .filter_map(|worker| worker.join().expect("join worker"))
        .collect::<Vec<_>>();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].record.projection_ref, reference);
    assert_eq!(claims[0].token, 1);
    assert_eq!(claims[0].generation, 1);

    std::fs::remove_file(path).ok();
}

#[test]
fn newer_generation_reclaims_and_fences_stale_projection_claim() {
    let store = TaskStore::open_in_memory().expect("store");
    let reference = commit_chat_projection(&store, "turn-stale-claim");
    let stale = store
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector", 1, 100)
        .expect("claim")
        .expect("pending row");
    assert!(
        store
            .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector", 1, 101)
            .expect("same-generation claim")
            .is_none()
    );

    let fresh = store
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector", 2, 102)
        .expect("reclaim")
        .expect("stale row is reclaimable");
    assert_eq!(fresh.token, stale.token + 1);
    assert!(store.complete_projection(&stale, 103).is_err());
    store
        .complete_projection(&fresh, 104)
        .expect("fresh owner completes");
    assert_eq!(
        store
            .projection_outbox_record(&reference)
            .expect("read row")
            .expect("row")
            .status,
        ProjectionStatus::Completed
    );
}

#[test]
fn retry_waits_until_due_and_blocked_projection_never_auto_claims() {
    let store = TaskStore::open_in_memory().expect("store");
    commit_chat_projection(&store, "turn-retry-claim");
    let retry_claim = store
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector", 1, 100)
        .expect("claim")
        .expect("pending row");
    store
        .retry_projection(
            &retry_claim,
            &ProjectionErrorEvidence {
                code: "sqlite_busy".into(),
                redacted_detail: "projection store was busy".into(),
            },
            200,
            101,
        )
        .expect("retry projection");
    assert!(
        store
            .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector", 1, 199)
            .expect("early claim")
            .is_none()
    );
    let due = store
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector", 1, 200)
        .expect("due claim")
        .expect("retry is due");
    let receipt = local_first_execution_protocol::EffectReceiptRef::from_store_id(
        "11111111111111111111111111111111",
    )
    .expect("receipt ref");
    store
        .block_projection(&due, &receipt, 201)
        .expect("block projection");
    assert!(
        store
            .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector", 2, i64::MAX)
            .expect("blocked claim")
            .is_none()
    );
}
