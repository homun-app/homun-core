//! Plan directive by chat mode (finding 1.2 / C).
//!
//! WHY this exists: the chat toggle has an explicit `agent | plan | ask | debug` mode. "Agent" is
//! the ACT mode; "Plan" is the one that "waits for OK before acting". The old prompt appended an
//! UNCONDITIONAL "for a MULTI-STEP task FIRST propose the plan and STOP" block, so agent behaved like
//! plan and a weak model (gemma4:12b, finding 1.2) obeyed it and STALLED. Rather than make the weak
//! model reason about a conditional in the prompt (the falsified nudge path), the HARNESS picks the
//! directive by mode here (caposaldo #2/#6): agent/debug get an operational block that EXECUTES;
//! plan gets propose-and-STOP; ask gets nothing (it has no tools). See spec 2026-07-03.

/// Shared operational guidance: how to run a plan with `update_plan`/`step_advance`, one step at a
/// time, verified, resumable. Used by BOTH agent and plan (plan uses it for post-approval execution).
const OPERATIONAL_BODY: &str = "Use update_plan to CREATE or revise the plan (give it an `objective`/goal and steps); use step_advance to move ONE step's status (doing→done) by its id WITHOUT re-sending the plan, so steps never duplicate. The plan is shown to the user as a CARD — do NOT repeat it in prose (at most one line of context). For single-step requests no plan is needed. STEP-AT-A-TIME: work ONE step at a time — do, then VERIFY that step's result (file written, search returned usable results, build/render succeeded), and only THEN mark it `done`. Give each step a `done_criterion` (the concrete, checkable proof it's finished): a step you mark done is INDEPENDENTLY verified against its evidence before it counts — if it isn't actually complete you'll be told and must keep working on it. Your working budget RESETS every time a step is verified complete, so a long task (e.g. a 10-slide deck, a deep research) can run as long as it KEEPS CLOSING steps — never rush or skip verification to save rounds, and never mark a step done before its result actually exists. RESUMING: if the conversation ALREADY shows an in-progress plan (some steps done, others not), CONTINUE it — re-emit the plan with update_plan keeping the completed steps as done, and proceed from the first not-done step; do NOT restart from scratch or re-propose.";

/// Agent/debug opener: EXECUTE operationally, no stop-to-propose. The only stop is a user-EXPLICIT
/// request to see/approve a plan first (user-triggered, not model-guessed).
const AGENT_OPENER: &str = "PLAN: for a non-trivial MULTI-STEP task (development, refactor, involved research, actions with effects), CREATE an operational plan with update_plan (set its `objective`) and EXECUTE it in THIS turn, one step at a time — do NOT stop to ask approval of the plan itself; just start working. Irreversible or risky ACTIONS are gated separately by the approval system, not by proposing a plan. ONLY if the user EXPLICITLY asks to see, approve, create, or test a plan FIRST: emit on its own line `‹‹PLAN_PROPOSE››{\"summary\":\"objective in brief\",\"steps\":[\"step 1\",\"step 2\"]}‹‹/PLAN_PROPOSE››` (valid JSON) and STOP, executing after approval.";

/// Plan-mode opener: propose-and-STOP for ANY non-trivial request (the user chose to gate execution).
const PLAN_OPENER: &str = "PLAN MODE (chosen by the user): for ANY non-trivial request FIRST propose a plan — emit on its own line `‹‹PLAN_PROPOSE››{\"summary\":\"objective in brief\",\"steps\":[\"step 1\",\"step 2\"]}‹‹/PLAN_PROPOSE››` (valid JSON) — and STOP. The user will see Accept/Edit; EXECUTE the plan ONLY in the NEXT turn after approval; if they ask for changes, revise and re-propose.";

/// The plan directive for a chat mode. Empty for `ask` (no tools/plan). Pure and total.
pub fn plan_directive_for_mode(mode: &str) -> String {
    match mode {
        "ask" => String::new(),
        "plan" => format!("{PLAN_OPENER}\n{OPERATIONAL_BODY}"),
        // agent | debug | anything else (default is "agent")
        _ => format!("{AGENT_OPENER}\n{OPERATIONAL_BODY}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_executes_and_never_forces_propose_and_stop() {
        let d = plan_directive_for_mode("agent");
        assert!(d.contains("EXECUTE it in THIS turn"));
        assert!(d.contains("update_plan"));
        // The removed miscalibration must not come back in agent mode.
        assert!(!d.contains("FIRST propose the plan and STOP"));
        // Propose is only the user-explicit exception here.
        assert!(d.contains("ONLY if the user EXPLICITLY asks"));
    }

    #[test]
    fn debug_uses_the_same_operational_directive_as_agent() {
        assert_eq!(plan_directive_for_mode("debug"), plan_directive_for_mode("agent"));
    }

    #[test]
    fn plan_mode_proposes_and_stops() {
        let d = plan_directive_for_mode("plan");
        assert!(d.contains("PLAN MODE"));
        assert!(d.contains("FIRST propose a plan"));
        assert!(d.contains("and STOP"));
    }

    #[test]
    fn ask_has_no_plan_directive() {
        assert_eq!(plan_directive_for_mode("ask"), "");
    }

    #[test]
    fn agent_and_plan_share_the_operational_body() {
        // Both must carry the how-to-run guidance (agent to execute, plan post-approval).
        for mode in ["agent", "plan", "debug"] {
            let d = plan_directive_for_mode(mode);
            assert!(d.contains("STEP-AT-A-TIME"), "{mode} missing operational body");
            assert!(d.contains("RESUMING:"), "{mode} missing resuming guidance");
        }
    }
}
