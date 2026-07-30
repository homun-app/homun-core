use crate::execution_adapter_context::ExecutionAdapterContext;
use crate::execution_control::{ExecutionAttemptControl, ExecutionInterruption};
use crate::execution_host::GatewayExecutionHost;
use crate::task_registry::TaskExecutorRegistry;
use crate::{
    AppState, LocalTaskExecutionError, PendingExecutorApproval, SurfaceKind,
    TaskExecutionPresentation, TaskRecord, TaskResultSurfacing, TaskStatus,
};
use local_first_execution_protocol::{
    ApprovalPolicy, CancelReason, CheckpointDataRef, CheckpointEnvelope, DurableDataRef,
    EffectClass, ExecutionBudget, ExecutionContract, ExecutionFailure, ExecutionOutcome,
    ExecutionPolicy, ExecutionScope, ExecutionState, FailureClass, ResourceRequirement,
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

    fn execute(
        &self,
        context: &ExecutionAdapterContext,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError>;
}

pub(crate) struct ExecutionRuntimeResult {
    execution_id: String,
    projection: ExecutionProjection,
    outcome: ExecutionOutcome,
}

impl ExecutionRuntimeResult {
    pub(crate) fn execution_id(&self) -> &str {
        &self.execution_id
    }

    pub(crate) fn projection(&self) -> ExecutionProjection {
        self.projection
    }

    pub(crate) fn outcome(&self) -> &ExecutionOutcome {
        &self.outcome
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
        registry.register("local_shell_task", Arc::new(ShellReadOnlyAdapter));
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
        let attempt_owner = task
            .lease_owner
            .as_deref()
            .ok_or_else(|| runtime_error("acquired task has no lease owner"))?;

        let recovered = {
            let store = state.task_store.lock().map_err(runtime_lock_error)?;
            store
                .execution(requested_contract.as_ref().execution_id.as_str())
                .map_err(runtime_store_error)?
                .and_then(|record| record.outcome.map(|outcome| (record.contract, outcome)))
        };
        if let Some((contract, outcome)) = recovered {
            validate_authoritative_contract(&task, &contract)?;
            crate::projection_worker::notify();
            return Ok(recovered_execution_result(&task, outcome.as_ref()));
        }

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
                    let authoritative = record.contract.as_ref();
                    if acquired_fence < authoritative.fencing_token {
                        return Err(runtime_error(
                            "acquired task lease fence is older than the authoritative execution fence",
                        ));
                    }
                    if record.state == ExecutionState::Running
                        && acquired_fence > authoritative.fencing_token
                    {
                        store
                            .reclaim_execution_attempt(
                                &authoritative.execution_id,
                                authoritative.revision,
                                authoritative.fencing_token,
                                acquired_fence,
                                attempt_owner,
                            )
                            .map_err(runtime_store_error)?
                            .contract
                    } else if record.state == ExecutionState::Running {
                        record.contract
                    } else if record.state != ExecutionState::Ready {
                        return Err(runtime_error(
                            "only a ready or running authoritative execution revision can be dispatched",
                        ));
                    } else if acquired_fence > authoritative.fencing_token {
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
        let contract = {
            let store = state.task_store.lock().map_err(runtime_lock_error)?;
            store
                .start_execution_attempt(
                    &contract.as_ref().execution_id,
                    contract.as_ref().revision,
                    contract.as_ref().fencing_token,
                    attempt_owner,
                )
                .map_err(runtime_store_error)?
                .contract
        };

        let adapter_outcome = if contract_deadline_reached(&contract, OffsetDateTime::now_utc()) {
            deadline_exceeded_outcome("Execution deadline elapsed before adapter dispatch.")
        } else {
            match self.registry.resolve(&contract.as_ref().kind) {
                Some(adapter) => {
                    let control = Arc::new(ExecutionAttemptControl::default());
                    let monitor = tokio::spawn(monitor_execution_attempt(
                        state.clone(),
                        task.clone(),
                        contract.clone(),
                        control.clone(),
                    ));
                    let host = Arc::new(GatewayExecutionHost::new(state.clone()));
                    let adapter_context =
                        ExecutionAdapterContext::new(host, contract.clone(), control);
                    let outcome = if let Err(error) = adapter_context.authorize_declared_effects() {
                        ExecutionOutcome::Failed {
                            failure: ExecutionFailure::permanent(
                                "execution_policy_denied",
                                crate::redact_sensitive_text(&error.message),
                            ),
                        }
                    } else {
                        let adapter_result =
                            tokio::task::spawn_blocking(move || adapter.execute(&adapter_context))
                                .await
                                .map_err(|error| {
                                    runtime_error(format!("execution adapter join error: {error}"))
                                });
                        match adapter_result {
                            Ok(Ok(outcome)) => outcome,
                            Ok(Err(error)) | Err(error) => ExecutionOutcome::Failed {
                                failure: ExecutionFailure::transient(
                                    "execution_adapter_failed",
                                    crate::redact_sensitive_text(&error.message),
                                ),
                            },
                        }
                    };
                    monitor.abort();
                    let _ = monitor.await;
                    outcome
                }
                None => ExecutionOutcome::Failed {
                    failure: ExecutionFailure::permanent(
                        "unsupported_execution_kind",
                        format!(
                            "No execution adapter is registered for kind `{}`.",
                            contract.as_ref().kind
                        ),
                    ),
                },
            }
        };

        let pre_commit_task = current_task(state, &task)?;
        if pre_commit_task.status != TaskStatus::Cancelled
            && !same_lease_generation(&pre_commit_task, &task)
        {
            return Err(runtime_error(LEASE_LOST_MESSAGE));
        }
        let externally_cancelled = pre_commit_task.status == TaskStatus::Cancelled;

        let outcome = if externally_cancelled {
            ExecutionOutcome::Cancelled {
                reason: CancelReason::User,
            }
        } else if contract_deadline_reached(&contract, OffsetDateTime::now_utc()) {
            deadline_exceeded_outcome("Execution deadline elapsed while the adapter was running.")
        } else {
            adapter_outcome
        };
        let outcome = normalize_transient_failure(state, &task, &contract, outcome)?;
        let validated = ValidatedExecutionOutcome::new(outcome, &contract)
            .map_err(|error| runtime_error(error.to_string()))?;
        {
            let store = state.task_store.lock().map_err(runtime_lock_error)?;
            store
                .commit_running_execution_outcome(&validated)
                .map_err(runtime_store_error)?;
        }
        crate::projection_worker::notify();

        let projection = ExecutionProjection::from_outcome(validated.as_ref());
        Ok(ExecutionRuntimeResult {
            execution_id: contract.as_ref().execution_id.clone(),
            projection,
            outcome: validated.as_ref().clone(),
        })
    }
}

async fn monitor_execution_attempt(
    state: AppState,
    expected: TaskRecord,
    contract: ValidatedExecutionContract,
    control: Arc<ExecutionAttemptControl>,
) {
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

    loop {
        match current_task(&state, &expected) {
            Ok(current) if current.status == TaskStatus::Cancelled => {
                control.signal(ExecutionInterruption::Cancelled);
                return;
            }
            Ok(current) if !same_lease_generation(&current, &expected) => {
                control.signal(ExecutionInterruption::LeaseLost);
                return;
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(
                    target: "execution::runtime",
                    execution_id = %contract.as_ref().execution_id,
                    error = %error.message,
                    "attempt monitor could not verify lease ownership"
                );
                control.signal(ExecutionInterruption::LeaseLost);
                return;
            }
        }
        if contract_deadline_reached(&contract, OffsetDateTime::now_utc()) {
            control.signal(ExecutionInterruption::DeadlineExceeded);
            return;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub(crate) fn should_project_chat(
    state: &AppState,
    task: &TaskRecord,
    outcome: &ExecutionOutcome,
) -> Result<bool, LocalTaskExecutionError> {
    if task.kind == "chat_turn" {
        return Ok(task
            .input_json
            .get("thread_id")
            .and_then(Value::as_str)
            .is_some()
            || matches!(
                outcome,
                ExecutionOutcome::Completed { output, .. }
                    if output.get("kind").and_then(Value::as_str) == Some("chat_turn")
            ));
    }
    let checkpoint = state
        .task_store
        .lock()
        .map_err(runtime_lock_error)?
        .latest_checkpoint(&task.task_id, &task.user_id, &task.workspace_id)
        .map_err(runtime_store_error)?;
    let metadata = checkpoint
        .as_ref()
        .and_then(|checkpoint| checkpoint.payload.get("state"));
    Ok(metadata.is_some_and(|metadata| {
        metadata.get("kind").and_then(Value::as_str) == Some("proactive_prompt")
            && metadata.get("thread_id").and_then(Value::as_str).is_some()
            && metadata
                .get("assistant_message_id")
                .and_then(Value::as_str)
                .is_some()
    }))
}

fn normalize_transient_failure(
    state: &AppState,
    task: &TaskRecord,
    contract: &ValidatedExecutionContract,
    outcome: ExecutionOutcome,
) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
    let ExecutionOutcome::Failed { failure } = outcome else {
        return Ok(outcome);
    };
    if failure.class != FailureClass::Transient
        || task.attempt_count.saturating_add(1) >= contract.as_ref().budget.max_attempts
    {
        return Ok(ExecutionOutcome::Failed { failure });
    }

    let store = state.task_store.lock().map_err(runtime_lock_error)?;
    let checkpoint = match store
        .latest_checkpoint(&task.task_id, &task.user_id, &task.workspace_id)
        .map_err(runtime_store_error)?
    {
        Some(checkpoint) => checkpoint,
        None => store
            .append_checkpoint(
                &task.task_id,
                &task.user_id,
                &task.workspace_id,
                json!({
                    "kind": "runtime_transient_failure",
                    "code": failure.code,
                    "detail": failure.redacted_detail,
                }),
                json!({
                    "kind": "runtime_transient_failure",
                    "code": failure.code,
                    "detail": failure.redacted_detail,
                }),
            )
            .map_err(runtime_store_error)?,
    };
    let record_ref = DurableDataRef::from_store_id(&checkpoint.checkpoint_id)
        .map_err(|error| runtime_error(error.to_string()))?;
    let retry_at = OffsetDateTime::now_utc()
        .saturating_add(time::Duration::seconds(
            contract.as_ref().budget.backoff_seconds,
        ))
        .unix_timestamp();
    if contract
        .as_ref()
        .budget
        .deadline_unix_seconds
        .is_some_and(|deadline| retry_at >= deadline)
    {
        return Ok(deadline_exceeded_outcome(
            "Execution cannot be retried before its deadline.",
        ));
    }
    let wake = WakeCondition::At {
        unix_seconds: retry_at,
    };
    let effect_receipts = store
        .list_effect_receipts_for_execution(
            &contract.as_ref().execution_id,
            contract.as_ref().revision,
        )
        .map_err(runtime_store_error)?
        .into_iter()
        .map(|receipt| receipt.receipt_ref)
        .collect();
    Ok(ExecutionOutcome::Suspended {
        wake: wake.clone(),
        checkpoint: CheckpointEnvelope::new(
            contract.as_ref().execution_id.clone(),
            contract.as_ref().revision,
            contract.as_ref().kind.clone(),
            1,
            CheckpointDataRef::Redacted { record_ref },
        )
        .with_resume_context(contract.as_ref().objective.clone(), wake, effect_receipts),
    })
}

fn contract_deadline_reached(contract: &ValidatedExecutionContract, now: OffsetDateTime) -> bool {
    contract
        .as_ref()
        .budget
        .deadline_unix_seconds
        .is_some_and(|deadline| now.unix_timestamp() >= deadline)
}

fn deadline_exceeded_outcome(detail: &'static str) -> ExecutionOutcome {
    ExecutionOutcome::Failed {
        failure: ExecutionFailure::permanent("execution_deadline_exceeded", detail),
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
    let mut contract_task = task.clone();
    let mut thread_id = task
        .input_json
        .get("thread_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    if task.kind == "proactive_prompt" && thread_id.is_none() {
        let source = task
            .input_json
            .get("thread_source")
            .or_else(|| task.input_json.get("source"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("scheduled");
        let (_, derived_thread_id) = crate::proactive_thread_scope(task.task_id.as_str(), source);
        let mut input = contract_task
            .input_json
            .as_object()
            .cloned()
            .unwrap_or_default();
        input.insert(
            "thread_id".to_string(),
            Value::String(derived_thread_id.clone()),
        );
        contract_task.input_json = Value::Object(input);
        thread_id = Some(derived_thread_id);
    }
    let mut contract = ExecutionContract::new(
        task.task_id.as_str(),
        task.kind.clone(),
        ExecutionScope {
            user_id: task.user_id.as_str().to_string(),
            workspace_id: task.workspace_id.as_str().to_string(),
            thread_id,
        },
        serde_json::to_value(contract_task).map_err(|error| runtime_error(error.to_string()))?,
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

fn same_lease_generation(current: &TaskRecord, expected: &TaskRecord) -> bool {
    current.lease_owner == expected.lease_owner
        && current.effective_lease_fencing_token() == expected.effective_lease_fencing_token()
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
        projection: ExecutionProjection::from_outcome(outcome),
        outcome: outcome.clone(),
    }
}

pub(crate) fn task_execution_presentation(
    state: &AppState,
    task: &TaskRecord,
    outcome: &ExecutionOutcome,
) -> Result<TaskExecutionPresentation, LocalTaskExecutionError> {
    if matches!(outcome, ExecutionOutcome::Cancelled { .. }) {
        return Ok(default_task_presentation(task, outcome));
    }
    let checkpoint = state
        .task_store
        .lock()
        .map_err(runtime_lock_error)?
        .latest_checkpoint(&task.task_id, &task.user_id, &task.workspace_id)
        .map_err(runtime_store_error)?;
    if let Some(presentation) = checkpoint
        .as_ref()
        .and_then(|checkpoint| checkpoint.payload.get("presentation"))
        .and_then(|value| serde_json::from_value(value.clone()).ok())
    {
        return Ok(presentation);
    }
    Ok(default_task_presentation(task, outcome))
}

fn default_task_presentation(
    task: &TaskRecord,
    outcome: &ExecutionOutcome,
) -> TaskExecutionPresentation {
    let (summary, pending_approval) = match outcome {
        ExecutionOutcome::Completed { output, .. } => (
            output
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("Execution completed.")
                .to_string(),
            None,
        ),
        ExecutionOutcome::Suspended {
            wake: WakeCondition::Approval { approval_ref },
            ..
        } => (
            "Execution is waiting for approval.".to_string(),
            Some(PendingExecutorApproval {
                action: approval_ref.clone(),
                risk_level: task.risk_level.clone(),
                data_boundary: "execution_contract".to_string(),
                explanation: "Execution is waiting for a registered approval.".to_string(),
                inline_action_card: false,
            }),
        ),
        ExecutionOutcome::Suspended { .. } => (
            "Execution is waiting for its durable wake.".to_string(),
            None,
        ),
        ExecutionOutcome::Cancelled { .. } => ("Execution was cancelled.".to_string(), None),
        ExecutionOutcome::Failed { failure } => (failure.redacted_detail.clone(), None),
    };
    TaskExecutionPresentation {
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

fn acquired_task_fencing_token(task: &TaskRecord) -> Result<u64, LocalTaskExecutionError> {
    let token = task
        .effective_lease_fencing_token()
        .ok_or_else(|| runtime_error("acquired task has no lease fencing token"))?;
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

pub(crate) fn execution_policy_for_task(task: &TaskRecord) -> ExecutionPolicy {
    let mut allowed_effects = vec![EffectClass::Read, EffectClass::RequestAuthorization];
    let chat_approval = (task.kind == "chat_turn")
        .then(|| task.input_json.get("approval").and_then(Value::as_str))
        .flatten();
    if matches!(chat_approval, Some("full" | "confirm" | "autonomous")) {
        for effect in [
            EffectClass::FilesystemWrite,
            EffectClass::ArtifactCreation,
            EffectClass::ExternalWrite,
        ] {
            push_effect(&mut allowed_effects, effect);
        }
    }

    // A read-only chat turn cannot be widened by stale or copied permission metadata.
    // Non-chat adapters and writable chat turns retain the existing explicit permission mapping.
    if chat_approval != Some("read_only") {
        if let Some(effects) = task
            .permission_context
            .get("allowed_effects")
            .and_then(Value::as_array)
        {
            for effect in effects
                .iter()
                .filter_map(Value::as_str)
                .filter_map(effect_class_from_str)
            {
                push_effect(&mut allowed_effects, effect);
            }
        }
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
                push_effect(&mut allowed_effects, effect);
            }
        }
    }

    let allowed_actions = task
        .permission_context
        .get("allowed_actions")
        .and_then(Value::as_array);
    let permits_approved_automation = allowed_actions.is_some_and(|actions| {
        actions
            .iter()
            .filter_map(Value::as_str)
            .any(|action| action == "approved_automation")
    });
    let permits_external_write = allowed_actions.is_some_and(|actions| {
        actions
            .iter()
            .filter_map(Value::as_str)
            .any(|action| matches!(action, "write_with_confirmation" | "approved_automation"))
    });
    if permits_external_write && chat_approval != Some("read_only") {
        push_effect(&mut allowed_effects, EffectClass::ExternalWrite);
    }

    let explicitly_preauthorized = task
        .permission_context
        .get("preauthorized")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let approval_required = task
        .permission_context
        .get("requires_user_approval")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let autonomy_level = task
        .permission_context
        .get("max_autonomy_level")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let approval_policy = if chat_approval == Some("read_only") {
        ApprovalPolicy::OnRequest
    } else if chat_approval == Some("autonomous")
        || explicitly_preauthorized
        || (permits_approved_automation && autonomy_level >= 4 && !approval_required)
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

fn effect_class_from_str(value: &str) -> Option<EffectClass> {
    match value {
        "read" => Some(EffectClass::Read),
        "filesystem_write" => Some(EffectClass::FilesystemWrite),
        "artifact_creation" => Some(EffectClass::ArtifactCreation),
        "external_write" => Some(EffectClass::ExternalWrite),
        "request_authorization" => Some(EffectClass::RequestAuthorization),
        _ => None,
    }
}

fn push_effect(allowed_effects: &mut Vec<EffectClass>, effect: EffectClass) {
    if !allowed_effects.contains(&effect) {
        allowed_effects.push(effect);
    }
}

fn persist_task_execution_checkpoint(
    state: &AppState,
    task: &TaskRecord,
    presentation: &TaskExecutionPresentation,
) -> Result<local_first_task_runtime::TaskCheckpoint, LocalTaskExecutionError> {
    let mut redacted_presentation = presentation.clone();
    redacted_presentation.checkpoint_payload = presentation.checkpoint_redacted.clone();
    redacted_presentation.chat_message =
        crate::redact_sensitive_text(&redacted_presentation.chat_message);
    redacted_presentation.event_subtitle =
        crate::redact_sensitive_text(&redacted_presentation.event_subtitle);
    redacted_presentation.event_payload =
        crate::agent_journal::redact_json_value(redacted_presentation.event_payload);
    let payload = json!({
        "schema_version": 1,
        "kind": "gateway_task_execution",
        "state": presentation.checkpoint_payload,
        "presentation": presentation,
    });
    let redacted_payload = json!({
        "schema_version": 1,
        "kind": "gateway_task_execution",
        "state": presentation.checkpoint_redacted,
        "presentation": redacted_presentation,
    });
    state
        .task_store
        .lock()
        .map_err(runtime_lock_error)?
        .append_checkpoint(
            &task.task_id,
            &task.user_id,
            &task.workspace_id,
            payload,
            redacted_payload,
        )
        .map_err(runtime_store_error)
}

fn checkpoint_envelope(
    state: &AppState,
    contract: &ValidatedExecutionContract,
    checkpoint: &local_first_task_runtime::TaskCheckpoint,
    wake: &WakeCondition,
) -> Result<CheckpointEnvelope, LocalTaskExecutionError> {
    let record_ref = DurableDataRef::from_store_id(&checkpoint.checkpoint_id)
        .map_err(|error| runtime_error(error.to_string()))?;
    let effect_receipts = state
        .task_store
        .lock()
        .map_err(runtime_lock_error)?
        .list_effect_receipts_for_execution(
            &contract.as_ref().execution_id,
            contract.as_ref().revision,
        )
        .map_err(runtime_store_error)?
        .into_iter()
        .map(|receipt| receipt.receipt_ref)
        .collect();
    Ok(CheckpointEnvelope::new(
        contract.as_ref().execution_id.clone(),
        contract.as_ref().revision,
        contract.as_ref().kind.clone(),
        1,
        CheckpointDataRef::Redacted { record_ref },
    )
    .with_resume_context(
        contract.as_ref().objective.clone(),
        wake.clone(),
        effect_receipts,
    ))
}

pub(crate) fn complete_task_execution(
    state: &AppState,
    task: &TaskRecord,
    presentation: TaskExecutionPresentation,
) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
    let checkpoint = persist_task_execution_checkpoint(state, task, &presentation)?;
    Ok(ExecutionOutcome::completed(json!({
        "kind": "gateway_task_execution",
        "summary": presentation.summary,
        "checkpoint_id": checkpoint.checkpoint_id,
        "result": presentation.checkpoint_redacted,
    })))
}

pub(crate) fn suspend_task_execution(
    state: &AppState,
    task: &TaskRecord,
    contract: &ValidatedExecutionContract,
    wake: WakeCondition,
    presentation: TaskExecutionPresentation,
) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
    let checkpoint = persist_task_execution_checkpoint(state, task, &presentation)?;
    Ok(ExecutionOutcome::Suspended {
        wake: wake.clone(),
        checkpoint: checkpoint_envelope(state, contract, &checkpoint, &wake)?,
    })
}

pub(crate) fn fail_task_execution(
    state: &AppState,
    task: &TaskRecord,
    failure: ExecutionFailure,
    presentation: TaskExecutionPresentation,
) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
    persist_task_execution_checkpoint(state, task, &presentation)?;
    Ok(ExecutionOutcome::Failed { failure })
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

macro_rules! gateway_adapter {
    ($name:ident, $label:literal, $execute:expr) => {
        struct $name;

        impl GatewayExecutionAdapter for $name {
            fn name(&self) -> &'static str {
                $label
            }

            fn execute(
                &self,
                context: &ExecutionAdapterContext,
            ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
                ($execute)(context)
            }
        }
    };
}

gateway_adapter!(
    CapabilityBrowserAdapter,
    "capability_browser",
    |context: &ExecutionAdapterContext| { context.execute_capability_browser() }
);
gateway_adapter!(
    CapabilityAdapter,
    "capability",
    |context: &ExecutionAdapterContext| { context.execute_capability() }
);
gateway_adapter!(
    SubagentAdapter,
    "subagent",
    |context: &ExecutionAdapterContext| { context.execute_subagent() }
);
gateway_adapter!(
    ProactivePromptAdapter,
    "proactive_prompt",
    |context: &ExecutionAdapterContext| { context.execute_proactive_prompt() }
);
struct ChatTurnAdapter;

impl GatewayExecutionAdapter for ChatTurnAdapter {
    fn name(&self) -> &'static str {
        "chat_turn"
    }

    fn execute(
        &self,
        context: &ExecutionAdapterContext,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        context.execute_chat_turn()
    }
}
gateway_adapter!(
    ShellReadOnlyAdapter,
    "shell_read_only",
    |context: &ExecutionAdapterContext| { context.execute_shell_read_only() }
);

#[cfg(test)]
mod tests {
    use super::{ExecutionRuntime, GatewayExecutionAdapter};
    use crate::execution_adapter_context::ExecutionAdapterContext;
    use crate::execution_control::{ExecutionAttemptControl, ExecutionInterruption};
    use crate::task_registry::TaskExecutorRegistry;
    use crate::{AppState, LocalTaskExecutionError, TaskRecord};
    use crate::{SurfaceKind, TaskExecutionPresentation, TaskResultSurfacing};
    use local_first_execution_protocol::{
        CheckpointDataRef, CheckpointEnvelope, DurableDataRef, ExecutionContract, ExecutionOutcome,
        ExecutionScope, ExecutionState, ValidatedExecutionContract, ValidatedExecutionOutcome,
        WakeCondition,
    };
    use local_first_task_runtime::{ExecutionProjection, TaskStatus, UserId, WorkspaceId};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use time::{Duration, OffsetDateTime};

    struct RecordingAdapter {
        execution_ids: Arc<Mutex<Vec<String>>>,
    }

    type RecordedRevision = (String, u64, u64, bool);

    struct RevisionRecordingAdapter {
        revisions: Arc<Mutex<Vec<RecordedRevision>>>,
    }

    struct JournalStateRecordingAdapter {
        states: Arc<Mutex<Vec<ExecutionState>>>,
        state: AppState,
    }

    impl GatewayExecutionAdapter for JournalStateRecordingAdapter {
        fn execute(
            &self,
            context: &ExecutionAdapterContext,
        ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
            let execution_id = context.contract().as_ref().execution_id.as_str();
            let state = self
                .state
                .task_store
                .lock()
                .expect("task store")
                .execution(execution_id)
                .expect("load execution")
                .expect("execution exists")
                .state;
            self.states.lock().expect("states").push(state);
            Ok(ExecutionOutcome::completed(serde_json::Value::Null))
        }
    }

    impl GatewayExecutionAdapter for RevisionRecordingAdapter {
        fn execute(
            &self,
            context: &ExecutionAdapterContext,
        ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
            let contract = context.contract().as_ref();
            self.revisions.lock().expect("revision adapter lock").push((
                contract.execution_id.clone(),
                contract.revision,
                contract.fencing_token,
                contract.wake.is_some(),
            ));
            Ok(ExecutionOutcome::completed(
                serde_json::json!({"revision": contract.revision}),
            ))
        }
    }

    struct SuspendingCanonicalAdapter {
        state: AppState,
    }

    impl GatewayExecutionAdapter for SuspendingCanonicalAdapter {
        fn execute(
            &self,
            context: &ExecutionAdapterContext,
        ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
            let contract = context.contract();
            let task = super::task_from_contract(contract)?;
            super::suspend_task_execution(
                &self.state,
                &task,
                contract,
                WakeCondition::At {
                    unix_seconds: (OffsetDateTime::now_utc() + Duration::minutes(1))
                        .unix_timestamp(),
                },
                TaskExecutionPresentation {
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
                },
            )
        }
    }

    struct LeaseStealingAdapter {
        state: AppState,
    }

    impl GatewayExecutionAdapter for LeaseStealingAdapter {
        fn execute(
            &self,
            context: &ExecutionAdapterContext,
        ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
            let contract = context.contract();
            let mut task = super::task_from_contract(contract).expect("task from contract");
            task.lease_owner = Some("replacement-worker".to_string());
            self.state
                .task_store
                .lock()
                .expect("task store")
                .insert_task(&task)
                .expect("replace lease owner");
            Ok(ExecutionOutcome::completed(
                serde_json::json!({"must_not_commit": true}),
            ))
        }
    }

    struct FailingAdapter;

    struct TransientCanonicalAdapter;

    struct BlockingClientAdapter;

    struct LateSuccessAdapter;

    struct CooperativeAdapter {
        started: Arc<AtomicBool>,
        stopped: Arc<AtomicBool>,
    }

    impl GatewayExecutionAdapter for CooperativeAdapter {
        fn execute(
            &self,
            context: &ExecutionAdapterContext,
        ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
            self.started.store(true, Ordering::Release);
            while !context.is_interrupted() {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            self.stopped.store(true, Ordering::Release);
            Ok(ExecutionOutcome::completed(
                serde_json::json!({"must_not_commit": true}),
            ))
        }
    }

    impl GatewayExecutionAdapter for BlockingClientAdapter {
        fn execute(
            &self,
            _context: &ExecutionAdapterContext,
        ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
            drop(reqwest::blocking::Client::new());
            Ok(ExecutionOutcome::completed(
                serde_json::json!({"blocking_adapter": "completed"}),
            ))
        }
    }

    impl GatewayExecutionAdapter for LateSuccessAdapter {
        fn execute(
            &self,
            _context: &ExecutionAdapterContext,
        ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
            std::thread::sleep(std::time::Duration::from_millis(2_500));
            Ok(ExecutionOutcome::completed(
                serde_json::json!({"late": true}),
            ))
        }
    }

    impl GatewayExecutionAdapter for FailingAdapter {
        fn execute(
            &self,
            _context: &ExecutionAdapterContext,
        ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
            Err(LocalTaskExecutionError {
                message: "provider temporarily unavailable".to_string(),
            })
        }
    }

    impl GatewayExecutionAdapter for TransientCanonicalAdapter {
        fn execute(
            &self,
            _context: &ExecutionAdapterContext,
        ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
            Ok(ExecutionOutcome::Failed {
                failure: local_first_execution_protocol::ExecutionFailure::transient(
                    "provider_unavailable",
                    "Provider unavailable",
                ),
            })
        }
    }

    impl GatewayExecutionAdapter for RecordingAdapter {
        fn execute(
            &self,
            context: &ExecutionAdapterContext,
        ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
            let contract = context.contract();
            self.execution_ids
                .lock()
                .expect("recording adapter lock")
                .push(contract.as_ref().execution_id.clone());
            Ok(ExecutionOutcome::completed(
                serde_json::json!({"execution_id": contract.as_ref().execution_id}),
            ))
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

    fn acquired_task_with_permissions(
        kind: &str,
        permission_context: serde_json::Value,
    ) -> TaskRecord {
        let mut task = TaskRecord::new(
            format!("policy-{kind}"),
            UserId::new("user-1"),
            WorkspaceId::new("workspace-1"),
            kind,
            "policy test",
            serde_json::json!({}),
        );
        task.status = TaskStatus::Running;
        task.lease_owner = Some("test-worker".to_string());
        task.last_heartbeat_at = Some(OffsetDateTime::now_utc());
        task.permission_context = permission_context;
        task
    }

    #[test]
    fn capability_allowed_actions_flow_into_the_execution_policy() {
        let task = acquired_task_with_permissions(
            "capability.connector.send",
            serde_json::json!({
                "allowed_actions": ["read", "write_with_confirmation"],
                "max_autonomy_level": 3,
            }),
        );

        let contract = super::contract_for_acquired_task(&task).expect("execution contract");

        assert!(
            contract
                .as_ref()
                .policy
                .allowed_effects
                .contains(&local_first_execution_protocol::EffectClass::ExternalWrite)
        );
        assert_eq!(
            contract.as_ref().policy.approval_policy,
            local_first_execution_protocol::ApprovalPolicy::OnRequest
        );
    }

    #[test]
    fn approved_automation_flows_into_a_preauthorized_execution_policy() {
        let task = acquired_task_with_permissions(
            "subagent.AutomationAgent",
            serde_json::json!({
                "allowed_actions": ["read", "approved_automation"],
                "max_autonomy_level": 4,
                "requires_user_approval": false,
            }),
        );

        let contract = super::contract_for_acquired_task(&task).expect("execution contract");

        assert!(
            contract
                .as_ref()
                .policy
                .allowed_effects
                .contains(&local_first_execution_protocol::EffectClass::ExternalWrite)
        );
        assert_eq!(
            contract.as_ref().policy.approval_policy,
            local_first_execution_protocol::ApprovalPolicy::Preauthorized
        );
    }

    #[test]
    fn approved_automation_without_required_autonomy_stays_on_request() {
        let task = acquired_task_with_permissions(
            "subagent.AutomationAgent",
            serde_json::json!({
                "allowed_actions": ["approved_automation"],
                "max_autonomy_level": 3,
                "requires_user_approval": false,
            }),
        );

        let contract = super::contract_for_acquired_task(&task).expect("execution contract");

        assert_eq!(
            contract.as_ref().policy.approval_policy,
            local_first_execution_protocol::ApprovalPolicy::OnRequest
        );
    }

    fn acquired_chat_task_with_approval(approval: &str) -> TaskRecord {
        let mut task = TaskRecord::new(
            format!("chat-policy-{approval}"),
            UserId::new("user-1"),
            WorkspaceId::new("workspace-1"),
            "chat_turn",
            "test",
            serde_json::json!({"approval": approval}),
        );
        task.status = TaskStatus::Running;
        task.lease_owner = Some("test-worker".to_string());
        task.last_heartbeat_at = Some(OffsetDateTime::now_utc());
        task
    }

    #[test]
    fn same_owner_with_a_new_lease_generation_is_not_the_same_attempt() {
        let mut original = acquired_task_with_permissions("capability.test", serde_json::json!({}));
        original.lease_fencing_token = Some(41);
        let mut reacquired = original.clone();
        reacquired.lease_fencing_token = Some(42);

        assert!(!super::same_lease_generation(&reacquired, &original));
        assert!(super::same_lease_generation(&original, &original));
    }

    fn assert_mutating_effects(policy: &local_first_execution_protocol::ExecutionPolicy) {
        for effect in [
            local_first_execution_protocol::EffectClass::FilesystemWrite,
            local_first_execution_protocol::EffectClass::ArtifactCreation,
            local_first_execution_protocol::EffectClass::ExternalWrite,
        ] {
            assert!(
                policy.allowed_effects.contains(&effect),
                "missing {effect:?} in {:?}",
                policy.allowed_effects
            );
        }
    }

    #[test]
    fn chat_approval_full_allows_mutating_effects_on_request() {
        let policy = super::execution_policy_for_task(&acquired_chat_task_with_approval("full"));

        assert_mutating_effects(&policy);
        assert_eq!(
            policy.approval_policy,
            local_first_execution_protocol::ApprovalPolicy::OnRequest
        );
    }

    #[test]
    fn chat_approval_confirm_allows_mutating_effects_on_request() {
        let policy = super::execution_policy_for_task(&acquired_chat_task_with_approval("confirm"));

        assert_mutating_effects(&policy);
        assert_eq!(
            policy.approval_policy,
            local_first_execution_protocol::ApprovalPolicy::OnRequest
        );
    }

    #[test]
    fn chat_approval_autonomous_preauthorizes_mutating_effects() {
        let policy =
            super::execution_policy_for_task(&acquired_chat_task_with_approval("autonomous"));

        assert_mutating_effects(&policy);
        assert_eq!(
            policy.approval_policy,
            local_first_execution_protocol::ApprovalPolicy::Preauthorized
        );
    }

    #[test]
    fn chat_approval_read_only_denies_mutating_effects() {
        let policy =
            super::execution_policy_for_task(&acquired_chat_task_with_approval("read_only"));

        assert_eq!(
            policy.allowed_effects,
            vec![
                local_first_execution_protocol::EffectClass::Read,
                local_first_execution_protocol::EffectClass::RequestAuthorization,
            ]
        );
        assert_eq!(
            policy.approval_policy,
            local_first_execution_protocol::ApprovalPolicy::OnRequest
        );
    }

    #[test]
    fn chat_approval_read_only_cannot_inherit_preauthorized_metadata() {
        let mut task = acquired_chat_task_with_approval("read_only");
        task.permission_context = serde_json::json!({
            "preauthorized": true,
            "approval_required": false,
            "max_autonomy_level": 5,
            "allowed_effects": ["external_write"],
        });

        let policy = super::execution_policy_for_task(&task);

        assert_eq!(
            policy.approval_policy,
            local_first_execution_protocol::ApprovalPolicy::OnRequest
        );
        assert!(
            !policy
                .allowed_effects
                .contains(&local_first_execution_protocol::EffectClass::ExternalWrite)
        );
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
    async fn blocking_adapter_isolated_from_the_async_runtime_context() {
        let mut registry = TaskExecutorRegistry::new();
        registry.register("capability.*", Arc::new(BlockingClientAdapter));
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let contract = contract("capability.test", "blocking-adapter-1");
        insert_contract_task(&state, &contract);

        let result = runtime
            .execute(&state, contract)
            .await
            .expect("blocking adapter executes outside the async runtime context");

        assert_eq!(result.projection().task_status, TaskStatus::Completed);
    }

    #[tokio::test]
    async fn running_adapter_observes_durable_task_cancellation() {
        let started = Arc::new(AtomicBool::new(false));
        let stopped = Arc::new(AtomicBool::new(false));
        let mut registry = TaskExecutorRegistry::new();
        registry.register(
            "capability.*",
            Arc::new(CooperativeAdapter {
                started: started.clone(),
                stopped: stopped.clone(),
            }),
        );
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let contract = contract("capability.test", "cooperative-cancel-1");
        insert_contract_task(&state, &contract);

        let run_state = state.clone();
        let run = tokio::spawn(async move { runtime.execute(&run_state, contract).await });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !started.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("adapter starts");
        {
            let store = state.task_store.lock().expect("task store");
            let mut task = store
                .get_task(
                    &local_first_task_runtime::TaskId::new("cooperative-cancel-1"),
                    &UserId::new("user-1"),
                    &WorkspaceId::new("workspace-1"),
                )
                .expect("load task")
                .expect("task exists");
            task.status = TaskStatus::Cancelled;
            store.insert_task(&task).expect("cancel task");
        }

        let result = tokio::time::timeout(std::time::Duration::from_secs(1), run)
            .await
            .expect("cooperative adapter stops promptly")
            .expect("runtime task joins")
            .expect("runtime commits cancellation");

        assert!(stopped.load(Ordering::Acquire));
        assert!(matches!(
            result.outcome(),
            ExecutionOutcome::Cancelled { .. }
        ));
    }

    #[tokio::test]
    async fn attempt_monitor_signals_lease_generation_loss() {
        let state = AppState::for_tests();
        let contract = contract("capability.test", "cooperative-lease-1");
        let expected = super::task_from_contract(&contract).expect("task from contract");
        insert_contract_task(&state, &contract);
        let control = Arc::new(ExecutionAttemptControl::default());
        let monitor = tokio::spawn(super::monitor_execution_attempt(
            state.clone(),
            expected,
            contract,
            control.clone(),
        ));
        {
            let store = state.task_store.lock().expect("task store");
            let mut task = store
                .get_task(
                    &local_first_task_runtime::TaskId::new("cooperative-lease-1"),
                    &UserId::new("user-1"),
                    &WorkspaceId::new("workspace-1"),
                )
                .expect("load task")
                .expect("task exists");
            task.lease_owner = Some("replacement-worker".to_string());
            store.insert_task(&task).expect("replace lease");
        }

        let interruption =
            tokio::time::timeout(std::time::Duration::from_secs(1), control.interrupted())
                .await
                .expect("monitor observes lease loss");
        monitor.await.expect("monitor joins");

        assert_eq!(interruption, ExecutionInterruption::LeaseLost);
    }

    #[tokio::test]
    async fn attempt_monitor_signals_contract_deadline() {
        let state = AppState::for_tests();
        let initial = contract("capability.test", "cooperative-deadline-1");
        let mut task = super::task_from_contract(&initial).expect("task from contract");
        task.deadline = Some(OffsetDateTime::now_utc() + Duration::seconds(1));
        let contract = super::contract_for_acquired_task(&task).expect("deadline contract");
        insert_contract_task(&state, &contract);
        let control = Arc::new(ExecutionAttemptControl::default());
        let monitor = tokio::spawn(super::monitor_execution_attempt(
            state,
            task,
            contract,
            control.clone(),
        ));

        let interruption =
            tokio::time::timeout(std::time::Duration::from_secs(2), control.interrupted())
                .await
                .expect("monitor observes deadline");
        monitor.await.expect("monitor joins");

        assert_eq!(interruption, ExecutionInterruption::DeadlineExceeded);
    }

    #[tokio::test]
    async fn journal_attempt_is_running_while_the_adapter_executes() {
        let states = Arc::new(Mutex::new(Vec::new()));
        let state = AppState::for_tests();
        let mut registry = TaskExecutorRegistry::new();
        registry.register(
            "capability.*",
            Arc::new(JournalStateRecordingAdapter {
                states: states.clone(),
                state: state.clone(),
            }),
        );
        let runtime = ExecutionRuntime::new(registry);
        let contract = contract("capability.test", "running-attempt-1");
        insert_contract_task(&state, &contract);

        runtime
            .execute(&state, contract)
            .await
            .expect("execute through claimed journal attempt");

        assert_eq!(
            *states.lock().expect("states"),
            vec![ExecutionState::Running]
        );
    }

    #[tokio::test]
    async fn newer_task_lease_reclaims_a_crashed_running_attempt() {
        let revisions = Arc::new(Mutex::new(Vec::new()));
        let mut registry = TaskExecutorRegistry::new();
        registry.register(
            "capability.*",
            Arc::new(RevisionRecordingAdapter {
                revisions: revisions.clone(),
            }),
        );
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let original = contract("capability.test", "running-reclaim-1");
        let original_task = super::task_from_contract(&original).expect("original task");
        {
            let store = state.task_store.lock().expect("task store");
            store.create_execution(&original).expect("create execution");
            store
                .start_execution_attempt(
                    "running-reclaim-1",
                    1,
                    original.as_ref().fencing_token,
                    original_task.lease_owner.as_deref().expect("lease owner"),
                )
                .expect("start old attempt");
        }
        let mut replacement_task = original_task;
        replacement_task.lease_owner = Some("replacement-worker".to_string());
        replacement_task.last_heartbeat_at = replacement_task
            .last_heartbeat_at
            .map(|timestamp| timestamp + Duration::seconds(1));
        let requested = super::contract_for_acquired_task(&replacement_task)
            .expect("replacement requested contract");
        insert_contract_task(&state, &requested);
        let replacement_fence = requested.as_ref().fencing_token;

        runtime
            .execute(&state, requested)
            .await
            .expect("reclaim running execution");

        assert_eq!(
            *revisions.lock().expect("revisions"),
            vec![("running-reclaim-1".to_string(), 1, replacement_fence, false,)]
        );
        let events = state
            .task_store
            .lock()
            .expect("task store")
            .execution_events("running-reclaim-1", 1)
            .expect("execution events");
        assert!(events.iter().any(|event| matches!(
            event.event,
            local_first_task_runtime::ExecutionJournalEvent::AttemptReclaimed { .. }
        )));
    }

    #[tokio::test]
    async fn unsupported_kind_commits_a_typed_permanent_failure() {
        let runtime = ExecutionRuntime::new(TaskExecutorRegistry::new());
        let state = AppState::for_tests();
        let contract = contract("unknown.task", "unsupported-kind-1");
        insert_contract_task(&state, &contract);

        let result = runtime
            .execute(&state, contract)
            .await
            .expect("unsupported execution kind becomes a canonical outcome");

        assert_eq!(result.projection().task_status, TaskStatus::Failed);
        assert!(matches!(
            result.outcome(),
            ExecutionOutcome::Failed { failure }
                if failure.code == "unsupported_execution_kind"
                    && failure.class == local_first_execution_protocol::FailureClass::Permanent
        ));
        let stored = state
            .task_store
            .lock()
            .expect("task store")
            .execution("unsupported-kind-1")
            .expect("load execution")
            .expect("execution exists");
        assert!(stored.outcome.is_some());
    }

    #[tokio::test]
    async fn contract_policy_denies_declared_effects_before_adapter_dispatch() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut registry = TaskExecutorRegistry::new();
        registry.register(
            "capability.*",
            Arc::new(RecordingAdapter {
                execution_ids: calls.clone(),
            }),
        );
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let task = acquired_task_with_permissions(
            "capability.connector.send",
            serde_json::json!({
                "allowed_actions": ["write_with_confirmation"],
                "max_autonomy_level": 3,
            }),
        );
        let mut raw_contract = ExecutionContract::new(
            task.task_id.as_str(),
            task.kind.clone(),
            ExecutionScope {
                user_id: task.user_id.as_str().to_string(),
                workspace_id: task.workspace_id.as_str().to_string(),
                thread_id: None,
            },
            serde_json::to_value(&task).expect("serialize task"),
        );
        raw_contract.fencing_token = super::acquired_task_fencing_token(&task).expect("task fence");
        let contract =
            ValidatedExecutionContract::try_from(raw_contract).expect("read-only contract");
        insert_contract_task(&state, &contract);

        let result = runtime
            .execute(&state, contract)
            .await
            .expect("policy denial becomes a canonical outcome");

        assert!(calls.lock().expect("calls").is_empty());
        assert!(matches!(
            result.outcome(),
            ExecutionOutcome::Failed { failure }
                if failure.code == "execution_policy_denied"
                    && failure.class == local_first_execution_protocol::FailureClass::Permanent
        ));
    }

    #[tokio::test]
    async fn committed_outcome_is_recovered_without_rerunning_adapter() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut registry = TaskExecutorRegistry::new();
        registry.register(
            "capability.*",
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
            "capability.*",
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
        let state = AppState::for_tests();
        let mut registry = TaskExecutorRegistry::new();
        registry.register(
            "capability.*",
            Arc::new(SuspendingCanonicalAdapter {
                state: state.clone(),
            }),
        );
        let runtime = ExecutionRuntime::new(registry);
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
        let state = AppState::for_tests();
        let mut registry = TaskExecutorRegistry::new();
        registry.register(
            "capability.*",
            Arc::new(LeaseStealingAdapter {
                state: state.clone(),
            }),
        );
        let runtime = ExecutionRuntime::new(registry);
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
            local_first_execution_protocol::ExecutionState::Running
        );
        assert!(execution.outcome.is_none());
    }

    #[tokio::test]
    async fn adapter_error_is_committed_as_budgeted_suspension_with_checkpoint() {
        let mut registry = TaskExecutorRegistry::new();
        registry.register("capability.*", Arc::new(FailingAdapter));
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
        assert!(matches!(
            result.outcome(),
            ExecutionOutcome::Suspended {
                wake: WakeCondition::At { .. },
                ..
            }
        ));
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
        registry.register("capability.*", Arc::new(FailingAdapter));
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

    #[tokio::test]
    async fn canonical_transient_failure_uses_the_runtime_retry_budget() {
        let mut registry = TaskExecutorRegistry::new();
        registry.register("capability.*", Arc::new(TransientCanonicalAdapter));
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let initial = contract("capability.test", "canonical-transient-1");
        let mut task = super::task_from_contract(&initial).expect("task from contract");
        task.retry_policy.max_attempts = 2;
        task.retry_policy.backoff_seconds = 30;
        let contract = super::contract_for_acquired_task(&task).expect("retry contract");
        insert_contract_task(&state, &contract);

        let result = runtime
            .execute(&state, contract)
            .await
            .expect("runtime suspends transient failure");

        assert_eq!(result.projection().task_status, TaskStatus::WaitingTime);
        let execution = state
            .task_store
            .lock()
            .expect("task store")
            .execution("canonical-transient-1")
            .expect("load execution")
            .expect("execution exists");
        assert!(matches!(
            execution.outcome.as_ref().map(|outcome| outcome.as_ref()),
            Some(ExecutionOutcome::Suspended {
                wake: WakeCondition::At { .. },
                ..
            })
        ));
    }

    #[tokio::test]
    async fn elapsed_contract_deadline_prevents_adapter_dispatch() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut registry = TaskExecutorRegistry::new();
        registry.register(
            "capability.*",
            Arc::new(RecordingAdapter {
                execution_ids: calls.clone(),
            }),
        );
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let initial = contract("capability.test", "deadline-elapsed-1");
        let mut task = super::task_from_contract(&initial).expect("task from contract");
        task.deadline = Some(OffsetDateTime::now_utc() - Duration::seconds(1));
        let contract = super::contract_for_acquired_task(&task).expect("deadline contract");
        insert_contract_task(&state, &contract);

        let result = runtime
            .execute(&state, contract)
            .await
            .expect("elapsed deadline becomes a canonical failure");

        assert!(calls.lock().expect("calls").is_empty());
        assert!(matches!(
            result.outcome(),
            ExecutionOutcome::Failed { failure }
                if failure.code == "execution_deadline_exceeded"
                    && failure.class == local_first_execution_protocol::FailureClass::Permanent
        ));
    }

    #[tokio::test]
    async fn adapter_success_returned_after_deadline_is_rejected() {
        let mut registry = TaskExecutorRegistry::new();
        registry.register("capability.*", Arc::new(LateSuccessAdapter));
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let initial = contract("capability.test", "deadline-during-adapter-1");
        let mut task = super::task_from_contract(&initial).expect("task from contract");
        task.deadline = Some(OffsetDateTime::now_utc() + Duration::seconds(2));
        let contract = super::contract_for_acquired_task(&task).expect("deadline contract");
        insert_contract_task(&state, &contract);

        let result = runtime
            .execute(&state, contract)
            .await
            .expect("late success becomes a canonical deadline failure");

        assert!(matches!(
            result.outcome(),
            ExecutionOutcome::Failed { failure }
                if failure.code == "execution_deadline_exceeded"
                    && failure.class == local_first_execution_protocol::FailureClass::Permanent
        ));
    }

    #[tokio::test]
    async fn retry_is_not_scheduled_beyond_the_contract_deadline() {
        let mut registry = TaskExecutorRegistry::new();
        registry.register("capability.*", Arc::new(TransientCanonicalAdapter));
        let runtime = ExecutionRuntime::new(registry);
        let state = AppState::for_tests();
        let initial = contract("capability.test", "deadline-retry-1");
        let mut task = super::task_from_contract(&initial).expect("task from contract");
        task.retry_policy.max_attempts = 2;
        task.retry_policy.backoff_seconds = 30;
        task.deadline = Some(OffsetDateTime::now_utc() + Duration::seconds(5));
        let contract = super::contract_for_acquired_task(&task).expect("deadline contract");
        insert_contract_task(&state, &contract);

        let result = runtime
            .execute(&state, contract)
            .await
            .expect("retry past deadline becomes a canonical failure");

        assert!(matches!(
            result.outcome(),
            ExecutionOutcome::Failed { failure }
                if failure.code == "execution_deadline_exceeded"
                    && failure.class == local_first_execution_protocol::FailureClass::Permanent
        ));
    }
}
