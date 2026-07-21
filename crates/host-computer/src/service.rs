use std::sync::Arc;

use crate::{
    artifact::ArtifactManager,
    client::{HostComputerClient, HostComputerClientError, RequestContext},
    protocol::{ArtifactRef, HostComputerErrorCode, PermissionState, PermissionStatus},
    transport::HostComputerTransport,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostComputerPermissionStatus {
    pub accessibility: PermissionState,
    pub screen_recording: PermissionState,
    pub can_observe: bool,
    pub can_control: bool,
}

pub struct HostComputerService<T> {
    client: Arc<HostComputerClient<T>>,
    artifacts: Option<ArtifactManager>,
}

impl<T> HostComputerService<T>
where
    T: HostComputerTransport,
{
    pub fn new(client: Arc<HostComputerClient<T>>) -> Self {
        Self {
            client,
            artifacts: None,
        }
    }

    pub fn new_with_artifacts(
        client: Arc<HostComputerClient<T>>,
        artifacts: ArtifactManager,
    ) -> Self {
        Self {
            client,
            artifacts: Some(artifacts),
        }
    }

    pub async fn permission_status(
        &self,
        context: RequestContext,
    ) -> Result<HostComputerPermissionStatus, HostComputerClientError> {
        let PermissionStatus {
            accessibility,
            screen_recording,
        } = self.client.permission_status(context).await?;
        let ready = accessibility == PermissionState::Granted
            && screen_recording == PermissionState::Granted;
        Ok(HostComputerPermissionStatus {
            accessibility,
            screen_recording,
            can_observe: ready,
            can_control: ready,
        })
    }

    pub async fn capture_window(
        &self,
        window_id: u32,
        context: RequestContext,
    ) -> Result<ArtifactRef, HostComputerClientError> {
        let manager = self.artifacts.as_ref().ok_or_else(|| {
            HostComputerClientError::transport(
                HostComputerErrorCode::HelperUnavailable,
                "host artifact root is unavailable",
            )
        })?;
        let staged = self.client.capture_window(window_id, context).await?;
        manager
            .adopt_staged(&staged.relative_path)
            .map_err(|error| {
                HostComputerClientError::transport(
                    HostComputerErrorCode::HelperUnavailable,
                    format!("invalid staged screenshot: {error}"),
                )
            })
    }
}
