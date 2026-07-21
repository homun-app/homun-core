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
