use crate::linked_memory_repair::{LinkedMemoryRepairApplyResult, LinkedMemoryRepairPreview};
use local_first_memory::{
    DataSensitivity, MemoryIntegrityReport, MemoryRepairAction, MemoryRepairEstimate,
    PrivacyDomain, ProjectGraphImportReport, UserId, WorkspaceId, normalize_graphify_value,
};
use local_first_vault::VaultIntegrityReport;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphFreshness {
    Missing,
    Fresh,
    Stale,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphIntegrityStatus {
    pub workspace_id: String,
    pub status: GraphFreshness,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_fingerprint_hash: Option<String>,
    pub current_fingerprint_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<ProjectGraphImportReport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrityAuditResponse {
    pub memory: MemoryIntegrityReport,
    pub vault: VaultIntegrityReport,
    pub graphs: Vec<GraphIntegrityStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IntegrityRepairAction {
    RemoveGraphifyDuplicateRelations { workspace_id: WorkspaceId },
    RemoveOrphanEmbeddings,
    RemoveOrphanEvidenceLinks,
    RemoveMissingWikiLinks,
    RebuildFts,
    PurgeUnknownWorkspace { workspace_id: WorkspaceId },
    RefreshProjectGraph { workspace_id: WorkspaceId },
}

impl IntegrityRepairAction {
    pub fn as_memory_action(&self) -> Option<MemoryRepairAction> {
        match self {
            Self::RemoveGraphifyDuplicateRelations { workspace_id } => {
                Some(MemoryRepairAction::RemoveGraphifyDuplicateRelations {
                    workspace_id: workspace_id.clone(),
                })
            }
            Self::RemoveOrphanEmbeddings => Some(MemoryRepairAction::RemoveOrphanEmbeddings),
            Self::RemoveOrphanEvidenceLinks => Some(MemoryRepairAction::RemoveOrphanEvidenceLinks),
            Self::RemoveMissingWikiLinks => Some(MemoryRepairAction::RemoveMissingWikiLinks),
            Self::RebuildFts => Some(MemoryRepairAction::RebuildFts),
            Self::PurgeUnknownWorkspace { workspace_id } => {
                Some(MemoryRepairAction::PurgeUnknownWorkspace {
                    workspace_id: workspace_id.clone(),
                })
            }
            Self::RefreshProjectGraph { .. } => None,
        }
    }

    pub fn is_graph_refresh(&self) -> bool {
        matches!(self, Self::RefreshProjectGraph { .. })
    }
}

impl From<MemoryRepairAction> for IntegrityRepairAction {
    fn from(action: MemoryRepairAction) -> Self {
        match action {
            MemoryRepairAction::RemoveGraphifyDuplicateRelations { workspace_id } => {
                Self::RemoveGraphifyDuplicateRelations { workspace_id }
            }
            MemoryRepairAction::RemoveOrphanEmbeddings => Self::RemoveOrphanEmbeddings,
            MemoryRepairAction::RemoveOrphanEvidenceLinks => Self::RemoveOrphanEvidenceLinks,
            MemoryRepairAction::RemoveMissingWikiLinks => Self::RemoveMissingWikiLinks,
            MemoryRepairAction::RebuildFts => Self::RebuildFts,
            MemoryRepairAction::PurgeUnknownWorkspace { workspace_id } => {
                Self::PurgeUnknownWorkspace { workspace_id }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrityRepairEstimate {
    pub action: IntegrityRepairAction,
    pub estimated_rows: u64,
}

impl From<MemoryRepairEstimate> for IntegrityRepairEstimate {
    fn from(estimate: MemoryRepairEstimate) -> Self {
        Self {
            action: estimate.action.into(),
            estimated_rows: estimate.estimated_rows,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct IntegrityRepairPreviewRequest {
    pub actions: Vec<IntegrityRepairAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrityRepairPreviewResponse {
    pub audit_checksum: String,
    pub actions: Vec<IntegrityRepairAction>,
    pub estimates: Vec<IntegrityRepairEstimate>,
    pub approval_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct IntegrityRepairApplyRequest {
    pub audit_checksum: String,
    pub actions: Vec<IntegrityRepairAction>,
    pub approval_token: String,
    pub confirm: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IntegrityBackupSummary {
    pub created: bool,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IntegrityRepairApplyResponse {
    pub before: MemoryIntegrityReport,
    pub after: MemoryIntegrityReport,
    pub backup: IntegrityBackupSummary,
    pub applied: Vec<IntegrityRepairEstimate>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub refreshed_graphs: Vec<GraphIntegrityStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkedMemoryRepairApplyRequest {
    pub preview: LinkedMemoryRepairPreview,
    pub confirm: bool,
}

pub type LinkedMemoryRepairApplyResponse = LinkedMemoryRepairApplyResult;

pub fn inspect_registered_graph(
    workspace_id: &str,
    graph_dir: &Path,
    current_fingerprint: &str,
    user_id: &UserId,
) -> GraphIntegrityStatus {
    let graph_path = graph_dir.join("graph.json");
    let saved_fingerprint = fs::read_to_string(graph_dir.join(".fingerprint")).ok();
    let saved_fingerprint_hash = saved_fingerprint.as_deref().map(hash_value);
    let current_fingerprint_hash = hash_value(current_fingerprint);
    if !graph_path.is_file() {
        return GraphIntegrityStatus {
            workspace_id: workspace_id.to_string(),
            status: GraphFreshness::Missing,
            saved_fingerprint_hash,
            current_fingerprint_hash,
            report: None,
        };
    }

    let normalized = fs::read_to_string(&graph_path)
        .map_err(|_| ())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).map_err(|_| ()))
        .and_then(|graph| {
            normalize_graphify_value(
                &graph,
                user_id,
                &WorkspaceId::new(workspace_id),
                PrivacyDomain::new("work"),
                DataSensitivity::Private,
            )
            .map_err(|_| ())
        });
    let Ok(normalized) = normalized else {
        return GraphIntegrityStatus {
            workspace_id: workspace_id.to_string(),
            status: GraphFreshness::Invalid,
            saved_fingerprint_hash,
            current_fingerprint_hash,
            report: None,
        };
    };
    let status = if saved_fingerprint.as_deref() == Some(current_fingerprint) {
        GraphFreshness::Fresh
    } else {
        GraphFreshness::Stale
    };
    GraphIntegrityStatus {
        workspace_id: workspace_id.to_string(),
        status,
        saved_fingerprint_hash,
        current_fingerprint_hash,
        report: Some(normalized.report),
    }
}

pub fn canonical_integrity_actions(
    actions: Vec<IntegrityRepairAction>,
) -> Result<Vec<IntegrityRepairAction>, String> {
    let mut encoded = actions
        .into_iter()
        .map(|action| {
            serde_json::to_string(&action)
                .map(|json| (json, action))
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    encoded.sort_by(|left, right| left.0.cmp(&right.0));
    if encoded.is_empty() {
        return Err("integrity repair requires at least one explicit action".to_string());
    }
    for pair in encoded.windows(2) {
        if pair[0].0 == pair[1].0 {
            return Err("integrity repair contains duplicate actions".to_string());
        }
    }
    let has_graph = encoded.iter().any(|(_, action)| action.is_graph_refresh());
    let has_memory = encoded.iter().any(|(_, action)| !action.is_graph_refresh());
    if has_graph && has_memory {
        return Err(
            "project graph refresh and database repair require separate previews".to_string(),
        );
    }
    if has_graph && encoded.len() != 1 {
        return Err("preview one project graph refresh at a time".to_string());
    }
    Ok(encoded.into_iter().map(|(_, action)| action).collect())
}

pub fn gateway_audit_checksum(
    memory_checksum: &str,
    actions: &[IntegrityRepairAction],
    relevant_graphs: &[GraphIntegrityStatus],
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(memory_checksum.as_bytes());
    hasher.update([0]);
    hasher.update(serde_json::to_vec(actions).map_err(|error| error.to_string())?);
    hasher.update([0]);
    hasher.update(serde_json::to_vec(relevant_graphs).map_err(|error| error.to_string())?);
    Ok(hex_digest(hasher.finalize()))
}

pub fn gateway_approval_token(
    audit_checksum: &str,
    actions: &[IntegrityRepairAction],
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(audit_checksum.as_bytes());
    hasher.update([0]);
    hasher.update(serde_json::to_vec(actions).map_err(|error| error.to_string())?);
    Ok(hex_digest(hasher.finalize()))
}

fn hash_value(value: &str) -> String {
    hex_digest(Sha256::digest(value.as_bytes()))
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph() -> serde_json::Value {
        serde_json::json!({
            "nodes": [{"id": "alpha"}, {"id": "beta"}],
            "links": [{"source": "alpha", "target": "beta", "relation": "calls"}]
        })
    }

    #[test]
    fn integrity_graph_status_distinguishes_missing_fresh_stale_and_invalid() {
        let dir = std::env::temp_dir().join(format!(
            "homun-integrity-graph-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let user = UserId::new("owner");

        let missing = inspect_registered_graph("project-a", &dir, "fp-1", &user);
        assert_eq!(missing.status, GraphFreshness::Missing);
        fs::write(dir.join("graph.json"), graph().to_string()).unwrap();
        fs::write(dir.join(".fingerprint"), "fp-1").unwrap();
        let fresh = inspect_registered_graph("project-a", &dir, "fp-1", &user);
        assert_eq!(fresh.status, GraphFreshness::Fresh);
        assert_eq!(fresh.report.as_ref().unwrap().unique_nodes, 2);
        let stale = inspect_registered_graph("project-a", &dir, "fp-2", &user);
        assert_eq!(stale.status, GraphFreshness::Stale);
        fs::write(dir.join("graph.json"), "not-json").unwrap();
        let invalid = inspect_registered_graph("project-a", &dir, "fp-1", &user);
        assert_eq!(invalid.status, GraphFreshness::Invalid);

        let encoded = serde_json::to_string(&fresh).unwrap();
        assert!(!encoded.contains("fp-1"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn integrity_actions_are_canonical_and_mixed_domains_are_rejected() {
        let actions = canonical_integrity_actions(vec![
            IntegrityRepairAction::RebuildFts,
            IntegrityRepairAction::RemoveOrphanEmbeddings,
        ])
        .unwrap();
        assert_eq!(actions[0], IntegrityRepairAction::RebuildFts);
        assert_eq!(actions[1], IntegrityRepairAction::RemoveOrphanEmbeddings);
        assert!(
            canonical_integrity_actions(vec![
                IntegrityRepairAction::RebuildFts,
                IntegrityRepairAction::RefreshProjectGraph {
                    workspace_id: WorkspaceId::new("project-a"),
                },
            ])
            .is_err()
        );
    }
}
