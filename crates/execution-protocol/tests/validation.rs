mod common;

use common::{assert_invalid, opaque_payload, signal, valid_contract};
use local_first_execution_protocol::*;
use serde_json::json;

#[test]
fn contract_constructor_uses_conservative_defaults() {
    let contract = valid_contract();

    assert_eq!(contract.schema_version, PROTOCOL_SCHEMA_VERSION);
    assert_eq!(contract.execution_id, "exec-1");
    assert_eq!(contract.parent_execution_id, None);
    assert_eq!(contract.kind, "chat_turn");
    assert_eq!(contract.revision, 1);
    assert_eq!(contract.fencing_token, 1);
    assert_eq!(contract.objective, None);
    assert_eq!(contract.input, json!({"prompt": "hello"}));
    assert_eq!(contract.policy.allowed_effects, vec![EffectClass::Read]);
    assert_eq!(contract.policy.approval_policy, ApprovalPolicy::Deny);
    assert!(contract.resources.is_empty());
    assert_eq!(contract.budget.max_attempts, 1);
    assert_eq!(contract.budget.backoff_seconds, 0);
    assert_eq!(contract.budget.deadline_unix_seconds, None);
    assert_eq!(contract.checkpoint, None);
    assert_eq!(contract.wake, None);
    assert_eq!(contract.validate(), Ok(()));
}

#[test]
fn validation_rejects_empty_required_identity_fields() {
    let mut contract = valid_contract();
    contract.execution_id = " ".into();
    assert_invalid(contract, ProtocolValidationError::EmptyExecutionId);

    let mut contract = valid_contract();
    contract.kind.clear();
    assert_invalid(contract, ProtocolValidationError::EmptyKind);

    let mut contract = valid_contract();
    contract.scope.user_id.clear();
    assert_invalid(contract, ProtocolValidationError::EmptyUserId);

    let mut contract = valid_contract();
    contract.scope.workspace_id = "  ".into();
    assert_invalid(contract, ProtocolValidationError::EmptyWorkspaceId);
}

#[test]
fn validation_rejects_invalid_revision_fence_and_budget() {
    let mut contract = valid_contract();
    contract.revision = 0;
    assert_invalid(contract, ProtocolValidationError::RevisionZero);

    let mut contract = valid_contract();
    contract.fencing_token = 0;
    assert_invalid(contract, ProtocolValidationError::FencingTokenZero);

    let mut contract = valid_contract();
    contract.revision = i64::MAX as u64 + 1;
    assert_invalid(contract, ProtocolValidationError::RevisionOutOfRange);

    let mut contract = valid_contract();
    contract.fencing_token = i64::MAX as u64 + 1;
    assert_invalid(contract, ProtocolValidationError::FencingTokenOutOfRange);

    let mut contract = valid_contract();
    contract.budget.max_attempts = 0;
    assert_invalid(contract, ProtocolValidationError::MaxAttemptsZero);

    let mut contract = valid_contract();
    contract.budget.backoff_seconds = -1;
    assert_invalid(contract, ProtocolValidationError::NegativeBackoff);
}

#[test]
fn validation_rejects_invalid_resources() {
    let mut contract = valid_contract();
    contract.resources.push(ResourceRequirement {
        class: " ".into(),
        units: 1,
    });
    assert_invalid(
        contract,
        ProtocolValidationError::EmptyResourceClass { index: 0 },
    );

    let mut contract = valid_contract();
    contract.resources.push(ResourceRequirement {
        class: "browser".into(),
        units: 0,
    });
    assert_invalid(
        contract,
        ProtocolValidationError::ResourceUnitsZero { index: 0 },
    );
}

#[test]
fn validation_rejects_empty_scoped_references() {
    let mut contract = valid_contract();
    contract.parent_execution_id = Some("".into());
    assert_invalid(
        contract,
        ProtocolValidationError::EmptyScopedReference {
            field: "parent_execution_id",
        },
    );

    let mut contract = valid_contract();
    contract.scope.thread_id = Some(" ".into());
    assert_invalid(
        contract,
        ProtocolValidationError::EmptyScopedReference {
            field: "scope.thread_id",
        },
    );

    let mut contract = valid_contract();
    contract.objective = Some(ObjectiveRef {
        thread_id: "".into(),
        revision: 1,
    });
    assert_invalid(
        contract,
        ProtocolValidationError::EmptyScopedReference {
            field: "objective.thread_id",
        },
    );

    let mut contract = valid_contract();
    contract.checkpoint = Some(CheckpointRef {
        checkpoint_id: " ".into(),
        producer_schema_version: 1,
    });
    assert_invalid(
        contract,
        ProtocolValidationError::EmptyScopedReference {
            field: "checkpoint.checkpoint_id",
        },
    );
}

#[test]
fn validation_rejects_objective_revisions_outside_sqlite_integer_range() {
    let mut contract = valid_contract();
    contract.objective = Some(ObjectiveRef {
        thread_id: "thread-1".into(),
        revision: 0,
    });
    assert_invalid(contract, ProtocolValidationError::ObjectiveRevisionZero);

    let mut contract = valid_contract();
    contract.objective = Some(ObjectiveRef {
        thread_id: "thread-1".into(),
        revision: i64::MAX as u64 + 1,
    });
    assert_invalid(
        contract,
        ProtocolValidationError::ObjectiveRevisionOutOfRange,
    );
}

#[test]
fn validation_requires_objective_to_belong_to_the_scoped_thread() {
    let mut contract = valid_contract();
    contract.scope.thread_id = None;
    contract.objective = Some(ObjectiveRef {
        thread_id: "thread-1".into(),
        revision: 1,
    });
    assert_invalid(
        contract,
        ProtocolValidationError::ObjectiveScopeThreadMissing,
    );

    let mut contract = valid_contract();
    contract.objective = Some(ObjectiveRef {
        thread_id: "other-thread".into(),
        revision: 1,
    });
    assert_invalid(
        contract,
        ProtocolValidationError::ObjectiveScopeThreadMismatch {
            scope_thread_id: "thread-1".into(),
            objective_thread_id: "other-thread".into(),
        },
    );
}

#[test]
fn validation_rejects_zero_checkpoint_producer_schema_version() {
    let mut contract = valid_contract();
    contract.checkpoint = Some(CheckpointRef {
        checkpoint_id: "checkpoint-1".into(),
        producer_schema_version: 0,
    });

    assert_invalid(
        contract,
        ProtocolValidationError::CheckpointProducerSchemaVersionZero,
    );
}

#[test]
fn validation_rejects_unsupported_schema_version() {
    let mut contract = valid_contract();
    contract.schema_version = PROTOCOL_SCHEMA_VERSION + 1;

    assert_invalid(
        contract,
        ProtocolValidationError::UnsupportedSchemaVersion {
            actual: PROTOCOL_SCHEMA_VERSION + 1,
        },
    );
}

#[test]
fn wake_delivery_accepts_malformed_opaque_payload_when_condition_and_key_are_valid() {
    let condition = signal();
    let mut contract = valid_contract();
    contract.wake = Some(WakeDelivery {
        condition: condition.clone(),
        dedup_key: condition.dedup_key(),
        payload: json!({"type": "signal", "kind": 42, "correlation_id": false}),
        delivered_at_unix_seconds: 1_800_000_000,
    });

    assert_eq!(contract.validate(), Ok(()));
}

#[test]
fn validation_rejects_empty_or_mismatched_wake_delivery_keys() {
    let condition = signal();
    let mut contract = valid_contract();
    contract.wake = Some(WakeDelivery {
        condition: condition.clone(),
        dedup_key: " ".into(),
        payload: opaque_payload(),
        delivered_at_unix_seconds: 1_800_000_000,
    });
    assert_invalid(contract, ProtocolValidationError::EmptyWakeDedupKey);

    let mut contract = valid_contract();
    contract.wake = Some(WakeDelivery {
        condition: condition.clone(),
        dedup_key: "v1:signal:5:wrong:3:key".into(),
        payload: opaque_payload(),
        delivered_at_unix_seconds: 1_800_000_000,
    });
    assert_invalid(
        contract,
        ProtocolValidationError::WakeDedupKeyMismatch {
            expected: condition.dedup_key(),
            actual: "v1:signal:5:wrong:3:key".into(),
        },
    );
}

#[test]
fn validation_rejects_invalid_wake_condition_references() {
    let condition = WakeCondition::Approval {
        approval_ref: " ".into(),
    };
    let mut contract = valid_contract();
    contract.wake = Some(WakeDelivery {
        dedup_key: condition.dedup_key(),
        condition,
        payload: opaque_payload(),
        delivered_at_unix_seconds: 1_800_000_000,
    });

    assert_invalid(
        contract,
        ProtocolValidationError::EmptyScopedReference {
            field: "wake.approval.approval_ref",
        },
    );
}

#[test]
fn timestamp_fields_state_seconds_explicitly() {
    let budget = ExecutionBudget {
        max_attempts: 1,
        backoff_seconds: 0,
        deadline_unix_seconds: Some(1_800_000_000),
    };
    let wake = WakeCondition::At {
        unix_seconds: 1_800_000_001,
    };
    let delivery = WakeDelivery {
        condition: wake.clone(),
        dedup_key: wake.dedup_key(),
        payload: opaque_payload(),
        delivered_at_unix_seconds: 1_800_000_002,
    };

    assert_eq!(budget.deadline_unix_seconds, Some(1_800_000_000));
    assert_eq!(delivery.delivered_at_unix_seconds, 1_800_000_002);
}

#[test]
fn failure_constructors_set_class_code_and_redacted_detail() {
    let cases = [
        (
            ExecutionFailure::transient("temporarily_unavailable", "retry later"),
            FailureClass::Transient,
            "temporarily_unavailable",
            "retry later",
        ),
        (
            ExecutionFailure::permanent("invalid_input", "input rejected"),
            FailureClass::Permanent,
            "invalid_input",
            "input rejected",
        ),
        (
            ExecutionFailure::policy_denied("effect_denied", "write not allowed"),
            FailureClass::PolicyDenied,
            "effect_denied",
            "write not allowed",
        ),
    ];

    for (failure, class, code, detail) in cases {
        assert_eq!(failure.class, class);
        assert_eq!(failure.code, code);
        assert_eq!(failure.redacted_detail, detail);
    }
}
