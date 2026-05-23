use crate::{
    AgentId, AllowedAction, PermissionEnvelope, SubagentTask, TaskBudgets, WorkflowTaskSpec,
};

pub fn routine_startup_workflow(input: serde_json::Value) -> Vec<WorkflowTaskSpec> {
    vec![
        WorkflowTaskSpec {
            task: workflow_task(
                "routine.plan",
                AgentId::Planner,
                "Infer startup routine from local events",
                "RoutineInference",
                input.clone(),
                vec![
                    "routine_name",
                    "intent",
                    "confidence",
                    "required_connectors",
                    "missing_connectors",
                    "requires_user_approval",
                ],
            ),
            depends_on: vec![],
        },
        WorkflowTaskSpec {
            task: workflow_task(
                "routine.risk",
                AgentId::Risk,
                "Assess risk and approval needs for the proposed routine",
                "RiskAssessment",
                input.clone(),
                vec!["risk_level", "requires_user_approval"],
            ),
            depends_on: vec!["routine.plan".to_string()],
        },
        WorkflowTaskSpec {
            task: workflow_task(
                "routine.memory",
                AgentId::Memory,
                "Extract durable memory candidates from the event batch",
                "MemoryExtraction",
                input.clone(),
                vec!["memories"],
            ),
            depends_on: vec!["routine.risk".to_string()],
        },
        WorkflowTaskSpec {
            task: workflow_task(
                "routine.tool",
                AgentId::Tool,
                "Prepare tool calls needed by the routine without executing them",
                "ToolPlan",
                input.clone(),
                vec!["tool_calls"],
            ),
            depends_on: vec!["routine.risk".to_string()],
        },
        WorkflowTaskSpec {
            task: workflow_task(
                "routine.review",
                AgentId::Review,
                "Review routine outputs before surfacing an automation proposal",
                "SubagentReview",
                input,
                vec!["approved", "risk_level", "findings"],
            ),
            depends_on: vec!["routine.memory".to_string(), "routine.tool".to_string()],
        },
    ]
}

fn workflow_task(
    task_id: &str,
    agent_id: AgentId,
    goal: &str,
    contract: &str,
    source_input: serde_json::Value,
    required_keys: Vec<&str>,
) -> SubagentTask {
    SubagentTask {
        task_id: task_id.to_string(),
        parent_task_id: None,
        agent_id,
        goal: goal.to_string(),
        input: serde_json::json!({
            "prompt": workflow_prompt(goal, &source_input, &required_keys),
            "source": source_input,
            "required_keys": required_keys,
            "schema": contract_schema(contract),
        }),
        contract: contract.to_string(),
        permission_envelope: PermissionEnvelope {
            connectors: vec![],
            max_autonomy_level: 2,
            allowed_actions: vec![AllowedAction::Read, AllowedAction::Draft],
            requires_user_approval: true,
        },
        budgets: TaskBudgets {
            timeout_seconds: 30,
            max_tokens: 512,
        },
    }
}

fn workflow_prompt(goal: &str, source_input: &serde_json::Value, required_keys: &[&str]) -> String {
    format!(
        "Goal: {goal}\nRespond only with valid JSON. Required keys: {}.\nInput: {}",
        required_keys.join(", "),
        source_input
    )
}

fn contract_schema(contract: &str) -> serde_json::Value {
    match contract {
        "SubagentReview" => serde_json::json!({
            "type": "object",
            "required": ["approved", "risk_level", "findings"],
            "properties": {
                "approved": {"type": "boolean"},
                "risk_level": {
                    "type": "string",
                    "enum": ["low", "medium", "high", "critical", "Low", "Medium", "High", "Critical"]
                },
                "requires_user_approval": {"type": "boolean"},
                "findings": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["severity", "message"],
                        "properties": {
                            "severity": {
                                "type": "string",
                                "enum": ["info", "warning", "error"]
                            },
                            "message": {"type": "string"}
                        }
                    }
                }
            }
        }),
        "RiskAssessment" => serde_json::json!({
            "type": "object",
            "required": ["risk_level", "requires_user_approval"],
            "properties": {
                "risk_level": {
                    "type": "string",
                    "enum": ["low", "medium", "high", "critical", "Low", "Medium", "High", "Critical"]
                },
                "requires_user_approval": {"type": "boolean"}
            }
        }),
        "MemoryExtraction" => serde_json::json!({
            "type": "object",
            "required": ["memories"],
            "properties": {
                "memories": {"type": "array"}
            }
        }),
        "ToolPlan" => serde_json::json!({
            "type": "object",
            "required": ["tool_calls"],
            "properties": {
                "tool_calls": {"type": "array"}
            }
        }),
        _ => serde_json::json!({
            "type": "object"
        }),
    }
}
