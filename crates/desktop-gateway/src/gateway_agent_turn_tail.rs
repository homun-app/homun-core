//! Post-loop tail for a chat agent turn.
//!
//! Owns the work that must happen after the engine returns a `TurnOutcome`:
//! legacy HITL projection, turn-trace end record, memory learning, project graph
//! refresh, steering cleanup, outcome publication, and stream registry cleanup.
//! It does not own stream setup, the agent loop, browser execution, or subagents.

use super::*;

pub(crate) struct AgentTurnTailInput<'a> {
    pub(crate) state: AppState,
    pub(crate) tx: &'a StreamSink,
    pub(crate) outcome: local_first_engine::TurnOutcome,
    pub(crate) execution_identity: &'a AgentTurnExecutionIdentity,
    pub(crate) thread_id: Option<String>,
    pub(crate) fence_turn_id: String,
    pub(crate) fence_user_id: UserId,
    pub(crate) fence_workspace_id: WorkspaceId,
    pub(crate) applies_new_input: bool,
    pub(crate) turn_policy: &'a ChatTurnPolicy,
    pub(crate) user_message: String,
    pub(crate) previous_assistant: Option<String>,
    pub(crate) tail_turn_id: String,
    pub(crate) resume_id: String,
    pub(crate) turn_trace: &'a local_first_engine::turn_trace::TurnTrace,
}

pub(crate) struct AgentTurnTailContext {
    pub(crate) user_id: UserId,
    pub(crate) workspace_id: WorkspaceId,
    pub(crate) user_message: String,
    pub(crate) previous_assistant: Option<String>,
}

pub(crate) struct AgentTurnTailSnapshot {
    pub(crate) state: AppState,
    pub(crate) thread_id: Option<String>,
    pub(crate) fence_turn_id: String,
    pub(crate) fence_user_id: UserId,
    pub(crate) fence_workspace_id: WorkspaceId,
    pub(crate) user_message: String,
    pub(crate) previous_assistant: Option<String>,
    pub(crate) tail_turn_id: String,
}

pub(crate) struct AgentTurnTailSnapshotInput<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) thread_id: Option<&'a str>,
    pub(crate) request_id: &'a str,
    pub(crate) user_id: &'a UserId,
    pub(crate) workspace_id: &'a WorkspaceId,
    pub(crate) user_message: &'a str,
    pub(crate) previous_assistant: Option<&'a str>,
}

pub(crate) fn prepare_agent_turn_tail_context(
    state: &AppState,
    thread_id: Option<&str>,
    prompt: &str,
    effective_context: &[ChatContextMessage],
    applies_new_input: bool,
) -> AgentTurnTailContext {
    AgentTurnTailContext {
        user_id: gateway_user_id(),
        workspace_id: tail_workspace_id_for_thread(state, thread_id),
        user_message: if applies_new_input {
            prompt.to_string()
        } else {
            String::new()
        },
        previous_assistant: previous_assistant_message(effective_context),
    }
}

pub(crate) fn snapshot_agent_turn_tail(
    input: AgentTurnTailSnapshotInput<'_>,
) -> AgentTurnTailSnapshot {
    AgentTurnTailSnapshot {
        state: input.state.clone(),
        thread_id: input.thread_id.map(str::to_string),
        fence_turn_id: input.request_id.to_string(),
        fence_user_id: input.user_id.clone(),
        fence_workspace_id: input.workspace_id.clone(),
        user_message: input.user_message.to_string(),
        previous_assistant: input.previous_assistant.map(str::to_string),
        tail_turn_id: input.request_id.to_string(),
    }
}

pub(crate) async fn complete_agent_turn_tail(input: AgentTurnTailInput<'_>) {
    let AgentTurnTailInput {
        state,
        tx,
        outcome,
        execution_identity,
        thread_id,
        fence_turn_id,
        fence_user_id,
        fence_workspace_id,
        applies_new_input,
        turn_policy,
        user_message,
        previous_assistant,
        tail_turn_id,
        resume_id,
        turn_trace,
    } = input;

    if !execution_identity.canonical_broker_turn
        && let (Some(thread_id), Some(assistant_message_id)) = (
            thread_id.as_deref(),
            tx.entry
                .assistant_message_id
                .lock()
                .ok()
                .and_then(|id| id.clone()),
        )
        && let Err(error) =
            persist_hitl_wait_from_outcome(&state, thread_id, &assistant_message_id, &outcome)
    {
        eprintln!("[hitl] legacy turn projection failed: {error}");
    }

    record_agent_turn_end_trace(turn_trace, &outcome);

    if applies_new_input && !outcome.memory_answer.trim().is_empty() && !turn_policy.read_only {
        let learn_state = state.clone();
        let learn_answer = outcome.memory_answer.clone();
        let learn_thread = thread_id.clone();
        let learn_actions = outcome.tool_actions.clone();
        let learn_envelope = memory_reuse_envelope_from_read_set(&outcome.memory_reads);
        tokio::spawn(async move {
            learn_via_service_or_inline(
                &learn_state,
                &user_message,
                &learn_answer,
                &learn_actions,
                learn_thread.as_deref(),
                Some(&tail_turn_id),
                None,
                previous_assistant.as_deref(),
                learn_envelope,
            )
            .await;
        });
    }

    if !turn_policy.read_only
        && let Some(workspace) = thread_id
            .as_deref()
            .and_then(|tid| {
                lock_store(&state)
                    .ok()
                    .and_then(|store| store.workspace_for_thread(tid).ok())
            })
            .filter(|workspace| !workspace.trim().is_empty())
    {
        spawn_project_graph_refresh(&state, &workspace);
    }

    finalize_turn_steering(
        &state,
        thread_id.as_deref(),
        &fence_turn_id,
        &fence_user_id,
        &fence_workspace_id,
    );
    publish_stream_outcome(&tx.entry, outcome);
    tx.entry
        .finished
        .store(true, std::sync::atomic::Ordering::Relaxed);
    schedule_stream_registry_cleanup(resume_id);
}

fn tail_workspace_id_for_thread(state: &AppState, thread_id: Option<&str>) -> WorkspaceId {
    thread_id
        .and_then(|thread_id| {
            lock_store(state)
                .ok()
                .and_then(|store| store.workspace_for_thread(thread_id).ok())
        })
        .map(WorkspaceId::new)
        .unwrap_or_else(gateway_workspace_id)
}

fn previous_assistant_message(effective_context: &[ChatContextMessage]) -> Option<String> {
    effective_context
        .iter()
        .rev()
        .find(|message| matches!(message.role, ChatContextRole::Assistant))
        .map(|message| message.text.clone())
}

fn record_agent_turn_end_trace(
    turn_trace: &local_first_engine::turn_trace::TurnTrace,
    outcome: &local_first_engine::TurnOutcome,
) {
    let final_steps = plan_value_steps(&outcome.final_plan);
    let plan_final: Vec<String> = final_steps
        .iter()
        .map(|step| plan_step_status(step).to_string())
        .collect();
    let plan_titles: Vec<String> = final_steps
        .iter()
        .map(|step| plan_step_title(step).to_string())
        .collect();
    let artifact_count = outcome.memory_answer.matches("‹‹ARTIFACT››").count();
    let signals =
        local_first_engine::turn_trace::answer_signals(&outcome.memory_answer, artifact_count);
    let derived = local_first_engine::turn_trace::derive_flags(&plan_final, &plan_titles, &signals);
    turn_trace.record(local_first_engine::turn_trace::TurnEvent::TurnEnd {
        final_len: outcome.memory_answer.chars().count(),
        plan_final,
        signals,
        derived,
    });
}

#[cfg(test)]
mod tests {
    use super::previous_assistant_message;
    use local_first_desktop_gateway::{ChatContextMessage, ChatContextRole};

    #[test]
    fn previous_assistant_message_uses_latest_assistant_turn() {
        let context = vec![
            ChatContextMessage {
                role: ChatContextRole::Assistant,
                text: "old answer".to_string(),
            },
            ChatContextMessage {
                role: ChatContextRole::User,
                text: "follow up".to_string(),
            },
            ChatContextMessage {
                role: ChatContextRole::Assistant,
                text: "latest answer".to_string(),
            },
        ];

        assert_eq!(
            previous_assistant_message(&context).as_deref(),
            Some("latest answer")
        );
    }
}
