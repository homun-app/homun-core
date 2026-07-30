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
        if let Some(objective) = &self.objective {
            let Some(scope_thread_id) = self.scope.thread_id.as_ref() else {
                return Err(ProtocolValidationError::ObjectiveScopeThreadMissing);
            };
            if scope_thread_id != &objective.thread_id {
                return Err(ProtocolValidationError::ObjectiveScopeThreadMismatch {
                    scope_thread_id: scope_thread_id.clone(),
                    objective_thread_id: objective.thread_id.clone(),
                });
            }
            if objective.revision == 0 {
                return Err(ProtocolValidationError::ObjectiveRevisionZero);
            }
            if objective.revision > i64::MAX as u64 {
                return Err(ProtocolValidationError::ObjectiveRevisionOutOfRange);
            }
        }
        validate_optional_ref(
            "checkpoint.checkpoint_id",
            self.checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.checkpoint_id.as_str()),
        )?;
        if self
            .checkpoint
            .as_ref()
            .is_some_and(|checkpoint| checkpoint.producer_schema_version == 0)
        {
            return Err(ProtocolValidationError::CheckpointProducerSchemaVersionZero);
        }

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
    /// Returns the validated revision as a SQLite-compatible integer.
    pub fn revision_i64(&self) -> i64 {
        i64::try_from(self.0.revision).expect("validated revision must fit in i64")
    }

    /// Returns the validated fencing token as a SQLite-compatible integer.
    pub fn fencing_token_i64(&self) -> i64 {
        i64::try_from(self.0.fencing_token).expect("validated fencing token must fit in i64")
    }

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
#[expect(
    clippy::large_enum_variant,
    reason = "the canonical public protocol keeps its four outcomes inline; boxing only Suspended would churn every adapter boundary for a bounded 272-byte value"
)]
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
pub struct ValidatedExecutionOutcome {
    outcome: ExecutionOutcome,
    binding: ExecutionBinding,
}

impl ValidatedExecutionOutcome {
    /// Validates an outcome against its contract before persistence.
    pub fn new(
        outcome: ExecutionOutcome,
        contract: &ValidatedExecutionContract,
    ) -> Result<Self, ProtocolValidationError> {
        validate_outcome(&outcome, contract.as_ref())?;
        let contract = contract.as_ref();
        Ok(Self {
            outcome,
            binding: ExecutionBinding {
                execution_id: contract.execution_id.clone(),
                revision: contract.revision,
                kind: contract.kind.clone(),
                fencing_token: contract.fencing_token,
            },
        })
    }

    /// Returns immutable identity metadata captured during validation.
    pub fn binding(&self) -> &ExecutionBinding {
        &self.binding
    }

    /// Consumes the wrapper and returns the raw DTO.
    pub fn into_inner(self) -> ExecutionOutcome {
        self.outcome
    }
}

impl AsRef<ExecutionOutcome> for ValidatedExecutionOutcome {
    fn as_ref(&self) -> &ExecutionOutcome {
        &self.outcome
    }
}

/// Immutable contract identity attached to a validated outcome.
///
/// Persistence adapters compare these fields with the loaded execution row in
/// the same transaction before accepting the outcome.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionBinding {
    execution_id: String,
    revision: u64,
    kind: String,
    fencing_token: u64,
}

impl ExecutionBinding {
    /// Returns the bound execution identity.
    pub fn execution_id(&self) -> &str {
        &self.execution_id
    }

    /// Returns the bound execution revision.
    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Returns the bound revision as a SQLite-compatible integer.
    pub fn revision_i64(&self) -> i64 {
        i64::try_from(self.revision).expect("bound validated revision must fit in i64")
    }

    /// Returns the bound execution kind.
    pub fn kind(&self) -> &str {
        &self.kind
    }

    /// Returns the bound fencing token.
    pub fn fencing_token(&self) -> u64 {
        self.fencing_token
    }

    /// Returns the bound fencing token as a SQLite-compatible integer.
    pub fn fencing_token_i64(&self) -> i64 {
        i64::try_from(self.fencing_token).expect("bound validated fencing token must fit in i64")
    }

    /// Compares all bound identity fields with a loaded persistence row.
    pub fn matches_persisted(
        &self,
        execution_id: &str,
        revision: i64,
        kind: &str,
        fencing_token: i64,
    ) -> bool {
        self.execution_id == execution_id
            && self.revision_i64() == revision
            && self.kind == kind
            && self.fencing_token_i64() == fencing_token
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
            let expected_checkpoint_id =
                canonical_checkpoint_id(&checkpoint.execution_id, checkpoint.revision);
            if checkpoint.checkpoint_id != expected_checkpoint_id {
                return Err(ProtocolValidationError::CheckpointIdMismatch {
                    expected: expected_checkpoint_id,
                    actual: checkpoint.checkpoint_id.clone(),
                });
            }
            if checkpoint.protocol_schema_version != PROTOCOL_SCHEMA_VERSION {
                return Err(
                    ProtocolValidationError::UnsupportedCheckpointProtocolSchemaVersion {
                        actual: checkpoint.protocol_schema_version,
                    },
                );
            }
            if checkpoint.producer_schema_version == 0 {
                return Err(ProtocolValidationError::CheckpointProducerSchemaVersionZero);
            }
            checkpoint.data_ref.validate().map_err(|reason| {
                ProtocolValidationError::InvalidCheckpointDataReference { reason }
            })?;
            if checkpoint
                .objective
                .as_ref()
                .is_some_and(|objective| Some(objective) != contract.objective.as_ref())
            {
                return Err(ProtocolValidationError::CheckpointObjectiveMismatch);
            }
            if checkpoint
                .wake
                .as_ref()
                .is_some_and(|checkpoint_wake| checkpoint_wake != wake)
            {
                return Err(ProtocolValidationError::CheckpointWakeMismatch);
            }
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
        receipt_ref: EffectReceiptRef,
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
                format!(
                    "v1:effect_resolution:{}",
                    length_prefixed(receipt_ref.as_ref())
                )
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
    /// Nonzero producer codec schema version for the referenced checkpoint data.
    pub producer_schema_version: u32,
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

/// Durable state of one consequential effect attempt.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectReceiptStatus {
    /// The effect was authorized and durably recorded but not dispatched.
    Prepared,
    /// One worker claimed the effect and may have dispatched it.
    Started,
    /// The remote or local effect completed with a durable result.
    Completed,
    /// The effect definitely failed and did not complete successfully.
    Failed,
    /// The worker lost certainty after dispatch and automatic retry is forbidden.
    Uncertain,
    /// A completed effect was reversed by its registered compensation.
    Compensated,
}

impl EffectReceiptStatus {
    /// Returns the stable persisted status token.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Started => "started",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Uncertain => "uncertain",
            Self::Compensated => "compensated",
        }
    }
}

/// Durable verification result for an effect whose remote outcome was uncertain.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EffectReceiptResolution {
    /// Verification proved that the effect was applied.
    Applied {
        /// Durable adapter result recovered during verification.
        result: Value,
        /// Structured description of the effects that occurred.
        effects: Value,
    },
    /// Verification proved that the effect was not applied.
    NotApplied {
        /// Redacted structured reason the effect is known to be absent.
        error: Value,
    },
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

/// Mutable checkpoint DTO containing only a checked external data reference.
///
/// Serialization alone does not make an envelope persistable. It must be part
/// of an outcome accepted by [`ValidatedExecutionOutcome`].
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CheckpointEnvelope {
    /// Canonical protocol identity derived from execution identity and revision.
    checkpoint_id: String,
    /// Execution that owns this checkpoint.
    pub execution_id: String,
    /// Monotonic execution revision that produced the checkpoint.
    pub revision: u64,
    /// Neutral producer execution kind.
    pub producer_kind: String,
    /// Protocol-owned envelope schema version, validated by this crate.
    pub protocol_schema_version: u32,
    /// Nonzero producer-owned codec schema version, evolved independently.
    pub producer_schema_version: u32,
    /// Reference to checkpoint data stored outside the canonical journal.
    pub data_ref: CheckpointDataRef,
    /// Objective lineage captured when the checkpoint was produced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<ObjectiveRef>,
    /// Exact condition that must be satisfied before this checkpoint resumes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake: Option<WakeCondition>,
    /// Consequential effects already associated with this execution revision.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effect_receipts: Vec<EffectReceiptRef>,
}

impl CheckpointEnvelope {
    /// Builds a protocol-v1 checkpoint with a canonical, length-prefixed identity.
    pub fn new(
        execution_id: impl Into<String>,
        revision: u64,
        producer_kind: impl Into<String>,
        producer_schema_version: u32,
        data_ref: CheckpointDataRef,
    ) -> Self {
        let execution_id = execution_id.into();
        let checkpoint_id = canonical_checkpoint_id(&execution_id, revision);
        Self {
            checkpoint_id,
            execution_id,
            revision,
            producer_kind: producer_kind.into(),
            protocol_schema_version: PROTOCOL_SCHEMA_VERSION,
            producer_schema_version,
            data_ref,
            objective: None,
            wake: None,
            effect_receipts: Vec::new(),
        }
    }

    /// Attaches the durable lineage and effect context required for a new resume.
    pub fn with_resume_context(
        mut self,
        objective: Option<ObjectiveRef>,
        wake: WakeCondition,
        effect_receipts: Vec<EffectReceiptRef>,
    ) -> Self {
        self.objective = objective;
        self.wake = Some(wake);
        self.effect_receipts = effect_receipts;
        self
    }

    /// Returns the canonical checkpoint identity derived from execution and revision.
    pub fn checkpoint_id(&self) -> &str {
        &self.checkpoint_id
    }
}

fn canonical_checkpoint_id(execution_id: &str, revision: u64) -> String {
    format!(
        "v1:checkpoint:{}:{execution_id}:{revision}",
        execution_id.len()
    )
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
    /// Builds a `durable:v1` reference from a store-issued canonical identifier.
    pub fn from_store_id(store_id: impl AsRef<str>) -> Result<Self, ReferenceValidationError> {
        checked_reference("durable:v1:", store_id.as_ref()).map(Self)
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

/// Checked reference to one durable effect receipt.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct EffectReceiptRef(String);

impl EffectReceiptRef {
    /// Builds an `effect:v1` reference from a store-issued identifier.
    pub fn from_store_id(store_id: impl AsRef<str>) -> Result<Self, ReferenceValidationError> {
        checked_reference("effect:v1:", store_id.as_ref()).map(Self)
    }

    /// Parses and validates an encoded `effect:v1` reference.
    pub fn parse(encoded: impl Into<String>) -> Result<Self, ReferenceValidationError> {
        let encoded = encoded.into();
        validate_encoded_reference("effect:v1:", &encoded)?;
        Ok(Self(encoded))
    }

    /// Consumes the wrapper and returns the encoded reference.
    pub fn into_inner(self) -> String {
        self.0
    }
}

impl AsRef<str> for EffectReceiptRef {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::str::FromStr for EffectReceiptRef {
    type Err = ReferenceValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl Serialize for EffectReceiptRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_ref())
    }
}

impl<'de> Deserialize<'de> for EffectReceiptRef {
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
    /// Builds a `secret:v1` reference from a store-issued canonical identifier.
    pub fn from_store_id(store_id: impl AsRef<str>) -> Result<Self, ReferenceValidationError> {
        checked_reference("secret:v1:", store_id.as_ref()).map(Self)
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
    store_id: &str,
) -> Result<String, ReferenceValidationError> {
    validate_store_id(store_id)?;
    Ok(format!("{prefix}32:{store_id}"))
}

fn validate_encoded_reference(
    prefix: &'static str,
    encoded: &str,
) -> Result<(), ReferenceValidationError> {
    let remainder = encoded
        .strip_prefix(prefix)
        .ok_or(ReferenceValidationError::InvalidPrefix { expected: prefix })?;
    let store_id = remainder
        .strip_prefix("32:")
        .ok_or(ReferenceValidationError::NonCanonicalEncoding)?;
    validate_store_id(store_id)
}

fn validate_store_id(store_id: &str) -> Result<(), ReferenceValidationError> {
    if store_id.len() != 32 {
        return Err(ReferenceValidationError::InvalidStoreIdLength {
            actual: store_id.len(),
        });
    }
    if !store_id
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ReferenceValidationError::InvalidStoreIdCharacter);
    }
    Ok(())
}

/// Reason a durable or secret data reference is malformed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReferenceValidationError {
    /// Encoded reference does not use the required versioned prefix.
    InvalidPrefix {
        /// Required prefix.
        expected: &'static str,
    },
    /// Store ID is not exactly 32 UTF-8 bytes.
    InvalidStoreIdLength {
        /// Actual input byte length.
        actual: usize,
    },
    /// Store ID contains uppercase, whitespace, control, or non-hex characters.
    InvalidStoreIdCharacter,
    /// Encoded reference is a noncanonical alias of the v1 wire form.
    NonCanonicalEncoding,
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
    /// Objective revision is zero.
    ObjectiveRevisionZero,
    /// Objective revision cannot be represented by the durable SQL integer.
    ObjectiveRevisionOutOfRange,
    /// An objective exists without a thread in the execution scope.
    ObjectiveScopeThreadMissing,
    /// An objective belongs to a different thread than the execution scope.
    ObjectiveScopeThreadMismatch {
        /// Thread identity carried by the execution scope.
        scope_thread_id: String,
        /// Thread identity carried by the objective reference.
        objective_thread_id: String,
    },
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
    /// A checkpoint identity is not canonical for its execution and revision.
    CheckpointIdMismatch {
        /// Canonical identity derived by the protocol.
        expected: String,
        /// Identity decoded from the raw checkpoint DTO.
        actual: String,
    },
    /// A suspended checkpoint uses an unsupported protocol envelope schema version.
    UnsupportedCheckpointProtocolSchemaVersion {
        /// Unsupported protocol envelope schema version.
        actual: u32,
    },
    /// A checkpoint producer codec schema version is zero.
    CheckpointProducerSchemaVersionZero,
    /// A checkpoint data reference failed structural validation.
    InvalidCheckpointDataReference {
        /// Structural reference validation failure.
        reason: ReferenceValidationError,
    },
    /// A checkpoint captures a different objective lineage than its contract.
    CheckpointObjectiveMismatch,
    /// A checkpoint captures a different wake condition than its suspended outcome.
    CheckpointWakeMismatch,
    /// A failed outcome contains no stable failure code.
    EmptyFailureCode,
}

impl std::fmt::Display for ProtocolValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for ProtocolValidationError {}
