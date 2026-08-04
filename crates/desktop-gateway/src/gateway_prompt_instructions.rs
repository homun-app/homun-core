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
        choice_resume_instruction_legacy_backup,
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
    fn gateway_prompt_instructions_keep_choice_resume_legacy_backup_out_of_sot() {
        let guidance = choice_resume_instruction_legacy_backup();
        assert!(guidance.contains("legacy backup"));
        assert!(guidance.contains("do NOT restart"));
    }
}
