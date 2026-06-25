use local_first_memory::{
    DataSensitivity, GraphMemory, MemoryEntity, MemoryFacade, MemoryRef, MemoryRefKind,
    MemoryRelation, PrivacyDomain, SQLiteMemoryStore, UserId, WorkspaceId,
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

#[test]
fn facade_merge_entities_repoints_relations_and_tombstones_absorbed() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let facade = MemoryFacade::new(store);
    let mut survivor = entity("person:self", "person", "Fabio");
    survivor.aliases = vec!["Fabio".to_string()];
    let mut absorbed = entity("person:telegram:8205578468", "person", "Fabio");
    absorbed.aliases = vec!["telegram:8205578468".to_string()];
    let tool = entity("tool:telegram", "tool", "Telegram");
    facade.upsert_entity(&survivor).unwrap();
    facade.upsert_entity(&absorbed).unwrap();
    facade.upsert_entity(&tool).unwrap();
    facade
        .upsert_relation(&relation(
            absorbed.reference.clone(),
            tool.reference.clone(),
        ))
        .unwrap();

    facade
        .merge_entities(
            &survivor.reference,
            &absorbed.reference,
            &survivor.user_id,
            &survivor.workspace_id,
            "same owner identity",
        )
        .unwrap();

    let entities = facade
        .list_entities_for_ui(&survivor.user_id, &survivor.workspace_id)
        .unwrap();
    let survivor = entities
        .iter()
        .find(|entity| entity.canonical_key == "person:self")
        .unwrap();
    assert!(
        survivor
            .aliases
            .iter()
            .any(|alias| alias == "telegram:8205578468")
    );
    assert!(
        entities
            .iter()
            .all(|entity| entity.canonical_key != "person:telegram:8205578468"),
        "absorbed entity should be hidden from graph UI"
    );
    let relations = facade
        .list_relations_for_ui(&survivor.user_id, &survivor.workspace_id)
        .unwrap();
    assert!(relations.iter().any(|relation| {
        relation.source_ref == survivor.reference && relation.target_ref == tool.reference
    }));
    assert!(
        relations
            .iter()
            .all(|relation| relation.source_ref != absorbed.reference)
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
