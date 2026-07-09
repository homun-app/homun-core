//! The `browse(goal) → BrowseResult` contract (ADR 0025, browse-as-recursion).
//!
//! The browser is a DELEGATED sub-agent, not a mid-turn hijack: the manager (the one guarded loop)
//! stays the driver and calls `browse` as one encapsulated capability. Internally `browse` is the same
//! [`crate::agent_loop::run_turn`], invoked recursively with a browser-only toolset, the browser model,
//! and an ISOLATED `LoopState` — so the sub-agent's snapshots/clicks/reasoning never pollute the
//! manager's context. Only this `BrowseResult` returns to the manager, which verifies it and advances
//! its plan. This is the payoff of the ADR 0024 extraction (the loop is now a recursively-callable
//! engine).

use crate::outcome::TurnOutcome;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The engine's canned "no answer" fallback (see `agent_loop`'s tail): when the sub-turn ends without
/// producing anything, `memory_answer` is this sentence. `browse` must read it as NOT-FOUND, not as a
/// real answer — so the manager retries/blocks instead of relaying a non-result. Matched by substring
/// (the full text carries a trailing hint) to stay robust to minor wording drift.
const NO_ANSWER_MARKER: &str = "couldn't produce a final answer";

/// The delimiter the loop prepends to the auto-generated "Fonti"/Sources block (`text::fonti_section`).
/// `browse` strips that block from `answer` because sources travel STRUCTURED in `BrowseResult.sources`
/// — the manager owns how (and whether) to present them; the raw `answer` stays a clean value.
const SOURCES_BLOCK_DELIM: &str = "\n\n**Sources**";

/// The sub-agent's self-assessment of the answer's trustworthiness. The MANAGER still verifies against
/// the step criterion — `confidence` is a hint, not a verdict.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    #[default]
    Low,
}

/// What a `browse(goal)` sub-turn returns to the manager (ADR 0025). The ONLY thing that crosses back
/// from the isolated sub-loop — the browser's raw activity stays encapsulated. Structured so the
/// manager can route deterministically: `found=false` / `status=Failed` → mark the step blocked or
/// answer "unavailable" WITHOUT thrashing; `found=true` → verify `answer`, then advance the plan.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BrowseResult {
    /// Was the information actually obtained?
    pub found: bool,
    /// The extracted value (or "" when `!found`).
    pub answer: String,
    /// URLs actually visited — feeds the manager's "Fonti"/sources section.
    pub sources: Vec<String>,
    /// The sub-agent's self-assessment (see [`Confidence`]).
    pub confidence: Confidence,
    /// Optional human note, e.g. "not available on Polymarket".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl BrowseResult {
    /// A NOT-FOUND result (impossible/exhausted goal): the manager marks the step blocked / answers
    /// "unavailable" instead of retrying forever.
    pub fn not_found(note: impl Into<String>) -> Self {
        Self { found: false, note: Some(note.into()), ..Default::default() }
    }
}

/// Seed the ISOLATED conversation for a `browse(goal)` sub-turn (ADR 0025). The sub-loop starts from a
/// clean 2-message context — the browser system prompt + the goal as the user turn — so NOTHING from the
/// manager's turn (its plan, prior tool history, reasoning) leaks in. This is the structural cure for the
/// browser-model context pollution: isolation by construction, seeded here and handed to `run_turn` as the
/// sub-`LoopState.messages`. The manager's `LoopState` is a separate value and stays untouched.
pub fn seed_browse_messages(system_prompt: &str, goal: &str) -> Vec<Value> {
    vec![
        json!({ "role": "system", "content": system_prompt }),
        json!({ "role": "user", "content": goal }),
    ]
}

/// Map a finished sub-turn ([`TurnOutcome`]) to the [`BrowseResult`] the manager sees (ADR 0025).
///
/// `found`/`confidence` are the sub-agent's cheap SELF-assessment, deliberately DERIVED from the answer's
/// shape rather than a forced structured self-report — forcing JSON on the weak browser model is the
/// anti-pattern this project rejected, and the MANAGER (strong model) does the authoritative verification
/// against the step criterion in a later slice. The heuristic: an answer is `found` when it is substantive
/// and is NOT the engine's canned no-answer fallback; `confidence` is `High` only when a real page was
/// actually visited (a source URL grounds the answer), else `Low`. The `**Sources**` block the loop may
/// append is stripped from `answer` — sources travel structured in `sources`.
pub fn browse_result_from_outcome(outcome: &TurnOutcome) -> BrowseResult {
    let raw = outcome.memory_answer.trim();
    let answer = raw
        .split(SOURCES_BLOCK_DELIM)
        .next()
        .unwrap_or(raw)
        .trim()
        .to_string();
    let is_no_answer = answer.to_lowercase().contains(NO_ANSWER_MARKER);
    let found = !answer.is_empty() && !is_no_answer;
    if !found {
        // Impossible/exhausted goal: carry the sub-agent's own words as the note (helps the manager
        // decide retry-vs-block) rather than discarding them.
        let note = (!answer.is_empty()).then(|| answer.clone());
        return BrowseResult { found: false, note, ..Default::default() };
    }
    let confidence = if outcome.browse_sources.is_empty() {
        Confidence::Low
    } else {
        Confidence::High
    };
    BrowseResult {
        found: true,
        answer,
        sources: outcome.browse_sources.clone(),
        confidence,
        note: None,
    }
}

/// Render a [`BrowseResult`] as the tool-result text the MANAGER reads (ADR 0025 slice 2). A compact
/// LABELED block (not raw JSON) so the strong manager model can verify the answer against the step
/// criterion and route deterministically — `found: false` → mark blocked / answer "unavailable" without
/// thrashing; `found: true` → verify `answer`, cite `sources`, advance. Readable beats JSON here: the
/// manager reasons over it, it never gets machine-parsed.
pub fn browse_result_for_manager(result: &BrowseResult) -> String {
    if !result.found {
        return match &result.note {
            Some(note) => format!("found: false\nnote: {note}"),
            None => "found: false".to_string(),
        };
    }
    let confidence = match result.confidence {
        Confidence::High => "high",
        Confidence::Low => "low",
    };
    let mut out = format!("found: true\nconfidence: {confidence}\nanswer: {}", result.answer);
    if !result.sources.is_empty() {
        out.push_str("\nsources:");
        for url in &result.sources {
            out.push_str(&format!("\n- {url}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browse_result_round_trips_with_lowercase_confidence() {
        let r = BrowseResult {
            found: true,
            answer: "42%".to_string(),
            sources: vec!["https://x".to_string()],
            confidence: Confidence::High,
            note: None,
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"confidence\":\"high\""), "got: {json}");
        assert!(!json.contains("\"note\""), "None note is skipped: {json}");
        let back: BrowseResult = serde_json::from_str(&json).unwrap();
        assert_eq!(back.answer, "42%");
        assert_eq!(back.confidence, Confidence::High);
    }

    #[test]
    fn not_found_carries_the_note_and_defaults_to_low() {
        let r = BrowseResult::not_found("not available on Polymarket");
        assert!(!r.found && r.answer.is_empty() && r.sources.is_empty());
        assert_eq!(r.confidence, Confidence::Low);
        assert_eq!(r.note.as_deref(), Some("not available on Polymarket"));
    }

    #[test]
    fn seed_produces_an_isolated_two_message_context() {
        let msgs = seed_browse_messages("You drive a browser.", "current BTC price on Kraken");
        assert_eq!(msgs.len(), 2, "exactly system + user — no manager history leaks in");
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "You drive a browser.");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "current BTC price on Kraken");
    }

    #[test]
    fn maps_substantive_grounded_answer_to_found_high_and_strips_sources_block() {
        let outcome = TurnOutcome {
            memory_answer: "The price is $63,120.\n\n**Sources**\n- https://kraken.com/btc".to_string(),
            tool_actions: String::new(),
            browse_sources: vec!["https://kraken.com/btc".to_string()],
            ..Default::default()
        };
        let r = browse_result_from_outcome(&outcome);
        assert!(r.found);
        assert_eq!(r.answer, "The price is $63,120.", "the Sources block is stripped from answer");
        assert_eq!(r.sources, vec!["https://kraken.com/btc".to_string()]);
        assert_eq!(r.confidence, Confidence::High, "a visited page grounds the answer");
        assert!(r.note.is_none());
    }

    #[test]
    fn substantive_answer_without_sources_is_found_but_low_confidence() {
        let outcome = TurnOutcome {
            memory_answer: "Roughly 42% according to the page.".to_string(),
            browse_sources: vec![],
            ..Default::default()
        };
        let r = browse_result_from_outcome(&outcome);
        assert!(r.found);
        assert_eq!(r.confidence, Confidence::Low, "no visited source → self-assessed low");
    }

    #[test]
    fn canned_no_answer_fallback_maps_to_not_found() {
        // The engine's tail returns this sentence when the sub-turn produced nothing — it must read as
        // NOT-FOUND so the manager retries/blocks instead of relaying a non-result.
        let outcome = TurnOutcome {
            memory_answer: "I completed the steps but couldn't produce a final answer. \
Tell me if you want me to retry or rephrase."
                .to_string(),
            ..Default::default()
        };
        let r = browse_result_from_outcome(&outcome);
        assert!(!r.found, "the canned fallback is not a real answer");
        assert!(r.answer.is_empty());
    }

    #[test]
    fn empty_answer_maps_to_not_found_with_no_note() {
        let r = browse_result_from_outcome(&TurnOutcome::default());
        assert!(!r.found && r.answer.is_empty() && r.note.is_none());
    }

    #[test]
    fn manager_view_labels_a_found_result_with_sources() {
        let r = BrowseResult {
            found: true,
            answer: "$63,120".to_string(),
            sources: vec!["https://kraken.com/btc".to_string()],
            confidence: Confidence::High,
            note: None,
        };
        let text = browse_result_for_manager(&r);
        assert_eq!(
            text,
            "found: true\nconfidence: high\nanswer: $63,120\nsources:\n- https://kraken.com/btc"
        );
    }

    #[test]
    fn manager_view_of_not_found_carries_note_and_no_answer() {
        let text = browse_result_for_manager(&BrowseResult::not_found("not available on Polymarket"));
        assert_eq!(text, "found: false\nnote: not available on Polymarket");
        assert!(!text.contains("answer:"), "a not-found result exposes no answer to the manager");
    }
}
