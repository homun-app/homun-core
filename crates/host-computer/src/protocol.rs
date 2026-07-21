use std::fmt;

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JsonRpcVersion {
    #[serde(rename = "2.0")]
    V2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostComputerMethod {
    Handshake,
    PermissionStatus,
    PermissionPresent,
    ListApps,
    ListWindows,
    GetAppState,
    CaptureWindow,
    ExecuteAction,
    ResumeControl,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplicationIdentity {
    pub pid: u32,
    pub process_start_time_unix_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivationPolicy {
    Regular,
    Accessory,
    Prohibited,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostApplication {
    pub identity: ApplicationIdentity,
    pub display_name: String,
    pub bundle_id: Option<String>,
    pub signing_identity: Option<AppSigningIdentity>,
    pub activation_policy: ActivationPolicy,
    pub is_active: bool,
    pub is_hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppSigningIdentity {
    pub team_id: String,
    pub designated_requirement_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListAppsResult {
    pub apps: Vec<HostApplication>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WindowIdentity {
    pub pid: u32,
    pub window_id: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostWindow {
    pub identity: WindowIdentity,
    pub title: Option<String>,
    pub bounds: HostRect,
    pub is_minimized: bool,
    pub is_on_screen: bool,
    pub display_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListWindowsResult {
    pub windows: Vec<HostWindow>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticAction {
    Press,
    SetValue,
    ShowMenu,
    Increment,
    Decrement,
    Confirm,
    Cancel,
    Raise,
    ScrollUp,
    ScrollDown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotTreeMode {
    Full,
    Diff,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostElement {
    pub index: u32,
    pub role: String,
    pub subrole: Option<String>,
    pub label: Option<String>,
    pub help: Option<String>,
    pub value: Option<String>,
    pub bounds: Option<HostRect>,
    pub enabled: bool,
    pub focused: bool,
    pub selected: Option<bool>,
    pub expanded: Option<bool>,
    pub sensitive: bool,
    pub actions: Vec<SemanticAction>,
    pub parent_index: Option<u32>,
    pub child_indices: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotDiff {
    pub inserted: Vec<HostElement>,
    pub updated: Vec<HostElement>,
    pub removed_indices: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRef {
    pub artifact_ref: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StagedCapture {
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionTarget {
    pub snapshot_id: String,
    pub generation: u64,
    pub index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionRequest {
    pub target: ActionTarget,
    pub action: SemanticAction,
    pub value: Option<String>,
    pub resume_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionResult {
    pub snapshot_required: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TakeoverPhase {
    Active,
    PausedByUser,
    HostLocked,
    MonitorUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostInputEvent {
    PhysicalMouseDown,
    PhysicalScroll,
    PhysicalKeyDown,
    HomunSynthetic,
    HostLocked,
    HostUnlocked,
    MonitorFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TakeoverState {
    pub phase: TakeoverPhase,
    resume_token: Option<String>,
}

impl TakeoverState {
    pub fn active(token: impl Into<String>) -> Self {
        Self {
            phase: TakeoverPhase::Active,
            resume_token: Some(token.into()),
        }
    }

    pub fn accepts(&self, token: &str) -> bool {
        self.phase == TakeoverPhase::Active && self.resume_token.as_deref() == Some(token)
    }

    pub fn apply(&mut self, event: HostInputEvent) {
        match event {
            HostInputEvent::HomunSynthetic => {}
            HostInputEvent::PhysicalMouseDown
            | HostInputEvent::PhysicalScroll
            | HostInputEvent::PhysicalKeyDown
            | HostInputEvent::HostUnlocked => {
                self.phase = TakeoverPhase::PausedByUser;
                self.resume_token = None;
            }
            HostInputEvent::HostLocked => {
                self.phase = TakeoverPhase::HostLocked;
                self.resume_token = None;
            }
            HostInputEvent::MonitorFailed => {
                self.phase = TakeoverPhase::MonitorUnavailable;
                self.resume_token = None;
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppSnapshot {
    pub snapshot_id: String,
    pub generation: u64,
    pub captured_at_unix_ms: i64,
    pub tree_mode: SnapshotTreeMode,
    pub base_snapshot_id: Option<String>,
    pub elements: Vec<HostElement>,
    pub focused_element_index: Option<u32>,
    pub screenshot_ref: Option<ArtifactRef>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandshakeResult {
    pub protocol_version: u32,
    pub helper_build: String,
    pub helper_pid: u32,
    pub host_os_version: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionState {
    Granted,
    Denied,
    NotDetermined,
    Restricted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionStatus {
    pub accessibility: PermissionState,
    pub screen_recording: PermissionState,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestMeta {
    pub protocol_version: u32,
    pub turn_id: Option<String>,
    pub deadline_unix_ms: i64,
    pub session_token: String,
}

impl fmt::Debug for RequestMeta {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RequestMeta")
            .field("protocol_version", &self.protocol_version)
            .field("turn_id", &self.turn_id)
            .field("deadline_unix_ms", &self.deadline_unix_ms)
            .field("session_token", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcRequest {
    pub jsonrpc: JsonRpcVersion,
    pub id: u64,
    pub method: HostComputerMethod,
    pub params: serde_json::Value,
    pub meta: RequestMeta,
}

impl RpcRequest {
    pub fn validate_protocol_version(&self) -> Result<(), RpcError> {
        if self.meta.protocol_version == PROTOCOL_VERSION {
            return Ok(());
        }

        Err(RpcError {
            code: HostComputerErrorCode::ProtocolMismatch,
            message: format!(
                "host computer protocol {} is unsupported; expected {PROTOCOL_VERSION}",
                self.meta.protocol_version
            ),
            data: None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcResponse {
    Success(RpcSuccessResponse),
    Error(RpcErrorResponse),
}

impl RpcResponse {
    pub fn id(&self) -> u64 {
        match self {
            Self::Success(response) => response.id,
            Self::Error(response) => response.id,
        }
    }

    pub fn into_result(self) -> Result<serde_json::Value, RpcError> {
        match self {
            Self::Success(response) => Ok(response.result),
            Self::Error(response) => Err(response.error),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcSuccessResponse {
    pub jsonrpc: JsonRpcVersion,
    pub id: u64,
    pub result: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcErrorResponse {
    pub jsonrpc: JsonRpcVersion,
    pub id: u64,
    pub error: RpcError,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcError {
    pub code: HostComputerErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostComputerErrorCode {
    AuthenticationFailed,
    ProtocolMismatch,
    InvalidRequest,
    PermissionMissing,
    AppNotGranted,
    ApprovalRequired,
    SecureInputBlocked,
    TerminalInputBlocked,
    StaleSnapshot,
    TargetNotFound,
    DeadlineExceeded,
    PayloadTooLarge,
    HelperUnavailable,
    HostLocked,
    UnsupportedPlatform,
}

impl HostComputerErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AuthenticationFailed => "authentication_failed",
            Self::ProtocolMismatch => "protocol_mismatch",
            Self::InvalidRequest => "invalid_request",
            Self::PermissionMissing => "permission_missing",
            Self::AppNotGranted => "app_not_granted",
            Self::ApprovalRequired => "approval_required",
            Self::SecureInputBlocked => "secure_input_blocked",
            Self::TerminalInputBlocked => "terminal_input_blocked",
            Self::StaleSnapshot => "stale_snapshot",
            Self::TargetNotFound => "target_not_found",
            Self::DeadlineExceeded => "deadline_exceeded",
            Self::PayloadTooLarge => "payload_too_large",
            Self::HelperUnavailable => "helper_unavailable",
            Self::HostLocked => "host_locked",
            Self::UnsupportedPlatform => "unsupported_platform",
        }
    }
}
