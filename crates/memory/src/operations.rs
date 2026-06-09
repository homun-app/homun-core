use serde::{Deserialize, Serialize};
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

/// One row of the access-audit ledger: a recorded decision about accessing memory
/// (who/why/outcome/when). Surfaced in Settings → Dati & Audit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessAuditEntry {
    pub reference: String,
    pub workspace_id: String,
    pub actor_id: String,
    pub purpose: String,
    pub decision: String,
    pub reasons: Vec<String>,
    pub created_at: String,
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
