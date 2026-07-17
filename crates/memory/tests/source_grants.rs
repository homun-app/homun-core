use local_first_memory::{
    DataSensitivity, MemoryCollectionKey, MemoryError, MemoryFacade, MemoryGrantOverrideEffect,
    MemoryRef, MemoryRefKind, MemorySourceGrant, MemorySourceGrantStoreError, SQLiteMemoryStore,
    UserId, WorkspaceId,
};
use rusqlite::Connection;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

fn facade() -> MemoryFacade {
    MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap())
}

fn get_grant(facade: &MemoryFacade, id: &str) -> Result<Option<MemorySourceGrant>, MemoryError> {
    facade.get_memory_source_grant(&UserId::new("owner"), &WorkspaceId::new("project-a"), id)
}

fn revoke_grant(facade: &MemoryFacade, id: &str, revoked_at: i64) -> Result<(), MemoryError> {
    facade.revoke_memory_source_grant(
        &UserId::new("owner"),
        &WorkspaceId::new("project-a"),
        id,
        revoked_at,
    )
}

fn colliding_refs() -> (MemoryRef, MemoryRef) {
    let mut first = MemoryRef::new(
        MemoryRefKind::Memory,
        UserId::new("owner"),
        WorkspaceId::new("__personal__"),
        "p:owner:__personal__:end",
    );
    first.scope = "a".to_string();

    let mut second = MemoryRef::new(
        MemoryRefKind::Memory,
        UserId::new("owner"),
        WorkspaceId::new("__personal__"),
        "end",
    );
    second.scope = "a:owner:__personal__:p".to_string();

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
        let result = get_grant(&facade, &persisted.id);
        assert!(
            matches!(result, Err(MemoryError::Store(_))),
            "corrupt {label} must fail closed as Store, got {result:?}"
        );
    }
    remove_sqlite_files(&path);
}

fn assert_semantically_corrupt_grant_is_rejected(label: &str, corrupt: impl FnOnce(&Connection)) {
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
        let get_result = facade.get_memory_source_grant(
            &persisted.consumer_user_id,
            &persisted.consumer_workspace_id,
            &persisted.id,
        );
        assert!(
            matches!(get_result, Err(MemoryError::Store(_))),
            "semantic corruption {label} must fail scoped get as Store, got {get_result:?}"
        );

        let list_result = facade.list_memory_source_grants(
            &persisted.consumer_user_id,
            &persisted.consumer_workspace_id,
        );
        assert!(
            matches!(list_result, Err(MemoryError::Store(_))),
            "semantic corruption {label} must fail list as Store, got {list_result:?}"
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
    assert_eq!(get_grant(&facade, "grant-1").unwrap(), Some(grant));
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

    assert_eq!(get_grant(&facade, "grant-1").unwrap(), Some(updated));
}

#[test]
fn revoke_is_durable_and_idempotently_increments_policy_once() {
    let facade = facade();
    let mut original = grant();
    original.updated_at = "fixed-before-revoke".to_string();
    facade.upsert_memory_source_grant(&original).unwrap();

    revoke_grant(&facade, "grant-1", 20).unwrap();
    let revoked = get_grant(&facade, "grant-1").unwrap().unwrap();
    assert_eq!(revoked.revoked_at, Some(20));
    assert_eq!(revoked.policy_version, original.policy_version + 1);
    assert_ne!(revoked.updated_at, original.updated_at);
    let revoked_updated_at = revoked.updated_at;

    revoke_grant(&facade, "grant-1", 30).unwrap();
    let repeated = get_grant(&facade, "grant-1").unwrap().unwrap();
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
fn persisted_cross_user_source_fails_closed_on_get_and_list() {
    assert_semantically_corrupt_grant_is_rejected("semantic-source-user", |connection| {
        connection
            .execute(
                "update memory_source_grants set source_user_id = 'other-user'
                 where id = 'grant-1'",
                [],
            )
            .unwrap();
    });
}

#[test]
fn persisted_reserved_or_self_source_workspace_fails_closed_on_get_and_list() {
    for (label, source_workspace) in [
        ("semantic-source-threads", "__threads__"),
        ("semantic-source-self", "project-a"),
    ] {
        assert_semantically_corrupt_grant_is_rejected(label, |connection| {
            connection
                .execute(
                    "update memory_source_grants set source_workspace_id = ?1
                     where id = 'grant-1'",
                    [source_workspace],
                )
                .unwrap();
        });
    }
}

#[test]
fn persisted_override_with_wrong_kind_fails_closed_on_get_and_list() {
    assert_semantically_corrupt_grant_is_rejected("semantic-override-kind", |connection| {
        let invalid = MemoryRef::new(
            MemoryRefKind::Entity,
            UserId::new("owner"),
            WorkspaceId::new("__personal__"),
            "syntactically-valid-entity",
        );
        connection
            .execute(
                "update memory_source_grant_overrides set memory_ref = ?1
                 where grant_id = 'grant-1' and effect = 'allow'",
                [serde_json::to_string(&invalid).unwrap()],
            )
            .unwrap();
    });
}

#[test]
fn persisted_override_outside_source_fails_closed_on_get_and_list() {
    assert_semantically_corrupt_grant_is_rejected("semantic-override-source", |connection| {
        let invalid = MemoryRef::new(
            MemoryRefKind::Memory,
            UserId::new("other-user"),
            WorkspaceId::new("other-workspace"),
            "syntactically-valid-memory",
        );
        connection
            .execute(
                "update memory_source_grant_overrides set memory_ref = ?1
                 where grant_id = 'grant-1' and effect = 'allow'",
                [serde_json::to_string(&invalid).unwrap()],
            )
            .unwrap();
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

    assert_eq!(get_grant(&facade, "grant-1").unwrap(), Some(original));
}

#[test]
fn memory_store_schema_version_is_four() {
    assert_eq!(facade().memory_health().unwrap().schema_version, 4);
}

fn assert_validation_error(result: Result<(), MemoryError>) {
    assert!(
        matches!(result, Err(MemoryError::Validation(_))),
        "expected validation error, got {result:?}"
    );
}

fn assert_rejected_upsert_leaves_grant_unchanged(candidate: MemorySourceGrant) {
    let facade = facade();
    let original = grant();
    facade.upsert_memory_source_grant(&original).unwrap();

    assert_validation_error(facade.upsert_memory_source_grant(&candidate));
    assert_eq!(get_grant(&facade, &original.id).unwrap(), Some(original));
}

#[test]
fn active_grant_updates_require_the_exact_next_policy_version() {
    let original = grant();

    let mut same_version_change = original.clone();
    same_version_change.collections = BTreeSet::from([MemoryCollectionKey::Goals]);
    assert_rejected_upsert_leaves_grant_unchanged(same_version_change);

    let mut lower_version = original.clone();
    lower_version.policy_version -= 1;
    lower_version.collections = BTreeSet::from([MemoryCollectionKey::Goals]);
    assert_rejected_upsert_leaves_grant_unchanged(lower_version);

    let mut skipped_version = original.clone();
    skipped_version.policy_version += 2;
    skipped_version.collections = BTreeSet::from([MemoryCollectionKey::Goals]);
    assert_rejected_upsert_leaves_grant_unchanged(skipped_version);
}

#[test]
fn active_grant_accepts_a_legitimate_next_version_update() {
    let facade = facade();
    let original = grant();
    facade.upsert_memory_source_grant(&original).unwrap();

    let mut next = original.clone();
    next.policy_version += 1;
    next.collections = BTreeSet::from([MemoryCollectionKey::Goals]);
    next.updated_at = "2026-07-17T12:00:00Z".to_string();
    facade.upsert_memory_source_grant(&next).unwrap();

    assert_eq!(get_grant(&facade, &original.id).unwrap(), Some(next));
}

#[test]
fn revoked_grant_cannot_be_reactivated_or_mutated() {
    let facade = facade();
    let original = grant();
    facade.upsert_memory_source_grant(&original).unwrap();
    revoke_grant(&facade, &original.id, 20).unwrap();
    let revoked = get_grant(&facade, &original.id).unwrap().unwrap();

    let mut reactivation = revoked.clone();
    reactivation.revoked_at = None;
    reactivation.policy_version += 1;
    assert_validation_error(facade.upsert_memory_source_grant(&reactivation));

    let mut mutation = revoked.clone();
    mutation.collections = BTreeSet::from([MemoryCollectionKey::Goals]);
    mutation.policy_version += 1;
    assert_validation_error(facade.upsert_memory_source_grant(&mutation));

    assert_eq!(get_grant(&facade, &original.id).unwrap(), Some(revoked));
}

#[test]
fn new_active_grant_policy_version_must_be_positive_representable_and_have_headroom() {
    for invalid_version in [0, i64::MAX as u64, u64::MAX] {
        let facade = facade();
        let mut invalid = grant();
        invalid.id = format!("invalid-version-{invalid_version}");
        invalid.policy_version = invalid_version;
        assert_validation_error(facade.upsert_memory_source_grant(&invalid));
        assert_eq!(get_grant(&facade, &invalid.id).unwrap(), None);
    }
}

#[test]
fn revoke_overflow_is_atomic_and_leaves_the_corrupt_row_unchanged() {
    let path = unique_db_path("revoke-overflow");
    let original = grant();
    {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).unwrap());
        facade.upsert_memory_source_grant(&original).unwrap();
    }
    {
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch("pragma ignore_check_constraints = on;")
            .unwrap();
        connection
            .execute(
                "update memory_source_grants set policy_version = ?1 where id = ?2",
                (i64::MAX, original.id.as_str()),
            )
            .unwrap();
    }
    {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).unwrap());
        assert_validation_error(revoke_grant(&facade, &original.id, 20));
        assert!(matches!(
            get_grant(&facade, &original.id),
            Err(MemoryError::Store(_))
        ));
    }
    {
        let connection = Connection::open(&path).unwrap();
        let unchanged: (i64, Option<i64>) = connection
            .query_row(
                "select policy_version, revoked_at from memory_source_grants where id = ?1",
                [original.id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(unchanged, (i64::MAX, None));
    }
    remove_sqlite_files(&path);
}

#[test]
fn intrinsic_grant_validation_rejects_unsafe_shapes_with_typed_errors() {
    let mut cases = Vec::new();

    let mut empty_id = grant();
    empty_id.id.clear();
    cases.push(empty_id);

    let mut empty_consumer_user = grant();
    empty_consumer_user.consumer_user_id = UserId::new("");
    cases.push(empty_consumer_user);

    let mut empty_consumer_workspace = grant();
    empty_consumer_workspace.consumer_workspace_id = WorkspaceId::new("");
    cases.push(empty_consumer_workspace);

    let mut empty_source_user = grant();
    empty_source_user.source_user_id = UserId::new("");
    cases.push(empty_source_user);

    let mut empty_source_workspace = grant();
    empty_source_workspace.source_workspace_id = WorkspaceId::new("");
    cases.push(empty_source_workspace);

    let mut empty_creator = grant();
    empty_creator.created_by.clear();
    cases.push(empty_creator);

    let mut personal_consumer = grant();
    personal_consumer.consumer_workspace_id = WorkspaceId::new("__personal__");
    cases.push(personal_consumer);

    let mut threads_consumer = grant();
    threads_consumer.consumer_workspace_id = WorkspaceId::new("__threads__");
    cases.push(threads_consumer);

    let mut threads_source = grant();
    threads_source.source_workspace_id = WorkspaceId::new("__threads__");
    cases.push(threads_source);

    let mut same_workspace = grant();
    same_workspace.source_workspace_id = same_workspace.consumer_workspace_id.clone();
    cases.push(same_workspace);

    let mut cross_user = grant();
    cross_user.source_user_id = UserId::new("other-user");
    cases.push(cross_user);

    let mut no_policy = grant();
    no_policy.collections.clear();
    no_policy.overrides.clear();
    cases.push(no_policy);

    let mut non_memory_override = grant();
    non_memory_override.overrides = HashMap::from([(
        MemoryRef::new(
            MemoryRefKind::Entity,
            non_memory_override.source_user_id.clone(),
            non_memory_override.source_workspace_id.clone(),
            "future-entity",
        ),
        MemoryGrantOverrideEffect::Allow,
    )]);
    cases.push(non_memory_override);

    let mut wrong_override_source = grant();
    wrong_override_source.overrides = HashMap::from([(
        MemoryRef::new(
            MemoryRefKind::Memory,
            wrong_override_source.source_user_id.clone(),
            WorkspaceId::new("another-source"),
            "future-memory",
        ),
        MemoryGrantOverrideEffect::Allow,
    )]);
    cases.push(wrong_override_source);

    let mut wrong_override_user = grant();
    wrong_override_user.overrides = HashMap::from([(
        MemoryRef::new(
            MemoryRefKind::Memory,
            UserId::new("other-user"),
            wrong_override_user.source_workspace_id.clone(),
            "future-memory",
        ),
        MemoryGrantOverrideEffect::Allow,
    )]);
    cases.push(wrong_override_user);

    for (index, mut invalid) in cases.into_iter().enumerate() {
        if !invalid.id.is_empty() {
            invalid.id = format!("invalid-shape-{index}");
        }
        let facade = facade();
        assert_validation_error(facade.upsert_memory_source_grant(&invalid));
    }
}

#[test]
fn override_validation_does_not_require_the_memory_row_to_exist() {
    let facade = facade();
    let grant = grant();
    // Override refs are authorization material. The referenced memory may be
    // created later and the canonical memory table still uses legacy text refs.
    facade.upsert_memory_source_grant(&grant).unwrap();
}

#[test]
fn store_boundary_revalidates_intrinsic_grant_rules() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let mut invalid = grant();
    invalid.consumer_workspace_id = WorkspaceId::new("__personal__");
    assert!(matches!(
        store.upsert_memory_source_grant(&invalid),
        Err(MemorySourceGrantStoreError::Validation(_))
    ));
}

#[test]
fn revoke_can_reach_the_representable_terminal_i64_version() {
    let facade = facade();
    let mut terminal = grant();
    terminal.id = "terminal-version".to_string();
    terminal.policy_version = (i64::MAX - 1) as u64;
    facade.upsert_memory_source_grant(&terminal).unwrap();

    revoke_grant(&facade, &terminal.id, 20).unwrap();
    let revoked = get_grant(&facade, &terminal.id).unwrap().unwrap();
    assert_eq!(revoked.policy_version, i64::MAX as u64);
    assert_eq!(revoked.revoked_at, Some(20));
}

#[test]
fn scoped_get_hides_grants_from_the_wrong_consumer() {
    let facade = facade();
    let persisted = grant();
    facade.upsert_memory_source_grant(&persisted).unwrap();

    assert_eq!(
        facade
            .get_memory_source_grant(
                &UserId::new("other-user"),
                &persisted.consumer_workspace_id,
                &persisted.id,
            )
            .unwrap(),
        None
    );
    assert_eq!(
        facade
            .get_memory_source_grant(
                &persisted.consumer_user_id,
                &WorkspaceId::new("other-project"),
                &persisted.id,
            )
            .unwrap(),
        None
    );
}

#[test]
fn scoped_revoke_rejects_wrong_or_missing_consumer_without_mutation() {
    let facade = facade();
    let persisted = grant();
    facade.upsert_memory_source_grant(&persisted).unwrap();

    let wrong_scope = facade.revoke_memory_source_grant(
        &UserId::new("other-user"),
        &persisted.consumer_workspace_id,
        &persisted.id,
        20,
    );
    assert!(matches!(wrong_scope, Err(MemoryError::NotFound(_))));

    let missing = facade.revoke_memory_source_grant(
        &persisted.consumer_user_id,
        &persisted.consumer_workspace_id,
        "missing-grant",
        20,
    );
    assert!(matches!(missing, Err(MemoryError::NotFound(_))));

    assert_eq!(
        facade
            .get_memory_source_grant(
                &persisted.consumer_user_id,
                &persisted.consumer_workspace_id,
                &persisted.id,
            )
            .unwrap(),
        Some(persisted)
    );
}

#[test]
fn exact_version_noop_skips_writes_and_child_failure_rolls_back_everything() {
    let path = unique_db_path("rollback");
    let original = grant();
    {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).unwrap());
        facade.upsert_memory_source_grant(&original).unwrap();
    }
    {
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "create trigger abort_source_grant_collection_insert
                 before insert on memory_source_grant_collections
                 begin
                    select raise(abort, 'forced child insert failure');
                 end;",
            )
            .unwrap();
    }
    {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).unwrap());

        facade.upsert_memory_source_grant(&original).unwrap();

        let mut changed = original.clone();
        changed.policy_version += 1;
        changed.collections = BTreeSet::from([MemoryCollectionKey::Goals]);
        changed.updated_at = "2026-07-17T13:00:00Z".to_string();
        assert!(matches!(
            facade.upsert_memory_source_grant(&changed),
            Err(MemoryError::Store(_))
        ));

        assert_eq!(get_grant(&facade, &original.id).unwrap(), Some(original));
    }
    remove_sqlite_files(&path);
}

#[test]
fn pooled_reads_never_assemble_parent_and_children_from_different_commits() {
    let path = unique_db_path("snapshot");
    let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).unwrap());
    let owner = UserId::new("owner");
    let consumer = WorkspaceId::new("project-a");

    for index in 0..199 {
        let mut filler = grant();
        filler.id = format!("grant-{index:03}");
        filler.policy_version = 1;
        filler.collections = BTreeSet::from([MemoryCollectionKey::Preferences]);
        filler.overrides.clear();
        facade.upsert_memory_source_grant(&filler).unwrap();
    }

    let mut state_a = grant();
    state_a.id = "grant-199".to_string();
    state_a.policy_version = 1;
    state_a.max_sensitivity = DataSensitivity::Public;
    state_a.collections = BTreeSet::from([MemoryCollectionKey::Preferences]);
    state_a.overrides = HashMap::from([(
        MemoryRef::new(
            MemoryRefKind::Memory,
            state_a.source_user_id.clone(),
            state_a.source_workspace_id.clone(),
            "state-a",
        ),
        MemoryGrantOverrideEffect::Allow,
    )]);
    state_a.updated_at = "state-a".to_string();
    facade.upsert_memory_source_grant(&state_a).unwrap();

    let mut state_b = state_a.clone();
    state_b.policy_version = 2;
    state_b.max_sensitivity = DataSensitivity::Confidential;
    state_b.collections = BTreeSet::from([MemoryCollectionKey::Goals]);
    state_b.overrides = HashMap::from([(
        MemoryRef::new(
            MemoryRefKind::Memory,
            state_b.source_user_id.clone(),
            state_b.source_workspace_id.clone(),
            "state-b",
        ),
        MemoryGrantOverrideEffect::Deny,
    )]);
    state_b.updated_at = "state-b".to_string();

    let stop = Arc::new(AtomicBool::new(false));
    let writer_stop = Arc::clone(&stop);
    let writer_path = path.clone();
    let writer_a = state_a.clone();
    let writer_b = state_b.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let writer = std::thread::spawn(move || {
        let mut connection = Connection::open(writer_path).unwrap();
        connection
            .execute_batch(
                "pragma journal_mode = wal;
                 pragma synchronous = normal;
                 pragma busy_timeout = 5000;",
            )
            .unwrap();
        let mut iteration = 0usize;
        while !writer_stop.load(Ordering::Acquire) && iteration < 20_000 {
            let state = if iteration % 2 == 0 {
                &writer_b
            } else {
                &writer_a
            };
            let transaction = connection.transaction().unwrap();
            transaction
                .execute(
                    "update memory_source_grants
                     set max_sensitivity = ?1, policy_version = ?2, updated_at = ?3
                     where id = ?4",
                    (
                        serde_json::to_value(state.max_sensitivity)
                            .unwrap()
                            .as_str()
                            .unwrap(),
                        state.policy_version as i64,
                        state.updated_at.as_str(),
                        state.id.as_str(),
                    ),
                )
                .unwrap();
            transaction
                .execute(
                    "delete from memory_source_grant_collections where grant_id = ?1",
                    [state.id.as_str()],
                )
                .unwrap();
            for collection in &state.collections {
                transaction
                    .execute(
                        "insert into memory_source_grant_collections (grant_id, collection_key)
                         values (?1, ?2)",
                        (
                            state.id.as_str(),
                            serde_json::to_value(collection).unwrap().as_str().unwrap(),
                        ),
                    )
                    .unwrap();
            }
            transaction
                .execute(
                    "delete from memory_source_grant_overrides where grant_id = ?1",
                    [state.id.as_str()],
                )
                .unwrap();
            for (reference, effect) in &state.overrides {
                transaction
                    .execute(
                        "insert into memory_source_grant_overrides (grant_id, memory_ref, effect)
                         values (?1, ?2, ?3)",
                        (
                            state.id.as_str(),
                            serde_json::to_string(reference).unwrap(),
                            serde_json::to_value(effect).unwrap().as_str().unwrap(),
                        ),
                    )
                    .unwrap();
            }
            transaction.commit().unwrap();
            if iteration == 0 {
                ready_tx.send(()).unwrap();
            }
            iteration += 1;
        }
    });

    ready_rx.recv().unwrap();
    let mut mixed = None;
    for _ in 0..2_000 {
        let listed = facade.list_memory_source_grants(&owner, &consumer).unwrap();
        let observed = listed
            .into_iter()
            .find(|candidate| candidate.id == "grant-199")
            .unwrap();
        if observed != state_a && observed != state_b {
            mixed = Some(observed);
            break;
        }
        let observed = facade
            .get_memory_source_grant(&owner, &consumer, "grant-199")
            .unwrap()
            .unwrap();
        if observed != state_a && observed != state_b {
            mixed = Some(observed);
            break;
        }
    }
    stop.store(true, Ordering::Release);
    writer.join().unwrap();
    assert!(mixed.is_none(), "observed mixed grant state: {mixed:?}");

    drop(facade);
    remove_sqlite_files(&path);
}
