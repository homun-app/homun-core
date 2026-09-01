//! Durable local-first task runtime.

pub mod approval;
pub mod broker;
pub mod checkpoint;
pub mod error;
pub mod execution_projection;
pub mod execution_store;
pub mod executor;
pub mod facade;
pub mod lease;
pub mod plan_context;
pub mod projection_outbox;
pub mod recurrence;
pub mod resources;
pub mod scheduler;
pub mod store;
pub mod turn_lifecycle;
pub mod turn_reducer;
pub mod types;
pub mod ui;

pub use approval::{ApprovalGate, ApprovalRequest, ApprovalStatus};
pub use broker::{
    ChatTurnInput, ChatTurnSource, EnqueueError, EnqueueTurnOutcome, EnqueuedTurn, TurnApproval,
    chat_turn_task_id,
};
pub use checkpoint::{RetryController, TaskCheckpoint};
pub use error::{TaskRuntimeError, TaskRuntimeResult};
pub use execution_projection::{ExecutionProjection, ExecutionPublicEventKind};
pub use execution_store::{
    ContinueAsNewCommit, CreateExecution, ExecutionEvent, ExecutionJournalEvent, ExecutionRecord,
    OutcomeCommit, PendingExecutionWake, StartExecutionRevision,
};
pub use executor::{ExecutorResult, FakeTaskExecutor, TaskExecutor};
pub use facade::{RunReadySummary, TaskRuntime};
pub use lease::{LeaseManager, LeaseOwnership};
pub use plan_context::TaskDependencyOutput;
pub use projection_outbox::{
    EffectReceiptResolutionCommit, ProjectionClaim, ProjectionErrorEvidence,
    ProjectionOutboxRecord, ProjectionStatus,
};
pub use recurrence::next_occurrence;
pub use resources::{ResourceGovernor, ResourceLimits};
pub use scheduler::TaskScheduler;
pub use store::TaskStore;
pub use turn_reducer::{
    KernelActivePlanProjection, KernelEffectProjection, KernelProjectionInput,
    KernelTurnProjection, REDUCED_TERMINAL_TURN_EVENT_KIND_SQL_LIST, ReducedTurnStatus,
    TurnContradiction, TurnStateSnapshot, reduce_kernel_projection, reduce_turn_events,
    reduced_terminal_status_matches_task_status, turn_event_kind_is_terminal,
};
pub use types::{
    ActiveTurnProjection, AgentCheckpoint, AgentRun, AgentRunEvent, AgentRunStatus, ApprovalPolicy,
    Automation, AutomationRun, AutomationSource, AutomationTrigger, BrowserCheckpointRecord,
    EffectReceiptClaim, EventTrigger, ExecutionEffectReceipt, KernelActivityRow,
    KernelApprovalView, KernelAttentionView, KernelBlockedCapabilityView, KernelBrowserView,
    KernelCapabilityRuntimeView, KernelPlanStepView, KernelPlanView, KernelThreadActions,
    KernelThreadProjection, KernelTurnView, KernelUncertainEffectView, NewAgentRun,
    NewBrowserCheckpoint, NewExecutionEffectReceipt, NewTurnSteering, ObjectiveContractRecord,
    ObjectiveMode, ResourceClass, ResourceRequirement, RetryPolicy, RuntimeDiagnosticGap,
    RuntimeIntegrityFinding, RuntimeIntegrityReport, RuntimeObservabilityReport,
    RuntimeObservabilitySummary, RuntimePlanRecord, SubagentInfo, TaskId, TaskPriority, TaskRecord,
    TaskStatus, TerminalWrite, ThreadAttention, TurnEvent, TurnEventKind, TurnSteeringRecord,
    TurnSteeringStatus, UserId, WorkflowId, WorkspaceId,
};
pub use ui::{TaskQueueSnapshot, TaskUiDetail, TaskUiItem, TaskUiReadModel};
