//! The `browse(goal) → BrowseResult` contract (ADR 0025, browse-as-recursion).
//!
//! The browser is a DELEGATED sub-agent, not a mid-turn hijack: the manager (the one guarded loop)
//! stays the driver and calls `browse` as one encapsulated capability. Internally `browse` is the same
//! [`crate::agent_loop::run_turn`], invoked recursively with a browser-only toolset, the browser model,
//! and an ISOLATED `LoopState` — so the sub-agent's snapshots/clicks/reasoning never pollute the
//! manager's context. Only this `BrowseResult` returns to the manager, which verifies it and advances
//! its plan. This is the payoff of the ADR 0024 extraction (the loop is now a recursively-callable
//! engine).

use serde::{Deserialize, Serialize};

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
}
