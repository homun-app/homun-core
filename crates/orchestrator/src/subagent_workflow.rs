use crate::{
    EnqueuedSubagentTaskSummary, OrchestratorError, OrchestratorRequest, OrchestratorResult,
    PlanStep, StepExecutionPolicy,
    execution::{task_id_for_step, task_user_id, task_workspace_id},
};
use local_first_capabilities::ActionClass;
use local_first_subagents::{
    AllowedAction, PermissionEnvelope, SubagentTask, TaskBudgets, WorkflowTaskSpec,
};
use local_first_task_runtime::{TaskId, TaskStore, WorkflowId};
use std::collections::BTreeMap;

pub(crate) fn workflow_id_for_request(request_id: &str) -> WorkflowId {
    WorkflowId::new(format!("orchestrator_{}", sanitize_id(request_id)))
}

pub(crate) fn subagent_workflow_spec(
    request: &OrchestratorRequest,
    step: &PlanStep,
    durable_step_task_ids: &BTreeMap<String, String>,
) -> OrchestratorResult<WorkflowTaskSpec> {
    let agent_id = step.agent_id.clone().ok_or_else(|| {
        OrchestratorError::Planner(format!("subagent_step_missing_agent:{}", step.step_id))
    })?;
    let goal = step.goal.clone().ok_or_else(|| {
        OrchestratorError::Planner(format!("subagent_step_missing_goal:{}", step.step_id))
    })?;
    let contract = step.contract.clone().ok_or_else(|| {
        OrchestratorError::Planner(format!("subagent_step_missing_contract:{}", step.step_id))
    })?;
    let allowed_actions = allowed_actions_for_step(request, step)?;
    let task_id = task_id_for_step(&request.request_id, &step.step_id);
    Ok(WorkflowTaskSpec {
        task: SubagentTask {
            task_id: task_id.clone(),
            parent_task_id: Some(request.request_id.clone()),
            agent_id,
            goal,
            input: serde_json::json!({
                "orchestrator": {
                    "request_id": request.request_id,
                    "step_id": step.step_id,
                    "conversation_summary": request.conversation_summary,
                    "user_message": request.user_message,
                    "attachments": request.attachments,
                    "arguments": step.arguments,
                }
            }),
            contract,
            permission_envelope: PermissionEnvelope {
                connectors: request
                    .policy_context
                    .enabled_providers
                    .iter()
                    .map(|provider| provider.as_str().to_string())
                    .collect(),
                max_autonomy_level: request.policy_context.max_autonomy_level,
                allowed_actions,
                requires_user_approval: step.requires_user_approval.unwrap_or_else(|| {
                    step.execution_policy == StepExecutionPolicy::AskApproval
                        || !step.risk_level.eq_ignore_ascii_case("low")
                }),
            },
            budgets: TaskBudgets {
                timeout_seconds: step.timeout_seconds.unwrap_or(60),
                max_tokens: step
                    .max_tokens
                    .unwrap_or(request.budgets.max_planner_tokens),
            },
        },
        depends_on: step
            .depends_on
            .iter()
            .filter_map(|dependency| durable_step_task_ids.get(dependency).cloned())
            .collect(),
    })
}

pub(crate) fn enqueue_subagent_spec(
    bridge: &local_first_subagents::SubagentTaskRuntimeBridge,
    store: &TaskStore,
    request: &OrchestratorRequest,
    step: &PlanStep,
    spec: WorkflowTaskSpec,
) -> OrchestratorResult<EnqueuedSubagentTaskSummary> {
    let workflow_id = workflow_id_for_request(&request.request_id);
    let user_id = task_user_id(&request.policy_context);
    let workspace_id = task_workspace_id(&request.policy_context);
    let task_id = TaskId::new(spec.task.task_id.clone());
    let agent_id = spec.task.agent_id.clone();
    let contract = spec.task.contract.clone();
    bridge.enqueue_workflow(store, &user_id, &workspace_id, &workflow_id, &[spec])?;
    Ok(EnqueuedSubagentTaskSummary {
        step_id: step.step_id.clone(),
        task_id,
        agent_id,
        contract,
    })
}

fn allowed_actions_for_step(
    request: &OrchestratorRequest,
    step: &PlanStep,
) -> OrchestratorResult<Vec<AllowedAction>> {
    let requested = if step.allowed_actions.is_empty() {
        default_subagent_actions(&request.policy_context.allowed_actions)
    } else {
        step.allowed_actions.clone()
    };
    if requested.is_empty() {
        return Err(OrchestratorError::Planner(format!(
            "subagent_step_no_allowed_actions:{}",
            step.step_id
        )));
    }
    for action in &requested {
        if !policy_allows_subagent_action(&request.policy_context.allowed_actions, action) {
            return Err(OrchestratorError::Planner(format!(
                "subagent_action_not_allowed:{}:{:?}",
                step.step_id, action
            )));
        }
    }
    Ok(requested)
}

fn default_subagent_actions(policy_actions: &[ActionClass]) -> Vec<AllowedAction> {
    let mut actions = Vec::new();
    if policy_actions.contains(&ActionClass::Read) {
        actions.push(AllowedAction::Read);
    }
    if policy_actions.contains(&ActionClass::Draft) {
        actions.push(AllowedAction::Draft);
    }
    actions
}

fn policy_allows_subagent_action(policy_actions: &[ActionClass], action: &AllowedAction) -> bool {
    match action {
        AllowedAction::Read => policy_actions.contains(&ActionClass::Read),
        AllowedAction::Draft => policy_actions.contains(&ActionClass::Draft),
        AllowedAction::WriteWithConfirmation => {
            policy_actions.contains(&ActionClass::WriteWithConfirmation)
        }
        AllowedAction::ApprovedAutomation => {
            policy_actions.contains(&ActionClass::ApprovedAutomation)
        }
    }
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
