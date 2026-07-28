use local_first_execution_protocol::{
    CancelReason, CheckpointDataRef, CheckpointEnvelope, CheckpointRef, DurableDataRef,
    ExecutionContract, ExecutionFailure, ExecutionOutcome, ExecutionScope, ExecutionState,
    ValidatedExecutionContract, ValidatedExecutionOutcome, WakeCondition, WakeDelivery,
};
use local_first_task_runtime::{
    CreateExecution, ExecutionJournalEvent, ExecutionRecord, OutcomeCommit, StartExecutionRevision,
    TaskRecord, TaskRuntimeError, TaskStore, UserId, WorkspaceId,
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Barrier},
    thread,
};
use uuid::Uuid;

const DURABLE_STORE_ID: &str = "0123456789abcdef0123456789abcdef";

fn contract(execution_id: &str, revision: u64, fencing_token: u64) -> ValidatedExecutionContract {
    let mut contract = ExecutionContract::new(
        execution_id,
        "chat_turn",
        ExecutionScope {
            user_id: "user-1".into(),
            workspace_id: "workspace-1".into(),
            thread_id: Some("thread-1".into()),
        },
        json!({"prompt": "hello"}),
    );
    contract.revision = revision;
    contract.fencing_token = fencing_token;
    ValidatedExecutionContract::try_from(contract).unwrap()
}

fn completed(contract: &ValidatedExecutionContract, output: Value) -> ValidatedExecutionOutcome {
    ValidatedExecutionOutcome::new(ExecutionOutcome::completed(output), contract).unwrap()
}

fn suspended(contract: &ValidatedExecutionContract) -> ValidatedExecutionOutcome {
    let raw = contract.as_ref();
    ValidatedExecutionOutcome::new(
        ExecutionOutcome::Suspended {
            wake: WakeCondition::Signal {
                kind: "connector.message".into(),
                correlation_id: "message-1".into(),
            },
            checkpoint: CheckpointEnvelope::new(
                &raw.execution_id,
                raw.revision,
                &raw.kind,
                1,
                CheckpointDataRef::Public {
                    record_ref: DurableDataRef::from_store_id(DURABLE_STORE_ID).unwrap(),
                },
            ),
        },
        contract,
    )
    .unwrap()
}

fn next_revision(
    prior: &ValidatedExecutionContract,
    suspension: &ValidatedExecutionOutcome,
    fencing_token: u64,
) -> ValidatedExecutionContract {
    let (wake, checkpoint) = match suspension.as_ref() {
        ExecutionOutcome::Suspended { wake, checkpoint } => (wake, checkpoint),
        _ => panic!("next revision requires a suspended outcome"),
    };
    let mut contract = prior.as_ref().clone();
    contract.revision += 1;
    contract.fencing_token = fencing_token;
    contract.checkpoint = Some(CheckpointRef {
        checkpoint_id: checkpoint.checkpoint_id().into(),
        producer_schema_version: checkpoint.producer_schema_version,
    });
    contract.wake = Some(WakeDelivery {
        condition: wake.clone(),
        dedup_key: wake.dedup_key(),
        payload: json!({"signal": "delivered"}),
        delivered_at_unix_seconds: 1_700_000_000,
    });
    ValidatedExecutionContract::try_from(contract).unwrap()
}

fn inserted(result: CreateExecution) -> ExecutionRecord {
    match result {
        CreateExecution::Inserted(record) => record,
        CreateExecution::Existing(_) => panic!("first create must insert"),
    }
}

fn file_store() -> (PathBuf, TaskStore) {
    let path = std::env::temp_dir().join(format!(
        "homun-execution-journal-test-{}.sqlite",
        Uuid::new_v4()
    ));
    let store = TaskStore::open(&path).unwrap();
    (path, store)
}

fn raw_connection(path: &Path) -> Connection {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")
        .unwrap();
    connection
}

#[test]
fn journal_events_are_typed_complete_and_timestamp_the_projection() {
    let store = TaskStore::open_in_memory().unwrap();
    let original = contract("exec-journal", 1, 7);
    let created = inserted(store.create_execution(&original).unwrap());
    let advanced = store
        .advance_execution_fence("exec-journal", 1, 7, 8)
        .unwrap();
    let after_fence = store.execution_events("exec-journal", 1).unwrap();
    let outcome = completed(&advanced.contract, json!({"ok": true}));
    let committed = match store.commit_execution_outcome(&outcome).unwrap() {
        OutcomeCommit::Inserted(record) => record,
        OutcomeCommit::Existing(_) => panic!("first outcome must insert"),
    };
    let events = store.execution_events("exec-journal", 1).unwrap();

    assert_eq!(
        events.iter().map(|event| event.seq).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(created.created_at, events[0].created_at);
    assert_eq!(created.updated_at, events[0].created_at);
    assert_eq!(advanced.updated_at, after_fence[1].created_at);
    assert_eq!(committed.updated_at, events[2].created_at);
    assert!(matches!(
        &events[0].event,
        ExecutionJournalEvent::Created { version: 1, contract } if contract == original.as_ref()
    ));
    assert!(matches!(
        &events[1].event,
        ExecutionJournalEvent::FenceAdvanced {
            version: 1,
            previous_fencing_token: 7,
            contract,
        } if contract == advanced.contract.as_ref()
    ));
    assert!(matches!(
        &events[2].event,
        ExecutionJournalEvent::OutcomeCommitted {
            version: 1,
            outcome: stored,
            state: ExecutionState::Completed,
        } if stored == outcome.as_ref()
    ));
}

#[test]
fn suspended_revision_can_start_and_complete_the_next_revision() {
    let store = TaskStore::open_in_memory().unwrap();
    let revision_one = contract("exec-multi-revision", 1, 2);
    store.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    store.commit_execution_outcome(&suspended).unwrap();
    let revision_two = next_revision(&revision_one, &suspended, 3);

    let started = match store.start_execution_revision(&revision_two).unwrap() {
        StartExecutionRevision::Inserted(record) => record,
        StartExecutionRevision::Existing(_) => panic!("first revision start must insert"),
    };
    assert_eq!(started.contract, revision_two);
    assert_eq!(started.state, ExecutionState::Ready);

    let completed = completed(&revision_two, json!({"done": true}));
    let latest = match store.commit_execution_outcome(&completed).unwrap() {
        OutcomeCommit::Inserted(record) => record,
        OutcomeCommit::Existing(_) => panic!("first outcome must insert"),
    };
    assert_eq!(latest.contract, revision_two);
    assert_eq!(latest.state, ExecutionState::Completed);
    assert_eq!(
        store.execution("exec-multi-revision").unwrap(),
        Some(latest)
    );

    let revision_one_events = store.execution_events("exec-multi-revision", 1).unwrap();
    let revision_two_events = store.execution_events("exec-multi-revision", 2).unwrap();
    assert_eq!(
        revision_one_events
            .iter()
            .map(|event| event.seq)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        revision_two_events
            .iter()
            .map(|event| event.seq)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert!(matches!(
        &revision_one_events[0].event,
        ExecutionJournalEvent::Created { contract, .. } if contract == revision_one.as_ref()
    ));
    assert!(matches!(
        &revision_two_events[0].event,
        ExecutionJournalEvent::RevisionStarted {
            version: 1,
            previous_revision: 1,
            contract,
        } if contract == revision_two.as_ref()
    ));
}

#[test]
fn create_and_revision_start_retries_return_the_latest_projection() {
    let store = TaskStore::open_in_memory().unwrap();
    let revision_one = contract("exec-multi-retry", 1, 1);
    store.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    store.commit_execution_outcome(&suspended).unwrap();
    let revision_two = next_revision(&revision_one, &suspended, 2);
    let started = match store.start_execution_revision(&revision_two).unwrap() {
        StartExecutionRevision::Inserted(record) => record,
        StartExecutionRevision::Existing(_) => unreachable!(),
    };

    let create_retry = match store.create_execution(&revision_one).unwrap() {
        CreateExecution::Existing(record) => record,
        CreateExecution::Inserted(_) => panic!("initial creation retry must be existing"),
    };
    let revision_retry = match store.start_execution_revision(&revision_two).unwrap() {
        StartExecutionRevision::Existing(record) => record,
        StartExecutionRevision::Inserted(_) => panic!("revision retry must be existing"),
    };
    assert_eq!(create_retry, started);
    assert_eq!(revision_retry, started);
    assert_eq!(
        store.execution_events("exec-multi-retry", 1).unwrap().len(),
        2
    );
    assert_eq!(
        store.execution_events("exec-multi-retry", 2).unwrap().len(),
        1
    );
}

#[test]
fn revision_start_rejects_invalid_aggregate_transitions() {
    let store = TaskStore::open_in_memory().unwrap();
    let revision_one = contract("exec-invalid-revision-start", 1, 4);
    store.create_execution(&revision_one).unwrap();
    let premature = contract("exec-invalid-revision-start", 2, 5);
    assert!(matches!(
        store.start_execution_revision(&premature),
        Err(TaskRuntimeError::InvalidTransition(_))
    ));

    let suspended = suspended(&revision_one);
    store.commit_execution_outcome(&suspended).unwrap();
    let valid = next_revision(&revision_one, &suspended, 5);
    let mut candidates = Vec::new();

    let mut skipped = valid.as_ref().clone();
    skipped.revision = 3;
    candidates.push(skipped);

    let mut checkpoint = valid.as_ref().clone();
    checkpoint.checkpoint.as_mut().unwrap().checkpoint_id = "wrong-checkpoint".into();
    candidates.push(checkpoint);

    let mut checkpoint_schema = valid.as_ref().clone();
    checkpoint_schema
        .checkpoint
        .as_mut()
        .unwrap()
        .producer_schema_version += 1;
    candidates.push(checkpoint_schema);

    let mut wake = valid.as_ref().clone();
    let condition = WakeCondition::User {
        wait_ref: "another-wait".into(),
    };
    wake.wake = Some(WakeDelivery {
        dedup_key: condition.dedup_key(),
        condition,
        payload: json!({}),
        delivered_at_unix_seconds: 1_700_000_001,
    });
    candidates.push(wake);

    let mut scope = valid.as_ref().clone();
    scope.scope.workspace_id = "other-workspace".into();
    candidates.push(scope);

    let mut kind = valid.as_ref().clone();
    kind.kind = "other-kind".into();
    candidates.push(kind);

    let mut parent = valid.as_ref().clone();
    parent.parent_execution_id = Some("other-parent".into());
    candidates.push(parent);

    let mut fence = valid.as_ref().clone();
    fence.fencing_token = revision_one.as_ref().fencing_token;
    candidates.push(fence);

    for candidate in candidates {
        let candidate = ValidatedExecutionContract::try_from(candidate).unwrap();
        assert!(matches!(
            store.start_execution_revision(&candidate),
            Err(TaskRuntimeError::InvalidTransition(_))
        ));
    }
    assert_eq!(
        store
            .execution_events("exec-invalid-revision-start", 2)
            .unwrap_err()
            .to_string(),
        TaskRuntimeError::NotFound(
            "execution journal exec-invalid-revision-start revision 2".into()
        )
        .to_string()
    );
}

#[test]
fn journal_survives_projection_deletion_and_rebuilds_exactly() {
    let (path, store) = file_store();
    let contract = contract("exec-rebuild-missing", 1, 4);
    store.create_execution(&contract).unwrap();
    let outcome = completed(&contract, json!({"answer": 42}));
    let expected = match store.commit_execution_outcome(&outcome).unwrap() {
        OutcomeCommit::Inserted(record) => record,
        OutcomeCommit::Existing(_) => unreachable!(),
    };

    raw_connection(&path)
        .execute(
            "DELETE FROM executions WHERE execution_id = ?1",
            ["exec-rebuild-missing"],
        )
        .unwrap();

    let events = store.execution_events("exec-rebuild-missing", 1).unwrap();
    assert_eq!(events.len(), 2);
    assert!(store.execution("exec-rebuild-missing").unwrap().is_none());
    let rebuilt = store
        .rebuild_execution_projection("exec-rebuild-missing")
        .unwrap();
    assert_eq!(rebuilt, expected);
    assert_eq!(
        store.execution("exec-rebuild-missing").unwrap(),
        Some(expected)
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn corrupt_projection_is_replaced_from_the_journal() {
    let (path, store) = file_store();
    let contract = contract("exec-rebuild-corrupt", 1, 5);
    let expected = inserted(store.create_execution(&contract).unwrap());
    raw_connection(&path)
        .execute(
            "UPDATE executions SET contract_json = '{}' WHERE execution_id = ?1",
            ["exec-rebuild-corrupt"],
        )
        .unwrap();
    assert!(matches!(
        store.execution("exec-rebuild-corrupt"),
        Err(TaskRuntimeError::Store(_))
    ));

    let rebuilt = store
        .rebuild_execution_projection("exec-rebuild-corrupt")
        .unwrap();
    assert_eq!(rebuilt, expected);
    assert_eq!(
        store.execution("exec-rebuild-corrupt").unwrap(),
        Some(expected)
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn journal_fold_rejects_sequence_gaps() {
    let (path, store) = file_store();
    let contract = contract("exec-gap", 1, 1);
    store.create_execution(&contract).unwrap();
    let outcome = completed(&contract, json!({"ok": true}));
    store.commit_execution_outcome(&outcome).unwrap();
    raw_connection(&path)
        .execute(
            "UPDATE execution_events SET seq = 3 WHERE execution_id = ?1 AND seq = 2",
            ["exec-gap"],
        )
        .unwrap();

    assert!(matches!(
        store.execution_events("exec-gap", 1),
        Err(TaskRuntimeError::Store(_))
    ));
    assert!(matches!(
        store.rebuild_execution_projection("exec-gap"),
        Err(TaskRuntimeError::Store(_))
    ));

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn journal_fold_rejects_reordered_lifecycle_events() {
    let (path, store) = file_store();
    let contract = contract("exec-reordered", 1, 1);
    store.create_execution(&contract).unwrap();
    store
        .advance_execution_fence("exec-reordered", 1, 1, 2)
        .unwrap();
    let connection = raw_connection(&path);
    connection
        .execute(
            "UPDATE execution_events SET seq = 3 WHERE execution_id = ?1 AND seq = 1",
            ["exec-reordered"],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE execution_events SET seq = 1 WHERE execution_id = ?1 AND seq = 2",
            ["exec-reordered"],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE execution_events SET seq = 2 WHERE execution_id = ?1 AND seq = 3",
            ["exec-reordered"],
        )
        .unwrap();

    assert!(matches!(
        store.execution_events("exec-reordered", 1),
        Err(TaskRuntimeError::Store(_))
    ));

    drop(connection);
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn journal_fold_rejects_forged_event_kind_and_payload() {
    let (path, store) = file_store();
    let contract = contract("exec-forged", 1, 1);
    store.create_execution(&contract).unwrap();
    raw_connection(&path)
        .execute(
            "UPDATE execution_events SET kind = 'outcome_committed' WHERE execution_id = ?1",
            ["exec-forged"],
        )
        .unwrap();

    assert!(matches!(
        store.execution_events("exec-forged", 1),
        Err(TaskRuntimeError::Store(_))
    ));

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn journal_fold_revalidates_raw_contracts_and_outcomes() {
    let (path, store) = file_store();
    let contract = contract("exec-invalid-raw", 1, 1);
    store.create_execution(&contract).unwrap();
    let outcome = completed(&contract, json!({"ok": true}));
    store.commit_execution_outcome(&outcome).unwrap();
    let connection = raw_connection(&path);
    let payload: String = connection
        .query_row(
            "SELECT payload_json FROM execution_events WHERE execution_id = ?1 AND seq = 2",
            ["exec-invalid-raw"],
            |row| row.get(0),
        )
        .unwrap();
    let mut payload: Value = serde_json::from_str(&payload).unwrap();
    payload["outcome"] = json!({
        "type": "failed",
        "failure": {"class": "permanent", "code": " ", "redacted_detail": "redacted"}
    });
    connection
        .execute(
            "UPDATE execution_events SET payload_json = ?1 WHERE execution_id = ?2 AND seq = 2",
            params![serde_json::to_string(&payload).unwrap(), "exec-invalid-raw"],
        )
        .unwrap();

    assert!(matches!(
        store.execution_events("exec-invalid-raw", 1),
        Err(TaskRuntimeError::Store(_))
    ));

    drop(connection);
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn journal_fold_revalidates_the_raw_created_contract() {
    let (path, store) = file_store();
    let contract = contract("exec-invalid-created", 1, 1);
    store.create_execution(&contract).unwrap();
    let connection = raw_connection(&path);
    let payload: String = connection
        .query_row(
            "SELECT payload_json FROM execution_events WHERE execution_id = ?1 AND seq = 1",
            ["exec-invalid-created"],
            |row| row.get(0),
        )
        .unwrap();
    let mut payload: Value = serde_json::from_str(&payload).unwrap();
    payload["contract"]["kind"] = Value::String(" ".into());
    connection
        .execute(
            "UPDATE execution_events SET payload_json = ?1 WHERE execution_id = ?2 AND seq = 1",
            params![
                serde_json::to_string(&payload).unwrap(),
                "exec-invalid-created"
            ],
        )
        .unwrap();

    assert!(matches!(
        store.execution_events("exec-invalid-created", 1),
        Err(TaskRuntimeError::Store(_))
    ));

    drop(connection);
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn journal_fold_rejects_a_second_outcome_event() {
    let (path, store) = file_store();
    let contract = contract("exec-duplicate-outcome", 1, 1);
    store.create_execution(&contract).unwrap();
    let outcome = completed(&contract, json!({"ok": true}));
    store.commit_execution_outcome(&outcome).unwrap();
    let connection = raw_connection(&path);
    let (kind, payload, created_at): (String, String, i64) = connection
        .query_row(
            "SELECT kind, payload_json, created_at FROM execution_events
             WHERE execution_id = ?1 AND seq = 2",
            ["exec-duplicate-outcome"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO execution_events (
                execution_id, revision, seq, kind, payload_json, created_at
             ) VALUES ('exec-duplicate-outcome', 1, 3, ?1, ?2, ?3)",
            params![kind, payload, created_at],
        )
        .unwrap();

    assert!(matches!(
        store.execution_events("exec-duplicate-outcome", 1),
        Err(TaskRuntimeError::Store(_))
    ));

    drop(connection);
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn same_contract_retry_is_explicitly_existing_without_a_second_event() {
    let store = TaskStore::open_in_memory().unwrap();
    let contract = contract("exec-create-existing", 1, 1);
    assert!(matches!(
        store.create_execution(&contract).unwrap(),
        CreateExecution::Inserted(_)
    ));
    assert!(matches!(
        store.create_execution(&contract).unwrap(),
        CreateExecution::Existing(_)
    ));
    assert_eq!(
        store
            .execution_events("exec-create-existing", 1)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn unknown_create_result_retry_recovers_a_missing_projection() {
    let (path, store) = file_store();
    let contract = contract("exec-create-recover", 1, 3);
    let expected = inserted(store.create_execution(&contract).unwrap());
    raw_connection(&path)
        .execute(
            "DELETE FROM executions WHERE execution_id = ?1",
            ["exec-create-recover"],
        )
        .unwrap();

    let recovered = match store.create_execution(&contract).unwrap() {
        CreateExecution::Existing(record) => record,
        CreateExecution::Inserted(_) => panic!("retry must not append another creation"),
    };
    assert_eq!(recovered, expected);
    assert_eq!(
        store
            .execution_events("exec-create-recover", 1)
            .unwrap()
            .len(),
        1
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn original_create_retry_remains_existing_after_fence_advance() {
    let store = TaskStore::open_in_memory().unwrap();
    let original = contract("exec-create-after-fence", 1, 3);
    store.create_execution(&original).unwrap();
    let advanced = store
        .advance_execution_fence("exec-create-after-fence", 1, 3, 4)
        .unwrap();

    let retried = match store.create_execution(&original).unwrap() {
        CreateExecution::Existing(record) => record,
        CreateExecution::Inserted(_) => panic!("create retry must remain idempotent"),
    };
    assert_eq!(retried, advanced);
    assert_eq!(
        store
            .execution_events("exec-create-after-fence", 1)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn different_contract_with_the_same_id_conflicts() {
    let store = TaskStore::open_in_memory().unwrap();
    let original = contract("exec-create-conflict", 1, 1);
    store.create_execution(&original).unwrap();
    let mut different = original.as_ref().clone();
    different.input = json!({"prompt": "different"});
    let different = ValidatedExecutionContract::try_from(different).unwrap();

    assert!(matches!(
        store.create_execution(&different),
        Err(TaskRuntimeError::Conflict(_))
    ));
    let different_revision = contract("exec-create-conflict", 2, 1);
    assert!(matches!(
        store.create_execution(&different_revision),
        Err(TaskRuntimeError::InvalidTransition(_))
    ));
    assert_eq!(
        store
            .execution_events("exec-create-conflict", 1)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn initial_creation_requires_revision_one() {
    let store = TaskStore::open_in_memory().unwrap();
    let revision_two = contract("exec-create-revision-two", 2, 2);

    assert!(matches!(
        store.create_execution(&revision_two),
        Err(TaskRuntimeError::InvalidTransition(_))
    ));
    assert!(
        store
            .execution("exec-create-revision-two")
            .unwrap()
            .is_none()
    );
}

#[test]
fn rebuild_restores_only_the_latest_revision_projection() {
    let (path, store) = file_store();
    let revision_one = contract("exec-rebuild-latest", 1, 1);
    store.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    store.commit_execution_outcome(&suspended).unwrap();
    let revision_two = next_revision(&revision_one, &suspended, 2);
    store.start_execution_revision(&revision_two).unwrap();
    let completed = completed(&revision_two, json!({"latest": true}));
    let expected = match store.commit_execution_outcome(&completed).unwrap() {
        OutcomeCommit::Inserted(record) => record,
        OutcomeCommit::Existing(_) => unreachable!(),
    };

    raw_connection(&path)
        .execute(
            "DELETE FROM executions WHERE execution_id = ?1",
            ["exec-rebuild-latest"],
        )
        .unwrap();
    assert_eq!(
        store
            .execution_events("exec-rebuild-latest", 1)
            .unwrap()
            .len(),
        2
    );
    let rebuilt = store
        .rebuild_execution_projection("exec-rebuild-latest")
        .unwrap();

    assert_eq!(rebuilt, expected);
    assert_eq!(rebuilt.contract.as_ref().revision, 2);
    assert_eq!(
        store.execution("exec-rebuild-latest").unwrap(),
        Some(expected)
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn stale_prior_revision_outcome_never_rewrites_the_latest_projection() {
    let store = TaskStore::open_in_memory().unwrap();
    let revision_one = contract("exec-stale-prior-outcome", 1, 1);
    store.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    store.commit_execution_outcome(&suspended).unwrap();
    let revision_two = next_revision(&revision_one, &suspended, 2);
    let latest = match store.start_execution_revision(&revision_two).unwrap() {
        StartExecutionRevision::Inserted(record) => record,
        StartExecutionRevision::Existing(_) => unreachable!(),
    };

    let repeated = match store.commit_execution_outcome(&suspended).unwrap() {
        OutcomeCommit::Existing(record) => record,
        OutcomeCommit::Inserted(_) => panic!("prior outcome retry must not append"),
    };
    assert_eq!(repeated.contract.as_ref().revision, 1);
    assert_eq!(
        store.execution("exec-stale-prior-outcome").unwrap(),
        Some(latest.clone())
    );

    let conflicting = completed(&revision_one, json!({"stale": true}));
    assert!(matches!(
        store.commit_execution_outcome(&conflicting),
        Err(TaskRuntimeError::InvalidTransition(_))
    ));
    assert_eq!(
        store.execution("exec-stale-prior-outcome").unwrap(),
        Some(latest)
    );
    assert_eq!(
        store
            .execution_events("exec-stale-prior-outcome", 1)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn journal_fold_revalidates_revision_start_transition_data() {
    let (path, store) = file_store();
    let revision_one = contract("exec-corrupt-revision-start", 1, 1);
    store.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    store.commit_execution_outcome(&suspended).unwrap();
    let revision_two = next_revision(&revision_one, &suspended, 2);
    store.start_execution_revision(&revision_two).unwrap();

    let connection = raw_connection(&path);
    let payload: String = connection
        .query_row(
            "SELECT payload_json FROM execution_events
             WHERE execution_id = ?1 AND revision = 2 AND seq = 1",
            ["exec-corrupt-revision-start"],
            |row| row.get(0),
        )
        .unwrap();
    let mut payload: Value = serde_json::from_str(&payload).unwrap();
    payload["previous_revision"] = json!(0);
    connection
        .execute(
            "UPDATE execution_events SET payload_json = ?1
             WHERE execution_id = ?2 AND revision = 2 AND seq = 1",
            params![
                serde_json::to_string(&payload).unwrap(),
                "exec-corrupt-revision-start"
            ],
        )
        .unwrap();

    assert!(matches!(
        store.execution_events("exec-corrupt-revision-start", 1),
        Err(TaskRuntimeError::Store(_))
    ));
    assert!(matches!(
        store.rebuild_execution_projection("exec-corrupt-revision-start"),
        Err(TaskRuntimeError::Store(_))
    ));

    drop(connection);
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn stale_fence_cannot_commit_and_fence_updates_journal_binding() {
    let store = TaskStore::open_in_memory().unwrap();
    let original = contract("exec-fence", 1, 7);
    let stale = completed(&original, json!({"stale": true}));
    store.create_execution(&original).unwrap();
    let advanced = store
        .advance_execution_fence("exec-fence", 1, 7, 8)
        .unwrap();

    assert!(matches!(
        store.commit_execution_outcome(&stale),
        Err(TaskRuntimeError::InvalidTransition(_))
    ));
    let current = completed(&advanced.contract, json!({"ok": true}));
    assert!(matches!(
        store.commit_execution_outcome(&current).unwrap(),
        OutcomeCommit::Inserted(_)
    ));
    assert_eq!(store.execution_events("exec-fence", 1).unwrap().len(), 3);
}

#[test]
fn advance_fence_rejects_stale_revision_and_invalid_tokens() {
    let store = TaskStore::open_in_memory().unwrap();
    let contract = contract("exec-fence-invalid", 1, 4);
    store.create_execution(&contract).unwrap();

    for result in [
        store.advance_execution_fence("exec-fence-invalid", 2, 4, 5),
        store.advance_execution_fence("exec-fence-invalid", 1, 3, 5),
        store.advance_execution_fence("exec-fence-invalid", 1, 4, 4),
        store.advance_execution_fence("exec-fence-invalid", 1, 4, u64::MAX),
    ] {
        assert!(matches!(
            result,
            Err(TaskRuntimeError::InvalidTransition(_))
        ));
    }
}

#[test]
fn repeated_outcome_is_existing_and_conflicting_outcome_is_rejected() {
    let store = TaskStore::open_in_memory().unwrap();
    let contract = contract("exec-outcome-idempotent", 1, 2);
    store.create_execution(&contract).unwrap();
    let first = completed(&contract, json!({"value": 1}));
    let conflicting = completed(&contract, json!({"value": 2}));
    assert!(matches!(
        store.commit_execution_outcome(&first).unwrap(),
        OutcomeCommit::Inserted(_)
    ));
    assert!(matches!(
        store.commit_execution_outcome(&first).unwrap(),
        OutcomeCommit::Existing(_)
    ));
    assert!(matches!(
        store.commit_execution_outcome(&conflicting),
        Err(TaskRuntimeError::InvalidTransition(_))
    ));
    assert_eq!(
        store
            .execution_events("exec-outcome-idempotent", 1)
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn all_canonical_outcomes_fold_to_their_states() {
    for (name, expected) in [
        ("completed", ExecutionState::Completed),
        ("suspended", ExecutionState::Suspended),
        ("cancelled", ExecutionState::Cancelled),
        ("failed", ExecutionState::Failed),
    ] {
        let store = TaskStore::open_in_memory().unwrap();
        let contract = contract(&format!("exec-state-{name}"), 1, 1);
        store.create_execution(&contract).unwrap();
        let outcome = match name {
            "completed" => completed(&contract, json!({"ok": true})),
            "suspended" => suspended(&contract),
            "cancelled" => ValidatedExecutionOutcome::new(
                ExecutionOutcome::Cancelled {
                    reason: CancelReason::User,
                },
                &contract,
            )
            .unwrap(),
            "failed" => ValidatedExecutionOutcome::new(
                ExecutionOutcome::Failed {
                    failure: ExecutionFailure::permanent("failed", "redacted"),
                },
                &contract,
            )
            .unwrap(),
            _ => unreachable!(),
        };
        let record = match store.commit_execution_outcome(&outcome).unwrap() {
            OutcomeCommit::Inserted(record) => record,
            OutcomeCommit::Existing(_) => unreachable!(),
        };
        assert_eq!(record.state, expected);
        assert_eq!(
            store
                .rebuild_execution_projection(&format!("exec-state-{name}"))
                .unwrap(),
            record
        );
    }
}

#[test]
fn outcome_binding_must_match_persisted_revision_kind_fence_and_id() {
    let store = TaskStore::open_in_memory().unwrap();
    let persisted = contract("exec-binding", 1, 7);
    store.create_execution(&persisted).unwrap();
    let mut wrong_kind = persisted.as_ref().clone();
    wrong_kind.kind = "other_kind".into();
    let candidates = [
        ("revision", contract("exec-binding", 2, 7)),
        ("fence", contract("exec-binding", 1, 8)),
        (
            "kind",
            ValidatedExecutionContract::try_from(wrong_kind).unwrap(),
        ),
        ("id", contract("unknown-execution", 1, 7)),
    ];

    for (dimension, candidate) in candidates {
        let outcome = completed(&candidate, json!({"wrong": true}));
        let result = store.commit_execution_outcome(&outcome);
        assert!(
            matches!(result, Err(TaskRuntimeError::InvalidTransition(_))),
            "binding dimension {dimension} returned {result:?}"
        );
    }
}

#[test]
fn corrupt_stored_outcome_is_rejected_on_projection_read() {
    let (path, store) = file_store();
    let contract = contract("exec-corrupt-projection-outcome", 1, 1);
    store.create_execution(&contract).unwrap();
    let outcome = completed(&contract, json!({"ok": true}));
    store.commit_execution_outcome(&outcome).unwrap();
    let invalid = ExecutionOutcome::Failed {
        failure: ExecutionFailure::permanent(" ", "redacted"),
    };
    raw_connection(&path)
        .execute(
            "UPDATE executions SET outcome_json = ?1 WHERE execution_id = ?2",
            params![
                serde_json::to_string(&invalid).unwrap(),
                "exec-corrupt-projection-outcome"
            ],
        )
        .unwrap();

    assert!(matches!(
        store.execution("exec-corrupt-projection-outcome"),
        Err(TaskRuntimeError::Store(_))
    ));

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn schema_constraints_reject_invalid_projection_event_and_wake_rows() {
    let (path, store) = file_store();
    let contract = contract("exec-constraints", 1, 1);
    store.create_execution(&contract).unwrap();
    let connection = raw_connection(&path);

    for sql in [
        "UPDATE executions SET revision = 0 WHERE execution_id = 'exec-constraints'",
        "UPDATE executions SET fencing_token = 0 WHERE execution_id = 'exec-constraints'",
        "UPDATE executions SET state = 'bogus' WHERE execution_id = 'exec-constraints'",
        "UPDATE executions SET state = 'completed' WHERE execution_id = 'exec-constraints'",
        "UPDATE executions SET outcome_json = '{}' WHERE execution_id = 'exec-constraints'",
        "UPDATE executions SET outcome_json = '{}', outcome_committed_at = 1 WHERE execution_id = 'exec-constraints'",
        "UPDATE execution_events SET revision = 0 WHERE execution_id = 'exec-constraints'",
        "UPDATE execution_events SET seq = 0 WHERE execution_id = 'exec-constraints'",
        "UPDATE execution_events SET kind = ' ' WHERE execution_id = 'exec-constraints'",
    ] {
        assert!(
            connection.execute(sql, []).is_err(),
            "constraint accepted: {sql}"
        );
    }

    for (dedup, status, delivery, delivered_at, revision) in [
        ("key", "pending", None, None, 2_i64),
        (" ", "pending", None, None, 1),
        ("key", " ", None, None, 1),
        ("key", "pending", Some("{}"), None, 1),
        ("key", "pending", None, Some(2_i64), 1),
        ("key", "pending", Some("{}"), Some(0_i64), 1),
    ] {
        assert!(
            connection
                .execute(
                    "INSERT INTO execution_wakes (
                        execution_id, revision, dedup_key, condition_json, status,
                        delivery_json, created_at, delivered_at
                     ) VALUES ('exec-constraints', ?1, ?2, '{}', ?3, ?4, 1, ?5)",
                    params![revision, dedup, status, delivery, delivered_at],
                )
                .is_err()
        );
    }

    drop(connection);
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn populated_v11_database_migrates_to_constrained_v12() {
    let (path, seed) = file_store();
    let task = TaskRecord::new(
        "legacy-task",
        UserId::new("user"),
        WorkspaceId::new("workspace"),
        "legacy",
        "Legacy task",
        json!({"preserved": true}),
    );
    seed.insert_task(&task).unwrap();
    drop(seed);
    let connection = raw_connection(&path);
    connection
        .execute_batch(
            "DROP TABLE execution_wakes;
             DROP TABLE execution_events;
             DROP TABLE executions;
             UPDATE task_runtime_metadata SET value = '11' WHERE key = 'schema_version';",
        )
        .unwrap();
    drop(connection);

    let migrated = TaskStore::open(&path).unwrap();
    assert_eq!(migrated.schema_version().unwrap(), 12);
    assert!(
        migrated
            .get_task(
                &task.task_id,
                &UserId::new("user"),
                &WorkspaceId::new("workspace")
            )
            .unwrap()
            .is_some()
    );
    let connection = raw_connection(&path);
    assert!(
        connection
            .execute(
                "INSERT INTO executions (
                execution_id, kind, revision, fencing_token, state, user_id, workspace_id,
                contract_json, created_at, updated_at
             ) VALUES ('invalid', 'kind', 0, 1, 'ready', 'u', 'w', '{}', 1, 1)",
                [],
            )
            .is_err()
    );

    drop(connection);
    drop(migrated);
    let _ = std::fs::remove_file(path);
}

#[test]
fn competing_different_outcomes_commit_exactly_one() {
    let (path, seed) = file_store();
    let contract = contract("exec-race-different", 1, 1);
    seed.create_execution(&contract).unwrap();
    drop(seed);
    let first = completed(&contract, json!({"winner": 1}));
    let second = completed(&contract, json!({"winner": 2}));
    let barrier = Arc::new(Barrier::new(3));
    let store_a = TaskStore::open(&path).unwrap();
    let store_b = TaskStore::open(&path).unwrap();
    let barrier_a = Arc::clone(&barrier);
    let barrier_b = Arc::clone(&barrier);
    let thread_a = thread::spawn(move || {
        barrier_a.wait();
        store_a.commit_execution_outcome(&first)
    });
    let thread_b = thread::spawn(move || {
        barrier_b.wait();
        store_b.commit_execution_outcome(&second)
    });
    barrier.wait();
    let results = [thread_a.join().unwrap(), thread_b.join().unwrap()];

    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Ok(OutcomeCommit::Inserted(_))))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(TaskRuntimeError::InvalidTransition(_))))
            .count(),
        1
    );
    let store = TaskStore::open(&path).unwrap();
    assert_eq!(
        store
            .execution_events("exec-race-different", 1)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        store
            .execution("exec-race-different")
            .unwrap()
            .unwrap()
            .state,
        ExecutionState::Completed
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn concurrent_same_outcome_is_inserted_once_and_existing_once() {
    let (path, seed) = file_store();
    let contract = contract("exec-race-same", 1, 1);
    seed.create_execution(&contract).unwrap();
    drop(seed);
    let outcome = completed(&contract, json!({"same": true}));
    let barrier = Arc::new(Barrier::new(3));
    let store_a = TaskStore::open(&path).unwrap();
    let store_b = TaskStore::open(&path).unwrap();
    let barrier_a = Arc::clone(&barrier);
    let barrier_b = Arc::clone(&barrier);
    let outcome_b = outcome.clone();
    let thread_a = thread::spawn(move || {
        barrier_a.wait();
        store_a.commit_execution_outcome(&outcome)
    });
    let thread_b = thread::spawn(move || {
        barrier_b.wait();
        store_b.commit_execution_outcome(&outcome_b)
    });
    barrier.wait();
    let results = [thread_a.join().unwrap(), thread_b.join().unwrap()];

    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Ok(OutcomeCommit::Inserted(_))))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Ok(OutcomeCommit::Existing(_))))
            .count(),
        1
    );
    let store = TaskStore::open(&path).unwrap();
    assert_eq!(
        store.execution_events("exec-race-same", 1).unwrap().len(),
        2
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn concurrent_same_revision_start_is_inserted_once_and_existing_once() {
    let (path, seed) = file_store();
    let revision_one = contract("exec-race-revision-same", 1, 1);
    seed.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    seed.commit_execution_outcome(&suspended).unwrap();
    let revision_two = next_revision(&revision_one, &suspended, 2);
    drop(seed);

    let barrier = Arc::new(Barrier::new(3));
    let store_a = TaskStore::open(&path).unwrap();
    let store_b = TaskStore::open(&path).unwrap();
    let barrier_a = Arc::clone(&barrier);
    let barrier_b = Arc::clone(&barrier);
    let revision_two_b = revision_two.clone();
    let thread_a = thread::spawn(move || {
        barrier_a.wait();
        store_a.start_execution_revision(&revision_two)
    });
    let thread_b = thread::spawn(move || {
        barrier_b.wait();
        store_b.start_execution_revision(&revision_two_b)
    });
    barrier.wait();
    let results = [thread_a.join().unwrap(), thread_b.join().unwrap()];

    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Ok(StartExecutionRevision::Inserted(_))))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Ok(StartExecutionRevision::Existing(_))))
            .count(),
        1
    );
    let store = TaskStore::open(&path).unwrap();
    assert_eq!(
        store
            .execution_events("exec-race-revision-same", 2)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .execution("exec-race-revision-same")
            .unwrap()
            .unwrap()
            .contract
            .as_ref()
            .revision,
        2
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn concurrent_conflicting_revision_starts_serialize_to_one_contract() {
    let (path, seed) = file_store();
    let revision_one = contract("exec-race-revision-conflict", 1, 1);
    seed.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    seed.commit_execution_outcome(&suspended).unwrap();
    let first = next_revision(&revision_one, &suspended, 2);
    let mut second = first.as_ref().clone();
    second.input = json!({"prompt": "conflicting retry"});
    let second = ValidatedExecutionContract::try_from(second).unwrap();
    drop(seed);

    let barrier = Arc::new(Barrier::new(3));
    let store_a = TaskStore::open(&path).unwrap();
    let store_b = TaskStore::open(&path).unwrap();
    let barrier_a = Arc::clone(&barrier);
    let barrier_b = Arc::clone(&barrier);
    let thread_a = thread::spawn(move || {
        barrier_a.wait();
        store_a.start_execution_revision(&first)
    });
    let thread_b = thread::spawn(move || {
        barrier_b.wait();
        store_b.start_execution_revision(&second)
    });
    barrier.wait();
    let results = [thread_a.join().unwrap(), thread_b.join().unwrap()];

    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Ok(StartExecutionRevision::Inserted(_))))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(TaskRuntimeError::Conflict(_))))
            .count(),
        1
    );
    let store = TaskStore::open(&path).unwrap();
    assert_eq!(
        store
            .execution_events("exec-race-revision-conflict", 2)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .execution("exec-race-revision-conflict")
            .unwrap()
            .unwrap()
            .contract
            .as_ref()
            .revision,
        2
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn fence_and_outcome_race_leaves_one_valid_journal_projection() {
    let (path, seed) = file_store();
    let contract = contract("exec-race-fence", 1, 1);
    seed.create_execution(&contract).unwrap();
    drop(seed);
    let outcome = completed(&contract, json!({"old_fence": true}));
    let barrier = Arc::new(Barrier::new(3));
    let fence_store = TaskStore::open(&path).unwrap();
    let outcome_store = TaskStore::open(&path).unwrap();
    let fence_barrier = Arc::clone(&barrier);
    let outcome_barrier = Arc::clone(&barrier);
    let fence_thread = thread::spawn(move || {
        fence_barrier.wait();
        fence_store.advance_execution_fence("exec-race-fence", 1, 1, 2)
    });
    let outcome_thread = thread::spawn(move || {
        outcome_barrier.wait();
        outcome_store.commit_execution_outcome(&outcome)
    });
    barrier.wait();
    let fence_result = fence_thread.join().unwrap();
    let outcome_result = outcome_thread.join().unwrap();

    let store = TaskStore::open(&path).unwrap();
    let projected = store.execution("exec-race-fence").unwrap().unwrap();
    let events = store.execution_events("exec-race-fence", 1).unwrap();
    assert_eq!(events.len(), 2);
    match (fence_result, outcome_result) {
        (Ok(fenced), Err(TaskRuntimeError::InvalidTransition(_))) => {
            assert_eq!(projected, fenced);
            assert_eq!(projected.state, ExecutionState::Ready);
            assert_eq!(projected.contract.as_ref().fencing_token, 2);
            assert!(matches!(
                events[1].event,
                ExecutionJournalEvent::FenceAdvanced { .. }
            ));
        }
        (Err(TaskRuntimeError::InvalidTransition(_)), Ok(OutcomeCommit::Inserted(committed))) => {
            assert_eq!(projected, committed);
            assert_eq!(projected.state, ExecutionState::Completed);
            assert!(matches!(
                events[1].event,
                ExecutionJournalEvent::OutcomeCommitted { .. }
            ));
        }
        other => panic!("unexpected race result: {other:?}"),
    }
    assert_eq!(
        store
            .rebuild_execution_projection("exec-race-fence")
            .unwrap(),
        projected
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}
