use crate::MemoryRef;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct UserId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorkspaceId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PrivacyDomain(String);

impl UserId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl WorkspaceId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl PrivacyDomain {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for UserId {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl From<&str> for WorkspaceId {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl From<&str> for PrivacyDomain {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataSensitivity {
    Public,
    Internal,
    Private,
    Confidential,
    Secret,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryStatus {
    Candidate,
    Confirmed,
    Rejected,
    Stale,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryEvent {
    pub reference: MemoryRef,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub timestamp: String,
    pub source: String,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub reference: MemoryRef,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub memory_type: String,
    pub text: String,
    pub aliases: Vec<String>,
    pub language_hints: Vec<String>,
    pub confidence: f64,
    pub status: MemoryStatus,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    pub metadata: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
    pub last_seen_at: Option<String>,
    pub supersedes: Vec<MemoryRef>,
    pub superseded_by: Option<MemoryRef>,
    pub correction_of: Option<MemoryRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryEntity {
    pub reference: MemoryRef,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub entity_type: String,
    pub name: String,
    pub canonical_key: String,
    pub aliases: Vec<String>,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryRelation {
    pub reference: MemoryRef,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub source_ref: MemoryRef,
    pub relation_type: String,
    pub target_ref: MemoryRef,
    pub confidence: f64,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    pub evidence: Vec<MemoryRef>,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryEvidence {
    pub memory_ref: MemoryRef,
    pub evidence_ref: MemoryRef,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WikiPage {
    pub reference: MemoryRef,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub path: String,
    pub title: String,
    pub body: String,
    pub linked_refs: Vec<MemoryRef>,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryContextItem {
    pub reference: MemoryRef,
    pub summary: String,
    /// e.g. "fact" | "preference" | "decision" — lets callers tier the profile
    /// (always-on identity/preferences vs episodic facts) without a second query.
    pub memory_type: String,
    pub sensitivity: DataSensitivity,
    pub privacy_domain: PrivacyDomain,
    pub evidence: Vec<MemoryRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryContextPack {
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub purpose: String,
    pub items: Vec<MemoryContextItem>,
    pub redacted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryExtraction {
    #[serde(default)]
    pub memories: Vec<ExtractedMemory>,
    #[serde(default)]
    pub entities: Vec<ExtractedEntity>,
    #[serde(default)]
    pub relations: Vec<ExtractedRelation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractedMemory {
    pub memory_type: String,
    pub text: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub language_hints: Vec<String>,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractedEntity {
    pub entity_type: String,
    pub name: String,
    pub canonical_key: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractedRelation {
    pub source_ref: String,
    pub relation_type: String,
    pub target_ref: String,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryExtractionSummary {
    pub memories_imported: usize,
    pub entities_imported: usize,
    pub relations_imported: usize,
    pub evidence_links_imported: usize,
    pub memory_refs: Vec<MemoryRef>,
    pub entity_refs: Vec<MemoryRef>,
    pub relation_refs: Vec<MemoryRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutineStatus {
    Candidate,
    Confirmed,
    Rejected,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoutineRecord {
    pub reference: MemoryRef,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub name: String,
    pub intent: String,
    pub confidence: f64,
    pub status: RoutineStatus,
    pub schedule_hint: serde_json::Value,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    pub evidence: Vec<MemoryRef>,
    pub metadata: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoutineInference {
    #[serde(default)]
    pub routines: Vec<ExtractedRoutine>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractedRoutine {
    pub name: String,
    pub intent: String,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    #[serde(default)]
    pub schedule_hint: serde_json::Value,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoutineInferenceSummary {
    pub routines_imported: usize,
    pub routine_refs: Vec<MemoryRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationCandidateStatus {
    Candidate,
    Approved,
    Rejected,
    Stale,
    Executed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AutomationCandidateRecord {
    pub reference: MemoryRef,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
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
    pub evidence: Vec<MemoryRef>,
    pub proposal_json: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

fn default_confidence() -> f64 {
    0.5
}
