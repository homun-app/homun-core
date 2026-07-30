use crate::{
    TaskId, TaskRuntimeError, TaskRuntimeResult, TaskStatus, TaskStore, UserId, WorkspaceId,
};
use time::{Duration, OffsetDateTime};

pub struct LeaseManager {
    lease_duration: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeaseOwnership<'a> {
    owner: &'a str,
    fencing_token: u64,
}

impl<'a> LeaseOwnership<'a> {
    pub fn new(owner: &'a str, fencing_token: u64) -> Self {
        Self {
            owner,
            fencing_token,
        }
    }
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
        {
            return Ok(false);
        }

        task.status = TaskStatus::Running;
        task.lease_owner = Some(owner.to_string());
        task.last_heartbeat_at = Some(now);
        task.lease_expires_at = Some(now + self.lease_duration);
        task.lease_fencing_token =
            Some(u64::try_from(now.unix_timestamp_nanos()).map_err(|_| {
                TaskRuntimeError::InvalidTransition(
                    "lease acquisition timestamp cannot be used as a fence".into(),
                )
            })?);
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
        ownership: LeaseOwnership<'_>,
        now: OffsetDateTime,
    ) -> TaskRuntimeResult<()> {
        let mut task = store
            .get_task(task_id, user_id, workspace_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound(task_id.as_str().to_string()))?;
        if task.lease_owner.as_deref() != Some(ownership.owner)
            || task.effective_lease_fencing_token() != Some(ownership.fencing_token)
        {
            return Err(TaskRuntimeError::LeaseConflict(format!(
                "task {} lease generation is not owned by {}",
                task_id.as_str(),
                ownership.owner,
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
            if task
                .lease_expires_at
                .is_none_or(|expires_at| expires_at > now)
            {
                continue;
            }

            store.release_resources(&task)?;
            task.status = TaskStatus::Queued;
            task.clear_lease();
            task.blocked_reason = Some("stale lease recovered".to_string());
            task.updated_at = now;
            let task_id = task.task_id.clone();
            store.insert_task(&task)?;
            recovered.push(task_id);
        }
        Ok(recovered)
    }
}
