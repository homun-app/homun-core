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
    EffectClass, ExecutionShape, MemoryIntent, ObjectiveEffectPolicy, ObjectiveRelationship,
    SteeringDisposition, ValidatedSemanticDecision, safe_fallback, semantic_decision_from_contract,
    validate_decision,
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

/// Bounded copy of the objective contract needed to resume safely even if the
/// canonical projection cannot be loaded during the next turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ResumeContractSnapshot {
    pub(crate) objective_revision: u64,
    pub(crate) objective: String,
    pub(crate) mode: ObjectiveMode,
    #[serde(default)]
    pub(crate) allowed_effect_classes: Vec<EffectClass>,
    #[serde(default)]
    pub(crate) forbidden_effect_classes: Vec<EffectClass>,
    pub(crate) memory_intent: MemoryIntent,
    #[serde(default)]
    pub(crate) completion: Value,
}

impl ResumeContractSnapshot {
    pub(crate) fn from_objective(contract: &ObjectiveContractRecord) -> Self {
        let semantic = semantic_decision_from_contract(contract);
        let allowed_effect_classes = ObjectiveEffectPolicy::from_contract(Some(contract))
            .allowed_effects()
            .to_vec();
        let forbidden_effect_classes = complement_effects(&allowed_effect_classes);
        let memory_intent = semantic
            .map(|row| row.decision.memory_intent)
            .unwrap_or_else(MemoryIntent::safe_default);
        Self {
            objective_revision: contract.revision,
            objective: contract.objective.clone(),
            mode: contract.mode,
            allowed_effect_classes,
            forbidden_effect_classes,
            memory_intent,
            completion: contract.completion_json.clone(),
        }
    }

    fn as_objective_record(&self, wait: &OpenHitlWait) -> ObjectiveContractRecord {
        let mut semantic = safe_fallback(None, HITL_RESUME_CODE);
        semantic.decision.objective = self.objective.clone();
        semantic.decision.mode = self.mode;
        semantic.decision.allowed_effect_classes = self.allowed_effect_classes.clone();
        semantic.decision.forbidden_effect_classes = self.forbidden_effect_classes.clone();
        semantic.decision.memory_intent = self.memory_intent.clone();
        ObjectiveContractRecord {
            user_id: String::new(),
            workspace_id: String::new(),
            thread_id: wait.thread_id.clone(),
            source_message_id: wait.source_message_id.clone(),
            objective: self.objective.clone(),
            mode: self.mode,
            scope_json: serde_json::json!({"semantic_decision": semantic}),
            allowed_actions_json: serde_json::to_value(&self.allowed_effect_classes)
                .unwrap_or_else(|_| Value::Array(Vec::new())),
            completion_json: self.completion.clone(),
            status: "active".to_string(),
            revision: self.objective_revision,
            created_at: wait.created_at,
            updated_at: wait.created_at,
        }
    }
}

const ALL_EFFECTS: [EffectClass; 5] = [
    EffectClass::Read,
    EffectClass::RequestAuthorization,
    EffectClass::FilesystemWrite,
    EffectClass::ArtifactCreation,
    EffectClass::ExternalWrite,
];

fn complement_effects(allowed: &[EffectClass]) -> Vec<EffectClass> {
    ALL_EFFECTS
        .into_iter()
        .filter(|effect| !allowed.contains(effect))
        .collect()
}

pub(crate) fn bounded_remaining_plan(plan: Vec<Value>) -> Vec<Value> {
    plan.into_iter()
        .filter(|step| step.get("status").and_then(Value::as_str) != Some("done"))
        .take(12)
        .filter_map(|step| {
            let title = step.get("title").and_then(Value::as_str)?.trim();
            if title.is_empty() {
                return None;
            }
            Some(serde_json::json!({
                "id": step.get("id").and_then(Value::as_str).unwrap_or_default(),
                "title": title.chars().take(500).collect::<String>(),
                "status": step.get("status").and_then(Value::as_str).unwrap_or("doing"),
                "detail": step
                    .get("detail")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .chars()
                    .take(1_000)
                    .collect::<String>(),
                "done_criterion": step
                    .get("done_criterion")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .chars()
                    .take(1_000)
                    .collect::<String>(),
            }))
        })
        .collect()
}

/// Machine snapshot of work that must survive across the user wait.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct OpenWorkSnapshot {
    #[serde(default = "open_work_schema_version")]
    pub(crate) schema_version: u32,
    /// Thread still held a live warm browser session when the wait was opened.
    #[serde(default)]
    pub(crate) browser_session_live: bool,
    /// A revision-matched durable checkpoint can reactivate browser continuation even when the
    /// warm sidecar is gone. This is metadata only; no target, URL, descriptor, or value is stored.
    #[serde(default)]
    pub(crate) browser_checkpoint_available: bool,
    #[serde(default)]
    pub(crate) browser_checkpoint_generation: Option<u64>,
    /// Last known page URL if available (optional; empty when unknown).
    #[serde(default)]
    pub(crate) last_url: Option<String>,
    /// Capability the open work already depended on (e.g. "browse").
    #[serde(default)]
    pub(crate) capability_hint: Option<String>,
    /// Contract in force when the wait opened.
    #[serde(default)]
    pub(crate) contract: Option<ResumeContractSnapshot>,
    /// Canonical open plan steps, bounded and sanitized before persistence.
    #[serde(default)]
    pub(crate) remaining_plan: Vec<Value>,
}

pub(crate) const OPEN_WORK_SCHEMA_VERSION: u32 = 2;

const fn open_work_schema_version() -> u32 {
    OPEN_WORK_SCHEMA_VERSION
}

impl Default for OpenWorkSnapshot {
    fn default() -> Self {
        Self {
            schema_version: open_work_schema_version(),
            browser_session_live: false,
            browser_checkpoint_available: false,
            browser_checkpoint_generation: None,
            last_url: None,
            capability_hint: None,
            contract: None,
            remaining_plan: Vec::new(),
        }
    }
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
    let snapshot_record = wait
        .open_work
        .contract
        .as_ref()
        .map(|contract| contract.as_objective_record(wait));
    let governing_contract = active.or(snapshot_record.as_ref());
    let kind_label = wait.kind_label();
    let objective = governing_contract
        .map(|row| row.objective.clone())
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| {
            wait.question()
                .map(|q| format!("Continue after user {kind_label}: {q}"))
                .unwrap_or_else(|| format!("Continue the open task after the user's {kind_label}"))
        });
    let mut candidate = safe_fallback(governing_contract, HITL_RESUME_CODE);
    if let Some(contract) = governing_contract {
        candidate.decision.allowed_effect_classes =
            ObjectiveEffectPolicy::from_contract(Some(contract))
                .allowed_effects()
                .to_vec();
        candidate.decision.forbidden_effect_classes =
            complement_effects(&candidate.decision.allowed_effect_classes);
    }
    candidate.decision.objective = objective;
    candidate.decision.relationship_to_active_objective = ObjectiveRelationship::SameObjective;
    candidate.decision.execution_shape = ExecutionShape::AgentLoop;
    candidate.decision.selected_capability = None;
    candidate.decision.steering_disposition = SteeringDisposition::ContinueCurrentWork;
    candidate.decision.requires_user_confirmation = false;
    candidate.decision.confidence = 1.0;
    candidate.decision.rationale = format!(
        "HITL {kind_label} resume (wait_id={}): continue open work with resolution «{}».",
        wait.wait_id,
        resolution.trim()
    );

    match validate_decision(candidate.decision, &[], governing_contract) {
        Ok(mut validated) => {
            validated.provenance.validator_rejection_code = Some(HITL_RESUME_CODE.to_string());
            validated
        }
        Err(error) => {
            let mut fallback = safe_fallback(governing_contract, error.code);
            fallback.provenance.validator_rejection_code = Some(error.code.to_string());
            fallback
        }
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
    } else if wait.open_work.browser_checkpoint_available {
        format!(
            "OpenWork.browser: the warm sidecar is gone, but a revision-matched CHECKPOINT{} is available. Continue with `browse`: recovery will force a fresh snapshot and will NOT replay the interrupted action. Do NOT call find_capability or suggest_capabilities. Do NOT restart discovery/search from scratch.",
            wait.open_work
                .browser_checkpoint_generation
                .map(|generation| format!(" at generation {generation}"))
                .unwrap_or_default()
        )
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
    let contract = wait
        .open_work
        .contract
        .as_ref()
        .map(|contract| {
            format!(
                "\nOpenWork.contract: objective revision {revision}, mode {mode:?}. Objective: {objective}",
                revision = contract.objective_revision,
                mode = contract.mode,
                objective = contract.objective,
            )
        })
        .unwrap_or_default();
    let remaining_plan = wait
        .open_work
        .remaining_plan
        .iter()
        .take(12)
        .filter_map(|step| {
            let title = step.get("title").and_then(Value::as_str)?.trim();
            if title.is_empty() {
                return None;
            }
            let detail = step
                .get("detail")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|detail| !detail.is_empty())
                .map(|detail| format!(" — {detail}"))
                .unwrap_or_default();
            Some(format!("- {title}{detail}"))
        })
        .collect::<Vec<_>>();
    let remaining_plan = if remaining_plan.is_empty() {
        String::new()
    } else {
        format!("\nOpenWork.remaining_plan:\n{}", remaining_plan.join("\n"))
    };
    format!(
        "HITL RESUME ({kind_label} wait_id={wait_id}): {detail}. \
Continue the SAME open work — this is NOT a new objective.\n{browser_line}{url}{contract}{remaining_plan}",
        wait_id = wait.wait_id,
        detail = detail,
        browser_line = browser_line,
        url = url,
        contract = contract,
        remaining_plan = remaining_plan,
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
/// When both warm browser and durable checkpoint are gone, `find_capability` stays so the model
/// can re-activate browse; `suggest_capabilities` (CONNECT_SUGGEST) is always forbidden on resume.
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
    use crate::semantic_decision::EffectClass;
    use local_first_task_runtime::ObjectiveMode;

    fn active_contract(decision: ValidatedSemanticDecision) -> ObjectiveContractRecord {
        ObjectiveContractRecord {
            user_id: "user_1".into(),
            workspace_id: "workspace_1".into(),
            thread_id: "thread_1".into(),
            source_message_id: "msg_0".into(),
            objective: decision.decision.objective.clone(),
            mode: decision.decision.mode,
            scope_json: serde_json::json!({"semantic_decision": decision}),
            allowed_actions_json: serde_json::to_value(&decision.decision.allowed_effect_classes)
                .unwrap(),
            completion_json: serde_json::json!({"deliverable":"chat_report"}),
            status: "active".into(),
            revision: 7,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn read_only_contract() -> ObjectiveContractRecord {
        active_contract(crate::semantic_decision::safe_fallback(None, "fixture"))
    }

    fn mixed_contract() -> ObjectiveContractRecord {
        let mut decision = crate::semantic_decision::safe_fallback(None, "fixture");
        decision.decision.objective = "Prepare an external draft using the saved profile".into();
        decision.decision.mode = ObjectiveMode::Mixed;
        decision.decision.allowed_effect_classes = vec![
            EffectClass::Read,
            EffectClass::RequestAuthorization,
            EffectClass::ExternalWrite,
        ];
        decision.decision.forbidden_effect_classes =
            vec![EffectClass::FilesystemWrite, EffectClass::ArtifactCreation];
        decision.decision.deliverable.kind =
            crate::semantic_decision::DeliverableKind::ExternalAction;
        decision.decision.memory_intent.search_personal = true;
        decision.decision.memory_intent.vault_value_requested = true;
        decision.provenance.fallback_reason = None;
        active_contract(decision)
    }

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
                ..OpenWorkSnapshot::default()
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
                ..OpenWorkSnapshot::default()
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
    fn read_only_resume_preserves_effect_policy_and_has_no_route_conflict() {
        let wait = sample_choice_wait(&["A", "B"]);
        let active = read_only_contract();

        let decision = hitl_resume_semantic_decision(&wait, "A", Some(&active));

        assert_eq!(decision.decision.mode, ObjectiveMode::ReadOnlyAnalysis);
        assert_eq!(
            decision.decision.allowed_effect_classes,
            vec![EffectClass::Read, EffectClass::RequestAuthorization]
        );
        assert_eq!(
            decision.decision.forbidden_effect_classes,
            vec![
                EffectClass::FilesystemWrite,
                EffectClass::ArtifactCreation,
                EffectClass::ExternalWrite,
            ]
        );
        assert_eq!(decision.decision.execution_shape, ExecutionShape::AgentLoop);
        assert_eq!(decision.decision.selected_capability, None);
        assert!(
            crate::semantic_decision::validate_decision(
                decision.decision.clone(),
                &[],
                Some(&active),
            )
            .is_ok()
        );
    }

    #[test]
    fn mixed_resume_preserves_exact_effect_and_memory_intent() {
        let wait = sample_choice_wait(&["A", "B"]);
        let active = mixed_contract();

        let decision = hitl_resume_semantic_decision(&wait, "B", Some(&active));

        assert_eq!(decision.decision.mode, ObjectiveMode::Mixed);
        assert_eq!(
            decision.decision.relationship_to_active_objective,
            ObjectiveRelationship::SameObjective
        );
        assert_eq!(
            decision.decision.steering_disposition,
            SteeringDisposition::ContinueCurrentWork
        );
        assert_eq!(
            decision.decision.allowed_effect_classes,
            vec![
                EffectClass::Read,
                EffectClass::RequestAuthorization,
                EffectClass::ExternalWrite,
            ]
        );
        assert_eq!(
            decision.decision.forbidden_effect_classes,
            vec![EffectClass::FilesystemWrite, EffectClass::ArtifactCreation,]
        );
        assert!(decision.decision.memory_intent.search_personal);
        assert!(decision.decision.memory_intent.vault_value_requested);
        assert_eq!(
            decision.provenance.validator_rejection_code.as_deref(),
            Some(HITL_RESUME_CODE)
        );
        assert!(decision.provenance.fallback_reason.is_none());
        assert!(
            crate::semantic_decision::validate_decision(
                decision.decision.clone(),
                &[],
                Some(&active),
            )
            .is_ok()
        );

        let projection = crate::semantic_decision::objective_contract_projection_for_request(
            &decision,
            Some(&active),
            "thread_1",
            "workspace_1",
            None,
            "B",
        );
        assert_eq!(projection.objective, active.objective);
        assert_eq!(projection.mode, ObjectiveMode::Mixed);
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
    fn harness_slot_keeps_browser_continuation_when_only_checkpoint_survives() {
        let mut wait = sample_choice_wait(&["A"]);
        wait.open_work.browser_checkpoint_available = true;
        wait.open_work.browser_checkpoint_generation = Some(12);

        let slot = hitl_resume_harness_slot(&wait, "A", false);

        assert!(slot.contains("CHECKPOINT"));
        assert!(slot.contains("generation 12"));
        assert!(slot.contains("Do NOT restart discovery/search from scratch"));
        assert!(!slot.contains("MAY re-search"));
    }

    #[test]
    fn open_work_round_trips_resume_contract_and_remaining_plan() {
        let persisted = serde_json::json!({
            "browser_session_live": true,
            "last_url": "https://example.test/results",
            "capability_hint": "browse",
            "contract": {
                "objective_revision": 7,
                "objective": "Compare options, wait for a choice, then prepare a draft without confirming it.",
                "mode": "mixed",
                "allowed_effect_classes": ["read", "request_authorization", "external_write"],
                "forbidden_effect_classes": ["filesystem_write", "artifact_creation"],
                "memory_intent": {
                    "use_current_thread": true,
                    "search_personal": false,
                    "search_project": false,
                    "vault_value_requested": false,
                    "standalone_choice_request": false,
                    "durable_memory_candidate": false
                },
                "completion": {"deliverable":"chat_report","requires_evidence":true}
            },
            "remaining_plan": [
                {"id":"s2","title":"Prepare the draft","status":"doing","detail":"Do not confirm"}
            ]
        });

        let decoded: OpenWorkSnapshot = serde_json::from_value(persisted).unwrap();
        let encoded = serde_json::to_value(decoded).unwrap();

        assert_eq!(encoded["contract"]["objective_revision"], 7);
        assert_eq!(encoded["schema_version"], 2);
        assert_eq!(encoded["contract"]["mode"], "mixed");
        assert_eq!(encoded["remaining_plan"][0]["id"], "s2");
        assert_eq!(encoded["remaining_plan"][0]["detail"], "Do not confirm");
    }

    #[test]
    fn harness_slot_includes_durable_objective_and_remaining_work() {
        let mut wait = sample_choice_wait(&["A"]);
        wait.open_work = serde_json::from_value(serde_json::json!({
            "browser_session_live": true,
            "capability_hint": "browse",
            "contract": {
                "objective_revision": 7,
                "objective": "Compare options, wait for a choice, then prepare a draft without confirming it.",
                "mode": "mixed",
                "allowed_effect_classes": ["read", "request_authorization", "external_write"],
                "forbidden_effect_classes": ["filesystem_write", "artifact_creation"],
                "memory_intent": {
                    "use_current_thread": true,
                    "search_personal": false,
                    "search_project": false,
                    "vault_value_requested": false,
                    "standalone_choice_request": false,
                    "durable_memory_candidate": false
                },
                "completion": {"deliverable":"chat_report","requires_evidence":true}
            },
            "remaining_plan": [
                {"id":"s2","title":"Prepare the draft","status":"doing","detail":"Do not confirm"}
            ]
        })).unwrap();

        let slot = hitl_resume_harness_slot(&wait, "A", true);

        assert!(slot.contains("objective revision 7"));
        assert!(slot.contains("prepare a draft without confirming it"));
        assert!(slot.contains("Prepare the draft"));
        assert!(slot.contains("Do not confirm"));
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
