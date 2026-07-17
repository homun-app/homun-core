use local_first_memory::{
    DataSensitivity, MemoryCollectionKey, MemoryFacade, MemoryGrantOverrideEffect, MemoryRef,
    MemoryRefKind, MemorySourceGrant, SQLiteMemoryStore, UserId, WorkspaceId,
};
use std::collections::{BTreeSet, HashMap};

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
    let original = grant();
    facade.upsert_memory_source_grant(&original).unwrap();

    facade.revoke_memory_source_grant("grant-1", 20).unwrap();
    let revoked = facade.get_memory_source_grant("grant-1").unwrap().unwrap();
    assert_eq!(revoked.revoked_at, Some(20));
    assert_eq!(revoked.policy_version, original.policy_version + 1);

    facade.revoke_memory_source_grant("grant-1", 30).unwrap();
    let repeated = facade.get_memory_source_grant("grant-1").unwrap().unwrap();
    assert_eq!(repeated.revoked_at, Some(20));
    assert_eq!(repeated.policy_version, original.policy_version + 1);
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
