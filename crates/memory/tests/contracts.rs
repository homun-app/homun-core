use local_first_memory::{
    DataSensitivity, MemoryRef, MemoryRefKind, MemoryStatus, UserId, WorkspaceId,
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
