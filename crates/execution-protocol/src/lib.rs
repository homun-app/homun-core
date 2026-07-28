//! Canonical, dependency-light execution persistence protocol.

#![deny(missing_docs)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Current durable JSON schema version accepted by [`ExecutionContract::validate`].
pub const PROTOCOL_SCHEMA_VERSION: u32 = 1;

/// Mutable execution DTO for adapter construction and wire decoding.
///
/// `Serialize` and `Deserialize` do not make this DTO persistable. Convert it to
/// [`ValidatedExecutionContract`] before passing it to any persistence API.
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
            delivery.condition.validate_references()?;
            let expected = delivery.condition.dedup_key();
            if delivery.dedup_key != expected {
                return Err(ProtocolValidationError::WakeDedupKeyMismatch {
                    expected,
                    actual: delivery.dedup_key.clone(),
                });
            }
        }

        Ok(())
    }
}

/// Execution contract proven safe for use as a persistence input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedExecutionContract(ExecutionContract);

impl ValidatedExecutionContract {
    /// Consumes the wrapper and returns the raw DTO.
    pub fn into_inner(self) -> ExecutionContract {
        self.0
    }
}

impl AsRef<ExecutionContract> for ValidatedExecutionContract {
    fn as_ref(&self) -> &ExecutionContract {
        &self.0
    }
}

impl TryFrom<ExecutionContract> for ValidatedExecutionContract {
    type Error = ProtocolValidationError;

    fn try_from(contract: ExecutionContract) -> Result<Self, Self::Error> {
        contract.validate()?;
        Ok(Self(contract))
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

/// Mutable outcome DTO returned by adapters and decoded from the wire.
///
/// `Serialize` and `Deserialize` do not make this DTO persistable. Convert it to
/// [`ValidatedExecutionOutcome`] against its validated contract first.
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

/// Execution outcome proven consistent with a validated contract.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedExecutionOutcome(ExecutionOutcome);

impl ValidatedExecutionOutcome {
    /// Validates an outcome against its contract before persistence.
    pub fn new(
        outcome: ExecutionOutcome,
        contract: &ValidatedExecutionContract,
    ) -> Result<Self, ProtocolValidationError> {
        validate_outcome(&outcome, contract.as_ref())?;
        Ok(Self(outcome))
    }

    /// Consumes the wrapper and returns the raw DTO.
    pub fn into_inner(self) -> ExecutionOutcome {
        self.0
    }
}

impl AsRef<ExecutionOutcome> for ValidatedExecutionOutcome {
    fn as_ref(&self) -> &ExecutionOutcome {
        &self.0
    }
}

fn validate_outcome(
    outcome: &ExecutionOutcome,
    contract: &ExecutionContract,
) -> Result<(), ProtocolValidationError> {
    match outcome {
        ExecutionOutcome::Completed {
            continuation: Some(continuation),
            ..
        } if is_blank(&continuation.execution_id) => {
            Err(ProtocolValidationError::EmptyContinuationExecutionId)
        }
        ExecutionOutcome::Completed { .. } | ExecutionOutcome::Cancelled { .. } => Ok(()),
        ExecutionOutcome::Suspended { wake, checkpoint } => {
            wake.validate_references()?;
            if checkpoint.execution_id != contract.execution_id {
                return Err(ProtocolValidationError::CheckpointExecutionIdMismatch);
            }
            if checkpoint.revision != contract.revision {
                return Err(ProtocolValidationError::CheckpointRevisionMismatch);
            }
            if checkpoint.producer_kind != contract.kind {
                return Err(ProtocolValidationError::CheckpointProducerKindMismatch);
            }
            if is_blank(&checkpoint.checkpoint_id) {
                return Err(ProtocolValidationError::EmptyScopedReference {
                    field: "checkpoint.checkpoint_id",
                });
            }
            if checkpoint.schema_version != PROTOCOL_SCHEMA_VERSION {
                return Err(
                    ProtocolValidationError::UnsupportedCheckpointSchemaVersion {
                        actual: checkpoint.schema_version,
                    },
                );
            }
            checkpoint.data_ref.validate().map_err(|reason| {
                ProtocolValidationError::InvalidCheckpointDataReference { reason }
            })?;
            Ok(())
        }
        ExecutionOutcome::Failed { failure } if is_blank(&failure.code) => {
            Err(ProtocolValidationError::EmptyFailureCode)
        }
        ExecutionOutcome::Failed { .. } => Ok(()),
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
    /// Typed wake condition this delivery satisfies.
    pub condition: WakeCondition,
    /// Nonempty canonical deduplication key for the delivered condition.
    pub dedup_key: String,
    /// Adapter-neutral delivery payload.
    pub payload: Value,
    /// UTC Unix delivery timestamp in seconds.
    pub delivered_at_unix_seconds: i64,
}

/// Durable checkpoint metadata containing only a checked external data reference.
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
    /// Reference to checkpoint data stored outside the canonical journal.
    pub data_ref: CheckpointDataRef,
}

impl CheckpointEnvelope {
    /// Builds an empty public schema-v1 checkpoint for an execution revision.
    pub fn empty(
        execution_id: impl Into<String>,
        revision: u64,
        producer_kind: impl Into<String>,
    ) -> Self {
        let execution_id = execution_id.into();
        let checkpoint_id = format!("{execution_id}:{revision}");
        let record_ref = DurableDataRef::new(format!("{checkpoint_id}:empty"))
            .expect("execution identifiers used by an empty checkpoint are nonempty");
        Self {
            checkpoint_id,
            execution_id,
            revision,
            producer_kind: producer_kind.into(),
            schema_version: PROTOCOL_SCHEMA_VERSION,
            data_ref: CheckpointDataRef::Public { record_ref },
        }
    }
}

/// Reference-only checkpoint representation persisted in the canonical journal.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum CheckpointDataRef {
    /// Public checkpoint bytes stored in a durable data record.
    Public {
        /// Checked durable record reference.
        record_ref: DurableDataRef,
    },
    /// Redacted checkpoint bytes stored in a durable data record.
    Redacted {
        /// Checked durable record reference.
        record_ref: DurableDataRef,
    },
    /// Encrypted checkpoint bytes stored in a secret record.
    Encrypted {
        /// Checked encrypted secret reference.
        secret_ref: SecretRef,
    },
}

impl CheckpointDataRef {
    fn validate(&self) -> Result<(), ReferenceValidationError> {
        match self {
            Self::Public { record_ref } | Self::Redacted { record_ref } => {
                DurableDataRef::parse(record_ref.as_ref()).map(|_| ())
            }
            Self::Encrypted { secret_ref } => SecretRef::parse(secret_ref.as_ref()).map(|_| ()),
        }
    }
}

/// Checked reference to non-secret checkpoint bytes in durable storage.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct DurableDataRef(String);

impl DurableDataRef {
    /// Builds a `durable:v1` reference from a nonempty scoped identifier.
    pub fn new(identifier: impl Into<String>) -> Result<Self, ReferenceValidationError> {
        let identifier = identifier.into();
        checked_reference("durable:v1:", identifier).map(Self)
    }

    /// Parses and validates an encoded `durable:v1` reference.
    pub fn parse(encoded: impl Into<String>) -> Result<Self, ReferenceValidationError> {
        let encoded = encoded.into();
        validate_encoded_reference("durable:v1:", &encoded)?;
        Ok(Self(encoded))
    }

    /// Consumes the wrapper and returns the stable encoded reference.
    pub fn into_inner(self) -> String {
        self.0
    }
}

impl AsRef<str> for DurableDataRef {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::str::FromStr for DurableDataRef {
    type Err = ReferenceValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl Serialize for DurableDataRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_ref())
    }
}

impl<'de> Deserialize<'de> for DurableDataRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::parse(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// Checked reference to encrypted checkpoint bytes in secret storage.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct SecretRef(String);

impl SecretRef {
    /// Builds a `secret:v1` reference from a nonempty scoped identifier.
    pub fn new(identifier: impl Into<String>) -> Result<Self, ReferenceValidationError> {
        let identifier = identifier.into();
        checked_reference("secret:v1:", identifier).map(Self)
    }

    /// Parses and validates an encoded `secret:v1` reference.
    pub fn parse(encoded: impl Into<String>) -> Result<Self, ReferenceValidationError> {
        let encoded = encoded.into();
        validate_encoded_reference("secret:v1:", &encoded)?;
        Ok(Self(encoded))
    }

    /// Consumes the wrapper and returns the stable encoded reference.
    pub fn into_inner(self) -> String {
        self.0
    }
}

impl AsRef<str> for SecretRef {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::str::FromStr for SecretRef {
    type Err = ReferenceValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl Serialize for SecretRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_ref())
    }
}

impl<'de> Deserialize<'de> for SecretRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::parse(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

fn checked_reference(
    prefix: &'static str,
    identifier: String,
) -> Result<String, ReferenceValidationError> {
    if is_blank(&identifier) {
        return Err(ReferenceValidationError::EmptyIdentifier);
    }
    Ok(format!("{prefix}{}:{identifier}", identifier.len()))
}

fn validate_encoded_reference(
    prefix: &'static str,
    encoded: &str,
) -> Result<(), ReferenceValidationError> {
    let remainder = encoded
        .strip_prefix(prefix)
        .ok_or(ReferenceValidationError::InvalidPrefix { expected: prefix })?;
    let (length, identifier) = remainder
        .split_once(':')
        .ok_or(ReferenceValidationError::InvalidLength)?;
    let expected = length
        .parse::<usize>()
        .map_err(|_| ReferenceValidationError::InvalidLength)?;
    if is_blank(identifier) {
        return Err(ReferenceValidationError::EmptyIdentifier);
    }
    let actual = identifier.len();
    if expected != actual {
        return Err(ReferenceValidationError::LengthMismatch { expected, actual });
    }
    Ok(())
}

/// Reason a durable or secret data reference is malformed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReferenceValidationError {
    /// Scoped identifier is empty.
    EmptyIdentifier,
    /// Encoded reference does not use the required versioned prefix.
    InvalidPrefix {
        /// Required prefix.
        expected: &'static str,
    },
    /// Encoded reference has no valid decimal byte length.
    InvalidLength,
    /// Encoded byte length does not match the identifier.
    LengthMismatch {
        /// Length declared by the reference.
        expected: usize,
        /// Actual UTF-8 byte length.
        actual: usize,
    },
}

impl std::fmt::Display for ReferenceValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for ReferenceValidationError {}

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
    /// A completed outcome contains an empty continuation execution reference.
    EmptyContinuationExecutionId,
    /// A suspended checkpoint belongs to another execution.
    CheckpointExecutionIdMismatch,
    /// A suspended checkpoint belongs to another contract revision.
    CheckpointRevisionMismatch,
    /// A suspended checkpoint was produced by another execution kind.
    CheckpointProducerKindMismatch,
    /// A suspended checkpoint uses an unsupported schema version.
    UnsupportedCheckpointSchemaVersion {
        /// Unsupported checkpoint schema version.
        actual: u32,
    },
    /// A checkpoint data reference failed structural validation.
    InvalidCheckpointDataReference {
        /// Structural reference validation failure.
        reason: ReferenceValidationError,
    },
    /// A failed outcome contains no stable failure code.
    EmptyFailureCode,
}

impl std::fmt::Display for ProtocolValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for ProtocolValidationError {}
