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
    pub(crate) canonical_broker_turn: bool,
    pub(crate) thread_id: Option<String>,
    pub(crate) fence_turn_id: String,
    pub(crate) fence_user_id: UserId,
    pub(crate) fence_workspace_id: WorkspaceId,
    pub(crate) applies_new_input: bool,
    pub(crate) read_only: bool,
    pub(crate) user_message: String,
    pub(crate) previous_assistant: Option<String>,
    pub(crate) tail_turn_id: String,
    pub(crate) resume_id: String,
    pub(crate) turn_trace: &'a local_first_engine::turn_trace::TurnTrace,
}

pub(crate) async fn complete_agent_turn_tail(input: AgentTurnTailInput<'_>) {
    let AgentTurnTailInput {
        state,
        tx,
        outcome,
        canonical_broker_turn,
        thread_id,
        fence_turn_id,
        fence_user_id,
        fence_workspace_id,
        applies_new_input,
        read_only,
        user_message,
        previous_assistant,
        tail_turn_id,
        resume_id,
        turn_trace,
    } = input;

    if !canonical_broker_turn
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

    if applies_new_input && !outcome.memory_answer.trim().is_empty() && !read_only {
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

    if !read_only
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
