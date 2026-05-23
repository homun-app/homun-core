use crate::{AgentDefinition, AllowedAction, SubagentTask, ToolScope, required_autonomy_level};
use local_first_capabilities::{
    ActionClass, CapabilityPolicy, CapabilityTool, PolicyContext, ProviderId, ToolAccessPlan,
    UserId, WorkspaceId,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityBridgeOptions {
    pub privacy_domains: Vec<String>,
    pub allow_managed_cloud: bool,
}

pub fn capability_policy_context_for_task(
    task: &SubagentTask,
    user_id: UserId,
    workspace_id: WorkspaceId,
    options: CapabilityBridgeOptions,
) -> PolicyContext {
    PolicyContext {
        user_id,
        workspace_id,
        enabled_providers: task
            .permission_envelope
            .connectors
            .iter()
            .map(ProviderId::new)
            .collect(),
        privacy_domains: options.privacy_domains,
        allowed_actions: task
            .permission_envelope
            .allowed_actions
            .iter()
            .cloned()
            .map(action_class_from_allowed_action)
            .collect(),
        max_autonomy_level: task.permission_envelope.max_autonomy_level,
        allow_managed_cloud: options.allow_managed_cloud,
    }
}

pub fn plan_capability_access(
    agent: &AgentDefinition,
    task: &SubagentTask,
    tools: &[CapabilityTool],
    user_id: UserId,
    workspace_id: WorkspaceId,
    options: CapabilityBridgeOptions,
) -> ToolAccessPlan {
    let context = capability_policy_context_for_task(task, user_id, workspace_id, options);
    let policy = CapabilityPolicy::new();
    let mut visible_tools = Vec::new();
    let mut executable_tools = Vec::new();

    for tool in tools {
        if !tool_is_visible(agent, tool.action) {
            continue;
        }

        let decision = policy.tool_access(&context, tool);
        if decision.model_visible {
            visible_tools.push(tool.clone());
        }
        if decision.executable && tool_is_executable(agent, tool.action) {
            executable_tools.push(tool.clone());
        }
    }

    visible_tools.sort_by(|left, right| left.name.cmp(&right.name));
    executable_tools.sort_by(|left, right| left.name.cmp(&right.name));

    ToolAccessPlan {
        visible_tools,
        executable_tools,
    }
}

fn action_class_from_allowed_action(action: AllowedAction) -> ActionClass {
    match action {
        AllowedAction::Read => ActionClass::Read,
        AllowedAction::Draft => ActionClass::Draft,
        AllowedAction::WriteWithConfirmation => ActionClass::WriteWithConfirmation,
        AllowedAction::ApprovedAutomation => ActionClass::ApprovedAutomation,
    }
}

fn tool_is_visible(agent: &AgentDefinition, action: ActionClass) -> bool {
    match agent.tool_scope {
        ToolScope::None => false,
        ToolScope::ReadOnly => matches!(action, ActionClass::Read),
        ToolScope::DraftOnly => matches!(
            action,
            ActionClass::Read | ActionClass::Draft | ActionClass::WriteWithConfirmation
        ),
        ToolScope::WriteWithConfirmation => matches!(
            action,
            ActionClass::Read | ActionClass::Draft | ActionClass::WriteWithConfirmation
        ),
    }
}

fn tool_is_executable(agent: &AgentDefinition, action: ActionClass) -> bool {
    match agent.tool_scope {
        ToolScope::None => false,
        ToolScope::ReadOnly => matches!(action, ActionClass::Read),
        ToolScope::DraftOnly => matches!(action, ActionClass::Read | ActionClass::Draft),
        ToolScope::WriteWithConfirmation => matches!(
            action,
            ActionClass::Read | ActionClass::Draft | ActionClass::WriteWithConfirmation
        ),
    }
}

#[allow(dead_code)]
fn required_autonomy_level_for_capability(action: ActionClass) -> u8 {
    match action {
        ActionClass::Read => required_autonomy_level(&AllowedAction::Read),
        ActionClass::Draft => required_autonomy_level(&AllowedAction::Draft),
        ActionClass::WriteWithConfirmation => {
            required_autonomy_level(&AllowedAction::WriteWithConfirmation)
        }
        ActionClass::ApprovedAutomation => {
            required_autonomy_level(&AllowedAction::ApprovedAutomation)
        }
    }
}
