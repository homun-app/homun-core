//! Prompt instruction snippet ownership.
//!
//! These strings are part of the runtime prompt contract. Keeping them outside
//! the gateway root makes browser-research and HITL-resume wording testable
//! without growing `main.rs`.

pub(crate) fn browser_open_research_discovery_instruction() -> &'static str {
    "For open-ended current news or broad web research where the user did NOT name \
a specific site/URL, start with search/discovery (for example a search results or \
news discovery page), scan multiple recent candidates, then choose the best sources. \
match the user's language and the browser locale when choosing discovery pages; when \
using a search/news URL, include locale parameters such as hl=it and gl=IT when \
appropriate instead of defaulting to an unrelated market. \
Do not jump directly to one outlet unless the user explicitly named it."
}

pub(crate) fn booking_assumption_choice_instruction() -> &'static str {
    "For bookings, purchases, or other real-world transactions, do NOT silently proceed \
with an assumed critical parameter (departure city/station, destination, date/time, quantity, \
budget, passenger count, etc.). If you have a likely default from context, STOP and emit a \
CHOICES marker with one option that confirms the default and one option for free-text correction \
(for example: Confirm Milan departure / Choose another departure). Continue only after the user \
chooses or writes the missing value."
}

pub(crate) fn operational_plan_instruction() -> &'static str {
    "OPERATIONAL PLAN: for a non-trivial MULTI-STEP task, call update_plan and then continue executing \
in the SAME turn. The plan is a live projection of the canonical objective, not a separate artifact \
and not an approval gate. Replace or revise it autonomously when the new steps are only a better way \
to reach the SAME objective. Ask the user before continuing only when the validated semantic decision \
says the request changes the objective, expands its scope, or introduces new effects. Use update_plan \
to create or revise the operational plan; do not write a free-form numbered plan in prose. \
Use update_plan to update the step status (doing→done), shown in the \
\"Plan\" panel. To move a step's status (e.g. doing→done) call step_advance with its id (shown in \
parentheses after the title in the plan card) and the new status — this updates that ONE step \
WITHOUT re-sending the plan, so steps never duplicate; use update_plan only to CREATE or revise \
the plan. GOAL: when CREATING the plan you MUST set the top-level `goal` field to the user's \
objective in ONE sentence, written in the USER'S language (use null when you are only updating \
step statuses of an existing plan). The plan is ALREADY shown to the user as a CARD: do NOT \
repeat it in the reply text too — no list or table of the steps in prose (at most one \
line of context). For single-step requests no plan is needed. \
STEP-AT-A-TIME EXECUTION: work the plan ONE step at a time — do, then VERIFY that step's \
result (file written, search returned usable results, build/render succeeded), and only \
THEN mark it `done` with update_plan before starting the next. Give each step a \
`done_criterion` (the concrete, checkable proof it's finished): a step you mark done is \
INDEPENDENTLY verified against its evidence before it counts — if it isn't actually complete \
you'll be told and must keep working on it. Your working budget RESETS every time a step is \
verified complete, so a long task (e.g. a 10-slide deck, a deep research) can run as long as \
it KEEPS CLOSING STEPS — never rush or skip verification to save rounds, and never mark a \
step done before its result actually exists. RESUMING: if the conversation ALREADY shows an \
in-progress plan (some steps done, others not), CONTINUE it — re-emit the plan with update_plan \
keeping the completed steps as done, and proceed from the first not-done step; do NOT restart \
from scratch or re-propose."
}

/// Legacy prose backup; ResumeBinding + `choice_resume_harness_slot` own the contract.
#[cfg(test)]
pub(crate) fn choice_resume_instruction_legacy_backup() -> &'static str {
    "CHOICE RESUME (legacy backup): the user's latest message answers your prior CHOICES card. \
Continue the unfinished task from the warm browser session and open plan — do NOT restart \
discovery/search from scratch."
}

#[cfg(test)]
mod tests {
    use super::{
        booking_assumption_choice_instruction, browser_open_research_discovery_instruction,
        choice_resume_instruction_legacy_backup, operational_plan_instruction,
    };

    #[test]
    fn gateway_prompt_instructions_guide_open_ended_news_through_discovery_first() {
        let guidance = browser_open_research_discovery_instruction();
        assert!(guidance.contains("open-ended current news"));
        assert!(guidance.contains("start with search/discovery"));
        assert!(guidance.contains("match the user's language"));
        assert!(guidance.contains("browser locale"));
        assert!(guidance.contains("hl="));
        assert!(guidance.contains("gl="));
        assert!(guidance.contains("Do not jump directly to one outlet"));
    }

    #[test]
    fn gateway_prompt_instructions_require_booking_choice_card_before_proceeding() {
        let guidance = booking_assumption_choice_instruction();
        assert!(guidance.contains("do NOT silently proceed"));
        assert!(guidance.contains("assumed critical parameter"));
        assert!(guidance.contains("CHOICES marker"));
        assert!(guidance.contains("Continue only after the user"));
    }

    #[test]
    fn gateway_prompt_instructions_own_operational_plan_contract() {
        let guidance = operational_plan_instruction();
        assert!(guidance.contains("OPERATIONAL PLAN"));
        assert!(guidance.contains("call update_plan"));
        assert!(guidance.contains("step_advance"));
        assert!(guidance.contains("top-level `goal`"));
        assert!(guidance.contains("STEP-AT-A-TIME EXECUTION"));
        assert!(guidance.contains("RESUMING"));
    }

    #[test]
    fn gateway_prompt_instructions_keep_choice_resume_legacy_backup_out_of_sot() {
        let guidance = choice_resume_instruction_legacy_backup();
        assert!(guidance.contains("legacy backup"));
        assert!(guidance.contains("do NOT restart"));
    }
}
