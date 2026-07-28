mod common;

use common::{checkpoint_for, signal, valid_contract};
use local_first_execution_protocol::*;
use serde_json::{Value, json};

#[test]
fn stored_contract_json_is_revalidated_after_deserialization() {
    let encoded = serde_json::to_string(&valid_contract()).unwrap();
    let decoded: ExecutionContract = serde_json::from_str(&encoded).unwrap();

    assert!(ValidatedExecutionContract::try_from(decoded).is_ok());
}

#[test]
fn hostile_stored_contract_json_cannot_become_a_validated_contract() {
    let mut stored = serde_json::to_value(valid_contract()).unwrap();
    stored["objective"] = json!({"thread_id": "thread-1", "revision": 0});
    let decoded: ExecutionContract = serde_json::from_value(stored).unwrap();

    assert_eq!(
        ValidatedExecutionContract::try_from(decoded),
        Err(ProtocolValidationError::ObjectiveRevisionZero)
    );
}

#[test]
fn stored_outcome_json_is_revalidated_against_the_loaded_contract() {
    let contract = ValidatedExecutionContract::try_from(valid_contract()).unwrap();
    let outcome = ExecutionOutcome::Suspended {
        wake: signal(),
        checkpoint: checkpoint_for("exec-1", 1, "chat_turn"),
    };
    let encoded = serde_json::to_string(&outcome).unwrap();
    let decoded: ExecutionOutcome = serde_json::from_str(&encoded).unwrap();

    assert!(ValidatedExecutionOutcome::new(decoded, &contract).is_ok());
}

#[test]
fn hostile_stored_outcome_json_cannot_become_a_validated_outcome() {
    let contract = ValidatedExecutionContract::try_from(valid_contract()).unwrap();
    let mut stored = serde_json::to_value(ExecutionOutcome::Suspended {
        wake: signal(),
        checkpoint: checkpoint_for("exec-1", 1, "chat_turn"),
    })
    .unwrap();
    stored["checkpoint"]["execution_id"] = Value::String("other-execution".into());
    let decoded: ExecutionOutcome = serde_json::from_value(stored).unwrap();

    assert_eq!(
        ValidatedExecutionOutcome::new(decoded, &contract),
        Err(ProtocolValidationError::CheckpointExecutionIdMismatch)
    );
}

#[test]
fn noncanonical_stored_reference_json_is_rejected_during_deserialization() {
    let stored =
        r#"{"mode":"public","record_ref":"durable:v1:032:0123456789abcdef0123456789abcdef"}"#;

    assert!(serde_json::from_str::<CheckpointDataRef>(stored).is_err());
}
