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

pub(crate) fn memory_recall_usage_instruction() -> &'static str {
    "MEMORY: you have a long-term memory of the user. If you need a personal \
or project detail you may have already learned (a name, a preference, a fact, a \
past decision and its why), OR if the user asks what was discussed or decided in \
PREVIOUS conversations, and the information is NOT already in the profile above, ALWAYS call the \
recall_memory tool BEFORE saying you don't know or don't remember. \
RECALL-BEFORE-ASKING: when the user refers to a POSSESSION, a PERSON or a \
CONTEXT they take as already known (typically with a possessive: «my motorbike», «my boss», «my \
house», «my brother», «my management software»…) and to act you need a detail about it that is NOT \
already in the profile above, do NOT instinctively ask the user: call recall_memory FIRST and USE what \
you find; then ask ONLY for the details that are truly still missing after the recall. \
E.g.: «find me a fuel cap for my motorbike» → recall_memory(«user's motorbike, make \
model year») → if you find «Moto Guzzi V7 Stone 850 2021» proceed with that and ask for the year only if \
it's not in memory. This concerns DURABLE facts plausibly already learned, not \
ephemeral information or things that just came up in the conversation. \
DECISIONS: BEFORE modifying a project's code/documents, call recall_memory to remember \
why things are the way they are (do NOT re-scan everything from scratch). AFTER a non-trivial choice — in \
ANY domain: code, a document (e.g. a customer quote), data, configurations — call \
record_decision with what you decided, the WHY, the rejected alternatives and the objects touched, so \
the rationale stays and doesn't have to be reconstructed. \
SENSITIVE VAULT: sensitive values are NOT in ordinary memory. If the user asks for a sensitive personal \
value (identity document, fiscal/tax code, vehicle plate, health note, credentials, payment data, private \
note), call recall_memory before saying you don't know it: if normal memory has no match, the gateway \
checks Vault metadata internally and returns only redacted metadata. Never reveal, infer, or guess the \
secret value from metadata. If a matching record exists, say it is saved in the Vault and local PIN unlock \
is required to reveal or edit it. If recall_memory returns a `reveal_card:` line, COPY the marker after \
`reveal_card:` EXACTLY into your final answer on its own line; do not paraphrase it. The UI hides that \
marker and renders the PIN unlock card. Do NOT send or forward raw Vault secret values through \
generic external channels/tools such as send_message. The configured Telegram authorization channel may \
receive Vault/payment summaries or approval prompts, but raw-value reveal stays behind the local PIN \
unlock card unless a dedicated approved reveal flow exists."
}

pub(crate) fn memory_scope_restricted_instruction() -> &'static str {
    "MEMORY SCOPE FOR THIS OBJECTIVE: long-term recall and Vault lookup are not authorized. Use only current-thread context and current-turn tool evidence; do not call recall_memory."
}

pub(crate) fn plan_mode_instruction() -> &'static str {
    "PLAN MODE (chosen by the user): maintain the canonical operational plan with \
update_plan and continue execution in this turn. Replan autonomously while the objective, scope and effects stay unchanged."
}

pub(crate) fn ask_mode_instruction() -> &'static str {
    "ASK MODE (chosen by the user): answer by conversing from your \
knowledge and memory. Do NOT use tools and do NOT perform external actions (no browser, files, \
sends, searches). If answering would require a tool, say so and suggest switching to \
Agent mode."
}

pub(crate) fn debug_mode_instruction() -> &'static str {
    "DEBUG MODE (chosen by the user): SYSTEMATIC debugging — reproduce the \
problem, isolate the cause, form a hypothesis, verify it with a minimal experiment, then fix and \
RE-VERIFY by executing. One cause at a time, no blind attempts."
}

pub(crate) fn language_follow_user_instruction() -> &'static str {
    "LANGUAGE: ALWAYS write in the SAME language as the user's latest \
message — both your step-by-step narration AND the final answer. If the user writes in \
Italian, reply entirely in Italian; if in English, in English. Match the user and never \
switch language on your own. (Tool arguments, code, file paths and URLs stay as-is.)"
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
        ask_mode_instruction, booking_assumption_choice_instruction,
        browser_open_research_discovery_instruction, choice_resume_instruction_legacy_backup,
        debug_mode_instruction, language_follow_user_instruction, memory_recall_usage_instruction,
        memory_scope_restricted_instruction, operational_plan_instruction, plan_mode_instruction,
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
    fn gateway_prompt_instructions_own_memory_recall_usage_contract() {
        let guidance = memory_recall_usage_instruction();
        assert!(guidance.contains("MEMORY: you have a long-term memory"));
        assert!(guidance.contains("recall_memory tool BEFORE"));
        assert!(guidance.contains("RECALL-BEFORE-ASKING"));
        assert!(guidance.contains("DECISIONS: BEFORE modifying"));
        assert!(guidance.contains("SENSITIVE VAULT"));
        assert!(guidance.contains("reveal_card:"));
    }

    #[test]
    fn gateway_prompt_instructions_own_memory_restricted_scope_contract() {
        let guidance = memory_scope_restricted_instruction();
        assert!(guidance.contains("MEMORY SCOPE FOR THIS OBJECTIVE"));
        assert!(guidance.contains("long-term recall and Vault lookup are not authorized"));
        assert!(guidance.contains("current-thread context and current-turn tool evidence"));
        assert!(guidance.contains("do not call recall_memory"));
    }

    #[test]
    fn gateway_prompt_instructions_own_chat_mode_contracts() {
        let plan = plan_mode_instruction();
        assert!(plan.contains("PLAN MODE (chosen by the user)"));
        assert!(plan.contains("canonical operational plan"));
        assert!(plan.contains("update_plan"));

        let ask = ask_mode_instruction();
        assert!(ask.contains("ASK MODE (chosen by the user)"));
        assert!(ask.contains("Do NOT use tools"));
        assert!(ask.contains("Agent mode"));

        let debug = debug_mode_instruction();
        assert!(debug.contains("DEBUG MODE (chosen by the user)"));
        assert!(debug.contains("SYSTEMATIC debugging"));
        assert!(debug.contains("RE-VERIFY"));
    }

    #[test]
    fn gateway_prompt_instructions_own_language_contract() {
        let guidance = language_follow_user_instruction();
        assert!(guidance.contains("LANGUAGE: ALWAYS write"));
        assert!(guidance.contains("SAME language as the user's latest message"));
        assert!(guidance.contains("step-by-step narration"));
        assert!(guidance.contains("final answer"));
        assert!(guidance.contains("Tool arguments, code, file paths and URLs stay as-is"));
    }

    #[test]
    fn gateway_prompt_instructions_keep_choice_resume_legacy_backup_out_of_sot() {
        let guidance = choice_resume_instruction_legacy_backup();
        assert!(guidance.contains("legacy backup"));
        assert!(guidance.contains("do NOT restart"));
    }
}
