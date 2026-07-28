use crate::{AgentRunStatus, TaskStatus};
use local_first_execution_protocol::{ExecutionOutcome, WakeCondition};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPublicEventKind {
    Suspended,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecutionProjection {
    pub task_status: TaskStatus,
    pub run_status: Option<AgentRunStatus>,
    pub terminal: bool,
    pub event_kind: ExecutionPublicEventKind,
}

impl ExecutionProjection {
    pub fn from_outcome(outcome: &ExecutionOutcome) -> Self {
        match outcome {
            ExecutionOutcome::Completed { .. } => Self {
                task_status: TaskStatus::Completed,
                run_status: Some(AgentRunStatus::Completed),
                terminal: true,
                event_kind: ExecutionPublicEventKind::Completed,
            },
            ExecutionOutcome::Suspended { wake, .. } => Self::from_wake(wake),
            ExecutionOutcome::Cancelled { .. } => Self {
                task_status: TaskStatus::Cancelled,
                run_status: Some(AgentRunStatus::Aborted),
                terminal: true,
                event_kind: ExecutionPublicEventKind::Cancelled,
            },
            ExecutionOutcome::Failed { .. } => Self {
                task_status: TaskStatus::Failed,
                run_status: Some(AgentRunStatus::Failed),
                terminal: true,
                event_kind: ExecutionPublicEventKind::Failed,
            },
        }
    }

    fn from_wake(wake: &WakeCondition) -> Self {
        let (task_status, run_status) = match wake {
            WakeCondition::At { .. } => (TaskStatus::WaitingTime, None),
            WakeCondition::Signal { .. } => (TaskStatus::WaitingExternalEvent, None),
            WakeCondition::Resource { .. } => (TaskStatus::WaitingResource, None),
            WakeCondition::ModelAvailable { .. } => {
                (TaskStatus::Parked, Some(AgentRunStatus::Aborted))
            }
            WakeCondition::User { .. } | WakeCondition::Approval { .. } => (
                TaskStatus::WaitingUserApproval,
                Some(AgentRunStatus::Completed),
            ),
            WakeCondition::EffectResolution { .. } => (TaskStatus::WaitingUserApproval, None),
        };
        Self {
            task_status,
            run_status,
            terminal: false,
            event_kind: ExecutionPublicEventKind::Suspended,
        }
    }
}
