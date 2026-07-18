use local_first_memory::{
    DataSensitivity, GraphifyArtifacts, GraphifyCli, GraphifyImport, PrivacyDomain,
    SQLiteMemoryStore, UserId, WorkspaceId, normalize_graphify_value,
};
use std::fs;

#[test]
fn graphify_import_maps_graph_json_nodes_and_links_to_memory_graph() {
    let root = graphify_fixture();
    let artifacts = GraphifyArtifacts::from_output_dir(&root).unwrap();
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let importer = GraphifyImport::new(&store);
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");

    let summary = importer
        .import_artifacts(
            &artifacts,
            &user,
            &workspace,
            PrivacyDomain::new("technical"),
            DataSensitivity::Internal,
        )
        .unwrap();

    assert_eq!(summary.nodes_imported, 2);
    assert_eq!(summary.edges_imported, 1);

    let entity = store
        .get_entity(&summary.entity_refs[0], &user, &workspace)
        .unwrap()
        .unwrap();
    assert_eq!(entity.metadata["adapter"], "graphify");
    assert_eq!(entity.metadata["graphify_node_id"], "create_patch");
    assert_eq!(
        entity.metadata["source_file"],
        "server/create-patch-handler.ts"
    );
    assert_eq!(
        entity.metadata["graph_json_path"],
        artifacts.graph_json_path.to_string_lossy().to_string()
    );

    let relations = store
        .relations_for(&summary.entity_refs[0], &user, &workspace)
        .unwrap();
    assert_eq!(relations.len(), 1);
    assert_eq!(relations[0].relation_type, "calls");
    assert_eq!(relations[0].metadata["adapter"], "graphify");
    assert_eq!(
        relations[0].metadata["graphify_edge_id"],
        "create_patch--calls--validate"
    );
    assert_eq!(relations[0].metadata["confidence"], "EXTRACTED");
}

#[test]
fn graphify_artifacts_require_graph_json_inside_output_dir() {
    let root = std::env::temp_dir().join(format!("graphify-empty-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();

    let error = GraphifyArtifacts::from_output_dir(&root).unwrap_err();

    assert_eq!(error, "graphify artifact graph.json is missing");
}

#[test]
fn graphify_cli_builds_query_first_commands_for_llm_context() {
    let root = graphify_fixture();
    let artifacts = GraphifyArtifacts::from_output_dir(&root).unwrap();
    let cli = GraphifyCli::new("graphify");

    assert_eq!(
        cli.query_args(&artifacts, "what connects auth to database?", Some(1500)),
        vec![
            "query",
            "what connects auth to database?",
            "--graph",
            artifacts.graph_json_path.to_str().unwrap(),
            "--budget",
            "1500",
        ]
    );
    assert_eq!(
        cli.path_args(&artifacts, "UserService", "DatabasePool"),
        vec![
            "path",
            "UserService",
            "DatabasePool",
            "--graph",
            artifacts.graph_json_path.to_str().unwrap(),
        ]
    );
    assert_eq!(
        cli.explain_args(&artifacts, "RateLimiter"),
        vec![
            "explain",
            "RateLimiter",
            "--graph",
            artifacts.graph_json_path.to_str().unwrap(),
        ]
    );
}

#[test]
fn graphify_normalization_collapses_duplicates_and_reports_dangling_links() {
    let normalized = normalize_graphify_value(
        &duplicate_graphify_value(false),
        &UserId::new("local-user"),
        &WorkspaceId::new("project-a"),
        PrivacyDomain::new("personal"),
        DataSensitivity::Internal,
    )
    .unwrap();

    assert_eq!(normalized.report.input_nodes, 3);
    assert_eq!(normalized.report.unique_nodes, 2);
    assert_eq!(normalized.report.duplicate_nodes, 1);
    assert_eq!(normalized.report.malformed_nodes, 0);
    assert_eq!(normalized.report.input_edges, 4);
    assert_eq!(normalized.report.unique_edges, 1);
    assert_eq!(normalized.report.duplicate_edges, 2);
    assert_eq!(normalized.report.malformed_edges, 0);
    assert_eq!(normalized.report.dangling_edges, 1);
    assert_eq!(normalized.entities.len(), 2);
    assert_eq!(normalized.relations.len(), 1);
    assert_eq!(normalized.entities[0].canonical_key, "code:a");
    assert_eq!(normalized.relations[0].relation_type, "calls");
    assert!(normalized.entities[0].metadata.get("raw_payload").is_none());
    assert!(
        normalized.relations[0]
            .metadata
            .get("raw_payload")
            .is_none()
    );
}

#[test]
fn graphify_checksum_and_refs_do_not_depend_on_input_order() {
    let normalize = |reversed| {
        normalize_graphify_value(
            &duplicate_graphify_value(reversed),
            &UserId::new("local-user"),
            &WorkspaceId::new("project-a"),
            PrivacyDomain::new("personal"),
            DataSensitivity::Internal,
        )
        .unwrap()
    };

    let forward = normalize(false);
    let reversed = normalize(true);

    assert_eq!(forward.report.checksum, reversed.report.checksum);
    assert_eq!(forward.entities, reversed.entities);
    assert_eq!(forward.relations, reversed.relations);
}

fn duplicate_graphify_value(reversed: bool) -> serde_json::Value {
    let mut nodes = vec![
        serde_json::json!({"id":"a","label":"a()","source_file":"src/a.rs","raw_payload":"discard-me"}),
        serde_json::json!({"id":"a","label":"a()","source_file":"src/a.rs","raw_payload":"discard-me"}),
        serde_json::json!({"id":"b","label":"b()","source_file":"src/b.rs"}),
    ];
    let mut links = vec![
        serde_json::json!({"source":"a","target":"b","relation":"calls","raw_payload":"discard-me"}),
        serde_json::json!({"source":"a","target":"b","relation":"calls","raw_payload":"discard-me"}),
        serde_json::json!({"source":"a","target":"b","relation":"calls","raw_payload":"discard-me"}),
        serde_json::json!({"source":"a","target":"missing","relation":"calls"}),
    ];
    if reversed {
        nodes.reverse();
        links.reverse();
    }
    serde_json::json!({"nodes": nodes, "links": links})
}

fn graphify_fixture() -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("graphify-out-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("GRAPH_REPORT.md"), "# Graph Report\n").unwrap();
    fs::write(root.join("graph.html"), "<html></html>\n").unwrap();
    fs::write(
        root.join("graph.json"),
        serde_json::json!({
            "directed": false,
            "multigraph": false,
            "graph": {},
            "nodes": [
                {
                    "id": "create_patch",
                    "label": "createPatchHandler()",
                    "source_file": "server/create-patch-handler.ts",
                    "source_location": "L10",
                    "community": 0
                },
                {
                    "id": "validate",
                    "label": "validateSanitySession()",
                    "source_file": "server/sanity-validate-session.ts",
                    "source_location": "L5",
                    "community": 0
                }
            ],
            "links": [
                {
                    "source": "create_patch",
                    "target": "validate",
                    "relation": "calls",
                    "confidence": "EXTRACTED",
                    "context": "call"
                }
            ]
        })
        .to_string(),
    )
    .unwrap();
    root
}
