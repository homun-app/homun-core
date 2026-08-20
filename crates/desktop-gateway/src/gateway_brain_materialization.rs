//! Durable task materialization through the Orchestrator Brain.
//!
//! This owner turns a chat goal into background tasks and links those tasks back
//! to the originating thread/session. Brain runtime configuration stays in
//! `gateway_brain_runtime`; chat task routes stay in `gateway_chat_tasks`.

use crate::gateway_brain_runtime::{brain_budgets_for_context_window, open_brain_memory};
use crate::gateway_identity::{
    gateway_capability_user_id, gateway_capability_workspace_id, gateway_user_id,
    gateway_workspace_id,
};
use crate::gateway_paths::gateway_task_database_path;
use crate::gateway_task_executor::local_task_gateway_error;
use crate::gateway_text_safety::task_goal_summary;
use crate::gateway_user_preferences::effective_user_language;
use crate::{
    AppState, GatewayError, LocalTaskExecutionError, build_browser_inference_router,
    ensure_computer_session_for_task, lock_capability_registry, lock_computer_store, lock_store,
};
use local_first_capabilities::{
    ActionClass, CachedToolProvider, CapabilityFacade, CapabilityPolicy, CapabilityProviderKind,
    InMemoryCapabilityAudit,
};
use local_first_inference::Requirements;
use local_first_orchestrator::{OrchestratorBrain, OrchestratorRequest};
use local_first_task_runtime::{TaskId, TaskStore, UserId, WorkspaceId};
use time::OffsetDateTime;

/// A1.1: runs the OrchestratorBrain so it MATERIALIZES durable tasks into the
/// shared TaskStore (the same DB the background worker polls). Durable-only:
/// the request policy has empty `allowed_actions`, so every tool is
/// visible-but-not-executable -> the Brain never calls `call_tool` (so the
/// planning-only CachedToolProvider is safe) and enqueues every step as a
/// durable task, executed by the worker's real executors (browser/subagent).
/// Returns the materialized task ids, or an error so the caller can fall back.
pub(crate) fn brain_materialize_tasks(
    state: &AppState,
    thread_id: &str,
    goal: &str,
) -> Result<Vec<String>, LocalTaskExecutionError> {
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();

    let (mut policy_context, provider_tools) = {
        let registry = lock_capability_registry(state).map_err(local_task_gateway_error)?;
        let policy = registry
            .policy_context(&user, &workspace)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("policy context: {error}"),
            })?;
        let mut provider_tools = Vec::new();
        for provider in &policy.enabled_providers {
            let tools = registry
                .cached_tools(provider)
                .map_err(|error| LocalTaskExecutionError {
                    message: format!("cached tools: {error}"),
                })?
                .into_iter()
                .map(|cached| cached.tool)
                .collect::<Vec<_>>();
            provider_tools.push((provider.clone(), tools));
        }
        (policy, provider_tools)
    };
    // Durable-first, but allow the NON-destructive action classes (Read/Draft)
    // so the planner can delegate sub-tasks to subagents (whose envelope must be
    // non-empty). Destructive classes (WriteWithConfirmation/ApprovedAutomation)
    // stay out, so no send/pay/write executes without an explicit user gate.
    policy_context.allowed_actions = vec![ActionClass::Read, ActionClass::Draft];

    let mut facade = CapabilityFacade::new(CapabilityPolicy, InMemoryCapabilityAudit::default());
    for (provider_id, tools) in provider_tools {
        let kind = tools
            .first()
            .map(|tool| tool.provider_kind)
            .unwrap_or(CapabilityProviderKind::Native);
        facade.register_provider(CachedToolProvider::new(provider_id, kind, tools));
    }

    let task_store =
        TaskStore::open(
            gateway_task_database_path().map_err(|error| LocalTaskExecutionError {
                message: error.to_string(),
            })?,
        )
        .map_err(|error| LocalTaskExecutionError {
            message: format!("shared task store: {error}"),
        })?;

    let router = build_browser_inference_router();
    let budgets =
        brain_budgets_for_context_window(router.active_context_window(&Requirements::default()));
    let mut brain = OrchestratorBrain::new(router, open_brain_memory(), facade, task_store);
    let request = OrchestratorRequest {
        request_id: format!("brain_{}", uuid::Uuid::new_v4().simple()),
        policy_context,
        user_message: goal.to_string(),
        conversation_summary: None,
        attachments: Vec::new(),
        budgets,
        language: effective_user_language(),
    };
    // Browser INTERACTION is no longer materialized as a durable `browser_task`:
    // the main chat agent drives the browser inline (granular tools). The Brain
    // here only materializes non-browser capability/subagent tasks.
    let task_ids = {
        let outcome = brain
            .run(request)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("brain run: {error}"),
            })?;
        let mut ids = Vec::new();
        for summary in &outcome.enqueued_tasks {
            ids.push(summary.task_id.as_str().to_string());
        }
        for summary in &outcome.enqueued_subagent_tasks {
            ids.push(summary.task_id.as_str().to_string());
        }
        ids
    };

    // Keep the canonical task-runtime projection linked to the originating chat.
    // ChatStore has its own task->thread relation for message surfacing, while
    // the runtime column is what `/activity` uses for subagent status and
    // timestamps.
    let runtime_user = UserId::new(user.as_str());
    let runtime_workspace = WorkspaceId::new(workspace.as_str());
    for task_id in &task_ids {
        let linked = brain
            .task_store()
            .link_task_to_thread(
                &TaskId::new(task_id),
                &runtime_user,
                &runtime_workspace,
                thread_id,
            )
            .map_err(|error| LocalTaskExecutionError {
                message: format!("task thread linkage: {error}"),
            })?;
        if !linked {
            return Err(LocalTaskExecutionError {
                message: format!("task thread linkage: task {task_id} was not found"),
            });
        }
    }

    // A1.2: bind the materialized task(s) to the originating chat thread so the
    // worker's existing session/chat surfacing (sync_session_for_task_run,
    // append_task_result_to_chat -- both keyed on thread_by_task_id) resolves
    // them into the thread's single Local Computer session. Best-effort: a
    // linkage hiccup must not lose the materialized tasks (they just run
    // "headless" as before), so failures are logged, not propagated.
    if !task_ids.is_empty()
        && let Err(error) = link_brain_tasks_to_thread(state, thread_id, goal, &task_ids)
    {
        eprintln!(
            "brain_materialize_tasks: thread linkage failed for {thread_id}: {}",
            error.message
        );
    }

    Ok(task_ids)
}

/// Links Brain-materialized tasks to their chat thread and seeds the thread's
/// aggregating Local Computer session (progress_total = number of tasks), so a
/// single prompt that fans out into N durable tasks surfaces as ONE session with
/// per-task progress and results in chat.
pub(crate) fn link_brain_tasks_to_thread(
    state: &AppState,
    thread_id: &str,
    goal: &str,
    task_ids: &[String],
) -> Result<(), LocalTaskExecutionError> {
    let thread = {
        let chat_store = lock_store(state).map_err(local_task_gateway_error)?;
        chat_store
            .thread(thread_id)
            .map_err(GatewayError::store)
            .map_err(local_task_gateway_error)?
    };
    let Some(thread) = thread else {
        return Ok(());
    };

    // Seed (or reuse) the aggregating session, then size its progress bar to the
    // number of tasks the Brain planned.
    let goal_redacted = task_goal_summary(goal);
    ensure_computer_session_for_task(
        state,
        &thread.computer_session_id,
        &thread.task_id,
        thread_id,
        &goal_redacted,
        false,
    )
    .map_err(local_task_gateway_error)?;
    set_session_progress_total(state, &thread.computer_session_id, task_ids.len() as u32)
        .map_err(local_task_gateway_error)?;

    // Resolve every member task back to this thread.
    let chat_store = lock_store(state).map_err(local_task_gateway_error)?;
    for task_id in task_ids {
        chat_store
            .link_task_to_thread(task_id, thread_id)
            .map_err(GatewayError::store)
            .map_err(local_task_gateway_error)?;
    }
    Ok(())
}

/// Overrides the aggregating session's `progress_total` to the planned task
/// count (the seeding helper uses the legacy single-task default of 2/3).
pub(crate) fn set_session_progress_total(
    state: &AppState,
    session_id: &str,
    total: u32,
) -> Result<(), GatewayError> {
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let store = lock_computer_store(state)?;
    if let Some(mut session) = store
        .session(session_id, user.as_str(), workspace.as_str())
        .map_err(GatewayError::local_computer)?
    {
        session.progress_total = total.max(1);
        session.progress_current = session.progress_current.min(session.progress_total);
        session.updated_at = OffsetDateTime::now_utc();
        store
            .upsert_session(&session)
            .map_err(GatewayError::local_computer)?;
    }
    Ok(())
}
