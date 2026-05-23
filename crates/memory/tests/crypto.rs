use local_first_memory::{
    DataSensitivity, DevelopmentKeyProvider, MemoryEvent, MemoryRef, MemoryRefKind, PrivacyDomain,
    SQLiteMemoryStore, UserId, WorkspaceId, decrypt_json, encrypt_json,
};

#[test]
fn encrypted_json_round_trips_with_same_key() {
    let provider = DevelopmentKeyProvider::new([7; 32]);
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let value = serde_json::json!({"password": "secret", "note": "private"});

    let encrypted = encrypt_json(&provider, &user, &workspace, &value).unwrap();
    let decrypted = decrypt_json(&provider, &user, &workspace, &encrypted).unwrap();

    assert_ne!(encrypted.ciphertext, serde_json::to_string(&value).unwrap());
    assert_eq!(decrypted, value);
}

#[test]
fn encrypted_json_fails_with_wrong_key() {
    let good = DevelopmentKeyProvider::new([7; 32]);
    let bad = DevelopmentKeyProvider::new([8; 32]);
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let encrypted =
        encrypt_json(&good, &user, &workspace, &serde_json::json!({"ok": true})).unwrap();

    let error = decrypt_json(&bad, &user, &workspace, &encrypted).unwrap_err();

    assert_eq!(error, "decryption failed");
}

#[test]
fn store_encrypts_secret_event_payloads() {
    let store = SQLiteMemoryStore::open_in_memory_with_key_provider(Box::new(
        DevelopmentKeyProvider::new([7; 32]),
    ))
    .unwrap();
    let event = MemoryEvent {
        reference: MemoryRef::new(
            MemoryRefKind::Event,
            UserId::new("user_1"),
            WorkspaceId::new("workspace_1"),
            "evt_secret",
        ),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        timestamp: "2026-05-23T08:00:00Z".to_string(),
        source: "connector".to_string(),
        event_type: "token_seen".to_string(),
        payload: serde_json::json!({"access_token": "token"}),
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Secret,
    };

    store.record_event(&event).unwrap();

    assert!(
        store
            .raw_event_payload_for_test(&event.reference)
            .unwrap()
            .contains("ciphertext")
    );
    assert_eq!(
        store
            .get_event(&event.reference, &event.user_id, &event.workspace_id)
            .unwrap(),
        Some(event)
    );
}
