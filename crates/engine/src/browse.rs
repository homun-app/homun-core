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
/// turns use `TurnDelivery::NoVisibleAnswer` instead of manufacturing this prose. This is the sub-agent's
/// ENTIRE canned answer when it fires (never a fragment of a longer one), so recognizing it must be
/// ANCHORED to the start of the (trimmed, lowercased) answer — not `contains` — or a legitimate answer
/// that merely quotes/discusses this phrase mid-text (e.g. summarizing what an error page said) would be
/// wrongly discarded as no-answer (MINOR 10). See [`is_canonical_no_answer`].
const NO_ANSWER_MARKER: &str = "i completed the steps but couldn't produce a final answer";

/// True when `answer` (trimmed, case-insensitive) IS the canonical no-answer sentinel — matched from
/// the start of the string, not anywhere inside it. See [`NO_ANSWER_MARKER`].
fn is_canonical_no_answer(answer: &str) -> bool {
    answer.trim().to_lowercase().starts_with(NO_ANSWER_MARKER)
}

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
    let is_no_answer = is_canonical_no_answer(&answer);
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

/// Render a [`BrowseResult`] as the tool-result text the MANAGER reads (ADR 0025 slice 2; JSON
/// switch, IMPORTANT 3). A single compact JSON object — NOT the older line-prefixed text — because
/// a free-form multi-line `answer` (e.g. a multi-option itinerary) silently lost every line after
/// the first under that format, and any line inside `answer` that happened to equal
/// `sources:`/`items:`/`fields_missing:`/`evidence:` flipped the line-parser's section state and
/// fabricated structured fields out of prose. JSON round-trips a multi-line string (and one that
/// merely CONTAINS those section keywords) byte-for-byte, because it is a real string value, never
/// re-interpreted as syntax. The manager model still just reads text — a compact JSON object is as
/// legible to it as the old labeled block — but the gateway's own round trip
/// (`browse_result_for_manager` → the sub-turn's `memory_answer` → [`browse_result_from_manager_text`])
/// is now a real parse instead of a line-oracle. See [`browse_result_from_manager_text`] for the
/// paired back-compat fallback.
pub fn browse_result_for_manager(result: &BrowseResult) -> String {
    serde_json::to_string(result).unwrap_or_else(|_| {
        // `BrowseResult` has no non-serializable fields (String/Vec/enum/Option only), so this is
        // unreachable in practice — but never let a serialization hiccup crash the turn: degrade to
        // the minimal JSON shape the parser below still understands.
        json!({ "found": result.found, "answer": result.answer }).to_string()
    })
}

/// Parse the manager-facing text back into a [`BrowseResult`] (paired with
/// [`browse_result_for_manager`], IMPORTANT 3). Primary path: JSON — the exact inverse of the
/// serializer above, so a multi-line answer or one containing `sources:`/`items:` text survives
/// intact instead of being truncated or mis-parsed into fabricated structured fields.
///
/// Back-compat fallback: any string that is NOT valid JSON (the older line-prefixed format still
/// in flight during a rollout, or unexpected raw prose) degrades gracefully by becoming the WHOLE
/// `answer` — it is never re-parsed line-by-line into structured fields, which is the very bug this
/// JSON switch fixes.
pub fn browse_result_from_manager_text(text: &str) -> Option<BrowseResult> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(result) = serde_json::from_str::<BrowseResult>(trimmed) {
        return Some(result);
    }
    Some(BrowseResult {
        found: true,
        answer: trimmed.to_string(),
        confidence: Confidence::Low,
        status: BrowserDoneStatus::Partial,
        ..Default::default()
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
    fn answer_merely_quoting_the_no_answer_phrase_mid_text_is_not_discarded() {
        // MINOR 10 regression: the phrase must be ANCHORED (matched from the start of the answer),
        // not a `contains` substring check — a legitimate answer that quotes/discusses the canned
        // sentinel mid-text (e.g. summarizing what an error banner said) is real evidence and must
        // survive as `found: true`.
        let outcome = TurnOutcome {
            delivery: TurnDelivery::Delivered,
            memory_answer: "The support page says: \"if the bot couldn't produce a final answer, \
contact support\" — but I did find the answer: the fare is EUR 39."
                .to_string(),
            browse_sources: vec!["https://example.test/support".to_string()],
            ..Default::default()
        };
        let r = browse_result_from_outcome(&outcome);
        assert!(r.found, "quoting the phrase mid-text is not the canned no-answer fallback");
        assert!(r.answer.contains("EUR 39"));
    }

    #[test]
    fn the_exact_sentinel_is_still_classified_no_answer() {
        let outcome = TurnOutcome {
            delivery: TurnDelivery::Delivered,
            memory_answer: "I completed the steps but couldn't produce a final answer.".to_string(),
            ..Default::default()
        };
        let r = browse_result_from_outcome(&outcome);
        assert!(!r.found, "the exact canonical sentinel is still a no-answer");
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
    fn manager_view_is_a_compact_json_object_with_sources() {
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
        let value: Value = serde_json::from_str(&text)
            .expect("the manager view is valid JSON, not the old labeled-text format");
        assert_eq!(value["found"], json!(true));
        assert_eq!(value["answer"], json!("$63,120"));
        assert_eq!(value["confidence"], json!("high"));
        assert_eq!(value["status"], json!("completed"));
        assert_eq!(value["sources"], json!(["https://kraken.com/btc"]));
    }

    #[test]
    fn manager_view_round_trip_preserves_a_multiline_answer() {
        // IMPORTANT 3: the old line-prefixed format silently dropped every line after the first.
        let answer = "Option 1: 09:05 → 13:40, 4h35m, EUR 39\n\
Option 2: 11:10 → 15:52, 4h42m, EUR 45\n\
Option 3: 14:20 → 18:59, 4h39m, EUR 52"
            .to_string();
        let r = BrowseResult {
            found: true,
            answer: answer.clone(),
            sources: vec!["https://www.trenitalia.com/".to_string()],
            confidence: Confidence::High,
            status: BrowserDoneStatus::Completed,
            ..Default::default()
        };
        let text = browse_result_for_manager(&r);
        let back = browse_result_from_manager_text(&text).expect("valid JSON parses back");
        assert_eq!(back.answer, answer, "every line of the multi-line answer survives the round trip");
        assert_eq!(back.answer.lines().count(), 3);
        assert!(back.found);
        assert_eq!(back.sources, r.sources);
        assert_eq!(back.status, BrowserDoneStatus::Completed);
    }

    #[test]
    fn manager_view_round_trip_does_not_fabricate_structured_fields_from_answer_text() {
        // IMPORTANT 3: an answer whose OWN text contains lines equal to the old section headers
        // (`sources:`, `items:`, ...) used to flip the line-parser's section state and manufacture
        // fake structured fields out of prose. JSON never re-interprets a string value as syntax.
        let tricky_answer = "Here is what the board shows:\nsources:\nitems:\n- this is prose, not a real list"
            .to_string();
        let r = BrowseResult {
            found: true,
            answer: tricky_answer.clone(),
            confidence: Confidence::Low,
            status: BrowserDoneStatus::Partial,
            ..Default::default()
        };
        let text = browse_result_for_manager(&r);
        let back = browse_result_from_manager_text(&text).expect("valid JSON parses back");
        assert_eq!(
            back.answer, tricky_answer,
            "the literal 'sources:'/'items:' lines inside the answer are not section headers"
        );
        assert!(back.sources.is_empty(), "no sources were fabricated from the answer text");
        assert!(back.items.is_empty(), "no items were fabricated from the answer text");
        assert!(back.fields_missing.is_empty());
        assert!(back.evidence.is_empty());
    }

    #[test]
    fn non_json_legacy_string_becomes_the_whole_answer() {
        // Back-compat fallback: a string that predates the JSON switch (or unexpected raw prose)
        // degrades gracefully — it is never re-parsed into structured fields, just carried whole.
        let legacy = "The train departs at 09:05 and arrives at 13:40.";
        let back = browse_result_from_manager_text(legacy).expect("legacy text still parses");
        assert_eq!(back.answer, legacy);
        assert!(back.found, "a non-empty legacy string degrades to a found answer");
        assert!(back.sources.is_empty());
    }

    #[test]
    fn manager_view_of_not_found_carries_note_as_json_with_empty_answer() {
        let text = browse_result_for_manager(&BrowseResult::not_found("not available on Polymarket"));
        let value: Value = serde_json::from_str(&text)
            .expect("the manager view is valid JSON, not the old labeled-text format");
        assert_eq!(value["found"], json!(false));
        assert_eq!(value["note"], json!("not available on Polymarket"));
        assert_eq!(value["answer"], json!(""), "a not-found result carries no real answer");
        let back = browse_result_from_manager_text(&text).expect("valid JSON parses back");
        assert!(!back.found);
        assert_eq!(back.note.as_deref(), Some("not available on Polymarket"));
    }
}
