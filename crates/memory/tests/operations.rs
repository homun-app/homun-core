use local_first_memory::{
    DataSensitivity, DevelopmentKeyProvider, MemoryEvent, MemoryFacade, MemoryRef, MemoryRefKind,
    MemoryRestoreMode, PrivacyDomain, SQLiteMemoryStore, UserId, WorkspaceId,
};
use std::path::PathBuf;

#[test]
fn health_reports_schema_and_counts() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    facade
        .record_event(&event(DataSensitivity::Private))
        .unwrap();

    let health = facade.memory_health().unwrap();

    assert_eq!(health.schema_version, 3);
    assert_eq!(health.total_events, 1);
    assert_eq!(health.total_memories, 0);
}

#[test]
fn file_backed_store_backs_up_and_restores_locally() {
    let source_path = unique_db_path("source");
    let backup_path = unique_db_path("backup");
    let restored_path = unique_db_path("restored");
    {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open(&source_path).unwrap());
        facade
            .record_event(&event(DataSensitivity::Private))
            .unwrap();
        let report = facade.backup_to(&backup_path).unwrap();
        assert!(report.bytes_copied > 0);
    }

    SQLiteMemoryStore::restore_from_backup(
        &backup_path,
        &restored_path,
        MemoryRestoreMode::RefuseIfTargetExists,
    )
    .unwrap();
    let restored = SQLiteMemoryStore::open(&restored_path).unwrap();

    assert!(
        restored
            .get_event(
                &event_ref(),
                &UserId::new("user_1"),
                &WorkspaceId::new("workspace_1")
            )
            .unwrap()
            .is_some()
    );
}

#[test]
fn restored_encrypted_payload_fails_with_wrong_key() {
    let source_path = unique_db_path("encrypted-source");
    let backup_path = unique_db_path("encrypted-backup");
    let restored_path = unique_db_path("encrypted-restored");
    {
        let facade = MemoryFacade::new(
            SQLiteMemoryStore::open_with_key_provider(
                &source_path,
                Box::new(DevelopmentKeyProvider::new([7; 32])),
            )
            .unwrap(),
        );
        facade
            .record_event(&event(DataSensitivity::Secret))
            .unwrap();
        facade.backup_to(&backup_path).unwrap();
    }

    SQLiteMemoryStore::restore_from_backup(
        &backup_path,
        &restored_path,
        MemoryRestoreMode::RefuseIfTargetExists,
    )
    .unwrap();
    let restored = SQLiteMemoryStore::open_with_key_provider(
        &restored_path,
        Box::new(DevelopmentKeyProvider::new([9; 32])),
    )
    .unwrap();

    let error = restored
        .get_event(
            &event_ref(),
            &UserId::new("user_1"),
            &WorkspaceId::new("workspace_1"),
        )
        .unwrap_err();
    assert_eq!(error, "decryption failed");
}

#[test]
fn maintenance_rebuilds_search_index_and_checks_integrity() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());

    let report = facade.run_memory_maintenance().unwrap();

    assert!(report.integrity_ok);
    assert!(report.fts_rebuilt);
}

fn event(sensitivity: DataSensitivity) -> MemoryEvent {
    MemoryEvent {
        reference: event_ref(),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        timestamp: "2026-05-23T08:00:00Z".to_string(),
        source: "desktop".to_string(),
        event_type: "open_app".to_string(),
        payload: serde_json::json!({"app": "Zed", "secret": "token"}),
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity,
    }
}

fn event_ref() -> MemoryRef {
    MemoryRef::new(
        MemoryRefKind::Event,
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        "event_1",
    )
}

fn unique_db_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "local-first-memory-{label}-{}.sqlite",
        uuid::Uuid::new_v4()
    ))
}
