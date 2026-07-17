use local_first_memory::{
    AuthorizedMemorySearchRequest, AuthorizedMemorySource, DataSensitivity, MemoryAccessRequest,
    MemoryCollectionKey, MemoryEntity, MemoryFacade, MemoryRecord, MemoryRef, MemoryRefKind,
    MemoryRelation, MemoryScope, MemorySourcePolicy, MemoryStatus, PrivacyDomain,
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

#[test]
fn denied_corpus_cannot_change_authorized_lexical_ranking() {
    fn authorized_order(denied_alpha_records: usize) -> Vec<String> {
        let fixture = RecallFixture::new();
        fixture.insert(
            "allowed-alpha",
            "preference",
            "alpha alpha alpha",
            DataSensitivity::Private,
            serde_json::json!({}),
            &[0.0, 1.0],
        );
        fixture.insert(
            "allowed-beta",
            "preference",
            "beta",
            DataSensitivity::Private,
            serde_json::json!({}),
            &[0.0, 1.0],
        );
        for index in 0..denied_alpha_records {
            fixture.insert(
                &format!("denied-{index:03}"),
                "fact",
                "alpha",
                DataSensitivity::Private,
                serde_json::json!({}),
                &[0.0, 1.0],
            );
        }
        let policy = MemorySourcePolicy::for_collections(
            vec![MemoryCollectionKey::Preferences],
            DataSensitivity::Private,
        );
        recall_source_on_facade(
            &fixture.facade,
            &fixture.source(policy),
            "alpha beta",
            &[],
            None,
        )
        .expect("lexical recall")
        .hits
        .into_iter()
        .map(|hit| hit.memory_ref)
        .collect()
    }

    let authorized_only = authorized_order(0);
    let with_denied_corpus = authorized_order(64);

    assert_eq!(authorized_only.len(), 2);
    assert_eq!(with_denied_corpus, authorized_only);
}

#[test]
fn subject_key_uses_one_canonical_mentions_relation_and_fails_closed_on_ambiguity() {
    let fixture = RecallFixture::new();
    let memory_ref = fixture.insert(
        "related-subject",
        "preference",
        "Keep release notes concise",
        DataSensitivity::Private,
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    let entity_ref = MemoryRef::new(
        MemoryRefKind::Entity,
        fixture.user.clone(),
        fixture.source_workspace.clone(),
        "topic:release-notes",
    );
    fixture
        .facade
        .upsert_entity(&MemoryEntity {
            reference: entity_ref.clone(),
            user_id: fixture.user.clone(),
            workspace_id: fixture.source_workspace.clone(),
            entity_type: "topic".to_string(),
            name: "Release notes".to_string(),
            canonical_key: "topic:release-notes".to_string(),
            aliases: vec![],
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: DataSensitivity::Private,
            metadata: serde_json::json!({}),
        })
        .expect("entity");
    fixture
        .facade
        .upsert_relation(&MemoryRelation {
            reference: MemoryRef::new(
                MemoryRefKind::Relation,
                fixture.user.clone(),
                fixture.source_workspace.clone(),
                "mentions-release-notes",
            ),
            user_id: fixture.user.clone(),
            workspace_id: fixture.source_workspace.clone(),
            source_ref: memory_ref.clone(),
            relation_type: "mentions".to_string(),
            target_ref: entity_ref,
            confidence: 1.0,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: DataSensitivity::Private,
            evidence: vec![],
            metadata: serde_json::json!({}),
        })
        .expect("relation");
    let policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );

    let one_subject = recall_source_on_facade(
        &fixture.facade,
        &fixture.source(policy.clone()),
        "How should release notes be written?",
        &[1.0, 0.0],
        None,
    )
    .expect("recall");
    assert_eq!(
        one_subject.hits[0].subject_key.as_deref(),
        Some("topic:release-notes")
    );

    let second_entity_ref = MemoryRef::new(
        MemoryRefKind::Entity,
        fixture.user.clone(),
        fixture.source_workspace.clone(),
        "project:other",
    );
    fixture
        .facade
        .upsert_entity(&MemoryEntity {
            reference: second_entity_ref.clone(),
            user_id: fixture.user.clone(),
            workspace_id: fixture.source_workspace.clone(),
            entity_type: "project".to_string(),
            name: "Other".to_string(),
            canonical_key: "project:other".to_string(),
            aliases: vec![],
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: DataSensitivity::Private,
            metadata: serde_json::json!({}),
        })
        .expect("second entity");
    fixture
        .facade
        .upsert_relation(&MemoryRelation {
            reference: MemoryRef::new(
                MemoryRefKind::Relation,
                fixture.user.clone(),
                fixture.source_workspace.clone(),
                "mentions-other",
            ),
            user_id: fixture.user.clone(),
            workspace_id: fixture.source_workspace.clone(),
            source_ref: memory_ref,
            relation_type: "mentions".to_string(),
            target_ref: second_entity_ref,
            confidence: 1.0,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: DataSensitivity::Private,
            evidence: vec![],
            metadata: serde_json::json!({}),
        })
        .expect("second relation");

    let ambiguous = recall_source_on_facade(
        &fixture.facade,
        &fixture.source(policy),
        "How should release notes be written?",
        &[1.0, 0.0],
        None,
    )
    .expect("recall");
    assert_eq!(ambiguous.hits[0].subject_key, None);
}

#[test]
fn authorized_lexical_index_works_on_the_file_backed_reader_pool() {
    let path = std::env::temp_dir().join(format!(
        "homun-authorized-recall-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let fixture = RecallFixture {
        facade: MemoryFacade::new(SQLiteMemoryStore::open(&path).expect("file-backed store")),
        user: UserId::new("pooled-recall-user"),
        source_workspace: WorkspaceId::new("pooled-source"),
    };
    let allowed = fixture.insert(
        "pooled-allowed",
        "preference",
        "pooled lexical preference",
        DataSensitivity::Private,
        serde_json::json!({}),
        &[0.0, 1.0],
    );
    for index in 0..16 {
        fixture.insert(
            &format!("pooled-denied-{index}"),
            "fact",
            "pooled lexical preference",
            DataSensitivity::Private,
            serde_json::json!({}),
            &[0.0, 1.0],
        );
    }
    let policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );

    let pack = recall_source_on_facade(
        &fixture.facade,
        &fixture.source(policy),
        "pooled lexical preference",
        &[],
        None,
    )
    .expect("pooled recall");

    assert_eq!(pack.hits.len(), 1);
    assert_eq!(pack.hits[0].memory_ref, allowed.to_string());
    drop(fixture);
    let _ = std::fs::remove_file(path);
}

#[test]
fn authorized_search_reports_the_effective_bounded_limit() {
    let fixture = RecallFixture::new();
    for index in 0..120 {
        fixture.insert(
            &format!("bounded-{index:03}"),
            "preference",
            &format!("Authorized bounded result {index:03}"),
            DataSensitivity::Private,
            serde_json::json!({}),
            &[0.0, 1.0],
        );
    }
    let policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );

    let page = fixture
        .facade
        .search_authorized_memories(AuthorizedMemorySearchRequest {
            access: MemoryAccessRequest {
                actor_id: "test".to_string(),
                user_id: fixture.user.clone(),
                workspace_id: fixture.source_workspace.clone(),
                purpose: "chat_context".to_string(),
                allowed_domains: vec![PrivacyDomain::new("personal")],
                max_sensitivity: DataSensitivity::Private,
                allow_raw_payload: false,
                allow_export: true,
                broad_query: false,
            },
            source_policy: Some(policy),
            query: "authorized bounded".to_string(),
            statuses: vec![MemoryStatus::Confirmed],
            memory_types: vec!["preference".to_string()],
            limit: 150,
            offset: 0,
        })
        .expect("authorized search");

    assert_eq!(page.total, 120);
    assert_eq!(page.items.len(), 100);
    assert_eq!(page.limit, 100);
}
