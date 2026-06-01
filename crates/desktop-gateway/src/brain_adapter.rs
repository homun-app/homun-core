//! Bridge from the OrchestratorBrain's `ExecutionPlan` to the gateway's
//! `OperationalPlan` (workstream A1, "Adattatore -> OperationalPlan").
//!
//! This is pure type conversion: it lets the Brain become the planner without
//! changing the task-creation / executor / read-model pipeline, which keeps
//! speaking `OperationalPlan`. It is NOT yet wired into the live prompt path —
//! that is the next, isolated step.

use crate::{
    OperationalAutonomy, OperationalIntentType, OperationalPlan, OperationalPlanStep,
    operational_step,
};
use local_first_orchestrator::{
    ExecutionPlan, OrchestratorRoute, PlanStep, PlanStepKind, StepExecutionPolicy,
};

/// Converts a validated `ExecutionPlan` into an `OperationalPlan` for the given
/// user objective.
pub fn execution_plan_to_operational_plan(plan: &ExecutionPlan, objective: &str) -> OperationalPlan {
    let intent_type = intent_for_route(plan.route);
    let needs_any_approval = plan.steps.iter().any(step_needs_approval);
    let autonomy = if needs_any_approval {
        OperationalAutonomy::AskBeforeEachExternalAction
    } else {
        OperationalAutonomy::AutomaticUntilGate
    };

    let steps = operational_steps(plan);
    let tools = distinct(plan.steps.iter().filter_map(|step| step.tool_name.clone()));
    let approval_gates = plan
        .steps
        .iter()
        .filter(|step| step_needs_approval(step))
        .map(|step| {
            format!(
                "{}: {}",
                step.step_id,
                step.tool_name.clone().unwrap_or_else(|| "azione".to_string())
            )
        })
        .collect::<Vec<_>>();
    let stop_conditions = if approval_gates.is_empty() {
        Vec::new()
    } else {
        vec![
            "Fermarsi prima di login, invio, acquisto, pagamento o azioni irreversibili senza approvazione."
                .to_string(),
        ]
    };
    let data_schema = distinct(plan.steps.iter().filter_map(|step| step.contract.clone()));

    OperationalPlan {
        objective: objective.to_string(),
        intent_type,
        autonomy,
        tools,
        steps,
        constraints: route_constraints(plan.route),
        success_criteria: route_success_criteria(plan.route),
        stop_conditions,
        approval_gates,
        data_schema,
    }
}

fn intent_for_route(route: OrchestratorRoute) -> OperationalIntentType {
    match route {
        // Routes that take external/stateful action.
        OrchestratorRoute::CapabilityCall
        | OrchestratorRoute::SubagentWorkflow
        | OrchestratorRoute::MixedWorkflow => OperationalIntentType::Transactional,
        // Pure information / planning / conversational routes.
        OrchestratorRoute::DirectAnswer
        | OrchestratorRoute::MemoryLookup
        | OrchestratorRoute::AskClarification
        | OrchestratorRoute::Refuse
        | OrchestratorRoute::NeedsMoreTools => OperationalIntentType::Informational,
    }
}

fn operational_steps(plan: &ExecutionPlan) -> Vec<OperationalPlanStep> {
    if plan.steps.is_empty() {
        // DirectAnswer / AskClarification plans carry no steps; surface a single
        // informational step so the plan is never empty.
        let detail = plan
            .direct_answer
            .as_ref()
            .map(|answer| answer.reason.clone())
            .unwrap_or_else(|| "Rispondi direttamente senza azioni esterne.".to_string());
        return vec![operational_step(
            "respond",
            "Rispondi direttamente",
            detail,
            None,
        )];
    }

    plan.steps
        .iter()
        .map(|step| {
            operational_step(
                step.step_id.clone(),
                step_title(step),
                step_detail(step),
                step.tool_name.as_deref(),
            )
        })
        .collect()
}

fn step_title(step: &PlanStep) -> String {
    match step.kind {
        PlanStepKind::DirectAnswer => "Rispondi direttamente".to_string(),
        PlanStepKind::MemoryLookup => "Consulta la memoria".to_string(),
        PlanStepKind::CapabilityCall => match &step.tool_name {
            Some(tool) => format!("Esegui {tool}"),
            None => "Esegui capability".to_string(),
        },
        PlanStepKind::SubagentTask => "Esegui subagente".to_string(),
    }
}

fn step_detail(step: &PlanStep) -> String {
    if let Some(goal) = step.goal.as_ref().filter(|goal| !goal.is_empty()) {
        return goal.clone();
    }
    let approval = if step_needs_approval(step) {
        " (richiede approvazione)"
    } else {
        ""
    };
    format!("rischio={}{approval}", step.risk_level)
}

fn step_needs_approval(step: &PlanStep) -> bool {
    step.requires_user_approval == Some(true)
        || step.execution_policy == StepExecutionPolicy::AskApproval
        || matches!(step.risk_level.to_ascii_lowercase().as_str(), "high" | "critical")
}

fn route_constraints(route: OrchestratorRoute) -> Vec<String> {
    match route {
        OrchestratorRoute::CapabilityCall
        | OrchestratorRoute::SubagentWorkflow
        | OrchestratorRoute::MixedWorkflow => vec![
            "Eseguire solo i tool del piano validato; non inventare azioni.".to_string(),
        ],
        _ => Vec::new(),
    }
}

fn route_success_criteria(route: OrchestratorRoute) -> Vec<String> {
    match route {
        OrchestratorRoute::DirectAnswer => {
            vec!["La risposta diretta e' fornita all'utente.".to_string()]
        }
        OrchestratorRoute::CapabilityCall
        | OrchestratorRoute::SubagentWorkflow
        | OrchestratorRoute::MixedWorkflow => {
            vec!["Tutti gli step del piano sono completati con output raccolto.".to_string()]
        }
        _ => Vec::new(),
    }
}

fn distinct(values: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = Vec::new();
    for value in values {
        if !value.is_empty() && !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;
    use local_first_orchestrator::{DirectAnswer, PlanStep};
    use serde_json::json;

    fn capability_step(id: &str, tool: &str, risk: &str, approval: Option<bool>) -> PlanStep {
        PlanStep {
            step_id: id.to_string(),
            kind: PlanStepKind::CapabilityCall,
            depends_on: Vec::new(),
            provider_id: Some("trello".to_string()),
            tool_name: Some(tool.to_string()),
            arguments: json!({}),
            execution_policy: StepExecutionPolicy::DurableTask,
            risk_level: risk.to_string(),
            expected_duration_seconds: 5,
            agent_id: None,
            assigned_agent: None,
            goal: None,
            contract: None,
            allowed_actions: Vec::new(),
            requires_user_approval: approval,
            timeout_seconds: None,
            max_tokens: None,
        }
    }

    #[test]
    fn maps_capability_plan_to_transactional_with_gate() {
        let plan = ExecutionPlan {
            route: OrchestratorRoute::CapabilityCall,
            direct_answer: None,
            steps: vec![
                capability_step("s1", "trello.read_board", "low", None),
                capability_step("s2", "trello.create_card", "high", Some(true)),
            ],
            needs_more_tools: None,
        };
        let operational = execution_plan_to_operational_plan(&plan, "sincronizza Trello");

        assert_eq!(operational.objective, "sincronizza Trello");
        assert_eq!(operational.intent_type, OperationalIntentType::Transactional);
        assert_eq!(
            operational.autonomy,
            OperationalAutonomy::AskBeforeEachExternalAction
        );
        assert_eq!(operational.steps.len(), 2);
        assert!(operational.tools.contains(&"trello.read_board".to_string()));
        assert_eq!(operational.approval_gates.len(), 1);
        assert!(operational.approval_gates[0].contains("trello.create_card"));
        assert!(!operational.stop_conditions.is_empty());
    }

    #[test]
    fn maps_direct_answer_plan_to_single_informational_step() {
        let plan = ExecutionPlan {
            route: OrchestratorRoute::DirectAnswer,
            direct_answer: Some(DirectAnswer {
                answer: "42".to_string(),
                reason: "domanda fattuale".to_string(),
                confidence: 0.9,
            }),
            steps: Vec::new(),
            needs_more_tools: None,
        };
        let operational = execution_plan_to_operational_plan(&plan, "quanto fa 6x7");

        assert_eq!(operational.intent_type, OperationalIntentType::Informational);
        assert_eq!(
            operational.autonomy,
            OperationalAutonomy::AutomaticUntilGate
        );
        assert_eq!(operational.steps.len(), 1);
        assert!(operational.approval_gates.is_empty());
        assert!(operational.stop_conditions.is_empty());
        assert!(!operational.success_criteria.is_empty());
    }

    #[test]
    fn subagent_contract_flows_into_data_schema() {
        let mut step = capability_step("s1", "planner", "medium", None);
        step.kind = PlanStepKind::SubagentTask;
        step.tool_name = None;
        step.contract = Some("RoutineInference".to_string());
        step.goal = Some("inferisci la routine".to_string());
        let plan = ExecutionPlan {
            route: OrchestratorRoute::SubagentWorkflow,
            direct_answer: None,
            steps: vec![step],
            needs_more_tools: None,
        };
        let operational = execution_plan_to_operational_plan(&plan, "impara la routine");

        assert!(operational.data_schema.contains(&"RoutineInference".to_string()));
        assert_eq!(operational.steps[0].detail, "inferisci la routine");
    }
}
