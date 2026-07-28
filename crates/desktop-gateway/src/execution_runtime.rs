use crate::task_registry::TaskExecutorRegistry;
use crate::{
    AppState, LocalTaskExecutionError, PendingExecutorApproval, SurfaceKind, TaskExecutionOutcome,
    TaskRecord, TaskResultSurfacing, TaskStatus, execute_capability_browser_task,
    execute_capability_generic, execute_local_read_only_task, execute_proactive_prompt_task,
    execute_shell_read_only_task, execute_subagent_task,
};
use futures_util::future::BoxFuture;
use local_first_execution_protocol::{
    ApprovalPolicy, CancelReason, CheckpointDataRef, CheckpointEnvelope, DurableDataRef,
    EffectClass, ExecutionBudget, ExecutionContract, ExecutionFailure, ExecutionOutcome,
    ExecutionPolicy, ExecutionScope, ExecutionState, ResourceRequirement,
    ValidatedExecutionContract, ValidatedExecutionOutcome, WakeCondition,
};
use local_first_task_runtime::{CreateExecution, ExecutionProjection, TaskRuntimeError};
use serde_json::{Value, json};
use std::sync::Arc;
use time::OffsetDateTime;

const LEASE_LOST_MESSAGE: &str = "execution task lease changed while the adapter was running";

pub(crate) trait GatewayExecutionAdapter: Send + Sync {
    fn name(&self) -> &'static str {
        "test"
    }

    fn execute<'a>(
        &'a self,
        state: &'a AppState,
        contract: &'a ValidatedExecutionContract,
    ) -> BoxFuture<'a, Result<AdapterExecution, LocalTaskExecutionError>>;
}

pub(crate) struct AdapterExecution {
    canonical: Option<ExecutionOutcome>,
    compatibility: Option<TaskExecutionOutcome>,
}

impl AdapterExecution {
    #[cfg(test)]
    pub(crate) fn canonical(outcome: ExecutionOutcome) -> Self {
        Self {
            canonical: Some(outcome),
            compatibility: None,
        }
    }

    fn legacy(outcome: TaskExecutionOutcome) -> Self {
        Self {
            canonical: None,
            compatibility: Some(outcome),
        }
    }
}

pub(crate) struct ExecutionRuntimeResult {
    execution_id: String,
    compatibility: Option<TaskExecutionOutcome>,
    projection: ExecutionProjection,
}

impl ExecutionRuntimeResult {
    pub(crate) fn execution_id(&self) -> &str {
        &self.execution_id
    }

    pub(crate) fn into_compatibility(self) -> Option<TaskExecutionOutcome> {
        self.compatibility
    }

    pub(crate) fn projection(&self) -> ExecutionProjection {
        self.projection
    }
}

#[derive(Clone)]
pub(crate) struct ExecutionRuntime {
    registry: TaskExecutorRegistry,
}

impl ExecutionRuntime {
    pub(crate) fn new(registry: TaskExecutorRegistry) -> Self {
        Self { registry }
    }

    pub(crate) fn default_registry() -> TaskExecutorRegistry {
        let mut registry = TaskExecutorRegistry::new();
        registry.register("capability.browser.*", Arc::new(CapabilityBrowserAdapter));
        registry.register("capability.*", Arc::new(CapabilityAdapter));
        registry.register("subagent.*", Arc::new(SubagentAdapter));
        registry.register("proactive_prompt", Arc::new(ProactivePromptAdapter));
        registry.register("chat_turn", Arc::new(ChatTurnAdapter));
        registry.register("local_shell_task", Arc::new(LegacyShellAdapter));
        registry.register("*", Arc::new(LegacyLocalAdapter));
        registry
    }

    pub(crate) async fn execute(
        &self,
        state: &AppState,
        requested_contract: ValidatedExecutionContract,
    ) -> Result<ExecutionRuntimeResult, LocalTaskExecutionError> {
        let task = task_from_contract(&requested_contract)?;
        validate_task_identity(&task, &requested_contract)?;
        let acquired_fence = acquired_task_fencing_token(&task)?;

        let contract = {
            let store = state.task_store.lock().map_err(runtime_lock_error)?;
            match store
                .execution(requested_contract.as_ref().execution_id.as_str())
                .map_err(runtime_store_error)?
            {
                Some(record) => {
                    validate_authoritative_contract(&task, &record.contract)?;
                    if let Some(outcome) = record.outcome.as_ref() {
                        return Ok(recovered_execution_result(&task, outcome.as_ref()));
                    }
                    if record.state != ExecutionState::Ready {
                        return Err(runtime_error(
                            "only a ready authoritative execution revision can be dispatched",
                        ));
                    }
                    let authoritative = record.contract.as_ref();
                    if acquired_fence < authoritative.fencing_token {
                        return Err(runtime_error(
                            "acquired task lease fence is older than the authoritative execution fence",
                        ));
                    }
                    if acquired_fence > authoritative.fencing_token {
                        store
                            .advance_execution_fence(
                                &authoritative.execution_id,
                                authoritative.revision,
                                authoritative.fencing_token,
                                acquired_fence,
                            )
                            .map_err(runtime_store_error)?
                            .contract
                    } else {
                        record.contract
                    }
                }
                None => match store
                    .create_execution(&requested_contract)
                    .map_err(runtime_store_error)?
                {
                    CreateExecution::Inserted(record) | CreateExecution::Existing(record) => {
                        record.contract
                    }
                },
            }
        };

        let adapter = self
            .registry
            .resolve(&contract.as_ref().kind)
            .ok_or_else(|| {
                runtime_error("no execution adapter is registered for this task kind")
            })?;
        let mut adapter_execution = match adapter.execute(state, &contract).await {
            Ok(execution) => execution,
            Err(error) => AdapterExecution::legacy(legacy_adapter_error_outcome(error)),
        };

        let pre_checkpoint_task = current_task(state, &task)?;
        if pre_checkpoint_task.status != TaskStatus::Cancelled
            && pre_checkpoint_task.lease_owner != task.lease_owner
        {
            return Err(runtime_error(LEASE_LOST_MESSAGE));
        }

        let persisted_checkpoint = if let Some(legacy) = adapter_execution.compatibility.as_ref() {
            let store = state.task_store.lock().map_err(runtime_lock_error)?;
            Some(
                store
                    .append_checkpoint(
                        &task.task_id,
                        &task.user_id,
                        &task.workspace_id,
                        legacy.checkpoint_payload.clone(),
                        legacy.checkpoint_redacted.clone(),
                    )
                    .map_err(runtime_store_error)?,
            )
        } else {
            None
        };

        let pre_commit_task = current_task(state, &task)?;
        if pre_commit_task.status != TaskStatus::Cancelled
            && pre_commit_task.lease_owner != task.lease_owner
        {
            return Err(runtime_error(LEASE_LOST_MESSAGE));
        }
        let externally_cancelled = pre_commit_task.status == TaskStatus::Cancelled;

        let outcome = if externally_cancelled {
            ExecutionOutcome::Cancelled {
                reason: CancelReason::User,
            }
        } else if let Some(outcome) = adapter_execution.canonical.take() {
            outcome
        } else {
            let legacy = adapter_execution
                .compatibility
                .as_ref()
                .expect("adapter execution must contain canonical or compatibility output");
            let checkpoint = persisted_checkpoint
                .as_ref()
                .expect("legacy adapter output always persists a checkpoint first");
            legacy_task_outcome_to_execution_outcome(state, &task, &contract, legacy, checkpoint)?
        };
        align_compatibility_with_canonical_outcome(
            adapter_execution.compatibility.as_mut(),
            &outcome,
        );
        let validated = ValidatedExecutionOutcome::new(outcome, &contract)
            .map_err(|error| runtime_error(error.to_string()))?;
        {
            let store = state.task_store.lock().map_err(runtime_lock_error)?;
            store
                .commit_execution_outcome(&validated)
                .map_err(runtime_store_error)?;
        }

        let projection = ExecutionProjection::from_outcome(validated.as_ref());
        Ok(ExecutionRuntimeResult {
            execution_id: contract.as_ref().execution_id.clone(),
            compatibility: adapter_execution.compatibility,
            projection,
        })
    }
}

fn align_compatibility_with_canonical_outcome(
    compatibility: Option<&mut TaskExecutionOutcome>,
    outcome: &ExecutionOutcome,
) {
    let Some(compatibility) = compatibility else {
        return;
    };
    match outcome {
        ExecutionOutcome::Completed { .. } => compatibility.completed = true,
        ExecutionOutcome::Suspended {
            wake: WakeCondition::At { unix_seconds },
            ..
        } if compatibility.wait_until.is_none() => {
            compatibility.wait_until = OffsetDateTime::from_unix_timestamp(*unix_seconds).ok();
        }
        ExecutionOutcome::Suspended { .. }
        | ExecutionOutcome::Cancelled { .. }
        | ExecutionOutcome::Failed { .. } => compatibility.completed = false,
    }
}

pub(crate) fn is_lease_lost_error(error: &LocalTaskExecutionError) -> bool {
    error.message == LEASE_LOST_MESSAGE
}

pub(crate) fn contract_for_acquired_task(
    task: &TaskRecord,
) -> Result<ValidatedExecutionContract, LocalTaskExecutionError> {
    if task.status != TaskStatus::Running || task.lease_owner.is_none() {
        return Err(runtime_error(
            "an execution contract can only be built from an acquired running task",
        ));
    }
    let thread_id = task
        .input_json
        .get("thread_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let mut contract = ExecutionContract::new(
        task.task_id.as_str(),
        task.kind.clone(),
        ExecutionScope {
            user_id: task.user_id.as_str().to_string(),
            workspace_id: task.workspace_id.as_str().to_string(),
            thread_id,
        },
        serde_json::to_value(task).map_err(|error| runtime_error(error.to_string()))?,
    );
    contract.fencing_token = acquired_task_fencing_token(task)?;
    contract.policy = execution_policy_for_task(task);
    contract.resources = task
        .resource_requirements
        .iter()
        .map(|requirement| ResourceRequirement {
            class: requirement.class.as_str().to_string(),
            units: requirement.units,
        })
        .collect();
    contract.budget = ExecutionBudget {
        max_attempts: task.retry_policy.max_attempts.max(1),
        backoff_seconds: task.retry_policy.backoff_seconds.max(0),
        deadline_unix_seconds: earliest_deadline(task),
    };
    ValidatedExecutionContract::try_from(contract).map_err(|error| runtime_error(error.to_string()))
}

fn task_from_contract(
    contract: &ValidatedExecutionContract,
) -> Result<TaskRecord, LocalTaskExecutionError> {
    serde_json::from_value(contract.as_ref().input.clone())
        .map_err(|error| runtime_error(format!("execution input is not a TaskRecord: {error}")))
}

fn current_task(
    state: &AppState,
    expected: &TaskRecord,
) -> Result<TaskRecord, LocalTaskExecutionError> {
    state
        .task_store
        .lock()
        .map_err(runtime_lock_error)?
        .get_task(&expected.task_id, &expected.user_id, &expected.workspace_id)
        .map_err(runtime_store_error)?
        .ok_or_else(|| runtime_error("the execution task disappeared before commit"))
}

fn validate_task_identity(
    task: &TaskRecord,
    contract: &ValidatedExecutionContract,
) -> Result<(), LocalTaskExecutionError> {
    let contract = contract.as_ref();
    let thread_id = task
        .input_json
        .get("thread_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    if task.task_id.as_str() != contract.execution_id
        || task.kind != contract.kind
        || task.user_id.as_str() != contract.scope.user_id
        || task.workspace_id.as_str() != contract.scope.workspace_id
        || thread_id != contract.scope.thread_id.as_deref()
        || acquired_task_fencing_token(task)? != contract.fencing_token
    {
        return Err(runtime_error(
            "execution contract identity does not match its acquired TaskRecord",
        ));
    }
    Ok(())
}

fn validate_authoritative_contract(
    task: &TaskRecord,
    authoritative: &ValidatedExecutionContract,
) -> Result<(), LocalTaskExecutionError> {
    let contract = authoritative.as_ref();
    let thread_id = task
        .input_json
        .get("thread_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    if task.task_id.as_str() != contract.execution_id
        || task.kind != contract.kind
        || task.user_id.as_str() != contract.scope.user_id
        || task.workspace_id.as_str() != contract.scope.workspace_id
        || thread_id != contract.scope.thread_id.as_deref()
    {
        return Err(runtime_error(
            "acquired TaskRecord identity or scope differs from the authoritative execution",
        ));
    }
    Ok(())
}

fn recovered_execution_result(
    task: &TaskRecord,
    outcome: &ExecutionOutcome,
) -> ExecutionRuntimeResult {
    ExecutionRuntimeResult {
        execution_id: task.task_id.as_str().to_string(),
        compatibility: Some(recovered_legacy_compatibility(task, outcome)),
        projection: ExecutionProjection::from_outcome(outcome),
    }
}

fn recovered_legacy_compatibility(
    task: &TaskRecord,
    outcome: &ExecutionOutcome,
) -> TaskExecutionOutcome {
    let (completed, blocked_reason, wait_until, pending_approval, summary) = match outcome {
        ExecutionOutcome::Completed { output, .. } => (
            true,
            None,
            None,
            None,
            output
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("Execution already completed.")
                .to_string(),
        ),
        ExecutionOutcome::Suspended { wake, .. } => match wake {
            WakeCondition::At { unix_seconds } => (
                false,
                Some("Execution is waiting for its durable wake.".to_string()),
                OffsetDateTime::from_unix_timestamp(*unix_seconds).ok(),
                None,
                "Execution already suspended.".to_string(),
            ),
            WakeCondition::Approval { approval_ref } => (
                false,
                Some("Execution is waiting for approval.".to_string()),
                None,
                Some(PendingExecutorApproval {
                    action: approval_ref.clone(),
                    risk_level: task.risk_level.clone(),
                    data_boundary: "execution_contract".to_string(),
                    explanation: "Execution is waiting for a previously registered approval."
                        .to_string(),
                    inline_action_card: false,
                }),
                "Execution already suspended for approval.".to_string(),
            ),
            _ => (
                false,
                Some("Execution is waiting for its durable wake.".to_string()),
                None,
                None,
                "Execution already suspended.".to_string(),
            ),
        },
        ExecutionOutcome::Cancelled { .. } => (
            false,
            Some("Execution was cancelled.".to_string()),
            None,
            None,
            "Execution already cancelled.".to_string(),
        ),
        ExecutionOutcome::Failed { failure } => (
            false,
            Some(failure.redacted_detail.clone()),
            None,
            None,
            "Execution already failed.".to_string(),
        ),
    };
    TaskExecutionOutcome {
        completed,
        blocked_reason,
        wait_until,
        pending_approval,
        summary: summary.clone(),
        checkpoint_payload: json!({"kind": "execution_recovered"}),
        checkpoint_redacted: json!({"kind": "execution_recovered"}),
        chat_message: summary,
        result_surfacing: TaskResultSurfacing::AlreadyPersisted,
        surface: SurfaceKind::Logs,
        event_kind: "execution_recovered".to_string(),
        event_title: "Execution recovered".to_string(),
        event_subtitle: "The canonical outcome was already committed.".to_string(),
        event_payload: json!({"execution_id": task.task_id.as_str()}),
        artifacts: Vec::new(),
    }
}

fn legacy_adapter_error_outcome(error: LocalTaskExecutionError) -> TaskExecutionOutcome {
    let detail = crate::redact_sensitive_text(&error.message);
    TaskExecutionOutcome {
        completed: false,
        blocked_reason: Some(detail.clone()),
        wait_until: None,
        pending_approval: None,
        summary: detail.clone(),
        checkpoint_payload: json!({
            "kind": "legacy_adapter_error",
            "detail": detail,
        }),
        checkpoint_redacted: json!({
            "kind": "legacy_adapter_error",
            "detail": detail,
        }),
        chat_message: detail.clone(),
        result_surfacing: TaskResultSurfacing::AlreadyPersisted,
        surface: SurfaceKind::Logs,
        event_kind: "execution_adapter_failed".to_string(),
        event_title: "Task execution failed".to_string(),
        event_subtitle: detail.clone(),
        event_payload: json!({"detail": detail}),
        artifacts: Vec::new(),
    }
}

fn acquired_task_fencing_token(task: &TaskRecord) -> Result<u64, LocalTaskExecutionError> {
    let acquired_at = task
        .last_heartbeat_at
        .ok_or_else(|| runtime_error("acquired task has no lease acquisition timestamp"))?;
    let token = u64::try_from(acquired_at.unix_timestamp_nanos())
        .map_err(|_| runtime_error("lease acquisition timestamp cannot be used as a fence"))?;
    if token == 0 || token > i64::MAX as u64 {
        return Err(runtime_error(
            "lease acquisition fence is outside the protocol range",
        ));
    }
    Ok(token)
}

fn earliest_deadline(task: &TaskRecord) -> Option<i64> {
    [task.deadline, task.expires_at]
        .into_iter()
        .flatten()
        .map(OffsetDateTime::unix_timestamp)
        .min()
}

fn execution_policy_for_task(task: &TaskRecord) -> ExecutionPolicy {
    let mut allowed_effects = vec![EffectClass::Read, EffectClass::RequestAuthorization];
    for (field, effect) in [
        ("allow_filesystem_write", EffectClass::FilesystemWrite),
        ("allow_artifact_creation", EffectClass::ArtifactCreation),
        ("allow_external_write", EffectClass::ExternalWrite),
    ] {
        if task
            .permission_context
            .get(field)
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            allowed_effects.push(effect);
        }
    }
    let approval_policy = if task
        .permission_context
        .get("preauthorized")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        ApprovalPolicy::Preauthorized
    } else {
        ApprovalPolicy::OnRequest
    };
    ExecutionPolicy {
        allowed_effects,
        approval_policy,
    }
}

// Temporary Task 5 compatibility bridge. Delete with the legacy task runner in Task 8.
fn legacy_task_outcome_to_execution_outcome(
    state: &AppState,
    task: &TaskRecord,
    contract: &ValidatedExecutionContract,
    legacy: &TaskExecutionOutcome,
    checkpoint: &local_first_task_runtime::TaskCheckpoint,
) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
    if legacy.completed {
        return Ok(ExecutionOutcome::completed(json!({
            "summary": legacy.summary,
            "checkpoint": legacy.checkpoint_redacted,
        })));
    }

    // Task 5 compatibility only: the chat executor still parks the task without returning a
    // typed stop. Task 6 removes this reread when chat returns a canonical stop directly.
    let persisted_task_status = state
        .task_store
        .lock()
        .map_err(runtime_lock_error)?
        .get_task(&task.task_id, &task.user_id, &task.workspace_id)
        .map_err(runtime_store_error)?
        .map(|task| task.status);
    let wake = if persisted_task_status == Some(TaskStatus::Parked) {
        WakeCondition::ModelAvailable {
            role: "primary".to_string(),
        }
    } else if let Some(approval) = legacy.pending_approval.as_ref() {
        WakeCondition::Approval {
            approval_ref: format!(
                "{}:{}:approval:{}",
                contract.as_ref().execution_id,
                contract.as_ref().revision,
                approval.action
            ),
        }
    } else if let Some(not_before) = legacy.wait_until {
        WakeCondition::At {
            unix_seconds: not_before.unix_timestamp(),
        }
    } else if task.attempt_count.saturating_add(1) < contract.as_ref().budget.max_attempts {
        WakeCondition::At {
            unix_seconds: OffsetDateTime::now_utc()
                .saturating_add(time::Duration::seconds(
                    contract.as_ref().budget.backoff_seconds,
                ))
                .unix_timestamp(),
        }
    } else {
        return Ok(ExecutionOutcome::Failed {
            failure: ExecutionFailure::permanent(
                "legacy_task_incomplete",
                legacy
                    .blocked_reason
                    .as_deref()
                    .unwrap_or("legacy task did not produce a successful outcome"),
            ),
        });
    };

    let record_ref = DurableDataRef::from_store_id(&checkpoint.checkpoint_id)
        .map_err(|error| runtime_error(error.to_string()))?;
    Ok(ExecutionOutcome::Suspended {
        wake,
        checkpoint: CheckpointEnvelope::new(
            contract.as_ref().execution_id.clone(),
            contract.as_ref().revision,
            contract.as_ref().kind.clone(),
            1,
            CheckpointDataRef::Redacted { record_ref },
        ),
    })
}

fn runtime_store_error(error: TaskRuntimeError) -> LocalTaskExecutionError {
    runtime_error(error.to_string())
}

fn runtime_lock_error<T>(error: std::sync::PoisonError<T>) -> LocalTaskExecutionError {
    runtime_error(error.to_string())
}

fn runtime_error(message: impl Into<String>) -> LocalTaskExecutionError {
    LocalTaskExecutionError {
        message: message.into(),
    }
}

macro_rules! legacy_adapter {
    ($name:ident, $label:literal, $execute:expr) => {
        struct $name;

        impl GatewayExecutionAdapter for $name {
            fn name(&self) -> &'static str {
                $label
            }

            fn execute<'a>(
                &'a self,
                state: &'a AppState,
                contract: &'a ValidatedExecutionContract,
            ) -> BoxFuture<'a, Result<AdapterExecution, LocalTaskExecutionError>> {
                Box::pin(async move {
                    let task = task_from_contract(contract)?;
                    ($execute)(state, &task).map(AdapterExecution::legacy)
                })
            }
        }
    };
}

legacy_adapter!(
    CapabilityBrowserAdapter,
    "capability_browser",
    |state, task| { execute_capability_browser_task(state, task) }
);
legacy_adapter!(CapabilityAdapter, "capability", |state, task| {
    execute_capability_generic(state, task)
});
legacy_adapter!(SubagentAdapter, "subagent", |_state, task| {
    execute_subagent_task(task)
});
legacy_adapter!(ProactivePromptAdapter, "proactive_prompt", |state, task| {
    execute_proactive_prompt_task(state, task)
});
legacy_adapter!(ChatTurnAdapter, "chat_turn", |state, task| {
    crate::turn_executor::execute_chat_turn_task(state, task)
});
legacy_adapter!(LegacyShellAdapter, "legacy_shell", |_state, task| {
    execute_shell_read_only_task(task)
});
legacy_adapter!(LegacyLocalAdapter, "legacy_local", |_state, task| {
    execute_local_read_only_task(task)
});

#[cfg(test)]
mod tests {
    use super::{AdapterExecution, ExecutionRuntime, GatewayExecutionAdapter};
    use crate::task_registry::TaskExecutorRegistry;
    use crate::{AppState, LocalTaskExecutionError, TaskRecord};
    use crate::{SurfaceKind, TaskExecutionOutcome, TaskResultSurfacing};
    use futures_util::future::BoxFuture;
    use local_first_execution_protocol::{
        CheckpointDataRef, CheckpointEnvelope, DurableDataRef, ExecutionContract, ExecutionOutcome,
        ExecutionScope, ValidatedExecutionContract, ValidatedExecutionOutcome, WakeCondition,
    };
    use local_first_task_runtime::{ExecutionProjection, TaskStatus, UserId, WorkspaceId};
    use std::sync::{Arc, Mutex};
    use time::{Duration, OffsetDateTime};

    struct RecordingAdapter {
        execution_ids: Arc<Mutex<Vec<String>>>,
    }

    struct RevisionRecordingAdapter {
        revisions: Arc<Mutex<Vec<(String, u64, u64, bool)>>>,
    }

    impl GatewayExecutionAdapter for RevisionRecordingAdapter {
        fn execute<'a>(
            &'a self,
            _state: &'a AppState,
            contract: &'a ValidatedExecutionContract,
        ) -> BoxFuture<'a, Result<AdapterExecution, LocalTaskExecutionError>> {
            Box::pin(async move {
                let contract = contract.as_ref();
                self.revisions.lock().expect("revision adapter lock").push((
                    contract.execution_id.clone(),
                    contract.revision,
                    contract.fencing_token,
                    contract.wake.is_some(),
                ));
                Ok(AdapterExecution::canonical(ExecutionOutcome::completed(
                    serde_json::json!({"revision": contract.revision}),
                )))
            })
        }
    }

    struct SuspendingLegacyAdapter;

    impl GatewayExecutionAdapter for SuspendingLegacyAdapter {
        fn execute<'a>(
            &'a self,
            _state: &'a AppState,
            _contract: &'a ValidatedExecutionContract,
        ) -> BoxFuture<'a, Result<AdapterExecution, LocalTaskExecutionError>> {
            Box::pin(async move {
                Ok(AdapterExecution::legacy(TaskExecutionOutcome {
                    completed: false,
                    blocked_reason: Some("wait for timer".to_string()),
                    wait_until: Some(OffsetDateTime::now_utc() + Duration::minutes(1)),
                    pending_approval: None,
                    summary: "waiting".to_string(),
                    checkpoint_payload: serde_json::json!({"secret": "raw"}),
                    checkpoint_redacted: serde_json::json!({"secret": "[REDACTED]"}),
                    chat_message: String::new(),
                    result_surfacing: TaskResultSurfacing::AlreadyPersisted,
                    surface: SurfaceKind::Logs,
                    event_kind: "test_wait".to_string(),
                    event_title: "Waiting".to_string(),
                    event_subtitle: "Waiting".to_string(),
                    event_payload: serde_json::json!({}),
                    artifacts: Vec::new(),
                }))
            })
        }
    }

    struct LeaseStealingAdapter;

    impl GatewayExecutionAdapter for LeaseStealingAdapter {
        fn execute<'a>(
            &'a self,
            state: &'a AppState,
            contract: &'a ValidatedExecutionContract,
        ) -> BoxFuture<'a, Result<AdapterExecution, LocalTaskExecutionError>> {
            Box::pin(async move {
                let mut task = super::task_from_contract(contract).expect("task from contract");
                task.lease_owner = Some("replacement-worker".to_string());
                state
                    .task_store
                    .lock()
                    .expect("task store")
                    .insert_task(&task)
                    .expect("replace lease owner");
                Ok(AdapterExecution::canonical(ExecutionOutcome::completed(
                    serde_json::json!({"must_not_commit": true}),
                )))
            })
        }
    }

    struct FailingAdapter;

    impl GatewayExecutionAdapter for FailingAdapter {
        fn execute<'a>(
            &'a self,
            _state: &'a AppState,
            _contract: &'a ValidatedExecutionContract,
        ) -> BoxFuture<'a, Result<AdapterExecution, LocalTaskExecutionError>> {
            Box::pin(async {
                Err(LocalTaskExecutionError {
                    message: "provider temporarily unavailable".to_string(),
                })
            })
        }
    }

    impl GatewayExecutionAdapter for RecordingAdapter {
        fn execute<'a>(
            &'a self,
            _state: &'a AppState,
            contract: &'a ValidatedExecutionContract,
        ) -> BoxFuture<'a, Result<AdapterExecution, LocalTaskExecutionError>> {
            Box::pin(async move {
                self.execution_ids
                    .lock()
                    .expect("recording adapter lock")
                    .push(contract.as_ref().execution_id.clone());
                Ok(AdapterExecution::canonical(ExecutionOutcome::completed(
                    serde_json::json!({"execution_id": contract.as_ref().execution_id}),
                )))
            })
        }
    }

    fn contract(kind: &str, execution_id: &str) -> ValidatedExecutionContract {
        let mut task = TaskRecord::new(
            execution_id,
            UserId::new("user-1"),
            WorkspaceId::new("workspace-1"),
            kind,
            "test",
            serde_json::json!({}),
        );
        task.status = local_first_task_runtime::TaskStatus::Running;
        task.lease_owner = Some("test-worker".to_string());
        task.last_heartbeat_at = Some(time::OffsetDateTime::now_utc());
        let mut contract = ExecutionContract::new(
            execution_id,
            kind,
            ExecutionScope {
                user_id: "user-1".to_string(),
                workspace_id: "workspace-1".to_string(),
                thread_id: None,
            },
            serde_json::to_value(task).expect("serialize task"),
        );
        contract.fencing_token = super::acquired_task_fencing_token(
            serde_json::from_value::<TaskRecord>(contract.input.clone())
                .as_ref()
                .expect("deserialize task"),
        )
        .expect("task fence");
        contract.try_into().expect("valid contract")
    }

    fn insert_contract_task(state: &AppState, contract: &ValidatedExecutionContract) {
        let task = super::task_from_contract(contract).expect("task from contract");
        state
            .task_store
            .lock()
            .expect("task store")
            .insert_task(&task)
            .expect("insert acquired task");
    }

    #[tokio::test]
    async fn all_kinds_use_the_same_execute_entry_point_and_preserve_execution_id() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let adapter: Arc<dyn GatewayExecutionAdapter> = Arc::new(RecordingAdapter {
            execution_ids: calls.clone(),
        });
        let mut registry = TaskExecutorRegistry::new();
        registry.register("chat_turn", adapter.clone());
        registry.register("proactive_prompt", adapter.clone());
        registry.register("capability.*", adapter);
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();

        for (kind, execution_id) in [
            ("chat_turn", "turn-1"),
            ("proactive_prompt", "proactive-1"),
            ("capability.github.search", "capability-1"),
        ] {
            let contract = contract(kind, execution_id);
            insert_contract_task(&state, &contract);
            let result = runtime
                .execute(&state, contract)
                .await
                .expect("execute through runtime");
            assert_eq!(result.execution_id(), execution_id);
        }

        assert_eq!(
            *calls.lock().expect("recorded calls"),
            vec!["turn-1", "proactive-1", "capability-1"]
        );
    }

    #[tokio::test]
    async fn committed_outcome_is_recovered_without_rerunning_adapter() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut registry = TaskExecutorRegistry::new();
        registry.register(
            "*",
            Arc::new(RecordingAdapter {
                execution_ids: calls.clone(),
            }),
        );
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let first = contract("capability.test", "idempotent-1");
        insert_contract_task(&state, &first);

        runtime
            .execute(&state, first)
            .await
            .expect("first execution");
        let retry = contract("capability.test", "idempotent-1");
        insert_contract_task(&state, &retry);
        let recovered = runtime
            .execute(&state, retry)
            .await
            .expect("recover committed execution");

        assert_eq!(calls.lock().expect("calls").len(), 1);
        assert_eq!(
            recovered.projection(),
            ExecutionProjection::from_outcome(&ExecutionOutcome::completed(
                serde_json::Value::Null
            ))
        );
    }

    #[tokio::test]
    async fn wake_revision_is_dispatched_unchanged_then_claims_newer_lease_fence() {
        let revisions = Arc::new(Mutex::new(Vec::new()));
        let mut registry = TaskExecutorRegistry::new();
        registry.register(
            "*",
            Arc::new(RevisionRecordingAdapter {
                revisions: revisions.clone(),
            }),
        );
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let first = contract("capability.test", "resume-1");
        insert_contract_task(&state, &first);
        let wake_at = OffsetDateTime::now_utc() - Duration::seconds(1);
        let suspended = ExecutionOutcome::Suspended {
            wake: WakeCondition::At {
                unix_seconds: wake_at.unix_timestamp(),
            },
            checkpoint: CheckpointEnvelope::new(
                "resume-1",
                1,
                "capability.test",
                1,
                CheckpointDataRef::Redacted {
                    record_ref: DurableDataRef::from_store_id("0123456789abcdef0123456789abcdef")
                        .expect("durable ref"),
                },
            ),
        };
        {
            let store = state.task_store.lock().expect("task store");
            store.create_execution(&first).expect("create execution");
            store
                .commit_execution_outcome(
                    &ValidatedExecutionOutcome::new(suspended, &first)
                        .expect("validated suspension"),
                )
                .expect("commit suspension");
            assert_eq!(
                store
                    .wake_due_executions(OffsetDateTime::now_utc(), 1)
                    .expect("deliver timer"),
                1
            );
        }
        let mut acquired = super::task_from_contract(&first).expect("first task");
        acquired.status = TaskStatus::Running;
        acquired.last_heartbeat_at = Some(OffsetDateTime::now_utc() + Duration::seconds(1));
        let requested = super::contract_for_acquired_task(&acquired).expect("requested contract");
        insert_contract_task(&state, &requested);
        let claimed_fence = requested.as_ref().fencing_token;

        runtime
            .execute(&state, requested)
            .await
            .expect("execute resumed revision");

        assert_eq!(
            *revisions.lock().expect("revisions"),
            vec![("resume-1".to_string(), 2, claimed_fence, true)]
        );
        let stored = state
            .task_store
            .lock()
            .expect("task store")
            .execution("resume-1")
            .expect("load execution")
            .expect("execution exists");
        assert_eq!(stored.contract.as_ref().revision, 2);
        assert_eq!(stored.contract.as_ref().fencing_token, claimed_fence);
    }

    #[tokio::test]
    async fn suspended_outcome_references_the_persisted_task_checkpoint() {
        let mut registry = TaskExecutorRegistry::new();
        registry.register("*", Arc::new(SuspendingLegacyAdapter));
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let contract = contract("capability.test", "checkpoint-1");
        insert_contract_task(&state, &contract);

        runtime
            .execute(&state, contract)
            .await
            .expect("suspend execution");

        let store = state.task_store.lock().expect("task store");
        let execution = store
            .execution("checkpoint-1")
            .expect("load execution")
            .expect("execution exists");
        let record_ref = match execution
            .outcome
            .as_ref()
            .expect("committed outcome")
            .as_ref()
        {
            ExecutionOutcome::Suspended {
                checkpoint:
                    CheckpointEnvelope {
                        data_ref: CheckpointDataRef::Redacted { record_ref },
                        ..
                    },
                ..
            } => record_ref.as_ref(),
            other => panic!("expected suspended outcome, got {other:?}"),
        };
        let store_id = record_ref
            .strip_prefix("durable:v1:32:")
            .expect("durable reference prefix");
        assert_eq!(store_id.len(), 32);
        assert!(
            store_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        );
        let checkpoint = store
            .latest_checkpoint(
                &local_first_task_runtime::TaskId::new("checkpoint-1"),
                &UserId::new("user-1"),
                &WorkspaceId::new("workspace-1"),
            )
            .expect("load checkpoint")
            .expect("checkpoint exists");
        assert_eq!(checkpoint.checkpoint_id, store_id);
    }

    #[tokio::test]
    async fn stolen_lease_cannot_commit_the_adapter_outcome() {
        let mut registry = TaskExecutorRegistry::new();
        registry.register("*", Arc::new(LeaseStealingAdapter));
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let contract = contract("capability.test", "stolen-lease-1");
        insert_contract_task(&state, &contract);

        let error = match runtime.execute(&state, contract).await {
            Ok(_) => panic!("stolen lease must fail before commit"),
            Err(error) => error,
        };

        assert!(super::is_lease_lost_error(&error));
        let execution = state
            .task_store
            .lock()
            .expect("task store")
            .execution("stolen-lease-1")
            .expect("load execution")
            .expect("execution exists");
        assert_eq!(
            execution.state,
            local_first_execution_protocol::ExecutionState::Ready
        );
        assert!(execution.outcome.is_none());
    }

    #[tokio::test]
    async fn adapter_error_is_committed_as_budgeted_suspension_with_checkpoint() {
        let mut registry = TaskExecutorRegistry::new();
        registry.register("*", Arc::new(FailingAdapter));
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let initial = contract("capability.test", "adapter-retry-1");
        let mut task = super::task_from_contract(&initial).expect("task from contract");
        task.retry_policy.max_attempts = 2;
        task.retry_policy.backoff_seconds = 30;
        let contract = super::contract_for_acquired_task(&task).expect("retry contract");
        insert_contract_task(&state, &contract);

        let result = runtime
            .execute(&state, contract)
            .await
            .expect("adapter error becomes canonical outcome");

        assert_eq!(result.projection().task_status, TaskStatus::WaitingTime);
        assert!(
            result
                .compatibility
                .as_ref()
                .expect("compatibility outcome")
                .wait_until
                .is_some()
        );
        let store = state.task_store.lock().expect("task store");
        let execution = store
            .execution("adapter-retry-1")
            .expect("load execution")
            .expect("execution exists");
        assert!(matches!(
            execution.outcome.expect("outcome").as_ref(),
            ExecutionOutcome::Suspended {
                wake: WakeCondition::At { .. },
                ..
            }
        ));
        assert!(
            store
                .latest_checkpoint(
                    &local_first_task_runtime::TaskId::new("adapter-retry-1"),
                    &UserId::new("user-1"),
                    &WorkspaceId::new("workspace-1"),
                )
                .expect("load checkpoint")
                .is_some()
        );
    }

    #[tokio::test]
    async fn exhausted_adapter_error_is_committed_as_failed() {
        let mut registry = TaskExecutorRegistry::new();
        registry.register("*", Arc::new(FailingAdapter));
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let contract = contract("capability.test", "adapter-failed-1");
        insert_contract_task(&state, &contract);

        let result = runtime
            .execute(&state, contract)
            .await
            .expect("adapter error becomes terminal outcome");

        assert_eq!(result.projection().task_status, TaskStatus::Failed);
        let execution = state
            .task_store
            .lock()
            .expect("task store")
            .execution("adapter-failed-1")
            .expect("load execution")
            .expect("execution exists");
        assert!(matches!(
            execution.outcome.expect("outcome").as_ref(),
            ExecutionOutcome::Failed { .. }
        ));
    }
}
