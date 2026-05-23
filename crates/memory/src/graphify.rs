use crate::{
    DataSensitivity, MemoryEntity, MemoryRef, MemoryRefKind, MemoryRelation, PrivacyDomain,
    SQLiteMemoryStore, UserId, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphifyArtifacts {
    pub output_dir: PathBuf,
    pub graph_json_path: PathBuf,
    pub report_path: PathBuf,
    pub html_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphifyImportSummary {
    pub nodes_imported: usize,
    pub edges_imported: usize,
    pub entity_refs: Vec<MemoryRef>,
    pub relation_refs: Vec<MemoryRef>,
}

pub struct GraphifyImport<'a> {
    store: &'a SQLiteMemoryStore,
}

#[derive(Debug, Clone)]
pub struct GraphifyCli {
    binary: String,
}

#[derive(Debug, Deserialize)]
struct GraphifyGraphJson {
    nodes: Vec<GraphifyNode>,
    #[serde(default, alias = "edges")]
    links: Vec<GraphifyLink>,
}

#[derive(Debug, Clone, Deserialize)]
struct GraphifyNode {
    id: String,
    label: Option<String>,
    source_file: Option<String>,
    source_location: Option<String>,
    community: Option<serde_json::Value>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct GraphifyLink {
    source: String,
    target: String,
    relation: Option<String>,
    confidence: Option<String>,
    context: Option<String>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

impl GraphifyArtifacts {
    pub fn from_output_dir(output_dir: impl AsRef<Path>) -> Result<Self, String> {
        let output_dir = output_dir.as_ref().to_path_buf();
        let graph_json_path = output_dir.join("graph.json");
        if !graph_json_path.exists() {
            return Err("graphify artifact graph.json is missing".to_string());
        }
        Ok(Self {
            report_path: output_dir.join("GRAPH_REPORT.md"),
            html_path: output_dir.join("graph.html"),
            output_dir,
            graph_json_path,
        })
    }
}

impl<'a> GraphifyImport<'a> {
    pub fn new(store: &'a SQLiteMemoryStore) -> Self {
        Self { store }
    }

    pub fn import_artifacts(
        &self,
        artifacts: &GraphifyArtifacts,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        privacy_domain: PrivacyDomain,
        sensitivity: DataSensitivity,
    ) -> Result<GraphifyImportSummary, String> {
        let graph: GraphifyGraphJson = serde_json::from_str(
            &fs::read_to_string(&artifacts.graph_json_path).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;

        let mut node_refs = BTreeMap::new();
        let mut entity_refs = Vec::new();
        for node in &graph.nodes {
            let reference = graphify_entity_ref(user_id, workspace_id, &node.id);
            let entity = MemoryEntity {
                reference: reference.clone(),
                user_id: user_id.clone(),
                workspace_id: workspace_id.clone(),
                entity_type: node
                    .extra
                    .get("file_type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("graphify_node")
                    .to_string(),
                name: node.label.clone().unwrap_or_else(|| node.id.clone()),
                canonical_key: format!("graphify:{}", node.id),
                aliases: vec![],
                privacy_domain: privacy_domain.clone(),
                sensitivity,
                metadata: node_metadata(node, artifacts),
            };
            self.store.upsert_entity(&entity)?;
            node_refs.insert(node.id.clone(), reference.clone());
            entity_refs.push(reference);
        }

        let mut relation_refs = Vec::new();
        for link in &graph.links {
            let Some(source_ref) = node_refs.get(&link.source).cloned() else {
                continue;
            };
            let Some(target_ref) = node_refs.get(&link.target).cloned() else {
                continue;
            };
            let relation_type = link
                .relation
                .clone()
                .unwrap_or_else(|| "related_to".to_string());
            let edge_id = graphify_edge_id(&link.source, &relation_type, &link.target);
            let reference = MemoryRef::new(
                MemoryRefKind::Relation,
                user_id.clone(),
                workspace_id.clone(),
                format!("graphify:{}", edge_id),
            );
            let relation = MemoryRelation {
                reference: reference.clone(),
                user_id: user_id.clone(),
                workspace_id: workspace_id.clone(),
                source_ref,
                relation_type,
                target_ref,
                confidence: confidence_score(link.confidence.as_deref()),
                privacy_domain: privacy_domain.clone(),
                sensitivity,
                evidence: vec![],
                metadata: link_metadata(link, artifacts, &edge_id),
            };
            self.store.upsert_relation(&relation)?;
            relation_refs.push(reference);
        }

        Ok(GraphifyImportSummary {
            nodes_imported: entity_refs.len(),
            edges_imported: relation_refs.len(),
            entity_refs,
            relation_refs,
        })
    }
}

impl GraphifyCli {
    pub fn new(binary: impl Into<String>) -> Self {
        Self {
            binary: binary.into(),
        }
    }

    pub fn binary(&self) -> &str {
        &self.binary
    }

    pub fn query_args(
        &self,
        artifacts: &GraphifyArtifacts,
        question: &str,
        budget: Option<u32>,
    ) -> Vec<String> {
        let mut args = vec![
            "query".to_string(),
            question.to_string(),
            "--graph".to_string(),
            artifacts.graph_json_path.to_string_lossy().to_string(),
        ];
        if let Some(budget) = budget {
            args.push("--budget".to_string());
            args.push(budget.to_string());
        }
        args
    }

    pub fn path_args(
        &self,
        artifacts: &GraphifyArtifacts,
        source: &str,
        target: &str,
    ) -> Vec<String> {
        vec![
            "path".to_string(),
            source.to_string(),
            target.to_string(),
            "--graph".to_string(),
            artifacts.graph_json_path.to_string_lossy().to_string(),
        ]
    }

    pub fn explain_args(&self, artifacts: &GraphifyArtifacts, label: &str) -> Vec<String> {
        vec![
            "explain".to_string(),
            label.to_string(),
            "--graph".to_string(),
            artifacts.graph_json_path.to_string_lossy().to_string(),
        ]
    }
}

fn graphify_entity_ref(user_id: &UserId, workspace_id: &WorkspaceId, node_id: &str) -> MemoryRef {
    MemoryRef::new(
        MemoryRefKind::Entity,
        user_id.clone(),
        workspace_id.clone(),
        format!("graphify:{}", node_id),
    )
}

fn graphify_edge_id(source: &str, relation: &str, target: &str) -> String {
    format!("{source}--{relation}--{target}")
}

fn confidence_score(confidence: Option<&str>) -> f64 {
    match confidence {
        Some("EXTRACTED") => 1.0,
        Some("INFERRED") => 0.7,
        Some("AMBIGUOUS") => 0.35,
        _ => 0.5,
    }
}

fn node_metadata(node: &GraphifyNode, artifacts: &GraphifyArtifacts) -> serde_json::Value {
    let mut metadata = serde_json::Map::new();
    metadata.insert("adapter".to_string(), serde_json::json!("graphify"));
    metadata.insert(
        "graphify_node_id".to_string(),
        serde_json::json!(node.id.clone()),
    );
    metadata.insert(
        "graph_json_path".to_string(),
        serde_json::json!(artifacts.graph_json_path.to_string_lossy().to_string()),
    );
    metadata.insert(
        "report_path".to_string(),
        serde_json::json!(artifacts.report_path.to_string_lossy().to_string()),
    );
    metadata.insert(
        "html_path".to_string(),
        serde_json::json!(artifacts.html_path.to_string_lossy().to_string()),
    );
    if let Some(source_file) = &node.source_file {
        metadata.insert("source_file".to_string(), serde_json::json!(source_file));
    }
    if let Some(source_location) = &node.source_location {
        metadata.insert(
            "source_location".to_string(),
            serde_json::json!(source_location),
        );
    }
    if let Some(community) = &node.community {
        metadata.insert("community".to_string(), community.clone());
    }
    for (key, value) in &node.extra {
        metadata.entry(key.clone()).or_insert_with(|| value.clone());
    }
    serde_json::Value::Object(metadata)
}

fn link_metadata(
    link: &GraphifyLink,
    artifacts: &GraphifyArtifacts,
    edge_id: &str,
) -> serde_json::Value {
    let mut metadata = serde_json::Map::new();
    metadata.insert("adapter".to_string(), serde_json::json!("graphify"));
    metadata.insert("graphify_edge_id".to_string(), serde_json::json!(edge_id));
    metadata.insert(
        "graphify_source_node_id".to_string(),
        serde_json::json!(link.source.clone()),
    );
    metadata.insert(
        "graphify_target_node_id".to_string(),
        serde_json::json!(link.target.clone()),
    );
    metadata.insert(
        "graph_json_path".to_string(),
        serde_json::json!(artifacts.graph_json_path.to_string_lossy().to_string()),
    );
    metadata.insert(
        "report_path".to_string(),
        serde_json::json!(artifacts.report_path.to_string_lossy().to_string()),
    );
    if let Some(confidence) = &link.confidence {
        metadata.insert("confidence".to_string(), serde_json::json!(confidence));
    }
    if let Some(context) = &link.context {
        metadata.insert("context".to_string(), serde_json::json!(context));
    }
    for (key, value) in &link.extra {
        metadata.entry(key.clone()).or_insert_with(|| value.clone());
    }
    serde_json::Value::Object(metadata)
}
