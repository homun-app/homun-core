//! The single guarded ReAct loop — motore #1 (ADR 0021), extracted into the engine (ADR 0024,
//! increment 5, Point 5 / 5.D1c.10).
//!
//! This is the canonical agent turn: a bounded round loop that calls the model, dispatches its tool
//! calls through the seams, tracks plan progress, and synthesizes a final answer. It is GENERIC over
//! its collaborators (the `contract` seams) so the engine stays decoupled from the gateway's concrete
//! `AppState`/transport — the gateway builds the impls and injects them.
//!
//! Landing note: this fn is a COPY of the gateway's inline `run_agent_rounds`, wired behind
//! `HOMUN_ENGINE_CRATE` (default OFF). While the flag is OFF the gateway runs its proven inline loop;
//! ON runs this one. The two are kept in parity via the `trace` oracle until 5.D2 flips the default and
//! deletes the inline copy — at which point this becomes the ONE loop (no flag, per "converge, don't
//! duplicate"). ADR 0025 (browse-as-recursion) then invokes this same loop recursively for the browser.

use crate::contract::{EventSink, PlanProgress};
use crate::events::GenerateStreamEvent;
use crate::plan::{
    advance_plan_frontier, build_plan_markdown, plan_step_status, plan_step_title, plan_value_steps,
};
use crate::{LoopState, TurnConfig};

/// Harness-driven plan progress from VERIFIED evidence. Called after each work tool result: if the
/// plan has a frontier `doing` step and enough new evidence has accrued, ask the F2 judge whether that
/// step is genuinely complete; if so, mark it done, advance the frontier, and emit the ‹‹PLAN›› card +
/// persist — the same canonical live+durable update the model's own `step_advance` produces. This is
/// the ONLY way progress rises during a browsing turn, where the driver is the weak browser model that
/// never calls `step_advance`. Verified-only, so thrashing on a hard-to-find market never fakes
/// progress. Stride-gated so the (cheap `memory`-role) judge runs at most once per few tool results.
///
/// Expressed over the seams (`PlanProgress` for verify/record/persist + the steps→Value bridge,
/// `EventSink` for the card, `TurnConfig` for the flags) — no `AppState`/transport/`ExecutionPlan`.
pub async fn try_advance_frontier_from_evidence(
    ls: &mut LoopState,
    plan_progress: &impl PlanProgress,
    event_sink: &impl EventSink,
    cfg: &TurnConfig,
    thread_id: Option<&str>,
    round: usize,
) {
    if !cfg.autoadvance_from_evidence || !cfg.step_verification {
        return;
    }
    // Evidence stride: only re-check after a few new tool outcomes since the last attempt.
    const EVIDENCE_STRIDE: usize = 3;
    if ls.step_evidence.len() < ls.progress_verify_anchor.saturating_add(EVIDENCE_STRIDE) {
        return;
    }
    ls.progress_verify_anchor = ls.step_evidence.len();
    let batch_evidence = ls.step_evidence.join("\n");
    if batch_evidence.is_empty() {
        return;
    }
    // Advance as many consecutive frontier steps as this evidence window confirms — bounded so a
    // single evidence window can never sweep the whole plan to done (that's the delivery reconcile's
    // job, not a mid-turn judge call).
    for _ in 0..2u8 {
        let plan_steps = plan_value_steps(&ls.plan);
        let Some(idx) = plan_steps
            .iter()
            .position(|s| plan_step_status(s) == "doing")
        else {
            return; // nothing in progress (plan complete or not started)
        };
        let title = plan_step_title(&plan_steps[idx]).to_string();
        let criterion = plan_steps[idx]
            .get("done_criterion")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let (ok, _reason) =
            plan_progress.verify_step_complete(&title, &criterion, &batch_evidence).await;
        if !ok {
            return; // frontier step not proven done yet → leave it doing
        }
        let mut plan_steps = plan_steps;
        advance_plan_frontier(&mut plan_steps);
        let verified_step = plan_steps[idx].clone();
        // record_step_outcome clones the evidence internally (its impl offloads to spawn_blocking),
        // so pass the current window by ref — the same evidence the old inline clone captured pre-clear.
        plan_progress
            .record_step_outcome(thread_id, &verified_step, &ls.step_evidence)
            .await;
        ls.plan = plan_progress.plan_value_from_steps(&plan_steps);
        ls.progress_anchor_round = round; // F1: real progress → reset the stall guard
        event_sink
            .emit(GenerateStreamEvent::Delta {
                text: format!(
                    "‹‹ACT››✓ Step verified: {}‹‹/ACT››",
                    title.chars().take(60).collect::<String>()
                ),
            })
            .await;
        // The canonical live plan card (→ plan_update event) + durable runtime plan, exactly like
        // the model's own step_advance path.
        let plan_mark = format!("‹‹PLAN››{}‹‹/PLAN››", build_plan_markdown(&plan_steps));
        event_sink.emit(GenerateStreamEvent::Delta { text: plan_mark }).await;
        plan_progress.persist_plan(thread_id, &plan_steps).await;
        // This evidence window was consumed by the advance — reset it + the stride anchor.
        ls.step_evidence.clear();
        ls.progress_verify_anchor = 0;
    }
}
