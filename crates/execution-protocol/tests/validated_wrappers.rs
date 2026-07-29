mod common;

use common::{checkpoint_for, signal, valid_contract};
use local_first_execution_protocol::*;
use serde_json::json;

fn validated_contract() -> ValidatedExecutionContract {
    ValidatedExecutionContract::try_from(valid_contract()).unwrap()
}

fn suspended(wake: WakeCondition, checkpoint: CheckpointEnvelope) -> ExecutionOutcome {
    ExecutionOutcome::Suspended { wake, checkpoint }
}

#[test]
fn valid_contracts_are_wrapped_for_persistence() {
    let validated = ValidatedExecutionContract::try_from(valid_contract()).unwrap();

    assert_eq!(validated.as_ref().execution_id, "exec-1");
    assert_eq!(validated.into_inner().execution_id, "exec-1");
}

#[test]
fn invalid_contracts_cannot_become_persistence_inputs() {
    let mut contract = valid_contract();
    contract.execution_id.clear();

    assert_eq!(
        ValidatedExecutionContract::try_from(contract),
        Err(ProtocolValidationError::EmptyExecutionId)
    );
}

#[test]
fn valid_outcomes_are_wrapped_for_persistence() {
    let contract = validated_contract();
    let outcome = ExecutionOutcome::completed(json!({"ok": true}));
    let validated = ValidatedExecutionOutcome::new(outcome, &contract).unwrap();

    assert!(matches!(
        validated.as_ref(),
        ExecutionOutcome::Completed { .. }
    ));
    assert!(matches!(
        validated.into_inner(),
        ExecutionOutcome::Completed { .. }
    ));
}

#[test]
fn validated_outcomes_bind_the_contract_identity() {
    let contract = validated_contract();
    let validated =
        ValidatedExecutionOutcome::new(ExecutionOutcome::completed(json!({"ok": true})), &contract)
            .unwrap();
    let binding = validated.binding();

    assert_eq!(binding.execution_id(), "exec-1");
    assert_eq!(binding.revision(), 1);
    assert_eq!(binding.revision_i64(), 1);
    assert_eq!(binding.kind(), "chat_turn");
    assert_eq!(binding.fencing_token(), 1);
    assert_eq!(binding.fencing_token_i64(), 1);
    assert!(binding.matches_persisted("exec-1", 1, "chat_turn", 1));
}

#[test]
fn validated_contract_exposes_checked_sqlite_integer_values() {
    let mut contract = valid_contract();
    contract.revision = i64::MAX as u64;
    contract.fencing_token = i64::MAX as u64;
    let validated = ValidatedExecutionContract::try_from(contract).unwrap();

    assert_eq!(validated.revision_i64(), i64::MAX);
    assert_eq!(validated.fencing_token_i64(), i64::MAX);

    let outcome = ValidatedExecutionOutcome::new(
        ExecutionOutcome::completed(json!({"ok": true})),
        &validated,
    )
    .unwrap();
    assert_eq!(outcome.binding().revision_i64(), i64::MAX);
    assert_eq!(outcome.binding().fencing_token_i64(), i64::MAX);
}

#[test]
fn validated_outcome_binding_rejects_cross_contract_revision_and_fence_use() {
    let contract = validated_contract();
    let validated =
        ValidatedExecutionOutcome::new(ExecutionOutcome::completed(json!({"ok": true})), &contract)
            .unwrap();
    let binding = validated.binding();

    assert!(!binding.matches_persisted("other", 1, "chat_turn", 1));
    assert!(!binding.matches_persisted("exec-1", 2, "chat_turn", 1));
    assert!(!binding.matches_persisted("exec-1", 1, "other_kind", 1));
    assert!(!binding.matches_persisted("exec-1", 1, "chat_turn", 2));
}

#[test]
fn blank_continuation_refs_cannot_become_validated_outcomes() {
    let contract = validated_contract();
    let outcome = ExecutionOutcome::Completed {
        output: json!({}),
        continuation: Some(ContinuationRef {
            execution_id: " ".into(),
        }),
    };

    assert_eq!(
        ValidatedExecutionOutcome::new(outcome, &contract),
        Err(ProtocolValidationError::EmptyContinuationExecutionId)
    );
}

#[test]
fn blank_wake_components_cannot_become_validated_outcomes() {
    let cases = [
        WakeCondition::Signal {
            kind: " ".into(),
            correlation_id: "correlation".into(),
        },
        WakeCondition::Signal {
            kind: "signal".into(),
            correlation_id: "".into(),
        },
        WakeCondition::Resource { class: "".into() },
        WakeCondition::ModelAvailable { role: " ".into() },
        WakeCondition::User {
            wait_ref: "".into(),
        },
        WakeCondition::Approval {
            approval_ref: " ".into(),
        },
    ];

    for wake in cases {
        let contract = validated_contract();
        let checkpoint = checkpoint_for("exec-1", 1, "chat_turn");
        assert!(ValidatedExecutionOutcome::new(suspended(wake, checkpoint), &contract).is_err());
    }
}

#[test]
fn mismatched_checkpoint_identity_cannot_become_a_validated_outcome() {
    let contract = validated_contract();
    let mut checkpoint = checkpoint_for("other", 1, "chat_turn");
    assert_eq!(
        ValidatedExecutionOutcome::new(suspended(signal(), checkpoint.clone()), &contract),
        Err(ProtocolValidationError::CheckpointExecutionIdMismatch)
    );

    checkpoint = checkpoint_for("exec-1", 2, "chat_turn");
    assert_eq!(
        ValidatedExecutionOutcome::new(suspended(signal(), checkpoint.clone()), &contract),
        Err(ProtocolValidationError::CheckpointRevisionMismatch)
    );

    checkpoint = checkpoint_for("exec-1", 1, "other_kind");
    assert_eq!(
        ValidatedExecutionOutcome::new(suspended(signal(), checkpoint), &contract),
        Err(ProtocolValidationError::CheckpointProducerKindMismatch)
    );
}

#[test]
fn unsupported_checkpoint_protocol_schema_cannot_become_a_validated_outcome() {
    let contract = validated_contract();
    let mut checkpoint = checkpoint_for("exec-1", 1, "chat_turn");
    checkpoint.protocol_schema_version = PROTOCOL_SCHEMA_VERSION + 1;

    assert_eq!(
        ValidatedExecutionOutcome::new(suspended(signal(), checkpoint), &contract),
        Err(
            ProtocolValidationError::UnsupportedCheckpointProtocolSchemaVersion {
                actual: PROTOCOL_SCHEMA_VERSION + 1,
            }
        )
    );
}

#[test]
fn checkpoint_producer_schema_can_evolve_independently() {
    let contract = validated_contract();
    let mut checkpoint = checkpoint_for("exec-1", 1, "chat_turn");
    checkpoint.producer_schema_version = 7;

    assert!(ValidatedExecutionOutcome::new(suspended(signal(), checkpoint), &contract).is_ok());
}

#[test]
fn zero_checkpoint_producer_schema_cannot_become_a_validated_outcome() {
    let contract = validated_contract();
    let mut checkpoint = checkpoint_for("exec-1", 1, "chat_turn");
    checkpoint.producer_schema_version = 0;

    assert_eq!(
        ValidatedExecutionOutcome::new(suspended(signal(), checkpoint), &contract),
        Err(ProtocolValidationError::CheckpointProducerSchemaVersionZero)
    );
}

#[test]
fn malformed_checkpoint_refs_cannot_deserialize_into_raw_outcomes() {
    let malformed = r#"{"type":"suspended","wake":{"type":"signal","kind":"connector.message","correlation_id":"msg-1"},"checkpoint":{"checkpoint_id":"v1:checkpoint:6:exec-1:1","execution_id":"exec-1","revision":1,"producer_kind":"chat_turn","protocol_schema_version":1,"producer_schema_version":1,"data_ref":{"mode":"public","record_ref":"durable:v1:99:short"}}}"#;

    assert!(serde_json::from_str::<ExecutionOutcome>(malformed).is_err());
}

#[test]
fn blank_failure_codes_cannot_become_validated_outcomes() {
    let contract = validated_contract();
    let outcome = ExecutionOutcome::Failed {
        failure: ExecutionFailure::permanent(" ", "redacted detail"),
    };

    assert_eq!(
        ValidatedExecutionOutcome::new(outcome, &contract),
        Err(ProtocolValidationError::EmptyFailureCode)
    );
}
