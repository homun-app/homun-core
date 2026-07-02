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
        // Weak-tier tolerance (caposaldo #11): only when an EXACT match fails, accept a loaded
        // tool whose name is the leading token of the requested one. A small model sometimes
        // crams the arguments into the tool_name field (observed on gemma4:
        // `tool_name = "browser_navigate.url: https://…"`); the harness must resolve that, not
        // reject a step it can clearly identify. Exact matches always win (checked first).
        .or_else(|| {
            tools.iter().find(|tool| {
                tool.provider_id == provider_id && tool_name_resolves(tool_name, &tool.name)
            })
        })
        .ok_or_else(|| {
            OrchestratorError::Planner(format!(
                "tool_not_loaded:{}:{}",
                provider_id.as_str(),
                tool_name
            ))
        })
}

/// Whether a planner-`requested` tool name resolves to a `loaded` tool name. Exact match, or
/// `requested` is `loaded` followed by a non-identifier boundary — so `browser_navigate.url: …`
/// resolves to `browser_navigate`, but `browser_navigatex` / `browser_navi` do NOT match (no
/// accidental cross-tool resolution).
fn tool_name_resolves(requested: &str, loaded: &str) -> bool {
    if requested == loaded {
        return true;
    }
    requested.strip_prefix(loaded).is_some_and(|rest| {
        rest.chars()
            .next()
            .is_some_and(|next| !next.is_ascii_alphanumeric() && next != '_')
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

#[cfg(test)]
mod tests {
    use super::tool_name_resolves;

    #[test]
    fn tool_name_resolves_exact_and_tolerates_crammed_args() {
        assert!(tool_name_resolves("browser_navigate", "browser_navigate"));
        // Weak model crammed the argument into the tool-name field (observed on gemma4).
        assert!(tool_name_resolves(
            "browser_navigate.url: https://www.trenitalia.com",
            "browser_navigate"
        ));
        assert!(tool_name_resolves("browser_navigate url=x", "browser_navigate"));
        // No accidental cross-tool resolution: a different tool sharing a prefix, or a
        // truncation, must NOT match.
        assert!(!tool_name_resolves("browser_navigatex", "browser_navigate"));
        assert!(!tool_name_resolves("browser_navi", "browser_navigate"));
        assert!(!tool_name_resolves("send_message", "browser_navigate"));
    }
}
