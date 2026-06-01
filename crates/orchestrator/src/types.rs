use local_first_capabilities::{
    CapabilityCallResult, CapabilityProviderKind, CapabilityTool, PolicyContext, ProviderId,
};
use local_first_subagents::{AgentId, AllowedAction, TokenMetrics};
use local_first_task_runtime::TaskId;
use serde::{Deserialize, Deserializer, Serialize};

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
#[serde(from = "PlanStepWire")]
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

/// `agent_id` as the planner may emit it: a built-in archetype, or — when the
/// model delegates to a user-defined specialized agent — that agent's free-form
/// id. Untagged: try the known enum first, fall back to a custom string.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum AgentRef {
    Known(AgentId),
    Custom(String),
}

/// Wire form of `PlanStep` used only for deserialization, so an unknown
/// `agent_id` (a custom specialized-agent id) does NOT crash the whole plan but
/// is routed into `assigned_agent` with a generic worker archetype.
#[derive(Deserialize)]
struct PlanStepWire {
    step_id: String,
    kind: PlanStepKind,
    #[serde(default)]
    depends_on: Vec<String>,
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    arguments: serde_json::Value,
    execution_policy: StepExecutionPolicy,
    risk_level: String,
    expected_duration_seconds: u64,
    #[serde(default)]
    agent_id: Option<AgentRef>,
    #[serde(default)]
    assigned_agent: Option<String>,
    #[serde(default)]
    goal: Option<String>,
    #[serde(default)]
    contract: Option<String>,
    #[serde(default, deserialize_with = "lenient_allowed_actions")]
    allowed_actions: Vec<AllowedAction>,
    #[serde(default)]
    requires_user_approval: Option<bool>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
    #[serde(default)]
    max_tokens: Option<u32>,
}

/// Parses `allowed_actions` tolerantly: unknown action strings emitted by the
/// planner LLM (e.g. "analyze") are dropped instead of failing the whole plan.
fn lenient_allowed_actions<'de, D>(deserializer: D) -> Result<Vec<AllowedAction>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Vec::<serde_json::Value>::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .filter_map(|value| serde_json::from_value::<AllowedAction>(value).ok())
        .collect())
}

impl From<PlanStepWire> for PlanStep {
    fn from(wire: PlanStepWire) -> Self {
        let (agent_id, assigned_agent) = match wire.agent_id {
            Some(AgentRef::Known(archetype)) => (Some(archetype), wire.assigned_agent),
            // A custom id in agent_id is the model delegating to a specialized
            // agent: keep a valid archetype for the subagent runner, and surface
            // the custom id so the gateway runs it on that agent's model+persona.
            Some(AgentRef::Custom(custom)) => (
                Some(AgentId::Tool),
                wire.assigned_agent.or(Some(custom)),
            ),
            None => (None, wire.assigned_agent),
        };
        PlanStep {
            step_id: wire.step_id,
            kind: wire.kind,
            depends_on: wire.depends_on,
            provider_id: wire.provider_id,
            tool_name: wire.tool_name,
            arguments: wire.arguments,
            execution_policy: wire.execution_policy,
            risk_level: wire.risk_level,
            expected_duration_seconds: wire.expected_duration_seconds,
            agent_id,
            assigned_agent,
            goal: wire.goal,
            contract: wire.contract,
            allowed_actions: wire.allowed_actions,
            requires_user_approval: wire.requires_user_approval,
            timeout_seconds: wire.timeout_seconds,
            max_tokens: wire.max_tokens,
        }
    }
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

#[cfg(test)]
mod plan_step_tests {
    use super::*;

    #[test]
    fn known_archetype_agent_id_is_preserved() {
        let step: PlanStep = serde_json::from_value(serde_json::json!({
            "step_id": "s1", "kind": "subagent_task", "depends_on": [],
            "execution_policy": "durable_task", "risk_level": "low",
            "expected_duration_seconds": 10,
            "agent_id": "PlannerAgent", "goal": "g", "contract": "c"
        }))
        .unwrap();
        assert_eq!(step.agent_id, Some(AgentId::Planner));
        assert_eq!(step.assigned_agent, None);
    }

    #[test]
    fn custom_agent_id_is_rerouted_to_assigned_agent() {
        // The planner put a user-defined agent id in agent_id (the natural
        // mistake): it must NOT crash the plan; the custom id is surfaced as
        // assigned_agent with a generic worker archetype.
        let step: PlanStep = serde_json::from_value(serde_json::json!({
            "step_id": "s1", "kind": "subagent_task", "depends_on": [],
            "execution_policy": "durable_task", "risk_level": "low",
            "expected_duration_seconds": 10,
            "agent_id": "ricercatore", "goal": "g", "contract": "c"
        }))
        .unwrap();
        assert_eq!(step.agent_id, Some(AgentId::Tool));
        assert_eq!(step.assigned_agent.as_deref(), Some("ricercatore"));
    }

    #[test]
    fn unknown_allowed_actions_are_dropped_not_fatal() {
        let step: PlanStep = serde_json::from_value(serde_json::json!({
            "step_id": "s1", "kind": "subagent_task", "depends_on": [],
            "execution_policy": "durable_task", "risk_level": "low",
            "expected_duration_seconds": 10, "agent_id": "ToolAgent",
            "goal": "g", "contract": "c",
            "allowed_actions": ["read", "analyze", "draft", "frobnicate"]
        }))
        .unwrap();
        assert_eq!(step.allowed_actions, vec![AllowedAction::Read, AllowedAction::Draft]);
    }
}
