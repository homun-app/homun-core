use crate::{
    TaskId, TaskRuntimeError, TaskRuntimeResult, TaskStatus, TaskStore, UserId, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub task_id: TaskId,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub action: String,
    pub risk_level: String,
    pub data_boundary: String,
    pub explanation: String,
    pub status: ApprovalStatus,
    pub approver_id: Option<String>,
    pub rejection_reason: Option<String>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

impl ApprovalRequest {
    pub fn new(
        approval_id: impl Into<String>,
        task_id: TaskId,
        user_id: UserId,
        workspace_id: WorkspaceId,
        action: impl Into<String>,
        risk_level: impl Into<String>,
        data_boundary: impl Into<String>,
        explanation: impl Into<String>,
    ) -> Self {
        let now = OffsetDateTime::now_utc();
        Self {
            approval_id: approval_id.into(),
            task_id,
            user_id,
            workspace_id,
            action: action.into(),
            risk_level: risk_level.into(),
            data_boundary: data_boundary.into(),
            explanation: explanation.into(),
            status: ApprovalStatus::Pending,
            approver_id: None,
            rejection_reason: None,
            created_at: now,
            updated_at: now,
        }
    }
}

pub struct ApprovalGate;

impl ApprovalGate {
    pub fn new() -> Self {
        Self
    }

    #[allow(clippy::too_many_arguments)]
    pub fn request_approval(
        &self,
        store: &TaskStore,
        task_id: &TaskId,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        action: &str,
        risk_level: &str,
        data_boundary: &str,
        explanation: &str,
    ) -> TaskRuntimeResult<ApprovalRequest> {
        let approval = ApprovalRequest::new(
            uuid::Uuid::new_v4().to_string(),
            task_id.clone(),
            user_id.clone(),
            workspace_id.clone(),
            action,
            risk_level,
            data_boundary,
            explanation,
        );
        store.insert_approval(&approval)?;
        let reason = format!("approval required: {action}");
        store.update_task_status(
            task_id,
            user_id,
            workspace_id,
            TaskStatus::WaitingUserApproval,
            Some(&reason),
        )?;
        Ok(approval)
    }

    pub fn approve(
        &self,
        store: &TaskStore,
        approval_id: &str,
        approver_id: &str,
    ) -> TaskRuntimeResult<()> {
        let mut approval = store
            .approval_by_id(approval_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound(approval_id.to_string()))?;
        approval.status = ApprovalStatus::Approved;
        approval.approver_id = Some(approver_id.to_string());
        approval.updated_at = OffsetDateTime::now_utc();
        store.insert_approval(&approval)?;
        store.update_task_status(
            &approval.task_id,
            &approval.user_id,
            &approval.workspace_id,
            TaskStatus::Queued,
            None,
        )
    }

    pub fn reject(
        &self,
        store: &TaskStore,
        approval_id: &str,
        approver_id: &str,
        reason: &str,
    ) -> TaskRuntimeResult<()> {
        let mut approval = store
            .approval_by_id(approval_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound(approval_id.to_string()))?;
        approval.status = ApprovalStatus::Rejected;
        approval.approver_id = Some(approver_id.to_string());
        approval.rejection_reason = Some(reason.to_string());
        approval.updated_at = OffsetDateTime::now_utc();
        store.insert_approval(&approval)?;
        let blocked_reason = format!("approval rejected: {reason}");
        store.update_task_status(
            &approval.task_id,
            &approval.user_id,
            &approval.workspace_id,
            TaskStatus::Cancelled,
            Some(&blocked_reason),
        )
    }
}

impl Default for ApprovalGate {
    fn default() -> Self {
        Self::new()
    }
}
