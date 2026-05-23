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
    MemoryIndexing,
    GraphIndexing,
    UserWait,
    BackgroundMaintenance,
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
            created_at: now,
            updated_at: now,
            last_heartbeat_at: None,
            lease_owner: None,
            lease_expires_at: None,
            blocked_reason: None,
        }
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
