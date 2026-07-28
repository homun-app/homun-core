mod common;

use common::{assert_golden_round_trip, checkpoint_with, durable_ref, secret_ref, valid_contract};
use local_first_execution_protocol::*;
use serde_json::json;

#[test]
fn canonical_outcomes_round_trip_without_domain_types() {
    let outcomes = [
        ExecutionOutcome::completed(json!({"ok": true})),
        ExecutionOutcome::Suspended {
            wake: WakeCondition::Signal {
                kind: "connector.message".into(),
                correlation_id: "msg-1".into(),
            },
            checkpoint: checkpoint_with(CheckpointDataRef::Public {
                record_ref: durable_ref(),
            }),
        },
        ExecutionOutcome::Cancelled {
            reason: CancelReason::User,
        },
        ExecutionOutcome::Failed {
            failure: ExecutionFailure::permanent("no_reply", "No final reply"),
        },
    ];

    for outcome in outcomes {
        let encoded = serde_json::to_string(&outcome).unwrap();
        assert_eq!(
            serde_json::from_str::<ExecutionOutcome>(&encoded).unwrap(),
            outcome
        );
    }
}

#[test]
fn default_contract_v1_wire_format_is_stable() {
    let golden = r#"{"schema_version":1,"execution_id":"exec-1","parent_execution_id":null,"kind":"chat_turn","revision":1,"fencing_token":1,"scope":{"user_id":"user-1","workspace_id":"workspace-1","thread_id":"thread-1"},"objective":null,"input":{"prompt":"hello"},"policy":{"allowed_effects":["read"],"approval_policy":"deny"},"resources":[],"budget":{"max_attempts":1,"backoff_seconds":0,"deadline_unix_seconds":null},"checkpoint":null,"wake":null}"#;

    assert_golden_round_trip(&valid_contract(), golden);
}

#[test]
fn execution_outcomes_v1_wire_format_is_stable() {
    let cases = [
        (
            ExecutionOutcome::completed(json!({"ok": true})),
            r#"{"type":"completed","output":{"ok":true},"continuation":null}"#,
        ),
        (
            ExecutionOutcome::Suspended {
                wake: WakeCondition::Signal {
                    kind: "connector.message".into(),
                    correlation_id: "msg-1".into(),
                },
                checkpoint: checkpoint_with(CheckpointDataRef::Public {
                    record_ref: durable_ref(),
                }),
            },
            r#"{"type":"suspended","wake":{"type":"signal","kind":"connector.message","correlation_id":"msg-1"},"checkpoint":{"checkpoint_id":"v1:checkpoint:6:exec-1:1","execution_id":"exec-1","revision":1,"producer_kind":"chat_turn","protocol_schema_version":1,"producer_schema_version":1,"data_ref":{"mode":"public","record_ref":"durable:v1:32:0123456789abcdef0123456789abcdef"}}}"#,
        ),
        (
            ExecutionOutcome::Cancelled {
                reason: CancelReason::User,
            },
            r#"{"type":"cancelled","reason":"user"}"#,
        ),
        (
            ExecutionOutcome::Failed {
                failure: ExecutionFailure::permanent("no_reply", "No final reply"),
            },
            r#"{"type":"failed","failure":{"class":"permanent","code":"no_reply","redacted_detail":"No final reply"}}"#,
        ),
    ];

    for (outcome, golden) in cases {
        assert_golden_round_trip(&outcome, golden);
    }
}

#[test]
fn wake_conditions_v1_wire_format_is_stable() {
    let cases = [
        (
            WakeCondition::At {
                unix_seconds: 1_800_000_000,
            },
            r#"{"type":"at","unix_seconds":1800000000}"#,
        ),
        (
            WakeCondition::Signal {
                kind: "connector.message".into(),
                correlation_id: "msg-1".into(),
            },
            r#"{"type":"signal","kind":"connector.message","correlation_id":"msg-1"}"#,
        ),
        (
            WakeCondition::Resource {
                class: "browser".into(),
            },
            r#"{"type":"resource","class":"browser"}"#,
        ),
        (
            WakeCondition::ModelAvailable {
                role: "reasoning".into(),
            },
            r#"{"type":"model_available","role":"reasoning"}"#,
        ),
        (
            WakeCondition::User {
                wait_ref: "wait-1".into(),
            },
            r#"{"type":"user","wait_ref":"wait-1"}"#,
        ),
        (
            WakeCondition::Approval {
                approval_ref: "approval-1".into(),
            },
            r#"{"type":"approval","approval_ref":"approval-1"}"#,
        ),
        (
            WakeCondition::EffectResolution {
                receipt_ref: "receipt-1".into(),
            },
            r#"{"type":"effect_resolution","receipt_ref":"receipt-1"}"#,
        ),
    ];

    for (wake, golden) in cases {
        assert_golden_round_trip(&wake, golden);
    }
}

#[test]
fn wake_delivery_v1_wire_format_is_stable() {
    let condition = WakeCondition::Signal {
        kind: "connector.message".into(),
        correlation_id: "msg-1".into(),
    };
    let delivery = WakeDelivery {
        dedup_key: condition.dedup_key(),
        condition,
        payload: json!({"opaque": true}),
        delivered_at_unix_seconds: 1_800_000_000,
    };
    let golden = r#"{"condition":{"type":"signal","kind":"connector.message","correlation_id":"msg-1"},"dedup_key":"v1:signal:17:connector.message:5:msg-1","payload":{"opaque":true},"delivered_at_unix_seconds":1800000000}"#;

    assert_golden_round_trip(&delivery, golden);
}

#[test]
fn checkpoint_data_modes_v1_wire_format_are_stable() {
    let cases = [
        (
            checkpoint_with(CheckpointDataRef::Public {
                record_ref: durable_ref(),
            }),
            r#"{"checkpoint_id":"v1:checkpoint:6:exec-1:1","execution_id":"exec-1","revision":1,"producer_kind":"chat_turn","protocol_schema_version":1,"producer_schema_version":1,"data_ref":{"mode":"public","record_ref":"durable:v1:32:0123456789abcdef0123456789abcdef"}}"#,
        ),
        (
            checkpoint_with(CheckpointDataRef::Redacted {
                record_ref: durable_ref(),
            }),
            r#"{"checkpoint_id":"v1:checkpoint:6:exec-1:1","execution_id":"exec-1","revision":1,"producer_kind":"chat_turn","protocol_schema_version":1,"producer_schema_version":1,"data_ref":{"mode":"redacted","record_ref":"durable:v1:32:0123456789abcdef0123456789abcdef"}}"#,
        ),
        (
            checkpoint_with(CheckpointDataRef::Encrypted {
                secret_ref: secret_ref(),
            }),
            r#"{"checkpoint_id":"v1:checkpoint:6:exec-1:1","execution_id":"exec-1","revision":1,"producer_kind":"chat_turn","protocol_schema_version":1,"producer_schema_version":1,"data_ref":{"mode":"encrypted","secret_ref":"secret:v1:32:abcdef0123456789abcdef0123456789"}}"#,
        ),
    ];

    for (checkpoint, golden) in cases {
        assert_golden_round_trip(&checkpoint, golden);
    }
}
