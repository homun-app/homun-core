//! Cross-turn runtime-plan stall budget.
//!
//! This owner keeps the resume-across-turns budget out of the gateway monolith:
//! per-turn loop counters reset every turn, while a resumed plan must remember
//! whether its current runnable step has failed to advance across resumes.

use local_first_engine::plan::{plan_done_count, plan_step_status, plan_step_title};
use local_first_task_runtime::TaskStore;
use std::sync::Mutex;

/// Max consecutive resumes of a plan with no new completed step before the harness blocks the
/// stuck step. Generous on purpose: a plan legitimately advancing even one step per turn never
/// trips (any `done`-count increase resets the counter); only genuine no-progress loops do.
pub(crate) const MAX_PLAN_STALL_RESUMES: u32 = 3;

/// New stall count from the prior count and the done-counts at the previous vs the current
/// resume. ANY progress (more done steps than last resume) resets to 0; otherwise +1. Pure.
#[cfg(test)]
pub(crate) fn next_plan_stall(
    prior_stall: u32,
    last_resume_done: usize,
    current_done: usize,
) -> u32 {
    if current_done > last_resume_done {
        0
    } else {
        prior_stall.saturating_add(1)
    }
}

pub(crate) fn plan_stall_exhausted(stall: u32) -> bool {
    stall >= MAX_PLAN_STALL_RESUMES
}

/// Block the first runnable (`todo`/`doing`) step: the F4 abort action once a plan has
/// stalled across resumes. Records WHY in the step's `detail` (surfaced in the Plan panel).
/// Returns the blocked step's title, or None if nothing was runnable. Pure (mutates `plan`).
pub(crate) fn block_stalled_step(plan: &mut [serde_json::Value]) -> Option<String> {
    for step in plan.iter_mut() {
        if matches!(plan_step_status(step), "todo" | "doing") {
            let title = plan_step_title(step).to_string();
            step["status"] = serde_json::json!("blocked");
            step["detail"] = serde_json::json!(format!(
                "paused by the harness: no progress after {MAX_PLAN_STALL_RESUMES} resumed turns"
            ));
            return Some(title).filter(|t| !t.is_empty());
        }
    }
    None
}

/// F4 turn-start: update cross-turn stall bookkeeping on the resumed plan and
/// report whether it has stalled past the cap. A store miss fails open: never
/// wedge a turn over bookkeeping.
pub(crate) fn plan_stall_check_and_bump(
    task_store: &Mutex<TaskStore>,
    user_id: &str,
    workspace_id: &str,
    thread_id: &str,
    resume_plan: &[serde_json::Value],
) -> bool {
    let current_done = plan_done_count(resume_plan);
    task_store
        .lock()
        .ok()
        .and_then(|store| {
            store
                .bump_runtime_plan_stall(user_id, workspace_id, thread_id, current_done)
                .ok()
                .flatten()
        })
        .is_some_and(|plan| plan_stall_exhausted(plan.stall_turns))
}
