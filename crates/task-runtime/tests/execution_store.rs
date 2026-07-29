use local_first_execution_protocol::{
    ApprovalPolicy, CancelReason, CheckpointDataRef, CheckpointEnvelope, CheckpointRef,
    DurableDataRef, EffectClass, ExecutionContract, ExecutionFailure, ExecutionOutcome,
    ExecutionScope, ExecutionState, ObjectiveRef, ResourceRequirement, ValidatedExecutionContract,
    ValidatedExecutionOutcome, WakeCondition, WakeDelivery,
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
        delivered_at_unix_seconds: time::OffsetDateTime::now_utc().unix_timestamp(),
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

fn raw_event_rows(
    connection: &Connection,
    execution_id: &str,
) -> Vec<(i64, i64, i64, String, String, i64)> {
    let mut statement = connection
        .prepare(
            "SELECT event_id, revision, seq, kind, payload_json, created_at
             FROM execution_events WHERE execution_id = ?1
             ORDER BY revision, seq, event_id",
        )
        .unwrap();
    statement
        .query_map([execution_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn insert_delivered_wake(
    path: &Path,
    suspension: &ValidatedExecutionOutcome,
    next: &ValidatedExecutionContract,
) {
    let (wake, revision, execution_id) = match suspension.as_ref() {
        ExecutionOutcome::Suspended { wake, checkpoint } => {
            (wake, checkpoint.revision, checkpoint.execution_id.as_str())
        }
        _ => panic!("delivered wake requires a suspended outcome"),
    };
    let delivery = next
        .as_ref()
        .wake
        .as_ref()
        .expect("next revision must contain a wake delivery");
    let connection = raw_connection(path);
    let suspended_at = connection
        .query_row(
            "SELECT created_at FROM execution_events
             WHERE execution_id = ?1 AND revision = ?2 AND kind = 'outcome_committed'",
            params![execution_id, i64::try_from(revision).unwrap()],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    connection
        .execute(
            "UPDATE execution_wakes
             SET status = 'delivered', delivery_json = ?1, delivered_at = ?2
             WHERE execution_id = ?3 AND revision = ?4 AND dedup_key = ?5
               AND condition_json = ?6 AND status = 'pending'
               AND delivery_json IS NULL AND delivered_at IS NULL AND created_at = ?7",
            params![
                serde_json::to_string(delivery).unwrap(),
                delivery.delivered_at_unix_seconds,
                execution_id,
                i64::try_from(revision).unwrap(),
                wake.dedup_key(),
                serde_json::to_string(wake).unwrap(),
                suspended_at,
            ],
        )
        .unwrap();
    let event = ExecutionJournalEvent::WakeDelivered {
        version: 1,
        delivery: delivery.clone(),
        next_revision: revision + 1,
    };
    connection
        .execute(
            "INSERT INTO execution_events (
                execution_id, revision, seq, kind, payload_json, created_at
             ) VALUES (
                ?1, ?2,
                (SELECT COALESCE(MAX(seq), 0) + 1 FROM execution_events
                 WHERE execution_id = ?1 AND revision = ?2),
                'wake_delivered', ?3, ?4
             )",
            params![
                execution_id,
                i64::try_from(revision).unwrap(),
                serde_json::to_string(&event).unwrap(),
                delivery.delivered_at_unix_seconds,
            ],
        )
        .unwrap();
}

struct InitialV12Fixture {
    expected: ExecutionRecord,
    wake: (
        String,
        i64,
        String,
        String,
        String,
        Option<String>,
        i64,
        Option<i64>,
    ),
    malformed_payload: String,
}

fn install_initial_v12_fixture(path: &Path, malformed_fence: bool) -> InitialV12Fixture {
    let original = contract("exec-initial-v12", 1, 7);
    let mut latest_raw = original.as_ref().clone();
    latest_raw.fencing_token = 8;
    let latest = ValidatedExecutionContract::try_from(latest_raw).unwrap();
    let outcome = completed(&latest, json!({"migrated": true}));
    let created_at = 100_i64;
    let fence_at = 101_i64;
    let outcome_at = 102_i64;
    let fence_payload = if malformed_fence {
        json!({"expected": 7})
    } else {
        json!({"expected": 7, "next": 8})
    };
    let wake = (
        "exec-initial-v12".to_string(),
        1_i64,
        "legacy-wake-key".to_string(),
        serde_json::to_string(&WakeCondition::Signal {
            kind: "legacy.signal".into(),
            correlation_id: "legacy-correlation".into(),
        })
        .unwrap(),
        "pending".to_string(),
        None,
        99_i64,
        None,
    );

    let connection = raw_connection(path);
    connection
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             DROP TABLE execution_wakes;
             DROP TABLE execution_events;
             DROP TABLE executions;
             CREATE TABLE executions (
                execution_id TEXT PRIMARY KEY,
                parent_execution_id TEXT,
                kind TEXT NOT NULL,
                revision INTEGER NOT NULL,
                fencing_token INTEGER NOT NULL,
                state TEXT NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                thread_id TEXT,
                contract_json TEXT NOT NULL,
                outcome_json TEXT,
                outcome_committed_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE TABLE execution_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                execution_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                seq INTEGER NOT NULL,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(execution_id, revision, seq),
                FOREIGN KEY(execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE
             );
             CREATE TABLE execution_wakes (
                execution_id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                dedup_key TEXT NOT NULL,
                condition_json TEXT NOT NULL,
                status TEXT NOT NULL,
                delivery_json TEXT,
                created_at INTEGER NOT NULL,
                delivered_at INTEGER,
                PRIMARY KEY(execution_id, revision, dedup_key),
                FOREIGN KEY(execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE
             );
             UPDATE task_runtime_metadata SET value = '12' WHERE key = 'schema_version';
             PRAGMA foreign_keys=ON;",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO executions (
                execution_id, parent_execution_id, kind, revision, fencing_token, state,
                user_id, workspace_id, thread_id, contract_json, outcome_json,
                outcome_committed_at, created_at, updated_at
             ) VALUES (?1, NULL, ?2, 1, 8, 'completed', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                latest.as_ref().execution_id,
                latest.as_ref().kind,
                latest.as_ref().scope.user_id,
                latest.as_ref().scope.workspace_id,
                latest.as_ref().scope.thread_id,
                serde_json::to_string(latest.as_ref()).unwrap(),
                serde_json::to_string(outcome.as_ref()).unwrap(),
                outcome_at,
                created_at,
                outcome_at,
            ],
        )
        .unwrap();
    for (seq, kind, payload, timestamp) in [
        (
            1_i64,
            "execution_created",
            json!({"state": "ready"}),
            created_at,
        ),
        (2, "fence_advanced", fence_payload.clone(), fence_at),
        (
            3,
            "outcome_committed",
            json!({"state": "completed"}),
            outcome_at,
        ),
    ] {
        connection
            .execute(
                "INSERT INTO execution_events (
                    execution_id, revision, seq, kind, payload_json, created_at
                 ) VALUES ('exec-initial-v12', 1, ?1, ?2, ?3, ?4)",
                params![
                    seq,
                    kind,
                    serde_json::to_string(&payload).unwrap(),
                    timestamp
                ],
            )
            .unwrap();
    }
    connection
        .execute(
            "INSERT INTO execution_wakes (
                execution_id, revision, dedup_key, condition_json, status,
                delivery_json, created_at, delivered_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                wake.0, wake.1, wake.2, wake.3, wake.4, wake.5, wake.6, wake.7
            ],
        )
        .unwrap();

    InitialV12Fixture {
        expected: ExecutionRecord {
            contract: latest,
            state: ExecutionState::Completed,
            outcome: Some(outcome),
            created_at,
            updated_at: outcome_at,
        },
        wake,
        malformed_payload: serde_json::to_string(&fence_payload).unwrap(),
    }
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
    let (path, store) = file_store();
    let revision_one = contract("exec-multi-revision", 1, 2);
    store.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    store.commit_execution_outcome(&suspended).unwrap();
    let revision_two = next_revision(&revision_one, &suspended, 3);
    insert_delivered_wake(&path, &suspended, &revision_two);

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
        vec![1, 2, 3]
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
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn create_and_revision_start_retries_return_the_latest_projection() {
    let (path, store) = file_store();
    let revision_one = contract("exec-multi-retry", 1, 1);
    store.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    store.commit_execution_outcome(&suspended).unwrap();
    let revision_two = next_revision(&revision_one, &suspended, 2);
    insert_delivered_wake(&path, &suspended, &revision_two);
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
        3
    );
    assert_eq!(
        store.execution_events("exec-multi-retry", 2).unwrap().len(),
        1
    );
    drop(store);
    let _ = std::fs::remove_file(path);
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
fn revision_start_rejects_each_immutable_contract_field_change() {
    for (index, field) in [
        "objective",
        "input",
        "allowed effects",
        "approval policy",
        "resources",
        "budget",
    ]
    .into_iter()
    .enumerate()
    {
        let (path, store) = file_store();
        let execution_id = format!("exec-immutable-revision-fields-{index}");
        let revision_one = contract(&execution_id, 1, 4);
        store.create_execution(&revision_one).unwrap();
        let suspended = suspended(&revision_one);
        store.commit_execution_outcome(&suspended).unwrap();
        let valid = next_revision(&revision_one, &suspended, 5);
        insert_delivered_wake(&path, &suspended, &valid);
        let mut candidate = valid.as_ref().clone();
        match field {
            "objective" => {
                candidate.objective = Some(ObjectiveRef {
                    thread_id: "thread-1".into(),
                    revision: 2,
                });
            }
            "input" => candidate.input = json!({"prompt": "changed"}),
            "allowed effects" => {
                candidate.policy.allowed_effects = vec![EffectClass::FilesystemWrite];
            }
            "approval policy" => {
                candidate.policy.approval_policy = ApprovalPolicy::OnRequest;
            }
            "resources" => {
                candidate.resources = vec![ResourceRequirement {
                    class: "browser".into(),
                    units: 1,
                }];
            }
            "budget" => candidate.budget.max_attempts = 2,
            _ => unreachable!(),
        }
        let candidate = ValidatedExecutionContract::try_from(candidate).unwrap();
        assert!(
            matches!(
                store.start_execution_revision(&candidate),
                Err(TaskRuntimeError::InvalidTransition(_))
            ),
            "revision start accepted changed {field}"
        );
        assert!(matches!(
            store.execution_events(&execution_id, 2),
            Err(TaskRuntimeError::NotFound(_))
        ));
        drop(store);
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn revision_start_rejects_unauthenticated_wake_history() {
    for case in [
        "missing",
        "pending",
        "wrong delivery",
        "wrong timestamp",
        "wrong condition",
        "before suspension",
    ] {
        let (path, store) = file_store();
        let execution_id = format!("exec-wake-auth-{}", case.replace(' ', "-"));
        let revision_one = contract(&execution_id, 1, 4);
        store.create_execution(&revision_one).unwrap();
        let suspended = suspended(&revision_one);
        store.commit_execution_outcome(&suspended).unwrap();
        let mut revision_two = next_revision(&revision_one, &suspended, 5);

        if case != "missing" && case != "before suspension" {
            insert_delivered_wake(&path, &suspended, &revision_two);
        }
        let connection = raw_connection(&path);
        match case {
            "missing" => {}
            "pending" => {
                connection
                    .execute(
                        "UPDATE execution_wakes SET status = 'pending' WHERE execution_id = ?1",
                        [&execution_id],
                    )
                    .unwrap();
            }
            "wrong delivery" => {
                let mut delivery = revision_two.as_ref().wake.as_ref().unwrap().clone();
                delivery.payload = json!({"signal": "forged"});
                connection
                    .execute(
                        "UPDATE execution_wakes SET delivery_json = ?1 WHERE execution_id = ?2",
                        params![serde_json::to_string(&delivery).unwrap(), execution_id],
                    )
                    .unwrap();
            }
            "wrong timestamp" => {
                connection
                    .execute(
                        "UPDATE execution_wakes SET delivered_at = delivered_at + 1
                         WHERE execution_id = ?1",
                        [&execution_id],
                    )
                    .unwrap();
            }
            "wrong condition" => {
                let other = WakeCondition::User {
                    wait_ref: "forged-wait".into(),
                };
                connection
                    .execute(
                        "UPDATE execution_wakes SET condition_json = ?1 WHERE execution_id = ?2",
                        params![serde_json::to_string(&other).unwrap(), execution_id],
                    )
                    .unwrap();
            }
            "before suspension" => {
                let suspended_at = connection
                    .query_row(
                        "SELECT created_at FROM execution_events
                         WHERE execution_id = ?1 AND revision = 1 AND kind = 'outcome_committed'",
                        [&execution_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap();
                let raw = revision_two.as_ref().clone();
                let mut delivery = raw.wake.clone().unwrap();
                delivery.delivered_at_unix_seconds = suspended_at - 1;
                let mut raw = raw;
                raw.wake = Some(delivery.clone());
                revision_two = ValidatedExecutionContract::try_from(raw).unwrap();
                let wake = match suspended.as_ref() {
                    ExecutionOutcome::Suspended { wake, .. } => wake,
                    _ => unreachable!(),
                };
                connection
                    .execute(
                        "UPDATE execution_wakes
                         SET status = 'delivered', delivery_json = ?1, delivered_at = ?2,
                             created_at = ?2 - 1
                         WHERE execution_id = ?3 AND revision = 1 AND dedup_key = ?4",
                        params![
                            serde_json::to_string(&delivery).unwrap(),
                            suspended_at - 1,
                            execution_id,
                            wake.dedup_key(),
                        ],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        drop(connection);

        assert!(
            matches!(
                store.start_execution_revision(&revision_two),
                Err(TaskRuntimeError::InvalidTransition(_))
            ),
            "revision start accepted {case} wake history"
        );
        assert!(matches!(
            store.execution_events(&execution_id, 2),
            Err(TaskRuntimeError::NotFound(_))
        ));
        drop(store);
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn revision_start_accepts_exact_delivered_wake_and_retries_idempotently() {
    let (path, store) = file_store();
    let revision_one = contract("exec-authenticated-revision", 1, 4);
    store.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    store.commit_execution_outcome(&suspended).unwrap();
    let revision_two = next_revision(&revision_one, &suspended, 5);
    insert_delivered_wake(&path, &suspended, &revision_two);

    assert!(matches!(
        store.start_execution_revision(&revision_two).unwrap(),
        StartExecutionRevision::Inserted(_)
    ));
    assert!(matches!(
        store.start_execution_revision(&revision_two).unwrap(),
        StartExecutionRevision::Existing(_)
    ));
    assert_eq!(
        store
            .execution_events("exec-authenticated-revision", 2)
            .unwrap()
            .len(),
        1
    );

    drop(store);
    let _ = std::fs::remove_file(path);
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
    insert_delivered_wake(&path, &suspended, &revision_two);
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
        3
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
fn execution_repairs_an_internally_valid_stale_projection_from_latest_journal() {
    let (path, store) = file_store();
    let revision_one = contract("exec-stale-valid-projection", 1, 1);
    store.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    let revision_one_record = match store.commit_execution_outcome(&suspended).unwrap() {
        OutcomeCommit::Inserted(record) => record,
        OutcomeCommit::Existing(_) => unreachable!(),
    };
    let revision_two = next_revision(&revision_one, &suspended, 2);
    insert_delivered_wake(&path, &suspended, &revision_two);
    let latest = match store.start_execution_revision(&revision_two).unwrap() {
        StartExecutionRevision::Inserted(record) => record,
        StartExecutionRevision::Existing(_) => unreachable!(),
    };
    let revision_one_outcome_at = raw_connection(&path)
        .query_row(
            "SELECT created_at FROM execution_events
             WHERE execution_id = 'exec-stale-valid-projection' AND revision = 1
               AND kind = 'outcome_committed'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    raw_connection(&path)
        .execute(
            "UPDATE executions
             SET revision = 1,
                 fencing_token = 1,
                 state = 'suspended',
                 contract_json = ?1,
                 outcome_json = ?2,
                 outcome_committed_at = ?3,
                 created_at = ?4,
                 updated_at = ?3
             WHERE execution_id = 'exec-stale-valid-projection'",
            params![
                serde_json::to_string(revision_one.as_ref()).unwrap(),
                serde_json::to_string(suspended.as_ref()).unwrap(),
                revision_one_outcome_at,
                revision_one_record.created_at,
            ],
        )
        .unwrap();

    assert_eq!(
        store.execution("exec-stale-valid-projection").unwrap(),
        Some(latest.clone())
    );
    let connection = raw_connection(&path);
    assert_eq!(
        connection
            .query_row(
                "SELECT revision FROM executions
                 WHERE execution_id = 'exec-stale-valid-projection'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        2
    );
    drop(connection);

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn historical_wake_survives_revision_start_and_projection_rebuild() {
    let (path, store) = file_store();
    let revision_one = contract("exec-wake-history", 1, 1);
    store.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    store.commit_execution_outcome(&suspended).unwrap();
    let revision_two = next_revision(&revision_one, &suspended, 2);
    let delivery = revision_two.as_ref().wake.as_ref().unwrap();
    let wake = match suspended.as_ref() {
        ExecutionOutcome::Suspended { wake, .. } => wake,
        _ => unreachable!(),
    };
    let connection = raw_connection(&path);
    let suspended_at = connection
        .query_row(
            "SELECT created_at FROM execution_events
             WHERE execution_id = 'exec-wake-history' AND revision = 1
               AND kind = 'outcome_committed'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    let expected = (
        wake.dedup_key(),
        serde_json::to_string(wake).unwrap(),
        "delivered".to_string(),
        serde_json::to_string(delivery).unwrap(),
        suspended_at,
        delivery.delivered_at_unix_seconds,
    );
    drop(connection);
    insert_delivered_wake(&path, &suspended, &revision_two);
    let connection = raw_connection(&path);

    store.start_execution_revision(&revision_two).unwrap();
    assert_eq!(
        store
            .execution("exec-wake-history")
            .unwrap()
            .unwrap()
            .contract
            .as_ref()
            .revision,
        2
    );
    let load_wake = || {
        connection.query_row(
            "SELECT dedup_key, condition_json, status, delivery_json, created_at, delivered_at
             FROM execution_wakes WHERE execution_id = ?1 AND revision = 1",
            ["exec-wake-history"],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
    };
    assert_eq!(load_wake().unwrap(), expected);

    connection
        .execute(
            "DELETE FROM executions WHERE execution_id = ?1",
            ["exec-wake-history"],
        )
        .unwrap();
    assert_eq!(load_wake().unwrap(), expected);
    let rebuilt = store
        .rebuild_execution_projection("exec-wake-history")
        .unwrap();
    assert_eq!(rebuilt.contract.as_ref().revision, 2);
    assert_eq!(load_wake().unwrap(), expected);

    drop(connection);
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn stale_prior_revision_outcome_never_rewrites_the_latest_projection() {
    let (path, store) = file_store();
    let revision_one = contract("exec-stale-prior-outcome", 1, 1);
    store.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    store.commit_execution_outcome(&suspended).unwrap();
    let revision_two = next_revision(&revision_one, &suspended, 2);
    insert_delivered_wake(&path, &suspended, &revision_two);
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
        3
    );
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn journal_fold_revalidates_revision_start_transition_data() {
    let (path, store) = file_store();
    let revision_one = contract("exec-corrupt-revision-start", 1, 1);
    store.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    store.commit_execution_outcome(&suspended).unwrap();
    let revision_two = next_revision(&revision_one, &suspended, 2);
    insert_delivered_wake(&path, &suspended, &revision_two);
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
        ("key", "pending", None, None, 0_i64),
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
fn populated_v11_database_migrates_to_current_schema() {
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
    assert_eq!(migrated.schema_version().unwrap(), 15);
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
    let wake_foreign_keys: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('execution_wakes')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(wake_foreign_keys, 0);
    connection
        .execute(
            "INSERT INTO execution_wakes (
                execution_id, revision, dedup_key, condition_json, status,
                delivery_json, created_at, delivered_at
             ) VALUES ('historical', 1, 'wake-key', '{}', 'pending', NULL, 1, NULL)",
            [],
        )
        .unwrap();
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
fn initial_v12_execution_tables_migrate_to_current_schema() {
    let (path, seed) = file_store();
    drop(seed);
    let fixture = install_initial_v12_fixture(&path, false);

    let migrated = TaskStore::open(&path).unwrap();
    assert_eq!(migrated.schema_version().unwrap(), 15);
    let events = migrated.execution_events("exec-initial-v12", 1).unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| (event.seq, event.created_at))
            .collect::<Vec<_>>(),
        vec![(1, 100), (2, 101), (3, 102)]
    );
    assert!(matches!(
        &events[0].event,
        ExecutionJournalEvent::Created { contract, .. }
            if contract.fencing_token == 7
    ));
    assert!(matches!(
        &events[1].event,
        ExecutionJournalEvent::FenceAdvanced {
            previous_fencing_token: 7,
            contract,
            ..
        } if contract.fencing_token == 8
    ));
    assert!(matches!(
        &events[2].event,
        ExecutionJournalEvent::OutcomeCommitted {
            state: ExecutionState::Completed,
            outcome,
            ..
        } if outcome == fixture.expected.outcome.as_ref().unwrap().as_ref()
    ));
    assert_eq!(
        migrated.execution("exec-initial-v12").unwrap(),
        Some(fixture.expected.clone())
    );

    let connection = raw_connection(&path);
    for table in ["executions", "execution_events", "execution_wakes"] {
        assert_eq!(
            connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM pragma_foreign_key_list('{table}')"),
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "{table} retained projection ownership"
        );
    }
    let wake = connection
        .query_row(
            "SELECT execution_id, revision, dedup_key, condition_json, status,
                    delivery_json, created_at, delivered_at
             FROM execution_wakes WHERE execution_id = 'exec-initial-v12'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(wake, fixture.wake);
    assert!(
        connection
            .execute(
                "UPDATE executions SET revision = 0 WHERE execution_id = 'exec-initial-v12'",
                [],
            )
            .is_err()
    );
    assert!(
        connection
            .execute(
                "UPDATE execution_events SET kind = ' ' WHERE execution_id = 'exec-initial-v12'",
                [],
            )
            .is_err()
    );
    assert!(
        connection
            .execute(
                "UPDATE execution_wakes SET status = ' ' WHERE execution_id = 'exec-initial-v12'",
                [],
            )
            .is_err()
    );
    connection
        .execute(
            "DELETE FROM executions WHERE execution_id = 'exec-initial-v12'",
            [],
        )
        .unwrap();
    drop(connection);
    assert_eq!(
        migrated
            .rebuild_execution_projection("exec-initial-v12")
            .unwrap(),
        fixture.expected
    );

    drop(migrated);
    let _ = std::fs::remove_file(path);
}

#[test]
fn malformed_initial_v12_event_aborts_migration_without_dropping_data() {
    let (path, seed) = file_store();
    drop(seed);
    let fixture = install_initial_v12_fixture(&path, true);

    assert!(matches!(
        TaskStore::open(&path),
        Err(TaskRuntimeError::Store(_))
    ));
    let connection = raw_connection(&path);
    assert_eq!(
        connection
            .query_row(
                "SELECT value FROM task_runtime_metadata WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "12"
    );
    for table in ["execution_events", "execution_wakes"] {
        assert!(
            connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM pragma_foreign_key_list('{table}')"),
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
                > 0,
            "{table} was replaced despite failed migration"
        );
    }
    assert_eq!(
        connection
            .query_row(
                "SELECT payload_json FROM execution_events
                 WHERE execution_id = 'exec-initial-v12' AND seq = 2",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        fixture.malformed_payload
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM executions", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM execution_events", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM execution_wakes", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );

    drop(connection);
    let _ = std::fs::remove_file(path);
}

#[test]
fn legacy_v12_wake_foreign_key_is_migrated_without_data_loss() {
    let (path, store) = file_store();
    let revision_one = contract("exec-legacy-wake-migration", 1, 1);
    store.create_execution(&revision_one).unwrap();
    let suspended = suspended(&revision_one);
    store.commit_execution_outcome(&suspended).unwrap();
    let revision_two = next_revision(&revision_one, &suspended, 2);
    let wake = match suspended.as_ref() {
        ExecutionOutcome::Suspended { wake, .. } => wake,
        _ => unreachable!(),
    };
    let delivery = revision_two.as_ref().wake.as_ref().unwrap();
    let connection = raw_connection(&path);
    let expected_events = raw_event_rows(&connection, "exec-legacy-wake-migration");
    let suspended_at = connection
        .query_row(
            "SELECT created_at FROM execution_events
             WHERE execution_id = 'exec-legacy-wake-migration' AND revision = 1
               AND kind = 'outcome_committed'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    let expected = (
        "exec-legacy-wake-migration".to_string(),
        1_i64,
        wake.dedup_key(),
        serde_json::to_string(wake).unwrap(),
        "delivered".to_string(),
        serde_json::to_string(delivery).unwrap(),
        suspended_at,
        delivery.delivered_at_unix_seconds,
    );
    drop(store);

    connection
        .execute_batch(
            "DROP TABLE execution_wakes;
             CREATE TABLE execution_wakes (
                execution_id TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK(revision > 0),
                dedup_key TEXT NOT NULL CHECK(length(trim(dedup_key)) > 0),
                condition_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK(length(trim(status)) > 0),
                delivery_json TEXT,
                created_at INTEGER NOT NULL,
                delivered_at INTEGER,
                PRIMARY KEY(execution_id, revision, dedup_key),
                FOREIGN KEY(execution_id, revision)
                    REFERENCES executions(execution_id, revision) ON DELETE CASCADE,
                CHECK(
                    (delivery_json IS NULL AND delivered_at IS NULL)
                    OR (delivery_json IS NOT NULL AND delivered_at IS NOT NULL)
                ),
                CHECK(delivered_at IS NULL OR delivered_at >= created_at)
             );",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO execution_wakes (
                execution_id, revision, dedup_key, condition_json, status,
                delivery_json, created_at, delivered_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                expected.0, expected.1, expected.2, expected.3, expected.4, expected.5, expected.6,
                expected.7,
            ],
        )
        .unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_list('execution_wakes')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        2
    );
    drop(connection);

    let migrated = TaskStore::open(&path).unwrap();
    assert_eq!(migrated.schema_version().unwrap(), 15);
    let connection = raw_connection(&path);
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_list('execution_wakes')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    let migrated_events = raw_event_rows(&connection, "exec-legacy-wake-migration");
    assert_eq!(&migrated_events[..2], expected_events.as_slice());
    assert_eq!(migrated_events[2].1, 1);
    assert_eq!(migrated_events[2].2, 3);
    assert_eq!(migrated_events[2].3, "wake_delivered");
    assert_eq!(migrated_events[2].5, delivery.delivered_at_unix_seconds);
    assert!(matches!(
        serde_json::from_str::<ExecutionJournalEvent>(&migrated_events[2].4).unwrap(),
        ExecutionJournalEvent::WakeDelivered {
            delivery: stored,
            next_revision: 2,
            ..
        } if stored == *delivery
    ));
    assert_eq!(migrated_events[3].1, 2);
    assert_eq!(migrated_events[3].2, 1);
    assert_eq!(migrated_events[3].3, "revision_started");
    assert_eq!(migrated_events[3].5, delivery.delivered_at_unix_seconds);
    assert!(matches!(
        serde_json::from_str::<ExecutionJournalEvent>(&migrated_events[3].4).unwrap(),
        ExecutionJournalEvent::RevisionStarted {
            previous_revision: 1,
            contract: stored,
            ..
        } if stored == *revision_two.as_ref()
    ));
    let migrated_projection = migrated
        .execution("exec-legacy-wake-migration")
        .unwrap()
        .unwrap();
    assert_eq!(migrated_projection.contract, revision_two);
    assert_eq!(migrated_projection.state, ExecutionState::Ready);
    assert!(migrated_projection.outcome.is_none());
    let load_wake = || {
        connection.query_row(
            "SELECT execution_id, revision, dedup_key, condition_json, status,
                    delivery_json, created_at, delivered_at
             FROM execution_wakes WHERE execution_id = ?1 AND revision = 1",
            ["exec-legacy-wake-migration"],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            },
        )
    };
    assert_eq!(load_wake().unwrap(), expected);

    assert!(matches!(
        migrated.start_execution_revision(&revision_two).unwrap(),
        StartExecutionRevision::Existing(_)
    ));
    assert_eq!(
        migrated
            .execution("exec-legacy-wake-migration")
            .unwrap()
            .unwrap()
            .contract
            .as_ref()
            .revision,
        2
    );
    assert_eq!(load_wake().unwrap(), expected);
    connection
        .execute(
            "DELETE FROM executions WHERE execution_id = ?1",
            ["exec-legacy-wake-migration"],
        )
        .unwrap();
    assert_eq!(load_wake().unwrap(), expected);
    let rebuilt = migrated
        .rebuild_execution_projection("exec-legacy-wake-migration")
        .unwrap();
    assert_eq!(rebuilt.contract.as_ref().revision, 2);
    assert_eq!(load_wake().unwrap(), expected);

    drop(connection);
    drop(migrated);
    let reopened = TaskStore::open(&path).unwrap();
    let connection = raw_connection(&path);
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_list('execution_wakes')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    let preserved = connection
        .query_row(
            "SELECT execution_id, revision, dedup_key, condition_json, status,
                    delivery_json, created_at, delivered_at
             FROM execution_wakes WHERE execution_id = ?1 AND revision = 1",
            ["exec-legacy-wake-migration"],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(preserved, expected);

    drop(connection);
    drop(reopened);
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
    insert_delivered_wake(&path, &suspended, &revision_two);
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
    insert_delivered_wake(&path, &suspended, &first);
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
            .filter(|result| {
                matches!(
                    result,
                    Err(TaskRuntimeError::InvalidTransition(_) | TaskRuntimeError::Conflict(_))
                )
            })
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

#[test]
fn committed_execution_scan_returns_only_authoritative_outcomes() {
    let (path, store) = file_store();
    let pending = contract("exec-pending-scan", 1, 1);
    let committed = contract("exec-committed-scan", 1, 1);
    store.create_execution(&pending).unwrap();
    store.create_execution(&committed).unwrap();
    store
        .commit_execution_outcome(&completed(&committed, json!({"ok": true})))
        .unwrap();
    raw_connection(&path)
        .execute(
            "DELETE FROM executions WHERE execution_id = ?1",
            ["exec-committed-scan"],
        )
        .unwrap();

    let records = store.committed_executions(100).unwrap();

    assert_eq!(records.len(), 1);
    assert_eq!(
        records[0].contract.as_ref().execution_id,
        "exec-committed-scan"
    );
    assert!(records[0].outcome.is_some());

    drop(store);
    let _ = std::fs::remove_file(path);
}
