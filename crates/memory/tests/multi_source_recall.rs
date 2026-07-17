use local_first_memory::{
    AuthorizedMemorySource, DataSensitivity, MemoryCollectionKey, MemoryFacade, MemoryRecord,
    MemoryRef, MemoryRefKind, MemoryScope, MemorySourcePolicy, MemoryStatus, PrivacyDomain,
    SQLiteMemoryStore, UserId, WorkspaceId, recall_source_on_facade,
};

struct RecallFixture {
    facade: MemoryFacade,
    user: UserId,
    source_workspace: WorkspaceId,
}

impl RecallFixture {
    fn new() -> Self {
        Self {
            facade: MemoryFacade::new(SQLiteMemoryStore::open_in_memory().expect("store")),
            user: UserId::new("recall-user"),
            source_workspace: WorkspaceId::new("source"),
        }
    }

    fn insert(
        &self,
        key: &str,
        memory_type: &str,
        text: &str,
        sensitivity: DataSensitivity,
        metadata: serde_json::Value,
        embedding: &[f32],
    ) -> MemoryRef {
        let reference = MemoryRef::new(
            MemoryRefKind::Memory,
            self.user.clone(),
            self.source_workspace.clone(),
            key,
        );
        let now = "unix:1800000000".to_string();
        self.facade
            .upsert_memory(&MemoryRecord {
                reference: reference.clone(),
                user_id: self.user.clone(),
                workspace_id: self.source_workspace.clone(),
                memory_type: memory_type.to_string(),
                text: text.to_string(),
                aliases: vec![],
                language_hints: vec![],
                confidence: 0.9,
                status: MemoryStatus::Confirmed,
                privacy_domain: PrivacyDomain::new("personal"),
                sensitivity,
                metadata,
                created_at: now.clone(),
                updated_at: now,
                last_seen_at: None,
                supersedes: vec![],
                superseded_by: None,
                correction_of: None,
            })
            .expect("memory");
        self.facade
            .upsert_embedding(
                &reference,
                &self.user,
                &self.source_workspace,
                "fixture",
                embedding,
            )
            .expect("embedding");
        reference
    }

    fn source(&self, policy: MemorySourcePolicy) -> AuthorizedMemorySource {
        AuthorizedMemorySource {
            source_user_id: self.user.clone(),
            source_workspace_id: self.source_workspace.clone(),
            source_label: "Linked source".to_string(),
            grant_id: Some("grant-1".to_string()),
            policy: Some(policy),
            policy_version: 1,
        }
    }
}

#[test]
fn source_recall_never_returns_denied_secret_or_published_alias_candidates() {
    let fixture = RecallFixture::new();
    let allowed = fixture.insert(
        "allowed",
        "preference",
        "Prefers concise answers",
        DataSensitivity::Private,
        serde_json::json!({"subject_key": "reply-style"}),
        &[1.0, 0.0],
    );
    fixture.insert(
        "wrong-collection",
        "fact",
        "Private family detail",
        DataSensitivity::Private,
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.insert(
        "secret",
        "preference",
        "API key secret",
        DataSensitivity::Secret,
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.insert(
        "published",
        "preference",
        "Published concise preference",
        DataSensitivity::Private,
        serde_json::json!({"published_alias": true}),
        &[1.0, 0.0],
    );
    let policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );

    let pack = recall_source_on_facade(
        &fixture.facade,
        &fixture.source(policy),
        "How should replies be written?",
        &[1.0, 0.0],
        None,
    )
    .expect("recall");

    assert_eq!(pack.hits.len(), 1);
    let hit = &pack.hits[0];
    assert_eq!(hit.memory_ref, allowed.to_string());
    assert_eq!(hit.source_user_id, fixture.user);
    assert_eq!(hit.source_workspace_id.as_str(), "source");
    assert_eq!(hit.source_label, "Linked source");
    assert_eq!(hit.collection, MemoryCollectionKey::Preferences);
    assert_eq!(hit.grant_id.as_deref(), Some("grant-1"));
    assert_eq!(hit.sensitivity, DataSensitivity::Private);
    assert_eq!(hit.status, MemoryStatus::Confirmed);
    assert_eq!(hit.subject_key.as_deref(), Some("reply-style"));
    assert!(!hit.conflict);
    assert_eq!(pack.scope, MemoryScope::Project(WorkspaceId::new("source")));
    let block = pack.block.expect("formatted block");
    assert!(block.contains("[source: Linked source] Prefers concise answers"));
    assert!(!block.contains("family"));
    assert!(!block.contains("secret"));
    assert!(!block.contains("Published"));
    assert_eq!(fixture.facade.vector_index_cache_len_for_tests(), 0);
}

#[test]
fn subject_key_is_never_inferred_from_free_text() {
    let fixture = RecallFixture::new();
    fixture.insert(
        "no-subject",
        "preference",
        "subject_key: must-not-be-inferred",
        DataSensitivity::Private,
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    let policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );

    let pack = recall_source_on_facade(
        &fixture.facade,
        &fixture.source(policy),
        "What preference applies to this answer?",
        &[1.0, 0.0],
        None,
    )
    .expect("recall");

    assert_eq!(pack.hits.len(), 1);
    assert_eq!(pack.hits[0].subject_key, None);
}

#[test]
fn lexical_candidates_are_policy_filtered_before_the_recall_budget() {
    let fixture = RecallFixture::new();
    let allowed = fixture.insert(
        "lexical-allowed",
        "preference",
        "Release notes should be concise",
        DataSensitivity::Private,
        serde_json::json!({"canonical_key": "preference:release-notes"}),
        &[0.0, 1.0],
    );
    fixture.insert(
        "lexical-fact",
        "fact",
        "Release notes include a private family detail",
        DataSensitivity::Private,
        serde_json::json!({}),
        &[0.0, 1.0],
    );
    fixture.insert(
        "lexical-secret",
        "preference",
        "Release notes include an API key",
        DataSensitivity::Secret,
        serde_json::json!({}),
        &[0.0, 1.0],
    );
    fixture.insert(
        "lexical-published",
        "preference",
        "Release notes use the published alias",
        DataSensitivity::Private,
        serde_json::json!({"published_alias": true}),
        &[0.0, 1.0],
    );
    let policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );

    let pack = recall_source_on_facade(
        &fixture.facade,
        &fixture.source(policy),
        "release notes",
        &[],
        None,
    )
    .expect("lexical recall");

    assert_eq!(pack.hits.len(), 1);
    assert_eq!(pack.hits[0].memory_ref, allowed.to_string());
    assert_eq!(
        pack.hits[0].subject_key.as_deref(),
        Some("preference:release-notes")
    );
}
