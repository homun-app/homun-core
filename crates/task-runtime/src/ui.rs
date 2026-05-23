use crate::{
    ApprovalRequest, ResourceClass, TaskId, TaskPriority, TaskRuntimeResult, TaskStatus, TaskStore,
    UserId, WorkspaceId,
};
use serde_json::Value;
use std::collections::HashMap;

pub struct TaskUiReadModel<'a> {
    store: &'a TaskStore,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskUiItem {
    pub task_id: TaskId,
    pub kind: String,
    pub goal: String,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskQueueSnapshot {
    pub queued: Vec<TaskUiItem>,
    pub active: Vec<TaskUiItem>,
    pub blocked: Vec<TaskUiItem>,
    pub waiting_approvals: Vec<ApprovalRequest>,
    pub recent_failures: Vec<TaskUiItem>,
    pub resource_usage: HashMap<ResourceClass, u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TaskUiDetail {
    pub task_id: TaskId,
    pub kind: String,
    pub goal: String,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    pub blocked_reason: Option<String>,
    pub latest_checkpoint: Option<Value>,
    pub exposes_raw_input: bool,
}

impl<'a> TaskUiReadModel<'a> {
    pub fn new(store: &'a TaskStore) -> Self {
        Self { store }
    }

    pub fn queue_snapshot(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<TaskQueueSnapshot> {
        let tasks = self.store.list_tasks(user_id, workspace_id)?;
        let mut queued = Vec::new();
        let mut active = Vec::new();
        let mut blocked = Vec::new();
        let mut waiting_approvals = Vec::new();
        let mut recent_failures = Vec::new();

        for task in tasks {
            match task.status {
                TaskStatus::Queued | TaskStatus::Pending => {
                    queued.push(TaskUiItem::from_task(&task))
                }
                TaskStatus::Running => active.push(TaskUiItem::from_task(&task)),
                TaskStatus::WaitingResource
                | TaskStatus::WaitingTime
                | TaskStatus::WaitingExternalEvent => blocked.push(TaskUiItem::from_task(&task)),
                TaskStatus::WaitingUserApproval => {
                    if let Some(approval) =
                        self.store
                            .latest_approval(&task.task_id, user_id, workspace_id)?
                    {
                        waiting_approvals.push(approval);
                    }
                }
                TaskStatus::Failed => recent_failures.push(TaskUiItem::from_task(&task)),
                TaskStatus::Paused
                | TaskStatus::Completed
                | TaskStatus::Cancelled
                | TaskStatus::Expired => {}
            }
        }

        Ok(TaskQueueSnapshot {
            queued,
            active,
            blocked,
            waiting_approvals,
            recent_failures,
            resource_usage: self.resource_usage(user_id, workspace_id)?,
        })
    }

    pub fn task_detail(
        &self,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<Option<TaskUiDetail>> {
        let Some(task) = self.store.get_task(task_id, user_id, workspace_id)? else {
            return Ok(None);
        };
        let latest_checkpoint = self
            .store
            .latest_checkpoint(task_id, user_id, workspace_id)?
            .map(|checkpoint| checkpoint.redacted_payload);
        Ok(Some(TaskUiDetail {
            task_id: task.task_id,
            kind: task.kind,
            goal: task.goal,
            status: task.status,
            priority: task.priority,
            blocked_reason: task.blocked_reason,
            latest_checkpoint,
            exposes_raw_input: false,
        }))
    }

    fn resource_usage(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> TaskRuntimeResult<HashMap<ResourceClass, u32>> {
        let mut usage = HashMap::new();
        for class in all_resource_classes() {
            let units = self.store.resource_usage(user_id, workspace_id, class)?;
            if units > 0 {
                usage.insert(class, units);
            }
        }
        Ok(usage)
    }
}

impl TaskUiItem {
    fn from_task(task: &crate::TaskRecord) -> Self {
        Self {
            task_id: task.task_id.clone(),
            kind: task.kind.clone(),
            goal: task.goal.clone(),
            status: task.status,
            priority: task.priority,
            blocked_reason: task.blocked_reason.clone(),
        }
    }
}

fn all_resource_classes() -> [ResourceClass; 9] {
    [
        ResourceClass::LlmInference,
        ResourceClass::BrowserSession,
        ResourceClass::NetworkIo,
        ResourceClass::FilesystemIo,
        ResourceClass::ConnectorApi,
        ResourceClass::MemoryIndexing,
        ResourceClass::GraphIndexing,
        ResourceClass::UserWait,
        ResourceClass::BackgroundMaintenance,
    ]
}
