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
#[serde(rename_all = "snake_case")]
pub enum AgentTier {
    Chat,
    Reasoning,
    Worker,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolScope {
    None,
    ReadOnly,
    DraftOnly,
    WriteWithConfirmation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub connector: String,
    pub action: AllowedAction,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolAccessPlan {
    pub visible_tools: Vec<ToolDefinition>,
    pub executable_tools: Vec<ToolDefinition>,
}

impl ToolDefinition {
    pub fn new(
        name: impl Into<String>,
        connector: impl Into<String>,
        action: AllowedAction,
        description: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            connector: connector.into(),
            action,
            description: description.into(),
        }
    }
}

impl ToolAccessPlan {
    pub fn visible_tool_names(&self) -> Vec<&str> {
        self.visible_tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect()
    }

    pub fn executable_tool_names(&self) -> Vec<&str> {
        self.executable_tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskComplexity {
    Simple,
    Moderate,
    Complex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DelegationDecision {
    ReplyDirectly,
    UseDirectTool,
    SpawnInlineSubagent,
    SpawnWorkerThread,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelegationInput {
    pub needs_tool: bool,
    pub needs_specialist: bool,
    pub complexity: TaskComplexity,
    pub estimated_turns: u32,
    pub large_transcript: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub id: String,
    pub display_name: String,
    pub when_to_use: String,
    pub tier: AgentTier,
    pub tool_scope: ToolScope,
    pub subagents: Vec<String>,
    pub max_iterations: u32,
    pub max_result_chars: Option<usize>,
    pub timeout_seconds: Option<u64>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowTaskSpec {
    pub task: SubagentTask,
    pub depends_on: Vec<String>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenerateJsonRequest {
    pub prompt: String,
    pub max_tokens: u32,
    pub temperature: f32,
    #[serde(rename = "schema", skip_serializing_if = "Option::is_none")]
    pub json_schema: Option<serde_json::Value>,
    pub required_keys: Vec<String>,
    pub repair: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenerateJsonResponse {
    pub valid: bool,
    pub errors: Vec<String>,
    pub json: serde_json::Value,
    pub raw_output: String,
    pub repaired: bool,
    pub metrics: TokenMetrics,
}

impl TokenMetrics {
    pub fn zero() -> Self {
        Self {
            prompt_tokens: 0,
            generation_tokens: 0,
            prompt_tps: 0.0,
            generation_tps: 0.0,
            peak_memory_gb: 0.0,
            elapsed_seconds: 0.0,
        }
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
