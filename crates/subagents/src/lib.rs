use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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

#[derive(Debug, Clone)]
pub struct RuntimeClient {
    base_url: String,
    http: reqwest::blocking::Client,
}

impl RuntimeClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http: reqwest::blocking::Client::new(),
        }
    }

    pub fn endpoint(&self, path: &str) -> String {
        format!("{}/{}", self.base_url, path.trim_start_matches('/'))
    }

    pub fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        let response = self
            .http
            .post(self.endpoint("/generate_json"))
            .json(request)
            .send()
            .map_err(RuntimeClientError::Request)?;

        if !response.status().is_success() {
            return Err(RuntimeClientError::Status(response.status().as_u16()));
        }

        response.json().map_err(RuntimeClientError::Request)
    }
}

#[derive(Debug)]
pub enum RuntimeClientError {
    Request(reqwest::Error),
    Status(u16),
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskNode {
    pub task_id: String,
    pub agent_id: AgentId,
    pub depends_on: Vec<String>,
    pub state: TaskState,
}

impl TaskNode {
    pub fn new(
        task_id: impl Into<String>,
        agent_id: AgentId,
        depends_on: Vec<String>,
    ) -> Self {
        Self {
            task_id: task_id.into(),
            agent_id,
            depends_on,
            state: TaskState::Pending,
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionGraph {
    nodes: BTreeMap<String, TaskNode>,
}

impl ExecutionGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_node(&mut self, node: TaskNode) -> Result<(), String> {
        if self.nodes.contains_key(&node.task_id) {
            return Err(format!("task {} already exists", node.task_id));
        }

        for dependency in &node.depends_on {
            if !self.nodes.contains_key(dependency) {
                return Err(format!(
                    "task {} depends on missing task {}",
                    node.task_id, dependency
                ));
            }
        }

        self.nodes.insert(node.task_id.clone(), node);
        Ok(())
    }

    pub fn set_state(&mut self, task_id: &str, state: TaskState) -> Result<(), String> {
        let node = self
            .nodes
            .get_mut(task_id)
            .ok_or_else(|| format!("task {} does not exist", task_id))?;
        node.state = state;
        Ok(())
    }

    pub fn ready_task_ids(&self) -> Vec<&str> {
        self.nodes
            .values()
            .filter(|node| {
                node.state == TaskState::Pending
                    && node.depends_on.iter().all(|dependency| {
                        self.nodes
                            .get(dependency)
                            .is_some_and(|dependency_node| {
                                dependency_node.state == TaskState::Succeeded
                            })
                    })
            })
            .map(|node| node.task_id.as_str())
            .collect()
    }

    pub fn blocked_task_ids(&self) -> Vec<&str> {
        self.nodes
            .values()
            .filter(|node| {
                node.state == TaskState::Pending
                    && node.depends_on.iter().any(|dependency| {
                        self.nodes
                            .get(dependency)
                            .is_some_and(|dependency_node| {
                                matches!(
                                    dependency_node.state,
                                    TaskState::Failed | TaskState::Cancelled
                                )
                            })
                    })
            })
            .map(|node| node.task_id.as_str())
            .collect()
    }
}
