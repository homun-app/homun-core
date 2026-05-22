use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AgentId {
    #[serde(rename = "PlannerAgent")]
    Planner,
    #[serde(rename = "MemoryAgent")]
    Memory,
    #[serde(rename = "ToolAgent")]
    Tool,
    #[serde(rename = "VisionAgent")]
    Vision,
    #[serde(rename = "RiskAgent")]
    Risk,
    #[serde(rename = "AutomationAgent")]
    Automation,
    #[serde(rename = "ReviewAgent")]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentStatus {
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenMetrics {
    pub prompt_tokens: u32,
    pub generation_tokens: u32,
    pub prompt_tps: f64,
    pub generation_tps: f64,
    pub peak_memory_gb: f64,
    pub elapsed_seconds: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentAudit {
    pub model: String,
    pub contract: String,
    pub started_at: String,
    pub finished_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubagentResult {
    pub task_id: String,
    pub agent_id: AgentId,
    pub status: SubagentStatus,
    pub output: serde_json::Value,
    pub errors: Vec<String>,
    pub metrics: TokenMetrics,
    pub audit: AgentAudit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    pub severity: FindingSeverity,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubagentReview {
    pub task_id: String,
    pub reviewer_agent_id: AgentId,
    pub approved: bool,
    pub risk_level: RiskLevel,
    pub requires_user_approval: bool,
    pub findings: Vec<Finding>,
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
