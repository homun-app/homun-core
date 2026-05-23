use crate::{ActionClass, CapabilityProviderKind, CapabilityTool, ProviderId, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyContext {
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub enabled_providers: Vec<ProviderId>,
    pub privacy_domains: Vec<String>,
    pub allowed_actions: Vec<ActionClass>,
    pub max_autonomy_level: u8,
    pub allow_managed_cloud: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolAccessDecision {
    pub model_visible: bool,
    pub executable: bool,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CapabilityPolicy;

impl CapabilityPolicy {
    pub fn new() -> Self {
        Self
    }

    pub fn tool_access(
        &self,
        context: &PolicyContext,
        tool: &CapabilityTool,
    ) -> ToolAccessDecision {
        let mut reasons = Vec::new();
        let provider_enabled = context
            .enabled_providers
            .iter()
            .any(|provider| provider == &tool.provider_id);
        if !provider_enabled {
            reasons.push(format!(
                "provider_not_enabled:{}",
                tool.provider_id.as_str()
            ));
        }

        if tool.provider_kind == CapabilityProviderKind::Managed && !context.allow_managed_cloud {
            reasons.push(format!(
                "managed_cloud_not_allowed:{}",
                tool.provider_id.as_str()
            ));
        }

        for domain in &tool.privacy_domains {
            if !context
                .privacy_domains
                .iter()
                .any(|allowed| allowed == domain)
            {
                reasons.push(format!("privacy_domain_denied:{domain}"));
            }
        }

        let boundary_denied = reasons.iter().any(|reason| {
            reason.starts_with("provider_not_enabled:")
                || reason.starts_with("managed_cloud_not_allowed:")
                || reason.starts_with("privacy_domain_denied:")
        });
        if boundary_denied {
            return ToolAccessDecision {
                model_visible: false,
                executable: false,
                reasons,
            };
        }

        let mut executable = true;
        if !context
            .allowed_actions
            .iter()
            .any(|action| action == &tool.action)
        {
            executable = false;
            reasons.push(format!("action_not_allowed:{}", action_name(tool.action)));
        }

        let required_autonomy = required_autonomy_level(tool.action);
        if context.max_autonomy_level < required_autonomy {
            executable = false;
            reasons.push(format!("autonomy_too_low:{required_autonomy}"));
        }

        ToolAccessDecision {
            model_visible: true,
            executable,
            reasons,
        }
    }
}

fn required_autonomy_level(action: ActionClass) -> u8 {
    match action {
        ActionClass::Read => 0,
        ActionClass::Draft => 2,
        ActionClass::WriteWithConfirmation => 3,
        ActionClass::ApprovedAutomation => 4,
    }
}

fn action_name(action: ActionClass) -> &'static str {
    match action {
        ActionClass::Read => "read",
        ActionClass::Draft => "draft",
        ActionClass::WriteWithConfirmation => "write_with_confirmation",
        ActionClass::ApprovedAutomation => "approved_automation",
    }
}
