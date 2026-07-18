use local_first_memory::{
    DataSensitivity, MemoryAccessRequest, MemoryCreateRequest, MemoryFacade,
    MemoryEvolutionKind, MemoryEvolutionMetadata, MemoryLifecycleRequest, MemoryRecord, MemoryRef,
    MemoryRefKind, MemorySearchRequest, MemoryStatus, PrivacyDomain, SQLiteMemoryStore, UserId,
    WorkspaceId, write_memory_evolution_metadata,
};

#[test]
fn search_returns_ranked_policy_gated_results() {
    let facade = seeded_facade();
    let audit_before = facade.access_audit_count().unwrap();

    let page = facade
        .search_memories(MemorySearchRequest {
            access: access_request(vec!["work"], DataSensitivity::Private),
            query: "zed".to_string(),
            statuses: vec![MemoryStatus::Confirmed],
            memory_types: vec!["preference".to_string()],
            limit: 10,
            offset: 0,
        })
        .unwrap();

    assert_eq!(page.total, 1);
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].summary, "Fabio prefers Zed for Acme work");
    assert_eq!(page.items[0].rank, 1);
    // Access audit intentionally disabled → no new rows recorded by the search.
    assert_eq!(facade.access_audit_count().unwrap(), audit_before);
}

#[test]
fn search_filters_by_sensitivity_and_privacy_domain() {
    let facade = seeded_facade();

    let page = facade
        .search_memories(MemorySearchRequest {
            access: access_request(vec!["work"], DataSensitivity::Private),
            query: "secret".to_string(),
            statuses: vec![],
            memory_types: vec![],
            limit: 10,
            offset: 0,
        })
        .unwrap();

    assert_eq!(page.total, 0);
    assert!(page.items.is_empty());
}

#[test]
fn search_paginates_after_filters() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let lifecycle = lifecycle_request();
    create_confirmed(&facade, &lifecycle, "preference", "Zed alpha");
    create_confirmed(&facade, &lifecycle, "preference", "Zed beta");
    create_confirmed(&facade, &lifecycle, "preference", "Zed gamma");

    let page = facade
        .search_memories(MemorySearchRequest {
            access: access_request(vec!["work"], DataSensitivity::Private),
            query: "zed".to_string(),
            statuses: vec![MemoryStatus::Confirmed],
            memory_types: vec!["preference".to_string()],
            limit: 1,
            offset: 1,
        })
        .unwrap();

    assert_eq!(page.total, 3);
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].summary, "Zed beta");
}

#[test]
fn legacy_search_preserves_limits_above_authorized_source_cap() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let lifecycle = lifecycle_request();
    for index in 0..101 {
        create_confirmed(
            &facade,
            &lifecycle,
            "preference",
            &format!("Legacy wide result {index:03}"),
        );
    }

    let page = facade
        .search_memories(MemorySearchRequest {
            access: access_request(vec!["work"], DataSensitivity::Private),
            query: "legacy wide".to_string(),
            statuses: vec![MemoryStatus::Confirmed],
            memory_types: vec!["preference".to_string()],
            limit: 101,
            offset: 0,
        })
        .unwrap();

    assert_eq!(page.total, 101);
    assert_eq!(page.items.len(), 101);
    assert_eq!(page.limit, 101);
}

#[test]
fn current_search_omits_superseded_and_temporally_expired_history() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let current = direct_memory("current", "Launch current-filter is Monday");
    let mut superseded = direct_memory("superseded", "Launch current-filter was Friday");
    superseded.superseded_by = Some(current.reference.clone());
    let mut expired = direct_memory("expired", "Launch current-filter was Tuesday");
    let evolution = MemoryEvolutionMetadata {
        kind: MemoryEvolutionKind::Independent,
        target_refs: vec![],
        valid_from: None,
        valid_until: Some(1),
        last_confirmed_at: None,
        reinforcement_count: 1,
        classifier: "test".to_string(),
        classifier_confidence: 1.0,
    };
    write_memory_evolution_metadata(&mut expired.metadata, &evolution).unwrap();
    for memory in [&current, &superseded, &expired] {
        facade.upsert_memory(memory).unwrap();
    }

    let page = facade
        .search_memories(MemorySearchRequest {
            access: access_request(vec!["work"], DataSensitivity::Private),
            query: "launch current filter".to_string(),
            statuses: vec![MemoryStatus::Confirmed],
            memory_types: vec![],
            limit: 10,
            offset: 0,
        })
        .unwrap();

    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].reference, current.reference);
    assert_eq!(
        facade
            .list_memories_for_ui(&UserId::new("user_1"), &WorkspaceId::new("workspace_1"))
            .unwrap()
            .len(),
        3,
        "history remains inspectable"
    );
}

#[test]
fn temporal_expiry_is_idempotent_and_preserves_the_record() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let lifecycle = lifecycle_request();
    let mut due = direct_memory("due", "Temporary current-filter fact");
    write_memory_evolution_metadata(
        &mut due.metadata,
        &MemoryEvolutionMetadata {
            kind: MemoryEvolutionKind::Independent,
            target_refs: vec![],
            valid_from: None,
            valid_until: Some(100),
            last_confirmed_at: None,
            reinforcement_count: 1,
            classifier: "test".to_string(),
            classifier_confidence: 1.0,
        },
    )
    .unwrap();
    facade.upsert_memory(&due).unwrap();

    assert_eq!(facade.expire_due_memories(&lifecycle, 100).unwrap(), 1);
    assert_eq!(facade.expire_due_memories(&lifecycle, 100).unwrap(), 0);
    let stored = facade
        .get_memory_for_ui(&due.reference, &lifecycle.user_id, &lifecycle.workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, MemoryStatus::Stale);
    assert_eq!(
        stored.metadata["last_lifecycle_reason"],
        "temporal_expiry"
    );
}

fn seeded_facade() -> MemoryFacade {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let lifecycle = lifecycle_request();
    create_confirmed(
        &facade,
        &lifecycle,
        "preference",
        "Fabio prefers Zed for Acme work",
    );
    create_confirmed_with_domain(
        &facade,
        &lifecycle,
        "secret",
        "A personal secret about Zed",
        PrivacyDomain::new("personal"),
        DataSensitivity::Secret,
    );
    facade
}

fn create_confirmed(
    facade: &MemoryFacade,
    request: &MemoryLifecycleRequest,
    memory_type: &str,
    text: &str,
) {
    create_confirmed_with_domain(
        facade,
        request,
        memory_type,
        text,
        PrivacyDomain::new("work"),
        DataSensitivity::Private,
    );
}

fn create_confirmed_with_domain(
    facade: &MemoryFacade,
    request: &MemoryLifecycleRequest,
    memory_type: &str,
    text: &str,
    privacy_domain: PrivacyDomain,
    sensitivity: DataSensitivity,
) {
    let memory = facade
        .create_memory_candidate(MemoryCreateRequest {
            request: request.clone(),
            memory_type: memory_type.to_string(),
            text: text.to_string(),
            aliases: vec![],
            language_hints: vec!["en".to_string()],
            confidence: 0.8,
            privacy_domain,
            sensitivity,
            evidence_refs: vec![],
            metadata: serde_json::json!({}),
        })
        .unwrap();
    facade
        .confirm_memory(request, &memory.reference, "seed")
        .unwrap();
}

fn access_request(domains: Vec<&str>, max_sensitivity: DataSensitivity) -> MemoryAccessRequest {
    MemoryAccessRequest {
        actor_id: "ui".to_string(),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        purpose: "memory search".to_string(),
        allowed_domains: domains.into_iter().map(PrivacyDomain::new).collect(),
        max_sensitivity,
        allow_raw_payload: false,
        allow_export: false,
        broad_query: false,
    }
}

fn lifecycle_request() -> MemoryLifecycleRequest {
    MemoryLifecycleRequest {
        actor_id: "ui".to_string(),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        purpose: "seed search test".to_string(),
    }
}

fn direct_memory(key: &str, text: &str) -> MemoryRecord {
    MemoryRecord {
        reference: MemoryRef::new(
            MemoryRefKind::Memory,
            UserId::new("user_1"),
            WorkspaceId::new("workspace_1"),
            key,
        ),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        memory_type: "fact".to_string(),
        text: text.to_string(),
        aliases: vec![],
        language_hints: vec!["en".to_string()],
        confidence: 0.9,
        status: MemoryStatus::Confirmed,
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
        metadata: serde_json::json!({}),
        created_at: "unix:100".to_string(),
        updated_at: "unix:100".to_string(),
        last_seen_at: None,
        supersedes: vec![],
        superseded_by: None,
        correction_of: None,
    }
}
