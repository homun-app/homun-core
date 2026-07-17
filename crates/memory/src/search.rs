use crate::{
    DataSensitivity, MemoryAccessRequest, MemoryRef, MemorySourcePolicy, MemoryStatus,
    PrivacyDomain,
};
use serde::{Deserialize, Serialize};

pub const AUTHORIZED_MEMORY_SEARCH_LIMIT_MAX: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemorySearchRequest {
    pub access: MemoryAccessRequest,
    pub query: String,
    pub statuses: Vec<MemoryStatus>,
    pub memory_types: Vec<String>,
    pub limit: usize,
    pub offset: usize,
}

/// Search constrained to one already-authorized source. This is intentionally
/// separate from [`MemorySearchRequest`] so existing callers keep their public
/// request shape unchanged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuthorizedMemorySearchRequest {
    pub access: MemoryAccessRequest,
    pub source_policy: Option<MemorySourcePolicy>,
    pub query: String,
    pub statuses: Vec<MemoryStatus>,
    pub memory_types: Vec<String>,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemorySearchResult {
    pub reference: MemoryRef,
    pub memory_type: String,
    pub summary: String,
    /// Raw record metadata — lets readers surface structured fields (e.g. a
    /// decision's `metadata.decision` rationale/alternatives), not just the summary.
    #[serde(default)]
    pub metadata: serde_json::Value,
    pub status: MemoryStatus,
    pub privacy_domain: PrivacyDomain,
    pub sensitivity: DataSensitivity,
    pub rank: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemorySearchPage {
    pub items: Vec<MemorySearchResult>,
    pub total: usize,
    pub limit: usize,
    pub offset: usize,
}
