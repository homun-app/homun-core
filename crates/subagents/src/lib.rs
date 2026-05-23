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
#[serde(rename_all = "snake_case")]
pub enum PromptGuardVerdict {
    Allow,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptGuardResult {
    pub verdict: PromptGuardVerdict,
    pub reasons: Vec<String>,
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
        let guard = guard_prompt(&request.prompt);
        if guard.verdict == PromptGuardVerdict::Block {
            return self.failed_result(
                task,
                vec![format!(
                    "prompt injection blocked: {}",
                    guard.reasons.join(", ")
                )],
                started_at,
            );
        }
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

pub fn guard_prompt(prompt: &str) -> PromptGuardResult {
    let normalized = normalize_prompt_for_guard(prompt);
    let mut reasons = Vec::new();

    if normalized.contains("ignore previous instructions")
        || normalized.contains("disregard previous instructions")
        || normalized.contains("forget previous instructions")
        || normalized.contains("you are now")
        || normalized.contains("developer mode")
    {
        reasons.push("instruction_override".to_string());
    }
    if normalized.contains("reveal the system prompt")
        || normalized.contains("show the system prompt")
        || normalized.contains("print the system prompt")
        || normalized.contains("developer instructions")
    {
        reasons.push("prompt_exfiltration".to_string());
    }
    if normalized.contains("api key")
        || normalized.contains("access token")
        || normalized.contains("password")
        || normalized.contains("secret")
    {
        reasons.push("secret_exfiltration".to_string());
    }

    PromptGuardResult {
        verdict: if reasons.is_empty() {
            PromptGuardVerdict::Allow
        } else {
            PromptGuardVerdict::Block
        },
        reasons,
    }
}

fn normalize_prompt_for_guard(prompt: &str) -> String {
    prompt
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch.is_ascii_whitespace() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
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

pub fn default_agent_definitions() -> BTreeMap<String, AgentDefinition> {
    [
        AgentDefinition {
            id: "PlannerAgent".to_string(),
            display_name: "Planner".to_string(),
            when_to_use: "Infer routines and build structured plans from local events".to_string(),
            tier: AgentTier::Reasoning,
            tool_scope: ToolScope::ReadOnly,
            subagents: vec![],
            max_iterations: 4,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
        AgentDefinition {
            id: "RiskAgent".to_string(),
            display_name: "Risk".to_string(),
            when_to_use: "Assess risk, reversibility and approval needs".to_string(),
            tier: AgentTier::Worker,
            tool_scope: ToolScope::ReadOnly,
            subagents: vec![],
            max_iterations: 2,
            max_result_chars: Some(2000),
            timeout_seconds: Some(20),
        },
        AgentDefinition {
            id: "MemoryAgent".to_string(),
            display_name: "Memory".to_string(),
            when_to_use: "Extract durable memory candidates and evidence".to_string(),
            tier: AgentTier::Worker,
            tool_scope: ToolScope::ReadOnly,
            subagents: vec![],
            max_iterations: 3,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
        AgentDefinition {
            id: "ToolAgent".to_string(),
            display_name: "Tool".to_string(),
            when_to_use: "Prepare typed tool plans without executing actions".to_string(),
            tier: AgentTier::Worker,
            tool_scope: ToolScope::DraftOnly,
            subagents: vec![],
            max_iterations: 3,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
        AgentDefinition {
            id: "VisionAgent".to_string(),
            display_name: "Vision".to_string(),
            when_to_use: "Analyze local screenshots and images".to_string(),
            tier: AgentTier::Worker,
            tool_scope: ToolScope::ReadOnly,
            subagents: vec![],
            max_iterations: 2,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
        AgentDefinition {
            id: "AutomationAgent".to_string(),
            display_name: "Automation".to_string(),
            when_to_use: "Propose routine automations from reviewed plans".to_string(),
            tier: AgentTier::Worker,
            tool_scope: ToolScope::DraftOnly,
            subagents: vec![],
            max_iterations: 3,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
        AgentDefinition {
            id: "ReviewAgent".to_string(),
            display_name: "Review".to_string(),
            when_to_use: "Review subagent outputs for policy, risk and schema consistency".to_string(),
            tier: AgentTier::Worker,
            tool_scope: ToolScope::ReadOnly,
            subagents: vec![],
            max_iterations: 2,
            max_result_chars: Some(4000),
            timeout_seconds: Some(30),
        },
    ]
    .into_iter()
    .map(|definition| (definition.id.clone(), definition))
    .collect()
}

pub fn validate_agent_definitions(definitions: &[AgentDefinition]) -> Vec<String> {
    let by_id: BTreeMap<&str, &AgentDefinition> = definitions
        .iter()
        .map(|definition| (definition.id.as_str(), definition))
        .collect();
    let mut errors = Vec::new();

    for definition in definitions {
        if definition.id.trim().is_empty() {
            errors.push("agent id must not be empty".to_string());
        }
        if definition.when_to_use.trim().is_empty() {
            errors.push(format!("agent {} must describe when_to_use", definition.id));
        }
        if definition.max_iterations == 0 {
            errors.push(format!("agent {} max_iterations must be > 0", definition.id));
        }
        if definition.tier == AgentTier::Worker && !definition.subagents.is_empty() {
            errors.push(format!(
                "worker agent {} must not list subagents",
                definition.id
            ));
            continue;
        }

        for subagent_id in &definition.subagents {
            let Some(target) = by_id.get(subagent_id.as_str()) else {
                errors.push(format!(
                    "agent {} references missing subagent {}",
                    definition.id, subagent_id
                ));
                continue;
            };
            if definition.tier == AgentTier::Chat && target.tier == AgentTier::Chat {
                errors.push(format!(
                    "chat agent {} must not delegate to chat agent {}",
                    definition.id, target.id
                ));
            }
            if definition.tier == AgentTier::Reasoning && target.tier == AgentTier::Reasoning {
                errors.push(format!(
                    "reasoning agent {} must not delegate to reasoning agent {}",
                    definition.id, target.id
                ));
            }
        }
    }

    errors
}

pub fn plan_tool_access(
    agent: &AgentDefinition,
    task: &SubagentTask,
    tools: &[ToolDefinition],
) -> ToolAccessPlan {
    let mut visible_tools = Vec::new();
    let mut executable_tools = Vec::new();

    for tool in tools {
        if !connector_is_allowed(task, &tool.connector) {
            continue;
        }
        if !tool_is_visible(agent, &tool.action) {
            continue;
        }

        visible_tools.push(tool.clone());

        if tool_is_executable(agent, &tool.action) && task_allows_action(task, &tool.action) {
            executable_tools.push(tool.clone());
        }
    }

    visible_tools.sort_by(|left, right| left.name.cmp(&right.name));
    executable_tools.sort_by(|left, right| left.name.cmp(&right.name));

    ToolAccessPlan {
        visible_tools,
        executable_tools,
    }
}

pub fn decide_delegation(input: &DelegationInput) -> DelegationDecision {
    if !input.needs_tool && !input.needs_specialist {
        return DelegationDecision::ReplyDirectly;
    }
    if input.needs_tool && !input.needs_specialist {
        return DelegationDecision::UseDirectTool;
    }
    if input.large_transcript
        || input.estimated_turns > 5
        || input.complexity == TaskComplexity::Complex
    {
        return DelegationDecision::SpawnWorkerThread;
    }
    DelegationDecision::SpawnInlineSubagent
}

fn connector_is_allowed(task: &SubagentTask, connector: &str) -> bool {
    connector.is_empty()
        || task
            .permission_envelope
            .connectors
            .iter()
            .any(|allowed| allowed == connector)
}

fn task_allows_action(task: &SubagentTask, action: &AllowedAction) -> bool {
    task.permission_envelope.allowed_actions.contains(action)
        && task.permission_envelope.max_autonomy_level >= required_autonomy_level(action)
}

fn tool_is_visible(agent: &AgentDefinition, action: &AllowedAction) -> bool {
    match agent.tool_scope {
        ToolScope::None => false,
        ToolScope::ReadOnly => matches!(action, AllowedAction::Read),
        ToolScope::DraftOnly => matches!(
            action,
            AllowedAction::Read | AllowedAction::Draft | AllowedAction::WriteWithConfirmation
        ),
        ToolScope::WriteWithConfirmation => matches!(
            action,
            AllowedAction::Read | AllowedAction::Draft | AllowedAction::WriteWithConfirmation
        ),
    }
}

fn tool_is_executable(agent: &AgentDefinition, action: &AllowedAction) -> bool {
    match agent.tool_scope {
        ToolScope::None => false,
        ToolScope::ReadOnly => matches!(action, AllowedAction::Read),
        ToolScope::DraftOnly => matches!(action, AllowedAction::Read | AllowedAction::Draft),
        ToolScope::WriteWithConfirmation => matches!(
            action,
            AllowedAction::Read | AllowedAction::Draft | AllowedAction::WriteWithConfirmation
        ),
    }
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

    pub fn run_until_blocked_recording(
        &mut self,
        audit_store: &AuditStore,
    ) -> Result<Vec<SubagentResult>, String> {
        let mut all_results = Vec::new();
        loop {
            let results = self.run_ready_once();
            if results.is_empty() {
                break;
            }
            for result in &results {
                audit_store.record_result(result)?;
            }
            all_results.extend(results);
        }
        Ok(all_results)
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

pub struct AuditStore {
    conn: rusqlite::Connection,
}

impl AuditStore {
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = rusqlite::Connection::open_in_memory().map_err(|error| error.to_string())?;
        let store = Self { conn };
        store.init()?;
        Ok(store)
    }

    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let conn = rusqlite::Connection::open(path).map_err(|error| error.to_string())?;
        let store = Self { conn };
        store.init()?;
        Ok(store)
    }

    pub fn record_result(&self, result: &SubagentResult) -> Result<(), String> {
        let output_json = serde_json::to_string(&result.output).map_err(|error| error.to_string())?;
        let errors_json = serde_json::to_string(&result.errors).map_err(|error| error.to_string())?;
        let metrics_json =
            serde_json::to_string(&result.metrics).map_err(|error| error.to_string())?;
        let audit_json = serde_json::to_string(&result.audit).map_err(|error| error.to_string())?;

        self.conn
            .execute(
                "insert into subagent_results (
                    task_id,
                    agent_id,
                    status,
                    output_json,
                    errors_json,
                    metrics_json,
                    audit_json
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                (
                    &result.task_id,
                    agent_id_name(&result.agent_id),
                    status_name(&result.status),
                    output_json,
                    errors_json,
                    metrics_json,
                    audit_json,
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn result_count(&self) -> Result<u64, String> {
        self.conn
            .query_row("select count(*) from subagent_results", [], |row| row.get(0))
            .map_err(|error| error.to_string())
    }

    pub fn result_status(&self, task_id: &str) -> Result<Option<String>, String> {
        let mut statement = self
            .conn
            .prepare("select status from subagent_results where task_id = ?1 order by id desc limit 1")
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query([task_id])
            .map_err(|error| error.to_string())?;
        match rows.next().map_err(|error| error.to_string())? {
            Some(row) => row.get(0).map(Some).map_err(|error| error.to_string()),
            None => Ok(None),
        }
    }

    pub fn latest_result(&self, task_id: &str) -> Result<Option<SubagentResult>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select task_id, agent_id, status, output_json, errors_json, metrics_json, audit_json
                 from subagent_results
                 where task_id = ?1
                 order by id desc
                 limit 1",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query([task_id])
            .map_err(|error| error.to_string())?;

        match rows.next().map_err(|error| error.to_string())? {
            Some(row) => result_from_audit_row(row).map(Some),
            None => Ok(None),
        }
    }

    pub fn recent_results_by_status(
        &self,
        status: SubagentStatus,
        limit: u32,
    ) -> Result<Vec<SubagentResult>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select task_id, agent_id, status, output_json, errors_json, metrics_json, audit_json
                 from subagent_results
                 where status = ?1
                 order by id desc
                 limit ?2",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query((status_name(&status), i64::from(limit)))
            .map_err(|error| error.to_string())?;
        let mut results = Vec::new();

        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            results.push(result_from_audit_row(row)?);
        }

        Ok(results)
    }

    fn init(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "create table if not exists subagent_results (
                    id integer primary key autoincrement,
                    task_id text not null,
                    agent_id text not null,
                    status text not null,
                    output_json text not null,
                    errors_json text not null,
                    metrics_json text not null,
                    audit_json text not null,
                    created_at text not null default current_timestamp
                );
                create index if not exists idx_subagent_results_task_id
                    on subagent_results(task_id);",
            )
            .map_err(|error| error.to_string())
    }
}

fn agent_id_name(agent_id: &AgentId) -> &'static str {
    match agent_id {
        AgentId::Planner => "PlannerAgent",
        AgentId::Memory => "MemoryAgent",
        AgentId::Tool => "ToolAgent",
        AgentId::Vision => "VisionAgent",
        AgentId::Risk => "RiskAgent",
        AgentId::Automation => "AutomationAgent",
        AgentId::Review => "ReviewAgent",
    }
}

fn status_name(status: &SubagentStatus) -> &'static str {
    match status {
        SubagentStatus::Succeeded => "succeeded",
        SubagentStatus::Failed => "failed",
        SubagentStatus::Cancelled => "cancelled",
        SubagentStatus::TimedOut => "timed_out",
    }
}

fn result_from_audit_row(row: &rusqlite::Row<'_>) -> Result<SubagentResult, String> {
    let task_id: String = row.get(0).map_err(|error| error.to_string())?;
    let agent_id: String = row.get(1).map_err(|error| error.to_string())?;
    let status: String = row.get(2).map_err(|error| error.to_string())?;
    let output_json: String = row.get(3).map_err(|error| error.to_string())?;
    let errors_json: String = row.get(4).map_err(|error| error.to_string())?;
    let metrics_json: String = row.get(5).map_err(|error| error.to_string())?;
    let audit_json: String = row.get(6).map_err(|error| error.to_string())?;

    Ok(SubagentResult {
        task_id,
        agent_id: agent_id_from_name(&agent_id)?,
        status: status_from_name(&status)?,
        output: serde_json::from_str(&output_json).map_err(|error| error.to_string())?,
        errors: serde_json::from_str(&errors_json).map_err(|error| error.to_string())?,
        metrics: serde_json::from_str(&metrics_json).map_err(|error| error.to_string())?,
        audit: serde_json::from_str(&audit_json).map_err(|error| error.to_string())?,
    })
}

fn agent_id_from_name(agent_id: &str) -> Result<AgentId, String> {
    match agent_id {
        "PlannerAgent" => Ok(AgentId::Planner),
        "MemoryAgent" => Ok(AgentId::Memory),
        "ToolAgent" => Ok(AgentId::Tool),
        "VisionAgent" => Ok(AgentId::Vision),
        "RiskAgent" => Ok(AgentId::Risk),
        "AutomationAgent" => Ok(AgentId::Automation),
        "ReviewAgent" => Ok(AgentId::Review),
        _ => Err(format!("unknown agent id {agent_id}")),
    }
}

fn status_from_name(status: &str) -> Result<SubagentStatus, String> {
    match status {
        "succeeded" => Ok(SubagentStatus::Succeeded),
        "failed" => Ok(SubagentStatus::Failed),
        "cancelled" => Ok(SubagentStatus::Cancelled),
        "timed_out" => Ok(SubagentStatus::TimedOut),
        _ => Err(format!("unknown subagent status {status}")),
    }
}
