//! Durable task queue and executor HTTP owner.
//!
//! Owns task queue/approval routes, uncertain effect resolution, task acquisition,
//! lease renewal, task finalization, executor status, and computer-session progress
//! projection. Concrete execution adapters (agent loop, browser/capability/MCP,
//! memory, vault, and connector implementations) remain in their dedicated owners.

use super::*;

#[test]
fn task_executor_owner_smoke() {
    let response = lease_stolen_task_response("task-smoke".to_string());
    assert_eq!(response.status, "lease_stolen");
    assert_eq!(response.completed, 0);
}

#[derive(Debug, Deserialize)]
pub(crate) struct TaskQueueQuery {
    /// When set, restrict the queue to tasks owned by this chat thread (the
    /// Workbench Attività tab is per-chat, like its File/Piano tabs). Omitted →
    /// the full cross-thread queue (the top-level Tasks view).
    #[serde(default)]
    thread_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct UncertainEffectQuery {
    #[serde(default)]
    thread_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ResolveEffectResponse {
    receipt: local_first_task_runtime::ExecutionEffectReceipt,
    projections_requeued: usize,
}

type EffectResolutionLocks = std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>;

fn effect_resolution_locks() -> &'static Mutex<EffectResolutionLocks> {
    static LOCKS: std::sync::OnceLock<Mutex<EffectResolutionLocks>> = std::sync::OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn effect_resolution_lock(receipt_ref: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = effect_resolution_locks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(receipt_ref.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

pub(crate) struct EffectResolutionGuard {
    receipt_ref: String,
    lock: Arc<tokio::sync::Mutex<()>>,
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

impl Drop for EffectResolutionGuard {
    fn drop(&mut self) {
        let mut locks = effect_resolution_locks()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if locks
            .get(&self.receipt_ref)
            .is_some_and(|current| Arc::ptr_eq(current, &self.lock))
        {
            locks.remove(&self.receipt_ref);
        }
    }
}

pub(crate) fn begin_effect_resolution(
    receipt_ref: &str,
) -> Result<EffectResolutionGuard, Arc<tokio::sync::Mutex<()>>> {
    let lock = effect_resolution_lock(receipt_ref);
    match lock.clone().try_lock_owned() {
        Ok(guard) => Ok(EffectResolutionGuard {
            receipt_ref: receipt_ref.to_string(),
            lock,
            _guard: guard,
        }),
        Err(_) => Err(lock),
    }
}

pub(crate) async fn uncertain_effect_receipts(
    State(state): State<AppState>,
    Query(query): Query<UncertainEffectQuery>,
) -> Result<Json<Vec<local_first_task_runtime::ExecutionEffectReceipt>>, GatewayError> {
    let user = gateway_user_id();
    let store = lock_task_store(&state)?;
    let mut receipts = store
        .uncertain_effect_receipts_for_user(user.as_str())
        .map_err(GatewayError::task)?;
    if let Some(thread_id) = query
        .thread_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        receipts.retain(|receipt| receipt.thread_id.as_deref() == Some(thread_id));
    }
    Ok(Json(receipts))
}

pub(crate) async fn resolve_uncertain_effect_receipt(
    State(state): State<AppState>,
    Path(receipt_ref): Path<String>,
    Json(resolution): Json<local_first_execution_protocol::EffectReceiptResolution>,
) -> Result<Json<ResolveEffectResponse>, GatewayError> {
    let receipt_ref = local_first_execution_protocol::EffectReceiptRef::parse(receipt_ref)
        .map_err(|error| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_effect_receipt",
            message: error.to_string(),
        })?;
    let user = gateway_user_id();
    let receipt_owner_execution_id = {
        let store = lock_task_store(&state)?;
        let receipt = store
            .effect_receipt(&receipt_ref)
            .map_err(GatewayError::task)?
            .ok_or_else(|| GatewayError {
                status: StatusCode::NOT_FOUND,
                code: "effect_receipt_not_found",
                message: "Effect receipt not found.".to_string(),
            })?;
        if receipt.user_id != user.as_str() {
            return Err(GatewayError {
                status: StatusCode::NOT_FOUND,
                code: "effect_receipt_not_found",
                message: "Effect receipt not found.".to_string(),
            });
        }
        receipt.execution_id
    };
    let _resolution_guard = match begin_effect_resolution(receipt_ref.as_ref()) {
        Ok(guard) => guard,
        Err(resolution_lock) => {
            let _completed = resolution_lock.lock_owned().await;
            return Err(GatewayError {
                status: StatusCode::CONFLICT,
                code: "effect_resolution_in_flight",
                message: "This effect receipt was resolved concurrently; reload its current state."
                    .to_string(),
            });
        }
    };
    let resolution_commit = {
        let store = lock_task_store(&state)?;
        match store.resolve_effect_receipt(&receipt_ref, &resolution) {
            Ok(commit) => commit,
            Err(TaskRuntimeError::NotFound(missing)) if missing == receipt_owner_execution_id => {
                store
                    .resolve_orphaned_effect_receipt(&receipt_ref, &resolution)
                    .map_err(GatewayError::task)?
            }
            Err(error) => return Err(GatewayError::task(error)),
        }
    };
    projection_worker::notify();
    let receipt = resolution_commit.receipt;
    publish_app_event(serde_json::json!({
        "type": "effect.resolved",
        "receipt_ref": receipt_ref.as_ref(),
        "execution_id": receipt.execution_id,
        "thread_id": receipt.thread_id,
        "status": receipt.status.as_str(),
    }));
    Ok(Json(ResolveEffectResponse {
        receipt,
        projections_requeued: resolution_commit.requeued_projections,
    }))
}

pub(crate) fn retain_task_queue_scope(
    response: &mut TaskQueueResponse,
    allowed_task_ids: &std::collections::HashSet<String>,
    thread_id: &str,
) {
    response
        .queued
        .retain(|item| allowed_task_ids.contains(&item.task_id));
    response
        .active
        .retain(|item| allowed_task_ids.contains(&item.task_id));
    response
        .blocked
        .retain(|item| allowed_task_ids.contains(&item.task_id));
    response
        .recent_failures
        .retain(|item| allowed_task_ids.contains(&item.task_id));
    response
        .waiting_approvals
        .retain(|item| allowed_task_ids.contains(&item.task_id));
    response
        .uncertain_effects
        .retain(|item| item.thread_id.as_deref() == Some(thread_id));
}

pub(crate) async fn task_queue(
    State(state): State<AppState>,
    Query(query): Query<TaskQueueQuery>,
) -> Result<Json<TaskQueueResponse>, GatewayError> {
    let mut response = task_queue_response_for_state(&state)?;
    if let Some(thread_id) = query
        .thread_id
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        // Tasks belonging to THIS chat = the thread's primary task + its member
        // tasks (the Brain materializes N member tasks from one prompt).
        let allowed: std::collections::HashSet<String> = {
            let store = lock_store(&state)?;
            let mut ids: std::collections::HashSet<String> = store
                .member_task_ids_for_thread(thread_id)
                .unwrap_or_default()
                .into_iter()
                .collect();
            if let Ok(Some(thread)) = store.thread(thread_id) {
                ids.insert(thread.task_id);
            }
            ids
        };
        retain_task_queue_scope(&mut response, &allowed, thread_id);
    }
    Ok(Json(response))
}

pub(crate) async fn task_detail(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<Option<TaskDetailResponse>>, GatewayError> {
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let store = lock_task_store(&state)?;
    let detail = TaskUiReadModel::new(&store)
        .task_detail(&TaskId::new(task_id), &user, &workspace)
        .map_err(GatewayError::task)?
        .map(task_detail_response)
        .transpose()?;
    Ok(Json(detail))
}

/// Cancels any non-terminal task (queued/active/blocked), so the user can clear
/// stuck/blocked tasks from the Workbench Attività tab. Unlike the chat
/// `cancel_scheduled_task` tool (proactive_prompt only), this works for any kind.
/// Returns the refreshed queue. Cancelling an already-terminal task is a no-op.
pub(crate) async fn cancel_task(
    State(state): State<AppState>,
    Path(task_id): Path<String>,
) -> Result<Json<TaskQueueResponse>, GatewayError> {
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    {
        let store = lock_task_store(&state)?;
        let tid = local_first_task_runtime::TaskId::new(&task_id);
        if let Some(mut task) = store
            .get_task(&tid, &user, &workspace)
            .map_err(GatewayError::task)?
        {
            let terminal = matches!(
                task.status,
                local_first_task_runtime::TaskStatus::Completed
                    | local_first_task_runtime::TaskStatus::Cancelled
                    | local_first_task_runtime::TaskStatus::Failed
                    | local_first_task_runtime::TaskStatus::Expired
            );
            if !terminal {
                if task.kind == "chat_turn" {
                    // Route through the shared helper (also used by `cancel_turn`) so this
                    // endpoint gets the SAME bubble finalization — without it, cancelling an
                    // already-Parked turn here left its assistant bubble a permanent ghost
                    // (no live executor left to ever flip it out of "waiting for the model").
                    cancel_chat_turn_and_finalize_bubble(
                        &state,
                        &store,
                        &user,
                        &workspace,
                        &tid,
                        Some(&task),
                    )
                    .map_err(GatewayError::task)?;
                } else {
                    let was_running = task.status == local_first_task_runtime::TaskStatus::Running;
                    task.status = local_first_task_runtime::TaskStatus::Cancelled;
                    task.blocked_reason = Some("cancelled by the user".to_string());
                    task.updated_at = OffsetDateTime::now_utc();
                    if !was_running {
                        store.release_resources(&task).map_err(GatewayError::task)?;
                        task.clear_lease();
                    }
                    store.insert_task(&task).map_err(GatewayError::task)?;
                }
            }
        }
    }
    Ok(Json(task_queue_response_for_state(&state)?))
}

#[cfg(test)]
mod cancel_of_parked_turn_tests {
    use super::*;
    use local_first_task_runtime::{ResourceClass, ResourceRequirement};

    /// Seeds a chat thread with one assistant bubble, then a chat_turn task Running
    /// under that same thread/message id, then parks it via `park_chat_turn` —
    /// mirrors the engine's finalization-boundary park (Build 2). Returns the
    /// generated thread_id (ChatStore mints its own).
    fn seed_parked_chat_turn_with_bubble(
        state: &AppState,
        turn_id: &str,
        assistant_message_id: &str,
    ) -> String {
        let thread_id = {
            let chat_store = state.chat_store.lock().unwrap();
            let thread = chat_store.create_thread("workspace-a").unwrap();
            let message = channel_chat_message_with_id("assistant", "", assistant_message_id);
            chat_store
                .append_assistant_message(&thread.thread_id, &message)
                .unwrap();
            thread.thread_id
        };

        let task_store = state.task_store.lock().unwrap();
        let mut task = TaskRecord::new(
            turn_id,
            gateway_user_id(),
            gateway_workspace_id(),
            "chat_turn",
            "seed goal",
            serde_json::json!({
                "thread_id": thread_id,
                "assistant_message_id": assistant_message_id,
            }),
        );
        task.status = TaskStatus::Running;
        task.resource_requirements =
            vec![ResourceRequirement::new(ResourceClass::BrowserSession, 1)];
        task_store
            .insert_chat_turn(&task, &thread_id, "req-1", "interactive", "full")
            .unwrap();
        task_store
            .park_chat_turn(
                turn_id,
                gateway_user_id().as_str(),
                gateway_workspace_id().as_str(),
            )
            .unwrap();
        thread_id
    }

    /// Regression test for the T3-review "ghost bubble" finding: cancelling an
    /// already-Parked turn has no live executor to finalize its bubble on its own
    /// (unlike a Running turn, whose own drain loop / `externally_cancelled` guard
    /// does it independently) — `cancel_chat_turn_and_finalize_bubble` must be the
    /// one place that does it, for BOTH `cancel_turn` and `cancel_task`.
    #[test]
    fn cancel_of_a_parked_turn_finalizes_the_bubble_with_exactly_one_terminal_event() {
        let state = AppState::for_tests();
        let turn_id = "turn-cancel-parked";
        let assistant_message_id = "asst-parked-1";
        let thread_id = seed_parked_chat_turn_with_bubble(&state, turn_id, assistant_message_id);

        let user_id = gateway_user_id();
        let workspace_id = gateway_workspace_id();
        let task_id = TaskId::new(turn_id);

        let store = state.task_store.lock().unwrap();
        let task_before_cancel = store
            .get_task(&task_id, &user_id, &workspace_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            task_before_cancel.status,
            TaskStatus::Parked,
            "precondition: turn is parked"
        );

        let ok = cancel_chat_turn_and_finalize_bubble(
            &state,
            &store,
            &user_id,
            &workspace_id,
            &task_id,
            Some(&task_before_cancel),
        )
        .unwrap();
        assert!(ok, "a parked turn is still cancellable");

        let cancelled = store
            .get_task(&task_id, &user_id, &workspace_id)
            .unwrap()
            .unwrap();
        assert_eq!(cancelled.status, TaskStatus::Cancelled);

        let events = store.read_turn_events(turn_id, 0).unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == local_first_task_runtime::TurnEventKind::Cancelled)
                .count(),
            1,
            "exactly one Cancelled terminal event"
        );
        drop(store);

        let message = state
            .chat_store
            .lock()
            .unwrap()
            .message(&thread_id, assistant_message_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            message.delivery_state,
            local_first_desktop_gateway::MessageDeliveryState::Cancelled,
            "the bubble is no longer a ghost — cancel-of-parked finalizes it too"
        );
    }

    /// End-to-end regression guard on the actual endpoint (not just the shared
    /// helper): before this fix, `cancel_task` called `broker::cancel_chat_turn`
    /// directly and skipped bubble finalization entirely, so a parked turn
    /// cancelled from the Workbench "Attività" tab left a ghost bubble even though
    /// `cancel_turn` (the chat-panel Stop button) already handled it correctly.
    #[tokio::test(flavor = "current_thread")]
    async fn cancel_task_endpoint_finalizes_bubble_for_a_parked_turn() {
        let state = AppState::for_tests();
        let turn_id = "turn-cancel-parked-endpoint";
        let assistant_message_id = "asst-parked-2";
        let thread_id = seed_parked_chat_turn_with_bubble(&state, turn_id, assistant_message_id);

        let _ = cancel_task(State(state.clone()), Path(turn_id.to_string()))
            .await
            .unwrap();

        let cancelled = state
            .task_store
            .lock()
            .unwrap()
            .get_task(
                &TaskId::new(turn_id),
                &gateway_user_id(),
                &gateway_workspace_id(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(cancelled.status, TaskStatus::Cancelled);

        let message = state
            .chat_store
            .lock()
            .unwrap()
            .message(&thread_id, assistant_message_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            message.delivery_state,
            local_first_desktop_gateway::MessageDeliveryState::Cancelled,
            "cancel_task must finalize the bubble for a parked turn, same as cancel_turn"
        );
    }
}

pub(crate) async fn run_next_task(
    State(state): State<AppState>,
) -> Result<Json<TaskRunBatchResponse>, GatewayError> {
    let state_for_task = state.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_next_task_once(&state_for_task, TASK_EXECUTOR_MANUAL_WORKER_ID)
    })
    .await
    .map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "task_executor_join_error",
        message: error.to_string(),
    })??;
    Ok(Json(result))
}

pub(crate) async fn task_executor_status(
    State(state): State<AppState>,
) -> Result<Json<TaskExecutorStatusResponse>, GatewayError> {
    Ok(Json(task_executor_status_response(&state)?))
}

pub(crate) async fn approve_approval(
    State(state): State<AppState>,
    Path(approval_id): Path<String>,
    request: Option<Json<ApproveApprovalRequest>>,
) -> Result<Json<TaskQueueResponse>, GatewayError> {
    let store = lock_task_store(&state)?;
    let approval = store
        .approval_by_id(&approval_id)
        .map_err(GatewayError::task)?
        .ok_or_else(|| GatewayError::task(TaskRuntimeError::NotFound(approval_id.clone())))?;
    let task = store
        .get_task(&approval.task_id, &approval.user_id, &approval.workspace_id)
        .map_err(GatewayError::task)?;
    let approval_options = request.map(|Json(request)| request);
    if let (Some(task), Some(options)) = (task.as_ref(), approval_options.as_ref()) {
        persist_browser_approval_options(&state, &approval, task, options)?;
        append_browser_approval_checkpoint(&store, &approval, task, options)
            .map_err(GatewayError::task)?;
    }
    ApprovalGate::new()
        .approve(&store, &approval_id, gateway_user_id().as_str())
        .map_err(GatewayError::task)?;
    drop(store);
    sync_computer_session_after_approval(&state, &approval, ApprovalState::Approved)?;
    Ok(Json(task_queue_response_for_state(&state)?))
}

pub(crate) async fn reject_approval(
    State(state): State<AppState>,
    Path(approval_id): Path<String>,
    Json(request): Json<RejectApprovalRequest>,
) -> Result<Json<TaskQueueResponse>, GatewayError> {
    let store = lock_task_store(&state)?;
    let approval = store
        .approval_by_id(&approval_id)
        .map_err(GatewayError::task)?
        .ok_or_else(|| GatewayError::task(TaskRuntimeError::NotFound(approval_id.clone())))?;
    ApprovalGate::new()
        .reject(
            &store,
            &approval_id,
            gateway_user_id().as_str(),
            &request.reason,
        )
        .map_err(GatewayError::task)?;
    drop(store);
    sync_computer_session_after_approval(&state, &approval, ApprovalState::Rejected)?;
    Ok(Json(task_queue_response_for_state(&state)?))
}

fn sync_computer_session_after_approval(
    state: &AppState,
    approval: &ApprovalRequest,
    approval_state: ApprovalState,
) -> Result<(), GatewayError> {
    let task_id = approval.task_id.as_str();
    let thread = {
        let chat_store = lock_store(state)?;
        chat_store
            .thread_by_task_id(task_id)
            .map_err(GatewayError::store)?
    };
    let Some(thread) = thread else {
        return Ok(());
    };

    let mut computer_store = lock_computer_store(state)?;
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let Some(mut session) = computer_store
        .session(
            &thread.computer_session_id,
            user.as_str(),
            workspace.as_str(),
        )
        .map_err(GatewayError::local_computer)?
    else {
        return Ok(());
    };

    let now = OffsetDateTime::now_utc();
    session.status = match approval_state {
        ApprovalState::Approved => SessionStatus::Running,
        ApprovalState::Rejected => SessionStatus::Cancelled,
        ApprovalState::None | ApprovalState::WaitingUser => SessionStatus::WaitingUser,
    };
    session.approval_state = approval_state;
    session.progress_current = session.progress_current.max(1);
    session.updated_at = now;
    if approval_state == ApprovalState::Rejected {
        session.last_error = Some("Approval rejected by the user.".to_string());
    }
    computer_store
        .upsert_session(&session)
        .map_err(GatewayError::local_computer)?;

    match approval_state {
        ApprovalState::Approved => append_computer_event(
            &mut computer_store,
            &thread.computer_session_id,
            &user,
            &workspace,
            SurfaceKind::Logs,
            "computer_approval_approved",
            "done",
            "Approval confirmed",
            "The local task has been queued.",
            false,
        )?,
        ApprovalState::Rejected => append_computer_event(
            &mut computer_store,
            &thread.computer_session_id,
            &user,
            &workspace,
            SurfaceKind::Logs,
            "computer_approval_rejected",
            "done",
            "Approval rejected",
            "The local task was cancelled before execution.",
            false,
        )?,
        ApprovalState::None | ApprovalState::WaitingUser => {}
    }
    Ok(())
}

fn persist_browser_approval_options(
    state: &AppState,
    approval: &ApprovalRequest,
    task: &TaskRecord,
    options: &ApproveApprovalRequest,
) -> Result<(), GatewayError> {
    if parse_approval_scope(options.scope.as_deref()) != BrowserUrlApprovalScope::Always {
        return Ok(());
    }
    if !task_uses_browser(task) || !approval_allows_browser_policy(approval) {
        return Ok(());
    }
    let visibility = parse_browser_visibility(options.browser_visibility.as_deref());
    let policy_store = lock_browser_url_policies(state)?;
    for target in browser_targets_for_goal(&task_effective_goal(task)) {
        policy_store
            .grant(&BrowserUrlApprovalGrant {
                user_id: approval.user_id.as_str().to_string(),
                workspace_id: approval.workspace_id.as_str().to_string(),
                url: target.url,
                action: "navigate".to_string(),
                scope: BrowserUrlApprovalScope::Always,
                visibility,
            })
            .map_err(|error| GatewayError {
                status: StatusCode::BAD_GATEWAY,
                code: "browser_url_policy_error",
                message: error.to_string(),
            })?;
    }
    Ok(())
}

fn append_browser_approval_checkpoint(
    store: &TaskStore,
    approval: &ApprovalRequest,
    task: &TaskRecord,
    options: &ApproveApprovalRequest,
) -> Result<(), TaskRuntimeError> {
    if !task_uses_browser(task) || !approval_allows_browser_policy(approval) {
        return Ok(());
    }
    let scope = parse_approval_scope(options.scope.as_deref());
    let visibility = parse_browser_visibility(options.browser_visibility.as_deref());
    store.append_checkpoint(
        &approval.task_id,
        &approval.user_id,
        &approval.workspace_id,
        serde_json::json!({
            "kind": "browser_approval_options",
            "approval": {
                "decision": "approved",
                "action": approval.action,
            },
            "scope": approval_scope_label(scope),
            "browser_visibility": browser_visibility_label(visibility),
        }),
        serde_json::json!({
            "kind": "browser_approval_options",
            "approval": {
                "decision": "approved",
                "action": approval.action,
            },
            "scope": approval_scope_label(scope),
            "browser_visibility": browser_visibility_label(visibility),
        }),
    )?;
    Ok(())
}

fn approval_allows_browser_policy(approval: &ApprovalRequest) -> bool {
    approval.action == "browser.manual_action"
        || approval.action == "prompt_plan.approve_step"
        || approval.data_boundary.contains("browser")
        || approval.explanation.to_lowercase().contains("browser")
}

/// Pick the next ready task for this user across EVERY non-terminal workspace.
/// Channel turns live in `local-workspace`; without this, a worker scoped to the
/// UI-selected project never sees them and WhatsApp/Telegram replies stay queued.
pub(crate) fn next_ready_task_across_workspaces(
    store: &TaskStore,
    user: &UserId,
    now: OffsetDateTime,
    governor: &ResourceGovernor,
    lease_manager: &LeaseManager,
) -> local_first_task_runtime::TaskRuntimeResult<Option<TaskRecord>> {
    let scheduler = TaskScheduler::new();
    for workspace in store.non_terminal_workspace_ids(user)? {
        lease_manager.recover_stale_leases(store, user, &workspace, now)?;
        requeue_waiting_resource_tasks(store, user, &workspace, governor)?;
        scheduler.mark_blocked_by_terminal_dependencies(store, user, &workspace)?;
        scheduler.expire_overdue_tasks(store, user, &workspace, now)?;
    }
    Ok(scheduler
        .ready_tasks_for_user(store, user, now, 1)?
        .into_iter()
        .next())
}

/// Count active (Running with a non-expired lease) and stale (Running with an
/// expired lease) tasks across all non-terminal workspaces. Called on every
/// task-executor tick to refresh the cached lease stats consumed by the
/// lock-free health handler — this runs on the executor thread, NOT in the
/// health handler path, so it never blocks the liveness probe.
fn count_active_stale_leases(
    store: &TaskStore,
    user: &UserId,
    now: OffsetDateTime,
) -> (usize, usize) {
    let mut active = 0;
    let mut stale = 0;
    let workspaces = store.non_terminal_workspace_ids(user).unwrap_or_default();
    for workspace in workspaces {
        for task in store.list_tasks(user, &workspace).unwrap_or_default() {
            if task.status != TaskStatus::Running {
                continue;
            }
            match task.lease_expires_at {
                Some(expires) if expires <= now => stale += 1,
                Some(_) => active += 1,
                None => {}
            }
        }
    }
    (active, stale)
}

pub(crate) fn run_next_task_once(
    state: &AppState,
    worker_id: &str,
) -> Result<TaskRunBatchResponse, GatewayError> {
    let user = gateway_user_id();
    let now = OffsetDateTime::now_utc();
    // Dynamic LLM concurrency: the limit follows the active provider's locality
    // (loopback 1, cloud 4) or the user's override — resolved fresh each tick so a
    // Settings change applies with no restart. See `active_llm_concurrency`.
    let governor = ResourceGovernor::new(effective_task_resource_limits());
    let lease_manager = LeaseManager::new(Duration::minutes(5));
    let task = {
        let store = lock_task_store(state)?;
        let task = next_ready_task_across_workspaces(&store, &user, now, &governor, &lease_manager)
            .map_err(GatewayError::task)?;
        // Refresh cached lease stats for the health handler (lightweight: runs
        // on the executor thread, never in the health handler path).
        let (active, stale) = count_active_stale_leases(&store, &user, now);
        crate::gateway_health::set_lease_stats(active, stale);
        task
    };
    let Some(task) = task else {
        return Ok(TaskRunBatchResponse {
            status: "idle".to_string(),
            completed: 0,
            stopped_reason: Some("No approved task in queue.".to_string()),
            results: vec![],
        });
    };

    let workspace = task.workspace_id.clone();
    let task_id = task.task_id.as_str().to_string();
    let task_kind = task.kind.clone();
    let mut task = match acquire_task_for_execution(
        state,
        task,
        &user,
        &workspace,
        &governor,
        &lease_manager,
        worker_id,
        now,
    )? {
        TaskAcquireResult::Acquired(task) => {
            let task = *task;
            if task.kind == "chat_turn" {
                tracing::info!(
                    target: "broker::worker",
                    turn_id = %task.task_id.as_str(),
                    thread_id = ?task.input_json.get("thread_id").and_then(|v| v.as_str()),
                    "worker acquired chat_turn — dispatching to executor"
                );
            }
            task
        }
        TaskAcquireResult::WaitingResource(reason) => {
            // Surface the wait as a turn_event so a live subscriber (or one that
            // reconnects) can show "in attesa del browser slot…". Best-effort:
            // a store error here must not block the waiting task itself.
            if task_kind == "chat_turn"
                && let Ok(store) = lock_task_store(state)
            {
                let _ = store.insert_turn_event(
                    &task_id,
                    local_first_task_runtime::TurnEventKind::Queued,
                    serde_json::json!({
                        "detail": reason,
                        "phase": "waiting_resource",
                    }),
                );
            }
            return Ok(TaskRunBatchResponse {
                status: "waiting_resource".to_string(),
                completed: 0,
                stopped_reason: Some(reason),
                results: vec![TaskRunStepResponse {
                    status: "waiting_resource".to_string(),
                    task_id: Some(task_id),
                    message: "Local resources not yet available.".to_string(),
                }],
            });
        }
        TaskAcquireResult::LeaseBusy => {
            return Ok(TaskRunBatchResponse {
                status: "skipped".to_string(),
                completed: 0,
                stopped_reason: Some("Task already running on another worker.".to_string()),
                results: vec![TaskRunStepResponse {
                    status: "skipped".to_string(),
                    task_id: Some(task_id),
                    message: "Lease already active.".to_string(),
                }],
            });
        }
    };
    set_chat_turn_message_delivery_state(
        state,
        &task,
        local_first_desktop_gateway::MessageDeliveryState::Streaming,
    );
    sync_session_for_task_run(state, &task, SessionStatus::Running, 1, None)?;
    append_task_progress_checkpoint(
        state,
        &task,
        "execution_started",
        SurfaceKind::Logs,
        "Task started",
        "Local execution approved and taken over by the worker.",
        serde_json::json!({
            "kind": "execution_started",
            "worker_id": worker_id,
            "task_id": task.task_id.as_str(),
        }),
    )?;

    let execution_task = match task_with_dependency_outputs(state, &task) {
        Ok(task) => task,
        Err(error) => {
            handle_failed_task_run(state, &mut task, true, &error.message)?;
            let retried = matches!(task.status, TaskStatus::Queued);
            sync_session_for_task_run(
                state,
                &task,
                if retried {
                    SessionStatus::Paused
                } else {
                    SessionStatus::Failed
                },
                1,
                Some(error.message.clone()),
            )?;
            let label = if retried { "retry_scheduled" } else { "failed" };
            return Ok(TaskRunBatchResponse {
                status: label.to_string(),
                completed: 0,
                stopped_reason: Some(error.message.clone()),
                results: vec![TaskRunStepResponse {
                    status: label.to_string(),
                    task_id: Some(task_id),
                    message: error.message,
                }],
            });
        }
    };

    // Spawn a background watchdog that renews the lease every 60s while the
    // executor blocks. This prevents long tasks (proactivity, browser, LLM
    // streaming) from expiring their 5-minute lease and being re-queued mid-run.
    // Abort it in EVERY path after execute returns (see the guard below).
    let watchdog = spawn_lease_watchdog(
        state.clone(),
        task.task_id.clone(),
        user.clone(),
        workspace.clone(),
        worker_id.to_string(),
        task.effective_lease_fencing_token()
            .ok_or_else(|| GatewayError {
                status: StatusCode::BAD_GATEWAY,
                code: "lease_fence_missing",
                message: "Acquired task has no lease fencing token.".to_string(),
            })?,
    );

    let execution_contract =
        contract_for_acquired_task(&execution_task).map_err(|error| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "execution_contract_invalid",
            message: error.message,
        })?;
    let execution_runtime = ExecutionRuntime::new(state.task_executor_registry.clone());
    let runtime_result =
        match block_on_execution_runtime(execution_runtime.execute(state, execution_contract)) {
            Ok(outcome) => outcome,
            Err(error) if execution_runtime::is_lease_lost_error(&error) => {
                if let Some(handle) = &watchdog {
                    handle.abort();
                }
                return Ok(lease_stolen_task_response(task_id));
            }
            Err(error) => {
                if let Some(handle) = &watchdog {
                    handle.abort();
                }
                if !is_lease_still_ours(state, &task, worker_id)? {
                    return Ok(lease_stolen_task_response(task_id));
                }
                handle_failed_task_run(state, &mut task, true, &error.message)?;
                let retried = matches!(task.status, TaskStatus::Queued);
                sync_session_for_task_run(
                    state,
                    &task,
                    if retried {
                        SessionStatus::Paused
                    } else {
                        SessionStatus::Failed
                    },
                    1,
                    Some(error.message.clone()),
                )?;
                let label = if retried { "retry_scheduled" } else { "failed" };
                return Ok(TaskRunBatchResponse {
                    status: label.to_string(),
                    completed: 0,
                    stopped_reason: Some(error.message.clone()),
                    results: vec![TaskRunStepResponse {
                        status: label.to_string(),
                        task_id: Some(task_id),
                        message: error.message,
                    }],
                });
            }
        };
    // Execution no longer needs heartbeats once the canonical outcome is committed or recovered.
    if let Some(handle) = &watchdog {
        handle.abort();
    }
    if runtime_result.execution_id() != task_id {
        return Err(GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "execution_identity_mismatch",
            message: "Execution runtime returned a different execution identity.".to_string(),
        });
    }
    let canonical_projection = runtime_result.projection();
    let canonical_outcome = runtime_result.outcome().clone();
    if task.kind == "chat_turn" {
        let (status, message, stopped_reason) = match &canonical_outcome {
            local_first_execution_protocol::ExecutionOutcome::Completed { .. } => {
                ("completed", "Chat turn completed.".to_string(), None)
            }
            local_first_execution_protocol::ExecutionOutcome::Suspended { wake, .. } => (
                "suspended",
                format!("Chat turn suspended for {wake:?}."),
                Some(format!("waiting for {wake:?}")),
            ),
            local_first_execution_protocol::ExecutionOutcome::Cancelled { .. } => (
                "cancelled",
                "Chat turn cancelled.".to_string(),
                Some("cancelled by user".to_string()),
            ),
            local_first_execution_protocol::ExecutionOutcome::Failed { failure } => (
                "failed",
                failure.redacted_detail.clone(),
                Some(failure.redacted_detail.clone()),
            ),
        };
        return Ok(TaskRunBatchResponse {
            status: status.to_string(),
            completed: u32::from(canonical_projection.task_status == TaskStatus::Completed),
            stopped_reason,
            results: vec![TaskRunStepResponse {
                status: status.to_string(),
                task_id: Some(task_id),
                message,
            }],
        });
    }
    let outcome = execution_runtime::task_execution_presentation(state, &task, &canonical_outcome)
        .map_err(|error| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "execution_presentation_invalid",
            message: error.message,
        })?;

    // Guard: if the lease was stolen during execution (recovery + re-acquire by
    // another worker), do NOT write the result. The task is now owned by the
    // other worker; writing here would corrupt its state (double-execution).
    if !is_lease_still_ours(state, &task, worker_id)? {
        eprintln!(
            "lease guard: task {task_id} lease was stolen during execution — discarding result to avoid double-execution"
        );
        return Ok(lease_stolen_task_response(task_id));
    }

    append_task_observation_to_session(state, &task, &outcome)?;
    // Guard: a turn cancelled mid-flight (cancel_chat_turn set status=Cancelled while the
    // executor was racing to a stop via its select! on the cancel Notify) must NOT be
    // resurrected by its late outcome. Reload the authoritative status; if it's already
    // Cancelled, release resources and close out WITHOUT overwriting it — otherwise
    // mark_task_completed / handle_failed_task_run would clobber Cancelled with Completed/Failed
    // and leave the thread stuck (the "thread is busy" symptom).
    let externally_cancelled = lock_task_store(state)
        .ok()
        .and_then(|store| {
            store
                .get_task(&task.task_id, &user, &workspace)
                .ok()
                .flatten()
        })
        .is_some_and(|t| t.status == TaskStatus::Cancelled);
    if externally_cancelled {
        if let Ok(store) = lock_task_store(state) {
            let _ = store.release_resources(&task);
        }
        surface_task_execution_outcome(state, &task_id, &outcome)?;
        return Ok(TaskRunBatchResponse {
            status: "cancelled".to_string(),
            completed: 0,
            stopped_reason: Some("cancelled by user".to_string()),
            results: vec![TaskRunStepResponse {
                status: "cancelled".to_string(),
                task_id: Some(task_id),
                message: outcome.summary,
            }],
        });
    }
    if canonical_projection.task_status == TaskStatus::Completed {
        record_subagent_task_step_outcome(state, &task, &outcome);
        mark_task_completed(state, &mut task)?;
        record_automation_run_for_task(state, &task, true, "");
        // Proactivity: check the owning automation and enqueue atomically under the task-store
        // lock. A disabled/deleted rule must never revive itself after an in-flight run ends.
        let store = lock_task_store(state)?;
        insert_next_recurrence_if_active(&store, &task, OffsetDateTime::now_utc())
            .map_err(GatewayError::task)?;
        drop(store);
        sync_session_for_task_run(state, &task, SessionStatus::Completed, 3, None)?;
    } else if canonical_projection.task_status == TaskStatus::WaitingUserApproval {
        let approval = outcome
            .pending_approval
            .as_ref()
            .ok_or_else(|| GatewayError {
                status: StatusCode::BAD_GATEWAY,
                code: "execution_approval_projection_missing",
                message: "Canonical approval suspension has no compatibility approval data."
                    .to_string(),
            })?;
        request_task_executor_approval(state, &mut task, approval)?;
        set_chat_turn_message_delivery_state(
            state,
            &task,
            local_first_desktop_gateway::MessageDeliveryState::WaitingUser,
        );
        sync_session_for_task_run(
            state,
            &task,
            SessionStatus::WaitingUser,
            2,
            Some(approval.explanation.clone()),
        )?;
    } else if canonical_projection.task_status == TaskStatus::WaitingTime {
        let wait_until = match &canonical_outcome {
            local_first_execution_protocol::ExecutionOutcome::Suspended {
                wake: local_first_execution_protocol::WakeCondition::At { unix_seconds },
                ..
            } => OffsetDateTime::from_unix_timestamp(*unix_seconds).map_err(|error| {
                GatewayError {
                    status: StatusCode::BAD_GATEWAY,
                    code: "execution_timer_projection_invalid",
                    message: error.to_string(),
                }
            })?,
            _ => {
                return Err(GatewayError {
                    status: StatusCode::BAD_GATEWAY,
                    code: "execution_timer_projection_missing",
                    message: "WaitingTime projection has no canonical timer wake.".to_string(),
                });
            }
        };
        let reason = outcome.summary.as_str();
        mark_task_waiting_time(state, &mut task, wait_until, reason)?;
        sync_session_for_task_run(
            state,
            &task,
            SessionStatus::Paused,
            2,
            Some(format!("Riprendo dopo {}: {reason}", wait_until)),
        )?;
    } else {
        let reason = match &canonical_outcome {
            local_first_execution_protocol::ExecutionOutcome::Failed { failure } => {
                failure.redacted_detail.clone()
            }
            local_first_execution_protocol::ExecutionOutcome::Cancelled { .. } => {
                "Task cancelled.".to_string()
            }
            _ => outcome.summary.clone(),
        };
        // Blocked = didn't meet success criteria. Retry while attempts remain, else
        // mark terminal AND (if recurring) schedule the next occurrence so a single
        // failure never silently stops the automation; notify + record on terminal.
        handle_failed_task_run(
            state,
            &mut task,
            matches!(
                canonical_outcome,
                local_first_execution_protocol::ExecutionOutcome::Failed { .. }
            ),
            &reason,
        )?;
        let retried = matches!(task.status, TaskStatus::Queued);
        sync_session_for_task_run(
            state,
            &task,
            SessionStatus::Paused,
            2,
            Some(if retried {
                format!("Ritento a breve: {reason}")
            } else {
                reason
            }),
        )?;
    }
    surface_task_execution_outcome(state, &task_id, &outcome)?;

    Ok(TaskRunBatchResponse {
        status: if canonical_projection.task_status == TaskStatus::Completed {
            "completed".to_string()
        } else if canonical_projection.task_status == TaskStatus::WaitingUserApproval {
            "waiting_user_approval".to_string()
        } else if canonical_projection.task_status == TaskStatus::WaitingTime {
            "waiting_time".to_string()
        } else {
            "blocked".to_string()
        },
        completed: u32::from(canonical_projection.task_status == TaskStatus::Completed),
        stopped_reason: (!matches!(
            canonical_outcome,
            local_first_execution_protocol::ExecutionOutcome::Completed { .. }
        ))
        .then(|| outcome.summary.clone()),
        results: vec![TaskRunStepResponse {
            status: if canonical_projection.task_status == TaskStatus::Completed {
                "completed".to_string()
            } else if canonical_projection.task_status == TaskStatus::WaitingUserApproval {
                "waiting_user_approval".to_string()
            } else if canonical_projection.task_status == TaskStatus::WaitingTime {
                "waiting_time".to_string()
            } else {
                "blocked".to_string()
            },
            task_id: Some(task_id),
            message: outcome.summary,
        }],
    })
}

fn lease_stolen_task_response(task_id: String) -> TaskRunBatchResponse {
    TaskRunBatchResponse {
        status: "lease_stolen".to_string(),
        completed: 0,
        stopped_reason: Some("Task lease expired and was re-queued by another worker.".to_string()),
        results: vec![TaskRunStepResponse {
            status: "lease_stolen".to_string(),
            task_id: Some(task_id),
            message: "Result discarded: lease stolen during execution.".to_string(),
        }],
    }
}

fn block_on_execution_runtime<F>(future: F) -> F::Output
where
    F: std::future::Future,
{
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        return handle.block_on(future);
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build execution runtime")
        .block_on(future)
}

pub(crate) fn effective_task_resource_limits() -> ResourceLimits {
    ResourceLimits::conservative_defaults()
        .with_limit(ResourceClass::LlmInference, active_llm_concurrency())
}

pub(crate) fn requeue_waiting_resource_tasks(
    store: &TaskStore,
    user: &UserId,
    workspace: &WorkspaceId,
    governor: &ResourceGovernor,
) -> TaskRuntimeResult<usize> {
    let mut requeued = 0usize;
    for task in store.list_tasks(user, workspace)? {
        if governor.requeue_waiting_if_available(store, &task)? {
            requeued += 1;
        }
    }
    Ok(requeued)
}

pub(crate) fn start_task_executor_worker(state: AppState) {
    if !gateway_task_executor_config::task_executor_worker_enabled() {
        return;
    }
    let count = gateway_task_executor_config::task_executor_worker_count();
    eprintln!(
        "task executor: starting {count} background worker{} (poll {}ms, ResourceGovernor gates concurrency)",
        if count == 1 { "" } else { "s" },
        TASK_EXECUTOR_POLL_INTERVAL_MS
    );
    for index in 0..count {
        let worker_state = state.clone();
        let worker_id = gateway_task_executor_config::task_executor_worker_id(index);
        // Stagger the first tick across workers so they don't all hit SQLite at
        // once on startup; the interval stays shared afterwards.
        let stagger = StdDuration::from_millis(
            TASK_EXECUTOR_POLL_INTERVAL_MS / count.max(1) as u64 * index as u64,
        );
        tokio::spawn(async move {
            // Initial offset before the steady-state interval begins.
            tokio::time::sleep(stagger).await;
            let mut interval =
                tokio::time::interval(StdDuration::from_millis(TASK_EXECUTOR_POLL_INTERVAL_MS));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                update_task_executor_status(&worker_state, |status| {
                    status.status = "polling".to_string();
                    status.last_tick_at = Some(OffsetDateTime::now_utc().to_string());
                    status.last_message = "Controllo coda task locale.".to_string();
                });

                let state_for_worker = worker_state.clone();
                let id_for_run = worker_id.clone();
                let result = tokio::task::spawn_blocking(move || {
                    run_next_task_once(&state_for_worker, &id_for_run)
                })
                .await;

                match result {
                    Ok(Ok(batch)) => record_task_executor_batch(&worker_state, batch),
                    Ok(Err(error)) => {
                        let message = error.message.clone();
                        update_task_executor_status(&worker_state, |status| {
                            status.status = "failed".to_string();
                            status.failure_count += 1;
                            status.last_message = message.clone();
                        });
                        eprintln!("task executor worker {worker_id} error: {message}");
                    }
                    Err(error) => {
                        let message = error.to_string();
                        update_task_executor_status(&worker_state, |status| {
                            status.status = "failed".to_string();
                            status.failure_count += 1;
                            status.last_message = message.clone();
                        });
                        eprintln!("task executor worker {worker_id} join error: {message}");
                    }
                }
            }
        });
    }
}

fn record_task_executor_batch(state: &AppState, batch: TaskRunBatchResponse) {
    update_task_executor_status(state, |status| {
        status.last_task_id = batch
            .results
            .iter()
            .find_map(|result| result.task_id.clone())
            .or_else(|| status.last_task_id.clone());
        status.last_message = batch
            .stopped_reason
            .clone()
            .or_else(|| batch.results.first().map(|result| result.message.clone()))
            .unwrap_or_else(|| "Coda task controllata.".to_string());
        status.status = batch.status.clone();
        status.completed_count += u64::from(batch.completed);
        if batch.status == "failed" {
            status.failure_count += 1;
        }
    });
}

fn update_task_executor_status(state: &AppState, update: impl FnOnce(&mut TaskExecutorStatus)) {
    if let Ok(mut status) = state.task_executor_status.lock() {
        update(&mut status);
    }
}

fn task_executor_status_response(
    state: &AppState,
) -> Result<TaskExecutorStatusResponse, GatewayError> {
    let status = lock_task_executor_status(state)?;
    Ok(TaskExecutorStatusResponse {
        enabled: status.enabled,
        worker_id: status.worker_id.clone(),
        poll_interval_ms: status.poll_interval_ms,
        status: status.status.clone(),
        last_tick_at: status.last_tick_at.clone(),
        last_task_id: status.last_task_id.clone(),
        last_message: status.last_message.clone(),
        completed_count: status.completed_count,
        failure_count: status.failure_count,
    })
}

enum TaskAcquireResult {
    Acquired(Box<TaskRecord>),
    WaitingResource(String),
    LeaseBusy,
}

#[allow(clippy::too_many_arguments)]
/// Spawns a background watchdog that renews the task lease every ~60s while the
/// executor blocks. Returns a `JoinHandle` that the caller MUST abort after the
/// execution returns (every path). The watchdog is best-effort: if a heartbeat
/// fails (LeaseConflict = task stolen by recovery+re-acquire), it logs and stops
/// renewing — the caller's guard (`is_lease_still_ours`) will detect the theft
/// and prevent writing a result that belongs to another worker.
///
/// SAFETY: the watchdog acquires `task_store`'s mutex on its own (no shared guard).
/// During unified execution the worker does not hold the task_store lock,
/// so there is no contention/deadlock risk. The heartbeat interval (60s) leaves
/// a 4-minute safety margin before the 5-minute lease expires.
fn spawn_lease_watchdog(
    state: AppState,
    task_id: TaskId,
    user_id: UserId,
    workspace_id: WorkspaceId,
    worker_id: String,
    fencing_token: u64,
) -> Option<tokio::task::JoinHandle<()>> {
    // run_next_task_once runs inside spawn_blocking; reach into the async runtime
    // to spawn the watchdog on the tokio reactor.
    let handle = tokio::runtime::Handle::try_current().ok()?;
    Some(handle.spawn(async move {
        let lease = LeaseManager::new(time::Duration::minutes(5));
        let mut interval = tokio::time::interval(StdDuration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let now = OffsetDateTime::now_utc();
            let keep_going = match lock_task_store(&state) {
                Ok(store) => {
                    match lease.heartbeat(
                        &store,
                        &task_id,
                        &user_id,
                        &workspace_id,
                        LeaseOwnership::new(&worker_id, fencing_token),
                        now,
                    ) {
                        Ok(()) => true,
                        Err(TaskRuntimeError::LeaseConflict(_)) => {
                            eprintln!(
                                "lease watchdog: task stolen (LeaseConflict) — stopping renewal; worker {worker_id} result will be discarded"
                            );
                            false
                        }
                        Err(error) => {
                            eprintln!(
                                "lease watchdog: heartbeat error: {error:?} — will retry next tick"
                            );
                            true // transient error, keep trying
                        }
                    }
                }
                Err(error) => {
                    eprintln!(
                        "lease watchdog: store lock error: {error:?} — will retry next tick"
                    );
                    true // lock contention, keep trying
                }
            };
            if !keep_going {
                break;
            }
        }
    }))
}

/// Checks whether the task lease still belongs to this worker. Used AFTER
/// unified execution returns and before writing the compatibility projection: if the lease
/// was stolen (recovery + re-acquire by another worker), the result must NOT be
/// written — it would corrupt the task state owned by the other worker.
fn is_lease_still_ours(
    state: &AppState,
    task: &TaskRecord,
    worker_id: &str,
) -> Result<bool, GatewayError> {
    let store = lock_task_store(state)?;
    let current = store
        .get_task(&task.task_id, &task.user_id, &task.workspace_id)
        .map_err(GatewayError::task)?;
    match current {
        Some(t) => Ok(t.lease_owner.as_deref() == Some(worker_id)
            && t.effective_lease_fencing_token() == task.effective_lease_fencing_token()),
        None => Ok(false),
    }
}

#[allow(clippy::too_many_arguments)]
fn acquire_task_for_execution(
    state: &AppState,
    task: TaskRecord,
    user: &UserId,
    workspace: &WorkspaceId,
    governor: &ResourceGovernor,
    lease_manager: &LeaseManager,
    worker_id: &str,
    now: OffsetDateTime,
) -> Result<TaskAcquireResult, GatewayError> {
    let store = lock_task_store(state)?;
    if governor
        .mark_waiting_if_unavailable(&store, &task)
        .map_err(GatewayError::task)?
    {
        let blocked_reason = store
            .get_task(&task.task_id, user, workspace)
            .map_err(GatewayError::task)?
            .and_then(|task| task.blocked_reason)
            .unwrap_or_else(|| "Local resources not available.".to_string());
        return Ok(TaskAcquireResult::WaitingResource(blocked_reason));
    }
    if !lease_manager
        .acquire(&store, &task.task_id, user, workspace, worker_id, now)
        .map_err(GatewayError::task)?
    {
        return Ok(TaskAcquireResult::LeaseBusy);
    }
    let leased = store
        .get_task(&task.task_id, user, workspace)
        .map_err(GatewayError::task)?
        .ok_or_else(|| {
            GatewayError::task(TaskRuntimeError::NotFound(
                task.task_id.as_str().to_string(),
            ))
        })?;
    governor
        .reserve(&store, &leased, worker_id)
        .map_err(GatewayError::task)?;
    Ok(TaskAcquireResult::Acquired(Box::new(leased)))
}

fn mark_task_completed(state: &AppState, task: &mut TaskRecord) -> Result<(), GatewayError> {
    task.status = TaskStatus::Completed;
    task.blocked_reason = None;
    task.clear_lease();
    task.updated_at = OffsetDateTime::now_utc();
    let store = lock_task_store(state)?;
    store.release_resources(task).map_err(GatewayError::task)?;
    store.insert_task(task).map_err(GatewayError::task)
}

fn mark_task_failed(
    state: &AppState,
    task: &mut TaskRecord,
    reason: &str,
) -> Result<(), GatewayError> {
    task.status = TaskStatus::Failed;
    task.blocked_reason = Some(reason.to_string());
    task.clear_lease();
    task.updated_at = OffsetDateTime::now_utc();
    let store = lock_task_store(state)?;
    store.release_resources(task).map_err(GatewayError::task)?;
    store.insert_task(task).map_err(GatewayError::task)
}

fn mark_task_waiting_external(
    state: &AppState,
    task: &mut TaskRecord,
    reason: &str,
) -> Result<(), GatewayError> {
    task.status = TaskStatus::WaitingExternalEvent;
    task.blocked_reason = Some(reason.to_string());
    task.clear_lease();
    task.updated_at = OffsetDateTime::now_utc();
    let store = lock_task_store(state)?;
    store.release_resources(task).map_err(GatewayError::task)?;
    store.insert_task(task).map_err(GatewayError::task)
}

pub(crate) fn mark_task_waiting_time(
    state: &AppState,
    task: &mut TaskRecord,
    not_before: OffsetDateTime,
    reason: &str,
) -> Result<(), GatewayError> {
    task.status = TaskStatus::WaitingTime;
    task.not_before = Some(not_before);
    task.blocked_reason = Some(reason.to_string());
    task.clear_lease();
    task.updated_at = OffsetDateTime::now_utc();
    let store = lock_task_store(state)?;
    store.release_resources(task).map_err(GatewayError::task)?;
    store.insert_task(task).map_err(GatewayError::task)
}

/// Records this run in the automation's history (no-op for non-automation tasks) and
/// stamps the automation's `last_fired_at`. Best-effort — never breaks the run.
fn record_automation_run_for_task(state: &AppState, task: &TaskRecord, ok: bool, detail: &str) {
    let Some(automation_id) = task
        .input_json
        .get("automation_id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        return;
    };
    let now = OffsetDateTime::now_utc();
    if let Ok(store) = lock_task_store(state) {
        record_automation_run_in_store(&store, &automation_id, task, ok, detail, now);
    }
}

pub(crate) fn record_automation_run_in_store(
    store: &TaskStore,
    automation_id: &str,
    task: &TaskRecord,
    ok: bool,
    detail: &str,
    now: OffsetDateTime,
) {
    // "Late" = ran well after its scheduled time — a catch-up after the app was off.
    let late = task
        .not_before
        .map(|nb| (now - nb).whole_seconds() > 120)
        .unwrap_or(false);
    let detail_opt = (!detail.is_empty()).then_some(detail);
    let _ = store.record_automation_run(automation_id, now, ok, late, detail_opt);
    if let Ok(Some(mut automation)) =
        store.get_automation(automation_id, &task.user_id, &task.workspace_id)
    {
        automation.last_fired_at = Some(now);
        automation.updated_at = now;
        let _ = store.upsert_automation(&automation);
    }
}

/// Surfaces a proactive card when an automation run fails terminally, so a silently
/// broken automation doesn't go unnoticed. Deduped per automation (never spams).
fn notify_automation_failure(state: &AppState, task: &TaskRecord, reason: &str) {
    let Some(automation_id) = task
        .input_json
        .get("automation_id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        return;
    };
    let (title, scope) = match lock_task_store(state).ok().and_then(|store| {
        store
            .get_automation(&automation_id, &task.user_id, &task.workspace_id)
            .ok()
            .flatten()
    }) {
        Some(a) => (
            format!("L'automazione «{}» è fallita", a.title),
            a.workspace_id.as_str().to_string(),
        ),
        None => (
            "Un'automazione è fallita".to_string(),
            "__personal__".to_string(),
        ),
    };
    if let Ok(store) = lock_store(state) {
        let _ = store.insert_suggestion(&chat_store::SuggestionInput {
            scope,
            kind: "automation_failure".to_string(),
            title,
            body: reason.chars().take(240).collect(),
            dedup_key: format!("autofail:{automation_id}"),
            source_ref: format!("automation:{automation_id}"),
            ..Default::default()
        });
    }
}

/// A task run that did NOT complete: retry the SAME occurrence (escalating backoff)
/// while attempts remain; otherwise mark it terminal, record + notify, and — for a
/// recurring task — schedule the NEXT occurrence so one failure never silently stops
/// the automation. `hard_error` = an execution error (→ Failed) vs a blocked outcome
/// (→ WaitingExternalEvent). Non-automation tasks default to 1 attempt, so they keep
/// today's behavior (terminal, no reschedule).
pub(crate) fn handle_failed_task_run(
    state: &AppState,
    task: &mut TaskRecord,
    hard_error: bool,
    reason: &str,
) -> Result<(), GatewayError> {
    if task.attempt_count + 1 < task.retry_policy.max_attempts {
        // chat_turn retry policies are explicit and may use short backoffs (15s for
        // interactive); other tasks get the legacy floor of 30s.
        let is_chat_turn = task.kind == "chat_turn";
        let step = if is_chat_turn {
            task.retry_policy.backoff_seconds
        } else {
            task.retry_policy.backoff_seconds.max(30)
        };
        let backoff = step * (task.attempt_count as i64 + 1);
        task.attempt_count += 1;
        task.status = TaskStatus::Queued;
        task.blocked_reason = Some(format!(
            "retry {}/{}: {reason}",
            task.attempt_count + 1,
            task.retry_policy.max_attempts
        ));
        task.not_before = Some(OffsetDateTime::now_utc() + Duration::seconds(backoff));
        task.clear_lease();
        task.updated_at = OffsetDateTime::now_utc();
        {
            let store = lock_task_store(state)?;
            store.release_resources(task).map_err(GatewayError::task)?;
            store.insert_task(task).map_err(GatewayError::task)?;
            // Surface the retry as a turn_event so a live subscriber (or one that
            // reconnects later) can show "retry in corso (n/N fra Xs)…" and the user
            // can still cancel. Best-effort: a store error here must not block the
            // retry itself.
            if is_chat_turn {
                let _ = store.insert_turn_event(
                    task.task_id.as_str(),
                    local_first_task_runtime::TurnEventKind::Retry,
                    serde_json::json!({
                        "attempt": task.attempt_count + 1,
                        "max_attempts": task.retry_policy.max_attempts,
                        "backoff_seconds": backoff,
                        "reason": reason,
                    }),
                );
            }
        }
        set_chat_turn_message_delivery_state(
            state,
            task,
            local_first_desktop_gateway::MessageDeliveryState::Retrying,
        );
        record_automation_run_for_task(state, task, false, &format!("retry: {reason}"));
        return Ok(());
    }
    if hard_error {
        mark_task_failed(state, task, reason)?;
    } else {
        mark_task_waiting_external(state, task, reason)?;
    }
    set_chat_turn_message_delivery_state(
        state,
        task,
        local_first_desktop_gateway::MessageDeliveryState::Failed,
    );
    record_automation_run_for_task(state, task, false, reason);
    notify_automation_failure(state, task, reason);
    let store = lock_task_store(state)?;
    insert_next_recurrence_if_active(&store, task, OffsetDateTime::now_utc())
        .map_err(GatewayError::task)?;
    Ok(())
}

pub(crate) fn request_task_executor_approval(
    state: &AppState,
    task: &mut TaskRecord,
    approval: &PendingExecutorApproval,
) -> Result<(), GatewayError> {
    let store = lock_task_store(state)?;
    if approval.inline_action_card {
        if let Some(persisted) = store
            .get_task(&task.task_id, &task.user_id, &task.workspace_id)
            .map_err(GatewayError::task)?
        {
            task.input_json = persisted.input_json;
        }
        task.status = TaskStatus::WaitingUserApproval;
        task.blocked_reason = Some(format!("approval required: {}", approval.action));
        task.clear_lease();
        task.updated_at = OffsetDateTime::now_utc();
        store.release_resources(task).map_err(GatewayError::task)?;
        store.insert_task(task).map_err(GatewayError::task)?;
        return Ok(());
    }
    let approval_request = ApprovalGate::new()
        .request_approval(
            &store,
            &task.task_id,
            &task.user_id,
            &task.workspace_id,
            &approval.action,
            &approval.risk_level,
            &approval.data_boundary,
            &approval.explanation,
        )
        .map_err(GatewayError::task)?;
    task.status = TaskStatus::WaitingUserApproval;
    task.blocked_reason = Some(format!("approval required: {}", approval.action));
    task.clear_lease();
    task.updated_at = OffsetDateTime::now_utc();
    store.release_resources(task).map_err(GatewayError::task)?;
    store.insert_task(task).map_err(GatewayError::task)?;
    let _ = approval_request;
    Ok(())
}

/// Computes the session-level `(status, progress_current)` for a thread whose
/// work was fanned out by the Brain into N member tasks. Reads each member's
/// terminal state from the durable task store:
/// - `progress_current` = number of members that have completed,
/// - status is `WaitingUser` if any member needs approval, else `Failed` if all
///   members are terminal and at least one failed/cancelled, else `Completed`
///   when every member is terminal, else `Running`.
///
/// Returns `None` when the thread has no linked members (caller keeps the
/// legacy per-task values), so the single-task path is never affected.
fn aggregate_member_session_state(
    state: &AppState,
    thread: &local_first_desktop_gateway::ChatThread,
    user: &UserId,
    workspace: &WorkspaceId,
) -> Result<Option<(SessionStatus, u32)>, GatewayError> {
    let member_ids = {
        let chat_store = lock_store(state)?;
        chat_store
            .member_task_ids_for_thread(&thread.thread_id)
            .map_err(GatewayError::store)?
    };
    if member_ids.is_empty() {
        return Ok(None);
    }

    let counts = {
        let store = lock_task_store(state)?;
        collect_member_counts(&store, &member_ids, user, workspace).map_err(GatewayError::task)?
    };
    Ok(Some(aggregate_session_state_from_counts(
        member_ids.len(),
        counts.completed,
        counts.terminal,
        counts.any_failed,
        counts.any_waiting_user,
    )))
}

/// Terminal-state tally of a thread's member tasks, read from the durable store.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MemberCounts {
    pub(crate) completed: u32,
    pub(crate) terminal: u32,
    pub(crate) any_failed: bool,
    pub(crate) any_waiting_user: bool,
}

/// Reads each member task's status from the durable store and tallies it.
/// Separated from [`aggregate_member_session_state`] so the store-reading loop
/// is testable against an in-memory `TaskStore` without a full `AppState`.
/// Missing tasks are skipped (treated as not-yet-terminal).
pub(crate) fn collect_member_counts(
    store: &TaskStore,
    member_ids: &[String],
    user: &UserId,
    workspace: &WorkspaceId,
) -> Result<MemberCounts, TaskRuntimeError> {
    let mut counts = MemberCounts::default();
    for task_id in member_ids {
        let Some(member) = store.get_task(&TaskId::new(task_id.clone()), user, workspace)? else {
            continue;
        };
        match member.status {
            TaskStatus::Completed => {
                counts.completed += 1;
                counts.terminal += 1;
            }
            TaskStatus::Failed | TaskStatus::Cancelled | TaskStatus::Expired => {
                counts.any_failed = true;
                counts.terminal += 1;
            }
            TaskStatus::WaitingUserApproval => counts.any_waiting_user = true,
            _ => {}
        }
    }
    Ok(counts)
}

/// Pure decision for the aggregate session status given member-task counts.
/// Extracted from [`aggregate_member_session_state`] so the branch logic is
/// unit-testable without standing up the durable stores.
pub(crate) fn aggregate_session_state_from_counts(
    total: usize,
    completed: u32,
    terminal: u32,
    any_failed: bool,
    any_waiting_user: bool,
) -> (SessionStatus, u32) {
    let all_terminal = terminal as usize >= total;
    let status = if any_waiting_user {
        SessionStatus::WaitingUser
    } else if all_terminal && any_failed {
        SessionStatus::Failed
    } else if all_terminal {
        SessionStatus::Completed
    } else {
        SessionStatus::Running
    };
    (status, completed)
}

fn sync_session_for_task_run(
    state: &AppState,
    task: &TaskRecord,
    status: SessionStatus,
    progress_current: u32,
    last_error: Option<String>,
) -> Result<(), GatewayError> {
    let thread = {
        let chat_store = lock_store(state)?;
        chat_store
            .thread_by_task_id(task.task_id.as_str())
            .map_err(GatewayError::store)?
    };
    let Some(thread) = thread else {
        return Ok(());
    };
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();

    // A1.2 aggregation: when this task is a Brain-materialized *member* (its id
    // differs from the thread's primary task_id, so it resolved via the link
    // table), the per-task status/progress passed by the run loop describes ONE
    // step, not the whole session. Recompute session-level status/progress from
    // the terminal state of all members so the one session reflects N tasks and
    // only flips to Completed when the last member finishes.
    let (status, progress_current) = if thread.task_id.as_str() != task.task_id.as_str() {
        aggregate_member_session_state(state, &thread, &user, &workspace)?
            .unwrap_or((status, progress_current))
    } else {
        (status, progress_current)
    };

    let mut store = lock_computer_store(state)?;
    let Some(mut session) = store
        .session(
            &thread.computer_session_id,
            user.as_str(),
            workspace.as_str(),
        )
        .map_err(GatewayError::local_computer)?
    else {
        return Ok(());
    };

    session.status = status;
    session.progress_current = progress_current.min(session.progress_total);
    session.approval_state = match status {
        SessionStatus::Running | SessionStatus::Completed => ApprovalState::Approved,
        SessionStatus::WaitingUser => ApprovalState::WaitingUser,
        _ => session.approval_state,
    };
    session.last_error = last_error.clone();
    session.updated_at = OffsetDateTime::now_utc();
    store
        .upsert_session(&session)
        .map_err(GatewayError::local_computer)?;

    match status {
        SessionStatus::Running => append_computer_event(
            &mut store,
            &thread.computer_session_id,
            &user,
            &workspace,
            surface_for_task(task),
            "computer_task_running",
            "running",
            "Local execution started",
            "The approved task is running read-only.",
            false,
        )?,
        SessionStatus::Completed => append_computer_event(
            &mut store,
            &thread.computer_session_id,
            &user,
            &workspace,
            surface_for_task(task),
            "computer_task_completed",
            "done",
            "Task completed",
            "Summary result available in chat.",
            false,
        )?,
        SessionStatus::Failed => append_computer_event_with_payload(
            &mut store,
            &thread.computer_session_id,
            &user,
            &workspace,
            surface_for_task(task),
            "computer_task_failed",
            "failed",
            "Task not completed",
            last_error.as_deref().unwrap_or("Local error redacted."),
            serde_json::json!({ "error": last_error.clone().unwrap_or_else(|| "Local error redacted.".to_string()) }),
            false,
            vec![],
        )?,
        SessionStatus::WaitingUser => append_computer_event_with_payload(
            &mut store,
            &thread.computer_session_id,
            &user,
            &workspace,
            surface_for_task(task),
            "computer_task_waiting_approval",
            "waiting_user",
            "Approval required",
            last_error
                .as_deref()
                .unwrap_or("A confirmation is needed to continue."),
            serde_json::json!({
                "approval_required": true,
                "reason": last_error.clone().unwrap_or_else(|| "A confirmation is needed to continue.".to_string()),
            }),
            true,
            vec![],
        )?,
        _ => {}
    }
    Ok(())
}

fn append_task_result_to_chat(
    state: &AppState,
    task_id: &str,
    message_text: &str,
) -> Result<(), GatewayError> {
    let thread = {
        let chat_store = lock_store(state)?;
        chat_store
            .thread_by_task_id(task_id)
            .map_err(GatewayError::store)?
    };
    let Some(thread) = thread else {
        return Ok(());
    };
    let now = OffsetDateTime::now_utc();
    let message = local_first_desktop_gateway::ChatMessage {
        id: format!("assistant_task_{}_{}", task_id, now.unix_timestamp_nanos()),
        role: "assistant".to_string(),
        text: message_text.to_string(),
        timestamp: now.unix_timestamp().to_string(),
        metadata: Some("Executor locale".to_string()),
        metrics: None,
        feedback: None,
        saved_memory_ref: None,
        linked_task_id: Some(task_id.to_string()),
        linked_automation_ref: None,
        attachments: Vec::new(),
        event_parts: Vec::new(),
        memory_reuse: None,
        delivery_state: local_first_desktop_gateway::MessageDeliveryState::Delivered,
    };
    lock_store(state)?
        .append_assistant_message(&thread.thread_id, &message)
        .map_err(GatewayError::store)?;
    Ok(())
}

pub(crate) fn surface_task_execution_outcome(
    state: &AppState,
    task_id: &str,
    outcome: &TaskExecutionPresentation,
) -> Result<(), GatewayError> {
    if outcome.result_surfacing == TaskResultSurfacing::AppendToChat {
        append_task_result_to_chat(state, task_id, &outcome.chat_message)?;
    }
    Ok(())
}

fn append_task_observation_to_session(
    state: &AppState,
    task: &TaskRecord,
    outcome: &TaskExecutionPresentation,
) -> Result<(), GatewayError> {
    let thread = {
        let chat_store = lock_store(state)?;
        chat_store
            .thread_by_task_id(task.task_id.as_str())
            .map_err(GatewayError::store)?
    };
    let Some(thread) = thread else {
        return Ok(());
    };
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let mut store = lock_computer_store(state)?;
    for artifact in &outcome.artifacts {
        store
            .upsert_artifact(&ArtifactRecord {
                artifact_id: artifact.artifact_id.clone(),
                session_id: thread.computer_session_id.clone(),
                user_id: user.as_str().to_string(),
                workspace_id: workspace.as_str().to_string(),
                title: artifact.title.clone(),
                kind: artifact.kind.clone(),
                path_ref: artifact.path_ref.clone(),
                size_bytes: artifact.size_bytes,
                preview_ref: artifact.preview_ref.clone(),
                created_at: OffsetDateTime::now_utc(),
            })
            .map_err(GatewayError::local_computer)?;
    }
    let artifact_refs = outcome
        .artifacts
        .iter()
        .map(|artifact| artifact.artifact_id.clone())
        .collect::<Vec<_>>();
    append_computer_event_with_payload(
        &mut store,
        &thread.computer_session_id,
        &user,
        &workspace,
        outcome.surface,
        &outcome.event_kind,
        "done",
        &outcome.event_title,
        &outcome.event_subtitle,
        outcome.event_payload.clone(),
        false,
        artifact_refs,
    )
}

pub(crate) fn append_task_progress_checkpoint(
    state: &AppState,
    task: &TaskRecord,
    phase: &str,
    surface: SurfaceKind,
    title: &str,
    subtitle: &str,
    payload: Value,
) -> Result<(), GatewayError> {
    {
        let store = lock_task_store(state)?;
        store
            .append_checkpoint(
                &task.task_id,
                &task.user_id,
                &task.workspace_id,
                payload.clone(),
                payload.clone(),
            )
            .map_err(GatewayError::task)?;
    }
    append_task_progress_event(state, task, phase, surface, title, subtitle, payload)
}

fn append_task_progress_event(
    state: &AppState,
    task: &TaskRecord,
    phase: &str,
    surface: SurfaceKind,
    title: &str,
    subtitle: &str,
    payload: Value,
) -> Result<(), GatewayError> {
    let thread = {
        let chat_store = lock_store(state)?;
        chat_store
            .thread_by_task_id(task.task_id.as_str())
            .map_err(GatewayError::store)?
    };
    let Some(thread) = thread else {
        return Ok(());
    };
    let mut store = lock_computer_store(state)?;
    append_computer_event_with_payload(
        &mut store,
        &thread.computer_session_id,
        &task.user_id,
        &task.workspace_id,
        surface,
        phase,
        "running",
        title,
        subtitle,
        payload,
        false,
        vec![],
    )
}

#[derive(Debug)]
pub(crate) struct LocalTaskExecutionError {
    pub(crate) message: String,
}

pub(crate) fn local_task_gateway_error(error: GatewayError) -> LocalTaskExecutionError {
    LocalTaskExecutionError {
        message: error.message,
    }
}

fn task_with_dependency_outputs(
    state: &AppState,
    task: &TaskRecord,
) -> Result<TaskRecord, LocalTaskExecutionError> {
    let store = lock_task_store(state).map_err(local_task_gateway_error)?;
    let dependency_outputs = store
        .dependency_outputs_for(&task.task_id, &task.user_id, &task.workspace_id)
        .map_err(GatewayError::task)
        .map_err(local_task_gateway_error)?;
    if dependency_outputs.is_empty() {
        return Ok(task.clone());
    }

    let outputs = dependency_outputs
        .into_iter()
        .map(|dependency| {
            serde_json::json!({
                "task_id": dependency.task_id.as_str(),
                "output": dependency.output,
                "redacted_output": dependency.redacted_output,
            })
        })
        .collect::<Vec<_>>();

    let mut enriched = task.clone();
    let mut input = enriched.input_json.as_object().cloned().unwrap_or_default();
    input.insert("previous_step_outputs".to_string(), Value::Array(outputs));
    enriched.input_json = Value::Object(input);
    Ok(enriched)
}
