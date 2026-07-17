use local_first_memory::{
    AuthorizedMemorySource, DataSensitivity, MemoryCollectionKey, MemoryFacade,
    MemoryGrantOverrideEffect, MemoryRecord, MemoryRef, MemoryRefKind, MemorySourceGrant,
    MemorySourcePolicy, MemoryStatus, PrivacyDomain, SQLiteMemoryStore, UserId, WorkspaceId,
    memory_source_policy_fingerprint, resolve_memory_sources,
};
use std::collections::{BTreeSet, HashMap};

#[test]
fn preferences_collection_allows_only_preferences() {
    let preference = memory("preference", "preference", DataSensitivity::Private);
    let fact = memory("fact", "fact", DataSensitivity::Private);
    let policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );

    assert!(policy.allows(&preference).is_allowed());
    let decision = policy.allows(&fact);
    assert!(!decision.is_allowed());
    assert_eq!(decision.reason(), "collection_not_allowed");
}

#[test]
fn individual_deny_wins_and_secret_never_becomes_shareable() {
    let private_preference = memory("private", "preference", DataSensitivity::Private);
    let secret_preference = memory("secret", "preference", DataSensitivity::Secret);
    let mut policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Secret,
    );
    policy.set_override(
        private_preference.reference.clone(),
        MemoryGrantOverrideEffect::Deny,
    );
    policy.set_override(
        secret_preference.reference.clone(),
        MemoryGrantOverrideEffect::Allow,
    );

    let private_decision = policy.allows(&private_preference);
    assert!(!private_decision.is_allowed());
    assert_eq!(private_decision.reason(), "memory_explicitly_denied");

    let secret_decision = policy.allows(&secret_preference);
    assert!(!secret_decision.is_allowed());
    assert_eq!(secret_decision.reason(), "secret_never_shareable");
}

#[test]
fn collections_match_exactly_their_declared_memory_types() {
    let mut profile = memory("profile", "fact", DataSensitivity::Private);
    profile.metadata = serde_json::json!({"scope": "personal"});
    let cases = vec![
        (
            "preference",
            memory("preference", "preference", DataSensitivity::Private),
            BTreeSet::from([MemoryCollectionKey::Preferences]),
        ),
        (
            "personal profile fact",
            profile,
            BTreeSet::from([MemoryCollectionKey::Profile]),
        ),
        (
            "ordinary fact",
            memory("fact", "fact", DataSensitivity::Private),
            BTreeSet::from([MemoryCollectionKey::Knowledge]),
        ),
        (
            "note",
            memory("note", "note", DataSensitivity::Private),
            BTreeSet::from([MemoryCollectionKey::Knowledge]),
        ),
        (
            "decision",
            memory("decision", "decision", DataSensitivity::Private),
            BTreeSet::from([MemoryCollectionKey::Decisions]),
        ),
        (
            "goal",
            memory("goal", "goal", DataSensitivity::Private),
            BTreeSet::from([MemoryCollectionKey::Goals]),
        ),
        (
            "objective",
            memory("objective", "objective", DataSensitivity::Private),
            BTreeSet::from([MemoryCollectionKey::Goals]),
        ),
        (
            "open loop",
            memory("open_loop", "open_loop", DataSensitivity::Private),
            BTreeSet::from([MemoryCollectionKey::Goals]),
        ),
        (
            "artifact",
            memory("artifact", "artifact", DataSensitivity::Private),
            BTreeSet::from([MemoryCollectionKey::Artifacts]),
        ),
        (
            "episode",
            memory("episode", "episode", DataSensitivity::Private),
            BTreeSet::from([MemoryCollectionKey::Episodes]),
        ),
        (
            "unrelated",
            memory("routine", "routine", DataSensitivity::Private),
            BTreeSet::new(),
        ),
    ];
    let collections = [
        MemoryCollectionKey::Preferences,
        MemoryCollectionKey::Profile,
        MemoryCollectionKey::Knowledge,
        MemoryCollectionKey::Decisions,
        MemoryCollectionKey::Goals,
        MemoryCollectionKey::Artifacts,
        MemoryCollectionKey::Episodes,
    ];

    for (label, record, expected) in cases {
        let actual = collections
            .iter()
            .copied()
            .filter(|collection| collection.matches(&record))
            .collect::<BTreeSet<_>>();
        assert_eq!(
            actual, expected,
            "unexpected collection matches for {label}"
        );
    }
}

#[test]
fn secret_bearing_text_and_metadata_are_never_shareable() {
    let policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );
    let mut secret_text = memory("secret_text", "preference", DataSensitivity::Private);
    secret_text.text = "password: hunter2".to_string();
    let mut secret_metadata = memory("secret_metadata", "preference", DataSensitivity::Private);
    secret_metadata.metadata = serde_json::json!({"api_key": "masked"});

    for record in [&secret_text, &secret_metadata] {
        let decision = policy.allows(record);
        assert!(!decision.is_allowed());
        assert_eq!(decision.reason(), "vault_payload_never_shareable");
    }
}

#[test]
fn sensitivity_above_grant_is_denied() {
    let record = memory("confidential", "preference", DataSensitivity::Confidential);
    let policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );

    let decision = policy.allows(&record);

    assert!(!decision.is_allowed());
    assert_eq!(decision.reason(), "sensitivity_above_grant");
}

#[test]
fn explicit_allow_bypasses_only_collection_membership() {
    let record = memory("allowed_fact", "fact", DataSensitivity::Private);
    let mut policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );
    policy.set_override(record.reference.clone(), MemoryGrantOverrideEffect::Allow);

    assert!(policy.allows(&record).is_allowed());
}

#[test]
fn explicit_allow_cannot_bypass_privacy_guards() {
    let mut vault_payload = memory("vault", "fact", DataSensitivity::Private);
    vault_payload.text = "access token: abc123".to_string();
    let cases = [
        (
            memory("secret", "fact", DataSensitivity::Secret),
            DataSensitivity::Secret,
            "secret_never_shareable",
        ),
        (
            vault_payload,
            DataSensitivity::Secret,
            "vault_payload_never_shareable",
        ),
        (
            memory("confidential", "fact", DataSensitivity::Confidential),
            DataSensitivity::Private,
            "sensitivity_above_grant",
        ),
    ];

    for (record, max_sensitivity, expected_reason) in cases {
        let mut policy = MemorySourcePolicy::for_collections(vec![], max_sensitivity);
        policy.set_override(record.reference.clone(), MemoryGrantOverrideEffect::Allow);

        let decision = policy.allows(&record);
        assert!(!decision.is_allowed());
        assert_eq!(decision.reason(), expected_reason);
    }
}

#[test]
fn unknown_collection_value_fails_deserialization() {
    assert!(serde_json::from_str::<MemoryCollectionKey>("\"unknown\"").is_err());
}

#[test]
fn policy_overrides_round_trip_as_a_deterministically_sorted_array() {
    let alpha = memory_ref("alpha");
    let zeta = memory_ref("zeta");
    let mut policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Knowledge],
        DataSensitivity::Private,
    );
    policy.set_override(zeta.clone(), MemoryGrantOverrideEffect::Allow);
    policy.set_override(alpha.clone(), MemoryGrantOverrideEffect::Deny);

    let json = serde_json::to_value(&policy).expect("serialize non-empty policy overrides");

    assert_eq!(
        json["overrides"],
        serde_json::json!([
            {
                "memory_ref": {
                    "kind": "memory",
                    "scope": "local",
                    "user_id": "source_user",
                    "workspace_id": "source_workspace",
                    "key": "alpha",
                },
                "effect": "deny",
            },
            {
                "memory_ref": {
                    "kind": "memory",
                    "scope": "local",
                    "user_id": "source_user",
                    "workspace_id": "source_workspace",
                    "key": "zeta",
                },
                "effect": "allow",
            },
        ])
    );
    assert_eq!(
        serde_json::from_value::<MemorySourcePolicy>(json).expect("deserialize policy overrides"),
        policy
    );
}

#[test]
fn structured_override_refs_preserve_distinct_colon_bearing_fields() {
    let colon_in_user = MemoryRef {
        kind: MemoryRefKind::Memory,
        scope: "local".to_string(),
        user_id: UserId::new("a:b"),
        workspace_id: WorkspaceId::new("c"),
        key: "d".to_string(),
    };
    let colon_in_key = MemoryRef {
        kind: MemoryRefKind::Memory,
        scope: "local".to_string(),
        user_id: UserId::new("a"),
        workspace_id: WorkspaceId::new("b"),
        key: "c:d".to_string(),
    };
    assert_ne!(colon_in_user, colon_in_key);
    assert_eq!(colon_in_user.to_string(), colon_in_key.to_string());

    let mut policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Knowledge],
        DataSensitivity::Private,
    );
    policy.set_override(colon_in_user.clone(), MemoryGrantOverrideEffect::Allow);
    policy.set_override(colon_in_key.clone(), MemoryGrantOverrideEffect::Deny);

    let json = serde_json::to_value(&policy).expect("serialize colliding refs");
    let round_trip =
        serde_json::from_value::<MemorySourcePolicy>(json).expect("deserialize colliding refs");

    assert_eq!(round_trip, policy);
    assert_eq!(round_trip.overrides.len(), 2);
    assert_eq!(
        round_trip.overrides.get(&colon_in_user),
        Some(&MemoryGrantOverrideEffect::Allow)
    );
    assert_eq!(
        round_trip.overrides.get(&colon_in_key),
        Some(&MemoryGrantOverrideEffect::Deny)
    );
}

#[test]
fn grant_with_non_empty_overrides_round_trips_through_json() {
    let reference = memory_ref("grant_memory");
    let grant = source_grant(HashMap::from([(
        reference.clone(),
        MemoryGrantOverrideEffect::Allow,
    )]));

    let json = serde_json::to_value(&grant).expect("serialize non-empty grant overrides");

    assert_eq!(
        json["overrides"],
        serde_json::json!([
            {
                "memory_ref": {
                    "kind": "memory",
                    "scope": "local",
                    "user_id": "source_user",
                    "workspace_id": "source_workspace",
                    "key": "grant_memory",
                },
                "effect": "allow",
            }
        ])
    );
    assert_eq!(
        serde_json::from_value::<MemorySourceGrant>(json).expect("deserialize grant overrides"),
        grant
    );
}

#[test]
fn override_deserialization_rejects_malformed_and_duplicate_refs() {
    let malformed_refs = [
        (
            "missing field",
            serde_json::json!({
                "kind": "memory",
                "scope": "local",
                "user_id": "source_user",
                "workspace_id": "source_workspace",
            }),
            "missing field",
        ),
        (
            "unknown kind",
            serde_json::json!({
                "kind": "unknown",
                "scope": "local",
                "user_id": "source_user",
                "workspace_id": "source_workspace",
                "key": "memory_1",
            }),
            "unknown variant",
        ),
        (
            "wrong type",
            serde_json::json!({
                "kind": "memory",
                "scope": "local",
                "user_id": 42,
                "workspace_id": "source_workspace",
                "key": "memory_1",
            }),
            "invalid type",
        ),
    ];
    for (label, memory_ref, expected_error) in malformed_refs {
        let malformed = serde_json::json!({
            "collections": ["preferences"],
            "max_sensitivity": "private",
            "overrides": [{"memory_ref": memory_ref, "effect": "allow"}],
        });
        let error = serde_json::from_value::<MemorySourcePolicy>(malformed)
            .expect_err("malformed refs must be rejected");
        assert!(
            error.to_string().contains(expected_error),
            "unexpected error for {label}: {error}"
        );
    }

    let reference = serde_json::to_value(memory_ref("duplicate")).unwrap();
    let duplicate = serde_json::json!({
        "collections": ["preferences"],
        "max_sensitivity": "private",
        "overrides": [
            {"memory_ref": reference, "effect": "allow"},
            {"memory_ref": reference, "effect": "deny"},
        ],
    });
    let duplicate_error = serde_json::from_value::<MemorySourcePolicy>(duplicate)
        .expect_err("duplicate refs must be rejected");
    assert!(duplicate_error.to_string().contains("duplicate memory_ref"));
}

#[test]
fn resolver_always_places_the_implicit_local_source_first() {
    let consumer_user = UserId::new("owner");
    let consumer_workspace = WorkspaceId::new("project-a");

    let sources = resolve_memory_sources(&consumer_user, &consumer_workspace, &[], 100).unwrap();

    assert_eq!(
        sources,
        vec![AuthorizedMemorySource {
            source_user_id: consumer_user,
            source_workspace_id: consumer_workspace.clone(),
            source_label: consumer_workspace.as_str().to_string(),
            grant_id: None,
            policy: None,
            policy_version: 0,
        }]
    );
}

#[test]
fn resolver_returns_only_direct_grants_for_the_requested_consumer() {
    let direct = resolver_grant("direct", "owner", "project-a", "owner", "project-b");
    let transitive = resolver_grant("transitive", "owner", "project-b", "owner", "project-c");
    let other_user = resolver_grant("other-user", "other", "project-a", "other", "project-d");
    let other_workspace = resolver_grant(
        "other-workspace",
        "owner",
        "project-z",
        "owner",
        "project-e",
    );

    let sources = resolve_memory_sources(
        &UserId::new("owner"),
        &WorkspaceId::new("project-a"),
        &[transitive, other_user, direct.clone(), other_workspace],
        100,
    )
    .unwrap();

    assert_eq!(sources.len(), 2);
    assert_eq!(sources[1].source_workspace_id.as_str(), "project-b");
    assert_eq!(sources[1].grant_id.as_deref(), Some("direct"));
    assert_eq!(
        sources[1].policy,
        Some(MemorySourcePolicy {
            collections: direct.collections,
            max_sensitivity: direct.max_sensitivity,
            overrides: direct.overrides,
        })
    );
}

#[test]
fn resolver_excludes_revoked_and_expired_grants_at_the_exact_boundary() {
    let mut revoked = resolver_grant("revoked", "owner", "project-a", "owner", "revoked");
    revoked.revoked_at = Some(99);
    let mut past = resolver_grant("past", "owner", "project-a", "owner", "past");
    past.expires_at = Some(99);
    let mut boundary = resolver_grant("boundary", "owner", "project-a", "owner", "boundary");
    boundary.expires_at = Some(100);
    let mut future = resolver_grant("future", "owner", "project-a", "owner", "future");
    future.expires_at = Some(101);

    let sources = resolve_memory_sources(
        &UserId::new("owner"),
        &WorkspaceId::new("project-a"),
        &[future, boundary, past, revoked],
        100,
    )
    .unwrap();

    assert_eq!(sources.len(), 2);
    assert_eq!(sources[1].source_workspace_id.as_str(), "future");
}

#[test]
fn resolver_labels_personal_and_project_sources_and_sorts_them_deterministically() {
    let project_z = resolver_grant("z", "owner", "project-a", "owner", "project-z");
    let personal = resolver_grant("personal", "owner", "project-a", "owner", "__personal__");
    let project_b = resolver_grant("b", "owner", "project-a", "owner", "project-b");
    let inputs = vec![project_z, personal, project_b];
    let mut reversed = inputs.clone();
    reversed.reverse();

    let first = resolve_memory_sources(
        &UserId::new("owner"),
        &WorkspaceId::new("project-a"),
        &inputs,
        100,
    )
    .unwrap();
    let second = resolve_memory_sources(
        &UserId::new("owner"),
        &WorkspaceId::new("project-a"),
        &reversed,
        100,
    )
    .unwrap();

    assert_eq!(first, second);
    assert_eq!(
        first
            .iter()
            .map(|source| source.source_label.as_str())
            .collect::<Vec<_>>(),
        vec!["project-a", "Personal", "project-b", "project-z"]
    );
}

#[test]
fn resolver_fails_closed_for_invalid_matching_grants() {
    let mut cases = Vec::new();

    let cross_user = resolver_grant("cross-user", "owner", "project-a", "other", "project-b");
    cases.push((cross_user, "cross_user_source_not_supported"));

    let self_source = resolver_grant("self", "owner", "project-a", "owner", "project-a");
    cases.push((self_source, "source_equals_consumer"));

    let threads = resolver_grant("threads", "owner", "project-a", "owner", "__threads__");
    cases.push((threads, "reserved_source_scope"));

    let mut empty_policy = resolver_grant("empty", "owner", "project-a", "owner", "project-b");
    empty_policy.collections.clear();
    cases.push((empty_policy, "empty_source_policy"));

    let mut wrong_kind = resolver_grant("kind", "owner", "project-a", "owner", "project-b");
    wrong_kind.overrides.insert(
        MemoryRef::new(
            MemoryRefKind::Entity,
            UserId::new("owner"),
            WorkspaceId::new("project-b"),
            "entity",
        ),
        MemoryGrantOverrideEffect::Allow,
    );
    cases.push((wrong_kind, "invalid_override_kind"));

    let mut wrong_source = resolver_grant("source", "owner", "project-a", "owner", "project-b");
    wrong_source.overrides.insert(
        MemoryRef::new(
            MemoryRefKind::Memory,
            UserId::new("owner"),
            WorkspaceId::new("project-c"),
            "memory",
        ),
        MemoryGrantOverrideEffect::Allow,
    );
    cases.push((wrong_source, "override_outside_source"));

    for (grant, expected) in cases {
        assert_eq!(
            resolve_memory_sources(
                &UserId::new("owner"),
                &WorkspaceId::new("project-a"),
                &[grant],
                100,
            )
            .unwrap_err(),
            expected
        );
    }

    for reserved in ["__personal__", "__threads__"] {
        assert_eq!(
            resolve_memory_sources(&UserId::new("owner"), &WorkspaceId::new(reserved), &[], 100,)
                .unwrap_err(),
            "reserved_consumer_scope"
        );
    }
    assert_eq!(
        resolve_memory_sources(&UserId::new(""), &WorkspaceId::new("project-a"), &[], 100,)
            .unwrap_err(),
        "empty_consumer_user"
    );
    assert_eq!(
        resolve_memory_sources(&UserId::new("owner"), &WorkspaceId::new(""), &[], 100,)
            .unwrap_err(),
        "empty_consumer_workspace"
    );
}

#[test]
fn resolver_rejects_duplicate_active_sources_but_ignores_inactive_duplicates() {
    let first = resolver_grant("first", "owner", "project-a", "owner", "project-b");
    let second = resolver_grant("second", "owner", "project-a", "owner", "project-b");

    assert_eq!(
        resolve_memory_sources(
            &UserId::new("owner"),
            &WorkspaceId::new("project-a"),
            &[first.clone(), second.clone()],
            100,
        )
        .unwrap_err(),
        "duplicate_active_source"
    );

    let mut revoked = second.clone();
    revoked.revoked_at = Some(90);
    let mut expired = second;
    expired.id = "expired".to_string();
    expired.expires_at = Some(100);
    let sources = resolve_memory_sources(
        &UserId::new("owner"),
        &WorkspaceId::new("project-a"),
        &[expired, first, revoked],
        100,
    )
    .unwrap();
    assert_eq!(sources.len(), 2);
}

#[test]
fn policy_fingerprint_is_order_independent_and_ignores_display_labels() {
    let grants = vec![
        resolver_grant("b", "owner", "project-a", "owner", "project-b"),
        resolver_grant("c", "owner", "project-a", "owner", "project-c"),
    ];
    let mut sources = resolve_memory_sources(
        &UserId::new("owner"),
        &WorkspaceId::new("project-a"),
        &grants,
        100,
    )
    .unwrap();
    let expected = memory_source_policy_fingerprint(&sources);
    sources.reverse();
    assert_eq!(memory_source_policy_fingerprint(&sources), expected);
    sources[0].source_label = "Display-only rename".to_string();
    assert_eq!(memory_source_policy_fingerprint(&sources), expected);

    let independently_resolved = resolve_memory_sources(
        &UserId::new("owner"),
        &WorkspaceId::new("project-a"),
        &grants.into_iter().rev().collect::<Vec<_>>(),
        100,
    )
    .unwrap();
    assert_eq!(
        memory_source_policy_fingerprint(&independently_resolved),
        expected
    );
}

#[test]
fn policy_fingerprint_is_independent_of_override_insertion_order() {
    let first_ref = MemoryRef::new(
        MemoryRefKind::Memory,
        UserId::new("owner"),
        WorkspaceId::new("project-b"),
        "first",
    );
    let second_ref = MemoryRef::new(
        MemoryRefKind::Memory,
        UserId::new("owner"),
        WorkspaceId::new("project-b"),
        "second",
    );
    let mut first = resolver_grant("grant", "owner", "project-a", "owner", "project-b");
    first
        .overrides
        .insert(first_ref.clone(), MemoryGrantOverrideEffect::Allow);
    first
        .overrides
        .insert(second_ref.clone(), MemoryGrantOverrideEffect::Deny);
    let mut second = resolver_grant("grant", "owner", "project-a", "owner", "project-b");
    second
        .overrides
        .insert(second_ref, MemoryGrantOverrideEffect::Deny);
    second
        .overrides
        .insert(first_ref, MemoryGrantOverrideEffect::Allow);

    let fingerprint = |grant| {
        memory_source_policy_fingerprint(
            &resolve_memory_sources(
                &UserId::new("owner"),
                &WorkspaceId::new("project-a"),
                &[grant],
                100,
            )
            .unwrap(),
        )
    };
    assert_eq!(fingerprint(first), fingerprint(second));
}

#[test]
fn policy_fingerprint_covers_every_effective_authorization_field() {
    let base = resolver_grant("grant", "owner", "project-a", "owner", "project-b");
    let fingerprint = |grant: MemorySourceGrant| {
        memory_source_policy_fingerprint(
            &resolve_memory_sources(
                &UserId::new("owner"),
                &WorkspaceId::new("project-a"),
                &[grant],
                100,
            )
            .unwrap(),
        )
    };
    let baseline = fingerprint(base.clone());

    let mut mutations = Vec::new();
    let mut source_identity = base.clone();
    source_identity.source_workspace_id = WorkspaceId::new("project-c");
    mutations.push(source_identity);
    let mut grant_id = base.clone();
    grant_id.id = "other-grant".to_string();
    mutations.push(grant_id);
    let mut version = base.clone();
    version.policy_version += 1;
    mutations.push(version);
    let mut collections = base.clone();
    collections.collections.insert(MemoryCollectionKey::Goals);
    mutations.push(collections);
    let mut sensitivity = base.clone();
    sensitivity.max_sensitivity = DataSensitivity::Confidential;
    mutations.push(sensitivity);
    let mut override_ref = base.clone();
    override_ref.overrides.insert(
        MemoryRef::new(
            MemoryRefKind::Memory,
            UserId::new("owner"),
            WorkspaceId::new("project-b"),
            "special",
        ),
        MemoryGrantOverrideEffect::Allow,
    );
    mutations.push(override_ref.clone());
    let mut override_effect = override_ref;
    *override_effect.overrides.values_mut().next().unwrap() = MemoryGrantOverrideEffect::Deny;
    mutations.push(override_effect);

    for mutation in mutations {
        assert_ne!(fingerprint(mutation), baseline);
    }
}

#[test]
fn policy_fingerprint_changes_when_expiry_or_revocation_removes_a_source() {
    let mut grant = resolver_grant("grant", "owner", "project-a", "owner", "project-b");
    grant.expires_at = Some(101);
    let active = resolve_memory_sources(
        &UserId::new("owner"),
        &WorkspaceId::new("project-a"),
        &[grant.clone()],
        100,
    )
    .unwrap();
    let expired = resolve_memory_sources(
        &UserId::new("owner"),
        &WorkspaceId::new("project-a"),
        &[grant.clone()],
        101,
    )
    .unwrap();
    assert_ne!(
        memory_source_policy_fingerprint(&active),
        memory_source_policy_fingerprint(&expired)
    );

    grant.revoked_at = Some(99);
    let revoked = resolve_memory_sources(
        &UserId::new("owner"),
        &WorkspaceId::new("project-a"),
        &[grant],
        100,
    )
    .unwrap();
    assert_eq!(
        memory_source_policy_fingerprint(&expired),
        memory_source_policy_fingerprint(&revoked)
    );
}

#[test]
fn facade_resolves_only_persisted_direct_grants_for_the_requested_consumer() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let direct = resolver_grant("direct", "owner", "project-a", "owner", "project-b");
    let transitive = resolver_grant("transitive", "owner", "project-b", "owner", "project-c");
    facade.upsert_memory_source_grant(&direct).unwrap();
    facade.upsert_memory_source_grant(&transitive).unwrap();

    let sources = facade
        .resolve_memory_sources(&UserId::new("owner"), &WorkspaceId::new("project-a"), 100)
        .unwrap();

    assert_eq!(
        sources
            .iter()
            .map(|source| source.source_workspace_id.as_str())
            .collect::<Vec<_>>(),
        vec!["project-a", "project-b"]
    );
}

fn memory(key: &str, memory_type: &str, sensitivity: DataSensitivity) -> MemoryRecord {
    MemoryRecord {
        reference: MemoryRef::new(
            MemoryRefKind::Memory,
            UserId::new("user_1"),
            WorkspaceId::new("workspace_1"),
            key,
        ),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        memory_type: memory_type.to_string(),
        text: "Fabio prefers Zed".to_string(),
        aliases: vec![],
        language_hints: vec!["en".to_string()],
        confidence: 0.8,
        status: MemoryStatus::Confirmed,
        privacy_domain: PrivacyDomain::new("personal"),
        sensitivity,
        metadata: serde_json::json!({}),
        created_at: "2026-07-17T08:00:00Z".to_string(),
        updated_at: "2026-07-17T08:00:00Z".to_string(),
        last_seen_at: None,
        supersedes: vec![],
        superseded_by: None,
        correction_of: None,
    }
}

fn memory_ref(key: &str) -> MemoryRef {
    MemoryRef::new(
        MemoryRefKind::Memory,
        UserId::new("source_user"),
        WorkspaceId::new("source_workspace"),
        key,
    )
}

fn source_grant(overrides: HashMap<MemoryRef, MemoryGrantOverrideEffect>) -> MemorySourceGrant {
    MemorySourceGrant {
        id: "grant_1".to_string(),
        consumer_user_id: UserId::new("consumer_user"),
        consumer_workspace_id: WorkspaceId::new("consumer_workspace"),
        source_user_id: UserId::new("source_user"),
        source_workspace_id: WorkspaceId::new("source_workspace"),
        collections: BTreeSet::from([MemoryCollectionKey::Knowledge]),
        max_sensitivity: DataSensitivity::Private,
        overrides,
        expires_at: None,
        revoked_at: None,
        policy_version: 1,
        created_by: "user".to_string(),
        created_at: "2026-07-17T08:00:00Z".to_string(),
        updated_at: "2026-07-17T08:00:00Z".to_string(),
    }
}

fn resolver_grant(
    id: &str,
    consumer_user: &str,
    consumer_workspace: &str,
    source_user: &str,
    source_workspace: &str,
) -> MemorySourceGrant {
    MemorySourceGrant {
        id: id.to_string(),
        consumer_user_id: UserId::new(consumer_user),
        consumer_workspace_id: WorkspaceId::new(consumer_workspace),
        source_user_id: UserId::new(source_user),
        source_workspace_id: WorkspaceId::new(source_workspace),
        collections: BTreeSet::from([MemoryCollectionKey::Knowledge]),
        max_sensitivity: DataSensitivity::Private,
        overrides: HashMap::new(),
        expires_at: None,
        revoked_at: None,
        policy_version: 1,
        created_by: consumer_user.to_string(),
        created_at: "2026-07-17T08:00:00Z".to_string(),
        updated_at: "2026-07-17T08:00:00Z".to_string(),
    }
}
