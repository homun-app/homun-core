use local_first_memory::{
    AuthorizedMemorySearchRequest, AuthorizedMemorySource, DataSensitivity, MemoryAccessRequest,
    MemoryCollectionKey, MemoryEntity, MemoryFacade, MemoryGrantOverrideEffect, MemoryRecord,
    MemoryRef, MemoryRefKind, MemoryRelation, MemoryScope, MemorySourceAccessEvent,
    MemorySourceAccessOutcome, MemorySourceGrant, MemorySourcePolicy, MemoryStatus, PrivacyDomain,
    RecallHit, SQLiteMemoryStore, UserId, WorkspaceId, memory_recall_intent, merge_recall_hits,
    recall_authorized_sources_on_facade, recall_authorized_sources_on_facade_with_source_filter,
    recall_source_on_facade,
    revalidate_recall_hits_before_injection,
};
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};

fn hit(
    workspace: &str,
    grant_id: Option<&str>,
    kind: &str,
    text: &str,
    score: f32,
    subject_key: Option<&str>,
) -> RecallHit {
    let collection = match kind {
        "preference" => MemoryCollectionKey::Preferences,
        "decision" => MemoryCollectionKey::Decisions,
        "goal" | "objective" | "open_loop" => MemoryCollectionKey::Goals,
        "artifact" => MemoryCollectionKey::Artifacts,
        "episode" => MemoryCollectionKey::Episodes,
        _ => MemoryCollectionKey::Knowledge,
    };
    RecallHit {
        memory_ref: format!("memory:test-user:{workspace}:{}", text.replace(' ', "-")),
        text: text.to_string(),
        score,
        kind: kind.to_string(),
        source_user_id: UserId::new("test-user"),
        source_workspace_id: WorkspaceId::new(workspace),
        source_label: workspace.to_string(),
        collection,
        grant_id: grant_id.map(str::to_string),
        sensitivity: DataSensitivity::Private,
        status: MemoryStatus::Confirmed,
        updated_at: "unix:1800000000".to_string(),
        subject_key: subject_key.map(str::to_string),
        conflict: false,
        publication_link: None,
    }
}

#[test]
fn intent_router_selects_expected_catalog_collections_without_source_content() {
    let preference = memory_recall_intent("Che lingua e tone preferisci?");
    assert!(
        preference
            .collections
            .contains(&MemoryCollectionKey::Preferences)
    );
    let decision = memory_recall_intent("Quale decisione abbiamo preso?");
    assert!(
        decision
            .collections
            .contains(&MemoryCollectionKey::Decisions)
    );
    let goal = memory_recall_intent("Quale obiettivo manca?");
    assert!(goal.collections.contains(&MemoryCollectionKey::Goals));
    let artifact = memory_recall_intent("Trova il deliverable del progetto");
    assert!(
        artifact
            .collections
            .contains(&MemoryCollectionKey::Artifacts)
    );
    let episode = memory_recall_intent("Cosa abbiamo discusso la scorsa volta?");
    assert!(episode.collections.contains(&MemoryCollectionKey::Episodes));
}

#[test]
fn merge_prefers_local_decision_and_personal_preference_without_hiding_conflict() {
    let local_decision = hit(
        "project-a",
        None,
        "decision",
        "Launch in September",
        0.80,
        Some("launch_date"),
    );
    let linked_decision = hit(
        "project-b",
        Some("grant-b"),
        "decision",
        "Launch in June",
        0.95,
        Some("launch_date"),
    );
    let local_preference = hit(
        "project-a",
        None,
        "preference",
        "Use English",
        0.90,
        Some("reply_language"),
    );
    let personal_preference = hit(
        "__personal__",
        Some("grant-p"),
        "preference",
        "Use Italian",
        0.70,
        Some("reply_language"),
    );

    let merged = merge_recall_hits(
        WorkspaceId::new("project-a"),
        vec![
            local_decision,
            linked_decision,
            local_preference,
            personal_preference,
        ],
        10,
    );

    assert_eq!(merged[0].text, "Launch in September");
    assert!(
        merged
            .iter()
            .any(|item| item.text == "Launch in June" && item.conflict)
    );
    assert!(
        merged
            .iter()
            .position(|item| item.text == "Use Italian")
            .unwrap()
            < merged
                .iter()
                .position(|item| item.text == "Use English")
                .unwrap()
    );
}

#[test]
fn merge_prefers_personal_profile_over_higher_scored_project_profile() {
    let mut project_profile = hit(
        "project-a",
        None,
        "fact",
        "Works as an engineer",
        0.99,
        Some("professional_identity"),
    );
    project_profile.collection = MemoryCollectionKey::Profile;
    let mut personal_profile = hit(
        "__personal__",
        Some("grant-personal"),
        "fact",
        "Works as a product founder",
        0.10,
        Some("professional_identity"),
    );
    personal_profile.collection = MemoryCollectionKey::Profile;

    let merged = merge_recall_hits(
        WorkspaceId::new("project-a"),
        vec![project_profile, personal_profile],
        10,
    );

    assert_eq!(merged[0].source_workspace_id.as_str(), "__personal__");
    assert_eq!(merged[0].text, "Works as a product founder");
    assert!(merged.iter().all(|item| item.conflict));
}

#[test]
fn merge_does_not_invent_conflict_without_explicit_shared_subject() {
    let merged = merge_recall_hits(
        WorkspaceId::new("project-a"),
        vec![
            hit(
                "project-a",
                None,
                "decision",
                "Launch in September",
                0.8,
                None,
            ),
            hit(
                "project-b",
                Some("grant-b"),
                "decision",
                "Launch in June",
                0.9,
                None,
            ),
        ],
        10,
    );

    assert!(merged.iter().all(|item| !item.conflict));
}

#[test]
fn same_source_same_subject_prefers_confirmed_then_newer_without_conflict() {
    let mut candidate = hit(
        "project-a",
        None,
        "decision",
        "Older candidate launch date",
        0.99,
        Some("launch"),
    );
    candidate.status = MemoryStatus::Candidate;
    candidate.updated_at = "unix:1800000002".to_string();
    let mut confirmed_old = hit(
        "project-a",
        None,
        "decision",
        "Older confirmed launch date",
        0.1,
        Some("launch"),
    );
    confirmed_old.updated_at = "unix:1800000000".to_string();
    let mut confirmed_new = hit(
        "project-a",
        None,
        "decision",
        "Newest confirmed launch date",
        0.05,
        Some("launch"),
    );
    confirmed_new.updated_at = "unix:1800000001".to_string();

    let merged = merge_recall_hits(
        WorkspaceId::new("project-a"),
        vec![candidate, confirmed_old, confirmed_new],
        10,
    );

    assert_eq!(merged[0].text, "Newest confirmed launch date");
    assert!(merged.iter().all(|item| !item.conflict));
}

#[test]
fn conflicting_hits_use_a_separate_prompt_section_and_degraded_reasons_stay_out() {
    let mut left = hit(
        "project-a",
        None,
        "decision",
        "Launch in September",
        0.8,
        Some("launch"),
    );
    left.conflict = true;
    let mut right = hit(
        "project-b",
        Some("grant-b"),
        "decision",
        "Launch in June",
        0.9,
        Some("launch"),
    );
    right.conflict = true;
    let pack = local_first_memory::RecallPack::from_hits_and_degraded(
        "launch date".to_string(),
        MemoryScope::Project(WorkspaceId::new("project-a")),
        vec![left, right],
        vec![(
            WorkspaceId::new("project-c"),
            "source_unavailable".to_string(),
        )],
    );

    let block = pack.block.expect("prompt block");
    assert!(block.contains("CONFLICTING MEMORY"));
    assert!(block.contains("[source: project-a] Launch in September"));
    assert!(block.contains("[source: project-b] Launch in June"));
    assert!(!block.contains("source_unavailable"));
}

#[test]
fn merge_reserves_four_local_slots_and_deduplicates_ref_text_and_publication_link() {
    let mut hits = (0..6)
        .map(|index| {
            hit(
                "project-a",
                None,
                "fact",
                &format!("Local {index}"),
                0.1 + index as f32 / 100.0,
                None,
            )
        })
        .collect::<Vec<_>>();
    hits.extend((0..10).map(|index| {
        hit(
            "project-b",
            Some("grant-b"),
            "fact",
            &format!("Linked {index}"),
            1.0 - index as f32 / 100.0,
            None,
        )
    }));
    let duplicate_ref = hits[0].clone();
    let mut duplicate_text = hit(
        "project-b",
        Some("grant-b"),
        "fact",
        "  LOCAL   1 ",
        0.99,
        None,
    );
    duplicate_text.memory_ref = "memory:test-user:project-b:duplicate-text".to_string();
    let mut published_a = hit("project-a", None, "fact", "Published A", 0.2, None);
    published_a.publication_link = Some("publication-1".to_string());
    let mut published_b = hit(
        "project-b",
        Some("grant-b"),
        "fact",
        "Published B",
        1.1,
        None,
    );
    published_b.publication_link = Some("publication-1".to_string());
    hits.extend([duplicate_ref, duplicate_text, published_a, published_b]);

    let merged = merge_recall_hits(WorkspaceId::new("project-a"), hits, 10);

    assert!(
        merged
            .iter()
            .filter(|item| item.source_workspace_id.as_str() == "project-a")
            .count()
            >= 4
    );
    assert_eq!(
        merged
            .iter()
            .filter(|item| {
                item.text
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .eq_ignore_ascii_case("local 1")
            })
            .count(),
        1
    );
    assert_eq!(
        merged
            .iter()
            .filter(|item| item.publication_link.as_deref() == Some("publication-1"))
            .count(),
        1
    );
}

struct MultiSourceFixture {
    facade: std::sync::Arc<MemoryFacade>,
    user: UserId,
    consumer: WorkspaceId,
}

impl MultiSourceFixture {
    fn new() -> Self {
        Self {
            facade: std::sync::Arc::new(MemoryFacade::new(
                SQLiteMemoryStore::open_in_memory().expect("store"),
            )),
            user: UserId::new("multi-user"),
            consumer: WorkspaceId::new("project-a"),
        }
    }

    fn insert(
        &self,
        workspace: &str,
        key: &str,
        memory_type: &str,
        text: &str,
        metadata: serde_json::Value,
        embedding: &[f32],
    ) -> MemoryRef {
        let workspace = WorkspaceId::new(workspace);
        let reference = MemoryRef::new(
            MemoryRefKind::Memory,
            self.user.clone(),
            workspace.clone(),
            key,
        );
        self.facade
            .upsert_memory(&MemoryRecord {
                reference: reference.clone(),
                user_id: self.user.clone(),
                workspace_id: workspace.clone(),
                memory_type: memory_type.to_string(),
                text: text.to_string(),
                aliases: Vec::new(),
                language_hints: Vec::new(),
                confidence: 0.9,
                status: MemoryStatus::Confirmed,
                privacy_domain: PrivacyDomain::new("work"),
                sensitivity: DataSensitivity::Private,
                metadata,
                created_at: "unix:1800000000".to_string(),
                updated_at: "unix:1800000000".to_string(),
                last_seen_at: None,
                supersedes: Vec::new(),
                superseded_by: None,
                correction_of: None,
            })
            .expect("memory");
        self.facade
            .upsert_embedding(&reference, &self.user, &workspace, "fixture", embedding)
            .expect("embedding");
        reference
    }

    fn grant(
        &self,
        id: &str,
        source_workspace: &str,
        collections: impl IntoIterator<Item = MemoryCollectionKey>,
        overrides: HashMap<MemoryRef, MemoryGrantOverrideEffect>,
    ) {
        self.facade
            .upsert_memory_source_grant(&MemorySourceGrant {
                id: id.to_string(),
                consumer_user_id: self.user.clone(),
                consumer_workspace_id: self.consumer.clone(),
                source_user_id: self.user.clone(),
                source_workspace_id: WorkspaceId::new(source_workspace),
                collections: collections.into_iter().collect::<BTreeSet<_>>(),
                max_sensitivity: DataSensitivity::Private,
                overrides,
                expires_at: None,
                revoked_at: None,
                policy_version: 1,
                created_by: "owner".to_string(),
                created_at: "unix:1800000000".to_string(),
                updated_at: "unix:1800000000".to_string(),
            })
            .expect("grant");
    }
}

#[test]
fn coordinator_queries_local_always_and_linked_only_on_intent_or_individual_allow() {
    let fixture = MultiSourceFixture::new();
    fixture.insert(
        "project-a",
        "local-decision",
        "decision",
        "Decision query keeps the local result",
        serde_json::json!({"subject_key": "launch"}),
        &[1.0, 0.0],
    );
    let linked_fact = fixture.insert(
        "project-b",
        "linked-fact",
        "fact",
        "Decision query linked override result",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.grant(
        "grant-b",
        "project-b",
        [MemoryCollectionKey::Preferences],
        HashMap::new(),
    );

    let without_override = recall_authorized_sources_on_facade(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        "decision query",
        &[1.0, 0.0],
        1_800_000_000,
        None,
    )
    .expect("local recall");
    assert_eq!(without_override.hits.len(), 1);
    assert_eq!(
        without_override.hits[0].source_workspace_id,
        fixture.consumer
    );

    fixture
        .facade
        .upsert_memory_source_grant(&MemorySourceGrant {
            id: "grant-b".to_string(),
            consumer_user_id: fixture.user.clone(),
            consumer_workspace_id: fixture.consumer.clone(),
            source_user_id: fixture.user.clone(),
            source_workspace_id: WorkspaceId::new("project-b"),
            collections: BTreeSet::from([MemoryCollectionKey::Preferences]),
            max_sensitivity: DataSensitivity::Private,
            overrides: HashMap::from([(linked_fact, MemoryGrantOverrideEffect::Allow)]),
            expires_at: None,
            revoked_at: None,
            policy_version: 2,
            created_by: "owner".to_string(),
            created_at: "unix:1800000000".to_string(),
            updated_at: "unix:1800000001".to_string(),
        })
        .expect("updated grant");

    let with_override = recall_authorized_sources_on_facade(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        "decision query",
        &[1.0, 0.0],
        1_800_000_000,
        None,
    )
    .expect("linked recall");
    assert!(
        with_override
            .hits
            .iter()
            .any(|item| item.source_workspace_id.as_str() == "project-b")
    );
}

#[test]
fn coordinator_loads_one_source_authorization_snapshot_per_resolution_pass() {
    let fixture = MultiSourceFixture::new();
    fixture.insert(
        "project-b",
        "linked-decision",
        "decision",
        "Linked decision is in September",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.grant(
        "grant-b",
        "project-b",
        [MemoryCollectionKey::Decisions],
        HashMap::new(),
    );
    let snapshots = AtomicUsize::new(0);

    let pack = recall_authorized_sources_on_facade_with_source_filter(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        "Which decision did we make?",
        &[1.0, 0.0],
        1_800_000_000,
        None,
        &|sources| {
            snapshots.fetch_add(1, Ordering::SeqCst);
            vec![true; sources.len()]
        },
    )
    .expect("recall with source snapshots");

    assert!(pack
        .hits
        .iter()
        .any(|hit| hit.source_workspace_id.as_str() == "project-b"));
    assert_eq!(snapshots.load(Ordering::SeqCst), 3);
}

#[test]
fn linked_recall_intersects_grant_collections_with_query_intent() {
    let fixture = MultiSourceFixture::new();
    fixture.insert(
        "project-b",
        "linked-preference",
        "preference",
        "Language preference shared intent marker",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.insert(
        "project-b",
        "linked-goal",
        "goal",
        "Language preference shared intent marker goal",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.grant(
        "grant-b",
        "project-b",
        [MemoryCollectionKey::Preferences, MemoryCollectionKey::Goals],
        HashMap::new(),
    );
    let pack = recall_authorized_sources_on_facade(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        "language preference shared intent marker",
        &[],
        1_800_000_000,
        None,
    )
    .expect("recall");
    let linked = pack
        .hits
        .iter()
        .filter(|item| item.source_workspace_id.as_str() == "project-b")
        .collect::<Vec<_>>();

    assert_eq!(linked.len(), 1);
    assert_eq!(linked[0].collection, MemoryCollectionKey::Preferences);
}

#[test]
fn individual_allow_outside_intent_does_not_reopen_other_granted_collections() {
    let fixture = MultiSourceFixture::new();
    fixture.insert(
        "project-b",
        "linked-preference",
        "preference",
        "Language preference override intent marker",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.insert(
        "project-b",
        "linked-goal",
        "goal",
        "Language preference override intent marker goal",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    let individually_allowed = fixture.insert(
        "project-b",
        "linked-artifact",
        "artifact",
        "Language preference override intent marker artifact",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.grant(
        "grant-b",
        "project-b",
        [MemoryCollectionKey::Preferences, MemoryCollectionKey::Goals],
        HashMap::from([(
            individually_allowed.clone(),
            MemoryGrantOverrideEffect::Allow,
        )]),
    );

    let pack = recall_authorized_sources_on_facade(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        "language preference override intent marker",
        &[],
        1_800_000_000,
        None,
    )
    .expect("recall");
    let linked = pack
        .hits
        .iter()
        .filter(|item| item.source_workspace_id.as_str() == "project-b")
        .collect::<Vec<_>>();

    assert!(
        linked
            .iter()
            .any(|item| item.collection == MemoryCollectionKey::Preferences)
    );
    assert!(
        linked
            .iter()
            .any(|item| item.memory_ref == individually_allowed.to_string())
    );
    assert!(
        linked
            .iter()
            .all(|item| item.collection != MemoryCollectionKey::Goals)
    );
}

#[test]
fn coordinator_never_follows_a_linked_projects_own_sources() {
    let fixture = MultiSourceFixture::new();
    fixture.insert(
        "project-a",
        "local-decision",
        "decision",
        "Transitive decision query local result",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.insert(
        "project-c",
        "transitive-decision",
        "decision",
        "Transitive decision query must stay hidden",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.grant(
        "grant-a-b",
        "project-b",
        [MemoryCollectionKey::Decisions],
        HashMap::new(),
    );
    fixture
        .facade
        .upsert_memory_source_grant(&MemorySourceGrant {
            id: "grant-b-c".to_string(),
            consumer_user_id: fixture.user.clone(),
            consumer_workspace_id: WorkspaceId::new("project-b"),
            source_user_id: fixture.user.clone(),
            source_workspace_id: WorkspaceId::new("project-c"),
            collections: BTreeSet::from([MemoryCollectionKey::Decisions]),
            max_sensitivity: DataSensitivity::Private,
            overrides: HashMap::new(),
            expires_at: None,
            revoked_at: None,
            policy_version: 1,
            created_by: "owner".to_string(),
            created_at: "unix:1800000000".to_string(),
            updated_at: "unix:1800000000".to_string(),
        })
        .expect("transitive grant fixture");

    let pack = recall_authorized_sources_on_facade(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        "transitive decision query",
        &[1.0, 0.0],
        1_800_000_000,
        None,
    )
    .expect("recall");

    assert!(
        pack.hits
            .iter()
            .all(|item| item.source_workspace_id.as_str() != "project-c")
    );
}

#[test]
fn linked_source_failure_degrades_to_local_hits_with_redacted_reason() {
    let path = std::env::temp_dir().join(format!(
        "homun-multi-source-degraded-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let fixture = MultiSourceFixture {
        facade: std::sync::Arc::new(MemoryFacade::new(
            SQLiteMemoryStore::open(&path).expect("store"),
        )),
        user: UserId::new("multi-user"),
        consumer: WorkspaceId::new("project-a"),
    };
    fixture.insert(
        "project-a",
        "local-preference",
        "preference",
        "Language preference local result",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.insert(
        "project-b",
        "linked-preference",
        "preference",
        "Language preference linked result",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.grant(
        "grant-b",
        "project-b",
        [MemoryCollectionKey::Preferences],
        HashMap::new(),
    );
    let connection = rusqlite::Connection::open(&path).expect("external sqlite");
    connection
        .execute(
            "update memory_embeddings set vector = ?1 where workspace_id = 'project-b'",
            [f32::NAN.to_le_bytes().to_vec()],
        )
        .expect("corrupt linked derived vector");

    let pack = recall_authorized_sources_on_facade(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        "language preference",
        &[1.0, 0.0],
        1_800_000_000,
        None,
    )
    .expect("local recall survives linked failure");

    assert!(
        pack.hits
            .iter()
            .any(|item| item.source_workspace_id == fixture.consumer)
    );
    assert!(
        pack.hits
            .iter()
            .all(|item| item.source_workspace_id.as_str() != "project-b")
    );
    assert_eq!(
        pack.degraded_sources,
        vec![(
            WorkspaceId::new("project-b"),
            "source_unavailable".to_string()
        )]
    );
    assert!(!format!("{:?}", pack.degraded_sources).contains("finite"));

    drop(connection);
    drop(fixture);
    let _ = std::fs::remove_file(path);
}

#[test]
fn local_source_failure_is_fatal() {
    let path = std::env::temp_dir().join(format!(
        "homun-multi-source-local-fatal-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let fixture = MultiSourceFixture {
        facade: std::sync::Arc::new(MemoryFacade::new(
            SQLiteMemoryStore::open(&path).expect("store"),
        )),
        user: UserId::new("multi-user"),
        consumer: WorkspaceId::new("project-a"),
    };
    fixture.insert(
        "project-a",
        "local-preference",
        "preference",
        "Language preference local result",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    let connection = rusqlite::Connection::open(&path).expect("external sqlite");
    connection
        .execute(
            "update memory_embeddings set vector = ?1 where workspace_id = 'project-a'",
            [f32::NAN.to_le_bytes().to_vec()],
        )
        .expect("corrupt local derived vector");

    let result = recall_authorized_sources_on_facade(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        "language preference",
        &[1.0, 0.0],
        1_800_000_000,
        None,
    );

    assert!(result.is_err());
    drop(connection);
    drop(fixture);
    let _ = std::fs::remove_file(path);
}

#[test]
fn authorized_vector_cache_keys_policy_and_source_generation() {
    let fixture = RecallFixture::new();
    fixture.insert(
        "cached-one",
        "preference",
        "Cached language preference one",
        DataSensitivity::Private,
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    let source = fixture.source(MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    ));

    fixture
        .facade
        .search_authorized_embeddings(&source, &[1.0, 0.0], 8)
        .expect("first authorized search");
    fixture
        .facade
        .search_authorized_embeddings(&source, &[1.0, 0.0], 8)
        .expect("cached authorized search");
    assert_eq!(
        fixture.facade.authorized_vector_index_cache_len_for_tests(),
        1
    );

    fixture.insert(
        "cached-two",
        "preference",
        "Cached language preference two",
        DataSensitivity::Private,
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture
        .facade
        .search_authorized_embeddings(&source, &[1.0, 0.0], 8)
        .expect("generation invalidates cache");
    assert_eq!(
        fixture.facade.authorized_vector_index_cache_len_for_tests(),
        2
    );

    let changed_policy = fixture.source(MemorySourcePolicy::for_collections(
        vec![
            MemoryCollectionKey::Preferences,
            MemoryCollectionKey::Knowledge,
        ],
        DataSensitivity::Private,
    ));
    fixture
        .facade
        .search_authorized_embeddings(&changed_policy, &[1.0, 0.0], 8)
        .expect("policy invalidates cache");
    assert_eq!(
        fixture.facade.authorized_vector_index_cache_len_for_tests(),
        3
    );
    assert_eq!(fixture.facade.vector_index_cache_len_for_tests(), 0);
}

#[test]
fn authorized_vector_cache_invalidates_when_an_embedding_is_added() {
    let fixture = RecallFixture::new();
    let reference = MemoryRef::new(
        MemoryRefKind::Memory,
        fixture.user.clone(),
        fixture.source_workspace.clone(),
        "late-embedding",
    );
    fixture
        .facade
        .upsert_memory(&MemoryRecord {
            reference: reference.clone(),
            user_id: fixture.user.clone(),
            workspace_id: fixture.source_workspace.clone(),
            memory_type: "preference".to_string(),
            text: "Late embedding language preference".to_string(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 0.9,
            status: MemoryStatus::Confirmed,
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: DataSensitivity::Private,
            metadata: serde_json::json!({}),
            created_at: "unix:1800000000".to_string(),
            updated_at: "unix:1800000000".to_string(),
            last_seen_at: None,
            supersedes: Vec::new(),
            superseded_by: None,
            correction_of: None,
        })
        .expect("memory");
    let source = fixture.source(MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    ));
    assert!(
        fixture
            .facade
            .search_authorized_embeddings(&source, &[1.0, 0.0], 8)
            .expect("empty derived index")
            .is_empty()
    );

    fixture
        .facade
        .upsert_embedding(
            &reference,
            &fixture.user,
            &fixture.source_workspace,
            "fixture",
            &[1.0, 0.0],
        )
        .expect("late embedding");

    let hits = fixture
        .facade
        .search_authorized_embeddings(&source, &[1.0, 0.0], 8)
        .expect("refreshed derived index");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].memory_ref, reference);
}

#[test]
fn authorized_vector_cache_is_capped_and_evicts_deterministically() {
    let fixture = MultiSourceFixture::new();
    for index in 0..65 {
        let workspace = format!("source-{index:03}");
        fixture.insert(
            &workspace,
            "preference",
            "preference",
            "Cache cap language preference",
            serde_json::json!({}),
            &[1.0, 0.0],
        );
        let source = AuthorizedMemorySource {
            source_user_id: fixture.user.clone(),
            source_workspace_id: WorkspaceId::new(&workspace),
            source_label: workspace,
            grant_id: Some(format!("grant-{index:03}")),
            policy: Some(MemorySourcePolicy::for_collections(
                vec![MemoryCollectionKey::Preferences],
                DataSensitivity::Private,
            )),
            policy_version: 1,
        };
        fixture
            .facade
            .search_authorized_embeddings(&source, &[1.0, 0.0], 8)
            .expect("authorized cache insert");
    }

    assert_eq!(
        fixture.facade.authorized_vector_index_cache_len_for_tests(),
        64
    );
    let cached_workspaces = fixture
        .facade
        .authorized_vector_index_cache_workspaces_for_tests();
    assert!(!cached_workspaces.contains(&"source-000".to_string()));
    assert!(cached_workspaces.contains(&"source-064".to_string()));

    let uncached_low_generation = AuthorizedMemorySource {
        source_user_id: fixture.user.clone(),
        source_workspace_id: WorkspaceId::new("source-low-generation"),
        source_label: "low generation".to_string(),
        grant_id: Some("grant-low-generation".to_string()),
        policy: Some(MemorySourcePolicy::for_collections(
            vec![MemoryCollectionKey::Preferences],
            DataSensitivity::Private,
        )),
        policy_version: 1,
    };
    let result = fixture
        .facade
        .search_authorized_embeddings(&uncached_low_generation, &[1.0, 0.0], 8)
        .expect("an evicted new entry still serves its current search");
    assert!(result.is_empty());
    assert_eq!(
        fixture.facade.authorized_vector_index_cache_len_for_tests(),
        64
    );
    assert!(
        !fixture
            .facade
            .authorized_vector_index_cache_workspaces_for_tests()
            .contains(&"source-low-generation".to_string())
    );
}

#[test]
fn policy_change_before_injection_drops_all_linked_hits_and_remerges_local_only() {
    let fixture = MultiSourceFixture::new();
    fixture.grant(
        "grant-b",
        "project-b",
        [MemoryCollectionKey::Decisions],
        HashMap::new(),
    );
    let initial_sources = fixture
        .facade
        .resolve_memory_sources(&fixture.user, &fixture.consumer, 1_800_000_000)
        .expect("initial sources");
    fixture
        .facade
        .revoke_memory_source_grant(&fixture.user, &fixture.consumer, "grant-b", 1_800_000_001)
        .expect("concurrent revoke");

    let mut local_hit = hit(
        "project-a",
        None,
        "decision",
        "Local decision remains",
        0.8,
        Some("launch"),
    );
    local_hit.source_user_id = fixture.user.clone();
    let mut linked_hit = hit(
        "project-b",
        Some("grant-b"),
        "decision",
        "Linked decision revoked",
        0.9,
        Some("launch"),
    );
    linked_hit.source_user_id = fixture.user.clone();
    let (hits, degraded) = revalidate_recall_hits_before_injection(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        &initial_sources,
        vec![local_hit, linked_hit],
        1_800_000_001,
        10,
    )
    .expect("fail-closed revalidation");

    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].source_workspace_id, fixture.consumer);
    assert_eq!(
        degraded,
        vec![(WorkspaceId::new("project-b"), "policy_changed".to_string())]
    );
}

#[test]
fn policy_is_rechecked_after_audit_at_the_final_injection_boundary() {
    let path = std::env::temp_dir().join(format!(
        "homun-multi-source-final-recheck-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let fixture = MultiSourceFixture {
        facade: std::sync::Arc::new(MemoryFacade::new(
            SQLiteMemoryStore::open(&path).expect("store"),
        )),
        user: UserId::new("multi-user"),
        consumer: WorkspaceId::new("project-a"),
    };
    fixture.insert(
        "project-a",
        "local-preference",
        "preference",
        "Final boundary language preference local",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.insert(
        "project-b",
        "linked-preference",
        "preference",
        "Final boundary language preference linked",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.grant(
        "grant-b",
        "project-b",
        [MemoryCollectionKey::Preferences],
        HashMap::new(),
    );
    let connection = rusqlite::Connection::open(&path).expect("external sqlite");
    connection
        .execute_batch(
            "create trigger revoke_grant_during_linked_audit
             before insert on memory_source_access_events
             when new.grant_id = 'grant-b'
              and exists(select 1 from memory_source_grants where id = 'grant-b' and revoked_at is null)
             begin
               update memory_source_grants
               set revoked_at = 1800000001, policy_version = policy_version + 1
               where id = 'grant-b' and revoked_at is null;
             end;",
        )
        .expect("concurrent revoke trigger");

    let pack = recall_authorized_sources_on_facade(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        "final boundary language preference",
        &[1.0, 0.0],
        1_800_000_000,
        None,
    )
    .expect("recall");

    assert!(
        pack.hits
            .iter()
            .all(|item| item.source_workspace_id.as_str() != "project-b")
    );
    assert!(
        pack.degraded_sources.iter().any(|(source, reason)| {
            source.as_str() == "project-b" && reason == "policy_changed"
        })
    );
    let last = fixture
        .facade
        .last_memory_source_access("grant-b")
        .expect("last access")
        .expect("corrective access event");
    assert_eq!(last.outcome, MemorySourceAccessOutcome::Degraded);
    assert_eq!(last.reason, "policy_changed");
    assert!(last.injected_refs.is_empty());

    drop(connection);
    drop(fixture);
    let _ = std::fs::remove_file(path);
}

#[test]
fn coordinator_records_source_level_audit_without_query_or_memory_text() {
    let path = std::env::temp_dir().join(format!(
        "homun-multi-source-audit-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let fixture = MultiSourceFixture {
        facade: std::sync::Arc::new(MemoryFacade::new(
            SQLiteMemoryStore::open(&path).expect("store"),
        )),
        user: UserId::new("multi-user"),
        consumer: WorkspaceId::new("project-a"),
    };
    fixture.insert(
        "project-a",
        "local-preference",
        "preference",
        "Local language preference text must not enter audit",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.insert(
        "project-b",
        "linked-preference",
        "preference",
        "Linked language preference text must not enter audit",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.grant(
        "grant-b",
        "project-b",
        [MemoryCollectionKey::Preferences],
        HashMap::new(),
    );

    let pack = recall_authorized_sources_on_facade(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        "language audit-query-must-not-be-stored",
        &[1.0, 0.0],
        1_800_000_000,
        None,
    )
    .expect("recall");
    assert!(pack.degraded_sources.is_empty());

    let last = fixture
        .facade
        .last_memory_source_access("grant-b")
        .expect("last access")
        .expect("linked audit event");
    assert_eq!(last.consumer_workspace_id, fixture.consumer);
    assert_eq!(last.source_workspace_id.as_str(), "project-b");
    assert_eq!(last.policy_version, 1);
    assert!(last.candidate_count >= 1);
    assert!(!last.injected_refs.is_empty());

    let connection = rusqlite::Connection::open(&path).expect("audit sqlite");
    let columns = connection
        .prepare("pragma table_info(memory_source_access_events)")
        .expect("table info")
        .query_map([], |row| row.get::<_, String>(1))
        .expect("columns")
        .collect::<Result<Vec<_>, _>>()
        .expect("column names");
    assert!(
        !columns
            .iter()
            .any(|column| column == "query" || column == "text")
    );
    let persisted: String = connection
        .query_row(
            "select injected_refs_json || '|' || reason from memory_source_access_events where grant_id = 'grant-b' order by created_at desc limit 1",
            [],
            |row| row.get(0),
        )
        .expect("persisted audit");
    assert!(!persisted.contains("audit-query-must-not-be-stored"));
    assert!(!persisted.contains("Linked language preference text"));

    drop(connection);
    drop(fixture);
    let _ = std::fs::remove_file(path);
}

#[test]
fn audit_failure_degrades_with_redacted_reason_without_expanding_access() {
    let path = std::env::temp_dir().join(format!(
        "homun-multi-source-audit-failure-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let fixture = MultiSourceFixture {
        facade: std::sync::Arc::new(MemoryFacade::new(
            SQLiteMemoryStore::open(&path).expect("store"),
        )),
        user: UserId::new("multi-user"),
        consumer: WorkspaceId::new("project-a"),
    };
    fixture.insert(
        "project-a",
        "local-preference",
        "preference",
        "Language preference local allowed",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.insert(
        "project-b",
        "linked-preference",
        "preference",
        "Language preference linked allowed",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.insert(
        "project-c",
        "unlinked-preference",
        "preference",
        "Language preference must remain isolated",
        serde_json::json!({}),
        &[1.0, 0.0],
    );
    fixture.grant(
        "grant-b",
        "project-b",
        [MemoryCollectionKey::Preferences],
        HashMap::new(),
    );
    let connection = rusqlite::Connection::open(&path).expect("audit sqlite");
    connection
        .execute_batch(
            "create trigger fail_memory_source_audit before insert on memory_source_access_events
             begin select raise(abort, 'technical audit detail must be redacted'); end;",
        )
        .expect("audit failure trigger");

    let pack = recall_authorized_sources_on_facade(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        "language preference",
        &[1.0, 0.0],
        1_800_000_000,
        None,
    )
    .expect("audit failure does not fail recall");

    assert!(
        pack.hits
            .iter()
            .any(|item| item.source_workspace_id.as_str() == "project-b")
    );
    assert!(
        pack.hits
            .iter()
            .all(|item| item.source_workspace_id.as_str() != "project-c")
    );
    assert!(pack.degraded_sources.iter().any(|(source, reason)| {
        source.as_str() == "project-b" && reason == "audit_unavailable"
    }));
    assert!(pack.degraded_sources.iter().all(|(source, reason)| {
        source.as_str() != "project-a" || reason != "audit_unavailable"
    }));
    assert!(!format!("{:?}", pack.degraded_sources).contains("technical audit detail"));

    drop(connection);
    drop(fixture);
    let _ = std::fs::remove_file(path);
}

#[test]
fn last_source_access_fails_closed_on_corrupt_persisted_reason_and_ref() {
    let path = std::env::temp_dir().join(format!(
        "homun-multi-source-corrupt-audit-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).expect("store"));
    let connection = rusqlite::Connection::open(&path).expect("audit sqlite");
    let corrupt_reason_id = uuid::Uuid::new_v4().to_string();
    connection
        .execute(
            "insert into memory_source_access_events (
                id, consumer_user_id, consumer_workspace_id, source_workspace_id,
                grant_id, policy_version, turn_id, outcome, reason, candidate_count,
                injected_refs_json, created_at
             ) values (?1, 'multi-user', 'project-a', 'project-b', 'grant-corrupt-reason',
                       1, null, 'allow', 'raw query leaked into reason', 0, '[]', 1800000000)",
            [&corrupt_reason_id],
        )
        .expect("insert corrupt reason");

    assert!(
        facade
            .last_memory_source_access("grant-corrupt-reason")
            .is_err()
    );

    let corrupt_ref_id = uuid::Uuid::new_v4().to_string();
    let outside_ref = MemoryRef::new(
        MemoryRefKind::Memory,
        UserId::new("multi-user"),
        WorkspaceId::new("project-c"),
        "outside-source",
    );
    connection
        .execute(
            "insert into memory_source_access_events (
                id, consumer_user_id, consumer_workspace_id, source_workspace_id,
                grant_id, policy_version, turn_id, outcome, reason, candidate_count,
                injected_refs_json, created_at
             ) values (?1, 'multi-user', 'project-a', 'project-b', 'grant-corrupt-ref',
                       1, null, 'allow', 'allowed', 1, ?2, 1800000000)",
            rusqlite::params![
                corrupt_ref_id,
                serde_json::to_string(&vec![outside_ref.to_string()]).expect("refs json")
            ],
        )
        .expect("insert corrupt ref");

    assert!(
        facade
            .last_memory_source_access("grant-corrupt-ref")
            .is_err()
    );

    drop(connection);
    drop(facade);
    let _ = std::fs::remove_file(path);
}

#[test]
fn source_audit_rejects_free_form_reasons_and_non_ref_payloads() {
    let fixture = MultiSourceFixture::new();
    let event = MemorySourceAccessEvent {
        id: uuid::Uuid::new_v4().to_string(),
        consumer_user_id: fixture.user.clone(),
        consumer_workspace_id: fixture.consumer.clone(),
        source_workspace_id: WorkspaceId::new("project-b"),
        grant_id: Some("grant-b".to_string()),
        policy_version: 1,
        turn_id: None,
        outcome: MemorySourceAccessOutcome::Allow,
        reason: "the user queried for a private launch date".to_string(),
        candidate_count: 1,
        injected_refs: vec!["raw memory text instead of a ref".to_string()],
        created_at: 1_800_000_000,
    };

    assert!(fixture.facade.record_memory_source_access(&event).is_err());
}

struct RecallFixture {
    facade: std::sync::Arc<MemoryFacade>,
    user: UserId,
    source_workspace: WorkspaceId,
}

impl RecallFixture {
    fn new() -> Self {
        Self {
            facade: std::sync::Arc::new(MemoryFacade::new(
                SQLiteMemoryStore::open_in_memory().expect("store"),
            )),
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
        self.insert_with_aliases(
            key,
            memory_type,
            text,
            sensitivity,
            metadata,
            embedding,
            vec![],
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_with_aliases(
        &self,
        key: &str,
        memory_type: &str,
        text: &str,
        sensitivity: DataSensitivity,
        metadata: serde_json::Value,
        embedding: &[f32],
        aliases: Vec<String>,
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
                aliases,
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
fn authorized_lexical_search_never_indexes_alias_payloads() {
    let fixture = RecallFixture::new();
    fixture.insert_with_aliases(
        "alias-only",
        "preference",
        "Safe visible preference",
        DataSensitivity::Private,
        serde_json::json!({}),
        &[0.0, 1.0],
        vec!["vault://private hiddenrankingtoken".to_string()],
    );
    let policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );

    let pack = recall_source_on_facade(
        &fixture.facade,
        &fixture.source(policy),
        "hiddenrankingtoken",
        &[],
        None,
    )
    .expect("alias-only recall");

    assert!(pack.hits.is_empty());
    assert_eq!(pack.block, None);
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
    let relation_ref = MemoryRef::new(
        MemoryRefKind::Relation,
        fixture.user.clone(),
        fixture.source_workspace.clone(),
        "mentions-release-notes",
    );
    fixture
        .facade
        .upsert_relation(&MemoryRelation {
            reference: relation_ref.clone(),
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

    fixture
        .facade
        .tombstone_ref(
            &relation_ref,
            &fixture.user,
            &fixture.source_workspace,
            "test relation revoke",
        )
        .expect("tombstone relation");
    let tombstoned = recall_source_on_facade(
        &fixture.facade,
        &fixture.source(policy.clone()),
        "How should release notes be written?",
        &[1.0, 0.0],
        None,
    )
    .expect("recall");
    assert_eq!(tombstoned.hits[0].subject_key, None);
    fixture
        .facade
        .untombstone_entity(&relation_ref, &fixture.user, &fixture.source_workspace)
        .expect("restore relation for ambiguity case");

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
        facade: std::sync::Arc::new(MemoryFacade::new(
            SQLiteMemoryStore::open(&path).expect("file-backed store"),
        )),
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
    fixture
        .facade
        .tombstone_ref(
            &allowed,
            &fixture.user,
            &fixture.source_workspace,
            "test pooled tombstone visibility",
        )
        .expect("tombstone pooled memory");
    let after_tombstone = recall_source_on_facade(
        &fixture.facade,
        &fixture.source(MemorySourcePolicy::for_collections(
            vec![MemoryCollectionKey::Preferences],
            DataSensitivity::Private,
        )),
        "pooled lexical preference",
        &[],
        None,
    )
    .expect("recall after tombstone");
    assert!(after_tombstone.hits.is_empty());
    drop(fixture);
    let _ = std::fs::remove_file(path);
}

#[test]
fn concurrent_authorized_temp_indexes_remain_isolated_by_source_scope() {
    const THREADS: usize = 8;

    let path = std::env::temp_dir().join(format!(
        "homun-authorized-concurrent-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let facade = std::sync::Arc::new(MemoryFacade::new(
        SQLiteMemoryStore::open(&path).expect("file-backed store"),
    ));
    let user = UserId::new("concurrent-recall-user");
    let fixture_a = RecallFixture {
        facade: facade.clone(),
        user: user.clone(),
        source_workspace: WorkspaceId::new("source-a"),
    };
    let fixture_b = RecallFixture {
        facade: facade.clone(),
        user,
        source_workspace: WorkspaceId::new("source-b"),
    };
    fixture_a.insert(
        "only-a",
        "preference",
        "sharedquery source alpha",
        DataSensitivity::Private,
        serde_json::json!({}),
        &[0.0, 1.0],
    );
    fixture_b.insert(
        "only-b",
        "preference",
        "sharedquery source beta",
        DataSensitivity::Private,
        serde_json::json!({}),
        &[0.0, 1.0],
    );
    let policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );
    let source_a = fixture_a.source(policy.clone());
    let source_b = fixture_b.source(policy);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(THREADS));
    let mut handles = Vec::new();
    for index in 0..THREADS {
        let facade = facade.clone();
        let source = if index % 2 == 0 {
            source_a.clone()
        } else {
            source_b.clone()
        };
        let expected_workspace = source.source_workspace_id.clone();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            let pack = recall_source_on_facade(&facade, &source, "sharedquery source", &[], None)
                .expect("concurrent recall");
            assert_eq!(pack.hits.len(), 1);
            assert_eq!(pack.hits[0].source_workspace_id, expected_workspace);
        }));
    }
    for handle in handles {
        handle.join().expect("concurrent recall thread");
    }

    drop(fixture_a);
    drop(fixture_b);
    drop(facade);
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
