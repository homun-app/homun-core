use local_first_memory::{
    DataSensitivity, GraphMemory, MemoryEntity, MemoryRef, MemoryRefKind, MemoryRelation,
    PrivacyDomain, SQLiteMemoryStore, UserId, WorkspaceId,
};

#[test]
fn graph_memory_links_entities_through_store() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let graph = GraphMemory::new(&store);
    let project = entity("project:acme", "project", "Acme");
    let tool = entity("tool:zed", "tool", "Zed");
    let relation = relation(project.reference.clone(), tool.reference.clone());

    graph.upsert_node(&project).unwrap();
    graph.upsert_node(&tool).unwrap();
    graph.link(&relation).unwrap();

    assert_eq!(
        graph
            .relations_from(&project.reference, &project.user_id, &project.workspace_id)
            .unwrap(),
        vec![relation]
    );
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
        metadata: serde_json::json!({
            "adapter": "graphify",
            "graphify_edge_id": "edge_project_acme_uses_tool_zed",
            "graphify_source_node_id": "node_project_acme",
            "graphify_target_node_id": "node_tool_zed",
            "graph_json_path": "graphify-out/graph.json",
            "report_path": "graphify-out/GRAPH_REPORT.md"
        }),
    }
}
