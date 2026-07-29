use local_first_execution_protocol::{EffectReceiptRef, WakeCondition};

#[test]
fn wake_conditions_have_stable_dedup_keys() {
    let cases = [
        (
            WakeCondition::At {
                unix_seconds: 1_800_000_000,
            },
            "v1:at:1800000000",
        ),
        (
            WakeCondition::Signal {
                kind: "connector.message".into(),
                correlation_id: "msg-1".into(),
            },
            "v1:signal:17:connector.message:5:msg-1",
        ),
        (
            WakeCondition::Resource {
                class: "browser".into(),
            },
            "v1:resource:7:browser",
        ),
        (
            WakeCondition::ModelAvailable {
                role: "reasoning".into(),
            },
            "v1:model_available:9:reasoning",
        ),
        (
            WakeCondition::User {
                wait_ref: "wait-1".into(),
            },
            "v1:user:6:wait-1",
        ),
        (
            WakeCondition::Approval {
                approval_ref: "approval-1".into(),
            },
            "v1:approval:10:approval-1",
        ),
        (
            WakeCondition::EffectResolution {
                receipt_ref: EffectReceiptRef::from_store_id(
                    "11111111111111111111111111111111",
                )
                .unwrap(),
            },
            "v1:effect_resolution:45:effect:v1:32:11111111111111111111111111111111",
        ),
    ];

    for (wake, expected) in cases {
        assert_eq!(wake.dedup_key(), expected);
    }
}

#[test]
fn signal_dedup_keys_do_not_collide_when_components_contain_delimiters() {
    let left = WakeCondition::Signal {
        kind: "a:b".into(),
        correlation_id: "c".into(),
    };
    let right = WakeCondition::Signal {
        kind: "a".into(),
        correlation_id: "b:c".into(),
    };

    assert_ne!(left.dedup_key(), right.dedup_key());
    assert_eq!(left.dedup_key(), "v1:signal:3:a:b:1:c");
    assert_eq!(right.dedup_key(), "v1:signal:1:a:3:b:c");
}

#[test]
fn wake_dedup_keys_length_prefix_utf8_bytes() {
    let wake = WakeCondition::Signal {
        kind: "méssage".into(),
        correlation_id: "消息".into(),
    };

    assert_eq!(wake.dedup_key(), "v1:signal:8:méssage:6:消息");
}
