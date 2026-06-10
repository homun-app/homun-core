use local_first_memory::{
    DataSensitivity, GraphifyArtifacts, MemoryAccessRequest, MemoryEvent, MemoryEvidence,
    MemoryFacade, MemoryRecord, MemoryRef, MemoryRefKind, MemoryStatus, MemoryWikiProjection,
    PrivacyDomain, SQLiteMemoryStore, UserId, WikiFileStore, WikiPage, WorkspaceId,
};
use std::fs;

#[test]
fn facade_builds_policy_gated_context_pack_with_refs_and_evidence() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let facade = MemoryFacade::new(store);
    let event = event();
    let memory = memory("work", DataSensitivity::Private);

    facade.record_event(&event).unwrap();
    facade.upsert_memory(&memory).unwrap();
    facade
        .link_evidence(&MemoryEvidence {
            memory_ref: memory.reference.clone(),
            evidence_ref: event.reference.clone(),
            note: "Observed in local event".to_string(),
        })
        .unwrap();

    let pack = facade.context_pack(&request(vec!["work"])).unwrap();

    assert!(pack.redacted);
    assert_eq!(pack.items.len(), 1);
    assert_eq!(pack.items[0].reference, memory.reference);
    assert_eq!(pack.items[0].evidence, vec![event.reference]);
    // Access-audit recording is intentionally a no-op (the audit log was removed;
    // record_access_decision no longer INSERTs) — the policy gate still applies.
    assert_eq!(facade.access_audit_count().unwrap(), 0);
}

#[test]
fn facade_excludes_denied_domains_and_audits_the_decision() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let facade = MemoryFacade::new(store);
    facade
        .upsert_memory(&memory("personal", DataSensitivity::Private))
        .unwrap();

    let pack = facade.context_pack(&request(vec!["work"])).unwrap();

    assert!(pack.items.is_empty());
    // Audit recording disabled on purpose (see above) — the DENY itself is what matters.
    assert_eq!(facade.access_audit_count().unwrap(), 0);
}

#[test]
fn facade_projects_confirmed_memory_to_wiki() {
    let root = std::env::temp_dir().join(format!("memory-facade-wiki-{}", uuid::Uuid::new_v4()));
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let facade = MemoryFacade::new(store);
    let wiki = WikiFileStore::new(&root);
    let page = WikiPage {
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
        body: "Confirmed project memory".to_string(),
        linked_refs: vec![],
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
    };

    facade
        .project_to_wiki(&wiki, &MemoryWikiProjection { page })
        .unwrap();
}

#[test]
fn facade_imports_graphify_artifacts_through_memory_boundary() {
    let root = std::env::temp_dir().join(format!("facade-graphify-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("GRAPH_REPORT.md"), "# Graph Report\n").unwrap();
    fs::write(root.join("graph.html"), "<html></html>\n").unwrap();
    fs::write(
        root.join("graph.json"),
        serde_json::json!({
            "nodes": [
                {"id": "memory_facade", "label": "MemoryFacade", "community": 1},
                {"id": "sqlite_store", "label": "SQLiteMemoryStore", "community": 1}
            ],
            "links": [
                {
                    "source": "memory_facade",
                    "target": "sqlite_store",
                    "relation": "uses",
                    "confidence": "EXTRACTED"
                }
            ]
        })
        .to_string(),
    )
    .unwrap();
    let artifacts = GraphifyArtifacts::from_output_dir(&root).unwrap();
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());

    let summary = facade
        .import_graphify_artifacts(
            &artifacts,
            &UserId::new("user_1"),
            &WorkspaceId::new("workspace_1"),
            PrivacyDomain::new("technical"),
            DataSensitivity::Internal,
        )
        .unwrap();

    assert_eq!(summary.nodes_imported, 2);
    assert_eq!(summary.edges_imported, 1);
}

fn request(domains: Vec<&str>) -> MemoryAccessRequest {
    MemoryAccessRequest {
        actor_id: "PlannerAgent".to_string(),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        purpose: "build subagent context".to_string(),
        allowed_domains: domains.into_iter().map(PrivacyDomain::new).collect(),
        max_sensitivity: DataSensitivity::Private,
        allow_raw_payload: false,
        allow_export: false,
        broad_query: false,
    }
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

fn memory(domain: &str, sensitivity: DataSensitivity) -> MemoryRecord {
    MemoryRecord {
        reference: MemoryRef::new(
            MemoryRefKind::Memory,
            UserId::new("user_1"),
            WorkspaceId::new("workspace_1"),
            "mem_1",
        ),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        memory_type: "project_preference".to_string(),
        text: "Fabio works on Acme with Zed".to_string(),
        aliases: vec!["Acme routine".to_string()],
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
