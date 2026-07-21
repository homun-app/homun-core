use local_first_host_computer::protocol::{AppSnapshot, SemanticAction, SnapshotTreeMode};

#[test]
fn secure_elements_never_deserialize_a_value_or_mutating_text_action() {
    let raw = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../runtimes/host-computer/macos/Fixtures/secure-field-redacted.json"
    ));
    let snapshot: AppSnapshot = serde_json::from_str(raw).unwrap();
    let secure = &snapshot.elements[0];

    assert_eq!(snapshot.tree_mode, SnapshotTreeMode::Full);
    assert_eq!(secure.value, None);
    assert!(secure.sensitive);
    assert!(!secure.actions.contains(&SemanticAction::SetValue));
}

#[test]
fn unknown_snapshot_fields_are_rejected() {
    let raw = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../runtimes/host-computer/macos/Fixtures/secure-field-redacted.json"
    ));
    let mut value: serde_json::Value = serde_json::from_str(raw).unwrap();
    value["raw_ax_pointer"] = serde_json::json!("0x1234");

    assert!(serde_json::from_value::<AppSnapshot>(value).is_err());
}
