use local_first_capabilities::{
    CapabilityCallResult, CapabilityProviderKind, CapabilityTool, PolicyContext, ProviderId,
};
use local_first_subagents::{AgentId, AllowedAction, TokenMetrics};
use local_first_task_runtime::TaskId;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrchestratorRequest {
    pub request_id: String,
    pub policy_context: PolicyContext,
    pub user_message: String,
    pub conversation_summary: Option<String>,
    pub attachments: Vec<serde_json::Value>,
    pub budgets: OrchestratorBudgets,
    /// User-defined specialized agents the planner may delegate sub-tasks to
    /// (Phase 3b). Empty = the planner uses only built-in worker archetypes.
    #[serde(default)]
    pub available_agents: Vec<AgentProfile>,
}

/// A specialized agent exposed to the planner so it can delegate a sub-task to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrchestratorBudgets {
    pub max_loaded_tools: usize,
    pub max_tool_search_rounds: usize,
    pub max_steps: usize,
    pub max_planner_tokens: u32,
    #[serde(default = "default_max_conversation_summary_chars")]
    pub max_conversation_summary_chars: usize,
    #[serde(default = "default_max_memory_context_chars")]
    pub max_memory_context_chars: usize,
    #[serde(default = "default_max_tool_cards_context_chars")]
    pub max_tool_cards_context_chars: usize,
    #[serde(default = "default_max_loaded_tool_context_chars")]
    pub max_loaded_tool_context_chars: usize,
    /// Per-call timeout (seconds) for the planner LLM request. Generous by
    /// default because capable cloud models on a large planner prompt take well
    /// over 30s. `u64` keeps the struct's `Eq` derive valid.
    #[serde(default = "default_planner_timeout_seconds")]
    pub planner_timeout_seconds: u64,
}

impl Default for OrchestratorBudgets {
    fn default() -> Self {
        Self {
            max_loaded_tools: 5,
            max_tool_search_rounds: 1,
            max_steps: 8,
            max_planner_tokens: 768,
            max_conversation_summary_chars: default_max_conversation_summary_chars(),
            max_memory_context_chars: default_max_memory_context_chars(),
            max_tool_cards_context_chars: default_max_tool_cards_context_chars(),
            max_loaded_tool_context_chars: default_max_loaded_tool_context_chars(),
            planner_timeout_seconds: default_planner_timeout_seconds(),
        }
    }
}

fn default_planner_timeout_seconds() -> u64 {
    120
}

fn default_max_conversation_summary_chars() -> usize {
    1_200
}

fn default_max_memory_context_chars() -> usize {
    2_000
}

fn default_max_tool_cards_context_chars() -> usize {
    2_400
}

fn default_max_loaded_tool_context_chars() -> usize {
    3_200
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrchestratorOutcome {
    pub plan: ExecutionPlan,
    pub direct_answer: Option<DirectAnswer>,
    pub loaded_tools: Vec<ToolCard>,
    pub memory_refs: Vec<String>,
    pub immediate_results: Vec<CapabilityCallResult>,
    pub enqueued_tasks: Vec<EnqueuedTaskSummary>,
    pub enqueued_subagent_tasks: Vec<EnqueuedSubagentTaskSummary>,
    pub blocked_reason: Option<String>,
    pub metrics: TokenMetrics,
    pub audit: OrchestratorAudit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrchestratorAudit {
    pub request_id: String,
    pub loaded_tool_count: usize,
    pub immediate_execution_count: usize,
    pub enqueued_task_count: usize,
    pub subagent_task_count: usize,
    pub planner_rounds: usize,
    pub context_budget: Vec<ContextBudgetUsage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextBudgetUsage {
    pub label: String,
    pub kind: String,
    pub compressed: bool,
    pub redacted: bool,
    pub input_chars: usize,
    pub output_chars: usize,
    pub estimated_input_tokens: usize,
    pub estimated_output_tokens: usize,
    pub compression_ratio: f64,
    pub redaction_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExecutionPlan {
    pub route: OrchestratorRoute,
    #[serde(default)]
    pub direct_answer: Option<DirectAnswer>,
    #[serde(default)]
    pub steps: Vec<PlanStep>,
    #[serde(default)]
    pub needs_more_tools: Option<ToolSearchRequest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrchestratorRoute {
    DirectAnswer,
    MemoryLookup,
    CapabilityCall,
    SubagentWorkflow,
    MixedWorkflow,
    AskClarification,
    Refuse,
    NeedsMoreTools,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DirectAnswer {
    pub answer: String,
    pub reason: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSearchRequest {
    pub query: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanStep {
    pub step_id: String,
    pub kind: PlanStepKind,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub arguments: serde_json::Value,
    pub execution_policy: StepExecutionPolicy,
    pub risk_level: String,
    pub expected_duration_seconds: u64,
    #[serde(default)]
    pub agent_id: Option<AgentId>,
    /// Optional user-defined agent (Phase 3b): when the planner picks one of the
    /// `available_agents`, its id lands here and drives the worker's model+persona.
    #[serde(default)]
    pub assigned_agent: Option<String>,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub contract: Option<String>,
    #[serde(default)]
    pub allowed_actions: Vec<AllowedAction>,
    #[serde(default)]
    pub requires_user_approval: Option<bool>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepKind {
    CapabilityCall,
    MemoryLookup,
    SubagentTask,
    DirectAnswer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepExecutionPolicy {
    Immediate,
    DurableTask,
    AskApproval,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCard {
    pub provider_id: ProviderId,
    pub provider_kind: CapabilityProviderKind,
    pub tool_name: String,
    pub action: local_first_capabilities::ActionClass,
    pub description: String,
    pub privacy_domains: Vec<String>,
    pub sensitivity: String,
    pub schema_hash: String,
}

impl ToolCard {
    pub fn from_tool(tool: &CapabilityTool) -> Self {
        Self {
            provider_id: tool.provider_id.clone(),
            provider_kind: tool.provider_kind,
            tool_name: tool.name.clone(),
            action: tool.action,
            description: tool.description.clone(),
            privacy_domains: tool.privacy_domains.clone(),
            sensitivity: tool.sensitivity.clone(),
            schema_hash: schema_hash(&tool.input_schema),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnqueuedTaskSummary {
    pub step_id: String,
    pub task_id: TaskId,
    pub provider_id: ProviderId,
    pub tool_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EnqueuedSubagentTaskSummary {
    pub step_id: String,
    pub task_id: TaskId,
    pub agent_id: AgentId,
    pub contract: String,
}

fn schema_hash(schema: &serde_json::Value) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    schema.to_string().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}
