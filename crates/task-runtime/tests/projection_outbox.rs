use local_first_execution_protocol::{
    CheckpointDataRef, CheckpointEnvelope, DurableDataRef, EffectClass, EffectReceiptRef,
    ExecutionContract, ExecutionOutcome, ExecutionScope, ValidatedExecutionContract,
    ValidatedExecutionOutcome, WakeCondition,
};
use local_first_task_runtime::{
    AgentRunStatus, NewAgentRun, NewExecutionEffectReceipt, ProjectionErrorEvidence,
    ProjectionStatus, TaskStore, TerminalWrite, TurnEventKind,
    projection_outbox::{
        CHAT_LIFECYCLE_PROJECTION, PROJECTION_CLAIM_STALE_AFTER_SECONDS, projection_ref,
    },
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

fn create_running_agent_run(store: &TaskStore, turn_id: &str) {
    store
        .create_agent_run(&NewAgentRun {
            run_id: format!("run-{turn_id}"),
            turn_id: turn_id.into(),
            thread_id: "thread-1".into(),
            user_id: "user-1".into(),
            workspace_id: "workspace-1".into(),
            model: None,
            provider: None,
            prompt_fingerprint: None,
        })
        .expect("create running agent run");
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
fn newer_generation_waits_for_claim_expiry_then_fences_stale_projection_claim() {
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

    assert!(
        store
            .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector", 2, 102)
            .expect("fresh higher-generation claim")
            .is_none(),
        "a new process generation must not steal an active projection"
    );

    let reclaim_at = 100 + PROJECTION_CLAIM_STALE_AFTER_SECONDS;
    let fresh = store
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector", 2, reclaim_at)
        .expect("reclaim")
        .expect("expired row is reclaimable");
    assert_eq!(fresh.token, stale.token + 1);
    assert!(store.assert_projection_claim_current(&stale).is_err());
    store
        .assert_projection_claim_current(&fresh)
        .expect("fresh claim is current");
    assert!(store.complete_projection(&stale, reclaim_at + 1).is_err());
    store
        .complete_projection(&fresh, reclaim_at + 2)
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
fn same_generation_supervisor_reclaims_an_expired_claim_after_worker_panic() {
    let store = TaskStore::open_in_memory().expect("store");
    commit_chat_projection(&store, "turn-same-generation-reclaim");
    let stale = store
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector", 7, 100)
        .expect("claim")
        .expect("pending row");

    let fresh = store
        .claim_projection(
            CHAT_LIFECYCLE_PROJECTION,
            "projector",
            7,
            100 + PROJECTION_CLAIM_STALE_AFTER_SECONDS,
        )
        .expect("same-generation takeover")
        .expect("expired claim is reclaimable by the supervisor");

    assert_eq!(fresh.generation, stale.generation);
    assert_eq!(fresh.token, stale.token + 1);
    assert!(store.assert_projection_claim_current(&stale).is_err());
    store
        .assert_projection_claim_current(&fresh)
        .expect("replacement claim");
}

#[test]
fn stale_projection_claim_cannot_prepare_an_adapter_effect_receipt() {
    let store = TaskStore::open_in_memory().expect("store");
    let execution_id = "turn-stale-adapter-effect";
    let contract = contract(execution_id, "chat_turn");
    store.create_execution(&contract).expect("create execution");
    let outcome = ValidatedExecutionOutcome::new(
        ExecutionOutcome::completed(serde_json::json!({"answer": "done"})),
        &contract,
    )
    .expect("outcome");
    store
        .commit_execution_outcome(&outcome)
        .expect("commit outcome");
    let stale = store
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector-old", 1, 100)
        .expect("claim")
        .expect("pending row");
    store
        .claim_projection(
            CHAT_LIFECYCLE_PROJECTION,
            "projector-new",
            2,
            100 + PROJECTION_CLAIM_STALE_AFTER_SECONDS,
        )
        .expect("takeover")
        .expect("fresh claim");
    let receipt = NewExecutionEffectReceipt {
        receipt_ref: EffectReceiptRef::from_store_id("11111111111111111111111111111111")
            .expect("receipt ref"),
        execution_id: execution_id.into(),
        revision: 1,
        run_id: None,
        thread_id: Some("thread-1".into()),
        user_id: "user-1".into(),
        workspace_id: "workspace-1".into(),
        effect_class: EffectClass::ExternalWrite,
        operation: "channel.telegram.reply".into(),
        arguments_hash: "sha256:args".into(),
        idempotency_key: "tool_call:channel.telegram.reply:projection_revision_1".into(),
        compensation: None,
    };

    let error = store
        .prepare_and_claim_effect_receipt_for_projection(
            &receipt,
            contract.as_ref().fencing_token,
            &stale,
        )
        .expect_err("stale projection must not cross the effect boundary");

    assert!(error.to_string().contains("projection claim"));
    assert!(
        store
            .list_effect_receipts_for_execution(execution_id, 1)
            .expect("receipts")
            .is_empty()
    );
}

#[test]
fn projection_claim_cannot_authorize_another_executions_adapter_effect() {
    let store = TaskStore::open_in_memory().expect("store");
    let owned_contract = contract("turn-a-owned-projection", "chat_turn");
    let other_contract = contract("turn-z-other-projection", "chat_turn");
    for contract in [&owned_contract, &other_contract] {
        store.create_execution(contract).expect("create execution");
        let outcome = ValidatedExecutionOutcome::new(
            ExecutionOutcome::completed(serde_json::json!({"answer": "done"})),
            contract,
        )
        .expect("outcome");
        store
            .commit_execution_outcome(&outcome)
            .expect("commit outcome");
    }
    let owned_claim = store
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector", 1, 100)
        .expect("claim")
        .expect("owned projection");
    let receipt = NewExecutionEffectReceipt {
        receipt_ref: EffectReceiptRef::from_store_id("22222222222222222222222222222222")
            .expect("receipt ref"),
        execution_id: other_contract.as_ref().execution_id.clone(),
        revision: 1,
        run_id: None,
        thread_id: Some("thread-1".into()),
        user_id: "user-1".into(),
        workspace_id: "workspace-1".into(),
        effect_class: EffectClass::ExternalWrite,
        operation: "channel.telegram.reply".into(),
        arguments_hash: "sha256:args".into(),
        idempotency_key: "tool_call:channel.telegram.reply:projection_revision_1".into(),
        compensation: None,
    };

    let error = store
        .prepare_and_claim_effect_receipt_for_projection(
            &receipt,
            other_contract.as_ref().fencing_token,
            &owned_claim,
        )
        .expect_err("a projection claim owns one exact execution revision");

    assert!(error.to_string().contains("does not own"));
    assert!(
        store
            .list_effect_receipts_for_execution(&receipt.execution_id, 1)
            .expect("receipts")
            .is_empty()
    );
}

#[test]
fn later_revision_waits_for_the_same_executions_prior_projection() {
    let store = TaskStore::open_in_memory().expect("store");
    let execution_id = "turn-ordered-projections";
    let contract = contract(execution_id, "chat_turn");
    store.create_execution(&contract).expect("create execution");
    let wake = WakeCondition::User {
        wait_ref: "wait-ordered-projections".into(),
    };
    let suspended = ValidatedExecutionOutcome::new(
        ExecutionOutcome::Suspended {
            wake: wake.clone(),
            checkpoint: CheckpointEnvelope::new(
                execution_id,
                1,
                "chat_turn",
                1,
                CheckpointDataRef::Public {
                    record_ref: DurableDataRef::from_store_id("0123456789abcdef0123456789abcdef")
                        .expect("checkpoint ref"),
                },
            ),
        },
        &contract,
    )
    .expect("suspended outcome");
    store
        .commit_execution_outcome(&suspended)
        .expect("commit revision one");
    store
        .deliver_execution_wake(&wake, &serde_json::json!({"answer": "continue"}))
        .expect("start revision two");
    let revision_two = store
        .execution_revision(execution_id, 2)
        .expect("revision lookup")
        .expect("revision two")
        .contract;
    let completed = ValidatedExecutionOutcome::new(
        ExecutionOutcome::completed(serde_json::json!({"answer": "done"})),
        &revision_two,
    )
    .expect("completed outcome");
    store
        .commit_execution_outcome(&completed)
        .expect("commit revision two");

    let revision_one_claim = store
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector-a", 1, 100)
        .expect("claim revision one")
        .expect("revision one pending");
    assert_eq!(revision_one_claim.record.revision, 1);
    assert!(
        store
            .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector-b", 1, 101)
            .expect("claim while revision one is active")
            .is_none(),
        "revision two must not overtake revision one"
    );

    store
        .complete_projection(&revision_one_claim, 102)
        .expect("complete revision one");
    let revision_two_claim = store
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector-b", 1, 103)
        .expect("claim revision two")
        .expect("revision two becomes eligible");
    assert_eq!(revision_two_claim.record.revision, 2);
}

#[test]
fn active_projection_heartbeat_extends_claim_validity() {
    let store = TaskStore::open_in_memory().expect("store");
    commit_chat_projection(&store, "turn-heartbeat");
    let claim = store
        .claim_projection(CHAT_LIFECYCLE_PROJECTION, "projector-old", 1, 100)
        .expect("claim")
        .expect("pending row");
    store
        .renew_projection_claim(&claim, 200)
        .expect("heartbeat current claim");

    assert!(
        store
            .claim_projection(
                CHAT_LIFECYCLE_PROJECTION,
                "projector-new",
                2,
                200 + PROJECTION_CLAIM_STALE_AFTER_SECONDS - 1,
            )
            .expect("takeover attempt")
            .is_none()
    );
}

#[test]
fn boot_abort_preserves_running_run_with_a_committed_outcome() {
    let store = TaskStore::open_in_memory().expect("store");
    create_running_agent_run(&store, "turn-committed");
    create_running_agent_run(&store, "turn-orphan");
    commit_chat_projection(&store, "turn-committed");

    assert_eq!(
        store
            .abort_orphaned_running_agent_runs("gateway_restart")
            .expect("abort orphaned runs"),
        1
    );
    let committed = store
        .list_agent_runs_for_turn("turn-committed", "user-1", "workspace-1")
        .expect("committed runs");
    let orphan = store
        .list_agent_runs_for_turn("turn-orphan", "user-1", "workspace-1")
        .expect("orphan runs");
    assert_eq!(committed[0].status, AgentRunStatus::Running);
    assert_eq!(orphan[0].status, AgentRunStatus::Aborted);
}

#[test]
fn boot_abort_uses_the_current_uncommitted_revision_not_prior_outcomes() {
    let store = TaskStore::open_in_memory().expect("store");
    let execution_id = "turn-revision-two-orphan";
    create_running_agent_run(&store, execution_id);
    let contract = contract(execution_id, "chat_turn");
    store.create_execution(&contract).expect("create execution");
    let wake = WakeCondition::User {
        wait_ref: "wait-revision-two".into(),
    };
    let suspended = ValidatedExecutionOutcome::new(
        ExecutionOutcome::Suspended {
            wake: wake.clone(),
            checkpoint: CheckpointEnvelope::new(
                execution_id,
                1,
                "chat_turn",
                1,
                CheckpointDataRef::Public {
                    record_ref: DurableDataRef::from_store_id("0123456789abcdef0123456789abcdef")
                        .expect("checkpoint ref"),
                },
            ),
        },
        &contract,
    )
    .expect("suspended outcome");
    store
        .commit_execution_outcome(&suspended)
        .expect("commit revision one");
    assert_eq!(
        store
            .deliver_execution_wake(&wake, &serde_json::json!({"answer": "continue"}))
            .expect("start revision two"),
        1
    );

    assert_eq!(
        store
            .abort_orphaned_running_agent_runs("gateway_restart")
            .expect("abort revision two orphan"),
        1
    );
    assert_eq!(
        store
            .list_agent_runs_for_turn(execution_id, "user-1", "workspace-1")
            .expect("runs")[0]
            .status,
        AgentRunStatus::Aborted
    );
}

#[test]
fn projection_event_ack_is_atomic_and_idempotent() {
    let store = TaskStore::open_in_memory().expect("store");
    let payload = serde_json::json!({"projection_ref": "turn-1:1"});

    let first = store
        .insert_turn_projection_event_once(
            "turn-1",
            TurnEventKind::Suspended,
            "turn-1:1",
            payload.clone(),
        )
        .expect("first projection event");
    let second = store
        .insert_turn_projection_event_once("turn-1", TurnEventKind::Suspended, "turn-1:1", payload)
        .expect("idempotent projection event");

    assert!(matches!(first, TerminalWrite::Inserted(_)));
    assert!(matches!(second, TerminalWrite::Existing(_)));
    assert_eq!(
        store.read_turn_events("turn-1", 0).expect("events").len(),
        1
    );
}

#[test]
fn canonical_terminal_projection_rejects_an_unacknowledged_prior_terminal() {
    let store = TaskStore::open_in_memory().expect("store");
    store
        .insert_terminal_event_once(
            "turn-terminal-conflict",
            TurnEventKind::Error,
            serde_json::json!({"code": "transport_error"}),
        )
        .expect("prior terminal");

    let conflict = store.insert_turn_projection_event_once(
        "turn-terminal-conflict",
        TurnEventKind::Done,
        "turn-terminal-conflict:1",
        serde_json::json!({"projection_ref": "turn-terminal-conflict:1"}),
    );

    assert!(conflict.is_err());
    assert_eq!(
        store
            .read_turn_events("turn-terminal-conflict", 0)
            .expect("events")
            .len(),
        1
    );
}

#[test]
fn canonical_error_projection_adopts_a_legacy_unacknowledged_error() {
    let store = TaskStore::open_in_memory().expect("store");
    let legacy = store
        .insert_terminal_event_once(
            "turn-legacy-error",
            TurnEventKind::Error,
            serde_json::json!({
                "type": "error",
                "message": "provider stream disconnected"
            }),
        )
        .expect("legacy terminal");
    let TerminalWrite::Inserted(legacy) = legacy else {
        panic!("legacy terminal must be inserted");
    };
    let projection_ref = "turn-legacy-error:1";

    let adopted = store
        .insert_turn_projection_event_once(
            "turn-legacy-error",
            TurnEventKind::Error,
            projection_ref,
            serde_json::json!({
                "projection_ref": projection_ref,
                "code": "provider_failed"
            }),
        )
        .expect("canonical error adopts legacy terminal");

    let TerminalWrite::Inserted(adopted) = adopted else {
        panic!("adopted canonical error must be broadcast once");
    };
    assert_eq!(adopted.event_id, legacy.event_id);
    assert_eq!(adopted.seq, legacy.seq);
    assert_eq!(adopted.payload["projection_ref"], projection_ref);
    assert_eq!(
        store
            .read_turn_events("turn-legacy-error", 0)
            .expect("events")
            .len(),
        1
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
    assert_eq!(
        store
            .pending_projection_error(CHAT_LIFECYCLE_PROJECTION)
            .expect("projection health evidence")
            .expect("retry error remains visible")
            .code,
        "sqlite_busy"
    );
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
