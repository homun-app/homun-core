use local_first_memory::{
    DataSensitivity, MemoryCollectionKey, MemoryFacade, MemoryGrantOverrideEffect, MemoryRef,
    MemoryRefKind, MemorySourceGrant, SQLiteMemoryStore, UserId, WorkspaceId,
};
use rusqlite::Connection;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

fn facade() -> MemoryFacade {
    MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap())
}

fn colliding_refs() -> (MemoryRef, MemoryRef) {
    let mut first = MemoryRef::new(
        MemoryRefKind::Memory,
        UserId::new("c"),
        WorkspaceId::new("d"),
        "e",
    );
    first.scope = "a:b".to_string();

    let mut second = MemoryRef::new(
        MemoryRefKind::Memory,
        UserId::new("b"),
        WorkspaceId::new("c"),
        "d:e",
    );
    second.scope = "a".to_string();

    assert_ne!(first, second);
    assert_eq!(first.to_string(), second.to_string());
    (first, second)
}

fn grant() -> MemorySourceGrant {
    let (allowed, denied) = colliding_refs();
    MemorySourceGrant {
        id: "grant-1".to_string(),
        consumer_user_id: UserId::new("owner"),
        consumer_workspace_id: WorkspaceId::new("project-a"),
        source_user_id: UserId::new("owner"),
        source_workspace_id: WorkspaceId::new("__personal__"),
        collections: BTreeSet::from([
            MemoryCollectionKey::Preferences,
            MemoryCollectionKey::Decisions,
        ]),
        max_sensitivity: DataSensitivity::Private,
        overrides: HashMap::from([
            (allowed, MemoryGrantOverrideEffect::Allow),
            (denied, MemoryGrantOverrideEffect::Deny),
        ]),
        expires_at: Some(1_900_000_000),
        revoked_at: None,
        policy_version: 7,
        created_by: "owner".to_string(),
        created_at: "2026-07-17T10:00:00Z".to_string(),
        updated_at: "2026-07-17T10:00:00Z".to_string(),
    }
}

fn unique_db_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "local-first-memory-source-grants-{label}-{}.sqlite",
        uuid::Uuid::new_v4()
    ))
}

fn remove_sqlite_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

fn assert_corrupt_grant_is_rejected(label: &str, corrupt: impl FnOnce(&Connection)) {
    let path = unique_db_path(label);
    let persisted = grant();
    {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).unwrap());
        facade.upsert_memory_source_grant(&persisted).unwrap();
    }
    {
        let connection = Connection::open(&path).unwrap();
        corrupt(&connection);
    }
    {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).unwrap());
        assert!(
            facade.get_memory_source_grant(&persisted.id).is_err(),
            "corrupt {label} must fail closed"
        );
    }
    remove_sqlite_files(&path);
}

#[test]
fn grants_round_trip_by_consumer_and_id_without_lossy_refs() {
    let facade = facade();
    let owner = UserId::new("owner");
    let project_a = WorkspaceId::new("project-a");

    assert!(
        facade
            .list_memory_source_grants(&owner, &project_a)
            .unwrap()
            .is_empty()
    );

    let grant = grant();
    facade.upsert_memory_source_grant(&grant).unwrap();

    assert_eq!(
        facade
            .list_memory_source_grants(&owner, &project_a)
            .unwrap(),
        vec![grant.clone()]
    );
    assert_eq!(
        facade.get_memory_source_grant("grant-1").unwrap(),
        Some(grant)
    );
    assert!(
        facade
            .list_memory_source_grants(&owner, &WorkspaceId::new("project-b"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn grants_list_in_id_order_within_the_consumer_scope() {
    let facade = facade();
    let owner = UserId::new("owner");
    let project_a = WorkspaceId::new("project-a");

    let mut later = grant();
    later.id = "grant-z".to_string();
    let mut earlier = grant();
    earlier.id = "grant-a".to_string();

    facade.upsert_memory_source_grant(&later).unwrap();
    facade.upsert_memory_source_grant(&earlier).unwrap();

    let listed = facade
        .list_memory_source_grants(&owner, &project_a)
        .unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|grant| grant.id.as_str())
            .collect::<Vec<_>>(),
        vec!["grant-a", "grant-z"]
    );
    assert!(
        facade
            .list_memory_source_grants(&owner, &WorkspaceId::new("project-b"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn upsert_atomically_replaces_mutable_policy_and_child_rows() {
    let facade = facade();
    let original = grant();
    facade.upsert_memory_source_grant(&original).unwrap();

    let replacement_ref = MemoryRef::new(
        MemoryRefKind::Memory,
        UserId::new("owner"),
        WorkspaceId::new("__personal__"),
        "replacement",
    );
    let mut updated = original.clone();
    updated.collections = BTreeSet::from([MemoryCollectionKey::Goals]);
    updated.max_sensitivity = DataSensitivity::Confidential;
    updated.overrides = HashMap::from([(replacement_ref, MemoryGrantOverrideEffect::Deny)]);
    updated.expires_at = None;
    updated.policy_version = 8;
    updated.updated_at = "2026-07-17T11:00:00Z".to_string();

    facade.upsert_memory_source_grant(&updated).unwrap();

    assert_eq!(
        facade.get_memory_source_grant("grant-1").unwrap(),
        Some(updated)
    );
}

#[test]
fn revoke_is_durable_and_idempotently_increments_policy_once() {
    let facade = facade();
    let mut original = grant();
    original.updated_at = "fixed-before-revoke".to_string();
    facade.upsert_memory_source_grant(&original).unwrap();

    facade.revoke_memory_source_grant("grant-1", 20).unwrap();
    let revoked = facade.get_memory_source_grant("grant-1").unwrap().unwrap();
    assert_eq!(revoked.revoked_at, Some(20));
    assert_eq!(revoked.policy_version, original.policy_version + 1);
    assert_ne!(revoked.updated_at, original.updated_at);
    let revoked_updated_at = revoked.updated_at;

    facade.revoke_memory_source_grant("grant-1", 30).unwrap();
    let repeated = facade.get_memory_source_grant("grant-1").unwrap().unwrap();
    assert_eq!(repeated.revoked_at, Some(20));
    assert_eq!(repeated.policy_version, original.policy_version + 1);
    assert_eq!(repeated.updated_at, revoked_updated_at);
}

#[test]
fn invalid_persisted_max_sensitivity_fails_closed() {
    assert_corrupt_grant_is_rejected("sensitivity", |connection| {
        connection
            .execute(
                "update memory_source_grants set max_sensitivity = 'not-a-sensitivity'
                 where id = 'grant-1'",
                [],
            )
            .unwrap();
    });
}

#[test]
fn invalid_persisted_collection_key_fails_closed() {
    assert_corrupt_grant_is_rejected("collection", |connection| {
        connection
            .execute(
                "update memory_source_grant_collections set collection_key = 'not-a-collection'
                 where grant_id = 'grant-1' and collection_key = 'preferences'",
                [],
            )
            .unwrap();
    });
}

#[test]
fn invalid_persisted_override_reference_json_fails_closed() {
    assert_corrupt_grant_is_rejected("override-ref", |connection| {
        connection
            .execute(
                "update memory_source_grant_overrides set memory_ref = '{not-json'
                 where grant_id = 'grant-1' and effect = 'allow'",
                [],
            )
            .unwrap();
    });
}

#[test]
fn invalid_persisted_override_effect_fails_closed() {
    assert_corrupt_grant_is_rejected("override-effect", |connection| {
        connection
            .execute_batch("pragma ignore_check_constraints = on;")
            .unwrap();
        connection
            .execute(
                "update memory_source_grant_overrides set effect = 'not-an-effect'
                 where grant_id = 'grant-1' and effect = 'allow'",
                [],
            )
            .unwrap();
        let corrupted: String = connection
            .query_row(
                "select effect from memory_source_grant_overrides
                 where grant_id = 'grant-1' and effect = 'not-an-effect'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(corrupted, "not-an-effect");
    });
}

#[test]
fn grant_identity_is_immutable_on_conflicting_upsert() {
    let facade = facade();
    let original = grant();
    facade.upsert_memory_source_grant(&original).unwrap();

    let mut rebound_consumer = original.clone();
    rebound_consumer.consumer_workspace_id = WorkspaceId::new("project-b");
    assert!(
        facade
            .upsert_memory_source_grant(&rebound_consumer)
            .is_err()
    );

    let mut rebound_source = original.clone();
    rebound_source.source_workspace_id = WorkspaceId::new("project-source-b");
    assert!(facade.upsert_memory_source_grant(&rebound_source).is_err());

    let mut changed_creator = original.clone();
    changed_creator.created_by = "someone-else".to_string();
    assert!(facade.upsert_memory_source_grant(&changed_creator).is_err());

    let mut changed_created_at = original.clone();
    changed_created_at.created_at = "2026-07-17T12:00:00Z".to_string();
    assert!(
        facade
            .upsert_memory_source_grant(&changed_created_at)
            .is_err()
    );

    assert_eq!(
        facade.get_memory_source_grant("grant-1").unwrap(),
        Some(original)
    );
}

#[test]
fn memory_store_schema_version_is_four() {
    assert_eq!(facade().memory_health().unwrap().schema_version, 4);
}
