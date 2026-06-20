//! Durable local-first task runtime.

pub mod approval;
pub mod checkpoint;
pub mod error;
pub mod executor;
pub mod facade;
pub mod lease;
pub mod plan_context;
pub mod recurrence;
pub mod resources;
pub mod scheduler;
pub mod store;
pub mod types;
pub mod ui;

pub use approval::{ApprovalGate, ApprovalRequest, ApprovalStatus};
pub use checkpoint::{RetryController, TaskCheckpoint};
pub use error::{TaskRuntimeError, TaskRuntimeResult};
pub use executor::{ExecutorResult, FakeTaskExecutor, TaskExecutor};
pub use facade::{RunReadySummary, TaskRuntime};
pub use lease::LeaseManager;
pub use plan_context::TaskDependencyOutput;
pub use recurrence::next_occurrence;
pub use resources::{ResourceGovernor, ResourceLimits};
pub use scheduler::TaskScheduler;
pub use store::TaskStore;
pub use types::{
    ApprovalPolicy, Automation, AutomationRun, AutomationSource, AutomationTrigger, EventTrigger,
    ResourceClass, ResourceRequirement, RetryPolicy, TaskId, TaskPriority, TaskRecord, TaskStatus,
    UserId, WorkflowId, WorkspaceId,
};
pub use ui::{TaskQueueSnapshot, TaskUiDetail, TaskUiItem, TaskUiReadModel};
