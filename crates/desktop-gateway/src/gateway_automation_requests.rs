//! Automation route request ownership.
//!
//! This module owns the HTTP DTOs and workspace scoping helper used by the
//! automation CRUD endpoints. Handlers stay in the gateway root for now.

use serde::Deserialize;

use crate::gateway_workspace_id;
use local_first_task_runtime::{ApprovalPolicy, AutomationSource, AutomationTrigger, WorkspaceId};

/// Body for creating an Automation (the user-facing rule). `trigger` is a typed
/// `AutomationTrigger` ({"type":"schedule","recurrence":"daily@08:00","tz":"Europe/Rome"}
/// or {"type":"event","event":{"kind":"channel_message","from":"Mario"}}).
#[derive(Deserialize)]
pub(crate) struct AutomationCreateRequest {
    pub(crate) title: String,
    pub(crate) trigger: AutomationTrigger,
    pub(crate) prompt: String,
    #[serde(default)]
    pub(crate) workspace_id: Option<String>,
    #[serde(default)]
    pub(crate) approval: Option<ApprovalPolicy>,
    #[serde(default)]
    pub(crate) source: Option<AutomationSource>,
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct AutomationScopeQuery {
    #[serde(default)]
    pub(crate) workspace_id: Option<String>,
}

pub(crate) fn automation_workspace_scope(raw: Option<&str>) -> WorkspaceId {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return gateway_workspace_id();
    };
    WorkspaceId::new(value)
}

/// Partial update of an existing automation: any field left out is unchanged.
/// `enabled` stays owned by the toggle endpoint.
#[derive(Debug, Deserialize)]
pub(crate) struct AutomationUpdateRequest {
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) trigger: Option<AutomationTrigger>,
    #[serde(default)]
    pub(crate) prompt: Option<String>,
    #[serde(default)]
    pub(crate) approval: Option<ApprovalPolicy>,
}

#[cfg(test)]
mod tests {
    use super::automation_workspace_scope;
    use crate::gateway_workspace_id;

    #[test]
    fn gateway_automation_requests_workspace_scope_defaults_and_trims() {
        assert_eq!(
            automation_workspace_scope(None).as_str(),
            gateway_workspace_id().as_str()
        );
        assert_eq!(
            automation_workspace_scope(Some("  ")).as_str(),
            gateway_workspace_id().as_str()
        );
        assert_eq!(
            automation_workspace_scope(Some("project_alpha")).as_str(),
            "project_alpha"
        );
    }
}
