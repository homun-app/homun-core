mod common;

use common::{signal, valid_contract};
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
        WakeCondition::EffectResolution {
            receipt_ref: "".into(),
        },
    ];

    for wake in cases {
        let contract = validated_contract();
        let checkpoint = CheckpointEnvelope::empty("exec-1", 1, "chat_turn");
        assert!(ValidatedExecutionOutcome::new(suspended(wake, checkpoint), &contract).is_err());
    }
}

#[test]
fn mismatched_checkpoint_identity_cannot_become_a_validated_outcome() {
    let contract = validated_contract();
    let mut checkpoint = CheckpointEnvelope::empty("other", 1, "chat_turn");
    assert_eq!(
        ValidatedExecutionOutcome::new(suspended(signal(), checkpoint.clone()), &contract),
        Err(ProtocolValidationError::CheckpointExecutionIdMismatch)
    );

    checkpoint = CheckpointEnvelope::empty("exec-1", 2, "chat_turn");
    assert_eq!(
        ValidatedExecutionOutcome::new(suspended(signal(), checkpoint.clone()), &contract),
        Err(ProtocolValidationError::CheckpointRevisionMismatch)
    );

    checkpoint = CheckpointEnvelope::empty("exec-1", 1, "other_kind");
    assert_eq!(
        ValidatedExecutionOutcome::new(suspended(signal(), checkpoint), &contract),
        Err(ProtocolValidationError::CheckpointProducerKindMismatch)
    );
}

#[test]
fn unsupported_checkpoint_schema_cannot_become_a_validated_outcome() {
    let contract = validated_contract();
    let mut checkpoint = CheckpointEnvelope::empty("exec-1", 1, "chat_turn");
    checkpoint.schema_version = PROTOCOL_SCHEMA_VERSION + 1;

    assert_eq!(
        ValidatedExecutionOutcome::new(suspended(signal(), checkpoint), &contract),
        Err(
            ProtocolValidationError::UnsupportedCheckpointSchemaVersion {
                actual: PROTOCOL_SCHEMA_VERSION + 1,
            }
        )
    );
}

#[test]
fn malformed_checkpoint_refs_cannot_deserialize_into_raw_outcomes() {
    let malformed = r#"{"type":"suspended","wake":{"type":"signal","kind":"connector.message","correlation_id":"msg-1"},"checkpoint":{"checkpoint_id":"exec-1:1","execution_id":"exec-1","revision":1,"producer_kind":"chat_turn","schema_version":1,"data_ref":{"mode":"public","record_ref":"durable:v1:99:short"}}}"#;

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
