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
fn collections_match_only_their_declared_memory_types() {
    let cases = [
        (MemoryCollectionKey::Profile, "fact", Some("personal"), true),
        (MemoryCollectionKey::Profile, "fact", None, false),
        (MemoryCollectionKey::Knowledge, "fact", None, true),
        (
            MemoryCollectionKey::Knowledge,
            "fact",
            Some("personal"),
            false,
        ),
        (MemoryCollectionKey::Knowledge, "note", None, true),
        (MemoryCollectionKey::Decisions, "decision", None, true),
        (MemoryCollectionKey::Goals, "goal", None, true),
        (MemoryCollectionKey::Goals, "objective", None, true),
        (MemoryCollectionKey::Goals, "open_loop", None, true),
        (MemoryCollectionKey::Artifacts, "artifact", None, true),
        (MemoryCollectionKey::Episodes, "episode", None, true),
    ];

    for (index, (collection, memory_type, scope, expected)) in cases.into_iter().enumerate() {
        let mut record = memory(
            &format!("case_{index}"),
            memory_type,
            DataSensitivity::Private,
        );
        if let Some(scope) = scope {
            record.metadata = serde_json::json!({"scope": scope});
        }

        assert_eq!(
            collection.matches(&record),
            expected,
            "unexpected match for {collection:?} and {memory_type}"
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
            {"memory_ref": alpha.to_string(), "effect": "deny"},
            {"memory_ref": zeta.to_string(), "effect": "allow"},
        ])
    );
    assert_eq!(
        serde_json::from_value::<MemorySourcePolicy>(json).expect("deserialize policy overrides"),
        policy
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
            {"memory_ref": reference.to_string(), "effect": "allow"}
        ])
    );
    assert_eq!(
        serde_json::from_value::<MemorySourceGrant>(json).expect("deserialize grant overrides"),
        grant
    );
}

#[test]
fn override_deserialization_rejects_malformed_and_duplicate_refs() {
    let malformed = serde_json::json!({
        "collections": ["preferences"],
        "max_sensitivity": "private",
        "overrides": [{"memory_ref": "not-a-memory-ref", "effect": "allow"}],
    });
    let malformed_error = serde_json::from_value::<MemorySourcePolicy>(malformed)
        .expect_err("malformed refs must be rejected");
    assert!(malformed_error.to_string().contains("invalid memory ref"));

    let reference = memory_ref("duplicate").to_string();
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
