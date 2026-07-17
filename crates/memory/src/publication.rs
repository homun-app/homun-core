use crate::{DataSensitivity, MemoryRecord, MemoryRef, PrivacyDomain, UserId, WorkspaceId};
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryPublicationProposal {
    pub id: String,
    pub source_ref: MemoryRef,
    pub source_user_id: UserId,
    pub source_workspace_id: WorkspaceId,
    pub destination_user_id: UserId,
    pub destination_workspace_id: WorkspaceId,
    /// A redacted-safe local payload. Source metadata is deliberately not copied
    /// into this proposal or the destination canonical record.
    pub proposed_text: String,
    pub proposed_memory_type: String,
    pub proposed_privacy_domain: PrivacyDomain,
    pub proposed_sensitivity: DataSensitivity,
    pub duplicate_ref: Option<MemoryRef>,
    pub status: MemoryPublicationStatus,
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
