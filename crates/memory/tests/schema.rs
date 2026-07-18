use local_first_memory::{
    DataSensitivity, MemoryCollectionKey, MemoryFacade, MemoryRecord, MemoryRef, MemoryRefKind,
    MemorySourceGrant, MemoryStatus, PrivacyDomain, SQLiteMemoryStore, UserId, WorkspaceId,
};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

#[test]
fn store_records_schema_version_and_migrations_are_idempotent() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();

    assert_eq!(store.schema_version().unwrap(), 7);

    store.run_migrations().unwrap();
    store.run_migrations().unwrap();

    assert_eq!(store.schema_version().unwrap(), 7);
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
        assert_eq!(store.schema_version().unwrap(), 7);
    }

    let reopened = SQLiteMemoryStore::open(&path).unwrap();

    assert_eq!(reopened.schema_version().unwrap(), 7);
    let _ = std::fs::remove_file(path);
}

fn unique_db_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "local-first-memory-schema-{}.sqlite",
        uuid::Uuid::new_v4()
    ))
}

#[test]
fn populated_v3_store_migrates_to_v4_without_data_loss() {
    let path = unique_db_path();
    let user = UserId::new("migration-user");
    let workspace = WorkspaceId::new("migration-project");
    let memory = MemoryRecord {
        reference: MemoryRef::new(
            MemoryRefKind::Memory,
            user.clone(),
            workspace.clone(),
            "existing-memory",
        ),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        memory_type: "fact".to_string(),
        text: "Existing v3 data".to_string(),
        aliases: vec![],
        language_hints: vec![],
        confidence: 1.0,
        status: MemoryStatus::Confirmed,
        privacy_domain: PrivacyDomain::new("general"),
        sensitivity: DataSensitivity::Internal,
        metadata: serde_json::json!({}),
        created_at: "2026-07-17T00:00:00Z".to_string(),
        updated_at: "2026-07-17T00:00:00Z".to_string(),
        last_seen_at: None,
        supersedes: vec![],
        superseded_by: None,
        correction_of: None,
    };
    {
        let store = SQLiteMemoryStore::open(&path).unwrap();
        store.upsert_memory(&memory).unwrap();
    }
    {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "drop table memory_source_grant_overrides;
                 drop table memory_source_grant_collections;
                 drop table memory_source_grants;
                 update schema_metadata set value = '3' where key = 'schema_version';",
            )
            .unwrap();
    }

    {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).unwrap());
        assert_eq!(facade.memory_health().unwrap().schema_version, 7);
        assert_eq!(
            facade
                .get_memory_for_ui(&memory.reference, &user, &workspace)
                .unwrap(),
            Some(memory.clone())
        );

        let grant = MemorySourceGrant {
            id: "migration-grant".to_string(),
            consumer_user_id: user.clone(),
            consumer_workspace_id: workspace.clone(),
            source_user_id: user.clone(),
            source_workspace_id: WorkspaceId::new("__personal__"),
            collections: BTreeSet::from([MemoryCollectionKey::Preferences]),
            max_sensitivity: DataSensitivity::Private,
            overrides: HashMap::new(),
            expires_at: None,
            revoked_at: None,
            policy_version: 1,
            created_by: "migration-user".to_string(),
            created_at: "2026-07-17T00:00:00Z".to_string(),
            updated_at: "2026-07-17T00:00:00Z".to_string(),
        };
        facade.upsert_memory_source_grant(&grant).unwrap();
        assert_eq!(
            facade.list_memory_source_grants(&user, &workspace).unwrap(),
            vec![grant]
        );
    }
    {
        let connection = rusqlite::Connection::open(&path).unwrap();
        let grant_table_sql: String = connection
            .query_row(
                "select sql from sqlite_master where type = 'table' and name = 'memory_source_grants'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(grant_table_sql.contains("typeof(policy_version)"));
        let index_count: i64 = connection
            .query_row(
                "select count(*) from sqlite_master
                 where type = 'index' and name = 'idx_memory_source_grants_consumer'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_count, 1);
        let active_source_index_sql: String = connection
            .query_row(
                "select sql from sqlite_master
                 where type = 'index' and name = 'idx_memory_source_grants_active_source'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let active_source_index_sql = active_source_index_sql.to_ascii_lowercase();
        assert!(active_source_index_sql.contains("create unique index"));
        assert!(active_source_index_sql.contains("where revoked_at is null"));
    }
    {
        let reopened = SQLiteMemoryStore::open(&path).unwrap();
        assert_eq!(reopened.schema_version().unwrap(), 7);
        assert!(
            reopened
                .get_memory(&memory.reference, &user, &workspace)
                .unwrap()
                .is_some()
        );
    }

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}
