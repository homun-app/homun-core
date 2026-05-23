use crate::{
    AgentDefinition, AllowedAction, SubagentTask, ToolAccessPlan, ToolDefinition, ToolScope,
    required_autonomy_level,
};

pub fn plan_tool_access(
    agent: &AgentDefinition,
    task: &SubagentTask,
    tools: &[ToolDefinition],
) -> ToolAccessPlan {
    let mut visible_tools = Vec::new();
    let mut executable_tools = Vec::new();

    for tool in tools {
        if !connector_is_allowed(task, &tool.connector) {
            continue;
        }
        if !tool_is_visible(agent, &tool.action) {
            continue;
        }

        visible_tools.push(tool.clone());

        if tool_is_executable(agent, &tool.action) && task_allows_action(task, &tool.action) {
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

fn connector_is_allowed(task: &SubagentTask, connector: &str) -> bool {
    connector.is_empty()
        || task
            .permission_envelope
            .connectors
            .iter()
            .any(|allowed| allowed == connector)
}

fn task_allows_action(task: &SubagentTask, action: &AllowedAction) -> bool {
    task.permission_envelope.allowed_actions.contains(action)
        && task.permission_envelope.max_autonomy_level >= required_autonomy_level(action)
}

fn tool_is_visible(agent: &AgentDefinition, action: &AllowedAction) -> bool {
    match agent.tool_scope {
        ToolScope::None => false,
        ToolScope::ReadOnly => matches!(action, AllowedAction::Read),
        ToolScope::DraftOnly => matches!(
            action,
            AllowedAction::Read | AllowedAction::Draft | AllowedAction::WriteWithConfirmation
        ),
        ToolScope::WriteWithConfirmation => matches!(
            action,
            AllowedAction::Read | AllowedAction::Draft | AllowedAction::WriteWithConfirmation
        ),
    }
}

fn tool_is_executable(agent: &AgentDefinition, action: &AllowedAction) -> bool {
    match agent.tool_scope {
        ToolScope::None => false,
        ToolScope::ReadOnly => matches!(action, AllowedAction::Read),
        ToolScope::DraftOnly => matches!(action, AllowedAction::Read | AllowedAction::Draft),
        ToolScope::WriteWithConfirmation => matches!(
            action,
            AllowedAction::Read | AllowedAction::Draft | AllowedAction::WriteWithConfirmation
        ),
    }
}
