use crate::{OrchestratorError, OrchestratorResult, PlanStep, StepExecutionPolicy};
use local_first_capabilities::{
    ActionClass, CapabilityProviderKind, CapabilityTool, PolicyContext, ProviderId,
};
use local_first_task_runtime::{UserId as TaskUserId, WorkspaceId as TaskWorkspaceId};

pub(crate) fn can_execute_immediately(
    step: &PlanStep,
    tool: &CapabilityTool,
    executable_tools: &[CapabilityTool],
) -> bool {
    if step.execution_policy != StepExecutionPolicy::Immediate {
        return false;
    }
    if step.expected_duration_seconds > 30 {
        return false;
    }
    if !matches!(tool.action, ActionClass::Read | ActionClass::Draft) {
        return false;
    }
    if tool.provider_kind == CapabilityProviderKind::Managed {
        return false;
    }
    if tool.provider_kind == CapabilityProviderKind::Browser
        && !safe_browser_immediate_tool(&tool.name)
    {
        return false;
    }
    executable_tools
        .iter()
        .any(|candidate| same_tool(candidate, tool))
}

pub(crate) fn tool_for_step<'a>(
    step: &PlanStep,
    tools: &'a [CapabilityTool],
) -> OrchestratorResult<&'a CapabilityTool> {
    let provider_id = provider_id_for_step(step)?;
    let tool_name = tool_name_for_step(step)?;
    tools
        .iter()
        .find(|tool| tool.provider_id == provider_id && tool.name == tool_name)
        .ok_or_else(|| {
            OrchestratorError::Planner(format!(
                "tool_not_loaded:{}:{}",
                provider_id.as_str(),
                tool_name
            ))
        })
}

pub(crate) fn provider_id_for_step(step: &PlanStep) -> OrchestratorResult<ProviderId> {
    step.provider_id
        .as_ref()
        .map(ProviderId::new)
        .ok_or_else(|| {
            OrchestratorError::Planner(format!("step_missing_provider:{}", step.step_id))
        })
}

pub(crate) fn tool_name_for_step(step: &PlanStep) -> OrchestratorResult<&str> {
    step.tool_name
        .as_deref()
        .ok_or_else(|| OrchestratorError::Planner(format!("step_missing_tool:{}", step.step_id)))
}

pub(crate) fn task_id_for_step(request_id: &str, step_id: &str) -> String {
    format!(
        "orchestrator_{}_{}",
        sanitize_id(request_id),
        sanitize_id(step_id)
    )
}

pub(crate) fn task_user_id(context: &PolicyContext) -> TaskUserId {
    TaskUserId::new(context.user_id.as_str())
}

pub(crate) fn task_workspace_id(context: &PolicyContext) -> TaskWorkspaceId {
    TaskWorkspaceId::new(context.workspace_id.as_str())
}

fn safe_browser_immediate_tool(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "browser.health"
            | "browser.profiles"
            | "browser.tabs"
            | "browser.snapshot"
            | "browser.console"
    )
}

fn same_tool(left: &CapabilityTool, right: &CapabilityTool) -> bool {
    left.provider_id == right.provider_id && left.name == right.name
}

fn sanitize_id(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect()
}
