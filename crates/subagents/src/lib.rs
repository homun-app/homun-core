use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

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

pub trait JsonRuntime {
    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError>;
}

impl JsonRuntime for RuntimeClient {
    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        RuntimeClient::generate_json(self, request)
    }
}

#[derive(Debug, Clone)]
pub struct SubagentRunner<R> {
    runtime: R,
    model: String,
}

impl<R: JsonRuntime> SubagentRunner<R> {
    pub fn new(runtime: R, model: impl Into<String>) -> Self {
        Self {
            runtime,
            model: model.into(),
        }
    }

    pub fn runtime(&self) -> &R {
        &self.runtime
    }

    pub fn run_generate_json(&self, task: &SubagentTask) -> SubagentResult {
        let started_at = audit_timestamp();
        let permission_errors = validate_task_permissions(task);
        if !permission_errors.is_empty() {
            return self.failed_result(task, permission_errors, started_at);
        }

        let request = generate_json_request_from_task(task);
        match self.runtime.generate_json(&request) {
            Ok(response) if response.valid => SubagentResult {
                task_id: task.task_id.clone(),
                agent_id: task.agent_id.clone(),
                status: SubagentStatus::Succeeded,
                output: response.json,
                errors: vec![],
                metrics: response.metrics,
                audit: AgentAudit {
                    model: self.model.clone(),
                    contract: task.contract.clone(),
                    started_at,
                    finished_at: audit_timestamp(),
                },
            },
            Ok(response) => SubagentResult {
                task_id: task.task_id.clone(),
                agent_id: task.agent_id.clone(),
                status: SubagentStatus::Failed,
                output: response.json,
                errors: response.errors,
                metrics: response.metrics,
                audit: AgentAudit {
                    model: self.model.clone(),
                    contract: task.contract.clone(),
                    started_at,
                    finished_at: audit_timestamp(),
                },
            },
            Err(error) => self.failed_result(task, vec![format!("{error:?}")], started_at),
        }
    }

    fn failed_result(
        &self,
        task: &SubagentTask,
        errors: Vec<String>,
        started_at: String,
    ) -> SubagentResult {
        SubagentResult {
            task_id: task.task_id.clone(),
            agent_id: task.agent_id.clone(),
            status: SubagentStatus::Failed,
            output: serde_json::Value::Null,
            errors,
            metrics: TokenMetrics::zero(),
            audit: AgentAudit {
                model: self.model.clone(),
                contract: task.contract.clone(),
                started_at,
                finished_at: audit_timestamp(),
            },
        }
    }
}

#[derive(Debug)]
pub enum RuntimeClientError {
    Request(reqwest::Error),
    Status(u16),
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

pub fn generate_json_request_from_task(task: &SubagentTask) -> GenerateJsonRequest {
    GenerateJsonRequest {
        prompt: task
            .input
            .get("prompt")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&task.goal)
            .to_string(),
        max_tokens: task.budgets.max_tokens,
        temperature: task
            .input
            .get("temperature")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0) as f32,
        json_schema: task.input.get("schema").cloned(),
        required_keys: task
            .input
            .get("required_keys")
            .and_then(serde_json::Value::as_array)
            .map(|keys| {
                keys.iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        repair: task
            .input
            .get("repair")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
    }
}

fn audit_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    format!("unix:{seconds}")
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

    pub fn state(&self, task_id: &str) -> Option<&TaskState> {
        self.nodes.get(task_id).map(|node| &node.state)
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

#[derive(Debug, Clone)]
pub struct SubagentOrchestrator<R> {
    runner: SubagentRunner<R>,
    graph: ExecutionGraph,
    tasks: BTreeMap<String, SubagentTask>,
}

impl<R: JsonRuntime> SubagentOrchestrator<R> {
    pub fn new(runner: SubagentRunner<R>) -> Self {
        Self {
            runner,
            graph: ExecutionGraph::new(),
            tasks: BTreeMap::new(),
        }
    }

    pub fn add_task(
        &mut self,
        task: SubagentTask,
        depends_on: Vec<String>,
    ) -> Result<(), String> {
        let node = TaskNode::new(task.task_id.clone(), task.agent_id.clone(), depends_on);
        self.graph.add_node(node)?;
        self.tasks.insert(task.task_id.clone(), task);
        Ok(())
    }

    pub fn add_workflow(&mut self, specs: Vec<WorkflowTaskSpec>) -> Result<(), String> {
        for spec in specs {
            self.add_task(spec.task, spec.depends_on)?;
        }
        Ok(())
    }

    pub fn run_ready_once(&mut self) -> Vec<SubagentResult> {
        let ready_task_ids: Vec<String> = self
            .graph
            .ready_task_ids()
            .into_iter()
            .map(ToString::to_string)
            .collect();

        let mut results = Vec::new();
        for task_id in ready_task_ids {
            if self.graph.set_state(&task_id, TaskState::Running).is_err() {
                continue;
            }
            let Some(task) = self.tasks.get(&task_id) else {
                let _ = self.graph.set_state(&task_id, TaskState::Failed);
                continue;
            };

            let result = self.runner.run_generate_json(task);
            let state = match result.status {
                SubagentStatus::Succeeded => TaskState::Succeeded,
                SubagentStatus::Cancelled => TaskState::Cancelled,
                SubagentStatus::Failed | SubagentStatus::TimedOut => TaskState::Failed,
            };
            let _ = self.graph.set_state(&task_id, state);
            results.push(result);
        }

        results
    }

    pub fn run_until_blocked(&mut self) -> Vec<SubagentResult> {
        let mut all_results = Vec::new();
        loop {
            let results = self.run_ready_once();
            if results.is_empty() {
                break;
            }
            all_results.extend(results);
        }
        all_results
    }

    pub fn state(&self, task_id: &str) -> Option<&TaskState> {
        self.graph.state(task_id)
    }

    pub fn blocked_task_ids(&self) -> Vec<&str> {
        self.graph.blocked_task_ids()
    }

    pub fn ready_task_ids(&self) -> Vec<&str> {
        self.graph.ready_task_ids()
    }
}
