use std::sync::Arc;

use crate::{
    client::{HostComputerClient, HostComputerClientError, RequestContext},
    protocol::{PermissionState, PermissionStatus},
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
}

impl<T> HostComputerService<T>
where
    T: HostComputerTransport,
{
    pub fn new(client: Arc<HostComputerClient<T>>) -> Self {
        Self { client }
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
}
