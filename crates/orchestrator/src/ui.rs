use crate::{
    ContextBudgetUsage, OrchestratorAuditStore, OrchestratorResult, OrchestratorRoute,
    StepExecutionPolicy,
};
use local_first_capabilities::{ActionClass, CapabilityProviderKind, ProviderId};
use local_first_subagents::{AgentId, TokenMetrics};
use local_first_task_runtime::{TaskId, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};

pub struct OrchestratorUiReadModel<'a> {
    audit_store: &'a OrchestratorAuditStore,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrchestratorRunSummary {
    pub request_id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub route: String,
    pub status: String,
    pub planner_rounds: usize,
    pub loaded_tool_count: usize,
    pub immediate_execution_count: usize,
    pub enqueued_task_count: usize,
    pub subagent_task_count: usize,
    pub blocked_reason: Option<String>,
    pub created_at_unix: i64,
    pub finished_at_unix: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrchestratorRunDetail {
    pub summary: OrchestratorRunSummary,
    pub plan: UiExecutionPlan,
    pub loaded_tools: Vec<UiToolCard>,
    pub memory_refs: Vec<String>,
    pub immediate_results: Vec<UiImmediateResult>,
    pub enqueued_tasks: Vec<UiEnqueuedTask>,
    pub subagent_tasks: Vec<UiSubagentTask>,
    pub metrics: TokenMetrics,
    pub context_budget: Vec<ContextBudgetUsage>,
    pub error_message: Option<String>,
    pub exposes_raw_input: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiExecutionPlan {
    pub route: String,
    pub direct_answer: Option<UiDirectAnswerSummary>,
    pub steps: Vec<UiPlanStep>,
    pub needs_more_tools_query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiDirectAnswerSummary {
    pub answer_present: bool,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiPlanStep {
    pub step_id: String,
    pub kind: String,
    pub depends_on: Vec<String>,
    pub provider_id: Option<String>,
    pub tool_name: Option<String>,
    pub agent_id: Option<AgentId>,
    pub contract: Option<String>,
    pub execution_policy: StepExecutionPolicy,
    pub risk_level: String,
    pub expected_duration_seconds: u64,
    pub argument_keys: Vec<String>,
    pub has_goal: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiToolCard {
    pub provider_id: ProviderId,
    pub provider_kind: CapabilityProviderKind,
    pub tool_name: String,
    pub action: ActionClass,
    pub description: String,
    pub privacy_domains: Vec<String>,
    pub sensitivity: String,
    pub schema_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiImmediateResult {
    pub provider_id: ProviderId,
    pub tool_name: String,
    pub output_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiEnqueuedTask {
    pub step_id: String,
    pub task_id: TaskId,
    pub provider_id: ProviderId,
    pub tool_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiSubagentTask {
    pub step_id: String,
    pub task_id: TaskId,
    pub agent_id: AgentId,
    pub contract: String,
}

impl<'a> OrchestratorUiReadModel<'a> {
    pub fn new(audit_store: &'a OrchestratorAuditStore) -> Self {
        Self { audit_store }
    }

    pub fn run_detail(
        &self,
        request_id: &str,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> OrchestratorResult<Option<OrchestratorRunDetail>> {
        self.audit_store
            .run_detail(request_id, user_id, workspace_id)
    }

    pub fn recent_runs(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        limit: u32,
    ) -> OrchestratorResult<Vec<OrchestratorRunSummary>> {
        self.audit_store.recent_runs(user_id, workspace_id, limit)
    }
}

pub(crate) fn route_label(route: OrchestratorRoute) -> &'static str {
    match route {
        OrchestratorRoute::DirectAnswer => "direct_answer",
        OrchestratorRoute::MemoryLookup => "memory_lookup",
        OrchestratorRoute::CapabilityCall => "capability_call",
        OrchestratorRoute::SubagentWorkflow => "subagent_workflow",
        OrchestratorRoute::MixedWorkflow => "mixed_workflow",
        OrchestratorRoute::AskClarification => "ask_clarification",
        OrchestratorRoute::Refuse => "refuse",
        OrchestratorRoute::NeedsMoreTools => "needs_more_tools",
    }
}
