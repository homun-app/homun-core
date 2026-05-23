use local_first_memory::{
    DataSensitivity, MemoryAccessRequest, MemoryExtraction, MemoryFacade, MemoryRef, MemoryRefKind,
    PrivacyDomain, SQLiteMemoryStore, UserId, WorkspaceId,
};

#[test]
fn facade_applies_memory_agent_extraction_to_memory_core() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let event_ref = MemoryRef::new(
        MemoryRefKind::Event,
        user.clone(),
        workspace.clone(),
        "evt_1",
    );
    let extraction: MemoryExtraction = serde_json::from_value(serde_json::json!({
        "memories": [{
            "memory_type": "preference",
            "text": "Fabio prefers Zed for Acme work",
            "aliases": ["preferenza Zed"],
            "language_hints": ["en", "it"],
            "confidence": 0.91,
            "privacy_domain": "work",
            "sensitivity": "private",
            "evidence_refs": [event_ref.to_string()],
            "metadata": {"source_agent": "MemoryAgent"}
        }],
        "entities": [{
            "entity_type": "project",
            "name": "Acme",
            "canonical_key": "project:acme",
            "aliases": ["Cliente Acme"],
            "privacy_domain": "work",
            "sensitivity": "private",
            "metadata": {"language": "it"}
        }],
        "relations": []
    }))
    .unwrap();

    let summary = facade
        .apply_extraction(&user, &workspace, extraction)
        .unwrap();
    let pack = facade.context_pack(&request()).unwrap();

    assert_eq!(summary.memories_imported, 1);
    assert_eq!(summary.entities_imported, 1);
    assert_eq!(summary.relations_imported, 0);
    assert_eq!(summary.evidence_links_imported, 1);
    assert_eq!(pack.items.len(), 1);
    assert_eq!(pack.items[0].summary, "Fabio prefers Zed for Acme work");
    assert_eq!(pack.items[0].evidence, vec![event_ref]);
}

fn request() -> MemoryAccessRequest {
    MemoryAccessRequest {
        actor_id: "PlannerAgent".to_string(),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        purpose: "build context".to_string(),
        allowed_domains: vec![PrivacyDomain::new("work")],
        max_sensitivity: DataSensitivity::Private,
        allow_raw_payload: false,
        allow_export: false,
        broad_query: false,
    }
}
