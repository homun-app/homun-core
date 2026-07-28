use local_first_execution_protocol::{
    CancelReason, CheckpointDataRef, CheckpointEnvelope, DurableDataRef, ExecutionContract,
    ExecutionFailure, ExecutionOutcome, ExecutionScope, ExecutionState, ValidatedExecutionContract,
    ValidatedExecutionOutcome, WakeCondition,
};
use local_first_task_runtime::{OutcomeCommit, TaskRuntimeError, TaskStore};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::path::PathBuf;
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
    let contract_raw = contract.as_ref();
    let outcome = ExecutionOutcome::Suspended {
        wake: WakeCondition::Signal {
            kind: "connector.message".into(),
            correlation_id: "message-1".into(),
        },
        checkpoint: CheckpointEnvelope::new(
            &contract_raw.execution_id,
            contract_raw.revision,
            &contract_raw.kind,
            1,
            CheckpointDataRef::Public {
                record_ref: DurableDataRef::from_store_id(DURABLE_STORE_ID).unwrap(),
            },
        ),
    };
    ValidatedExecutionOutcome::new(outcome, contract).unwrap()
}

fn temporary_store() -> (PathBuf, TaskStore) {
    let path = std::env::temp_dir().join(format!(
        "homun-execution-store-test-{}.sqlite",
        Uuid::new_v4()
    ));
    let store = TaskStore::open(&path).unwrap();
    (path, store)
}

#[test]
fn creation_and_read_round_trip_validated_contract() {
    let store = TaskStore::open_in_memory().unwrap();
    let contract = contract("exec-round-trip", 3, 7);

    let created = store.create_execution(&contract).unwrap();
    let loaded = store.execution("exec-round-trip").unwrap().unwrap();

    assert_eq!(created, loaded);
    assert_eq!(loaded.contract, contract);
    assert_eq!(loaded.state, ExecutionState::Ready);
    assert_eq!(loaded.outcome, None);
}

#[test]
fn execution_events_have_deterministic_revision_sequence_order() {
    let store = TaskStore::open_in_memory().unwrap();
    let contract = contract("exec-events", 4, 2);
    store.create_execution(&contract).unwrap();

    store
        .append_execution_event("exec-events", 4, "execution_started", &json!({"round": 1}))
        .unwrap();
    store
        .append_execution_event(
            "exec-events",
            4,
            "adapter_called",
            &json!({"adapter": "chat"}),
        )
        .unwrap();

    let events = store.execution_events("exec-events", 4).unwrap();
    assert_eq!(
        events.iter().map(|event| event.seq).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(
        events
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["execution_created", "execution_started", "adapter_called"]
    );
    assert_eq!(events[2].payload, json!({"adapter": "chat"}));
}

#[test]
fn append_execution_event_rejects_invalid_inputs() {
    let store = TaskStore::open_in_memory().unwrap();
    let contract = contract("exec-event-input", 1, 1);
    store.create_execution(&contract).unwrap();

    assert!(matches!(
        store.append_execution_event(" ", 1, "kind", &json!({})),
        Err(TaskRuntimeError::InvalidTransition(_))
    ));
    assert!(matches!(
        store.append_execution_event("exec-event-input", 1, " ", &json!({})),
        Err(TaskRuntimeError::InvalidTransition(_))
    ));
    assert!(matches!(
        store.append_execution_event("exec-event-input", u64::MAX, "kind", &json!({})),
        Err(TaskRuntimeError::InvalidTransition(_))
    ));
}

#[test]
fn stale_fencing_token_cannot_commit_a_late_outcome() {
    let store = TaskStore::open_in_memory().unwrap();
    let original = contract("exec-stale-fence", 1, 7);
    let late = completed(&original, json!({"late": true}));
    store.create_execution(&original).unwrap();

    let advanced = store
        .advance_execution_fence("exec-stale-fence", 1, 7, 8)
        .unwrap();

    assert!(matches!(
        store.commit_execution_outcome(&late),
        Err(TaskRuntimeError::InvalidTransition(_))
    ));
    let current = completed(&advanced.contract, json!({"ok": true}));
    assert!(matches!(
        store.commit_execution_outcome(&current).unwrap(),
        OutcomeCommit::Inserted(_)
    ));
}

#[test]
fn advance_fence_updates_projection_contract_json_and_outcome_binding() {
    let (path, store) = temporary_store();
    let original = contract("exec-advance", 5, 9);
    store.create_execution(&original).unwrap();

    let advanced = store
        .advance_execution_fence("exec-advance", 5, 9, 11)
        .unwrap();

    let connection = Connection::open(&path).unwrap();
    let (projected_fence, contract_json): (i64, String) = connection
        .query_row(
            "SELECT fencing_token, contract_json FROM executions WHERE execution_id = ?1",
            ["exec-advance"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let raw: ExecutionContract = serde_json::from_str(&contract_json).unwrap();
    let persisted = ValidatedExecutionContract::try_from(raw).unwrap();
    assert_eq!(projected_fence, 11);
    assert_eq!(persisted, advanced.contract);
    assert_eq!(advanced.contract.as_ref().fencing_token, 11);

    let outcome = completed(&advanced.contract, json!({"fence": 11}));
    assert_eq!(outcome.binding().fencing_token(), 11);
    assert!(matches!(
        store.commit_execution_outcome(&outcome).unwrap(),
        OutcomeCommit::Inserted(_)
    ));
    let events = store.execution_events("exec-advance", 5).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "fence_advanced")
            .count(),
        1
    );
    assert!(matches!(
        store.advance_execution_fence("exec-advance", 5, 9, 11),
        Err(TaskRuntimeError::InvalidTransition(_))
    ));
    assert_eq!(store.execution_events("exec-advance", 5).unwrap(), events);

    drop(connection);
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn advance_fence_requires_matching_revision_and_strictly_newer_token() {
    let store = TaskStore::open_in_memory().unwrap();
    let contract = contract("exec-advance-invalid", 2, 4);
    store.create_execution(&contract).unwrap();

    for result in [
        store.advance_execution_fence("exec-advance-invalid", 3, 4, 5),
        store.advance_execution_fence("exec-advance-invalid", 2, 3, 5),
        store.advance_execution_fence("exec-advance-invalid", 2, 4, 4),
        store.advance_execution_fence("exec-advance-invalid", 2, 4, u64::MAX),
    ] {
        assert!(matches!(
            result,
            Err(TaskRuntimeError::InvalidTransition(_))
        ));
    }
}

#[test]
fn repeating_the_same_outcome_is_existing_without_another_event() {
    let store = TaskStore::open_in_memory().unwrap();
    let contract = contract("exec-idempotent", 1, 4);
    let outcome = completed(&contract, json!({"ok": true}));
    store.create_execution(&contract).unwrap();

    assert!(matches!(
        store.commit_execution_outcome(&outcome).unwrap(),
        OutcomeCommit::Inserted(_)
    ));
    let events_after_insert = store.execution_events("exec-idempotent", 1).unwrap();
    assert!(matches!(
        store.commit_execution_outcome(&outcome).unwrap(),
        OutcomeCommit::Existing(_)
    ));
    let events_after_repeat = store.execution_events("exec-idempotent", 1).unwrap();

    assert_eq!(events_after_insert, events_after_repeat);
    assert_eq!(
        events_after_repeat
            .iter()
            .filter(|event| event.kind == "outcome_committed")
            .count(),
        1
    );
}

#[test]
fn conflicting_second_outcome_is_rejected() {
    let store = TaskStore::open_in_memory().unwrap();
    let contract = contract("exec-conflict", 1, 2);
    let first = completed(&contract, json!({"value": 1}));
    let conflicting = completed(&contract, json!({"value": 2}));
    store.create_execution(&contract).unwrap();
    store.commit_execution_outcome(&first).unwrap();

    assert!(matches!(
        store.commit_execution_outcome(&conflicting),
        Err(TaskRuntimeError::InvalidTransition(_))
    ));
    assert_eq!(
        store.execution("exec-conflict").unwrap().unwrap().outcome,
        Some(first)
    );
}

#[test]
fn canonical_outcomes_map_to_canonical_execution_states() {
    let cases = [
        ("completed", ExecutionState::Completed),
        ("suspended", ExecutionState::Suspended),
        ("cancelled", ExecutionState::Cancelled),
        ("failed", ExecutionState::Failed),
    ];

    for (name, expected_state) in cases {
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
                    failure: ExecutionFailure::permanent("adapter_failed", "redacted"),
                },
                &contract,
            )
            .unwrap(),
            _ => unreachable!(),
        };

        let record = match store.commit_execution_outcome(&outcome).unwrap() {
            OutcomeCommit::Inserted(record) => record,
            OutcomeCommit::Existing(_) => panic!("first outcome commit must insert"),
        };
        assert_eq!(record.state, expected_state, "outcome {name}");
    }
}

#[test]
fn corrupt_stored_contract_json_is_rejected_on_read() {
    let (path, store) = temporary_store();
    let contract = contract("exec-corrupt-contract", 1, 1);
    store.create_execution(&contract).unwrap();

    let mut invalid_raw = contract.as_ref().clone();
    invalid_raw.kind = " ".into();
    let invalid_json = serde_json::to_string(&invalid_raw).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE executions SET contract_json = ?1 WHERE execution_id = ?2",
            params![invalid_json, "exec-corrupt-contract"],
        )
        .unwrap();

    assert!(matches!(
        store.execution("exec-corrupt-contract"),
        Err(TaskRuntimeError::Store(_))
    ));

    drop(connection);
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn corrupt_stored_outcome_json_is_rejected_on_read() {
    let (path, store) = temporary_store();
    let contract = contract("exec-corrupt-outcome", 1, 1);
    let outcome = completed(&contract, json!({"ok": true}));
    store.create_execution(&contract).unwrap();
    store.commit_execution_outcome(&outcome).unwrap();

    let invalid_raw = ExecutionOutcome::Failed {
        failure: ExecutionFailure::permanent(" ", "redacted"),
    };
    let invalid_json = serde_json::to_string(&invalid_raw).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE executions SET outcome_json = ?1 WHERE execution_id = ?2",
            params![invalid_json, "exec-corrupt-outcome"],
        )
        .unwrap();

    assert!(matches!(
        store.execution("exec-corrupt-outcome"),
        Err(TaskRuntimeError::Store(_))
    ));

    drop(connection);
    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn outcome_binding_must_match_persisted_revision_kind_and_fence() {
    let store = TaskStore::open_in_memory().unwrap();
    let persisted = contract("exec-binding", 2, 7);
    store.create_execution(&persisted).unwrap();

    let mut wrong_kind_raw = persisted.as_ref().clone();
    wrong_kind_raw.kind = "other_kind".into();
    let wrong_kind = ValidatedExecutionContract::try_from(wrong_kind_raw).unwrap();
    let candidates = [
        contract("exec-binding", 3, 7),
        contract("exec-binding", 2, 8),
        wrong_kind,
    ];

    for candidate in candidates {
        let outcome = completed(&candidate, json!({"wrong": true}));
        assert!(matches!(
            store.commit_execution_outcome(&outcome),
            Err(TaskRuntimeError::InvalidTransition(_))
        ));
    }
}

#[test]
fn outcome_binding_for_an_unknown_execution_is_an_invalid_transition() {
    let store = TaskStore::open_in_memory().unwrap();
    let unknown = contract("exec-unknown", 1, 1);
    let outcome = completed(&unknown, json!({"wrong": true}));

    assert!(matches!(
        store.commit_execution_outcome(&outcome),
        Err(TaskRuntimeError::InvalidTransition(_))
    ));
}

#[test]
fn conflicting_duplicate_execution_is_not_overwritten() {
    let store = TaskStore::open_in_memory().unwrap();
    let original = contract("exec-duplicate", 1, 1);
    store.create_execution(&original).unwrap();
    let mut conflicting_raw = original.as_ref().clone();
    conflicting_raw.input = json!({"prompt": "different"});
    let conflicting = ValidatedExecutionContract::try_from(conflicting_raw).unwrap();

    assert!(matches!(
        store.create_execution(&conflicting),
        Err(TaskRuntimeError::Conflict(_))
    ));
    assert_eq!(
        store.execution("exec-duplicate").unwrap().unwrap().contract,
        original
    );
}
