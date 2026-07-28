//! Canonical, dependency-light execution persistence protocol.

#![deny(missing_docs)]

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Current durable JSON schema version accepted by [`ExecutionContract::validate`].
pub const PROTOCOL_SCHEMA_VERSION: u32 = 1;

/// Durable input and policy envelope for one execution.
///
/// Call [`ExecutionContract::validate`] immediately before every persistence write.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionContract {
    /// Durable wire schema version for this contract.
    pub schema_version: u32,
    /// Stable identity of this execution.
    pub execution_id: String,
    /// Optional parent execution identity for child work.
    pub parent_execution_id: Option<String>,
    /// Adapter-neutral execution kind.
    pub kind: String,
    /// Monotonic execution revision, starting at one.
    pub revision: u64,
    /// Monotonic lease generation used to fence stale workers, starting at one.
    pub fencing_token: u64,
    /// User, workspace, and optional thread ownership boundary.
    pub scope: ExecutionScope,
    /// Optional objective lineage reference.
    pub objective: Option<ObjectiveRef>,
    /// Adapter-owned input serialized as neutral JSON.
    pub input: Value,
    /// Effects and approvals permitted for this execution.
    pub policy: ExecutionPolicy,
    /// Resource capacity required before dispatch.
    pub resources: Vec<ResourceRequirement>,
    /// Retry and deadline limits enforced by the runtime.
    pub budget: ExecutionBudget,
    /// Optional durable checkpoint reference for resumption.
    pub checkpoint: Option<CheckpointRef>,
    /// Optional delivery that caused a suspended execution to resume.
    pub wake: Option<WakeDelivery>,
}

impl ExecutionContract {
    /// Builds a schema-v1, read-only, single-attempt contract at revision and fence one.
    pub fn new(
        execution_id: impl Into<String>,
        kind: impl Into<String>,
        scope: ExecutionScope,
        input: Value,
    ) -> Self {
        Self {
            schema_version: PROTOCOL_SCHEMA_VERSION,
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
                approval_policy: ApprovalPolicy::Deny,
            },
            resources: Vec::new(),
            budget: ExecutionBudget {
                max_attempts: 1,
                backoff_seconds: 0,
                deadline_unix_seconds: None,
            },
            checkpoint: None,
            wake: None,
        }
    }

    /// Rejects contracts that are unsafe or unsupported for durable persistence.
    pub fn validate(&self) -> Result<(), ProtocolValidationError> {
        if self.schema_version != PROTOCOL_SCHEMA_VERSION {
            return Err(ProtocolValidationError::UnsupportedSchemaVersion {
                actual: self.schema_version,
            });
        }
        if is_blank(&self.execution_id) {
            return Err(ProtocolValidationError::EmptyExecutionId);
        }
        if is_blank(&self.kind) {
            return Err(ProtocolValidationError::EmptyKind);
        }
        if is_blank(&self.scope.user_id) {
            return Err(ProtocolValidationError::EmptyUserId);
        }
        if is_blank(&self.scope.workspace_id) {
            return Err(ProtocolValidationError::EmptyWorkspaceId);
        }
        if self.revision == 0 {
            return Err(ProtocolValidationError::RevisionZero);
        }
        if self.fencing_token == 0 {
            return Err(ProtocolValidationError::FencingTokenZero);
        }
        if self.revision > i64::MAX as u64 {
            return Err(ProtocolValidationError::RevisionOutOfRange);
        }
        if self.fencing_token > i64::MAX as u64 {
            return Err(ProtocolValidationError::FencingTokenOutOfRange);
        }
        if self.budget.max_attempts == 0 {
            return Err(ProtocolValidationError::MaxAttemptsZero);
        }
        if self.budget.backoff_seconds < 0 {
            return Err(ProtocolValidationError::NegativeBackoff);
        }

        validate_optional_ref("parent_execution_id", self.parent_execution_id.as_deref())?;
        validate_optional_ref("scope.thread_id", self.scope.thread_id.as_deref())?;
        validate_optional_ref(
            "objective.thread_id",
            self.objective
                .as_ref()
                .map(|objective| objective.thread_id.as_str()),
        )?;
        validate_optional_ref(
            "checkpoint.checkpoint_id",
            self.checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.checkpoint_id.as_str()),
        )?;

        for (index, resource) in self.resources.iter().enumerate() {
            if is_blank(&resource.class) {
                return Err(ProtocolValidationError::EmptyResourceClass { index });
            }
            if resource.units == 0 {
                return Err(ProtocolValidationError::ResourceUnitsZero { index });
            }
        }

        if let Some(delivery) = &self.wake {
            if is_blank(&delivery.dedup_key) {
                return Err(ProtocolValidationError::EmptyWakeDedupKey);
            }
            if let Ok(condition) = serde_json::from_value::<WakeCondition>(delivery.payload.clone())
            {
                condition.validate_references()?;
                let expected = condition.dedup_key();
                if delivery.dedup_key != expected {
                    return Err(ProtocolValidationError::WakeDedupKeyMismatch {
                        expected,
                        actual: delivery.dedup_key.clone(),
                    });
                }
            }
        }

        Ok(())
    }
}

fn is_blank(value: &str) -> bool {
    value.trim().is_empty()
}

fn validate_optional_ref(
    field: &'static str,
    value: Option<&str>,
) -> Result<(), ProtocolValidationError> {
    if value.is_some_and(is_blank) {
        return Err(ProtocolValidationError::EmptyScopedReference { field });
    }
    Ok(())
}

/// Canonical result of an execution; these are the only lifecycle outcomes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutionOutcome {
    /// Execution reached a successful terminal state.
    Completed {
        /// Adapter-neutral result payload.
        output: Value,
        /// Optional linked execution that continues the work.
        continuation: Option<ContinuationRef>,
    },
    /// Execution durably paused until one wake condition is delivered.
    Suspended {
        /// Condition required to make the execution ready again.
        wake: WakeCondition,
        /// Safe persisted state required to resume.
        checkpoint: CheckpointEnvelope,
    },
    /// Execution was intentionally terminated without failure.
    Cancelled {
        /// Typed cancellation source.
        reason: CancelReason,
    },
    /// Execution reached a terminal failure.
    Failed {
        /// Redacted, classifiable failure details.
        failure: ExecutionFailure,
    },
}

impl ExecutionOutcome {
    /// Builds a completed outcome without a continuation.
    pub fn completed(output: Value) -> Self {
        Self::Completed {
            output,
            continuation: None,
        }
    }
}

/// Typed reason a suspended execution may become ready.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WakeCondition {
    /// Resume at or after a Unix timestamp in seconds.
    At {
        /// UTC Unix timestamp in seconds.
        unix_seconds: i64,
    },
    /// Resume when a correlated external signal arrives.
    Signal {
        /// Stable signal kind.
        kind: String,
        /// Producer correlation identity.
        correlation_id: String,
    },
    /// Resume when capacity in a resource class is available.
    Resource {
        /// Neutral resource class identifier.
        class: String,
    },
    /// Resume when a model role becomes available.
    ModelAvailable {
        /// Logical model role.
        role: String,
    },
    /// Resume when a user wait is resolved.
    User {
        /// Opaque scoped wait reference.
        wait_ref: String,
    },
    /// Resume when an approval is resolved.
    Approval {
        /// Opaque scoped approval reference.
        approval_ref: String,
    },
    /// Resume when an uncertain effect receives a durable resolution.
    EffectResolution {
        /// Opaque scoped effect receipt reference.
        receipt_ref: String,
    },
}

impl WakeCondition {
    /// Returns an injective v1 key with UTF-8 byte-length-prefixed string components.
    pub fn dedup_key(&self) -> String {
        match self {
            Self::At { unix_seconds } => format!("v1:at:{unix_seconds}"),
            Self::Signal {
                kind,
                correlation_id,
            } => format!(
                "v1:signal:{}:{}",
                length_prefixed(kind),
                length_prefixed(correlation_id)
            ),
            Self::Resource { class } => format!("v1:resource:{}", length_prefixed(class)),
            Self::ModelAvailable { role } => {
                format!("v1:model_available:{}", length_prefixed(role))
            }
            Self::User { wait_ref } => format!("v1:user:{}", length_prefixed(wait_ref)),
            Self::Approval { approval_ref } => {
                format!("v1:approval:{}", length_prefixed(approval_ref))
            }
            Self::EffectResolution { receipt_ref } => {
                format!("v1:effect_resolution:{}", length_prefixed(receipt_ref))
            }
        }
    }

    fn validate_references(&self) -> Result<(), ProtocolValidationError> {
        let field = match self {
            Self::At { .. } => None,
            Self::Signal {
                kind,
                correlation_id,
            } if is_blank(kind) => Some("wake.signal.kind"),
            Self::Signal { correlation_id, .. } if is_blank(correlation_id) => {
                Some("wake.signal.correlation_id")
            }
            Self::Signal { .. } => None,
            Self::Resource { class } if is_blank(class) => Some("wake.resource.class"),
            Self::Resource { .. } => None,
            Self::ModelAvailable { role } if is_blank(role) => Some("wake.model_available.role"),
            Self::ModelAvailable { .. } => None,
            Self::User { wait_ref } if is_blank(wait_ref) => Some("wake.user.wait_ref"),
            Self::User { .. } => None,
            Self::Approval { approval_ref } if is_blank(approval_ref) => {
                Some("wake.approval.approval_ref")
            }
            Self::Approval { .. } => None,
            Self::EffectResolution { receipt_ref } if is_blank(receipt_ref) => {
                Some("wake.effect_resolution.receipt_ref")
            }
            Self::EffectResolution { .. } => None,
        };
        if let Some(field) = field {
            return Err(ProtocolValidationError::EmptyScopedReference { field });
        }
        Ok(())
    }
}

fn length_prefixed(value: &str) -> String {
    format!("{}:{value}", value.len())
}

/// Redacted execution failure suitable for durable storage.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionFailure {
    /// Retry and policy classification.
    pub class: FailureClass,
    /// Stable machine-readable failure code.
    pub code: String,
    /// Human-readable detail with sensitive data removed.
    pub redacted_detail: String,
}

impl ExecutionFailure {
    /// Builds a retry-eligible failure.
    pub fn transient(code: impl Into<String>, redacted_detail: impl Into<String>) -> Self {
        Self::new(FailureClass::Transient, code, redacted_detail)
    }

    /// Builds a non-retryable failure.
    pub fn permanent(code: impl Into<String>, redacted_detail: impl Into<String>) -> Self {
        Self::new(FailureClass::Permanent, code, redacted_detail)
    }

    /// Builds a failure caused by execution policy.
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

/// Runtime treatment of an execution failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClass {
    /// The runtime may retry within the execution budget.
    Transient,
    /// Retrying cannot resolve the failure.
    Permanent,
    /// Policy explicitly denied the attempted operation.
    PolicyDenied,
}

/// Intentional cancellation source.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    /// The user cancelled the execution.
    User,
    /// A newer execution replaced this one.
    Replaced,
    /// The execution expired before completion.
    Expired,
    /// The runtime shut down the execution.
    Shutdown,
}

/// Durable lifecycle state projected from canonical outcomes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    /// Eligible for dispatch.
    Ready,
    /// Currently owned by a worker.
    Running,
    /// Waiting for a typed wake condition.
    Suspended,
    /// Successfully terminal.
    Completed,
    /// Intentionally terminal.
    Cancelled,
    /// Unsuccessfully terminal.
    Failed,
}

/// Ownership boundary used to scope every opaque reference.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionScope {
    /// Owning user identity.
    pub user_id: String,
    /// Owning workspace identity.
    pub workspace_id: String,
    /// Optional owning conversation thread.
    pub thread_id: Option<String>,
}

/// Reference to a revision of a thread objective.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ObjectiveRef {
    /// Scoped thread identity.
    pub thread_id: String,
    /// Objective revision.
    pub revision: u64,
}

/// Reference to externally persisted checkpoint state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CheckpointRef {
    /// Stable checkpoint identity.
    pub checkpoint_id: String,
    /// Producer-defined checkpoint schema version.
    pub schema_version: u32,
}

/// Reference to a linked execution that continues completed work.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContinuationRef {
    /// Linked execution identity.
    pub execution_id: String,
}

/// Closed execution policy persisted with the contract.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionPolicy {
    /// Effect classes the adapter may perform.
    pub allowed_effects: Vec<EffectClass>,
    /// Approval behavior applied to authorized effects.
    pub approval_policy: ApprovalPolicy,
}

/// Approval behavior for consequential effects.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    /// Deny effects that require approval.
    Deny,
    /// Ask for approval when an effect requests it.
    OnRequest,
    /// Permit effects covered by prior authorization.
    Preauthorized,
}

/// Neutral class of side effect governed by execution policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectClass {
    /// Read-only access.
    Read,
    /// Filesystem mutation.
    FilesystemWrite,
    /// Creation of a user-visible artifact.
    ArtifactCreation,
    /// Mutation of an external system.
    ExternalWrite,
    /// Request for authorization without performing the effect.
    RequestAuthorization,
}

/// Capacity required from one neutral resource class.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResourceRequirement {
    /// Neutral resource class identifier.
    pub class: String,
    /// Nonzero capacity units required.
    pub units: u32,
}

/// Retry and deadline limits enforced by the execution runtime.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecutionBudget {
    /// Nonzero maximum attempts, including the first attempt.
    pub max_attempts: u32,
    /// Nonnegative delay between attempts in seconds.
    pub backoff_seconds: i64,
    /// Optional UTC Unix deadline in seconds.
    pub deadline_unix_seconds: Option<i64>,
}

/// Durable input that caused a suspended execution to resume.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WakeDelivery {
    /// Nonempty canonical deduplication key for the delivered condition.
    pub dedup_key: String,
    /// Adapter-neutral delivery payload.
    pub payload: Value,
    /// UTC Unix delivery timestamp in seconds.
    pub delivered_at_unix_seconds: i64,
}

/// Durable checkpoint metadata containing exactly one secrecy-safe data mode.
///
/// Sensitive raw payloads must be encrypted in an external secret store before
/// constructing this envelope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CheckpointEnvelope {
    /// Stable checkpoint identity.
    pub checkpoint_id: String,
    /// Execution that owns this checkpoint.
    pub execution_id: String,
    /// Monotonic execution revision that produced the checkpoint.
    pub revision: u64,
    /// Neutral producer execution kind.
    pub producer_kind: String,
    /// Producer-defined checkpoint schema version.
    pub schema_version: u32,
    /// The sole persisted checkpoint data representation.
    pub data: PersistedCheckpointData,
}

impl CheckpointEnvelope {
    /// Builds an empty public schema-v1 checkpoint for an execution revision.
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
            data: PersistedCheckpointData::Public { value: json!({}) },
        }
    }
}

/// Secrecy-safe checkpoint representation persisted in the canonical envelope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum PersistedCheckpointData {
    /// Public data that may be stored as provided.
    Public {
        /// Public checkpoint value.
        value: Value,
    },
    /// Already-redacted data plus references to externally encrypted secrets.
    Redacted {
        /// Checkpoint value after all sensitive material has been removed.
        value: Value,
        /// Opaque references to encrypted secret material.
        secret_refs: Vec<String>,
    },
    /// Opaque references only, with no persisted checkpoint value.
    SecretRefsOnly {
        /// Opaque references to encrypted secret material.
        secret_refs: Vec<String>,
    },
}

/// Reason an execution contract cannot be persisted safely.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProtocolValidationError {
    /// Contract uses a schema version this crate does not support.
    UnsupportedSchemaVersion {
        /// Unsupported version found in the contract.
        actual: u32,
    },
    /// Execution identity is empty.
    EmptyExecutionId,
    /// Execution kind is empty.
    EmptyKind,
    /// Scope user identity is empty.
    EmptyUserId,
    /// Scope workspace identity is empty.
    EmptyWorkspaceId,
    /// Execution revision is zero.
    RevisionZero,
    /// Fencing token is zero.
    FencingTokenZero,
    /// Execution revision cannot be represented by the durable SQL integer.
    RevisionOutOfRange,
    /// Fencing token cannot be represented by the durable SQL integer.
    FencingTokenOutOfRange,
    /// Execution budget permits no attempts.
    MaxAttemptsZero,
    /// Execution budget has a negative retry delay.
    NegativeBackoff,
    /// A resource requirement has an empty class.
    EmptyResourceClass {
        /// Invalid resource index.
        index: usize,
    },
    /// A resource requirement requests zero units.
    ResourceUnitsZero {
        /// Invalid resource index.
        index: usize,
    },
    /// An optional scoped reference is present but empty.
    EmptyScopedReference {
        /// Stable field path identifying the reference.
        field: &'static str,
    },
    /// A wake delivery has an empty deduplication key.
    EmptyWakeDedupKey,
    /// A determinable wake condition does not match its delivery key.
    WakeDedupKeyMismatch {
        /// Canonical key derived from the condition.
        expected: String,
        /// Key supplied by the delivery.
        actual: String,
    },
}

impl std::fmt::Display for ProtocolValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for ProtocolValidationError {}

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

    fn valid_contract() -> ExecutionContract {
        ExecutionContract::new("exec-1", "chat_turn", scope(), json!({"prompt": "hello"}))
    }

    fn assert_invalid(contract: ExecutionContract, expected: ProtocolValidationError) {
        assert_eq!(contract.validate(), Err(expected));
    }

    fn assert_golden_round_trip<T>(value: &T, golden: &str)
    where
        T: serde::Serialize + serde::de::DeserializeOwned + std::fmt::Debug + Eq,
    {
        assert_eq!(serde_json::to_string(value).unwrap(), golden);
        let decoded = serde_json::from_str::<T>(golden).unwrap();
        assert_eq!(&decoded, value);
        assert_eq!(serde_json::to_string(&decoded).unwrap(), golden);
    }

    fn checkpoint_with(data: PersistedCheckpointData) -> CheckpointEnvelope {
        CheckpointEnvelope {
            checkpoint_id: "exec-1:1".into(),
            execution_id: "exec-1".into(),
            revision: 1,
            producer_kind: "chat_turn".into(),
            schema_version: 1,
            data,
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
    fn default_contract_v1_wire_format_is_stable() {
        let golden = r#"{"schema_version":1,"execution_id":"exec-1","parent_execution_id":null,"kind":"chat_turn","revision":1,"fencing_token":1,"scope":{"user_id":"user-1","workspace_id":"workspace-1","thread_id":"thread-1"},"objective":null,"input":{"prompt":"hello"},"policy":{"allowed_effects":["read"],"approval_policy":"deny"},"resources":[],"budget":{"max_attempts":1,"backoff_seconds":0,"deadline_unix_seconds":null},"checkpoint":null,"wake":null}"#;

        assert_golden_round_trip(&valid_contract(), golden);
    }

    #[test]
    fn execution_outcomes_v1_wire_format_is_stable() {
        let cases = [
            (
                ExecutionOutcome::completed(json!({"ok": true})),
                r#"{"type":"completed","output":{"ok":true},"continuation":null}"#,
            ),
            (
                ExecutionOutcome::Suspended {
                    wake: WakeCondition::Signal {
                        kind: "connector.message".into(),
                        correlation_id: "msg-1".into(),
                    },
                    checkpoint: CheckpointEnvelope::empty("exec-1", 1, "chat_turn"),
                },
                r#"{"type":"suspended","wake":{"type":"signal","kind":"connector.message","correlation_id":"msg-1"},"checkpoint":{"checkpoint_id":"exec-1:1","execution_id":"exec-1","revision":1,"producer_kind":"chat_turn","schema_version":1,"data":{"mode":"public","value":{}}}}"#,
            ),
            (
                ExecutionOutcome::Cancelled {
                    reason: CancelReason::User,
                },
                r#"{"type":"cancelled","reason":"user"}"#,
            ),
            (
                ExecutionOutcome::Failed {
                    failure: ExecutionFailure::permanent("no_reply", "No final reply"),
                },
                r#"{"type":"failed","failure":{"class":"permanent","code":"no_reply","redacted_detail":"No final reply"}}"#,
            ),
        ];

        for (outcome, golden) in cases {
            assert_golden_round_trip(&outcome, golden);
        }
    }

    #[test]
    fn wake_conditions_v1_wire_format_is_stable() {
        let cases = [
            (
                WakeCondition::At {
                    unix_seconds: 1_800_000_000,
                },
                r#"{"type":"at","unix_seconds":1800000000}"#,
            ),
            (
                WakeCondition::Signal {
                    kind: "connector.message".into(),
                    correlation_id: "msg-1".into(),
                },
                r#"{"type":"signal","kind":"connector.message","correlation_id":"msg-1"}"#,
            ),
            (
                WakeCondition::Resource {
                    class: "browser".into(),
                },
                r#"{"type":"resource","class":"browser"}"#,
            ),
            (
                WakeCondition::ModelAvailable {
                    role: "reasoning".into(),
                },
                r#"{"type":"model_available","role":"reasoning"}"#,
            ),
            (
                WakeCondition::User {
                    wait_ref: "wait-1".into(),
                },
                r#"{"type":"user","wait_ref":"wait-1"}"#,
            ),
            (
                WakeCondition::Approval {
                    approval_ref: "approval-1".into(),
                },
                r#"{"type":"approval","approval_ref":"approval-1"}"#,
            ),
            (
                WakeCondition::EffectResolution {
                    receipt_ref: "receipt-1".into(),
                },
                r#"{"type":"effect_resolution","receipt_ref":"receipt-1"}"#,
            ),
        ];

        for (wake, golden) in cases {
            assert_golden_round_trip(&wake, golden);
        }
    }

    #[test]
    fn checkpoint_data_modes_v1_wire_format_are_stable() {
        let cases = [
            (
                checkpoint_with(PersistedCheckpointData::Public {
                    value: json!({"cursor": 3}),
                }),
                r#"{"checkpoint_id":"exec-1:1","execution_id":"exec-1","revision":1,"producer_kind":"chat_turn","schema_version":1,"data":{"mode":"public","value":{"cursor":3}}}"#,
            ),
            (
                checkpoint_with(PersistedCheckpointData::Redacted {
                    value: json!({"token": "[redacted]"}),
                    secret_refs: vec!["secret-ref-1".into()],
                }),
                r#"{"checkpoint_id":"exec-1:1","execution_id":"exec-1","revision":1,"producer_kind":"chat_turn","schema_version":1,"data":{"mode":"redacted","value":{"token":"[redacted]"},"secret_refs":["secret-ref-1"]}}"#,
            ),
            (
                checkpoint_with(PersistedCheckpointData::SecretRefsOnly {
                    secret_refs: vec!["secret-ref-1".into()],
                }),
                r#"{"checkpoint_id":"exec-1:1","execution_id":"exec-1","revision":1,"producer_kind":"chat_turn","schema_version":1,"data":{"mode":"secret_refs_only","secret_refs":["secret-ref-1"]}}"#,
            ),
        ];

        for (checkpoint, golden) in cases {
            assert_golden_round_trip(&checkpoint, golden);
        }
    }

    #[test]
    fn wake_conditions_have_stable_dedup_keys() {
        let cases = [
            (
                WakeCondition::At {
                    unix_seconds: 1_800_000_000,
                },
                "v1:at:1800000000",
            ),
            (
                WakeCondition::Signal {
                    kind: "connector.message".into(),
                    correlation_id: "msg-1".into(),
                },
                "v1:signal:17:connector.message:5:msg-1",
            ),
            (
                WakeCondition::Resource {
                    class: "browser".into(),
                },
                "v1:resource:7:browser",
            ),
            (
                WakeCondition::ModelAvailable {
                    role: "reasoning".into(),
                },
                "v1:model_available:9:reasoning",
            ),
            (
                WakeCondition::User {
                    wait_ref: "wait-1".into(),
                },
                "v1:user:6:wait-1",
            ),
            (
                WakeCondition::Approval {
                    approval_ref: "approval-1".into(),
                },
                "v1:approval:10:approval-1",
            ),
            (
                WakeCondition::EffectResolution {
                    receipt_ref: "receipt-1".into(),
                },
                "v1:effect_resolution:9:receipt-1",
            ),
        ];

        for (wake, expected) in cases {
            assert_eq!(wake.dedup_key(), expected);
        }
    }

    #[test]
    fn signal_dedup_keys_do_not_collide_when_components_contain_delimiters() {
        let left = WakeCondition::Signal {
            kind: "a:b".into(),
            correlation_id: "c".into(),
        };
        let right = WakeCondition::Signal {
            kind: "a".into(),
            correlation_id: "b:c".into(),
        };

        assert_ne!(left.dedup_key(), right.dedup_key());
        assert_eq!(left.dedup_key(), "v1:signal:3:a:b:1:c");
        assert_eq!(right.dedup_key(), "v1:signal:1:a:3:b:c");
    }

    #[test]
    fn wake_dedup_keys_length_prefix_utf8_bytes() {
        let wake = WakeCondition::Signal {
            kind: "méssage".into(),
            correlation_id: "消息".into(),
        };

        assert_eq!(wake.dedup_key(), "v1:signal:8:méssage:6:消息");
    }

    #[test]
    fn contract_constructor_uses_conservative_defaults() {
        let contract = valid_contract();

        assert_eq!(contract.schema_version, PROTOCOL_SCHEMA_VERSION);
        assert_eq!(contract.execution_id, "exec-1");
        assert_eq!(contract.parent_execution_id, None);
        assert_eq!(contract.kind, "chat_turn");
        assert_eq!(contract.revision, 1);
        assert_eq!(contract.fencing_token, 1);
        assert_eq!(contract.objective, None);
        assert_eq!(contract.input, json!({"prompt": "hello"}));
        assert_eq!(contract.policy.allowed_effects, vec![EffectClass::Read]);
        assert_eq!(contract.policy.approval_policy, ApprovalPolicy::Deny);
        assert!(contract.resources.is_empty());
        assert_eq!(contract.budget.max_attempts, 1);
        assert_eq!(contract.budget.backoff_seconds, 0);
        assert_eq!(contract.budget.deadline_unix_seconds, None);
        assert_eq!(contract.checkpoint, None);
        assert_eq!(contract.wake, None);
        assert_eq!(contract.validate(), Ok(()));
    }

    #[test]
    fn validation_rejects_empty_required_identity_fields() {
        let mut contract = valid_contract();
        contract.execution_id = " ".into();
        assert_invalid(contract, ProtocolValidationError::EmptyExecutionId);

        let mut contract = valid_contract();
        contract.kind.clear();
        assert_invalid(contract, ProtocolValidationError::EmptyKind);

        let mut contract = valid_contract();
        contract.scope.user_id.clear();
        assert_invalid(contract, ProtocolValidationError::EmptyUserId);

        let mut contract = valid_contract();
        contract.scope.workspace_id = "  ".into();
        assert_invalid(contract, ProtocolValidationError::EmptyWorkspaceId);
    }

    #[test]
    fn validation_rejects_invalid_revision_fence_and_budget() {
        let mut contract = valid_contract();
        contract.revision = 0;
        assert_invalid(contract, ProtocolValidationError::RevisionZero);

        let mut contract = valid_contract();
        contract.fencing_token = 0;
        assert_invalid(contract, ProtocolValidationError::FencingTokenZero);

        let mut contract = valid_contract();
        contract.revision = i64::MAX as u64 + 1;
        assert_invalid(contract, ProtocolValidationError::RevisionOutOfRange);

        let mut contract = valid_contract();
        contract.fencing_token = i64::MAX as u64 + 1;
        assert_invalid(contract, ProtocolValidationError::FencingTokenOutOfRange);

        let mut contract = valid_contract();
        contract.budget.max_attempts = 0;
        assert_invalid(contract, ProtocolValidationError::MaxAttemptsZero);

        let mut contract = valid_contract();
        contract.budget.backoff_seconds = -1;
        assert_invalid(contract, ProtocolValidationError::NegativeBackoff);
    }

    #[test]
    fn validation_rejects_invalid_resources() {
        let mut contract = valid_contract();
        contract.resources.push(ResourceRequirement {
            class: " ".into(),
            units: 1,
        });
        assert_invalid(
            contract,
            ProtocolValidationError::EmptyResourceClass { index: 0 },
        );

        let mut contract = valid_contract();
        contract.resources.push(ResourceRequirement {
            class: "browser".into(),
            units: 0,
        });
        assert_invalid(
            contract,
            ProtocolValidationError::ResourceUnitsZero { index: 0 },
        );
    }

    #[test]
    fn validation_rejects_empty_scoped_references() {
        let mut contract = valid_contract();
        contract.parent_execution_id = Some("".into());
        assert_invalid(
            contract,
            ProtocolValidationError::EmptyScopedReference {
                field: "parent_execution_id",
            },
        );

        let mut contract = valid_contract();
        contract.scope.thread_id = Some(" ".into());
        assert_invalid(
            contract,
            ProtocolValidationError::EmptyScopedReference {
                field: "scope.thread_id",
            },
        );

        let mut contract = valid_contract();
        contract.objective = Some(ObjectiveRef {
            thread_id: "".into(),
            revision: 1,
        });
        assert_invalid(
            contract,
            ProtocolValidationError::EmptyScopedReference {
                field: "objective.thread_id",
            },
        );

        let mut contract = valid_contract();
        contract.checkpoint = Some(CheckpointRef {
            checkpoint_id: " ".into(),
            schema_version: 1,
        });
        assert_invalid(
            contract,
            ProtocolValidationError::EmptyScopedReference {
                field: "checkpoint.checkpoint_id",
            },
        );
    }

    #[test]
    fn validation_rejects_unsupported_schema_version() {
        let mut contract = valid_contract();
        contract.schema_version = PROTOCOL_SCHEMA_VERSION + 1;

        assert_invalid(
            contract,
            ProtocolValidationError::UnsupportedSchemaVersion {
                actual: PROTOCOL_SCHEMA_VERSION + 1,
            },
        );
    }

    #[test]
    fn validation_rejects_empty_or_mismatched_wake_delivery_keys() {
        let condition = WakeCondition::Signal {
            kind: "connector.message".into(),
            correlation_id: "msg-1".into(),
        };
        let mut contract = valid_contract();
        contract.wake = Some(WakeDelivery {
            dedup_key: " ".into(),
            payload: json!({"opaque": true}),
            delivered_at_unix_seconds: 1_800_000_000,
        });
        assert_invalid(contract, ProtocolValidationError::EmptyWakeDedupKey);

        let mut contract = valid_contract();
        contract.wake = Some(WakeDelivery {
            dedup_key: "v1:signal:5:wrong:3:key".into(),
            payload: serde_json::to_value(&condition).unwrap(),
            delivered_at_unix_seconds: 1_800_000_000,
        });
        assert_invalid(
            contract,
            ProtocolValidationError::WakeDedupKeyMismatch {
                expected: condition.dedup_key(),
                actual: "v1:signal:5:wrong:3:key".into(),
            },
        );
    }

    #[test]
    fn timestamp_fields_state_seconds_explicitly() {
        let budget = ExecutionBudget {
            max_attempts: 1,
            backoff_seconds: 0,
            deadline_unix_seconds: Some(1_800_000_000),
        };
        let wake = WakeCondition::At {
            unix_seconds: 1_800_000_001,
        };
        let delivery = WakeDelivery {
            dedup_key: wake.dedup_key(),
            payload: serde_json::to_value(&wake).unwrap(),
            delivered_at_unix_seconds: 1_800_000_002,
        };

        assert_eq!(budget.deadline_unix_seconds, Some(1_800_000_000));
        assert_eq!(delivery.delivered_at_unix_seconds, 1_800_000_002);
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
        assert_eq!(
            checkpoint.data,
            PersistedCheckpointData::Public { value: json!({}) }
        );
    }

    #[test]
    fn redacted_checkpoint_serialization_contains_no_raw_secret() {
        let checkpoint = checkpoint_with(PersistedCheckpointData::Redacted {
            value: json!({"token": "[redacted]"}),
            secret_refs: vec!["secret-ref-1".into()],
        });

        let encoded = serde_json::to_string(&checkpoint).unwrap();
        assert!(!encoded.contains("raw_secret"));
        assert!(!encoded.contains("secret-value-123"));
        assert!(encoded.contains("[redacted]"));
        assert!(encoded.contains("secret-ref-1"));
    }

    #[test]
    fn secret_refs_only_checkpoint_serialization_contains_no_raw_secret() {
        let checkpoint = checkpoint_with(PersistedCheckpointData::SecretRefsOnly {
            secret_refs: vec!["secret-ref-1".into()],
        });

        let encoded = serde_json::to_string(&checkpoint).unwrap();
        assert!(!encoded.contains("raw_secret"));
        assert!(!encoded.contains("secret-value-123"));
        assert!(encoded.contains("secret-ref-1"));
    }
}
