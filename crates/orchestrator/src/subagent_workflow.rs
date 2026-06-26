use crate::{
    EnqueuedSubagentTaskSummary, OrchestratorError, OrchestratorRequest, OrchestratorResult,
    PlanStep, PlanStepKind, StepExecutionPolicy,
    execution::{task_id_for_step, task_user_id, task_workspace_id},
};
use local_first_capabilities::ActionClass;
use local_first_subagents::{
    AllowedAction, PermissionEnvelope, SubagentTask, TaskBudgets, WorkflowTaskSpec,
};
use local_first_task_runtime::{TaskId, TaskStore, WorkflowId};
use std::collections::{BTreeMap, BTreeSet};

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
                },
                "language": request.language,
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

/// Single-threaded writes (ADR 0018 Pilastro 3; Cognition "Multi-Agents: What's
/// Actually Working"; caposaldo #1). A subagent limited to Read/Draft produces a
/// PROPOSAL with no external side-effect → safe to fan out in parallel with
/// siblings (intelligence gathering). One that can execute an external write
/// (`WriteWithConfirmation` / `ApprovedAutomation`) makes a world-state decision →
/// it must be single-threaded. NB: Draft is intentionally parallel-safe — the
/// canonical `Planner→Risk→Memory‖Tool→Review` workflow fans out Draft proposals
/// that ReviewAgent reconciles before any execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubagentWriteMode {
    ReadGather,
    WriteDecide,
}

pub(crate) fn subagent_write_mode(actions: &[AllowedAction]) -> SubagentWriteMode {
    let writes = actions.iter().any(|action| {
        matches!(
            action,
            AllowedAction::WriteWithConfirmation | AllowedAction::ApprovedAutomation
        )
    });
    if writes {
        SubagentWriteMode::WriteDecide
    } else {
        SubagentWriteMode::ReadGather
    }
}

/// Enforce single-threaded writes across a plan's subagent steps: no two
/// `WriteDecide` subagent steps may be able to run in parallel — one must
/// transitively depend on the other. `ReadGather` steps fan out freely. Relies on
/// the plan being acyclic with deps pointing to earlier steps (already validated
/// by `validate_plan`). Pure so it is unit-tested.
pub(crate) fn validate_single_threaded_writes(steps: &[PlanStep]) -> OrchestratorResult<()> {
    let writers: Vec<&PlanStep> = steps
        .iter()
        .filter(|step| {
            step.kind == PlanStepKind::SubagentTask
                && subagent_write_mode(&step.allowed_actions) == SubagentWriteMode::WriteDecide
        })
        .collect();
    if writers.len() < 2 {
        return Ok(());
    }
    let closure = transitive_dependencies(steps);
    for (index, first) in writers.iter().enumerate() {
        for second in &writers[index + 1..] {
            let first_after_second = closure
                .get(&first.step_id)
                .is_some_and(|deps| deps.contains(&second.step_id));
            let second_after_first = closure
                .get(&second.step_id)
                .is_some_and(|deps| deps.contains(&first.step_id));
            if !first_after_second && !second_after_first {
                return Err(OrchestratorError::Planner(format!(
                    "parallel_subagent_writes:{}:{}",
                    first.step_id, second.step_id
                )));
            }
        }
    }
    Ok(())
}

/// `step_id` → the set of all step_ids it transitively depends on. A single
/// forward pass suffices because deps point to earlier steps (validated upstream).
fn transitive_dependencies(steps: &[PlanStep]) -> BTreeMap<String, BTreeSet<String>> {
    let mut closure: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for step in steps {
        let mut deps: BTreeSet<String> = BTreeSet::new();
        for direct in &step.depends_on {
            deps.insert(direct.clone());
            if let Some(inherited) = closure.get(direct) {
                deps.extend(inherited.iter().cloned());
            }
        }
        closure.insert(step.step_id.clone(), deps);
    }
    closure
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
    use super::*;

    fn subagent_step(id: &str, deps: &[&str], actions: &[&str]) -> PlanStep {
        serde_json::from_value(serde_json::json!({
            "step_id": id,
            "kind": "subagent_task",
            "depends_on": deps,
            "execution_policy": "durable_task",
            "risk_level": "low",
            "expected_duration_seconds": 10,
            "agent_id": "ToolAgent",
            "goal": "g",
            "contract": "c",
            "allowed_actions": actions,
        }))
        .expect("valid plan step")
    }

    #[test]
    fn write_mode_classifies_only_external_writes_as_decide() {
        assert_eq!(
            subagent_write_mode(&[AllowedAction::Read, AllowedAction::Draft]),
            SubagentWriteMode::ReadGather
        );
        assert_eq!(subagent_write_mode(&[]), SubagentWriteMode::ReadGather);
        assert_eq!(
            subagent_write_mode(&[AllowedAction::WriteWithConfirmation]),
            SubagentWriteMode::WriteDecide
        );
        assert_eq!(
            subagent_write_mode(&[AllowedAction::ApprovedAutomation]),
            SubagentWriteMode::WriteDecide
        );
    }

    #[test]
    fn read_draft_gatherers_may_fan_out() {
        // The canonical Memory‖Tool fan-out: Draft proposals in parallel are fine.
        let steps = vec![
            subagent_step("s1", &[], &["read", "draft"]),
            subagent_step("s2", &[], &["read", "draft"]),
        ];
        assert!(validate_single_threaded_writes(&steps).is_ok());
    }

    #[test]
    fn parallel_external_writers_are_rejected() {
        let steps = vec![
            subagent_step("w1", &[], &["write_with_confirmation"]),
            subagent_step("w2", &[], &["approved_automation"]),
        ];
        let err = validate_single_threaded_writes(&steps).unwrap_err();
        assert!(format!("{err:?}").contains("parallel_subagent_writes"));
    }

    #[test]
    fn directly_serialized_writers_are_allowed() {
        let steps = vec![
            subagent_step("w1", &[], &["write_with_confirmation"]),
            subagent_step("w2", &["w1"], &["write_with_confirmation"]),
        ];
        assert!(validate_single_threaded_writes(&steps).is_ok());
    }

    #[test]
    fn transitively_serialized_writers_are_allowed() {
        // w3 → w2 → w1: w3 transitively depends on w1, so they never run together.
        let steps = vec![
            subagent_step("w1", &[], &["write_with_confirmation"]),
            subagent_step("w2", &["w1"], &["read"]),
            subagent_step("w3", &["w2"], &["write_with_confirmation"]),
        ];
        assert!(validate_single_threaded_writes(&steps).is_ok());
    }

    #[test]
    fn one_writer_among_gatherers_is_fine() {
        let steps = vec![
            subagent_step("g1", &[], &["read"]),
            subagent_step("g2", &[], &["read", "draft"]),
            subagent_step("w1", &[], &["write_with_confirmation"]),
        ];
        assert!(validate_single_threaded_writes(&steps).is_ok());
    }
}
