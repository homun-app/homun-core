use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Running,
    WaitingUser,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceKind {
    Browser,
    Shell,
    Files,
    Logs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceStatus {
    Idle,
    Running,
    Waiting,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalState {
    None,
    WaitingUser,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TakeoverState {
    None,
    Requested,
    Active,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputerSessionCreate {
    pub session_id: String,
    pub task_id: String,
    pub workflow_id: Option<String>,
    pub user_id: String,
    pub workspace_id: String,
    pub title: String,
    pub subtitle: String,
    pub risk_level: String,
    pub progress_total: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputerSessionRecord {
    pub session_id: String,
    pub task_id: String,
    pub workflow_id: Option<String>,
    pub user_id: String,
    pub workspace_id: String,
    pub status: SessionStatus,
    pub active_surface: SurfaceKind,
    pub surfaces: Vec<ComputerSurfaceRecord>,
    pub title: String,
    pub subtitle: String,
    pub progress_current: u32,
    pub progress_total: u32,
    pub approval_state: ApprovalState,
    pub takeover_state: TakeoverState,
    pub risk_level: String,
    pub last_error: Option<String>,
    pub started_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputerSurfaceRecord {
    pub surface: SurfaceKind,
    pub label: String,
    pub status: SurfaceStatus,
    pub detail: Option<String>,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputerEventCreate {
    pub session_id: String,
    pub surface: SurfaceKind,
    pub kind: String,
    pub status: String,
    pub title: String,
    pub subtitle: String,
    pub payload: Value,
    pub artifact_refs: Vec<String>,
    pub approval_required: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputerEventRecord {
    pub event_id: String,
    pub session_id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub surface: SurfaceKind,
    pub kind: String,
    pub status: String,
    pub title: String,
    pub subtitle: String,
    pub payload: Value,
    pub artifact_refs: Vec<String>,
    pub approval_required: bool,
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactCreate {
    pub session_id: String,
    pub artifact_id: String,
    pub title: String,
    pub kind: String,
    pub path_ref: String,
    pub size_bytes: u64,
    pub preview_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRecord {
    pub artifact_id: String,
    pub session_id: String,
    pub user_id: String,
    pub workspace_id: String,
    pub title: String,
    pub kind: String,
    pub path_ref: String,
    pub size_bytes: u64,
    pub preview_ref: Option<String>,
    pub created_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputerSessionSnapshot {
    pub computer_session_id: String,
    pub task_id: String,
    pub workflow_id: Option<String>,
    pub user_id: String,
    pub workspace_id: String,
    pub status: SessionStatus,
    pub active_surface: SurfaceKind,
    pub surfaces: Vec<ComputerSurfaceSnapshot>,
    pub activity_title: String,
    pub activity_subtitle: String,
    pub progress_current: u32,
    pub progress_total: u32,
    pub elapsed_seconds: i64,
    pub preview_frame_ref: Option<String>,
    pub current_url_redacted: Option<String>,
    pub terminal_excerpt_redacted: Vec<String>,
    pub artifact_refs: Vec<ArtifactSnapshot>,
    pub timeline: Vec<TimelineItem>,
    pub approval_state: ApprovalState,
    pub takeover_state: TakeoverState,
    pub risk_level: String,
    pub last_error_redacted: Option<String>,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputerSurfaceSnapshot {
    pub surface: SurfaceKind,
    pub label: String,
    pub status: SurfaceStatus,
    pub detail_redacted: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimelineItem {
    pub event_id: String,
    pub surface: SurfaceKind,
    pub kind: String,
    pub status: String,
    pub title: String,
    pub subtitle_redacted: String,
    pub artifact_refs: Vec<String>,
    pub started_at: OffsetDateTime,
    pub completed_at: Option<OffsetDateTime>,
    pub approval_required: bool,
    pub payload_redacted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactSnapshot {
    pub artifact_id: String,
    pub title_redacted: String,
    pub kind: String,
    pub size_bytes: u64,
    pub preview_ref: Option<String>,
    pub created_at: OffsetDateTime,
}
