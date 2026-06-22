use crate::{
    ApprovalGate, ExecutorResult, LeaseManager, ResourceGovernor, ResourceLimits, RetryController,
    TaskExecutor, TaskId, TaskRecord, TaskRuntimeResult, TaskScheduler, TaskStatus, TaskStore,
    UserId, WorkspaceId,
};
use time::{Duration, OffsetDateTime};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunReadySummary {
    pub attempted: usize,
    pub completed: usize,
    pub checkpointed: usize,
    pub waiting: usize,
    pub failed_retryable: usize,
    pub skipped: usize,
}

pub struct TaskRuntime {
    store: TaskStore,
    scheduler: TaskScheduler,
    resources: ResourceGovernor,
    leases: LeaseManager,
    approvals: ApprovalGate,
    retry: RetryController,
    executor: Box<dyn TaskExecutor>,
    worker_id: String,
}

impl TaskRuntime {
    pub fn new(
        store: TaskStore,
        executor: Box<dyn TaskExecutor>,
        resource_limits: ResourceLimits,
        worker_id: impl Into<String>,
    ) -> Self {
        Self {
            store,
            scheduler: TaskScheduler::new(),
            resources: ResourceGovernor::new(resource_limits),
            leases: LeaseManager::new(Duration::minutes(5)),
            approvals: ApprovalGate::new(),
            retry: RetryController::new(),
            executor,
            worker_id: worker_id.into(),
        }
    }

    pub fn store(&self) -> &TaskStore {
        &self.store
    }

    pub fn run_ready_once(
        &mut self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        now: OffsetDateTime,
    ) -> TaskRuntimeResult<RunReadySummary> {
        self.requeue_waiting_resource_tasks(user_id, workspace_id)?;
        let ready =
            self.scheduler
                .ready_tasks(&self.store, user_id, workspace_id, now, usize::MAX)?;
        let mut summary = RunReadySummary::default();

        for task in ready {
            if self
                .resources
                .mark_waiting_if_unavailable(&self.store, &task)?
            {
                summary.skipped += 1;
                continue;
            }
            if !self.leases.acquire(
                &self.store,
                &task.task_id,
                user_id,
                workspace_id,
                &self.worker_id,
                now,
            )? {
                summary.skipped += 1;
                continue;
            }
            let Some(mut leased_task) =
                self.store.get_task(&task.task_id, user_id, workspace_id)?
            else {
                summary.skipped += 1;
                continue;
            };
            self.resources
                .reserve(&self.store, &leased_task, &self.worker_id)?;
            let checkpoint =
                self.store
                    .latest_checkpoint(&leased_task.task_id, user_id, workspace_id)?;
            summary.attempted += 1;

            match self.executor.execute_step(&leased_task, checkpoint) {
                Ok(ExecutorResult::Completed { .. }) => {
                    self.finish_task(&mut leased_task, TaskStatus::Completed, None, now)?;
                    self.insert_next_recurrence(&leased_task, now)?;
                    summary.completed += 1;
                }
                Ok(ExecutorResult::Checkpoint {
                    payload,
                    redacted_payload,
                }) => {
                    self.store.append_checkpoint(
                        &leased_task.task_id,
                        user_id,
                        workspace_id,
                        payload,
                        redacted_payload,
                    )?;
                    let mut reloaded =
                        self.reload_task(&leased_task.task_id, user_id, workspace_id)?;
                    self.finish_task(&mut reloaded, TaskStatus::Queued, None, now)?;
                    summary.checkpointed += 1;
                }
                Ok(ExecutorResult::WaitUntil { not_before, reason }) => {
                    leased_task.status = TaskStatus::WaitingTime;
                    leased_task.not_before = Some(not_before);
                    leased_task.blocked_reason = Some(reason);
                    self.clear_execution_state(&mut leased_task, now);
                    self.resources.release(&self.store, &leased_task)?;
                    self.store.insert_task(&leased_task)?;
                    summary.waiting += 1;
                }
                Ok(ExecutorResult::NeedsApproval {
                    action,
                    risk_level,
                    data_boundary,
                    explanation,
                }) => {
                    self.clear_execution_state(&mut leased_task, now);
                    self.resources.release(&self.store, &leased_task)?;
                    self.store.insert_task(&leased_task)?;
                    self.approvals.request_approval(
                        &self.store,
                        &leased_task.task_id,
                        user_id,
                        workspace_id,
                        &action,
                        &risk_level,
                        &data_boundary,
                        &explanation,
                    )?;
                    summary.waiting += 1;
                }
                Ok(ExecutorResult::RetryableFailure { reason }) => {
                    self.record_failure_and_insert_next_if_terminal(
                        &leased_task.task_id,
                        user_id,
                        workspace_id,
                        &reason,
                        now,
                    )?;
                    summary.failed_retryable += 1;
                }
                Err(error) => {
                    self.record_failure_and_insert_next_if_terminal(
                        &leased_task.task_id,
                        user_id,
                        workspace_id,
                        &error.to_string(),
                        now,
                    )?;
                    summary.failed_retryable += 1;
                }
            }
        }

        Ok(summary)
    }

    fn requeue_waiting_resource_tasks(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<usize> {
        let mut requeued = 0usize;
        for task in self.store.list_tasks(user_id, workspace_id)? {
            if self
                .resources
                .requeue_waiting_if_available(&self.store, &task)?
            {
                requeued += 1;
            }
        }
        Ok(requeued)
    }

    fn finish_task(
        &self,
        task: &mut TaskRecord,
        status: TaskStatus,
        blocked_reason: Option<String>,
        now: OffsetDateTime,
    ) -> TaskRuntimeResult<()> {
        task.status = status;
        task.blocked_reason = blocked_reason;
        self.clear_execution_state(task, now);
        self.resources.release(&self.store, task)?;
        self.store.insert_task(task)
    }

    fn insert_next_recurrence(
        &self,
        completed: &TaskRecord,
        now: OffsetDateTime,
    ) -> TaskRuntimeResult<()> {
        if let Some(next) = self.scheduler.next_recurrence(completed, now) {
            self.store.insert_task(&next)?;
        }
        Ok(())
    }

    fn record_failure_and_insert_next_if_terminal(
        &self,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        reason: &str,
        now: OffsetDateTime,
    ) -> TaskRuntimeResult<()> {
        self.retry
            .record_failure(&self.store, task_id, user_id, workspace_id, reason, now)?;
        let failed = self.reload_task(task_id, user_id, workspace_id)?;
        if failed.status == TaskStatus::Failed {
            self.insert_next_recurrence(&failed, now)?;
        }
        Ok(())
    }

    fn clear_execution_state(&self, task: &mut TaskRecord, now: OffsetDateTime) {
        task.lease_owner = None;
        task.lease_expires_at = None;
        task.last_heartbeat_at = None;
        task.updated_at = now;
    }

    fn reload_task(
        &self,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<TaskRecord> {
        self.store
            .get_task(task_id, user_id, workspace_id)?
            .ok_or_else(|| crate::TaskRuntimeError::NotFound(task_id.as_str().to_string()))
    }
}
