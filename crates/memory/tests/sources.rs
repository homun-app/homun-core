use local_first_memory::{
    DataSensitivity, MemoryCollectionKey, MemoryGrantOverrideEffect, MemoryRecord, MemoryRef,
    MemoryRefKind, MemorySourcePolicy, MemoryStatus, PrivacyDomain, UserId, WorkspaceId,
};

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
