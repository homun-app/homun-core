use local_first_memory::{
    DataSensitivity, GraphifyArtifacts, GraphifyOperation, GraphifyQueryRequest,
    MemoryAccessRequest, MemoryFacade, PrivacyDomain, SQLiteMemoryStore, UserId, WorkspaceId,
};
use std::fs;
use std::path::PathBuf;

#[test]
fn graphify_query_is_denied_without_export_permission() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let artifacts = graphify_fixture();

    let error = facade
        .graphify_query(GraphifyQueryRequest {
            access: access(false),
            artifacts: artifacts.clone(),
            allowed_output_root: artifacts.output_dir.clone(),
            operation: GraphifyOperation::Query {
                question: "Summarize the graph".to_string(),
                budget: Some(3),
            },
        })
        .unwrap_err();

    assert_eq!(error, "graphify query requires export permission");
}

#[test]
fn graphify_path_returns_policy_scoped_refs_and_command_args() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let artifacts = graphify_fixture();
    facade
        .import_graphify_artifacts(
            &artifacts,
            &UserId::new("user_1"),
            &WorkspaceId::new("workspace_1"),
            PrivacyDomain::new("work"),
            DataSensitivity::Private,
        )
        .unwrap();

    let result = facade
        .graphify_query(GraphifyQueryRequest {
            access: access(false),
            artifacts: artifacts.clone(),
            allowed_output_root: artifacts.output_dir.clone(),
            operation: GraphifyOperation::Path {
                source: "memory_facade".to_string(),
                target: "sqlite_store".to_string(),
            },
        })
        .unwrap();

    assert_eq!(result.command[0], "path");
    assert_eq!(result.entity_refs.len(), 2);
    assert_eq!(result.relation_refs.len(), 1);
}

#[test]
fn graphify_query_rejects_artifacts_outside_allowed_root() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let artifacts = graphify_fixture();
    let outside =
        std::env::temp_dir().join(format!("local-first-memory-other-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&outside).unwrap();

    let error = facade
        .graphify_query(GraphifyQueryRequest {
            access: access(true),
            artifacts,
            allowed_output_root: outside,
            operation: GraphifyOperation::Explain {
                label: "MemoryFacade".to_string(),
            },
        })
        .unwrap_err();

    assert_eq!(
        error,
        "graphify artifacts must stay inside allowed output root"
    );
}

fn access(allow_export: bool) -> MemoryAccessRequest {
    MemoryAccessRequest {
        actor_id: "graphify-query-test".to_string(),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        purpose: "graphify query".to_string(),
        allowed_domains: vec![PrivacyDomain::new("work")],
        max_sensitivity: DataSensitivity::Private,
        allow_raw_payload: false,
        allow_export,
        broad_query: false,
    }
}

fn graphify_fixture() -> GraphifyArtifacts {
    let output_dir = unique_dir();
    fs::create_dir_all(&output_dir).unwrap();
    fs::write(output_dir.join("GRAPH_REPORT.md"), "# Report").unwrap();
    fs::write(output_dir.join("graph.html"), "<html></html>").unwrap();
    fs::write(
        output_dir.join("graph.json"),
        serde_json::json!({
            "nodes": [
                {"id": "memory_facade", "label": "MemoryFacade"},
                {"id": "sqlite_store", "label": "SQLiteMemoryStore"}
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
    GraphifyArtifacts::from_output_dir(&output_dir).unwrap()
}

fn unique_dir() -> PathBuf {
    std::env::temp_dir().join(format!(
        "local-first-memory-graphify-query-{}",
        uuid::Uuid::new_v4()
    ))
}
