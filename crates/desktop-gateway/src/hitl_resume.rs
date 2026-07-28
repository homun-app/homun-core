//! HITL ResumeBinding — machine-owned wait + open-work resume (Turn Contract).
//!
//! Choice and Clarify stop the loop without holding the broker task. The next
//! user message must resume the SAME open work via a durable wait record — not a fresh
//! semantic "new objective" / capability-discovery turn. Pure helpers live here;
//! persistence is `chat_store::thread_hitl_waits`.
//!
//! One protocol: `kind` is the extension (choice | clarify). Same resume binder.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::semantic_decision::{
    DeliverableDecision, DeliverableKind, EffectClass, ExecutionShape, MemoryIntent,
    ObjectiveRelationship, SEMANTIC_DECISION_SCHEMA_VERSION, SemanticDecision,
    SemanticDecisionProvenance, SemanticScope, SteeringDisposition, ValidatedSemanticDecision,
};
use local_first_task_runtime::{ObjectiveContractRecord, ObjectiveMode};

/// Provenance stamp for journal/telemetry — not a soft fallback that drops disposition.
pub(crate) const HITL_RESUME_CODE: &str = "hitl_resume";
/// Legacy alias kept so older tests/logs still match.
#[allow(dead_code)]
pub(crate) const HITL_CHOICE_RESUME_CODE: &str = HITL_RESUME_CODE;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HitlWaitKind {
    Choice,
    Clarify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HitlWaitStatus {
    Open,
    Resolved,
}

/// Machine snapshot of work that must survive across the user wait.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub(crate) struct OpenWorkSnapshot {
    /// Thread still held a live warm browser session when the wait was opened.
    #[serde(default)]
    pub(crate) browser_session_live: bool,
    /// Last known page URL if available (optional; empty when unknown).
    #[serde(default)]
    pub(crate) last_url: Option<String>,
    /// Capability the open work already depended on (e.g. "browse").
    #[serde(default)]
    pub(crate) capability_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct OpenHitlWait {
    pub(crate) wait_id: String,
    pub(crate) thread_id: String,
    pub(crate) source_message_id: String,
    pub(crate) kind: HitlWaitKind,
    /// Card JSON payload (CHOICES options / CLARIFY question+fields).
    pub(crate) payload: Value,
    pub(crate) open_work: OpenWorkSnapshot,
    pub(crate) status: HitlWaitStatus,
    pub(crate) created_at: i64,
}

impl OpenHitlWait {
    pub(crate) fn choice_options(&self) -> Vec<String> {
        self.payload
            .get("options")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn question(&self) -> Option<&str> {
        self.payload.get("question").and_then(Value::as_str)
    }

    pub(crate) fn kind_label(&self) -> &'static str {
        match self.kind {
            HitlWaitKind::Choice => "Choice",
            HitlWaitKind::Clarify => "Clarify",
        }
    }
}

/// True when `prompt` resolves the open HITL wait for its kind.
pub(crate) fn prompt_resolves_hitl_wait(prompt: &str, wait: &OpenHitlWait) -> bool {
    if !matches!(wait.status, HitlWaitStatus::Open) {
        return false;
    }
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return false;
    }
    match wait.kind {
        HitlWaitKind::Choice => {
            let options = wait.choice_options();
            if options.iter().any(|option| option.trim() == trimmed) {
                return true;
            }
            // Numbered reply ("1", "2") against a listed option.
            if let Ok(index) = trimmed.parse::<usize>()
                && index >= 1
                && index <= options.len()
            {
                return true;
            }
            false
        }
        // Free-text resolution: any non-empty message answers Clarify.
        HitlWaitKind::Clarify => true,
    }
}

/// Backward-compatible alias.
#[allow(dead_code)]
pub(crate) fn prompt_resolves_choice_wait(prompt: &str, wait: &OpenHitlWait) -> bool {
    matches!(wait.kind, HitlWaitKind::Choice) && prompt_resolves_hitl_wait(prompt, wait)
}

/// Synthetic semantic decision for an HITL resume — skips the model router.
pub(crate) fn hitl_resume_semantic_decision(
    wait: &OpenHitlWait,
    resolution: &str,
    active: Option<&ObjectiveContractRecord>,
) -> ValidatedSemanticDecision {
    let kind_label = wait.kind_label();
    let objective = active
        .map(|row| row.objective.clone())
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| {
            wait.question()
                .map(|q| format!("Continue after user {kind_label}: {q}"))
                .unwrap_or_else(|| format!("Continue the open task after the user's {kind_label}"))
        });
    let mode = active.map(|row| row.mode).unwrap_or(ObjectiveMode::Mixed);
    ValidatedSemanticDecision {
        decision: SemanticDecision {
            objective,
            relationship_to_active_objective: ObjectiveRelationship::SameObjective,
            mode,
            scope: SemanticScope {
                resources: Vec::new(),
                may_request_additional_access: true,
            },
            allowed_effect_classes: vec![
                EffectClass::Read,
                EffectClass::RequestAuthorization,
                EffectClass::FilesystemWrite,
                EffectClass::ArtifactCreation,
                EffectClass::ExternalWrite,
            ],
            forbidden_effect_classes: Vec::new(),
            deliverable: DeliverableDecision {
                kind: DeliverableKind::ChatReport,
                artifact_requested: false,
            },
            execution_shape: ExecutionShape::AgentLoop,
            selected_capability: wait.open_work.capability_hint.clone().or_else(|| {
                wait.open_work
                    .browser_session_live
                    .then(|| "browse".to_string())
            }),
            memory_intent: MemoryIntent {
                use_current_thread: true,
                search_personal: false,
                search_project: false,
                vault_value_requested: false,
                standalone_choice_request: false,
                durable_memory_candidate: false,
            },
            steering_disposition: SteeringDisposition::ContinueCurrentWork,
            requires_user_confirmation: false,
            confidence: 1.0,
            rationale: format!(
                "HITL {kind_label} resume (wait_id={}): continue open work with resolution «{}».",
                wait.wait_id,
                resolution.trim()
            ),
        },
        provenance: SemanticDecisionProvenance {
            schema_version: SEMANTIC_DECISION_SCHEMA_VERSION,
            provider: None,
            model: None,
            // Keep disposition actionable (steering reads fallback_reason.is_none()).
            fallback_reason: None,
            validator_rejection_code: Some(HITL_RESUME_CODE.to_string()),
        },
    }
}

/// Backward-compatible alias.
#[allow(dead_code)]
pub(crate) fn choice_resume_semantic_decision(
    wait: &OpenHitlWait,
    resolution: &str,
    active: Option<&ObjectiveContractRecord>,
) -> ValidatedSemanticDecision {
    hitl_resume_semantic_decision(wait, resolution, active)
}

/// Harness-owned slot injected into the system prompt on resume (state in code, not prose SoT).
pub(crate) fn hitl_resume_harness_slot(
    wait: &OpenHitlWait,
    resolution: &str,
    browser_still_live: bool,
) -> String {
    let kind_label = wait.kind_label();
    let question = wait.question().unwrap_or("the prior wait");
    let detail = match wait.kind {
        HitlWaitKind::Choice => {
            let options = wait.choice_options().join(" | ");
            format!(
                "the user resolved «{question}» with «{resolution}» (options were: {options})",
                resolution = resolution.trim(),
            )
        }
        HitlWaitKind::Clarify => format!(
            "the user answered «{question}» with free text «{resolution}»",
            resolution = resolution.trim(),
        ),
    };
    let browser_line = if browser_still_live {
        "OpenWork.browser: WARM session is live for this thread — continue with `browse` on the page already open. Do NOT call find_capability or suggest_capabilities. Do NOT restart discovery/search from scratch."
            .to_string()
    } else if wait.open_work.browser_session_live {
        "OpenWork.browser: the warm session that was live at wait-open is GONE — say so briefly if needed, then you MAY re-search. Still do NOT call suggest_capabilities."
            .to_string()
    } else {
        "OpenWork.browser: none at wait-open. Continue the open plan/capability; do NOT call suggest_capabilities as a first move."
            .to_string()
    };
    let url = wait
        .open_work
        .last_url
        .as_deref()
        .filter(|u| !u.is_empty())
        .map(|u| format!(" Last URL at wait-open: {u}."))
        .unwrap_or_default();
    format!(
        "HITL RESUME ({kind_label} wait_id={wait_id}): {detail}. \
Continue the SAME open work — this is NOT a new objective.\n{browser_line}{url}",
        wait_id = wait.wait_id,
        detail = detail,
        browser_line = browser_line,
        url = url,
    )
}

/// Backward-compatible alias.
#[allow(dead_code)]
pub(crate) fn choice_resume_harness_slot(
    wait: &OpenHitlWait,
    resolution: &str,
    browser_still_live: bool,
) -> String {
    hitl_resume_harness_slot(wait, resolution, browser_still_live)
}

/// On an HITL resume, strip cold-discovery tools from the live set.
/// When the warm browser is gone, `find_capability` stays so the model can re-activate
/// browse; `suggest_capabilities` (CONNECT_SUGGEST) is always forbidden on resume.
pub(crate) fn prune_cold_discovery_tools(tools: &mut Vec<Value>, allow_rediscovery: bool) {
    tools.retain(|schema| {
        let name = schema
            .pointer("/function/name")
            .and_then(Value::as_str)
            .unwrap_or("");
        if name == "suggest_capabilities" {
            return false;
        }
        if name == "find_capability" && !allow_rediscovery {
            return false;
        }
        true
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_choice_wait(options: &[&str]) -> OpenHitlWait {
        OpenHitlWait {
            wait_id: "wait_1".into(),
            thread_id: "thread_1".into(),
            source_message_id: "msg_1".into(),
            kind: HitlWaitKind::Choice,
            payload: serde_json::json!({
                "question": "Which train?",
                "multi": false,
                "options": options,
            }),
            open_work: OpenWorkSnapshot {
                browser_session_live: true,
                last_url: Some("https://example.test/results".into()),
                capability_hint: Some("browse".into()),
            },
            status: HitlWaitStatus::Open,
            created_at: 1,
        }
    }

    fn sample_clarify_wait() -> OpenHitlWait {
        OpenHitlWait {
            wait_id: "wait_c".into(),
            thread_id: "thread_1".into(),
            source_message_id: "msg_c".into(),
            kind: HitlWaitKind::Clarify,
            payload: serde_json::json!({
                "question": "Passenger details?",
                "fields": ["name", "email", "phone"],
            }),
            open_work: OpenWorkSnapshot {
                browser_session_live: true,
                last_url: None,
                capability_hint: Some("browse".into()),
            },
            status: HitlWaitStatus::Open,
            created_at: 1,
        }
    }

    #[test]
    fn prompt_matches_option_text_or_index() {
        let wait = sample_choice_wait(&["Alpha", "Beta"]);
        assert!(prompt_resolves_hitl_wait("Alpha", &wait));
        assert!(prompt_resolves_hitl_wait("2", &wait));
        assert!(!prompt_resolves_hitl_wait("Gamma", &wait));
        assert!(!prompt_resolves_hitl_wait("0", &wait));
    }

    #[test]
    fn clarify_resolves_any_non_empty_text() {
        let wait = sample_clarify_wait();
        assert!(prompt_resolves_hitl_wait(
            "Mario Rossi, 01/01/1990, …",
            &wait
        ));
        assert!(!prompt_resolves_hitl_wait("   ", &wait));
    }

    #[test]
    fn resume_decision_is_same_objective_continue() {
        let wait = sample_choice_wait(&["A", "B"]);
        let decision = hitl_resume_semantic_decision(&wait, "A", None);
        assert_eq!(
            decision.decision.relationship_to_active_objective,
            ObjectiveRelationship::SameObjective
        );
        assert_eq!(
            decision.decision.steering_disposition,
            SteeringDisposition::ContinueCurrentWork
        );
        assert_eq!(
            decision.provenance.validator_rejection_code.as_deref(),
            Some(HITL_RESUME_CODE)
        );
        assert!(decision.provenance.fallback_reason.is_none());
        assert_ne!(
            decision.decision.relationship_to_active_objective,
            ObjectiveRelationship::NewObjective
        );
    }

    #[test]
    fn harness_slot_mentions_warm_or_gone_browser() {
        let wait = sample_choice_wait(&["A"]);
        let warm = hitl_resume_harness_slot(&wait, "A", true);
        assert!(warm.contains("HITL RESUME"));
        assert!(warm.contains("WARM"));
        assert!(warm.contains("suggest_capabilities"));
        let gone = hitl_resume_harness_slot(&wait, "A", false);
        assert!(gone.contains("GONE"));
        let clarify = hitl_resume_harness_slot(&sample_clarify_wait(), "details here", true);
        assert!(clarify.contains("Clarify"));
        assert!(clarify.contains("free text"));
    }

    #[test]
    fn prune_removes_cold_discovery_only() {
        let mut tools = vec![
            serde_json::json!({"type":"function","function":{"name":"browse"}}),
            serde_json::json!({"type":"function","function":{"name":"find_capability"}}),
            serde_json::json!({"type":"function","function":{"name":"suggest_capabilities"}}),
            serde_json::json!({"type":"function","function":{"name":"update_plan"}}),
        ];
        prune_cold_discovery_tools(&mut tools, false);
        let names: Vec<_> = tools
            .iter()
            .filter_map(|t| t.pointer("/function/name").and_then(Value::as_str))
            .collect();
        assert_eq!(names, vec!["browse", "update_plan"]);
    }

    #[test]
    fn prune_keeps_find_capability_when_rediscovery_allowed() {
        let mut tools = vec![
            serde_json::json!({"type":"function","function":{"name":"find_capability"}}),
            serde_json::json!({"type":"function","function":{"name":"suggest_capabilities"}}),
            serde_json::json!({"type":"function","function":{"name":"browse"}}),
        ];
        prune_cold_discovery_tools(&mut tools, true);
        let names: Vec<_> = tools
            .iter()
            .filter_map(|t| t.pointer("/function/name").and_then(Value::as_str))
            .collect();
        assert_eq!(names, vec!["find_capability", "browse"]);
    }
}
