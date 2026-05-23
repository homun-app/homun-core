use crate::{TaskRecord, TaskRuntimeResult, TaskStatus, TaskStore, UserId, WorkspaceId};
use time::OffsetDateTime;

pub struct TaskScheduler;

impl TaskScheduler {
    pub fn new() -> Self {
        Self
    }

    pub fn ready_tasks(
        &self,
        store: &TaskStore,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        now: OffsetDateTime,
        limit: usize,
    ) -> TaskRuntimeResult<Vec<TaskRecord>> {
        let mut candidates = Vec::new();
        for task in store.list_tasks(user_id, workspace_id)? {
            if !matches!(task.status, TaskStatus::Queued | TaskStatus::Pending) {
                continue;
            }
            if task.not_before.is_some_and(|not_before| not_before > now) {
                continue;
            }
            if !self.dependencies_completed(store, &task, user_id, workspace_id)? {
                continue;
            }
            candidates.push(task);
        }

        candidates.sort_by(|left, right| {
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| left.created_at.cmp(&right.created_at))
                .then_with(|| left.task_id.as_str().cmp(right.task_id.as_str()))
        });
        candidates.truncate(limit);
        Ok(candidates)
    }

    pub fn mark_blocked_by_terminal_dependencies(
        &self,
        store: &TaskStore,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<()> {
        for task in store.list_tasks(user_id, workspace_id)? {
            if !matches!(task.status, TaskStatus::Queued | TaskStatus::Pending) {
                continue;
            }
            for dependency_id in store.dependencies_for(&task.task_id, user_id, workspace_id)? {
                let Some(dependency) = store.get_task(&dependency_id, user_id, workspace_id)?
                else {
                    continue;
                };
                if matches!(
                    dependency.status,
                    TaskStatus::Failed | TaskStatus::Cancelled | TaskStatus::Expired
                ) {
                    let reason = format!(
                        "dependency {} is {}",
                        dependency.task_id.as_str(),
                        status_label(dependency.status)
                    );
                    store.update_task_status(
                        &task.task_id,
                        user_id,
                        workspace_id,
                        TaskStatus::WaitingExternalEvent,
                        Some(&reason),
                    )?;
                    break;
                }
            }
        }
        Ok(())
    }

    fn dependencies_completed(
        &self,
        store: &TaskStore,
        task: &TaskRecord,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<bool> {
        for dependency_id in store.dependencies_for(&task.task_id, user_id, workspace_id)? {
            let Some(dependency) = store.get_task(&dependency_id, user_id, workspace_id)? else {
                return Ok(false);
            };
            if dependency.status != TaskStatus::Completed {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

impl Default for TaskScheduler {
    fn default() -> Self {
        Self::new()
    }
}

fn status_label(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Queued => "queued",
        TaskStatus::Pending => "pending",
        TaskStatus::Running => "running",
        TaskStatus::WaitingTime => "waiting_time",
        TaskStatus::WaitingExternalEvent => "waiting_external_event",
        TaskStatus::WaitingUserApproval => "waiting_user_approval",
        TaskStatus::WaitingResource => "waiting_resource",
        TaskStatus::Paused => "paused",
        TaskStatus::Completed => "completed",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
        TaskStatus::Expired => "expired",
    }
}
