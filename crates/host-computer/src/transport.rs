use std::{path::PathBuf, time::Duration};

use async_trait::async_trait;

use crate::{
    client::HostComputerClientError,
    framing::{read_json_frame, write_json_frame},
    protocol::{HostComputerErrorCode, RpcRequest, RpcResponse},
};

#[async_trait]
pub trait HostComputerTransport: Send + Sync {
    async fn call(&self, request: RpcRequest) -> Result<RpcResponse, HostComputerClientError>;
}

#[derive(Debug, Clone)]
pub struct UdsTransport {
    socket_path: PathBuf,
}

impl UdsTransport {
    pub fn new(socket_path: impl Into<PathBuf>) -> Self {
        Self {
            socket_path: socket_path.into(),
        }
    }
}

#[cfg(unix)]
#[async_trait]
impl HostComputerTransport for UdsTransport {
    async fn call(&self, request: RpcRequest) -> Result<RpcResponse, HostComputerClientError> {
        use std::os::unix::fs::MetadataExt;

        let metadata = std::fs::symlink_metadata(&self.socket_path).map_err(|error| {
            HostComputerClientError::transport(
                HostComputerErrorCode::HelperUnavailable,
                format!("host socket metadata is unavailable: {error}"),
            )
        })?;
        let current_uid = unsafe { libc::geteuid() };
        if metadata.uid() != current_uid || metadata.mode() & 0o077 != 0 {
            return Err(HostComputerClientError::transport(
                HostComputerErrorCode::AuthenticationFailed,
                "host socket ownership or permissions are unsafe",
            ));
        }

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i128;
        let remaining_ms = i128::from(request.meta.deadline_unix_ms) - now_ms;
        if remaining_ms <= 0 {
            return Err(HostComputerClientError::transport(
                HostComputerErrorCode::DeadlineExceeded,
                "request deadline has already elapsed",
            ));
        }
        let timeout = Duration::from_millis(remaining_ms.min(u64::MAX as i128) as u64);

        tokio::time::timeout(timeout, async {
            let mut stream = tokio::net::UnixStream::connect(&self.socket_path)
                .await
                .map_err(|error| {
                    HostComputerClientError::transport(
                        HostComputerErrorCode::HelperUnavailable,
                        format!("host socket connection failed: {error}"),
                    )
                })?;
            write_json_frame(&mut stream, &request)
                .await
                .map_err(framing_error)?;
            read_json_frame(&mut stream).await.map_err(framing_error)
        })
        .await
        .map_err(|_| {
            HostComputerClientError::transport(
                HostComputerErrorCode::DeadlineExceeded,
                "host socket request timed out",
            )
        })?
    }
}

#[cfg(not(unix))]
#[async_trait]
impl HostComputerTransport for UdsTransport {
    async fn call(&self, _request: RpcRequest) -> Result<RpcResponse, HostComputerClientError> {
        Err(HostComputerClientError::transport(
            HostComputerErrorCode::UnsupportedPlatform,
            "host computer transport is available on macOS only",
        ))
    }
}

fn framing_error(error: crate::framing::FramingError) -> HostComputerClientError {
    HostComputerClientError::transport(error.code(), error.to_string())
}
