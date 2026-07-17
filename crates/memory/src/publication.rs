use crate::{
    DataSensitivity, MemoryCollectionKey, MemoryRecord, MemoryRef, PrivacyDomain, UserId,
    WorkspaceId,
};
use serde::{Deserialize, Serialize};

/// A destination scope selected explicitly by the owner before a memory is published.
/// The destination remains a normal, isolated memory space; this value never grants
/// the caller broad cross-workspace access.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryPublicationDestination {
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
}

impl MemoryPublicationDestination {
    pub fn new(user_id: UserId, workspace_id: WorkspaceId) -> Self {
        Self {
            user_id,
            workspace_id,
        }
    }

    pub fn personal(user_id: UserId) -> Self {
        Self::new(user_id, WorkspaceId::new(crate::PERSONAL_WORKSPACE))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryPublicationStatus {
    Pending,
    Approved,
    Rejected,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryPublicationReasonCode {
    Pending,
    PublicationDuplicateCompatible,
    PublicationConflict,
    Approved,
    Rejected,
    PublicationFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum MemoryPublicationResolution {
    CreateNew,
    UpdateExisting { destination_ref: MemoryRef },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum MemoryPublicationCandidate {
    CompatibleDuplicate { destination_ref: MemoryRef },
    Conflict { destination_ref: MemoryRef },
}

/// The only client-editable portion of a publication proposal. Scope, ownership,
/// provenance, candidate and lifecycle state are deliberately absent: they are
/// always reloaded and derived by the memory boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryPublicationEditInput {
    pub proposed_text: Option<String>,
    pub proposed_memory_type: Option<String>,
    pub proposed_privacy_domain: Option<PrivacyDomain>,
    pub proposed_sensitivity: Option<DataSensitivity>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryPublicationProposal {
    pub id: String,
    /// Monotonic optimistic-concurrency token for this exact preview.
    pub proposal_version: u64,
    pub source_ref: MemoryRef,
    pub source_user_id: UserId,
    pub source_workspace_id: WorkspaceId,
    pub destination_user_id: UserId,
    pub destination_workspace_id: WorkspaceId,
    /// A redacted-safe local payload. Source metadata is deliberately not copied
    /// into this proposal or the destination canonical record.
    pub proposed_text: String,
    pub proposed_memory_type: String,
    pub proposed_collection: MemoryCollectionKey,
    pub proposed_privacy_domain: PrivacyDomain,
    pub proposed_sensitivity: DataSensitivity,
    /// Fingerprint of the server-reloaded source when this preview was made.
    /// A pending legacy proposal without a verifiable revision is fail-closed.
    pub source_revision: String,
    /// Fingerprint of the full visible destination scope when this preview was
    /// derived. A pending legacy proposal without it is rebased before review.
    pub destination_revision: String,
    pub candidate: Option<MemoryPublicationCandidate>,
    pub resolution: Option<MemoryPublicationResolution>,
    pub status: MemoryPublicationStatus,
    pub reason_code: MemoryPublicationReasonCode,
    /// Stable, redacted-safe code recorded only after a failed approval.
    pub failure_reason: Option<String>,
    pub proposed_by: String,
    pub decided_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryPublicationLink {
    pub source_ref: MemoryRef,
    pub destination_ref: MemoryRef,
    pub approved_by: String,
    pub created_at: String,
}

/// Result of a successful explicit approval. It carries the canonical destination
/// plus its audit link rather than asking callers to reconstruct provenance from text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryPublicationResult {
    pub proposal: MemoryPublicationProposal,
    pub destination: MemoryRecord,
    pub link: MemoryPublicationLink,
}
