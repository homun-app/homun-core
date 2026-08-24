//! Agent turn plan seed owner.
//!
//! Owns the pre-loop application of the already resolved resumed plan to the
//! engine `LoopState`, plus the initial progress counters consumed by the
//! canonical agent loop. It does not own plan resume, plan stall policy,
//! runtime-plan shape, browser execution or subagents.

use super::*;

pub(crate) struct AgentTurnPlanSeed {
    pub(crate) final_done: bool,
    pub(crate) plan_nudges: u32,
    pub(crate) turn_used_tools: bool,
}

pub(crate) fn seed_agent_turn_plan_state(
    loop_state: &mut local_first_engine::LoopState,
    chat_plan_resume: &ChatPlanResume,
    verbose: bool,
) -> AgentTurnPlanSeed {
    loop_state.plan =
        canonical_plan_value(chat_plan_resume.goal.as_deref(), &chat_plan_resume.plan);
    if verbose {
        let done = chat_plan_resume
            .plan
            .iter()
            .filter(|s| s.get("status").and_then(|v| v.as_str()) == Some("done"))
            .count();
        eprintln!(
            "[plan] turn-start: resumed {} steps ({done} done) from prior ‹‹PLAN›› marker",
            chat_plan_resume.plan.len()
        );
    }

    loop_state.step_messages_start = loop_state.messages.len();
    AgentTurnPlanSeed {
        final_done: false,
        plan_nudges: 0,
        turn_used_tools: false,
    }
}
