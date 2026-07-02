use local_first_memory::{
    DataSensitivity, MemoryRef, MemoryRefKind, MemoryStatus, UserId, WorkspaceId, contains_secret,
    redact_text,
};
use std::str::FromStr;

#[test]
fn memory_refs_are_stable_and_parseable() {
    let reference = MemoryRef::new(
        MemoryRefKind::Entity,
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        "project:acme",
    );

    let encoded = reference.to_string();
    let parsed = MemoryRef::from_str(&encoded).unwrap();

    assert_eq!(encoded, "entity:local:user_1:workspace_1:project:acme");
    assert_eq!(parsed, reference);
}

#[test]
fn contracts_serialize_multilingual_memory_metadata() {
    let json = serde_json::json!({
        "status": MemoryStatus::Candidate,
        "sensitivity": DataSensitivity::Private,
        "aliases": ["Acme", "Cliente Acme", "Projet Acme"],
        "language_hints": ["it", "en", "fr"]
    });

    assert_eq!(json["status"], "candidate");
    assert_eq!(json["sensitivity"], "private");
    assert_eq!(json["language_hints"][2], "fr");
}

#[test]
fn redacts_vault_sensitive_values_from_memory() {
    let redacted = redact_text(
        "La mia carta e' 4111 1111 1111 1111, targa AB123CD, allergico alla penicillina",
    );

    assert!(redacted.contains("[VAULT:payments:card:last4=1111]"));
    assert!(redacted.contains("[VAULT:vehicles:plate]"));
    assert!(redacted.contains("[VAULT:health:health_note]"));
    assert!(!redacted.contains("4111 1111 1111 1111"));
    assert!(!redacted.contains("AB123CD"));
    assert!(!redacted.contains("penicillina"));
}

#[test]
fn contains_secret_flags_vault_sensitive_strings() {
    let value = serde_json::json!({
        "note": "Codice fiscale RSSMRA80A01H501U",
        "preference": "Preferisco partire da Napoli"
    });

    assert!(contains_secret(&value));
    assert!(!contains_secret(&serde_json::json!(
        "Preferisco partire da Napoli"
    )));
}
