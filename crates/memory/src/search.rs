use crate::{
    DataSensitivity, MemoryAccessRequest, MemoryRef, MemoryStatus, PrivacyDomain,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemorySearchRequest {
    pub access: MemoryAccessRequest,
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
