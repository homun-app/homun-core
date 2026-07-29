use local_first_execution_protocol::{
    CheckpointDataRef, CheckpointEnvelope, CheckpointRef, DurableDataRef, ExecutionContract,
    ExecutionOutcome, ExecutionScope, ExecutionState, ValidatedExecutionContract,
    ValidatedExecutionOutcome, WakeCondition, WakeDelivery,
};
use local_first_task_runtime::{
    ExecutionJournalEvent, ExecutorResult, FakeTaskExecutor, OutcomeCommit, ResourceLimits, TaskId,
    TaskRecord, TaskRuntime, TaskRuntimeError, TaskScheduler, TaskStatus, TaskStore, UserId,
    WorkspaceId,
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Barrier},
    thread,
};
use time::OffsetDateTime;
use uuid::Uuid;

const DURABLE_STORE_ID: &str = "0123456789abcdef0123456789abcdef";

fn file_store() -> (PathBuf, TaskStore) {
    let path = std::env::temp_dir().join(format!(
        "homun-execution-wake-test-{}.sqlite",
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

fn contract(execution_id: &str) -> ValidatedExecutionContract {
    ValidatedExecutionContract::try_from(ExecutionContract::new(
        execution_id,
        "chat_turn",
        ExecutionScope {
            user_id: "user-1".into(),
            workspace_id: "workspace-1".into(),
            thread_id: Some("thread-1".into()),
        },
        json!({"prompt": "hello"}),
    ))
    .unwrap()
}

fn suspended(
    contract: &ValidatedExecutionContract,
    wake: WakeCondition,
) -> ValidatedExecutionOutcome {
    let raw = contract.as_ref();
    ValidatedExecutionOutcome::new(
        ExecutionOutcome::Suspended {
            wake,
            checkpoint: CheckpointEnvelope::new(
                &raw.execution_id,
                raw.revision,
                &raw.kind,
                7,
                CheckpointDataRef::Public {
                    record_ref: DurableDataRef::from_store_id(DURABLE_STORE_ID).unwrap(),
                },
            ),
        },
        contract,
    )
    .unwrap()
}

fn suspend_execution(store: &TaskStore, execution_id: &str, wake: WakeCondition) {
    let contract = contract(execution_id);
    store.create_execution(&contract).unwrap();
    store
        .commit_execution_outcome(&suspended(&contract, wake))
        .unwrap();
}

fn at(unix_seconds: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(unix_seconds).unwrap()
}

#[test]
fn suspended_outcome_registers_one_canonical_pending_wake_and_retry_verifies_it() {
    let (path, store) = file_store();
    let contract = contract("exec-register-wake");
    store.create_execution(&contract).unwrap();
    let wake = WakeCondition::Signal {
        kind: "connector.message".into(),
        correlation_id: "message-1".into(),
    };
    let outcome = suspended(&contract, wake.clone());

    assert!(matches!(
        store.commit_execution_outcome(&outcome).unwrap(),
        OutcomeCommit::Inserted(_)
    ));
    assert!(matches!(
        store.commit_execution_outcome(&outcome).unwrap(),
        OutcomeCommit::Existing(_)
    ));

    let connection = raw_connection(&path);
    let row = connection
        .query_row(
            "SELECT revision, dedup_key, condition_json, status, delivery_json,
                    created_at, delivered_at
             FROM execution_wakes WHERE execution_id = ?1",
            ["exec-register-wake"],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                ))
            },
        )
        .unwrap();
    let outcome_at = connection
        .query_row(
            "SELECT created_at FROM execution_events
             WHERE execution_id = ?1 AND kind = 'outcome_committed'",
            ["exec-register-wake"],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();

    assert_eq!(
        row,
        (
            1,
            wake.dedup_key(),
            serde_json::to_string(&wake).unwrap(),
            "pending".into(),
            None,
            outcome_at,
            None,
        )
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM execution_wakes WHERE execution_id = ?1",
                ["exec-register-wake"],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );

    drop(connection);
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn identical_suspended_outcome_retry_fails_closed_on_a_corrupt_wake_receipt() {
    let (path, store) = file_store();
    let contract = contract("exec-corrupt-wake-retry");
    store.create_execution(&contract).unwrap();
    let outcome = suspended(
        &contract,
        WakeCondition::At {
            unix_seconds: 2_000_000_000,
        },
    );
    store.commit_execution_outcome(&outcome).unwrap();
    raw_connection(&path)
        .execute(
            "UPDATE execution_wakes SET condition_json = '{}' WHERE execution_id = ?1",
            ["exec-corrupt-wake-retry"],
        )
        .unwrap();

    assert!(matches!(
        store.commit_execution_outcome(&outcome),
        Err(TaskRuntimeError::Store(_) | TaskRuntimeError::InvalidTransition(_))
    ));
    assert_eq!(
        store
            .execution_events("exec-corrupt-wake-retry", 1)
            .unwrap()
            .len(),
        2
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn terminal_outcome_does_not_register_a_wake() {
    let (path, store) = file_store();
    let contract = contract("exec-terminal-no-wake");
    store.create_execution(&contract).unwrap();
    let outcome = ValidatedExecutionOutcome::new(
        ExecutionOutcome::completed(json!({"done": true})),
        &contract,
    )
    .unwrap();

    store.commit_execution_outcome(&outcome).unwrap();

    assert_eq!(
        raw_connection(&path)
            .query_row(
                "SELECT COUNT(*) FROM execution_wakes WHERE execution_id = ?1",
                ["exec-terminal-no-wake"],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn exact_typed_wake_delivery_resumes_the_same_execution_revision() {
    let (path, store) = file_store();
    let condition = WakeCondition::User {
        wait_ref: "wait-1".into(),
    };
    suspend_execution(&store, "exec-user-wake", condition.clone());
    let payload = json!({"type": "user", "answer": "continue"});

    assert_eq!(
        store.deliver_execution_wake(&condition, &payload).unwrap(),
        1
    );
    assert_eq!(
        store.deliver_execution_wake(&condition, &payload).unwrap(),
        0
    );

    let revision = store
        .execution_revision("exec-user-wake", 2)
        .unwrap()
        .expect("wake delivery creates revision two");
    assert_eq!(revision.contract.as_ref().revision, 2);
    assert_eq!(
        revision.contract.as_ref().wake.as_ref().unwrap().payload,
        payload
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn exact_typed_wake_retry_rejects_a_different_payload() {
    let (path, store) = file_store();
    let condition = WakeCondition::Approval {
        approval_ref: "approval-1".into(),
    };
    suspend_execution(&store, "exec-approval-wake", condition.clone());
    store
        .deliver_execution_wake(&condition, &json!({"approved": true}))
        .unwrap();

    assert!(matches!(
        store.deliver_execution_wake(&condition, &json!({"approved": false})),
        Err(TaskRuntimeError::Conflict(_))
    ));

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn pending_wakes_are_discovered_by_execution_scope() {
    let (path, store) = file_store();
    let condition = WakeCondition::User {
        wait_ref: "wait-scoped".into(),
    };
    suspend_execution(&store, "exec-scoped-wake", condition.clone());

    let wakes = store
        .pending_execution_wakes("user-1", "workspace-1", Some("thread-1"))
        .unwrap();
    assert_eq!(wakes.len(), 1);
    assert_eq!(wakes[0].execution_id, "exec-scoped-wake");
    assert_eq!(wakes[0].revision, 1);
    assert_eq!(wakes[0].condition, condition);
    assert!(
        store
            .pending_execution_wakes("user-1", "workspace-1", Some("other-thread"))
            .unwrap()
            .is_empty()
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn wake_delivery_rolls_back_its_external_projection_callback() {
    let (path, store) = file_store();
    raw_connection(&path)
        .execute_batch("CREATE TABLE wake_projection (value TEXT NOT NULL);")
        .unwrap();
    let condition = WakeCondition::User {
        wait_ref: "wait-atomic".into(),
    };
    suspend_execution(&store, "exec-atomic-wake", condition.clone());

    let result =
        store.deliver_execution_wake_with(&condition, &json!({"answer": "continue"}), |tx| {
            tx.execute("INSERT INTO wake_projection (value) VALUES ('written')", [])?;
            Err(TaskRuntimeError::Store("projection rejected".into()))
        });
    assert!(matches!(result, Err(TaskRuntimeError::Store(_))));

    let connection = raw_connection(&path);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM wake_projection", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT status FROM execution_wakes WHERE execution_id = ?1",
                ["exec-atomic-wake"],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "pending"
    );
    assert!(
        store
            .execution_revision("exec-atomic-wake", 2)
            .unwrap()
            .is_none()
    );

    drop(connection);
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn wake_registration_failure_rolls_back_the_suspended_outcome() {
    let (path, store) = file_store();
    let contract = contract("exec-wake-registration-atomic");
    store.create_execution(&contract).unwrap();
    let outcome = suspended(
        &contract,
        WakeCondition::At {
            unix_seconds: 2_000_000_000,
        },
    );
    raw_connection(&path)
        .execute_batch(
            "CREATE TRIGGER reject_execution_wake
             BEFORE INSERT ON execution_wakes
             BEGIN
                SELECT RAISE(ABORT, 'wake registration rejected');
             END;",
        )
        .unwrap();

    assert!(matches!(
        store.commit_execution_outcome(&outcome),
        Err(TaskRuntimeError::Store(_))
    ));
    let record = store
        .execution("exec-wake-registration-atomic")
        .unwrap()
        .unwrap();
    assert_eq!(record.state, ExecutionState::Ready);
    assert!(record.outcome.is_none());
    assert_eq!(
        store
            .execution_events("exec-wake-registration-atomic", 1)
            .unwrap()
            .len(),
        1
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn due_timer_delivers_once_and_starts_a_neutral_next_revision() {
    let (path, store) = file_store();
    let due_at = 1_900_000_000;
    let now = at(2_000_000_000);
    let original = contract("exec-due-timer");
    store.create_execution(&original).unwrap();
    let suspension = suspended(
        &original,
        WakeCondition::At {
            unix_seconds: due_at,
        },
    );
    let checkpoint = match suspension.as_ref() {
        ExecutionOutcome::Suspended { checkpoint, .. } => checkpoint.clone(),
        _ => unreachable!(),
    };
    store.commit_execution_outcome(&suspension).unwrap();

    assert_eq!(store.wake_due_executions(now, usize::MAX).unwrap(), 1);
    assert_eq!(store.wake_due_executions(now, usize::MAX).unwrap(), 0);

    let record = store.execution("exec-due-timer").unwrap().unwrap();
    assert_eq!(record.state, ExecutionState::Ready);
    let expected_delivery = WakeDelivery {
        condition: WakeCondition::At {
            unix_seconds: due_at,
        },
        dedup_key: WakeCondition::At {
            unix_seconds: due_at,
        }
        .dedup_key(),
        payload: json!({"scheduled_unix_seconds": due_at, "type": "timer"}),
        delivered_at_unix_seconds: now.unix_timestamp(),
    };
    let mut expected_contract = original.as_ref().clone();
    expected_contract.revision = 2;
    expected_contract.fencing_token = 2;
    expected_contract.checkpoint = Some(CheckpointRef {
        checkpoint_id: checkpoint.checkpoint_id().into(),
        producer_schema_version: checkpoint.producer_schema_version,
    });
    expected_contract.wake = Some(expected_delivery.clone());
    assert_eq!(record.contract.as_ref(), &expected_contract);

    let revision_one = store.execution_events("exec-due-timer", 1).unwrap();
    let revision_two = store.execution_events("exec-due-timer", 2).unwrap();
    assert_eq!(
        revision_one
            .iter()
            .map(|event| event.seq)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(revision_two.len(), 1);
    assert!(matches!(
        &revision_one[2].event,
        ExecutionJournalEvent::WakeDelivered {
            version: 1,
            delivery,
            next_revision: 2,
        } if delivery == &expected_delivery
    ));
    assert_eq!(revision_one[2].created_at, now.unix_timestamp());
    assert!(matches!(
        &revision_two[0].event,
        ExecutionJournalEvent::RevisionStarted {
            version: 1,
            previous_revision: 1,
            contract,
        } if contract == &expected_contract
    ));
    assert_eq!(revision_two[0].created_at, now.unix_timestamp());

    let row = raw_connection(&path)
        .query_row(
            "SELECT status, delivery_json, delivered_at FROM execution_wakes
             WHERE execution_id = ?1 AND revision = 1",
            ["exec-due-timer"],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "delivered".into(),
            serde_json::to_string(&expected_delivery).unwrap(),
            now.unix_timestamp(),
        )
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn timer_sweep_leaves_not_due_and_wrong_conditions_pending() {
    let (path, store) = file_store();
    suspend_execution(
        &store,
        "exec-timer-future",
        WakeCondition::At {
            unix_seconds: 2_100_000_000,
        },
    );
    suspend_execution(
        &store,
        "exec-timer-signal",
        WakeCondition::Signal {
            kind: "connector.message".into(),
            correlation_id: "message-1".into(),
        },
    );

    assert_eq!(
        store
            .wake_due_executions(at(2_000_000_000), usize::MAX)
            .unwrap(),
        0
    );
    for execution_id in ["exec-timer-future", "exec-timer-signal"] {
        let record = store.execution(execution_id).unwrap().unwrap();
        assert_eq!(record.state, ExecutionState::Suspended);
        assert_eq!(record.contract.as_ref().revision, 1);
    }
    assert_eq!(
        raw_connection(&path)
            .query_row(
                "SELECT COUNT(*) FROM execution_wakes
                 WHERE status = 'pending' AND delivery_json IS NULL AND delivered_at IS NULL",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        2
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn timer_sweep_applies_limit_in_due_time_then_identity_order() {
    let (_path, store) = file_store();
    for (execution_id, due_at) in [
        ("exec-order-c", 1_900_000_020),
        ("exec-order-b", 1_900_000_010),
        ("exec-order-a", 1_900_000_010),
    ] {
        suspend_execution(
            &store,
            execution_id,
            WakeCondition::At {
                unix_seconds: due_at,
            },
        );
    }

    assert_eq!(store.wake_due_executions(at(2_000_000_000), 2).unwrap(), 2);
    assert_eq!(
        store
            .execution("exec-order-a")
            .unwrap()
            .unwrap()
            .contract
            .as_ref()
            .revision,
        2
    );
    assert_eq!(
        store
            .execution("exec-order-b")
            .unwrap()
            .unwrap()
            .contract
            .as_ref()
            .revision,
        2
    );
    assert_eq!(
        store
            .execution("exec-order-c")
            .unwrap()
            .unwrap()
            .contract
            .as_ref()
            .revision,
        1
    );
    assert_eq!(
        store
            .wake_due_executions(at(2_000_000_000), usize::MAX)
            .unwrap(),
        1
    );
}

#[test]
fn signal_delivery_requires_exact_pair_and_preserves_first_opaque_payload() {
    let (path, store) = file_store();
    suspend_execution(
        &store,
        "exec-signal-exact",
        WakeCondition::Signal {
            kind: "connector.message".into(),
            correlation_id: "message-1".into(),
        },
    );
    let payload = json!({"opaque": [1, {"nested": true}]});

    assert_eq!(
        store
            .deliver_execution_signal("connector.other", "message-1", &payload)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .deliver_execution_signal("connector.message", "message-2", &payload)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .deliver_execution_signal("connector.message", "message-1", &payload)
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .deliver_execution_signal(
                "connector.message",
                "message-1",
                &json!({"different": true}),
            )
            .unwrap(),
        0
    );

    let record = store.execution("exec-signal-exact").unwrap().unwrap();
    let delivery = record.contract.as_ref().wake.as_ref().unwrap();
    assert_eq!(delivery.payload, payload);
    assert_eq!(record.contract.as_ref().revision, 2);
    let persisted: String = raw_connection(&path)
        .query_row(
            "SELECT delivery_json FROM execution_wakes WHERE execution_id = ?1",
            ["exec-signal-exact"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<WakeDelivery>(&persisted).unwrap(),
        *delivery
    );

    for (kind, correlation_id) in [("", "message-1"), ("  ", "message-1"), ("kind", "")] {
        assert!(matches!(
            store.deliver_execution_signal(kind, correlation_id, &Value::Null),
            Err(TaskRuntimeError::InvalidTransition(_))
        ));
    }

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn duplicate_signal_fails_closed_when_journal_delivery_evidence_is_missing() {
    let (path, store) = file_store();
    suspend_execution(
        &store,
        "exec-signal-missing-journal",
        WakeCondition::Signal {
            kind: "connector.message".into(),
            correlation_id: "message-1".into(),
        },
    );
    store
        .deliver_execution_signal("connector.message", "message-1", &json!({"first": true}))
        .unwrap();
    raw_connection(&path)
        .execute(
            "DELETE FROM execution_events
             WHERE execution_id = ?1 AND revision = 1 AND kind = 'wake_delivered'",
            ["exec-signal-missing-journal"],
        )
        .unwrap();

    assert!(matches!(
        store.deliver_execution_signal(
            "connector.message",
            "message-1",
            &json!({"duplicate": true}),
        ),
        Err(TaskRuntimeError::Store(_))
    ));

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn duplicate_timer_sweeps_across_connections_start_one_revision() {
    let (path, seed) = file_store();
    suspend_execution(
        &seed,
        "exec-concurrent-timer",
        WakeCondition::At {
            unix_seconds: 1_900_000_000,
        },
    );
    drop(seed);

    let barrier = Arc::new(Barrier::new(3));
    let store_a = TaskStore::open(&path).unwrap();
    let store_b = TaskStore::open(&path).unwrap();
    let barrier_a = Arc::clone(&barrier);
    let barrier_b = Arc::clone(&barrier);
    let thread_a = thread::spawn(move || {
        barrier_a.wait();
        store_a.wake_due_executions(at(2_000_000_000), usize::MAX)
    });
    let thread_b = thread::spawn(move || {
        barrier_b.wait();
        store_b.wake_due_executions(at(2_000_000_000), usize::MAX)
    });
    barrier.wait();
    let mut counts = vec![
        thread_a.join().unwrap().unwrap(),
        thread_b.join().unwrap().unwrap(),
    ];
    counts.sort_unstable();
    assert_eq!(counts, vec![0, 1]);

    let store = TaskStore::open(&path).unwrap();
    assert_eq!(
        store
            .execution_events("exec-concurrent-timer", 1)
            .unwrap()
            .iter()
            .filter(|event| matches!(event.event, ExecutionJournalEvent::WakeDelivered { .. }))
            .count(),
        1
    );
    assert_eq!(
        store
            .execution_events("exec-concurrent-timer", 2)
            .unwrap()
            .len(),
        1
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn duplicate_signal_delivery_across_connections_starts_one_revision() {
    let (path, seed) = file_store();
    suspend_execution(
        &seed,
        "exec-concurrent-signal",
        WakeCondition::Signal {
            kind: "connector.message".into(),
            correlation_id: "message-1".into(),
        },
    );
    drop(seed);

    let barrier = Arc::new(Barrier::new(3));
    let store_a = TaskStore::open(&path).unwrap();
    let store_b = TaskStore::open(&path).unwrap();
    let barrier_a = Arc::clone(&barrier);
    let barrier_b = Arc::clone(&barrier);
    let thread_a = thread::spawn(move || {
        barrier_a.wait();
        store_a.deliver_execution_signal("connector.message", "message-1", &json!({"source": "a"}))
    });
    let thread_b = thread::spawn(move || {
        barrier_b.wait();
        store_b.deliver_execution_signal("connector.message", "message-1", &json!({"source": "b"}))
    });
    barrier.wait();
    let mut counts = vec![
        thread_a.join().unwrap().unwrap(),
        thread_b.join().unwrap().unwrap(),
    ];
    counts.sort_unstable();
    assert_eq!(counts, vec![0, 1]);

    let store = TaskStore::open(&path).unwrap();
    assert_eq!(
        store
            .execution_events("exec-concurrent-signal", 1)
            .unwrap()
            .iter()
            .filter(|event| matches!(event.event, ExecutionJournalEvent::WakeDelivered { .. }))
            .count(),
        1
    );
    assert_eq!(
        store
            .execution_events("exec-concurrent-signal", 2)
            .unwrap()
            .len(),
        1
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn corrupt_pending_receipt_aborts_delivery_without_starting_a_revision() {
    let (path, store) = file_store();
    suspend_execution(
        &store,
        "exec-corrupt-delivery",
        WakeCondition::At {
            unix_seconds: 1_900_000_000,
        },
    );
    raw_connection(&path)
        .execute(
            "UPDATE execution_wakes SET dedup_key = 'forged' WHERE execution_id = ?1",
            ["exec-corrupt-delivery"],
        )
        .unwrap();

    assert!(matches!(
        store.wake_due_executions(at(2_000_000_000), usize::MAX),
        Err(TaskRuntimeError::Store(_) | TaskRuntimeError::InvalidTransition(_))
    ));
    let record = store.execution("exec-corrupt-delivery").unwrap().unwrap();
    assert_eq!(record.state, ExecutionState::Suspended);
    assert_eq!(record.contract.as_ref().revision, 1);

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn wake_projects_only_the_matching_legacy_waiting_task_back_to_queued() {
    for status in [TaskStatus::WaitingTime, TaskStatus::WaitingExternalEvent] {
        let (path, store) = file_store();
        let execution_id = format!("exec-legacy-task-{status}");
        suspend_execution(
            &store,
            &execution_id,
            WakeCondition::At {
                unix_seconds: 1_900_000_000,
            },
        );
        let user = UserId::new("user-1");
        let workspace = WorkspaceId::new("workspace-1");
        let mut waiting = TaskRecord::new(
            &execution_id,
            user.clone(),
            workspace.clone(),
            "legacy.execution",
            "Resume execution",
            json!({}),
        );
        waiting.status = status;
        waiting.blocked_reason = Some("waiting for wake".into());
        store.insert_task(&waiting).unwrap();

        let other_workspace = WorkspaceId::new("workspace-other");
        let mut unrelated = TaskRecord::new(
            &execution_id,
            user.clone(),
            other_workspace.clone(),
            "legacy.execution",
            "Unrelated execution",
            json!({}),
        );
        unrelated.status = status;
        unrelated.blocked_reason = Some("unrelated".into());
        store.insert_task(&unrelated).unwrap();

        assert_eq!(
            store
                .wake_due_executions(at(2_000_000_000), usize::MAX)
                .unwrap(),
            1
        );
        let resumed = store
            .get_task(&TaskId::new(&execution_id), &user, &workspace)
            .unwrap()
            .unwrap();
        assert_eq!(resumed.status, TaskStatus::Queued);
        assert_eq!(resumed.blocked_reason, None);
        let untouched = store
            .get_task(&TaskId::new(&execution_id), &user, &other_workspace)
            .unwrap()
            .unwrap();
        assert_eq!(untouched.status, status);
        assert_eq!(untouched.blocked_reason.as_deref(), Some("unrelated"));

        drop(store);
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn user_scheduler_sweeps_due_execution_wakes_before_cross_workspace_selection() {
    let (_path, store) = file_store();
    suspend_execution(
        &store,
        "exec-scheduler-wake",
        WakeCondition::At {
            unix_seconds: 1_900_000_000,
        },
    );
    let user = UserId::new("user-1");
    let workspace = WorkspaceId::new("workspace-1");
    let mut waiting = TaskRecord::new(
        "exec-scheduler-wake",
        user.clone(),
        workspace.clone(),
        "legacy.execution",
        "Resume execution",
        json!({}),
    );
    waiting.status = TaskStatus::WaitingTime;
    waiting.blocked_reason = Some("waiting for timer".into());
    store.insert_task(&waiting).unwrap();

    let ready = TaskScheduler::new()
        .ready_tasks_for_user(&store, &user, at(2_000_000_000), 10)
        .unwrap();

    assert_eq!(
        ready
            .iter()
            .map(|task| task.task_id.as_str())
            .collect::<Vec<_>>(),
        vec!["exec-scheduler-wake"]
    );
    assert_eq!(
        store
            .execution("exec-scheduler-wake")
            .unwrap()
            .unwrap()
            .contract
            .as_ref()
            .revision,
        2
    );
}

#[test]
fn facade_sweeps_due_execution_wakes_before_ready_selection() {
    let (_path, store) = file_store();
    suspend_execution(
        &store,
        "exec-facade-wake",
        WakeCondition::At {
            unix_seconds: 1_900_000_000,
        },
    );
    let user = UserId::new("user-1");
    let workspace = WorkspaceId::new("workspace-1");
    let mut waiting = TaskRecord::new(
        "exec-facade-wake",
        user.clone(),
        workspace.clone(),
        "legacy.execution",
        "Resume execution",
        json!({}),
    );
    waiting.status = TaskStatus::WaitingExternalEvent;
    waiting.blocked_reason = Some("waiting for wake".into());
    store.insert_task(&waiting).unwrap();
    let executor = FakeTaskExecutor::new(vec![ExecutorResult::Completed {
        output: json!({"done": true}),
    }]);
    let mut runtime = TaskRuntime::new(
        store,
        Box::new(executor),
        ResourceLimits::new(),
        "worker-wake",
    );

    let summary = runtime
        .run_ready_once(&user, &workspace, at(2_000_000_000))
        .unwrap();

    assert_eq!(summary.attempted, 1);
    assert_eq!(summary.completed, 1);
    assert_eq!(
        runtime
            .store()
            .execution("exec-facade-wake")
            .unwrap()
            .unwrap()
            .contract
            .as_ref()
            .revision,
        2
    );
    assert_eq!(
        runtime
            .store()
            .get_task(&TaskId::new("exec-facade-wake"), &user, &workspace)
            .unwrap()
            .unwrap()
            .status,
        TaskStatus::Completed
    );
}

#[test]
fn journal_fold_rejects_corrupt_wake_transition_evidence() {
    for case in [
        "dedup key",
        "next revision",
        "causal timestamp",
        "duplicate delivery",
        "revision mismatch",
    ] {
        let (path, store) = file_store();
        let execution_id = format!("exec-corrupt-wake-journal-{}", case.replace(' ', "-"));
        suspend_execution(
            &store,
            &execution_id,
            WakeCondition::At {
                unix_seconds: 1_900_000_000,
            },
        );
        store
            .wake_due_executions(at(2_000_000_000), usize::MAX)
            .unwrap();
        let connection = raw_connection(&path);

        match case {
            "dedup key" | "next revision" => {
                let payload: String = connection
                    .query_row(
                        "SELECT payload_json FROM execution_events
                         WHERE execution_id = ?1 AND revision = 1 AND kind = 'wake_delivered'",
                        [&execution_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                let mut payload: Value = serde_json::from_str(&payload).unwrap();
                if case == "dedup key" {
                    payload["delivery"]["dedup_key"] = json!("forged");
                } else {
                    payload["next_revision"] = json!(3);
                }
                connection
                    .execute(
                        "UPDATE execution_events SET payload_json = ?1
                         WHERE execution_id = ?2 AND revision = 1 AND kind = 'wake_delivered'",
                        rusqlite::params![serde_json::to_string(&payload).unwrap(), execution_id],
                    )
                    .unwrap();
            }
            "causal timestamp" => {
                let suspended_at: i64 = connection
                    .query_row(
                        "SELECT created_at FROM execution_events
                         WHERE execution_id = ?1 AND revision = 1
                           AND kind = 'outcome_committed'",
                        [&execution_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                let payload: String = connection
                    .query_row(
                        "SELECT payload_json FROM execution_events
                         WHERE execution_id = ?1 AND revision = 1 AND kind = 'wake_delivered'",
                        [&execution_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                let mut payload: Value = serde_json::from_str(&payload).unwrap();
                payload["delivery"]["delivered_at_unix_seconds"] = json!(suspended_at - 1);
                connection
                    .execute(
                        "UPDATE execution_events SET payload_json = ?1, created_at = ?2
                         WHERE execution_id = ?3 AND revision = 1 AND kind = 'wake_delivered'",
                        rusqlite::params![
                            serde_json::to_string(&payload).unwrap(),
                            suspended_at - 1,
                            execution_id,
                        ],
                    )
                    .unwrap();
            }
            "duplicate delivery" => {
                let (payload, created_at): (String, i64) = connection
                    .query_row(
                        "SELECT payload_json, created_at FROM execution_events
                         WHERE execution_id = ?1 AND revision = 1 AND kind = 'wake_delivered'",
                        [&execution_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .unwrap();
                connection
                    .execute(
                        "INSERT INTO execution_events (
                            execution_id, revision, seq, kind, payload_json, created_at
                         ) VALUES (?1, 1, 4, 'wake_delivered', ?2, ?3)",
                        rusqlite::params![execution_id, payload, created_at],
                    )
                    .unwrap();
            }
            "revision mismatch" => {
                let payload: String = connection
                    .query_row(
                        "SELECT payload_json FROM execution_events
                         WHERE execution_id = ?1 AND revision = 2 AND kind = 'revision_started'",
                        [&execution_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                let mut payload: Value = serde_json::from_str(&payload).unwrap();
                payload["contract"]["wake"]["payload"] = json!({"forged": true});
                connection
                    .execute(
                        "UPDATE execution_events SET payload_json = ?1
                         WHERE execution_id = ?2 AND revision = 2 AND kind = 'revision_started'",
                        rusqlite::params![serde_json::to_string(&payload).unwrap(), execution_id],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        drop(connection);

        assert!(
            matches!(
                store.execution(&execution_id),
                Err(TaskRuntimeError::Store(_))
            ),
            "journal fold accepted corrupt {case}"
        );

        drop(store);
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn v13_upgrade_adds_wake_evidence_to_an_authenticated_legacy_revision_start() {
    let (path, store) = file_store();
    suspend_execution(
        &store,
        "exec-v13-wake-upgrade",
        WakeCondition::Signal {
            kind: "connector.message".into(),
            correlation_id: "message-1".into(),
        },
    );
    store
        .deliver_execution_signal("connector.message", "message-1", &json!({"legacy": true}))
        .unwrap();
    drop(store);

    let connection = raw_connection(&path);
    connection
        .execute_batch(
            "DELETE FROM execution_events
             WHERE execution_id = 'exec-v13-wake-upgrade' AND kind = 'wake_delivered';
             ALTER TABLE execution_wakes RENAME TO execution_wakes_current;
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
                CHECK(
                    (delivery_json IS NULL AND delivered_at IS NULL)
                    OR (delivery_json IS NOT NULL AND delivered_at IS NOT NULL)
                ),
                CHECK(delivered_at IS NULL OR delivered_at >= created_at)
             );
             INSERT INTO execution_wakes
             SELECT * FROM execution_wakes_current;
             DROP TABLE execution_wakes_current;",
        )
        .unwrap();
    drop(connection);

    let migrated = TaskStore::open(&path).unwrap();
    assert_eq!(migrated.schema_version().unwrap(), 15);
    assert_eq!(
        migrated
            .execution("exec-v13-wake-upgrade")
            .unwrap()
            .unwrap()
            .contract
            .as_ref()
            .revision,
        2
    );
    let revision_one = migrated
        .execution_events("exec-v13-wake-upgrade", 1)
        .unwrap();
    assert_eq!(
        revision_one
            .iter()
            .filter(|event| matches!(event.event, ExecutionJournalEvent::WakeDelivered { .. }))
            .count(),
        1
    );
    assert_eq!(
        migrated
            .execution_events("exec-v13-wake-upgrade", 2)
            .unwrap()
            .len(),
        1
    );

    drop(migrated);
    let _ = std::fs::remove_file(path);
}

#[test]
fn v13_upgrade_reconstructs_a_missing_pending_receipt_from_the_suspended_journal() {
    let (path, store) = file_store();
    let original = contract("exec-v13-missing-pending");
    let condition = WakeCondition::Signal {
        kind: "connector.message".into(),
        correlation_id: "missing-pending-1".into(),
    };
    store.create_execution(&original).unwrap();
    store
        .commit_execution_outcome(&suspended(&original, condition.clone()))
        .unwrap();
    drop(store);

    let connection = raw_connection(&path);
    let suspended_at: i64 = connection
        .query_row(
            "SELECT created_at FROM execution_events
             WHERE execution_id = ?1 AND revision = 1 AND kind = 'outcome_committed'",
            ["exec-v13-missing-pending"],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .execute(
            "DELETE FROM execution_wakes WHERE execution_id = ?1",
            ["exec-v13-missing-pending"],
        )
        .unwrap();
    drop(connection);

    let migrated = TaskStore::open(&path).unwrap();
    let receipt = raw_connection(&path)
        .query_row(
            "SELECT dedup_key, condition_json, status, delivery_json, created_at, delivered_at
             FROM execution_wakes WHERE execution_id = ?1 AND revision = 1",
            ["exec-v13-missing-pending"],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        receipt,
        (
            condition.dedup_key(),
            serde_json::to_string(&condition).unwrap(),
            "pending".into(),
            None,
            suspended_at,
            None,
        )
    );

    assert_eq!(
        migrated
            .deliver_execution_signal(
                "connector.message",
                "missing-pending-1",
                &json!({"recovered": true}),
            )
            .unwrap(),
        1
    );
    let ready = migrated
        .execution("exec-v13-missing-pending")
        .unwrap()
        .unwrap();
    assert_eq!(ready.state, ExecutionState::Ready);
    assert_eq!(ready.contract.as_ref().revision, 2);
    assert_eq!(ready.contract.as_ref().fencing_token, 2);

    drop(migrated);
    let _ = std::fs::remove_file(path);
}

#[test]
fn v13_upgrade_reconstructs_the_next_revision_from_a_delivered_legacy_receipt() {
    let (path, store) = file_store();
    let original = contract("exec-v13-delivered-no-start");
    let condition = WakeCondition::Signal {
        kind: "connector.message".into(),
        correlation_id: "delivered-no-start-1".into(),
    };
    let outcome = suspended(&original, condition.clone());
    let checkpoint = match outcome.as_ref() {
        ExecutionOutcome::Suspended { checkpoint, .. } => checkpoint.clone(),
        _ => unreachable!(),
    };
    store.create_execution(&original).unwrap();
    store.commit_execution_outcome(&outcome).unwrap();
    drop(store);

    let connection = raw_connection(&path);
    let suspended_at: i64 = connection
        .query_row(
            "SELECT created_at FROM execution_events
             WHERE execution_id = ?1 AND revision = 1 AND kind = 'outcome_committed'",
            ["exec-v13-delivered-no-start"],
            |row| row.get(0),
        )
        .unwrap();
    let delivery = WakeDelivery {
        condition: condition.clone(),
        dedup_key: condition.dedup_key(),
        payload: json!({"legacy": "first-payload", "sequence": 1}),
        delivered_at_unix_seconds: suspended_at + 1,
    };
    connection
        .execute(
            "UPDATE execution_wakes
             SET status = 'delivered', delivery_json = ?1, delivered_at = ?2
             WHERE execution_id = ?3 AND revision = 1",
            rusqlite::params![
                serde_json::to_string(&delivery).unwrap(),
                delivery.delivered_at_unix_seconds,
                "exec-v13-delivered-no-start",
            ],
        )
        .unwrap();
    drop(connection);

    let migrated = TaskStore::open(&path).unwrap();
    let record = migrated
        .execution("exec-v13-delivered-no-start")
        .unwrap()
        .unwrap();
    let mut expected_contract = original.as_ref().clone();
    expected_contract.revision = 2;
    expected_contract.fencing_token = 2;
    expected_contract.checkpoint = Some(CheckpointRef {
        checkpoint_id: checkpoint.checkpoint_id().into(),
        producer_schema_version: checkpoint.producer_schema_version,
    });
    expected_contract.wake = Some(delivery.clone());
    assert_eq!(record.state, ExecutionState::Ready);
    assert_eq!(record.contract.as_ref(), &expected_contract);
    assert!(record.outcome.is_none());

    let revision_one = migrated
        .execution_events("exec-v13-delivered-no-start", 1)
        .unwrap();
    let revision_two = migrated
        .execution_events("exec-v13-delivered-no-start", 2)
        .unwrap();
    assert!(matches!(
        &revision_one[2].event,
        ExecutionJournalEvent::WakeDelivered {
            delivery: stored,
            next_revision: 2,
            ..
        } if stored == &delivery
    ));
    assert!(matches!(
        &revision_two[0].event,
        ExecutionJournalEvent::RevisionStarted {
            previous_revision: 1,
            contract,
            ..
        } if contract == &expected_contract
    ));
    assert_eq!(
        revision_two[0].created_at,
        delivery.delivered_at_unix_seconds
    );

    drop(migrated);
    let reopened = TaskStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .execution_events("exec-v13-delivered-no-start", 1)
            .unwrap()
            .iter()
            .filter(|event| matches!(event.event, ExecutionJournalEvent::WakeDelivered { .. }))
            .count(),
        1
    );

    drop(reopened);
    let _ = std::fs::remove_file(path);
}
