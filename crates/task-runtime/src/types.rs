use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct UserId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorkspaceId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TaskId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorkflowId(String);

impl UserId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl WorkspaceId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TaskId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl WorkflowId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for UserId {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl From<&str> for WorkspaceId {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl From<&str> for TaskId {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl From<&str> for WorkflowId {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Pending,
    Running,
    WaitingTime,
    WaitingExternalEvent,
    WaitingUserApproval,
    WaitingResource,
    Paused,
    Completed,
    Failed,
    Cancelled,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskPriority {
    Background,
    Low,
    Normal,
    High,
    Critical,
}

impl Default for TaskPriority {
    fn default() -> Self {
        Self::Normal
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceClass {
    LlmInference,
    BrowserSession,
    NetworkIo,
    FilesystemIo,
    ConnectorApi,
    ComputerSession,
    ShellProcess,
    MemoryIndexing,
    GraphIndexing,
    UserWait,
    BackgroundMaintenance,
}

impl ResourceClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            ResourceClass::LlmInference => "llm_inference",
            ResourceClass::BrowserSession => "browser_session",
            ResourceClass::NetworkIo => "network_io",
            ResourceClass::FilesystemIo => "filesystem_io",
            ResourceClass::ConnectorApi => "connector_api",
            ResourceClass::ComputerSession => "computer_session",
            ResourceClass::ShellProcess => "shell_process",
            ResourceClass::MemoryIndexing => "memory_indexing",
            ResourceClass::GraphIndexing => "graph_indexing",
            ResourceClass::UserWait => "user_wait",
            ResourceClass::BackgroundMaintenance => "background_maintenance",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceRequirement {
    pub class: ResourceClass,
    pub units: u32,
}

impl ResourceRequirement {
    pub fn new(class: ResourceClass, units: u32) -> Self {
        Self { class, units }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub backoff_seconds: i64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 1,
            backoff_seconds: 0,
        }
    }
}

/// One recorded execution of an automation — the run history surfaced in the UI so
/// the user can see WHEN it last fired and whether it succeeded, failed or ran late
/// (a catch-up after the app was off at the scheduled time).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationRun {
    pub ran_at: i64,
    pub ok: bool,
    pub late: bool,
    pub detail: Option<String>,
}

/// One unit of a turn's stream, persisted for resume and the working island. The
/// semantics of `kind` mirror `liveWorkspace.ts` (replace on `plan_update`, append
/// on `activity`) — the client reducer is preserved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnEvent {
    pub event_id: i64,
    pub turn_id: String,
    pub seq: i64,
    pub kind: TurnEventKind,
    pub payload: Value,
    pub created_at: i64,
}

/// One broker attempt through the guarded agent loop. This is operational state, not
/// semantic memory: it exists so a run can be inspected and recovered without changing recall.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRun {
    pub run_id: String,
    pub turn_id: String,
    pub thread_id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub attempt: u32,
    pub status: AgentRunStatus,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub prompt_fingerprint: Option<String>,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub terminal_reason: Option<String>,
    pub schema_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewAgentRun {
    pub run_id: String,
    pub turn_id: String,
    pub thread_id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub prompt_fingerprint: Option<String>,
}

/// Canonical, operational plan state for one chat thread.
///
/// This deliberately lives outside semantic memory: plan execution state must be
/// isolated by user/workspace/thread and updated transactionally.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimePlanRecord {
    pub user_id: String,
    pub workspace_id: String,
    pub thread_id: String,
    pub status: String,
    pub plan_json: Value,
    pub revision: u64,
    pub stall_turns: u32,
    pub last_resume_done: Option<usize>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunStatus {
    Running,
    Completed,
    Failed,
    Aborted,
}

impl AgentRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Aborted => "aborted",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "aborted" => Self::Aborted,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRunEvent {
    pub event_id: i64,
    pub run_id: String,
    pub seq: i64,
    pub round: Option<i64>,
    pub kind: String,
    pub payload: Value,
    pub created_at: i64,
}

/// Thread-level cockpit projection over the durable per-turn log (`turn_events`) for the
/// working island. Plans supersede (latest `plan_update` wins); activity accumulates across
/// ALL turns of the thread in chronological order (capped to bound the payload). This is the
/// single durable source the island reads at rest — the message-text `‹‹ACT/PLAN››` markers
/// are a lossy mirror (absent for workflow deliverables, plan emitted at most once) we no
/// longer depend on. `latest_turn_status` distinguishes a live turn from a concluded one.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ThreadActivityProjection {
    pub plan_markdown: Option<String>,
    pub activity: Vec<String>,
    pub latest_turn_status: Option<String>,
    pub turn_count: usize,
    /// Subagents spawned on this thread (name + status). Empty until `spawn_subagent`
    /// actually fires — today weak local managers route decomposition to the PLAN, so this
    /// is forward-looking plumbing: the section renders as soon as a subagent task appears.
    pub subagents: Vec<SubagentInfo>,
}

/// One spawned subagent, projected into the island's "Subagenti" section.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SubagentInfo {
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnEventKind {
    Delta,
    Reasoning,
    Activity,
    PlanUpdate,
    Tool,
    Recall,
    Done,
    Error,
    Cancelled,
    Aborted,
    /// A transient failure triggered an automatic retry. Payload carries attempt,
    /// max_attempts, backoff_seconds, reason — so the UI can show "retry in corso
    /// (2/2 fra 15s)…". The user can still cancel via DELETE /turns/{id}.
    Retry,
    /// The turn is waiting for a shared resource (e.g. the browser slot). Payload
    /// carries detail (human reason like "waiting for browser slot") so the UI can
    /// surface "in attesa del browser…". Emitted when the governor puts the task in
    /// WaitingResource. The turn auto-resumes (back to Queued) once the resource frees.
    Queued,
}

impl TurnEventKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TurnEventKind::Delta => "delta",
            TurnEventKind::Reasoning => "reasoning",
            TurnEventKind::Activity => "activity",
            TurnEventKind::PlanUpdate => "plan_update",
            TurnEventKind::Tool => "tool",
            TurnEventKind::Recall => "recall",
            TurnEventKind::Done => "done",
            TurnEventKind::Error => "error",
            TurnEventKind::Cancelled => "cancelled",
            TurnEventKind::Aborted => "aborted",
            TurnEventKind::Retry => "retry",
            TurnEventKind::Queued => "queued",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "delta" => Self::Delta,
            "reasoning" => Self::Reasoning,
            "activity" => Self::Activity,
            "plan_update" => Self::PlanUpdate,
            "tool" => Self::Tool,
            "recall" => Self::Recall,
            "done" => Self::Done,
            "error" => Self::Error,
            "cancelled" => Self::Cancelled,
            "aborted" => Self::Aborted,
            "retry" => Self::Retry,
            "queued" => Self::Queued,
            _ => return None,
        })
    }
}

#[cfg(test)]
mod turn_event_kind_tests {
    use super::TurnEventKind;

    #[test]
    fn recall_round_trips_through_persisted_event_kind() {
        assert_eq!(TurnEventKind::Recall.as_str(), "recall");
        assert_eq!(TurnEventKind::parse("recall"), Some(TurnEventKind::Recall));
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskRecord {
    pub task_id: TaskId,
    pub workflow_id: Option<WorkflowId>,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub kind: String,
    pub goal: String,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    pub risk_level: String,
    pub resource_requirements: Vec<ResourceRequirement>,
    pub permission_context: Value,
    pub input_json: Value,
    pub checkpoint_json: Option<Value>,
    pub retry_policy: RetryPolicy,
    pub attempt_count: u32,
    pub not_before: Option<OffsetDateTime>,
    pub deadline: Option<OffsetDateTime>,
    pub expires_at: Option<OffsetDateTime>,
    /// Optional recurrence rule. v1: interval specs ("every 6h", "every 1d").
    /// When set, completing this task enqueues the next occurrence (proactivity).
    #[serde(default)]
    pub recurrence: Option<String>,
    /// IANA timezone, reserved for calendar-anchored recurrence (interval rules
    /// are timezone-independent). Defaults to UTC when absent.
    #[serde(default)]
    pub recurrence_tz: Option<String>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    pub last_heartbeat_at: Option<OffsetDateTime>,
    pub lease_owner: Option<String>,
    pub lease_expires_at: Option<OffsetDateTime>,
    pub blocked_reason: Option<String>,
}

impl TaskRecord {
    pub fn new(
        task_id: impl Into<String>,
        user_id: UserId,
        workspace_id: WorkspaceId,
        kind: impl Into<String>,
        goal: impl Into<String>,
        input_json: Value,
    ) -> Self {
        let now = OffsetDateTime::now_utc();
        Self {
            task_id: TaskId::new(task_id),
            workflow_id: None,
            user_id,
            workspace_id,
            kind: kind.into(),
            goal: goal.into(),
            status: TaskStatus::Queued,
            priority: TaskPriority::Normal,
            risk_level: "low".to_string(),
            resource_requirements: Vec::new(),
            permission_context: Value::Object(Default::default()),
            input_json,
            checkpoint_json: None,
            retry_policy: RetryPolicy::default(),
            attempt_count: 0,
            not_before: None,
            deadline: None,
            expires_at: None,
            recurrence: None,
            recurrence_tz: None,
            created_at: now,
            updated_at: now,
            last_heartbeat_at: None,
            lease_owner: None,
            lease_expires_at: None,
            blocked_reason: None,
        }
    }

    pub fn with_recurrence(mut self, rule: impl Into<String>, tz: Option<String>) -> Self {
        self.recurrence = Some(rule.into());
        self.recurrence_tz = tz;
        self
    }

    pub fn with_priority(mut self, priority: TaskPriority) -> Self {
        self.priority = priority;
        self
    }

    pub fn with_resource(mut self, resource: ResourceRequirement) -> Self {
        self.resource_requirements.push(resource);
        self
    }

    pub fn with_retry_policy(mut self, retry_policy: RetryPolicy) -> Self {
        self.retry_policy = retry_policy;
        self
    }

    pub fn with_workflow(mut self, workflow_id: WorkflowId) -> Self {
        self.workflow_id = Some(workflow_id);
        self
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Automation: the user-facing RULE (trigger → agentic action). Distinct from a
// TaskRecord (a single execution). SOTA model: IFTTT-clarity triggers + agentic
// action. A Schedule automation drives a recurring TaskRecord; an Event automation
// materializes a one-shot TaskRecord when its event fires.
// ─────────────────────────────────────────────────────────────────────────────

/// What starts an automation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AutomationTrigger {
    /// Time-based — a recurrence rule ("daily@08:00", "weekly@mon@09:00", "every 6h")
    /// parsed by `recurrence::next_occurrence`, with an optional IANA timezone.
    Schedule {
        recurrence: String,
        #[serde(default)]
        tz: Option<String>,
    },
    /// Event-based — fires when a matching event occurs (channel message, email, …).
    Event { event: EventTrigger },
}

/// The concrete event an Event automation listens for. Filters are optional; absent
/// means "any". Only `ChannelMessage` is wired in v1; the rest are forward-declared.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventTrigger {
    /// An inbound message on a connected channel (WhatsApp/Telegram).
    ChannelMessage {
        #[serde(default)]
        channel: Option<String>,
        #[serde(default)]
        from: Option<String>,
    },
    /// An inbound email (forward-declared; wired in a later phase).
    EmailReceived {
        #[serde(default)]
        from: Option<String>,
    },
    /// A watched file changed (forward-declared).
    FileChanged { path: String },
    /// Memory updated, optionally on a topic (forward-declared).
    MemoryUpdated {
        #[serde(default)]
        topic: Option<String>,
    },
    /// GENERIC poll on a connected capability (Composio slug or MCP tool). A background
    /// poller calls `tool(args)`, treats the response items as events, and fires on each
    /// item whose `key_field` value hasn't been seen before. Works for ANY connector —
    /// Gmail "new email", Calendar "new event", Slack messages, Notion rows, … — without
    /// hardcoding the service. The agent configures `tool`/`args`/`key_field` at creation
    /// (it knows the tool's shape via find_capability).
    ConnectorPoll {
        tool: String,
        #[serde(default)]
        args: Value,
        key_field: String,
        #[serde(default)]
        label: Option<String>,
    },
}

/// Whether the automation's run may act autonomously or must ask first. Defaults to
/// `Confirm` — the safe choice for anything that sends/publishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    Confirm,
    Autonomous,
}

impl Default for ApprovalPolicy {
    fn default() -> Self {
        ApprovalPolicy::Confirm
    }
}

/// How the automation came to exist (for provenance + UI grouping).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutomationSource {
    Chat,
    Mining,
    Manual,
}

/// A first-class automation: trigger + agentic action + policy. The action is a
/// natural-language `prompt` the agent runs with its full toolset (skills/MCP/browser
/// via the capability router) — NOT a deterministic node graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Automation {
    pub id: String,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub title: String,
    pub trigger: AutomationTrigger,
    /// The agentic action: what the agent should do when the trigger fires.
    pub prompt: String,
    #[serde(default)]
    pub approval: ApprovalPolicy,
    pub enabled: bool,
    pub source: AutomationSource,
    /// For Schedule automations: the recurring TaskRecord that drives it (1:1).
    /// `None` for Event automations (runs are materialized on the fly).
    #[serde(default)]
    pub task_id: Option<String>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    #[serde(default)]
    pub last_fired_at: Option<OffsetDateTime>,
    /// Per-automation runtime state — e.g. the ConnectorPoll watermark
    /// (`{"seen": [...keys], "initialized": true}`). Opaque to the store.
    #[serde(default)]
    pub state: Option<Value>,
}

impl Automation {
    /// `"schedule"` | `"event"` — used by the store index + UI grouping.
    pub fn trigger_kind(&self) -> &'static str {
        match self.trigger {
            AutomationTrigger::Schedule { .. } => "schedule",
            AutomationTrigger::Event { .. } => "event",
        }
    }
}
