use crate::{
    DataSensitivity, MemoryEntity, MemoryRef, MemoryRefKind, MemoryRelation, PrivacyDomain,
    SQLiteMemoryStore, UserId, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
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
    pub report: ProjectGraphImportReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectGraphImportReport {
    pub input_nodes: usize,
    pub unique_nodes: usize,
    pub duplicate_nodes: usize,
    pub malformed_nodes: usize,
    pub input_edges: usize,
    pub unique_edges: usize,
    pub duplicate_edges: usize,
    pub malformed_edges: usize,
    pub dangling_edges: usize,
    pub checksum: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectGraphImportError {
    InvalidRoot,
    InvalidJson(String),
    Store(String),
}

impl fmt::Display for ProjectGraphImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRoot => formatter.write_str("graphify root must be a JSON object"),
            Self::InvalidJson(error) => write!(formatter, "invalid graphify JSON: {error}"),
            Self::Store(error) => write!(formatter, "graphify store error: {error}"),
        }
    }
}

impl std::error::Error for ProjectGraphImportError {}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedProjectGraph {
    pub entities: Vec<MemoryEntity>,
    pub relations: Vec<MemoryRelation>,
    pub report: ProjectGraphImportReport,
}

pub struct GraphifyImport<'a> {
    store: &'a SQLiteMemoryStore,
}

#[derive(Debug, Clone)]
pub struct GraphifyCli {
    binary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GraphifyNode {
    id: String,
    label: Option<String>,
    source_file: Option<String>,
    source_location: Option<String>,
    community: Option<serde_json::Value>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
        let graph: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(&artifacts.graph_json_path).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let normalized = normalize_graphify_value_inner(
            &graph,
            user_id,
            workspace_id,
            privacy_domain,
            sensitivity,
            Some(artifacts),
        )
        .map_err(|error| error.to_string())?;
        let entity_refs = normalized
            .entities
            .iter()
            .map(|entity| entity.reference.clone())
            .collect::<Vec<_>>();
        let relation_refs = normalized
            .relations
            .iter()
            .map(|relation| relation.reference.clone())
            .collect::<Vec<_>>();
        for entity in &normalized.entities {
            self.store.upsert_entity(entity)?;
        }
        for relation in &normalized.relations {
            self.store.upsert_relation(relation)?;
        }

        Ok(GraphifyImportSummary {
            nodes_imported: entity_refs.len(),
            edges_imported: relation_refs.len(),
            entity_refs,
            relation_refs,
            report: normalized.report,
        })
    }
}

pub fn normalize_graphify_value(
    graph: &serde_json::Value,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    privacy_domain: PrivacyDomain,
    sensitivity: DataSensitivity,
) -> Result<NormalizedProjectGraph, ProjectGraphImportError> {
    normalize_graphify_value_inner(
        graph,
        user_id,
        workspace_id,
        privacy_domain,
        sensitivity,
        None,
    )
}

fn normalize_graphify_value_inner(
    graph: &serde_json::Value,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    privacy_domain: PrivacyDomain,
    sensitivity: DataSensitivity,
    artifacts: Option<&GraphifyArtifacts>,
) -> Result<NormalizedProjectGraph, ProjectGraphImportError> {
    let root = graph
        .as_object()
        .ok_or(ProjectGraphImportError::InvalidRoot)?;
    let raw_nodes = root
        .get("nodes")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let raw_links = root
        .get("links")
        .or_else(|| root.get("edges"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut malformed_nodes = 0;
    let mut duplicate_nodes = 0;
    let mut nodes = BTreeMap::<String, (String, GraphifyNode)>::new();
    for value in &raw_nodes {
        let Some(id) = value
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            malformed_nodes += 1;
            continue;
        };
        let mut node: GraphifyNode = match serde_json::from_value(value.clone()) {
            Ok(node) => node,
            Err(_) => {
                malformed_nodes += 1;
                continue;
            }
        };
        node.id = id.to_string();
        node.extra.retain(|key, _| key == "file_type");
        let canonical = canonical_json(&node)?;
        match nodes.entry(node.id.clone()) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert((canonical, node));
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                duplicate_nodes += 1;
                if canonical < entry.get().0 {
                    entry.insert((canonical, node));
                }
            }
        }
    }

    let mut entities = Vec::with_capacity(nodes.len());
    let mut node_refs = BTreeMap::new();
    for (node_id, (_, node)) in &nodes {
        let reference = graphify_entity_ref(user_id, workspace_id, node_id);
        node_refs.insert(node_id.clone(), reference.clone());
        entities.push(MemoryEntity {
            reference,
            user_id: user_id.clone(),
            workspace_id: workspace_id.clone(),
            entity_type: node
                .extra
                .get("file_type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("graphify_node")
                .to_string(),
            name: node.label.clone().unwrap_or_else(|| node_id.clone()),
            canonical_key: format!("code:{node_id}"),
            aliases: vec![node_id.clone()],
            privacy_domain: privacy_domain.clone(),
            sensitivity,
            metadata: node_metadata(node, artifacts),
        });
    }

    let mut malformed_edges = 0;
    let mut dangling_edges = 0;
    let mut duplicate_edges = 0;
    let mut links = BTreeMap::<(String, String, String), (f64, String, GraphifyLink)>::new();
    for value in &raw_links {
        let Some(source) = value
            .get("source")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|source| !source.is_empty())
        else {
            malformed_edges += 1;
            continue;
        };
        let Some(target) = value
            .get("target")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|target| !target.is_empty())
        else {
            malformed_edges += 1;
            continue;
        };
        if !node_refs.contains_key(source) || !node_refs.contains_key(target) {
            dangling_edges += 1;
            continue;
        }
        let mut link: GraphifyLink = match serde_json::from_value(value.clone()) {
            Ok(link) => link,
            Err(_) => {
                malformed_edges += 1;
                continue;
            }
        };
        link.source = source.to_string();
        link.target = target.to_string();
        link.extra.clear();
        let relation = link
            .relation
            .as_deref()
            .map(str::trim)
            .filter(|relation| !relation.is_empty())
            .unwrap_or("connects")
            .to_string();
        link.relation = Some(relation.clone());
        let confidence = confidence_score(link.confidence.as_deref());
        let canonical = canonical_json(&link)?;
        let key = (source.to_string(), relation, target.to_string());
        match links.entry(key) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert((confidence, canonical, link));
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                duplicate_edges += 1;
                let current = entry.get();
                if confidence > current.0 || (confidence == current.0 && canonical < current.1) {
                    entry.insert((confidence, canonical, link));
                }
            }
        }
    }

    let mut relations = Vec::with_capacity(links.len());
    for ((source, relation_type, target), (confidence, _, link)) in &links {
        let edge_id = graphify_edge_id(source, relation_type, target);
        relations.push(MemoryRelation {
            reference: graphify_relation_ref(user_id, workspace_id, source, relation_type, target),
            user_id: user_id.clone(),
            workspace_id: workspace_id.clone(),
            source_ref: node_refs[source].clone(),
            relation_type: relation_type.clone(),
            target_ref: node_refs[target].clone(),
            confidence: *confidence,
            privacy_domain: privacy_domain.clone(),
            sensitivity,
            evidence: vec![],
            metadata: link_metadata(link, artifacts, &edge_id),
        });
    }

    let checksum = graph_checksum(&entities, &relations)?;
    Ok(NormalizedProjectGraph {
        report: ProjectGraphImportReport {
            input_nodes: raw_nodes.len(),
            unique_nodes: entities.len(),
            duplicate_nodes,
            malformed_nodes,
            input_edges: raw_links.len(),
            unique_edges: relations.len(),
            duplicate_edges,
            malformed_edges,
            dangling_edges,
            checksum,
        },
        entities,
        relations,
    })
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
        format!(
            "graphify:node:{}",
            sha256_json(&serde_json::json!(["code", node_id]))
        ),
    )
}

fn graphify_relation_ref(
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    source: &str,
    relation: &str,
    target: &str,
) -> MemoryRef {
    MemoryRef::new(
        MemoryRefKind::Relation,
        user_id.clone(),
        workspace_id.clone(),
        format!(
            "graphify:edge:{}",
            sha256_json(&serde_json::json!([source, relation, target]))
        ),
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

fn node_metadata(node: &GraphifyNode, artifacts: Option<&GraphifyArtifacts>) -> serde_json::Value {
    let mut metadata = serde_json::Map::new();
    metadata.insert("adapter".to_string(), serde_json::json!("graphify"));
    metadata.insert("source".to_string(), serde_json::json!("graphify"));
    metadata.insert(
        "graphify_node_id".to_string(),
        serde_json::json!(node.id.clone()),
    );
    if let Some(artifacts) = artifacts {
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
    }
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
    serde_json::Value::Object(metadata)
}

fn link_metadata(
    link: &GraphifyLink,
    artifacts: Option<&GraphifyArtifacts>,
    edge_id: &str,
) -> serde_json::Value {
    let mut metadata = serde_json::Map::new();
    metadata.insert("adapter".to_string(), serde_json::json!("graphify"));
    metadata.insert("source".to_string(), serde_json::json!("graphify"));
    metadata.insert("graphify_edge_id".to_string(), serde_json::json!(edge_id));
    metadata.insert(
        "graphify_source_node_id".to_string(),
        serde_json::json!(link.source.clone()),
    );
    metadata.insert(
        "graphify_target_node_id".to_string(),
        serde_json::json!(link.target.clone()),
    );
    if let Some(artifacts) = artifacts {
        metadata.insert(
            "graph_json_path".to_string(),
            serde_json::json!(artifacts.graph_json_path.to_string_lossy().to_string()),
        );
        metadata.insert(
            "report_path".to_string(),
            serde_json::json!(artifacts.report_path.to_string_lossy().to_string()),
        );
    }
    if let Some(confidence) = &link.confidence {
        metadata.insert("confidence".to_string(), serde_json::json!(confidence));
    }
    if let Some(context) = &link.context {
        metadata.insert("context".to_string(), serde_json::json!(context));
    }
    serde_json::Value::Object(metadata)
}

fn graph_checksum(
    entities: &[MemoryEntity],
    relations: &[MemoryRelation],
) -> Result<String, ProjectGraphImportError> {
    let value = serde_json::json!({
        "nodes": entities.iter().map(|entity| serde_json::json!({
            "canonical_key": entity.canonical_key,
            "entity_type": entity.entity_type,
            "name": entity.name,
            "aliases": entity.aliases,
            "metadata": entity.metadata,
        })).collect::<Vec<_>>(),
        "edges": relations.iter().map(|relation| serde_json::json!({
            "source_ref": relation.source_ref.to_string(),
            "relation_type": relation.relation_type,
            "target_ref": relation.target_ref.to_string(),
            "confidence": relation.confidence,
            "metadata": relation.metadata,
        })).collect::<Vec<_>>(),
    });
    Ok(sha256_json(&value))
}

fn canonical_json<T: Serialize>(value: &T) -> Result<String, ProjectGraphImportError> {
    serde_json::to_string(value)
        .map_err(|error| ProjectGraphImportError::InvalidJson(error.to_string()))
}

fn sha256_json(value: &serde_json::Value) -> String {
    let encoded = serde_json::to_vec(value).expect("serializing serde_json::Value cannot fail");
    format!("{:x}", Sha256::digest(encoded))
}
