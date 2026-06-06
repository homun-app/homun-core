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
            if overdue_reason(&task, now).is_some() {
                // Past its hard time budget — never hand it to the worker; the
                // `expire_overdue_tasks` sweep moves it to `Expired`.
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

    /// Marks non-terminal tasks whose hard time budget has elapsed as `Expired`,
    /// so the worker never starts (nor keeps re-queuing) work it can no longer
    /// deliver. Two "can't succeed anymore" bounds: `expires_at` = do-not-start
    /// after (e.g. a stale recurring occurrence); `deadline` = must-finish-by.
    /// A cheap sweep, mirrored on `mark_blocked_by_terminal_dependencies`, meant
    /// to run before scheduling. Returns how many tasks were expired.
    ///
    /// Human-blocked states (`WaitingUserApproval`, `Paused`) are intentionally
    /// left alone — expiring something the user is mid-decision on would surprise.
    pub fn expire_overdue_tasks(
        &self,
        store: &TaskStore,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        now: OffsetDateTime,
    ) -> TaskRuntimeResult<usize> {
        let mut expired = 0usize;
        for task in store.list_tasks(user_id, workspace_id)? {
            if !matches!(
                task.status,
                TaskStatus::Queued
                    | TaskStatus::Pending
                    | TaskStatus::WaitingTime
                    | TaskStatus::WaitingExternalEvent
                    | TaskStatus::WaitingResource
            ) {
                continue;
            }
            let Some(reason) = overdue_reason(&task, now) else {
                continue;
            };
            store.update_task_status(
                &task.task_id,
                user_id,
                workspace_id,
                TaskStatus::Expired,
                Some(&reason),
            )?;
            expired += 1;
        }
        Ok(expired)
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

/// `Some(reason)` when the task is past a hard time budget and can no longer
/// succeed: `expires_at` (do-not-start-after) takes precedence over `deadline`
/// (must-finish-by). Both are optional; absent bounds never expire a task.
fn overdue_reason(task: &TaskRecord, now: OffsetDateTime) -> Option<String> {
    if task.expires_at.is_some_and(|expires_at| expires_at <= now) {
        return Some("task expired: past expires_at (not started in time)".to_string());
    }
    if task.deadline.is_some_and(|deadline| deadline <= now) {
        return Some("task expired: past deadline (cannot complete in time)".to_string());
    }
    None
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
