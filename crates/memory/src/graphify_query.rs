use crate::{GraphifyArtifacts, MemoryAccessRequest, MemoryRef};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphifyOperation {
    Query {
        question: String,
        budget: Option<u32>,
    },
    Path {
        source: String,
        target: String,
    },
    Explain {
        label: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GraphifyQueryRequest {
    pub access: MemoryAccessRequest,
    pub artifacts: GraphifyArtifacts,
    pub allowed_output_root: PathBuf,
    pub operation: GraphifyOperation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphifyQueryResult {
    pub command: Vec<String>,
    pub entity_refs: Vec<MemoryRef>,
    pub relation_refs: Vec<MemoryRef>,
    pub summaries: Vec<String>,
}

pub(crate) fn ensure_artifacts_inside_root(
    artifacts: &GraphifyArtifacts,
    allowed_root: &Path,
) -> Result<(), String> {
    let output_dir = artifacts
        .output_dir
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let allowed_root = allowed_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !output_dir.starts_with(&allowed_root) {
        return Err("graphify artifacts must stay inside allowed output root".to_string());
    }
    Ok(())
}
