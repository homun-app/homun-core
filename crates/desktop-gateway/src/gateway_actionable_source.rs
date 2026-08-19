//! Actionable source claim and resolution owner.
//!
//! Owns the one-shot transition from a persisted actionable assistant card to
//! a claimed/resolved task/message state. Execution, payment approval, remote
//! approval dispatch and browser enforcement stay in their dedicated owners.

use crate::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ActionableSourceResolution {
    Succeeded,
    Cancelled,
    Failed,
}

impl ActionableSourceResolution {
    fn task_status(self) -> TaskStatus {
        match self {
            Self::Succeeded => TaskStatus::Completed,
            Self::Cancelled => TaskStatus::Cancelled,
            Self::Failed => TaskStatus::Failed,
        }
    }

    fn delivery_state(self) -> local_first_desktop_gateway::MessageDeliveryState {
        match self {
            Self::Succeeded => local_first_desktop_gateway::MessageDeliveryState::Delivered,
            Self::Cancelled => local_first_desktop_gateway::MessageDeliveryState::Cancelled,
            Self::Failed => local_first_desktop_gateway::MessageDeliveryState::Failed,
        }
    }
}

fn actionable_source_error(message: impl Into<String>) -> GatewayError {
    GatewayError {
        status: StatusCode::CONFLICT,
        code: "actionable_source_resolution",
        message: message.into(),
    }
}

pub(crate) fn actionable_source_terminal_text(text: &str, note: &str) -> String {
    let visible = strip_display_markers(text).trim().to_string();
    if visible.is_empty() {
        note.to_string()
    } else {
        format!("{visible}\n\n{note}")
    }
}

pub(crate) fn actionable_claim_error(message: impl Into<String>) -> GatewayError {
    GatewayError {
        status: StatusCode::CONFLICT,
        code: "actionable_source_claim",
        message: message.into(),
    }
}

/// Once an endpoint has proved a request came from its exact persisted card,
/// every terminal executor error must release that source before being returned
/// to the caller. This keeps a retryable UI error from becoming a permanent
/// `WaitingUserApproval`/`ThreadBusy` deadlock.
pub(crate) fn terminal_actionable_execution_error(
    state: &AppState,
    thread_id: Option<&str>,
    message_id: Option<&str>,
    code: &'static str,
    message: impl Into<String>,
    source_note: &str,
) -> GatewayError {
    if let (Some(thread_id), Some(message_id)) = (thread_id, message_id) {
        let _ = resolve_actionable_source(
            state,
            thread_id,
            message_id,
            |text| actionable_source_terminal_text(text, source_note),
            ActionableSourceResolution::Failed,
        );
    }
    GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code,
        message: message.into(),
    }
}

/// One-shot security boundary for every actionable side effect. In production
/// the task runtime and chat transcript share one SQLite file, so the exact
/// linked task and exact message transition together or not at all.
pub(crate) fn claim_actionable_source<F>(
    state: &AppState,
    thread_id: &str,
    message_id: &str,
    provenance_matches: F,
) -> Result<(), GatewayError>
where
    F: FnOnce(&str) -> bool,
{
    #[cfg(not(test))]
    {
        let user = gateway_user_id();
        let store = lock_task_store(state)?;
        store
            .with_transaction(|tx| {
                let row = tx
                    .query_row(
                        "select m.text, m.linked_task_id, c.workspace_id, t.task_json
                         from chat_messages m
                         join chat_threads c on c.thread_id = m.thread_id
                         join tasks t on t.task_id = m.linked_task_id
                           and t.user_id = ?3 and t.workspace_id = c.workspace_id
                         where m.thread_id = ?1 and m.id = ?2 and m.role = 'assistant'
                           and m.delivery_state = 'waiting_user'
                           and t.status = 'waiting_user_approval'",
                        rusqlite::params![thread_id, message_id, user.as_str()],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                            ))
                        },
                    )
                    .optional()?;
                let Some((text, task_id, workspace_id, task_json)) = row else {
                    return Err(TaskRuntimeError::InvalidTransition(
                        "actionable source is stale, cancelled, or already claimed".to_string(),
                    ));
                };
                if !provenance_matches(&text) {
                    return Err(TaskRuntimeError::InvalidTransition(
                        "persisted actionable card provenance does not match".to_string(),
                    ));
                }
                let mut task: TaskRecord = serde_json::from_str(&task_json)?;
                let supported = task.kind == "chat_turn"
                    || state
                        .task_executor_registry
                        .resolve(task.kind.as_str())
                        .is_some_and(|adapter| adapter.name() == "proactive_prompt");
                let exact_source = task.input_json.get("thread_id").and_then(Value::as_str)
                    == Some(thread_id)
                    && task
                        .input_json
                        .get("assistant_message_id")
                        .and_then(Value::as_str)
                        == Some(message_id);
                if !supported || task.status != TaskStatus::WaitingUserApproval || !exact_source {
                    return Err(TaskRuntimeError::InvalidTransition(
                        "linked task does not own this waiting actionable source".to_string(),
                    ));
                }
                task.status = TaskStatus::Running;
                task.blocked_reason = Some("actionable side effect claimed".to_string());
                task.updated_at = OffsetDateTime::now_utc();
                let changed_task = tx.execute(
                    "update tasks set status = 'running', blocked_reason = ?1,
                        updated_at = ?2, task_json = ?3
                     where task_id = ?4 and user_id = ?5 and workspace_id = ?6
                       and status = 'waiting_user_approval'",
                    rusqlite::params![
                        task.blocked_reason,
                        task.updated_at.unix_timestamp(),
                        serde_json::to_string(&task)?,
                        task_id,
                        user.as_str(),
                        workspace_id,
                    ],
                )?;
                let changed_message = tx.execute(
                    "update chat_messages set delivery_state = 'retrying'
                     where thread_id = ?1 and id = ?2 and linked_task_id = ?3
                       and delivery_state = 'waiting_user'",
                    rusqlite::params![thread_id, message_id, task_id],
                )?;
                if changed_task != 1 || changed_message != 1 {
                    return Err(TaskRuntimeError::InvalidTransition(
                        "actionable source claim lost a concurrent race".to_string(),
                    ));
                }
                Ok(())
            })
            .map_err(|error| actionable_claim_error(error.to_string()))
    }

    #[cfg(test)]
    {
        let user = gateway_user_id();
        let task_store = lock_task_store(state)?;
        let chat_store = lock_store(state)?;
        let message = chat_store
            .message(thread_id, message_id)
            .map_err(GatewayError::store)?
            .ok_or_else(|| actionable_claim_error("actionable source message is missing"))?;
        if message.role != "assistant"
            || message.delivery_state
                != local_first_desktop_gateway::MessageDeliveryState::WaitingUser
            || !provenance_matches(&message.text)
        {
            return Err(actionable_claim_error(
                "actionable source is stale or provenance does not match",
            ));
        }
        let task_id = message
            .linked_task_id
            .as_deref()
            .ok_or_else(|| actionable_claim_error("actionable source has no linked task"))?;
        let workspace = WorkspaceId::new(
            chat_store
                .workspace_for_thread(thread_id)
                .map_err(GatewayError::store)?,
        );
        let mut task = task_store
            .get_task(&TaskId::new(task_id), &user, &workspace)
            .map_err(GatewayError::task)?
            .ok_or_else(|| actionable_claim_error("linked actionable task is missing"))?;
        let supported = task.kind == "chat_turn"
            || state
                .task_executor_registry
                .resolve(task.kind.as_str())
                .is_some_and(|adapter| adapter.name() == "proactive_prompt");
        let exact_source = task.input_json.get("thread_id").and_then(Value::as_str)
            == Some(thread_id)
            && task
                .input_json
                .get("assistant_message_id")
                .and_then(Value::as_str)
                == Some(message_id);
        if !supported || task.status != TaskStatus::WaitingUserApproval || !exact_source {
            return Err(actionable_claim_error(
                "linked task does not own this waiting actionable source",
            ));
        }
        task.status = TaskStatus::Running;
        task.blocked_reason = Some("actionable side effect claimed".to_string());
        task.updated_at = OffsetDateTime::now_utc();
        task_store.insert_task(&task).map_err(GatewayError::task)?;
        if !chat_store
            .set_message_delivery_state(
                thread_id,
                message_id,
                local_first_desktop_gateway::MessageDeliveryState::Retrying,
            )
            .map_err(GatewayError::store)?
        {
            return Err(actionable_claim_error(
                "actionable source claim lost a concurrent race",
            ));
        }
        Ok(())
    }
}

/// Resolves the exact durable chat turn which owns an actionable assistant card.
///
/// Canonical approval sources remain non-terminal until their typed wake is
/// delivered. Legacy cards without a journal retain the old terminalize-then-
/// enqueue behavior during migration. New broker turns carry `linked_task_id`;
/// legacy cards may fall back only to the exact source pair stored in task input.
pub(crate) fn resolve_actionable_source<F>(
    state: &AppState,
    thread_id: &str,
    message_id: &str,
    rewrite: F,
    resolution: ActionableSourceResolution,
) -> Result<(), GatewayError>
where
    F: FnOnce(&str) -> String,
{
    let (message, workspace_id) = {
        let store = lock_store(state)?;
        let message = store
            .message(thread_id, message_id)
            .map_err(GatewayError::store)?
            .ok_or_else(|| actionable_source_error("actionable source message is missing"))?;
        if message.role != "assistant" {
            return Err(actionable_source_error(
                "actionable source message is not an assistant reply",
            ));
        }
        let workspace_id = store
            .workspace_for_thread(thread_id)
            .map_err(GatewayError::store)?;
        (message, workspace_id)
    };
    let user = gateway_user_id();
    let workspace = WorkspaceId::new(workspace_id);
    let task_id = {
        let store = lock_task_store(state)?;
        if let Some(task_id) = message.linked_task_id.as_deref() {
            TaskId::new(task_id)
        } else {
            store
                .list_tasks(&user, &workspace)
                .map_err(GatewayError::task)?
                .into_iter()
                .find(|task| {
                    task.kind == "chat_turn"
                        && task.input_json.get("thread_id").and_then(Value::as_str)
                            == Some(thread_id)
                        && task
                            .input_json
                            .get("assistant_message_id")
                            .and_then(Value::as_str)
                            == Some(message_id)
                })
                .map(|task| task.task_id)
                .ok_or_else(|| {
                    actionable_source_error("no exact legacy chat turn owns this actionable card")
                })?
        }
    };

    let canonical_resume;
    {
        let store = lock_task_store(state)?;
        let mut task = store
            .get_task(&task_id, &user, &workspace)
            .map_err(GatewayError::task)?
            .ok_or_else(|| actionable_source_error("linked actionable source task is missing"))?;
        let supported_persisted_bubble = task.kind == "chat_turn"
            || state
                .task_executor_registry
                .resolve(task.kind.as_str())
                .is_some_and(|adapter| adapter.name() == "proactive_prompt");
        let lifecycle_matches = match resolution {
            ActionableSourceResolution::Cancelled => {
                (task.status == TaskStatus::WaitingUserApproval
                    && message.delivery_state
                        == local_first_desktop_gateway::MessageDeliveryState::WaitingUser)
                    || (task.status == TaskStatus::Running
                        && message.delivery_state
                            == local_first_desktop_gateway::MessageDeliveryState::Retrying)
            }
            ActionableSourceResolution::Succeeded | ActionableSourceResolution::Failed => {
                task.status == TaskStatus::Running
                    && message.delivery_state
                        == local_first_desktop_gateway::MessageDeliveryState::Retrying
            }
        };
        let matches_source = supported_persisted_bubble
            && lifecycle_matches
            && task.input_json.get("thread_id").and_then(Value::as_str) == Some(thread_id)
            && task
                .input_json
                .get("assistant_message_id")
                .and_then(Value::as_str)
                == Some(message_id);
        if !matches_source {
            return Err(actionable_source_error(
                "linked task does not own the actionable source message",
            ));
        }
        canonical_resume = store
            .pending_execution_wakes(user.as_str(), workspace.as_str(), Some(thread_id))
            .map_err(GatewayError::task)?
            .into_iter()
            .any(|wake| {
                wake.execution_id == task.task_id.as_str()
                    && matches!(
                        wake.condition,
                        local_first_execution_protocol::WakeCondition::Approval { .. }
                    )
            });
        if canonical_resume {
            task.status = TaskStatus::Running;
            task.blocked_reason = Some("approval decision committed; wake pending".to_string());
        } else {
            task.status = resolution.task_status();
            task.blocked_reason = match resolution {
                ActionableSourceResolution::Succeeded => None,
                ActionableSourceResolution::Cancelled => {
                    Some("actionable card cancelled".to_string())
                }
                ActionableSourceResolution::Failed => {
                    Some("actionable card execution failed".to_string())
                }
            };
            task.clear_lease();
            store.release_resources(&task).map_err(GatewayError::task)?;
        }
        task.updated_at = OffsetDateTime::now_utc();
        store.insert_task(&task).map_err(GatewayError::task)?;
    }

    let rewritten = rewrite(&message.text);
    let remote_approval_id =
        remote_approval_intent_from_raw_text(&message.text).and_then(|intent| intent.approval_id);
    let store = lock_store(state)?;
    if resolution != ActionableSourceResolution::Cancelled
        && let Some(approval_id) = remote_approval_id.as_deref()
    {
        let _ = store.supersede_remote_approval(approval_id);
    }
    store
        .set_message_text(thread_id, message_id, &rewritten)
        .map_err(GatewayError::store)?;
    let delivery_state = if canonical_resume {
        local_first_desktop_gateway::MessageDeliveryState::Retrying
    } else {
        resolution.delivery_state()
    };
    if !store
        .set_message_delivery_state(thread_id, message_id, delivery_state)
        .map_err(GatewayError::store)?
    {
        return Err(actionable_source_error(
            "actionable source message could not transition delivery state",
        ));
    }
    publish_app_event(serde_json::json!({
        "type": "thread.updated",
        "thread_id": thread_id,
        "workspace": base_workspace_id(),
    }));
    drop(store);
    if canonical_resume && resolution != ActionableSourceResolution::Succeeded {
        let (result, prompt) = match resolution {
            ActionableSourceResolution::Cancelled => (
                "declined",
                "The user declined the requested action. Continue the same objective without executing it and explain the safe next step.",
            ),
            ActionableSourceResolution::Failed => (
                "failed",
                "The approved action failed. Continue the same objective from the durable checkpoint, report the failure accurately, and do not claim it succeeded.",
            ),
            ActionableSourceResolution::Succeeded => unreachable!(),
        };
        resume_suspended_approval_turn_core(
            state, thread_id, false, "approval", result, None, prompt,
        )
        .map_err(|error| actionable_source_error(error.to_string()))?
        .ok_or_else(|| actionable_source_error("canonical approval wake disappeared"))?;
    }
    Ok(())
}
