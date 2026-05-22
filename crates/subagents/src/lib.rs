use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum AgentId {
    Planner,
    Memory,
    Tool,
    Vision,
    Risk,
    Automation,
    Review,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AllowedAction {
    Read,
    Draft,
    WriteWithConfirmation,
    ApprovedAutomation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionEnvelope {
    pub connectors: Vec<String>,
    pub max_autonomy_level: u8,
    pub allowed_actions: Vec<AllowedAction>,
    pub requires_user_approval: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskBudgets {
    pub timeout_seconds: u64,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubagentTask {
    pub task_id: String,
    pub parent_task_id: Option<String>,
    pub agent_id: AgentId,
    pub goal: String,
    pub input: serde_json::Value,
    pub contract: String,
    pub permission_envelope: PermissionEnvelope,
    pub budgets: TaskBudgets,
}

pub fn default_registry() -> Vec<AgentId> {
    vec![
        AgentId::Planner,
        AgentId::Memory,
        AgentId::Tool,
        AgentId::Vision,
        AgentId::Risk,
        AgentId::Automation,
        AgentId::Review,
    ]
}

pub fn validate_task_permissions(task: &SubagentTask) -> Vec<String> {
    let mut errors = Vec::new();
    for action in &task.permission_envelope.allowed_actions {
        let required_level = required_autonomy_level(action);
        if task.permission_envelope.max_autonomy_level < required_level {
            errors.push(format!(
                "action {} requires autonomy level {}, task allows {}",
                action.as_str(),
                required_level,
                task.permission_envelope.max_autonomy_level
            ));
        }
    }
    errors
}

pub fn required_autonomy_level(action: &AllowedAction) -> u8 {
    match action {
        AllowedAction::Read => 0,
        AllowedAction::Draft => 2,
        AllowedAction::WriteWithConfirmation => 3,
        AllowedAction::ApprovedAutomation => 4,
    }
}

impl AllowedAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            AllowedAction::Read => "read",
            AllowedAction::Draft => "draft",
            AllowedAction::WriteWithConfirmation => "write_with_confirmation",
            AllowedAction::ApprovedAutomation => "approved_automation",
        }
    }
}
