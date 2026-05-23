use crate::{
    TaskId, TaskRuntimeError, TaskRuntimeResult, TaskStatus, TaskStore, UserId, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{Duration, OffsetDateTime};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskCheckpoint {
    pub checkpoint_id: String,
    pub task_id: TaskId,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub sequence: u32,
    pub payload: Value,
    pub redacted_payload: Value,
    pub created_at: OffsetDateTime,
}

impl TaskCheckpoint {
    pub fn new(
        checkpoint_id: impl Into<String>,
        task_id: TaskId,
        user_id: UserId,
        workspace_id: WorkspaceId,
        sequence: u32,
        payload: Value,
        redacted_payload: Value,
    ) -> Self {
        Self {
            checkpoint_id: checkpoint_id.into(),
            task_id,
            user_id,
            workspace_id,
            sequence,
            payload,
            redacted_payload,
            created_at: OffsetDateTime::now_utc(),
        }
    }
}

pub struct RetryController;

impl RetryController {
    pub fn new() -> Self {
        Self
    }

    pub fn record_failure(
        &self,
        store: &TaskStore,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        reason: &str,
        now: OffsetDateTime,
    ) -> TaskRuntimeResult<()> {
        let mut task = store
            .get_task(task_id, user_id, workspace_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound(task_id.as_str().to_string()))?;

        task.attempt_count += 1;
        task.lease_owner = None;
        task.lease_expires_at = None;
        task.last_heartbeat_at = None;
        task.blocked_reason = Some(reason.to_string());
        task.updated_at = now;

        if task.attempt_count < task.retry_policy.max_attempts {
            task.status = TaskStatus::WaitingTime;
            task.not_before = Some(now + Duration::seconds(task.retry_policy.backoff_seconds));
        } else {
            task.status = TaskStatus::Failed;
            task.not_before = None;
        }

        store.release_resources(&task)?;
        store.insert_task(&task)
    }
}

impl Default for RetryController {
    fn default() -> Self {
        Self::new()
    }
}
