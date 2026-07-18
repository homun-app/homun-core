use local_first_desktop_gateway::project_graph_commit::{
    ProjectGraphCommitError, stage_project_graph_build,
};
use local_first_memory::ProjectGraphImportReport;
use std::fs;

#[test]
fn failed_import_keeps_previous_artifacts_and_fingerprint() {
    let root = temp_root("failed-import");
    let published = root.join("workspace-a");
    fs::create_dir_all(&published).unwrap();
    fs::write(published.join("graph.json"), r#"{"version":"old"}"#).unwrap();
    fs::write(published.join(".fingerprint"), "fp-old").unwrap();

    let result = stage_project_graph_build(
        &published,
        "fp-new",
        |staging| {
            fs::create_dir_all(staging).map_err(|error| error.to_string())?;
            fs::write(staging.join("graph.json"), valid_graph()).map_err(|error| error.to_string())
        },
        |_| Err(ProjectGraphCommitError::Import("forced".to_string())),
    );

    assert!(matches!(result, Err(ProjectGraphCommitError::Import(_))));
    assert_eq!(
        fs::read_to_string(published.join("graph.json")).unwrap(),
        r#"{"version":"old"}"#
    );
    assert_eq!(
        fs::read_to_string(published.join(".fingerprint")).unwrap(),
        "fp-old"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn successful_import_publishes_artifacts_and_fingerprint() {
    let root = temp_root("success");
    let published = root.join("workspace-a");
    fs::create_dir_all(&published).unwrap();
    fs::write(published.join("graph.json"), r#"{"version":"old"}"#).unwrap();
    fs::write(published.join(".fingerprint"), "fp-old").unwrap();

    let report = stage_project_graph_build(
        &published,
        "fp-new",
        |staging| {
            fs::create_dir_all(staging).map_err(|error| error.to_string())?;
            fs::write(staging.join("graph.json"), valid_graph()).map_err(|error| error.to_string())
        },
        |_| Ok(report()),
    )
    .unwrap();

    assert_eq!(report.unique_nodes, 2);
    assert_eq!(
        fs::read_to_string(published.join("graph.json")).unwrap(),
        valid_graph()
    );
    assert_eq!(
        fs::read_to_string(published.join(".fingerprint")).unwrap(),
        "fp-new"
    );
    fs::remove_dir_all(root).unwrap();
}

fn valid_graph() -> &'static str {
    r#"{"nodes":[{"id":"a"},{"id":"b"}],"links":[]}"#
}

fn report() -> ProjectGraphImportReport {
    ProjectGraphImportReport {
        input_nodes: 2,
        unique_nodes: 2,
        duplicate_nodes: 0,
        malformed_nodes: 0,
        input_edges: 0,
        unique_edges: 0,
        duplicate_edges: 0,
        malformed_edges: 0,
        dangling_edges: 0,
        checksum: "checksum".to_string(),
    }
}

fn temp_root(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("project-graph-{label}-{}", uuid::Uuid::new_v4()))
}
