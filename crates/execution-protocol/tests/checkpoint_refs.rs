mod common;

use common::{DURABLE_STORE_ID, SECRET_STORE_ID, checkpoint_with, durable_ref, secret_ref};
use local_first_execution_protocol::{
    CheckpointDataRef, CheckpointEnvelope, DurableDataRef, SecretRef,
};

#[test]
fn checkpoint_constructor_requires_an_external_data_reference() {
    let checkpoint = CheckpointEnvelope::new(
        "exec-1",
        3,
        "chat_turn",
        4,
        CheckpointDataRef::Public {
            record_ref: durable_ref(),
        },
    );

    assert_eq!(checkpoint.checkpoint_id(), "v1:checkpoint:6:exec-1:3");
    assert_eq!(checkpoint.execution_id, "exec-1");
    assert_eq!(checkpoint.revision, 3);
    assert_eq!(checkpoint.producer_kind, "chat_turn");
    assert_eq!(checkpoint.protocol_schema_version, 1);
    assert_eq!(checkpoint.producer_schema_version, 4);
    assert_eq!(
        checkpoint.data_ref,
        CheckpointDataRef::Public {
            record_ref: durable_ref()
        }
    );
}

#[test]
fn checkpoint_ids_length_prefix_utf8_execution_ids() {
    let checkpoint = CheckpointEnvelope::new(
        "exec:α",
        12,
        "chat_turn",
        1,
        CheckpointDataRef::Public {
            record_ref: durable_ref(),
        },
    );

    assert_eq!(checkpoint.checkpoint_id(), "v1:checkpoint:7:exec:α:12");
}

#[test]
fn checkpoint_modes_serialize_references_without_payload_fields() {
    let checkpoints = [
        checkpoint_with(CheckpointDataRef::Public {
            record_ref: durable_ref(),
        }),
        checkpoint_with(CheckpointDataRef::Redacted {
            record_ref: durable_ref(),
        }),
        checkpoint_with(CheckpointDataRef::Encrypted {
            secret_ref: secret_ref(),
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
    let reference = DurableDataRef::from_store_id(DURABLE_STORE_ID).unwrap();
    let encoded = format!("durable:v1:32:{DURABLE_STORE_ID}");
    assert_eq!(reference.as_ref(), encoded);
    assert_eq!(encoded.parse::<DurableDataRef>().unwrap(), reference);
}

#[test]
fn secret_refs_use_checked_versioned_length_prefixes() {
    let reference = SecretRef::from_store_id(SECRET_STORE_ID).unwrap();
    let encoded = format!("secret:v1:32:{SECRET_STORE_ID}");
    assert_eq!(reference.as_ref(), encoded);
    assert_eq!(encoded.parse::<SecretRef>().unwrap(), reference);
}

#[test]
fn hostile_values_cannot_become_store_references() {
    let hostile = [
        "",
        " ",
        r#"{"token":"secret-value"}"#,
        "sk-proj-credential-control-string",
        "0123456789ABCDEF0123456789ABCDEF",
        "0123456789abcdef0123456789abcde",
        "0123456789abcdef0123456789abcdef0",
        "0123456789abcdef0123456789abcdeg",
        "0123456789abcdef0123456789abcde\n",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ];

    for value in hostile {
        assert!(DurableDataRef::from_store_id(value).is_err(), "{value:?}");
        assert!(SecretRef::from_store_id(value).is_err(), "{value:?}");
    }
}

#[test]
fn noncanonical_encoded_aliases_are_rejected() {
    let durable_aliases = [
        format!("durable:v1:032:{DURABLE_STORE_ID}"),
        format!("durable:v1:31:{DURABLE_STORE_ID}"),
        format!("durable:v1:32:{}", DURABLE_STORE_ID.to_uppercase()),
        format!("durable:v1:32:{DURABLE_STORE_ID}\n"),
        format!("secret:v1:32:{DURABLE_STORE_ID}"),
    ];

    for alias in durable_aliases {
        assert!(alias.parse::<DurableDataRef>().is_err(), "{alias:?}");
    }

    let secret_aliases = [
        format!("secret:v1:032:{SECRET_STORE_ID}"),
        format!("secret:v1:31:{SECRET_STORE_ID}"),
        format!("secret:v1:32:{}", SECRET_STORE_ID.to_uppercase()),
        format!("secret:v1:32:{SECRET_STORE_ID}\n"),
        format!("durable:v1:32:{SECRET_STORE_ID}"),
    ];

    for alias in secret_aliases {
        assert!(alias.parse::<SecretRef>().is_err(), "{alias:?}");
    }
}

#[test]
fn malformed_serialized_refs_cannot_deserialize() {
    let malformed = r#"{"mode":"encrypted","secret_ref":"secret:v1:99:short"}"#;

    assert!(serde_json::from_str::<CheckpointDataRef>(malformed).is_err());
}

#[test]
fn checked_refs_can_be_recovered_for_storage_adapters() {
    let durable = DurableDataRef::from_store_id(DURABLE_STORE_ID).unwrap();
    let secret = SecretRef::from_store_id(SECRET_STORE_ID).unwrap();

    assert_eq!(
        durable.into_inner(),
        format!("durable:v1:32:{DURABLE_STORE_ID}")
    );
    assert_eq!(
        secret.into_inner(),
        format!("secret:v1:32:{SECRET_STORE_ID}")
    );
}
