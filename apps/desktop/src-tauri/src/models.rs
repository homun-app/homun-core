use local_first_capabilities::{CachedCapabilityTool, CapabilityConnectionConfig};
use local_first_process_manager::{ProcessDetail, ProcessSnapshot};
use local_first_task_runtime::{ApprovalRequest, TaskQueueSnapshot, TaskUiDetail, TaskUiItem};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeStatus {
    pub user_id: String,
    pub workspace_id: String,
    pub local_first: bool,
    pub cloud_api_enabled: bool,
    pub components: Vec<BridgeComponentStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeComponentStatus {
    pub id: String,
    pub label: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopChatThread {
    pub thread_id: String,
    pub title: String,
    pub subtitle: String,
    pub status: String,
    pub computer_session_id: String,
    pub task_id: String,
    pub updated_at: String,
    pub message_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopChatThreadSnapshot {
    pub active_thread_id: String,
    pub threads: Vec<DesktopChatThread>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptPlanStepRunResult {
    pub status: String,
    pub task_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptPlanBatchRunResult {
    pub status: String,
    pub completed: usize,
    pub stopped_reason: Option<String>,
    pub results: Vec<PromptPlanStepRunResult>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeHealthSnapshot {
    pub processes: Vec<RuntimeProcessItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeProcessItem {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub pid: Option<u32>,
    pub message: Option<String>,
    pub health_check: Value,
    pub command_label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopTaskQueueSnapshot {
    pub queued: Vec<DesktopTaskItem>,
    pub active: Vec<DesktopTaskItem>,
    pub blocked: Vec<DesktopTaskItem>,
    pub waiting_approvals: Vec<DesktopApprovalItem>,
    pub recent_failures: Vec<DesktopTaskItem>,
    pub resource_usage: Vec<ResourceUsageItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopTaskItem {
    pub task_id: String,
    pub kind: String,
    pub goal: String,
    pub status: String,
    pub priority: String,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopApprovalItem {
    pub approval_id: String,
    pub task_id: String,
    pub action: String,
    pub risk_level: String,
    pub data_boundary: String,
    pub explanation: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResourceUsageItem {
    pub resource_class: String,
    pub units: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopTaskDetail {
    pub task_id: String,
    pub kind: String,
    pub goal: String,
    pub status: String,
    pub priority: String,
    pub blocked_reason: Option<String>,
    pub latest_checkpoint: Option<Value>,
    pub runtime_metadata: Option<Value>,
    pub exposes_raw_input: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilitySnapshot {
    pub connections: Vec<CapabilityConnectionItem>,
    pub tools: Vec<CapabilityToolItem>,
    pub policy: CapabilityPolicySummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityConnectionItem {
    pub id: String,
    pub provider_id: String,
    pub display_name: String,
    pub status: String,
    pub privacy_domains: Vec<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityToolItem {
    pub provider_id: String,
    pub name: String,
    pub provider_kind: String,
    pub action: String,
    pub description: String,
    pub privacy_domains: Vec<String>,
    pub sensitivity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityPolicySummary {
    pub enabled_providers: Vec<String>,
    pub allow_managed_cloud: bool,
    pub privacy_domains: Vec<String>,
    pub max_autonomy_level: u8,
}

pub fn component(id: &str, label: &str, status: &str) -> BridgeComponentStatus {
    BridgeComponentStatus {
        id: id.to_string(),
        label: label.to_string(),
        status: status.to_string(),
    }
}

pub fn runtime_process_item(detail: &ProcessDetail) -> Result<RuntimeProcessItem, String> {
    runtime_process_item_with_snapshot(detail, detail.snapshot.clone())
}

pub fn runtime_process_item_with_snapshot(
    detail: &ProcessDetail,
    snapshot: ProcessSnapshot,
) -> Result<RuntimeProcessItem, String> {
    Ok(RuntimeProcessItem {
        id: snapshot.process_id,
        kind: enum_string(&snapshot.kind)?,
        status: enum_string(&snapshot.status)?,
        pid: snapshot.pid,
        message: snapshot.message,
        health_check: serde_json::to_value(&detail.spec.health_check)
            .map_err(|error| error.to_string())?,
        command_label: command_label(&detail.spec.command),
    })
}

pub fn desktop_task_queue(snapshot: TaskQueueSnapshot) -> Result<DesktopTaskQueueSnapshot, String> {
    Ok(DesktopTaskQueueSnapshot {
        queued: snapshot
            .queued
            .into_iter()
            .map(desktop_task_item)
            .collect::<Result<Vec<_>, _>>()?,
        active: snapshot
            .active
            .into_iter()
            .map(desktop_task_item)
            .collect::<Result<Vec<_>, _>>()?,
        blocked: snapshot
            .blocked
            .into_iter()
            .map(desktop_task_item)
            .collect::<Result<Vec<_>, _>>()?,
        waiting_approvals: snapshot
            .waiting_approvals
            .into_iter()
            .map(desktop_approval_item)
            .collect::<Result<Vec<_>, _>>()?,
        recent_failures: snapshot
            .recent_failures
            .into_iter()
            .map(desktop_task_item)
            .collect::<Result<Vec<_>, _>>()?,
        resource_usage: snapshot
            .resource_usage
            .into_iter()
            .map(|(resource_class, units)| {
                Ok(ResourceUsageItem {
                    resource_class: enum_string(&resource_class)?,
                    units,
                })
            })
            .collect::<Result<Vec<_>, String>>()?,
    })
}

pub fn desktop_task_detail(detail: TaskUiDetail) -> DesktopTaskDetail {
    DesktopTaskDetail {
        task_id: detail.task_id.as_str().to_string(),
        kind: detail.kind,
        goal: detail.goal,
        status: enum_string(&detail.status).unwrap_or_else(|_| "unknown".to_string()),
        priority: enum_string(&detail.priority).unwrap_or_else(|_| "unknown".to_string()),
        blocked_reason: detail.blocked_reason,
        latest_checkpoint: detail.latest_checkpoint,
        runtime_metadata: detail.runtime_metadata,
        exposes_raw_input: detail.exposes_raw_input,
    }
}

pub fn capability_connection_item(config: CapabilityConnectionConfig) -> CapabilityConnectionItem {
    CapabilityConnectionItem {
        id: config.connection_id,
        provider_id: config.provider_id.as_str().to_string(),
        display_name: config.display_name,
        status: enum_string(&config.status).unwrap_or_else(|_| "unknown".to_string()),
        privacy_domains: config.privacy_domains,
        metadata: config.metadata,
    }
}

pub fn capability_tool_item(cached: CachedCapabilityTool) -> CapabilityToolItem {
    CapabilityToolItem {
        provider_id: cached.tool.provider_id.as_str().to_string(),
        name: cached.tool.name,
        provider_kind: enum_string(&cached.tool.provider_kind)
            .unwrap_or_else(|_| "unknown".to_string()),
        action: enum_string(&cached.tool.action).unwrap_or_else(|_| "unknown".to_string()),
        description: cached.tool.description,
        privacy_domains: cached.tool.privacy_domains,
        sensitivity: cached.tool.sensitivity,
    }
}

fn desktop_task_item(item: TaskUiItem) -> Result<DesktopTaskItem, String> {
    Ok(DesktopTaskItem {
        task_id: item.task_id.as_str().to_string(),
        kind: item.kind,
        goal: item.goal,
        status: enum_string(&item.status)?,
        priority: enum_string(&item.priority)?,
        blocked_reason: item.blocked_reason,
    })
}

fn desktop_approval_item(approval: ApprovalRequest) -> Result<DesktopApprovalItem, String> {
    Ok(DesktopApprovalItem {
        approval_id: approval.approval_id,
        task_id: approval.task_id.as_str().to_string(),
        action: approval.action,
        risk_level: approval.risk_level,
        data_boundary: approval.data_boundary,
        explanation: approval.explanation,
        status: enum_string(&approval.status)?,
    })
}

fn command_label(command: &str) -> String {
    command
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(command)
        .to_string()
}

fn enum_string<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_value(value)
        .map_err(|error| error.to_string())?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "enum did not serialize to string".to_string())
}
