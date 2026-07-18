use local_first_memory::{
    DataSensitivity, MemoryAccessRequest, MemoryEntity, MemoryEvent, MemoryEvidence, MemoryFacade,
    MemoryEvolutionKind, MemoryEvolutionMetadata, MemoryRecord, MemoryRef, MemoryRefKind,
    MemoryRelation, MemoryStatus, MemoryUiReadModel, PrivacyDomain, SQLiteMemoryStore, UserId,
    WikiPage, WorkspaceId, write_memory_evolution_metadata,
};

#[test]
fn ui_read_model_returns_dashboard_counts_without_raw_payloads() {
    let facade = seeded_facade();
    let ui = MemoryUiReadModel::new(&facade);

    let dashboard = ui.dashboard(&request(vec!["work"])).unwrap();

    assert_eq!(dashboard.total_memories, 1);
    assert_eq!(dashboard.total_entities, 2);
    assert_eq!(dashboard.total_relations, 1);
    assert_eq!(dashboard.total_wiki_pages, 1);
    assert_eq!(dashboard.by_status[0].key, "confirmed");
    assert_eq!(dashboard.by_privacy_domain[0].key, "work");
    assert_eq!(dashboard.by_sensitivity[0].key, "private");
    // Access audit intentionally disabled → dashboard reports 0.
    assert_eq!(dashboard.access_audit_count, 0);
}

#[test]
fn ui_read_model_lists_only_policy_allowed_memories() {
    let facade = seeded_facade();
    let ui = MemoryUiReadModel::new(&facade);

    let memories = ui.list_memories(&request(vec!["work"])).unwrap();

    assert_eq!(memories.len(), 1);
    assert_eq!(memories[0].summary, "Fabio prefers Zed for Acme work");
    assert_eq!(memories[0].privacy_domain.as_str(), "work");
}

#[test]
fn ui_read_model_returns_memory_detail_with_refs_and_links() {
    let facade = seeded_facade();
    let ui = MemoryUiReadModel::new(&facade);
    let memory_ref = memory_ref("mem_work");

    let detail = ui
        .memory_detail(&request(vec!["work"]), &memory_ref)
        .unwrap()
        .unwrap();

    assert_eq!(detail.memory.reference, memory_ref);
    assert_eq!(detail.evidence.len(), 1);
    assert_eq!(detail.entities.len(), 2);
    assert_eq!(detail.relations.len(), 1);
    assert_eq!(detail.wiki_pages.len(), 1);
}

#[test]
fn ui_detail_exposes_authorized_evolution_history_without_leaking_denied_text() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let mut previous = memory("history_old", "work", DataSensitivity::Private);
    previous.text = "The authorized historical launch was Friday".to_string();
    let denied = memory("history_denied", "personal", DataSensitivity::Secret);
    let mut current = memory("history_current", "work", DataSensitivity::Private);
    current.text = "The current launch is Monday".to_string();
    current.supersedes = vec![previous.reference.clone(), denied.reference.clone()];
    previous.superseded_by = Some(current.reference.clone());
    write_memory_evolution_metadata(
        &mut current.metadata,
        &MemoryEvolutionMetadata {
            kind: MemoryEvolutionKind::Updates,
            target_refs: vec![previous.reference.clone()],
            valid_from: Some(100),
            valid_until: Some(200),
            last_confirmed_at: Some(100),
            reinforcement_count: 1,
            classifier: "test".to_string(),
            classifier_confidence: 1.0,
        },
    )
    .unwrap();
    for item in [&previous, &denied, &current] {
        facade.upsert_memory(item).unwrap();
    }

    let detail = MemoryUiReadModel::new(&facade)
        .memory_detail(&request(vec!["work"]), &current.reference)
        .unwrap()
        .unwrap();

    assert_eq!(detail.evolution.unwrap().valid_until, Some(200));
    assert_eq!(detail.history.len(), 1);
    assert_eq!(detail.history[0].memory.reference, previous.reference);
    assert_eq!(
        detail.history[0].memory.summary,
        "The authorized historical launch was Friday"
    );
    assert!(
        detail
            .history
            .iter()
            .all(|entry| !entry.memory.summary.contains("Private secret memory"))
    );
}

#[test]
fn ui_read_model_returns_privacy_overview() {
    let facade = seeded_facade();
    let ui = MemoryUiReadModel::new(&facade);

    let overview = ui
        .privacy_overview(&UserId::new("user_1"), &WorkspaceId::new("workspace_1"))
        .unwrap();

    assert_eq!(overview.domains.len(), 2);
    assert!(
        overview
            .domains
            .iter()
            .any(|domain| domain.domain == "work")
    );
    assert!(
        overview
            .domains
            .iter()
            .any(|domain| domain.domain == "personal")
    );
    assert_eq!(overview.secret_or_confidential_count, 1);
}

fn seeded_facade() -> MemoryFacade {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let work = memory("mem_work", "work", DataSensitivity::Private);
    let personal = memory("mem_personal", "personal", DataSensitivity::Secret);
    let event = event();
    let project = entity("project:acme", "project", "Acme");
    let tool = entity("tool:zed", "tool", "Zed");
    let relation = relation(project.reference.clone(), tool.reference.clone());
    let wiki = wiki_page(work.reference.clone());

    facade.upsert_memory(&work).unwrap();
    facade.upsert_memory(&personal).unwrap();
    facade.record_event(&event).unwrap();
    facade.upsert_entity(&project).unwrap();
    facade.upsert_entity(&tool).unwrap();
    facade.upsert_relation(&relation).unwrap();
    facade
        .link_evidence(&MemoryEvidence {
            memory_ref: work.reference.clone(),
            evidence_ref: event.reference.clone(),
            note: "Observed in desktop event".to_string(),
        })
        .unwrap();
    facade.record_wiki_page_for_ui(&wiki).unwrap();
    facade
}

fn request(domains: Vec<&str>) -> MemoryAccessRequest {
    MemoryAccessRequest {
        actor_id: "ui".to_string(),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        purpose: "memory ui".to_string(),
        allowed_domains: domains.into_iter().map(PrivacyDomain::new).collect(),
        max_sensitivity: DataSensitivity::Private,
        allow_raw_payload: false,
        allow_export: false,
        broad_query: false,
    }
}

fn memory(key: &str, domain: &str, sensitivity: DataSensitivity) -> MemoryRecord {
    MemoryRecord {
        reference: memory_ref(key),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        memory_type: "preference".to_string(),
        text: if domain == "work" {
            "Fabio prefers Zed for Acme work".to_string()
        } else {
            "Private secret memory".to_string()
        },
        aliases: vec![],
        language_hints: vec!["en".to_string(), "it".to_string()],
        confidence: 0.9,
        status: MemoryStatus::Confirmed,
        privacy_domain: PrivacyDomain::new(domain),
        sensitivity,
        metadata: serde_json::json!({}),
        created_at: "2026-05-23T08:00:00Z".to_string(),
        updated_at: "2026-05-23T08:00:00Z".to_string(),
        last_seen_at: None,
        supersedes: vec![],
        superseded_by: None,
        correction_of: None,
    }
}

fn memory_ref(key: &str) -> MemoryRef {
    MemoryRef::new(
        MemoryRefKind::Memory,
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        key,
    )
}

fn event() -> MemoryEvent {
    MemoryEvent {
        reference: MemoryRef::new(
            MemoryRefKind::Event,
            UserId::new("user_1"),
            WorkspaceId::new("workspace_1"),
            "evt_1",
        ),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        timestamp: "2026-05-23T08:00:00Z".to_string(),
        source: "desktop".to_string(),
        event_type: "open_project".to_string(),
        payload: serde_json::json!({"project": "Acme"}),
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
    }
}

fn entity(key: &str, entity_type: &str, name: &str) -> MemoryEntity {
    MemoryEntity {
        reference: MemoryRef::new(
            MemoryRefKind::Entity,
            UserId::new("user_1"),
            WorkspaceId::new("workspace_1"),
            key,
        ),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        entity_type: entity_type.to_string(),
        name: name.to_string(),
        canonical_key: key.to_string(),
        aliases: vec![],
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
        metadata: serde_json::json!({}),
    }
}

fn relation(source_ref: MemoryRef, target_ref: MemoryRef) -> MemoryRelation {
    MemoryRelation {
        reference: MemoryRef::new(
            MemoryRefKind::Relation,
            UserId::new("user_1"),
            WorkspaceId::new("workspace_1"),
            "rel_1",
        ),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        source_ref,
        relation_type: "uses_tool".to_string(),
        target_ref,
        confidence: 0.9,
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
        evidence: vec![],
        metadata: serde_json::json!({}),
    }
}

fn wiki_page(memory_ref: MemoryRef) -> WikiPage {
    WikiPage {
        reference: MemoryRef::new(
            MemoryRefKind::Wiki,
            UserId::new("user_1"),
            WorkspaceId::new("workspace_1"),
            "Projects/Acme.md",
        ),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        path: "Projects/Acme.md".to_string(),
        title: "Acme".to_string(),
        body: "Acme memory summary".to_string(),
        linked_refs: vec![memory_ref],
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
    }
}
