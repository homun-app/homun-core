//! The `browse(goal) → BrowseResult` contract (ADR 0025, browse-as-recursion).
//!
//! The browser is a DELEGATED sub-agent, not a mid-turn hijack: the manager (the one guarded loop)
//! stays the driver and calls `browse` as one encapsulated capability. Internally `browse` is the same
//! [`crate::agent_loop::run_turn`], invoked recursively with a browser-only toolset, the browser model,
//! and an ISOLATED `LoopState` — so the sub-agent's snapshots/clicks/reasoning never pollute the
//! manager's context. Only this `BrowseResult` returns to the manager, which verifies it and advances
//! its plan. This is the payoff of the ADR 0024 extraction (the loop is now a recursively-callable
//! engine).

use crate::outcome::{TurnDelivery, TurnOutcome};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// A legacy no-answer phrase is still mapped to NOT-FOUND if it reaches a browse result. New engine
/// turns use `TurnDelivery::NoVisibleAnswer` instead of manufacturing this prose.
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserDoneStatus {
    Completed,
    #[default]
    Partial,
    Blocked,
    Unavailable,
    Timeout,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowseResultKind {
    #[default]
    List,
    Fact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowseResultField {
    pub name: String,
    pub required: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowseResultContract {
    pub kind: BrowseResultKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum_items: Option<usize>,
    #[serde(default)]
    pub fields: Vec<BrowseResultField>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boundary: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BrowserDonePayload {
    pub status: BrowserDoneStatus,
    pub answer: String,
    #[serde(default)]
    pub items: Vec<Value>,
    #[serde(default)]
    pub fields_missing: Vec<String>,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<String>,
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
    #[serde(default)]
    pub status: BrowserDoneStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields_missing: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<String>,
}

impl BrowseResult {
    /// A NOT-FOUND result (impossible/exhausted goal): the manager marks the step blocked / answers
    /// "unavailable" instead of retrying forever.
    pub fn not_found(note: impl Into<String>) -> Self {
        Self {
            found: false,
            note: Some(note.into()),
            status: BrowserDoneStatus::Unavailable,
            ..Default::default()
        }
    }
}

pub fn validate_browser_done_payload(
    payload: BrowserDonePayload,
    contract: Option<&BrowseResultContract>,
) -> BrowseResult {
    let mut status = payload.status;
    let mut missing = payload.fields_missing.clone();
    if let Some(contract) = contract {
        if let Some(minimum_items) = contract.minimum_items
            && payload.items.len() < minimum_items
            && status == BrowserDoneStatus::Completed
        {
            status = BrowserDoneStatus::Partial;
            push_unique(&mut missing, "minimum_items");
        }
        for field in contract.fields.iter().filter(|field| field.required) {
            let has_field = payload.items.iter().any(|item| {
                item.get(&field.name)
                    .map(|value| {
                        !value.is_null()
                            && value
                                .as_str()
                                .map(|text| !text.trim().is_empty())
                                .unwrap_or(true)
                    })
                    .unwrap_or(false)
            });
            if !has_field && status == BrowserDoneStatus::Completed {
                status = BrowserDoneStatus::Partial;
                push_unique(&mut missing, &field.name);
            }
        }
    }
    let found = matches!(status, BrowserDoneStatus::Completed | BrowserDoneStatus::Partial)
        && (!payload.answer.trim().is_empty() || !payload.items.is_empty());
    BrowseResult {
        found,
        answer: payload.answer.trim().to_string(),
        sources: payload.sources,
        confidence: if found { Confidence::High } else { Confidence::Low },
        note: (!found).then(|| format!("{status:?}")),
        status,
        items: payload.items,
        fields_missing: missing,
        evidence: payload.evidence,
    }
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
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
    if outcome.delivery != TurnDelivery::Delivered {
        return BrowseResult::default();
    }
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
        return BrowseResult {
            found: false,
            note,
            status: BrowserDoneStatus::Unavailable,
            ..Default::default()
        };
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
        status: BrowserDoneStatus::Completed,
        ..Default::default()
    }
}

/// Preserve grounded page evidence when the browser sub-agent navigated and
/// captured a substantive accessibility snapshot but its final no-tools model
/// call failed to produce visible prose. The manager still performs the
/// semantic verification against the user's goal; this fallback only prevents
/// already-observed page text from being discarded as `found: false`.
pub fn browse_result_from_outcome_with_snapshot(
    outcome: &TurnOutcome,
    last_snapshot: &str,
) -> BrowseResult {
    let result = browse_result_from_outcome(outcome);
    if result.found {
        return result;
    }
    let snapshot = last_snapshot.trim();
    if outcome.browse_sources.is_empty() || snapshot.chars().count() < 200 {
        return result;
    }
    let snapshot = snapshot.chars().take(8_000).collect::<String>();
    BrowseResult {
        found: true,
        answer: format!(
            "The browser reached a grounded page but the browsing sub-agent did not finish its summary. Verify and extract the requested facts from this last page snapshot:\n{snapshot}"
        ),
        sources: outcome.browse_sources.clone(),
        confidence: Confidence::Low,
        note: None,
        status: BrowserDoneStatus::Partial,
        ..Default::default()
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
    let status = format!("{:?}", result.status).to_lowercase();
    let mut out = format!(
        "found: true\nconfidence: {confidence}\nstatus: {status}\nanswer: {}",
        result.answer
    );
    if !result.items.is_empty() {
        out.push_str("\nitems:");
        for item in &result.items {
            out.push_str(&format!("\n- {}", serde_json::to_string(item).unwrap_or_default()));
        }
    }
    if !result.fields_missing.is_empty() {
        out.push_str("\nfields_missing:");
        for field in &result.fields_missing {
            out.push_str(&format!("\n- {field}"));
        }
    }
    if !result.evidence.is_empty() {
        out.push_str("\nevidence:");
        for evidence in &result.evidence {
            out.push_str(&format!("\n- {evidence}"));
        }
    }
    if !result.sources.is_empty() {
        out.push_str("\nsources:");
        for url in &result.sources {
            out.push_str(&format!("\n- {url}"));
        }
    }
    out
}

pub fn browse_result_from_manager_text(text: &str) -> Option<BrowseResult> {
    let mut found: Option<bool> = None;
    let mut confidence = Confidence::Low;
    let mut status = BrowserDoneStatus::Partial;
    let mut answer = String::new();
    let mut note = None;
    let mut sources = Vec::new();
    let mut items = Vec::new();
    let mut fields_missing = Vec::new();
    let mut evidence = Vec::new();
    let mut section = "";
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("found: ") {
            found = Some(value.trim() == "true");
            section = "";
        } else if let Some(value) = line.strip_prefix("confidence: ") {
            confidence = if value.trim() == "high" {
                Confidence::High
            } else {
                Confidence::Low
            };
            section = "";
        } else if let Some(value) = line.strip_prefix("status: ") {
            status = match value.trim() {
                "completed" => BrowserDoneStatus::Completed,
                "blocked" => BrowserDoneStatus::Blocked,
                "unavailable" => BrowserDoneStatus::Unavailable,
                "timeout" => BrowserDoneStatus::Timeout,
                _ => BrowserDoneStatus::Partial,
            };
            section = "";
        } else if let Some(value) = line.strip_prefix("answer: ") {
            answer = value.trim().to_string();
            section = "";
        } else if let Some(value) = line.strip_prefix("note: ") {
            note = Some(value.trim().to_string());
            section = "";
        } else if line == "sources:" || line == "items:" || line == "fields_missing:" || line == "evidence:" {
            section = line.trim_end_matches(':');
        } else if let Some(value) = line.strip_prefix("- ") {
            match section {
                "sources" => sources.push(value.to_string()),
                "items" => {
                    if let Ok(item) = serde_json::from_str::<Value>(value) {
                        items.push(item);
                    }
                }
                "fields_missing" => fields_missing.push(value.to_string()),
                "evidence" => evidence.push(value.to_string()),
                _ => {}
            }
        }
    }
    Some(BrowseResult {
        found: found?,
        answer,
        sources,
        confidence,
        note,
        status,
        items,
        fields_missing,
        evidence,
    })
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
            ..Default::default()
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"confidence\":\"high\""), "got: {json}");
        assert!(!json.contains("\"note\""), "None note is skipped: {json}");
        let back: BrowseResult = serde_json::from_str(&json).unwrap();
        assert_eq!(back.answer, "42%");
        assert_eq!(back.confidence, Confidence::High);
    }

    #[test]
    fn browser_done_completed_is_downgraded_when_minimum_items_missing() {
        let contract = BrowseResultContract {
            kind: BrowseResultKind::List,
            minimum_items: Some(3),
            fields: vec![
                BrowseResultField { name: "departure".into(), required: true },
                BrowseResultField { name: "arrival".into(), required: true },
                BrowseResultField { name: "duration".into(), required: true },
                BrowseResultField { name: "price".into(), required: false },
            ],
            boundary: Some("Stop before booking or payment".into()),
        };
        let payload = BrowserDonePayload {
            status: BrowserDoneStatus::Completed,
            answer: "One visible option".into(),
            items: vec![serde_json::json!({
                "departure": "09:05",
                "arrival": "13:40",
                "duration": "4h 35m"
            })],
            fields_missing: vec![],
            sources: vec!["https://www.trenitalia.com/".into()],
            evidence: vec!["Visible result card with times".into()],
        };

        let result = validate_browser_done_payload(payload, Some(&contract));

        assert_eq!(result.status, BrowserDoneStatus::Partial);
        assert!(result.found);
        assert_eq!(result.items.len(), 1);
        assert!(result.fields_missing.contains(&"minimum_items".to_string()));
    }

    #[test]
    fn browser_done_completed_keeps_optional_missing_price() {
        let contract = BrowseResultContract {
            kind: BrowseResultKind::List,
            minimum_items: Some(1),
            fields: vec![
                BrowseResultField { name: "departure".into(), required: true },
                BrowseResultField { name: "arrival".into(), required: true },
                BrowseResultField { name: "duration".into(), required: true },
                BrowseResultField { name: "price".into(), required: false },
            ],
            boundary: Some("Stop before booking or payment".into()),
        };
        let payload = BrowserDonePayload {
            status: BrowserDoneStatus::Completed,
            answer: "One visible option".into(),
            items: vec![serde_json::json!({
                "departure": "09:05",
                "arrival": "13:40",
                "duration": "4h 35m",
                "price": null
            })],
            fields_missing: vec!["price".into()],
            sources: vec!["https://www.trenitalia.com/".into()],
            evidence: vec!["Price was not visible in the result card".into()],
        };

        let result = validate_browser_done_payload(payload, Some(&contract));

        assert_eq!(result.status, BrowserDoneStatus::Completed);
        assert!(result.fields_missing.contains(&"price".to_string()));
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
            delivery: TurnDelivery::Delivered,
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
            delivery: TurnDelivery::Delivered,
            memory_answer: "Roughly 42% according to the page.".to_string(),
            browse_sources: vec![],
            ..Default::default()
        };
        let r = browse_result_from_outcome(&outcome);
        assert!(r.found);
        assert_eq!(r.confidence, Confidence::Low, "no visited source → self-assessed low");
    }

    #[test]
    fn legacy_no_answer_text_maps_to_not_found() {
        // Historical data carrying this phrase remains a NOT-FOUND result.
        let outcome = TurnOutcome {
            delivery: TurnDelivery::Delivered,
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
    fn grounded_snapshot_survives_when_subagent_synthesis_has_no_answer() {
        let outcome = TurnOutcome {
            delivery: TurnDelivery::NoVisibleAnswer,
            browse_sources: vec!["https://official.example/report".to_string()],
            ..Default::default()
        };
        let snapshot = format!(
            "Official report\nURL: https://official.example/report\n{}",
            "Measured punctuality was 91.4 percent. ".repeat(8)
        );

        let result = browse_result_from_outcome_with_snapshot(&outcome, &snapshot);

        assert!(result.found);
        assert_eq!(result.confidence, Confidence::Low);
        assert_eq!(result.sources, outcome.browse_sources);
        assert!(result.answer.contains("91.4 percent"));
    }

    #[test]
    fn ungrounded_snapshot_does_not_become_a_browse_result() {
        let snapshot = "Navigation text ".repeat(30);
        let result = browse_result_from_outcome_with_snapshot(&TurnOutcome::default(), &snapshot);
        assert!(!result.found);
    }

    #[test]
    fn manager_view_labels_a_found_result_with_sources() {
        let r = BrowseResult {
            found: true,
            answer: "$63,120".to_string(),
            sources: vec!["https://kraken.com/btc".to_string()],
            confidence: Confidence::High,
            note: None,
            status: BrowserDoneStatus::Completed,
            ..Default::default()
        };
        let text = browse_result_for_manager(&r);
        assert_eq!(
            text,
            "found: true\nconfidence: high\nstatus: completed\nanswer: $63,120\nsources:\n- https://kraken.com/btc"
        );
    }

    #[test]
    fn manager_view_of_not_found_carries_note_and_no_answer() {
        let text = browse_result_for_manager(&BrowseResult::not_found("not available on Polymarket"));
        assert_eq!(text, "found: false\nnote: not available on Polymarket");
        assert!(!text.contains("answer:"), "a not-found result exposes no answer to the manager");
    }
}
