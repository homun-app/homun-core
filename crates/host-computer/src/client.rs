use std::{
    fmt,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use secrecy::{ExposeSecret, SecretBox};
use serde::de::DeserializeOwned;
use tokio::sync::Mutex;

use crate::{
    protocol::{
        ActionRequest, ActionResult, AppSnapshot, HandshakeResult, HostComputerErrorCode,
        HostComputerMethod, HostPermission, JsonRpcVersion, ListAppsResult, ListWindowsResult,
        PROTOCOL_VERSION, PermissionStatus, RequestMeta, ResumeControlResult, RpcError, RpcRequest,
        StagedCapture,
    },
    transport::HostComputerTransport,
};

pub struct SecretToken {
    bytes: SecretBox<[u8; 32]>,
}

impl SecretToken {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self {
            bytes: SecretBox::new(Box::new(bytes)),
        }
    }

    pub(crate) fn encoded(&self) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let bytes = self.bytes.expose_secret();
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }
        output
    }
}

impl fmt::Debug for SecretToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretToken([REDACTED])")
    }
}

#[derive(Debug, Clone)]
pub struct RequestContext {
    pub turn_id: Option<String>,
    pub deadline_unix_ms: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum HostComputerClientError {
    #[error("host computer RPC failed: {0:?}")]
    Rpc(RpcError),
    #[error("host computer transport failed: {message}")]
    Transport {
        code: HostComputerErrorCode,
        message: String,
    },
}

impl HostComputerClientError {
    pub fn code(&self) -> HostComputerErrorCode {
        match self {
            Self::Rpc(error) => error.code,
            Self::Transport { code, .. } => *code,
        }
    }

    pub fn transport(code: HostComputerErrorCode, message: impl Into<String>) -> Self {
        Self::Transport {
            code,
            message: message.into(),
        }
    }
}

pub struct HostComputerClient<T> {
    transport: T,
    token: SecretToken,
    next_id: AtomicU64,
    handshake: Mutex<Option<HandshakeResult>>,
}

impl<T> HostComputerClient<T>
where
    T: HostComputerTransport,
{
    pub fn new(transport: T, token: SecretToken) -> Self {
        Self {
            transport,
            token,
            next_id: AtomicU64::new(1),
            handshake: Mutex::new(None),
        }
    }

    pub async fn permission_status(
        &self,
        context: RequestContext,
    ) -> Result<PermissionStatus, HostComputerClientError> {
        self.ensure_handshake(&context).await?;
        self.call(
            HostComputerMethod::PermissionStatus,
            serde_json::json!({}),
            context,
        )
        .await
    }

    pub async fn permission_present(
        &self,
        permission: HostPermission,
        context: RequestContext,
    ) -> Result<PermissionStatus, HostComputerClientError> {
        self.ensure_handshake(&context).await?;
        self.call(
            HostComputerMethod::PermissionPresent,
            serde_json::json!({"permission": permission}),
            context,
        )
        .await
    }

    pub async fn list_apps(
        &self,
        include_background: bool,
        context: RequestContext,
    ) -> Result<ListAppsResult, HostComputerClientError> {
        self.ensure_handshake(&context).await?;
        self.call(
            HostComputerMethod::ListApps,
            serde_json::json!({"include_background": include_background}),
            context,
        )
        .await
    }

    pub async fn list_windows(
        &self,
        context: RequestContext,
    ) -> Result<ListWindowsResult, HostComputerClientError> {
        self.ensure_handshake(&context).await?;
        self.call(
            HostComputerMethod::ListWindows,
            serde_json::json!({}),
            context,
        )
        .await
    }

    pub async fn get_app_state(
        &self,
        pid: u32,
        base_snapshot_id: Option<String>,
        context: RequestContext,
    ) -> Result<AppSnapshot, HostComputerClientError> {
        self.ensure_handshake(&context).await?;
        self.call(
            HostComputerMethod::GetAppState,
            serde_json::json!({
                "pid": pid,
                "base_snapshot_id": base_snapshot_id,
            }),
            context,
        )
        .await
    }

    pub async fn capture_window(
        &self,
        window_id: u32,
        context: RequestContext,
    ) -> Result<StagedCapture, HostComputerClientError> {
        self.ensure_handshake(&context).await?;
        self.call(
            HostComputerMethod::CaptureWindow,
            serde_json::json!({"window_id": window_id}),
            context,
        )
        .await
    }

    pub async fn execute_action(
        &self,
        request: ActionRequest,
        context: RequestContext,
    ) -> Result<ActionResult, HostComputerClientError> {
        self.ensure_handshake(&context).await?;
        self.call(
            HostComputerMethod::ExecuteAction,
            serde_json::to_value(request).map_err(|error| {
                HostComputerClientError::transport(
                    HostComputerErrorCode::InvalidRequest,
                    format!("action request is invalid: {error}"),
                )
            })?,
            context,
        )
        .await
    }

    pub async fn resume_control(
        &self,
        resume_token: String,
        context: RequestContext,
    ) -> Result<ResumeControlResult, HostComputerClientError> {
        self.ensure_handshake(&context).await?;
        self.call(
            HostComputerMethod::ResumeControl,
            serde_json::json!({"resume_token": resume_token}),
            context,
        )
        .await
    }

    async fn ensure_handshake(
        &self,
        context: &RequestContext,
    ) -> Result<(), HostComputerClientError> {
        let mut state = self.handshake.lock().await;
        if state.is_some() {
            return Ok(());
        }

        let result: HandshakeResult = self
            .call(
                HostComputerMethod::Handshake,
                serde_json::json!({}),
                context.clone(),
            )
            .await?;
        if result.protocol_version != PROTOCOL_VERSION {
            return Err(HostComputerClientError::transport(
                HostComputerErrorCode::ProtocolMismatch,
                format!(
                    "helper protocol {} does not match {PROTOCOL_VERSION}",
                    result.protocol_version
                ),
            ));
        }
        *state = Some(result);
        Ok(())
    }

    async fn call<R>(
        &self,
        method: HostComputerMethod,
        params: serde_json::Value,
        context: RequestContext,
    ) -> Result<R, HostComputerClientError>
    where
        R: DeserializeOwned,
    {
        if context.deadline_unix_ms <= unix_time_ms() {
            return Err(HostComputerClientError::transport(
                HostComputerErrorCode::DeadlineExceeded,
                "request deadline has already elapsed",
            ));
        }

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = RpcRequest {
            jsonrpc: JsonRpcVersion::V2,
            id,
            method,
            params,
            meta: RequestMeta {
                protocol_version: PROTOCOL_VERSION,
                turn_id: context.turn_id,
                deadline_unix_ms: context.deadline_unix_ms,
                session_token: self.token.encoded(),
            },
        };
        let response = self.transport.call(request).await?;
        if response.id() != id {
            return Err(HostComputerClientError::transport(
                HostComputerErrorCode::InvalidRequest,
                format!(
                    "response id {} does not match request id {id}",
                    response.id()
                ),
            ));
        }
        let value = response
            .into_result()
            .map_err(HostComputerClientError::Rpc)?;
        serde_json::from_value(value).map_err(|error| {
            HostComputerClientError::transport(
                HostComputerErrorCode::InvalidRequest,
                format!("response payload is invalid: {error}"),
            )
        })
    }
}

fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}
