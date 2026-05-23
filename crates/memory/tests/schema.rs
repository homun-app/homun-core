use local_first_memory::{
    DataSensitivity, MemoryRecord, MemoryRef, MemoryRefKind, MemoryStatus, PrivacyDomain,
    SQLiteMemoryStore, UserId, WorkspaceId,
};
use std::path::PathBuf;

#[test]
fn store_records_schema_version_and_migrations_are_idempotent() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();

    assert_eq!(store.schema_version().unwrap(), 3);

    store.run_migrations().unwrap();
    store.run_migrations().unwrap();

    assert_eq!(store.schema_version().unwrap(), 3);
}

#[test]
fn memory_round_trips_production_lifecycle_metadata() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let user_id = UserId::new("user_1");
    let workspace_id = WorkspaceId::new("workspace_1");
    let old_ref = MemoryRef::new(
        MemoryRefKind::Memory,
        user_id.clone(),
        workspace_id.clone(),
        "old",
    );
    let correction_ref = MemoryRef::new(
        MemoryRefKind::Memory,
        user_id.clone(),
        workspace_id.clone(),
        "correction-source",
    );
    let memory = MemoryRecord {
        reference: MemoryRef::new(
            MemoryRefKind::Memory,
            user_id.clone(),
            workspace_id.clone(),
            "current",
        ),
        user_id: user_id.clone(),
        workspace_id: workspace_id.clone(),
        memory_type: "preference".to_string(),
        text: "Fabio prefers Zed for Acme work".to_string(),
        aliases: vec!["editor preference".to_string()],
        language_hints: vec!["en".to_string(), "it".to_string()],
        confidence: 0.91,
        status: MemoryStatus::Confirmed,
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
        metadata: serde_json::json!({"source": "test"}),
        created_at: "2026-05-23T08:00:00Z".to_string(),
        updated_at: "2026-05-23T08:05:00Z".to_string(),
        last_seen_at: Some("2026-05-23T08:10:00Z".to_string()),
        supersedes: vec![old_ref.clone()],
        superseded_by: None,
        correction_of: Some(correction_ref.clone()),
    };

    store.upsert_memory(&memory).unwrap();

    let loaded = store
        .get_memory(&memory.reference, &user_id, &workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(loaded.created_at, "2026-05-23T08:00:00Z");
    assert_eq!(loaded.updated_at, "2026-05-23T08:05:00Z");
    assert_eq!(loaded.last_seen_at.as_deref(), Some("2026-05-23T08:10:00Z"));
    assert_eq!(loaded.supersedes, vec![old_ref]);
    assert_eq!(loaded.superseded_by, None);
    assert_eq!(loaded.correction_of, Some(correction_ref));
}

#[test]
fn file_backed_store_keeps_schema_version_after_reopen() {
    let path = unique_db_path();
    {
        let store = SQLiteMemoryStore::open(&path).unwrap();
        assert_eq!(store.schema_version().unwrap(), 3);
    }

    let reopened = SQLiteMemoryStore::open(&path).unwrap();

    assert_eq!(reopened.schema_version().unwrap(), 3);
    let _ = std::fs::remove_file(path);
}

fn unique_db_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "local-first-memory-schema-{}.sqlite",
        uuid::Uuid::new_v4()
    ))
}
