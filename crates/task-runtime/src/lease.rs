use crate::{
    TaskId, TaskRuntimeError, TaskRuntimeResult, TaskStatus, TaskStore, UserId, WorkspaceId,
};
use time::{Duration, OffsetDateTime};

pub struct LeaseManager {
    lease_duration: Duration,
}

impl LeaseManager {
    pub fn new(lease_duration: Duration) -> Self {
        Self { lease_duration }
    }

    pub fn acquire(
        &self,
        store: &TaskStore,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        owner: &str,
        now: OffsetDateTime,
    ) -> TaskRuntimeResult<bool> {
        let mut task = store
            .get_task(task_id, user_id, workspace_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound(task_id.as_str().to_string()))?;

        if task
            .lease_expires_at
            .is_some_and(|expires_at| expires_at > now)
            && task.lease_owner.as_deref() != Some(owner)
        {
            return Ok(false);
        }

        task.status = TaskStatus::Running;
        task.lease_owner = Some(owner.to_string());
        task.last_heartbeat_at = Some(now);
        task.lease_expires_at = Some(now + self.lease_duration);
        task.updated_at = now;
        store.insert_task(&task)?;
        Ok(true)
    }

    pub fn heartbeat(
        &self,
        store: &TaskStore,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        owner: &str,
        now: OffsetDateTime,
    ) -> TaskRuntimeResult<()> {
        let mut task = store
            .get_task(task_id, user_id, workspace_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound(task_id.as_str().to_string()))?;
        if task.lease_owner.as_deref() != Some(owner) {
            return Err(TaskRuntimeError::LeaseConflict(format!(
                "task {} is leased by {:?}",
                task_id.as_str(),
                task.lease_owner
            )));
        }

        task.last_heartbeat_at = Some(now);
        task.lease_expires_at = Some(now + self.lease_duration);
        task.updated_at = now;
        store.insert_task(&task)
    }

    pub fn recover_stale_leases(
        &self,
        store: &TaskStore,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        now: OffsetDateTime,
    ) -> TaskRuntimeResult<Vec<TaskId>> {
        let mut recovered = Vec::new();
        for mut task in store.list_tasks(user_id, workspace_id)? {
            if task.status != TaskStatus::Running {
                continue;
            }
            if !task
                .lease_expires_at
                .is_some_and(|expires_at| expires_at <= now)
            {
                continue;
            }

            store.release_resources(&task)?;
            task.status = TaskStatus::Queued;
            task.lease_owner = None;
            task.lease_expires_at = None;
            task.last_heartbeat_at = None;
            task.blocked_reason = Some("stale lease recovered".to_string());
            task.updated_at = now;
            let task_id = task.task_id.clone();
            store.insert_task(&task)?;
            recovered.push(task_id);
        }
        Ok(recovered)
    }
}
