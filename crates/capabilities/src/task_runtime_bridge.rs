use crate::{
    CapabilityCall, CapabilityProviderKind, CapabilityTool, PolicyContext, UserId, WorkspaceId,
};
use local_first_task_runtime::{
    ResourceClass, ResourceRequirement, RetryPolicy, TaskRecord, TaskRuntimeResult, TaskStore,
    UserId as TaskUserId, WorkspaceId as TaskWorkspaceId,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityTaskPayload {
    pub context: PolicyContext,
    pub call: CapabilityCall,
}

pub struct CapabilityTaskRuntimeBridge {
    retry_policy: RetryPolicy,
}

impl CapabilityTaskRuntimeBridge {
    pub fn new() -> Self {
        Self {
            retry_policy: RetryPolicy {
                max_attempts: 2,
                backoff_seconds: 30,
            },
        }
    }

    pub fn enqueue_call(
        &self,
        store: &TaskStore,
        task_id: impl Into<String>,
        context: &PolicyContext,
        call: &CapabilityCall,
        tool: &CapabilityTool,
    ) -> TaskRuntimeResult<TaskRecord> {
        let payload = CapabilityTaskPayload {
            context: context.clone(),
            call: call.clone(),
        };
        let mut record = TaskRecord::new(
            task_id,
            task_user_id(&context.user_id),
            task_workspace_id(&context.workspace_id),
            format!(
                "capability.{}.{}",
                call.provider_id.as_str(),
                call.tool_name
            ),
            format!("Call capability tool {}", call.tool_name),
            serde_json::to_value(payload)?,
        )
        .with_resource(ResourceRequirement::new(
            self.resource_for_provider_kind(tool.provider_kind),
            1,
        ))
        .with_retry_policy(self.retry_policy.clone());
        record.permission_context = serde_json::to_value(context)?;
        record.risk_level = risk_level_for_tool(tool);
        store.insert_task(&record)?;
        Ok(record)
    }

    pub fn resource_for_provider_kind(&self, kind: CapabilityProviderKind) -> ResourceClass {
        match kind {
            CapabilityProviderKind::Native => ResourceClass::FilesystemIo,
            CapabilityProviderKind::Mcp | CapabilityProviderKind::Managed => {
                ResourceClass::ConnectorApi
            }
            CapabilityProviderKind::Browser => ResourceClass::BrowserSession,
            CapabilityProviderKind::Skill => ResourceClass::BackgroundMaintenance,
        }
    }
}

impl Default for CapabilityTaskRuntimeBridge {
    fn default() -> Self {
        Self::new()
    }
}

fn risk_level_for_tool(tool: &CapabilityTool) -> String {
    match tool.action {
        crate::ActionClass::Read => "low",
        crate::ActionClass::Draft => "low",
        crate::ActionClass::WriteWithConfirmation => "medium",
        crate::ActionClass::ApprovedAutomation => "high",
    }
    .to_string()
}

fn task_user_id(user_id: &UserId) -> TaskUserId {
    TaskUserId::new(user_id.as_str())
}

fn task_workspace_id(workspace_id: &WorkspaceId) -> TaskWorkspaceId {
    TaskWorkspaceId::new(workspace_id.as_str())
}
