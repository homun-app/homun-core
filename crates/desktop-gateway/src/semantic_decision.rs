use local_first_task_runtime::{ObjectiveContractRecord, ObjectiveMode};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ObjectiveRelationship {
    NewObjective,
    SameObjective,
    CompatibleExtension,
    Replacement,
    ScopeExpansion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExecutionShape {
    AgentLoop,
    Workflow,
    AtomicCapability,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeliverableKind {
    ChatReport,
    Artifact,
    CodeChange,
    ExternalAction,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EffectClass {
    Read,
    RequestAuthorization,
    FilesystemWrite,
    ArtifactCreation,
    ExternalWrite,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DeliverableDecision {
    pub(crate) kind: DeliverableKind,
    pub(crate) artifact_requested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SemanticScope {
    #[serde(default)]
    pub(crate) resources: Vec<String>,
    #[serde(default)]
    pub(crate) may_request_additional_access: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct MemoryIntent {
    pub(crate) use_current_thread: bool,
    pub(crate) search_personal: bool,
    pub(crate) search_project: bool,
    pub(crate) vault_value_requested: bool,
    #[serde(default)]
    pub(crate) standalone_choice_request: bool,
    #[serde(default)]
    pub(crate) durable_memory_candidate: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct SemanticDecision {
    pub(crate) objective: String,
    pub(crate) relationship_to_active_objective: ObjectiveRelationship,
    pub(crate) mode: ObjectiveMode,
    pub(crate) scope: SemanticScope,
    pub(crate) allowed_effect_classes: Vec<EffectClass>,
    pub(crate) forbidden_effect_classes: Vec<EffectClass>,
    pub(crate) deliverable: DeliverableDecision,
    pub(crate) execution_shape: ExecutionShape,
    pub(crate) selected_capability: Option<String>,
    pub(crate) memory_intent: MemoryIntent,
    pub(crate) requires_user_confirmation: bool,
    pub(crate) confidence: f64,
    pub(crate) rationale: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CapabilitySemanticEntry {
    pub(crate) key: String,
    pub(crate) effects: Vec<EffectClass>,
    pub(crate) enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct SemanticDecisionProvenance {
    pub(crate) schema_version: u32,
    pub(crate) provider: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) fallback_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ValidatedSemanticDecision {
    #[serde(flatten)]
    pub(crate) decision: SemanticDecision,
    pub(crate) provenance: SemanticDecisionProvenance,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SemanticDecisionError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

const SEMANTIC_DECISION_SCHEMA_VERSION: u32 = 1;

fn write_effect(effect: EffectClass) -> bool {
    matches!(
        effect,
        EffectClass::FilesystemWrite
            | EffectClass::ArtifactCreation
            | EffectClass::ExternalWrite
    )
}

pub(crate) fn validate_decision(
    decision: SemanticDecision,
    registry: &[CapabilitySemanticEntry],
    active: Option<&ObjectiveContractRecord>,
) -> Result<ValidatedSemanticDecision, SemanticDecisionError> {
    if decision.objective.trim().is_empty() {
        return Err(SemanticDecisionError {
            code: "empty_objective",
            message: "the semantic decision has no objective".to_string(),
        });
    }
    if !(0.0..=1.0).contains(&decision.confidence) {
        return Err(SemanticDecisionError {
            code: "invalid_confidence",
            message: "confidence must be between zero and one".to_string(),
        });
    }

    let capability = match decision.execution_shape {
        ExecutionShape::AgentLoop => {
            if decision.selected_capability.is_some() {
                return Err(SemanticDecisionError {
                    code: "route_conflict",
                    message: "agent_loop cannot select a single capability".to_string(),
                });
            }
            None
        }
        ExecutionShape::Workflow | ExecutionShape::AtomicCapability => {
            let key = decision.selected_capability.as_deref().ok_or_else(|| {
                SemanticDecisionError {
                    code: "missing_capability",
                    message: "the selected execution shape requires a capability".to_string(),
                }
            })?;
            let capability = registry
                .iter()
                .find(|entry| entry.enabled && entry.key == key)
                .ok_or_else(|| SemanticDecisionError {
                    code: "unknown_capability",
                    message: format!("unknown or disabled capability: {key}"),
                })?;
            Some(capability)
        }
    };

    let decision_forbids_writes = decision
        .forbidden_effect_classes
        .iter()
        .copied()
        .any(write_effect);
    let decision_allows_writes = decision
        .allowed_effect_classes
        .iter()
        .copied()
        .any(write_effect);
    let deliverable_has_effect = matches!(
        decision.deliverable.kind,
        DeliverableKind::Artifact | DeliverableKind::CodeChange | DeliverableKind::ExternalAction
    ) || decision.deliverable.artifact_requested;
    let capability_has_effect = capability.is_some_and(|entry| {
        entry.effects.iter().copied().any(|effect| {
            write_effect(effect) || decision.forbidden_effect_classes.contains(&effect)
        })
    });
    if decision.mode == ObjectiveMode::ReadOnlyAnalysis
        && (decision_allows_writes || deliverable_has_effect || capability_has_effect)
        || decision_forbids_writes && (deliverable_has_effect || capability_has_effect)
    {
        return Err(SemanticDecisionError {
            code: "effect_conflict",
            message: "the selected route or deliverable conflicts with the effect policy"
                .to_string(),
        });
    }

    if decision.relationship_to_active_objective == ObjectiveRelationship::ScopeExpansion
        && !decision.requires_user_confirmation
    {
        return Err(SemanticDecisionError {
            code: "scope_confirmation_missing",
            message: "scope expansion requires user confirmation".to_string(),
        });
    }
    if let Some(active) = active
        && matches!(
            decision.relationship_to_active_objective,
            ObjectiveRelationship::SameObjective | ObjectiveRelationship::CompatibleExtension
        )
        && active.mode == ObjectiveMode::ReadOnlyAnalysis
        && decision.mode != ObjectiveMode::ReadOnlyAnalysis
        && !decision.requires_user_confirmation
    {
        return Err(SemanticDecisionError {
            code: "effect_confirmation_missing",
            message: "new effects on an active read-only objective require confirmation".to_string(),
        });
    }

    Ok(ValidatedSemanticDecision {
        decision,
        provenance: SemanticDecisionProvenance {
            schema_version: SEMANTIC_DECISION_SCHEMA_VERSION,
            provider: None,
            model: None,
            fallback_reason: None,
        },
    })
}

fn default_memory_intent() -> MemoryIntent {
    MemoryIntent {
        use_current_thread: true,
        search_personal: false,
        search_project: false,
        vault_value_requested: false,
        standalone_choice_request: false,
        durable_memory_candidate: false,
    }
}

pub(crate) fn safe_fallback(
    active: Option<&ObjectiveContractRecord>,
    reason: &str,
) -> ValidatedSemanticDecision {
    if let Some(active) = active
        && let Some(value) = active.scope_json.get("semantic_decision")
        && let Ok(mut decision) = serde_json::from_value::<ValidatedSemanticDecision>(value.clone())
    {
        decision.provenance.fallback_reason = Some(reason.to_string());
        return decision;
    }

    let objective = active
        .map(|record| record.objective.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Safely inspect the user's request and report in chat".to_string());
    let mode = active
        .map(|record| record.mode)
        .unwrap_or(ObjectiveMode::ReadOnlyAnalysis);
    let (allowed_effect_classes, forbidden_effect_classes) = if mode
        == ObjectiveMode::ReadOnlyAnalysis
    {
        (
            vec![EffectClass::Read, EffectClass::RequestAuthorization],
            vec![
                EffectClass::FilesystemWrite,
                EffectClass::ArtifactCreation,
                EffectClass::ExternalWrite,
            ],
        )
    } else {
        (
            vec![
                EffectClass::Read,
                EffectClass::RequestAuthorization,
                EffectClass::FilesystemWrite,
                EffectClass::ArtifactCreation,
                EffectClass::ExternalWrite,
            ],
            Vec::new(),
        )
    };
    ValidatedSemanticDecision {
        decision: SemanticDecision {
            objective,
            relationship_to_active_objective: if active.is_some() {
                ObjectiveRelationship::SameObjective
            } else {
                ObjectiveRelationship::NewObjective
            },
            mode,
            scope: SemanticScope {
                resources: Vec::new(),
                may_request_additional_access: true,
            },
            allowed_effect_classes,
            forbidden_effect_classes,
            deliverable: DeliverableDecision {
                kind: DeliverableKind::ChatReport,
                artifact_requested: false,
            },
            execution_shape: ExecutionShape::AgentLoop,
            selected_capability: None,
            memory_intent: default_memory_intent(),
            requires_user_confirmation: false,
            confidence: 0.0,
            rationale: "Safe fallback; no semantic inference was made.".to_string(),
        },
        provenance: SemanticDecisionProvenance {
            schema_version: SEMANTIC_DECISION_SCHEMA_VERSION,
            provider: None,
            model: None,
            fallback_reason: Some(reason.to_string()),
        },
    }
}

pub(crate) fn semantic_decision_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": [
            "objective", "relationship_to_active_objective", "mode", "scope",
            "allowed_effect_classes", "forbidden_effect_classes", "deliverable",
            "execution_shape", "selected_capability", "memory_intent",
            "requires_user_confirmation", "confidence", "rationale"
        ],
        "properties": {
            "objective": { "type": "string", "minLength": 1 },
            "relationship_to_active_objective": {
                "type": "string",
                "enum": ["new_objective", "same_objective", "compatible_extension", "replacement", "scope_expansion"]
            },
            "mode": { "type": "string", "enum": ["read_only_analysis", "mutation", "mixed"] },
            "scope": {
                "type": "object",
                "additionalProperties": false,
                "required": ["resources", "may_request_additional_access"],
                "properties": {
                    "resources": { "type": "array", "items": { "type": "string" } },
                    "may_request_additional_access": { "type": "boolean" }
                }
            },
            "allowed_effect_classes": {
                "type": "array",
                "items": { "$ref": "#/$defs/effect" },
                "uniqueItems": true
            },
            "forbidden_effect_classes": {
                "type": "array",
                "items": { "$ref": "#/$defs/effect" },
                "uniqueItems": true
            },
            "deliverable": {
                "type": "object",
                "additionalProperties": false,
                "required": ["kind", "artifact_requested"],
                "properties": {
                    "kind": { "type": "string", "enum": ["chat_report", "artifact", "code_change", "external_action", "none"] },
                    "artifact_requested": { "type": "boolean" }
                }
            },
            "execution_shape": { "type": "string", "enum": ["agent_loop", "workflow", "atomic_capability"] },
            "selected_capability": { "type": ["string", "null"] },
            "memory_intent": {
                "type": "object",
                "additionalProperties": false,
                "required": ["use_current_thread", "search_personal", "search_project", "vault_value_requested", "standalone_choice_request", "durable_memory_candidate"],
                "properties": {
                    "use_current_thread": { "type": "boolean" },
                    "search_personal": { "type": "boolean" },
                    "search_project": { "type": "boolean" },
                    "vault_value_requested": { "type": "boolean" },
                    "standalone_choice_request": { "type": "boolean" },
                    "durable_memory_candidate": { "type": "boolean" }
                }
            },
            "requires_user_confirmation": { "type": "boolean" },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "rationale": { "type": "string" }
        },
        "$defs": {
            "effect": {
                "type": "string",
                "enum": ["read", "request_authorization", "filesystem_write", "artifact_creation", "external_write"]
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_only_decision() -> SemanticDecision {
        SemanticDecision {
            objective: "Inspect the project and report in chat".to_string(),
            relationship_to_active_objective: ObjectiveRelationship::NewObjective,
            mode: ObjectiveMode::ReadOnlyAnalysis,
            scope: SemanticScope {
                resources: vec!["project".to_string()],
                may_request_additional_access: true,
            },
            allowed_effect_classes: vec![EffectClass::Read, EffectClass::RequestAuthorization],
            forbidden_effect_classes: vec![
                EffectClass::FilesystemWrite,
                EffectClass::ArtifactCreation,
                EffectClass::ExternalWrite,
            ],
            deliverable: DeliverableDecision {
                kind: DeliverableKind::ChatReport,
                artifact_requested: false,
            },
            execution_shape: ExecutionShape::AgentLoop,
            selected_capability: None,
            memory_intent: MemoryIntent {
                use_current_thread: true,
                search_personal: false,
                search_project: true,
                vault_value_requested: false,
                standalone_choice_request: false,
                durable_memory_candidate: false,
            },
            requires_user_confirmation: false,
            confidence: 0.98,
            rationale: "The user requested analysis only.".to_string(),
        }
    }

    fn registry() -> Vec<CapabilitySemanticEntry> {
        vec![CapabilitySemanticEntry {
            key: "make_document".to_string(),
            effects: vec![EffectClass::ArtifactCreation, EffectClass::FilesystemWrite],
            enabled: true,
        }]
    }

    #[test]
    fn read_only_decision_rejects_effectful_workflow() {
        let mut decision = read_only_decision();
        decision.execution_shape = ExecutionShape::Workflow;
        decision.selected_capability = Some("make_document".to_string());

        assert_eq!(
            validate_decision(decision, &registry(), None)
                .unwrap_err()
                .code,
            "effect_conflict"
        );
    }

    #[test]
    fn unknown_capability_is_rejected() {
        let mut decision = read_only_decision();
        decision.execution_shape = ExecutionShape::AtomicCapability;
        decision.selected_capability = Some("missing".to_string());

        assert_eq!(
            validate_decision(decision, &registry(), None)
                .unwrap_err()
                .code,
            "unknown_capability"
        );
    }

    #[test]
    fn new_turn_fallback_is_read_only_agent_loop() {
        let decision = safe_fallback(None, "model_unavailable");
        assert_eq!(decision.decision.mode, ObjectiveMode::ReadOnlyAnalysis);
        assert_eq!(decision.decision.execution_shape, ExecutionShape::AgentLoop);
        assert_eq!(
            decision.decision.deliverable.kind,
            DeliverableKind::ChatReport
        );
        assert_eq!(
            decision.provenance.fallback_reason.as_deref(),
            Some("model_unavailable")
        );
    }
}
