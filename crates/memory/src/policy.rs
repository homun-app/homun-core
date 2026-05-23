use crate::{DataSensitivity, MemoryRecord, PrivacyDomain, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessDecisionKind {
    Allow,
    Redact,
    SummarizeOnly,
    RequiresUserApproval,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryAccessRequest {
    pub actor_id: String,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub purpose: String,
    pub allowed_domains: Vec<PrivacyDomain>,
    pub max_sensitivity: DataSensitivity,
    pub allow_raw_payload: bool,
    pub allow_export: bool,
    pub broad_query: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryAccessDecision {
    pub kind: AccessDecisionKind,
    pub reasons: Vec<String>,
}

#[derive(Debug, Default, Clone)]
pub struct MemoryPolicyEngine;

impl MemoryPolicyEngine {
    pub fn decide_memory(
        &self,
        request: &MemoryAccessRequest,
        memory: &MemoryRecord,
    ) -> MemoryAccessDecision {
        if request.user_id != memory.user_id || request.workspace_id != memory.workspace_id {
            return MemoryAccessDecision::deny("scope_mismatch");
        }
        if !request
            .allowed_domains
            .iter()
            .any(|domain| domain == &memory.privacy_domain)
        {
            return MemoryAccessDecision::deny("privacy_domain_not_allowed");
        }
        if memory.sensitivity > request.max_sensitivity {
            return MemoryAccessDecision::deny("sensitivity_above_request_limit");
        }
        if !request.allow_raw_payload {
            return MemoryAccessDecision::redact("raw_payload_not_allowed");
        }
        MemoryAccessDecision::allow()
    }

    pub fn decide_export(&self, request: &MemoryAccessRequest) -> MemoryAccessDecision {
        if request.broad_query && !request.allow_export {
            return MemoryAccessDecision::deny("export_not_allowed");
        }
        MemoryAccessDecision::allow()
    }
}

impl MemoryAccessDecision {
    pub fn allow() -> Self {
        Self {
            kind: AccessDecisionKind::Allow,
            reasons: vec![],
        }
    }

    pub fn redact(reason: &str) -> Self {
        Self {
            kind: AccessDecisionKind::Redact,
            reasons: vec![reason.to_string()],
        }
    }

    pub fn deny(reason: &str) -> Self {
        Self {
            kind: AccessDecisionKind::Deny,
            reasons: vec![reason.to_string()],
        }
    }
}
