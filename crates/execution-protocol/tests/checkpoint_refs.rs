mod common;

use common::{checkpoint_with, durable_ref, secret_ref};
use local_first_execution_protocol::{
    CheckpointDataRef, CheckpointEnvelope, DurableDataRef, SecretRef,
};

#[test]
fn empty_checkpoint_is_public_and_contains_no_payload_or_secrets() {
    let checkpoint = CheckpointEnvelope::empty("exec-1", 3, "chat_turn");

    assert_eq!(checkpoint.checkpoint_id, "exec-1:3");
    assert_eq!(checkpoint.execution_id, "exec-1");
    assert_eq!(checkpoint.revision, 3);
    assert_eq!(checkpoint.producer_kind, "chat_turn");
    assert_eq!(checkpoint.schema_version, 1);
    assert_eq!(
        checkpoint.data_ref,
        CheckpointDataRef::Public {
            record_ref: durable_ref("exec-1:3:empty")
        }
    );
}

#[test]
fn checkpoint_modes_serialize_references_without_payload_fields() {
    let checkpoints = [
        checkpoint_with(CheckpointDataRef::Public {
            record_ref: durable_ref("checkpoint-public"),
        }),
        checkpoint_with(CheckpointDataRef::Redacted {
            record_ref: durable_ref("checkpoint-redacted"),
        }),
        checkpoint_with(CheckpointDataRef::Encrypted {
            secret_ref: secret_ref("checkpoint-secret"),
        }),
    ];

    for checkpoint in checkpoints {
        let encoded = serde_json::to_string(&checkpoint).unwrap();
        assert!(!encoded.contains("\"value\""));
        assert!(!encoded.contains("payload"));
        assert!(!encoded.contains("raw_secret"));
        assert!(!encoded.contains("secret-value-123"));
    }
}

#[test]
fn durable_data_refs_use_checked_versioned_length_prefixes() {
    let reference = DurableDataRef::new("scope:α").unwrap();
    assert_eq!(reference.as_ref(), "durable:v1:8:scope:α");
    assert_eq!(
        "durable:v1:8:scope:α".parse::<DurableDataRef>().unwrap(),
        reference
    );

    assert!(DurableDataRef::new(" ").is_err());
    assert!("durable:v1:7:scope:α".parse::<DurableDataRef>().is_err());
    assert!("secret:v1:8:scope:α".parse::<DurableDataRef>().is_err());
}

#[test]
fn secret_refs_use_checked_versioned_length_prefixes() {
    let reference = SecretRef::new("secret:β").unwrap();
    assert_eq!(reference.as_ref(), "secret:v1:9:secret:β");
    assert_eq!(
        "secret:v1:9:secret:β".parse::<SecretRef>().unwrap(),
        reference
    );

    assert!(SecretRef::new("").is_err());
    assert!("secret:v1:8:secret:β".parse::<SecretRef>().is_err());
    assert!("durable:v1:9:secret:β".parse::<SecretRef>().is_err());
}

#[test]
fn malformed_serialized_refs_cannot_deserialize() {
    let malformed = r#"{"mode":"encrypted","secret_ref":"secret:v1:99:short"}"#;

    assert!(serde_json::from_str::<CheckpointDataRef>(malformed).is_err());
}

#[test]
fn checked_refs_can_be_recovered_for_storage_adapters() {
    let durable = DurableDataRef::new("record-1").unwrap();
    let secret = SecretRef::new("secret-1").unwrap();

    assert_eq!(durable.into_inner(), "durable:v1:8:record-1");
    assert_eq!(secret.into_inner(), "secret:v1:8:secret-1");
}
