//! Execution owner for scheduled/evented proactive prompt tasks.
//!
//! Thread planning stays in `gateway_proactive_threads`; persisted visible-turn
//! creation stays in `gateway_visible_turns`. This owner wires those surfaces to
//! the agent turn and maps the typed engine stop into task execution outcomes.

use super::*;

pub(crate) fn start_proactive_visible_turn(
    state: &AppState,
    task: &TaskRecord,
    thread_id: &str,
    thread_plan: &ProactiveThreadPlan,
    goal: &str,
) -> Result<VisibleConversationTurn, LocalTaskExecutionError> {
    let visible_turn = start_visible_conversation_turn(
        state,
        thread_id,
        &thread_plan.workspace_id,
        &thread_plan.source,
        thread_plan.channel.as_deref(),
        &thread_plan.title,
        goal,
        None,
        None,
        None,
        Some(task.task_id.as_str()),
    )
    .ok_or_else(|| LocalTaskExecutionError {
        message: "could not start a visible automation turn".to_string(),
    })?;

    let store = lock_task_store(state).map_err(local_task_gateway_error)?;
    let mut persisted = store
        .get_task(&task.task_id, &task.user_id, &task.workspace_id)
        .map_err(GatewayError::task)
        .map_err(local_task_gateway_error)?
        .ok_or_else(|| LocalTaskExecutionError {
            message: "owning proactive task disappeared before execution".to_string(),
        })?;
    let mut input = persisted
        .input_json
        .as_object()
        .cloned()
        .unwrap_or_default();
    input.insert(
        "thread_id".to_string(),
        Value::String(thread_id.to_string()),
    );
    input.insert(
        "assistant_message_id".to_string(),
        Value::String(visible_turn.assistant_message_id.clone()),
    );
    persisted.input_json = Value::Object(input);
    persisted.updated_at = OffsetDateTime::now_utc();
    store
        .insert_task(&persisted)
        .map_err(GatewayError::task)
        .map_err(local_task_gateway_error)?;
    Ok(visible_turn)
}

/// Executes a scheduled/recurring "proactive prompt": runs a full agent turn on
/// the task's goal in a stable per-schedule chat thread, persists the exchange,
/// and pushes a live `/api/events` update so the desktop app surfaces it.
pub(crate) fn execute_proactive_prompt_task(
    state: &AppState,
    task: &TaskRecord,
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
    control: std::sync::Arc<crate::execution_control::ExecutionAttemptControl>,
) -> Result<local_first_execution_protocol::ExecutionOutcome, LocalTaskExecutionError> {
    let goal = task.goal.clone();
    let thread_plan = proactive_thread_plan(task, &goal);

    let thread_id = if let Some(root) = thread_plan.scheduled_root.clone() {
        match lock_store(state) {
            Ok(store) => store
                .find_or_create_channel_thread(
                    &thread_plan.workspace_id,
                    &thread_plan.source,
                    &root,
                    &thread_plan.title,
                )
                .ok()
                .map(|thread| thread.thread_id),
            Err(_) => None,
        }
    } else {
        thread_plan.thread_id.clone()
    };
    let Some(thread_id) = thread_id else {
        return Err(LocalTaskExecutionError {
            message: "could not create the automation thread".to_string(),
        });
    };

    let is_automation = task.input_json.get("automation_id").is_some();
    let is_autonomous = task
        .input_json
        .get("approval")
        .and_then(|v| v.as_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("autonomous"));
    let policy = if is_automation && is_autonomous {
        "autonomous"
    } else if is_automation {
        "full"
    } else {
        "read_only"
    };

    let visible_turn = start_proactive_visible_turn(state, task, &thread_id, &thread_plan, &goal)?;

    let request_id = agent_turn_stream_request_id(&visible_turn.assistant_message_id);
    let result = tokio::runtime::Handle::current().block_on(async {
        tokio::select! {
            biased;
            interruption = control.interrupted() => {
                tracing::info!(
                    target: "proactive::executor",
                    execution_id = %contract.as_ref().execution_id,
                    ?interruption,
                    "runtime interruption reached proactive agent turn"
                );
                abort_stream_generation(&request_id);
                Ok(None)
            }
            result = run_agent_turn_into_message(
                state,
                &thread_id,
                &goal,
                policy,
                &visible_turn.user_message_id,
                &visible_turn.assistant_message_id,
                local_first_desktop_gateway::MessageDeliveryState::Streaming,
            ) => result,
        }
    });
    let agent_result = result.ok().flatten();
    let waiting_action = agent_result
        .as_ref()
        .and_then(|result| result.actionable_cards.first())
        .map(|card| card.kind.to_string());
    let wake = agent_result.as_ref().and_then(|result| {
        wake_for_agent_stop(contract, &result.outcome.stop, waiting_action.as_deref())
    });
    let answer = agent_result.as_ref().map(|result| result.text.clone());
    let stop_failure = agent_result
        .as_ref()
        .and_then(|result| match &result.outcome.stop {
            local_first_engine::TurnStop::Failed { failure } => {
                Some(failure.redacted_detail.clone())
            }
            _ => None,
        });
    let incomplete_reason = stop_failure.or_else(|| {
        answer
            .as_deref()
            .and_then(agent_output_incomplete_reason)
            .or_else(|| {
                answer
                    .is_none()
                    .then(|| "scheduled task produced no final reply".to_string())
            })
    });

    let completed = incomplete_reason.is_none()
        && agent_result
            .as_ref()
            .is_some_and(|result| result.outcome.stop == local_first_engine::TurnStop::Completed);
    let suspended = wake.is_some();
    let blocked_reason = if suspended {
        Some("scheduled task is waiting for its durable wake".to_string())
    } else {
        incomplete_reason.clone()
    };
    let summary = blocked_reason.clone().unwrap_or_else(|| {
        if suspended {
            "Scheduled task is waiting for its durable wake.".to_string()
        } else {
            "Scheduled task executed.".to_string()
        }
    });
    let presentation = TaskExecutionPresentation {
        pending_approval: matches!(
            wake,
            Some(local_first_execution_protocol::WakeCondition::Approval { .. })
        )
        .then(|| PendingExecutorApproval {
            action: waiting_action
                .clone()
                .unwrap_or_else(|| "action card".to_string()),
            risk_level: "high".to_string(),
            data_boundary: "in-chat action card".to_string(),
            explanation: "The scheduled task is waiting for its persisted action card.".to_string(),
            inline_action_card: true,
        }),
        summary,
        checkpoint_payload: serde_json::json!({
            "kind": "proactive_prompt",
            "goal": goal,
            "thread_id": thread_id,
            "assistant_message_id": visible_turn.assistant_message_id,
            "user_message_id": visible_turn.user_message_id,
            "objective_revision": contract.as_ref().objective.as_ref().map(|objective| objective.revision),
            "awaiting_user": agent_result.as_ref().and_then(|result| result.outcome.awaiting_user.clone()),
            "answer": answer,
            "completed": completed,
            "suspended": suspended,
        }),
        checkpoint_redacted: serde_json::json!({
            "kind": "proactive_prompt",
            "completed": completed,
        }),
        chat_message: answer.clone().unwrap_or_default(),
        result_surfacing: TaskResultSurfacing::AlreadyPersisted,
        surface: SurfaceKind::Logs,
        event_kind: if completed {
            "proactive_prompt_completed".to_string()
        } else if suspended {
            "proactive_prompt_suspended".to_string()
        } else {
            "proactive_prompt_incomplete".to_string()
        },
        event_title: if completed {
            "Scheduled task completed".to_string()
        } else if suspended {
            "Scheduled task suspended".to_string()
        } else {
            "Scheduled task incomplete".to_string()
        },
        event_subtitle: if completed {
            "Scheduled proactive execution.".to_string()
        } else if suspended {
            "The execution is waiting for its registered wake condition.".to_string()
        } else {
            "Scheduled task stopped before finishing its plan.".to_string()
        },
        event_payload: serde_json::json!({ "goal": goal }),
        artifacts: vec![],
    };
    if completed {
        execution_runtime::complete_task_execution(state, task, presentation)
    } else if let Some(wake) = wake {
        execution_runtime::suspend_task_execution(state, task, contract, wake, presentation)
    } else {
        execution_runtime::fail_task_execution(
            state,
            task,
            local_first_execution_protocol::ExecutionFailure::transient(
                "proactive_prompt_incomplete",
                incomplete_reason
                    .as_deref()
                    .unwrap_or("scheduled task stopped before completing"),
            ),
            presentation,
        )
    }
}
