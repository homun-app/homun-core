//! Chat plan resume owner.
//!
//! Owns the pre-loop orchestration that seeds a chat turn from the canonical
//! runtime plan and applies the cross-turn stall guard. The runtime plan shape
//! remains in `gateway_runtime_plan_state`, and the stall budget remains in
//! `gateway_plan_stall`; this module only composes those owners for a chat turn.

use super::*;

pub(crate) struct ChatPlanResumeInput<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) thread_id: Option<&'a str>,
    pub(crate) effective_context: &'a [ChatContextMessage],
    pub(crate) applies_new_input: bool,
}

pub(crate) struct ChatPlanResume {
    pub(crate) plan: Vec<serde_json::Value>,
    pub(crate) goal: Option<String>,
}

pub(crate) fn prepare_chat_plan_resume(input: ChatPlanResumeInput<'_>) -> ChatPlanResume {
    let (mut plan, goal) =
        load_resumable_plan(input.state, input.thread_id, input.effective_context);
    apply_plan_stall_guard(
        input.state,
        input.thread_id,
        input.applies_new_input,
        &mut plan,
        goal.as_deref(),
    );
    ChatPlanResume { plan, goal }
}

fn load_resumable_plan(
    state: &AppState,
    thread_id: Option<&str>,
    effective_context: &[ChatContextMessage],
) -> (Vec<serde_json::Value>, Option<String>) {
    let from_store = runtime_plan_record_from_state(state, thread_id);
    if let Some((goal, steps)) = from_store
        && !steps.is_empty()
    {
        return (steps, goal);
    }

    let steps = effective_context
        .iter()
        .rev()
        .find(|message| message.text.contains("‹‹PLAN››"))
        .map(|message| parse_plan_marker(&message.text))
        .unwrap_or_default();
    (steps, None)
}

fn apply_plan_stall_guard(
    state: &AppState,
    thread_id: Option<&str>,
    applies_new_input: bool,
    plan: &mut [serde_json::Value],
    goal: Option<&str>,
) {
    if !applies_new_input || plan.is_empty() || !plan_stall_abort_enabled() {
        return;
    }
    let stalled = runtime_plan_control_scope(state, thread_id).is_some_and(
        |(user_id, workspace_id, thread_id)| {
            plan_stall_check_and_bump(
                state.task_store.as_ref(),
                &user_id,
                &workspace_id,
                &thread_id,
                plan,
            )
        },
    );
    if stalled && let Some(title) = block_stalled_step(plan) {
        upsert_runtime_plan_memory_from_state(state, thread_id, goal, plan);
        if verbose_debug() {
            eprintln!(
                "[plan] F4: blocked stalled step after {MAX_PLAN_STALL_RESUMES} no-progress resumes: «{title}»"
            );
        }
    }
}
