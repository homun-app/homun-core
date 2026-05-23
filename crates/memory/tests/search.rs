use local_first_memory::{
    DataSensitivity, MemoryAccessRequest, MemoryCreateRequest, MemoryFacade,
    MemoryLifecycleRequest, MemorySearchRequest, MemoryStatus, PrivacyDomain, SQLiteMemoryStore,
    UserId, WorkspaceId,
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
    assert_eq!(facade.access_audit_count().unwrap(), audit_before + 2);
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
