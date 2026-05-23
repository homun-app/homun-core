use crate::{
    AutomationCandidateStatus, AutomationRiskLevel, DataSensitivity, MemoryRef, MemoryStatus,
    PrivacyDomain, UserId, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryLifecycleRequest {
    pub actor_id: String,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub purpose: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryCreateRequest {
    pub request: MemoryLifecycleRequest,
    pub memory_type: String,
    pub text: String,
    pub aliases: Vec<String>,
    pub language_hints: Vec<String>,
    pub confidence: f64,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    pub evidence_refs: Vec<MemoryRef>,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MemoryUpdatePatch {
    pub text: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub language_hints: Option<Vec<String>>,
    pub confidence: Option<f64>,
    pub privacy_domain: Option<PrivacyDomain>,
    pub sensitivity: Option<DataSensitivity>,
    pub metadata: Option<serde_json::Value>,
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AutomationCandidateCreateRequest {
    pub request: MemoryLifecycleRequest,
    pub routine_ref: Option<MemoryRef>,
    pub title: String,
    pub summary: String,
    pub trigger: String,
    pub actions: Vec<String>,
    pub risk_level: AutomationRiskLevel,
    pub autonomy_level: u8,
    pub status: AutomationCandidateStatus,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    pub evidence_refs: Vec<MemoryRef>,
    pub proposal_json: serde_json::Value,
}

pub(crate) fn current_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or_default();
    format!("unix:{seconds}.{nanos:09}")
}

pub(crate) fn ensure_transition(current: MemoryStatus, next: MemoryStatus) -> Result<(), String> {
    match (current, next) {
        (MemoryStatus::Candidate, MemoryStatus::Confirmed)
        | (MemoryStatus::Candidate, MemoryStatus::Rejected)
        | (MemoryStatus::Confirmed, MemoryStatus::Stale)
        | (_, MemoryStatus::Deleted) => Ok(()),
        (MemoryStatus::Confirmed, MemoryStatus::Rejected) => {
            Err("cannot reject confirmed memory".to_string())
        }
        (same_current, same_next) if same_current == same_next => Ok(()),
        _ => Err(format!(
            "invalid memory transition from {:?} to {:?}",
            current, next
        )),
    }
}
