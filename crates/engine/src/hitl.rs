//! Turn Contract HITL — one typed envelope for every human wait.
//!
//! Ownership handoff is NEVER "the model wrote a question in prose". The harness
//! only enters `AwaitingUser` when it holds a validated [`HitlEnvelope`]. Legacy
//! markers (`CHOICES`, `CLARIFY`, `MCP_CONFIRM`, …) normalize into this shape so
//! Choice / Clarify / Confirm share one protocol; `kind` + `hold_policy` are the
//! only extensions.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::markers::{
    ACTIONABLE_CARD_MARKER_TAGS, bodies, close, extract_numbered_option_labels, open,
    prose_asks_clarify_without_card, prose_asks_closed_choice_without_card,
    prose_mentions_payment_approval_without_card, validated_actionable_marker_blocks,
};

/// Canonical wire marker. Legacy tags normalize into the same envelope.
pub const AWAIT_USER_MARKER: &str = "AWAIT_USER";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HitlKind {
    Choice,
    Clarify,
    Confirm,
    Vault,
    Payment,
    PlanPropose,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HoldPolicy {
    /// Thread frees; next user message is a new turn + ResumeBinding.
    Free,
    /// Task stays WaitingUserApproval; resolution via approval API.
    Hold,
}

/// Machine-owned HITL stop. Extensions = data on this struct, not parallel protocols.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HitlEnvelope {
    pub kind: HitlKind,
    pub hold_policy: HoldPolicy,
    /// Kind-specific payload (options / fields / tool args / …).
    pub payload: Value,
    /// Original marker name when normalized from legacy wire (`CHOICES`, …).
    #[serde(default)]
    pub source_marker: String,
}

/// A human wait that was already resolved before this turn started. The loop uses
/// this machine-owned guard to reject an immediate semantic replay of that wait.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedHitlGuard {
    pub envelope: HitlEnvelope,
    pub resolution: String,
}

impl ResolvedHitlGuard {
    pub fn reopens(&self, candidate: &HitlEnvelope) -> bool {
        if self.envelope.kind != candidate.kind
            || self.envelope.hold_policy != candidate.hold_policy
        {
            return false;
        }
        match candidate.kind {
            HitlKind::Choice => {
                payload_strings(&self.envelope.payload, "options")
                    == payload_strings(&candidate.payload, "options")
                    && payload_bool(&self.envelope.payload, "multi")
                        == payload_bool(&candidate.payload, "multi")
            }
            HitlKind::Clarify => {
                let resolved_fields = payload_strings(&self.envelope.payload, "fields");
                let candidate_fields = payload_strings(&candidate.payload, "fields");
                if resolved_fields.is_empty() || candidate_fields.is_empty() {
                    normalized_question(&self.envelope.payload)
                        == normalized_question(&candidate.payload)
                } else {
                    resolved_fields == candidate_fields
                }
            }
            _ => self.envelope.payload == candidate.payload,
        }
    }
}

fn payload_strings(payload: &Value, key: &str) -> Vec<String> {
    let mut values: Vec<String> = payload
        .get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(|value| value.trim().to_lowercase())
                .collect()
        })
        .unwrap_or_default();
    values.sort_unstable();
    values.dedup();
    values
}

fn payload_bool(payload: &Value, key: &str) -> bool {
    payload.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn normalized_question(payload: &Value) -> String {
    payload
        .get("question")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

impl HitlEnvelope {
    pub fn is_free(&self) -> bool {
        matches!(self.hold_policy, HoldPolicy::Free)
    }

    pub fn wait_kind_key(&self) -> &'static str {
        match self.kind {
            HitlKind::Choice => "choice",
            HitlKind::Clarify => "clarify",
            HitlKind::Confirm => "confirm",
            HitlKind::Vault => "vault",
            HitlKind::Payment => "payment",
            HitlKind::PlanPropose => "plan_propose",
        }
    }
}

/// Post-model classification for a no-tools stop (Turn Contract chokepoint).
#[derive(Debug, Clone, PartialEq)]
pub enum NoToolsClassification {
    /// Structured HITL — enter AwaitingUser. Never from prose alone.
    Await(HitlEnvelope),
    /// Prose asked the user without an envelope — one harness nudge to emit it.
    NudgeEmit(HitlKind),
    /// Not an HITL ownership question; caller may plan-nudge / deliver / synthesize.
    NotHitl,
}

/// Normalize every validated actionable / AWAIT_USER block in `text` into envelopes.
pub fn hitl_envelopes_from_text(text: &str) -> Vec<HitlEnvelope> {
    let mut out = Vec::new();
    // Canonical marker first.
    for body in bodies(text, AWAIT_USER_MARKER) {
        if let Ok(value) = serde_json::from_str::<Value>(&body)
            && let Some(env) = envelope_from_await_user_payload(&value)
        {
            out.push(env);
        }
    }
    // Legacy actionable tags → same envelope.
    for block in validated_actionable_marker_blocks(text) {
        if block.marker == AWAIT_USER_MARKER {
            continue; // already handled (AWAIT_USER may also be on actionable list)
        }
        if let Some(env) = envelope_from_legacy_marker(block.marker, block.payload) {
            out.push(env);
        }
    }
    out
}

fn envelope_from_await_user_payload(value: &Value) -> Option<HitlEnvelope> {
    let kind_raw = value.get("kind").and_then(Value::as_str)?;
    let (kind, hold) = match kind_raw {
        "choice" => (HitlKind::Choice, HoldPolicy::Free),
        "clarify" => (HitlKind::Clarify, HoldPolicy::Free),
        "confirm" => (HitlKind::Confirm, HoldPolicy::Hold),
        "vault" => (HitlKind::Vault, HoldPolicy::Hold),
        "payment" => (HitlKind::Payment, HoldPolicy::Hold),
        "plan_propose" => (HitlKind::PlanPropose, HoldPolicy::Free),
        _ => return None,
    };
    let mut payload = value.clone();
    if let Some(obj) = payload.as_object_mut() {
        obj.remove("kind");
    }
    Some(HitlEnvelope {
        kind,
        hold_policy: hold,
        payload,
        source_marker: AWAIT_USER_MARKER.to_string(),
    })
}

fn envelope_from_legacy_marker(marker: &str, payload: Value) -> Option<HitlEnvelope> {
    let (kind, hold) = match marker {
        "CHOICES" => (HitlKind::Choice, HoldPolicy::Free),
        "CLARIFY" => (HitlKind::Clarify, HoldPolicy::Free),
        "COMPOSIO_CONFIRM" | "MCP_CONFIRM" | "FS_AUTHORIZE" | "SANDBOX_ESCALATE"
        | "CONNECT_SUGGEST" => (HitlKind::Confirm, HoldPolicy::Hold),
        "VAULT_PROPOSE" | "VAULT_REVEAL" => (HitlKind::Vault, HoldPolicy::Hold),
        "PAYMENT_APPROVAL" => (HitlKind::Payment, HoldPolicy::Hold),
        "PLAN_PROPOSE" | "GOAL_PROPOSE" => (HitlKind::PlanPropose, HoldPolicy::Free),
        _ => return None,
    };
    Some(HitlEnvelope {
        kind,
        hold_policy: hold,
        payload,
        source_marker: marker.to_string(),
    })
}

/// Single chokepoint: does this no-tools model stop hand ownership to the user?
pub fn classify_no_tools_stop(content: &str) -> NoToolsClassification {
    let envelopes = hitl_envelopes_from_text(content);
    if let Some(env) = envelopes.into_iter().next() {
        return NoToolsClassification::Await(env);
    }
    // Prose detectors are ONLY nudge signals — never Await.
    if prose_asks_closed_choice_without_card(content) {
        return NoToolsClassification::NudgeEmit(HitlKind::Choice);
    }
    if prose_asks_clarify_without_card(content) {
        return NoToolsClassification::NudgeEmit(HitlKind::Clarify);
    }
    if prose_mentions_payment_approval_without_card(content) {
        return NoToolsClassification::NudgeEmit(HitlKind::Payment);
    }
    NoToolsClassification::NotHitl
}

/// True when `text` contains any structured HITL envelope (canonical or legacy).
pub fn text_has_hitl_envelope(text: &str) -> bool {
    !hitl_envelopes_from_text(text).is_empty()
}

/// Build the canonical `‹‹AWAIT_USER››…‹‹/AWAIT_USER››` body for nudges / tests.
pub fn format_await_user_marker(kind: HitlKind, payload: &Value) -> String {
    let kind_str = match kind {
        HitlKind::Choice => "choice",
        HitlKind::Clarify => "clarify",
        HitlKind::Confirm => "confirm",
        HitlKind::Vault => "vault",
        HitlKind::Payment => "payment",
        HitlKind::PlanPropose => "plan_propose",
    };
    let mut body = payload.clone();
    if let Some(obj) = body.as_object_mut() {
        obj.insert("kind".into(), Value::String(kind_str.into()));
    } else {
        body = serde_json::json!({ "kind": kind_str });
    }
    format!(
        "{}{}{}",
        open(AWAIT_USER_MARKER),
        body,
        close(AWAIT_USER_MARKER)
    )
}

/// Markers that participate in HITL admission (ACTIONABLE + canonical AWAIT_USER).
pub fn hitl_actionable_marker_names() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = ACTIONABLE_CARD_MARKER_TAGS.to_vec();
    if !names.contains(&AWAIT_USER_MARKER) {
        names.push(AWAIT_USER_MARKER);
    }
    names
}

/// Ensure a Free envelope is visible on the wire so gateway persist + UI can bind Resume.
/// Steering Clarify (and similar) may set [`HitlEnvelope`] without a marker in prose —
/// inject a minimal card once so ownership is machine-readable. Hold envelopes are unchanged.
pub fn ensure_free_hitl_marker_in_text(text: &str, envelope: &HitlEnvelope) -> String {
    if !envelope.is_free() || text_has_hitl_envelope(text) {
        return text.to_string();
    }
    let marker = match envelope.kind {
        HitlKind::Choice => {
            let options = envelope
                .payload
                .get("options")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]));
            let question = envelope
                .payload
                .get("question")
                .and_then(Value::as_str)
                .unwrap_or("Please choose one option.");
            format!(
                "{}{}{}",
                open("CHOICES"),
                serde_json::json!({ "question": question, "multi": false, "options": options }),
                close("CHOICES")
            )
        }
        HitlKind::Clarify | HitlKind::PlanPropose => {
            let mut payload = envelope.payload.clone();
            if payload.get("question").and_then(Value::as_str).is_none() {
                if let Some(obj) = payload.as_object_mut() {
                    obj.insert(
                        "question".into(),
                        Value::String("Please clarify how you want to proceed.".into()),
                    );
                } else {
                    payload = serde_json::json!({
                        "question": "Please clarify how you want to proceed."
                    });
                }
            }
            format!("{}{}{}", open("CLARIFY"), payload, close("CLARIFY"))
        }
        HitlKind::Confirm | HitlKind::Vault | HitlKind::Payment => {
            return text.to_string();
        }
    };
    if text.trim().is_empty() {
        marker
    } else {
        format!("{}\n{marker}", text.trim_end())
    }
}

/// Last question-like line in prose (for materializing Clarify / Choice question).
fn prose_question_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .rev()
        .find(|l| l.contains('?') || l.to_ascii_lowercase().contains("preferisc"))
        .unwrap_or("How do you want to proceed?")
        .trim_matches('*')
        .trim()
        .to_string()
}

/// When the model asked the user in prose and we cannot afford another nudge round
/// (forced synthesis / final deliver), the harness owns materialization of a Free envelope.
pub fn materialize_nudge_envelope(kind: HitlKind, prose: &str) -> HitlEnvelope {
    match kind {
        HitlKind::Choice => {
            let options = extract_numbered_option_labels(prose);
            if options.len() >= 2 {
                HitlEnvelope {
                    kind: HitlKind::Choice,
                    hold_policy: HoldPolicy::Free,
                    payload: serde_json::json!({
                        "question": prose_question_line(prose),
                        "multi": false,
                        "options": options,
                    }),
                    source_marker: "harness_materialize".into(),
                }
            } else {
                // Closed-choice ask without parseable options → free-text Clarify.
                materialize_nudge_envelope(HitlKind::Clarify, prose)
            }
        }
        HitlKind::Clarify | HitlKind::PlanPropose => HitlEnvelope {
            kind: HitlKind::Clarify,
            hold_policy: HoldPolicy::Free,
            payload: serde_json::json!({
                "question": prose_question_line(prose),
            }),
            source_marker: "harness_materialize".into(),
        },
        // Hold kinds are not prose-materialized; confirm path owns them.
        HitlKind::Confirm | HitlKind::Vault | HitlKind::Payment => HitlEnvelope {
            kind: HitlKind::Clarify,
            hold_policy: HoldPolicy::Free,
            payload: serde_json::json!({
                "question": prose_question_line(prose),
            }),
            source_marker: "harness_materialize".into(),
        },
    }
}

/// Always Contract terminal gate: every final model text (loop stop OR forced synthesis)
/// must pass here. Prose that asks the user is never delivered as a bare wait — the harness
/// materializes a Free envelope so persist/UI/resume share one protocol.
pub fn finalize_terminal_text_for_hitl(text: &str) -> (String, Option<HitlEnvelope>) {
    match classify_no_tools_stop(text) {
        NoToolsClassification::Await(env) => (text.to_string(), Some(env)),
        NoToolsClassification::NudgeEmit(kind) => {
            let env = materialize_nudge_envelope(kind, text);
            let with_marker = ensure_free_hitl_marker_in_text(text, &env);
            (with_marker, Some(env))
        }
        NoToolsClassification::NotHitl => (text.to_string(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_choice_guard_rejects_reworded_replay_of_same_options() {
        let guard = ResolvedHitlGuard {
            envelope: HitlEnvelope {
                kind: HitlKind::Choice,
                hold_policy: HoldPolicy::Free,
                payload: serde_json::json!({
                    "question": "Which option should continue?",
                    "multi": false,
                    "options": ["ALFA", "BETA"]
                }),
                source_marker: "CHOICES".into(),
            },
            resolution: "ALFA".into(),
        };
        let replay = HitlEnvelope {
            kind: HitlKind::Choice,
            hold_policy: HoldPolicy::Free,
            payload: serde_json::json!({
                "question": "Choose the operational option:",
                "multi": false,
                "options": ["ALFA", "BETA"]
            }),
            source_marker: "CHOICES".into(),
        };
        let different = HitlEnvelope {
            payload: serde_json::json!({
                "question": "Choose the delivery format:",
                "multi": false,
                "options": ["PDF", "DOCX"]
            }),
            ..replay.clone()
        };
        let reordered = HitlEnvelope {
            payload: serde_json::json!({
                "question": "Pick one:",
                "options": ["BETA", "ALFA"]
            }),
            ..replay.clone()
        };

        assert!(guard.reopens(&replay));
        assert!(guard.reopens(&reordered));
        assert!(!guard.reopens(&different));
    }

    #[test]
    fn choices_legacy_normalizes_to_free_choice_envelope() {
        let text = r#"Pick one.
‹‹CHOICES››{"question":"Which?","options":["A","B"]}‹‹/CHOICES››"#;
        let envs = hitl_envelopes_from_text(text);
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].kind, HitlKind::Choice);
        assert_eq!(envs[0].hold_policy, HoldPolicy::Free);
        assert_eq!(
            classify_no_tools_stop(text),
            NoToolsClassification::Await(envs[0].clone())
        );
    }

    #[test]
    fn clarify_legacy_normalizes_to_free_clarify_envelope() {
        let text = r#"‹‹CLARIFY››{"question":"Details?","fields":["email"]}‹‹/CLARIFY››"#;
        let envs = hitl_envelopes_from_text(text);
        assert_eq!(envs[0].kind, HitlKind::Clarify);
        assert!(envs[0].is_free());
    }

    #[test]
    fn await_user_canonical_marker_parses() {
        let text =
            r#"‹‹AWAIT_USER››{"kind":"choice","question":"Q?","options":["1","2"]}‹‹/AWAIT_USER››"#;
        let envs = hitl_envelopes_from_text(text);
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].kind, HitlKind::Choice);
        assert_eq!(envs[0].source_marker, AWAIT_USER_MARKER);
        assert_eq!(envs[0].payload["question"], "Q?");
    }

    #[test]
    fn mcp_confirm_is_hold_confirm() {
        let text = r#"‹‹MCP_CONFIRM››{"approval_id":"a1","tool":"t"}‹‹/MCP_CONFIRM››"#;
        let envs = hitl_envelopes_from_text(text);
        assert_eq!(envs[0].kind, HitlKind::Confirm);
        assert_eq!(envs[0].hold_policy, HoldPolicy::Hold);
    }

    #[test]
    fn prose_field_request_is_nudge_not_await() {
        let text =
            "Mi servono i tuoi dati:\n- Nome\n- Email\n- Telefono\nAppena me li dai proseguo.";
        assert_eq!(
            classify_no_tools_stop(text),
            NoToolsClassification::NudgeEmit(HitlKind::Clarify)
        );
    }

    #[test]
    fn prose_closed_choice_is_nudge_choice() {
        let prose = r#"Opzioni:

| # | Treno |
|---|-------|
| 1 | A |
| 2 | B |

quale preferisci?"#;
        assert_eq!(
            classify_no_tools_stop(prose),
            NoToolsClassification::NudgeEmit(HitlKind::Choice)
        );
    }

    #[test]
    fn prose_payment_approval_claim_is_nudge_payment() {
        let prose = "Payment Approval Card già presentata: attendo la tua decisione.";
        assert_eq!(
            classify_no_tools_stop(prose),
            NoToolsClassification::NudgeEmit(HitlKind::Payment)
        );
    }

    #[test]
    fn plain_answer_is_not_hitl() {
        assert_eq!(
            classify_no_tools_stop("Here is the report."),
            NoToolsClassification::NotHitl
        );
    }

    #[test]
    fn steering_clarify_envelope_gets_wire_marker() {
        let env = HitlEnvelope {
            kind: HitlKind::Clarify,
            hold_policy: HoldPolicy::Free,
            payload: serde_json::json!({}),
            source_marker: "steering_clarify".into(),
        };
        let out = ensure_free_hitl_marker_in_text("", &env);
        assert!(out.contains("‹‹CLARIFY››"));
        assert!(text_has_hitl_envelope(&out));
        assert_eq!(
            classify_no_tools_stop(&out),
            NoToolsClassification::Await(hitl_envelopes_from_text(&out)[0].clone())
        );
    }

    #[test]
    fn ensure_marker_is_noop_when_envelope_already_present() {
        let text = r#"Ask:
‹‹CLARIFY››{"question":"Email?"}‹‹/CLARIFY››"#;
        let env = HitlEnvelope {
            kind: HitlKind::Clarify,
            hold_policy: HoldPolicy::Free,
            payload: serde_json::json!({}),
            source_marker: "CLARIFY".into(),
        };
        assert_eq!(ensure_free_hitl_marker_in_text(text, &env), text);
    }
}
