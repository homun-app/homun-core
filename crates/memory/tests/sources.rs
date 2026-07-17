use local_first_memory::{
    DataSensitivity, MemoryCollectionKey, MemoryGrantOverrideEffect, MemoryRecord, MemoryRef,
    MemoryRefKind, MemorySourceGrant, MemorySourcePolicy, MemoryStatus, PrivacyDomain, UserId,
    WorkspaceId,
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
