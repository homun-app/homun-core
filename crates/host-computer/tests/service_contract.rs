use std::sync::Arc;

use async_trait::async_trait;
use local_first_host_computer::{
    client::{HostComputerClient, HostComputerClientError, RequestContext, SecretToken},
    protocol::{
        HostComputerMethod, JsonRpcVersion, PROTOCOL_VERSION, PermissionState, PermissionStatus,
        RpcRequest, RpcResponse, RpcSuccessResponse,
    },
    service::HostComputerService,
    transport::HostComputerTransport,
};

#[derive(Clone)]
struct PermissionTransport {
    status: PermissionStatus,
}

#[async_trait]
impl HostComputerTransport for PermissionTransport {
    async fn call(&self, request: RpcRequest) -> Result<RpcResponse, HostComputerClientError> {
        let result = match request.method {
            HostComputerMethod::Handshake => serde_json::json!({
                "protocol_version": PROTOCOL_VERSION,
                "helper_build": "test",
                "helper_pid": 42,
                "host_os_version": "14.5",
                "capabilities": ["permission_status"]
            }),
            HostComputerMethod::PermissionStatus => serde_json::to_value(&self.status).unwrap(),
            HostComputerMethod::PermissionPresent => serde_json::json!({}),
            HostComputerMethod::ListApps => serde_json::json!({"apps": [], "truncated": false}),
            HostComputerMethod::ListWindows => {
                serde_json::json!({"windows": [], "truncated": false})
            }
            HostComputerMethod::GetAppState => serde_json::json!({
                "snapshot_id": "00000000-0000-0000-0000-000000000001",
                "generation": 1,
                "captured_at_unix_ms": 0,
                "tree_mode": "full",
                "base_snapshot_id": null,
                "elements": [],
                "focused_element_index": null,
                "screenshot_ref": null,
                "truncated": false
            }),
        };
        Ok(RpcResponse::Success(RpcSuccessResponse {
            jsonrpc: JsonRpcVersion::V2,
            id: request.id,
            result,
        }))
    }
}

fn service(status: PermissionStatus) -> HostComputerService<PermissionTransport> {
    HostComputerService::new(Arc::new(HostComputerClient::new(
        PermissionTransport { status },
        SecretToken::from_bytes([3; 32]),
    )))
}

fn context() -> RequestContext {
    RequestContext {
        turn_id: Some("turn_test".to_string()),
        deadline_unix_ms: i64::MAX,
    }
}

#[tokio::test]
async fn status_keeps_accessibility_and_capture_independent() {
    let service = service(PermissionStatus {
        accessibility: PermissionState::Granted,
        screen_recording: PermissionState::Denied,
    });

    let status = service.permission_status(context()).await.unwrap();

    assert_eq!(status.accessibility, PermissionState::Granted);
    assert_eq!(status.screen_recording, PermissionState::Denied);
    assert!(!status.can_observe);
    assert!(!status.can_control);
}

#[tokio::test]
async fn both_permissions_enable_observation_and_control() {
    let service = service(PermissionStatus {
        accessibility: PermissionState::Granted,
        screen_recording: PermissionState::Granted,
    });

    let status = service.permission_status(context()).await.unwrap();

    assert!(status.can_observe);
    assert!(status.can_control);
}
