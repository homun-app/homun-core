use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryHealth {
    pub schema_version: u32,
    pub total_events: u64,
    pub total_memories: u64,
    pub total_entities: u64,
    pub total_relations: u64,
    pub total_wiki_pages: u64,
    pub access_audit_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryBackupReport {
    pub source_path: PathBuf,
    pub destination_path: PathBuf,
    pub bytes_copied: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryRestoreMode {
    RefuseIfTargetExists,
    ReplaceTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryMaintenanceReport {
    pub integrity_ok: bool,
    pub fts_rebuilt: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePurgeReport {
    pub workspace_id: String,
    pub rows_by_table: BTreeMap<String, usize>,
    pub total_deleted: usize,
}
