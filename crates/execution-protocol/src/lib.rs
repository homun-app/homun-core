use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionContract {
    pub execution_id: String,
    pub parent_execution_id: Option<String>,
    pub kind: String,
    pub revision: u64,
    pub fencing_token: u64,
    pub scope: ExecutionScope,
    pub objective: Option<ObjectiveRef>,
    pub input: Value,
    pub policy: ExecutionPolicy,
    pub resources: Vec<ResourceRequirement>,
    pub budget: ExecutionBudget,
    pub checkpoint: Option<CheckpointRef>,
    pub wake: Option<WakeDelivery>,
}

impl ExecutionContract {
    pub fn new(
        execution_id: impl Into<String>,
        kind: impl Into<String>,
        scope: ExecutionScope,
        input: Value,
    ) -> Self {
        Self {
            execution_id: execution_id.into(),
            parent_execution_id: None,
            kind: kind.into(),
            revision: 1,
            fencing_token: 1,
            scope,
            objective: None,
            input,
            policy: ExecutionPolicy {
                allowed_effects: vec![EffectClass::Read],
                approval_policy: "deny".into(),
            },
            resources: Vec::new(),
            budget: ExecutionBudget {
                max_attempts: 1,
                backoff_seconds: 0,
                deadline_unix: None,
            },
            checkpoint: None,
            wake: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionOutcome {
    Completed {
        output: Value,
        continuation: Option<ContinuationRef>,
    },
    Suspended {
        wake: WakeCondition,
        checkpoint: CheckpointEnvelope,
    },
    Cancelled {
        reason: CancelReason,
    },
    Failed {
        failure: ExecutionFailure,
    },
}

impl ExecutionOutcome {
    pub fn completed(output: Value) -> Self {
        Self::Completed {
            output,
            continuation: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeCondition {
    At {
        unix_timestamp: i64,
    },
    Signal {
        kind: String,
        correlation_id: String,
    },
    Resource {
        class: String,
    },
    ModelAvailable {
        role: String,
    },
    User {
        wait_ref: String,
    },
    Approval {
        approval_ref: String,
    },
    EffectResolution {
        receipt_ref: String,
    },
}

impl WakeCondition {
    pub fn dedup_key(&self) -> String {
        match self {
            Self::At { unix_timestamp } => format!("at:{unix_timestamp}"),
            Self::Signal {
                kind,
                correlation_id,
            } => format!("signal:{kind}:{correlation_id}"),
            Self::Resource { class } => format!("resource:{class}"),
            Self::ModelAvailable { role } => format!("model_available:{role}"),
            Self::User { wait_ref } => format!("user:{wait_ref}"),
            Self::Approval { approval_ref } => format!("approval:{approval_ref}"),
            Self::EffectResolution { receipt_ref } => {
                format!("effect_resolution:{receipt_ref}")
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionFailure {
    pub class: FailureClass,
    pub code: String,
    pub redacted_detail: String,
}

impl ExecutionFailure {
    pub fn transient(code: impl Into<String>, redacted_detail: impl Into<String>) -> Self {
        Self::new(FailureClass::Transient, code, redacted_detail)
    }

    pub fn permanent(code: impl Into<String>, redacted_detail: impl Into<String>) -> Self {
        Self::new(FailureClass::Permanent, code, redacted_detail)
    }

    pub fn policy_denied(code: impl Into<String>, redacted_detail: impl Into<String>) -> Self {
        Self::new(FailureClass::PolicyDenied, code, redacted_detail)
    }

    fn new(
        class: FailureClass,
        code: impl Into<String>,
        redacted_detail: impl Into<String>,
    ) -> Self {
        Self {
            class,
            code: code.into(),
            redacted_detail: redacted_detail.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    Transient,
    Permanent,
    PolicyDenied,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    User,
    Replaced,
    Expired,
    Shutdown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    Ready,
    Running,
    Suspended,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionScope {
    pub user_id: String,
    pub workspace_id: String,
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ObjectiveRef {
    pub thread_id: String,
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CheckpointRef {
    pub checkpoint_id: String,
    pub schema_version: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContinuationRef {
    pub execution_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionPolicy {
    pub allowed_effects: Vec<EffectClass>,
    pub approval_policy: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectClass {
    Read,
    FilesystemWrite,
    ArtifactCreation,
    ExternalWrite,
    RequestAuthorization,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResourceRequirement {
    pub class: String,
    pub units: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionBudget {
    pub max_attempts: u32,
    pub backoff_seconds: i64,
    pub deadline_unix: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WakeDelivery {
    pub dedup_key: String,
    pub payload: Value,
    pub delivered_at_unix: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CheckpointEnvelope {
    pub checkpoint_id: String,
    pub execution_id: String,
    pub revision: u64,
    pub producer_kind: String,
    pub schema_version: u32,
    pub sensitivity: PayloadSensitivity,
    pub payload: Value,
    pub redacted_payload: Value,
    pub secret_refs: Vec<String>,
}

impl CheckpointEnvelope {
    pub fn empty(
        execution_id: impl Into<String>,
        revision: u64,
        producer_kind: impl Into<String>,
    ) -> Self {
        let execution_id = execution_id.into();
        Self {
            checkpoint_id: format!("{execution_id}:{revision}"),
            execution_id,
            revision,
            producer_kind: producer_kind.into(),
            schema_version: 1,
            sensitivity: PayloadSensitivity::Public,
            payload: json!({}),
            redacted_payload: json!({}),
            secret_refs: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PayloadSensitivity {
    Public,
    Redacted,
    SecretRefsOnly,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scope() -> ExecutionScope {
        ExecutionScope {
            user_id: "user-1".into(),
            workspace_id: "workspace-1".into(),
            thread_id: Some("thread-1".into()),
        }
    }

    #[test]
    fn canonical_outcomes_round_trip_without_domain_types() {
        let outcomes = [
            ExecutionOutcome::completed(json!({"ok": true})),
            ExecutionOutcome::Suspended {
                wake: WakeCondition::Signal {
                    kind: "connector.message".into(),
                    correlation_id: "msg-1".into(),
                },
                checkpoint: CheckpointEnvelope::empty("exec-1", 1, "chat_turn"),
            },
            ExecutionOutcome::Cancelled {
                reason: CancelReason::User,
            },
            ExecutionOutcome::Failed {
                failure: ExecutionFailure::permanent("no_reply", "No final reply"),
            },
        ];

        for outcome in outcomes {
            let encoded = serde_json::to_string(&outcome).unwrap();
            assert_eq!(
                serde_json::from_str::<ExecutionOutcome>(&encoded).unwrap(),
                outcome
            );
        }
    }

    #[test]
    fn wake_conditions_have_stable_dedup_keys() {
        let cases = [
            (
                WakeCondition::At {
                    unix_timestamp: 1_800_000_000,
                },
                "at:1800000000",
            ),
            (
                WakeCondition::Signal {
                    kind: "connector.message".into(),
                    correlation_id: "msg-1".into(),
                },
                "signal:connector.message:msg-1",
            ),
            (
                WakeCondition::Resource {
                    class: "browser".into(),
                },
                "resource:browser",
            ),
            (
                WakeCondition::ModelAvailable {
                    role: "reasoning".into(),
                },
                "model_available:reasoning",
            ),
            (
                WakeCondition::User {
                    wait_ref: "wait-1".into(),
                },
                "user:wait-1",
            ),
            (
                WakeCondition::Approval {
                    approval_ref: "approval-1".into(),
                },
                "approval:approval-1",
            ),
            (
                WakeCondition::EffectResolution {
                    receipt_ref: "receipt-1".into(),
                },
                "effect_resolution:receipt-1",
            ),
        ];

        for (wake, expected) in cases {
            assert_eq!(wake.dedup_key(), expected);
        }
    }

    #[test]
    fn contract_constructor_uses_conservative_defaults() {
        let contract =
            ExecutionContract::new("exec-1", "chat_turn", scope(), json!({"prompt": "hello"}));

        assert_eq!(contract.execution_id, "exec-1");
        assert_eq!(contract.parent_execution_id, None);
        assert_eq!(contract.kind, "chat_turn");
        assert_eq!(contract.revision, 1);
        assert_eq!(contract.fencing_token, 1);
        assert_eq!(contract.objective, None);
        assert_eq!(contract.input, json!({"prompt": "hello"}));
        assert_eq!(contract.policy.allowed_effects, vec![EffectClass::Read]);
        assert_eq!(contract.policy.approval_policy, "deny");
        assert!(contract.resources.is_empty());
        assert_eq!(contract.budget.max_attempts, 1);
        assert_eq!(contract.budget.backoff_seconds, 0);
        assert_eq!(contract.budget.deadline_unix, None);
        assert_eq!(contract.checkpoint, None);
        assert_eq!(contract.wake, None);
    }

    #[test]
    fn failure_constructors_set_class_code_and_redacted_detail() {
        let cases = [
            (
                ExecutionFailure::transient("temporarily_unavailable", "retry later"),
                FailureClass::Transient,
                "temporarily_unavailable",
                "retry later",
            ),
            (
                ExecutionFailure::permanent("invalid_input", "input rejected"),
                FailureClass::Permanent,
                "invalid_input",
                "input rejected",
            ),
            (
                ExecutionFailure::policy_denied("effect_denied", "write not allowed"),
                FailureClass::PolicyDenied,
                "effect_denied",
                "write not allowed",
            ),
        ];

        for (failure, class, code, detail) in cases {
            assert_eq!(failure.class, class);
            assert_eq!(failure.code, code);
            assert_eq!(failure.redacted_detail, detail);
        }
    }

    #[test]
    fn empty_checkpoint_is_public_and_contains_no_payload_or_secrets() {
        let checkpoint = CheckpointEnvelope::empty("exec-1", 3, "chat_turn");

        assert_eq!(checkpoint.checkpoint_id, "exec-1:3");
        assert_eq!(checkpoint.execution_id, "exec-1");
        assert_eq!(checkpoint.revision, 3);
        assert_eq!(checkpoint.producer_kind, "chat_turn");
        assert_eq!(checkpoint.schema_version, 1);
        assert_eq!(checkpoint.sensitivity, PayloadSensitivity::Public);
        assert_eq!(checkpoint.payload, json!({}));
        assert_eq!(checkpoint.redacted_payload, json!({}));
        assert!(checkpoint.secret_refs.is_empty());
    }
}
