use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use local_first_host_computer::{
    client::{HostComputerClient, HostComputerClientError, RequestContext, SecretToken},
    protocol::{
        HostComputerErrorCode, HostComputerMethod, JsonRpcVersion, PROTOCOL_VERSION,
        PermissionState, PermissionStatus, RpcRequest, RpcResponse, RpcSuccessResponse,
    },
    transport::HostComputerTransport,
};

#[derive(Clone, Default)]
struct RecordingTransport {
    requests: Arc<Mutex<Vec<RpcRequest>>>,
    wrong_response_id: bool,
}

impl RecordingTransport {
    fn with_wrong_response_id() -> Self {
        Self {
            wrong_response_id: true,
            ..Self::default()
        }
    }

    fn methods(&self) -> Vec<HostComputerMethod> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.method)
            .collect()
    }
}

#[async_trait]
impl HostComputerTransport for RecordingTransport {
    async fn call(&self, request: RpcRequest) -> Result<RpcResponse, HostComputerClientError> {
        self.requests.lock().unwrap().push(request.clone());
        let id = if self.wrong_response_id {
            request.id + 1
        } else {
            request.id
        };
        let result = match request.method {
            HostComputerMethod::Handshake => serde_json::json!({
                "protocol_version": PROTOCOL_VERSION,
                "helper_build": "test",
                "helper_pid": 42,
                "host_os_version": "14.5",
                "capabilities": ["permission_status"]
            }),
            HostComputerMethod::PermissionStatus => serde_json::to_value(PermissionStatus {
                accessibility: PermissionState::Granted,
                screen_recording: PermissionState::Denied,
            })
            .unwrap(),
            HostComputerMethod::PermissionPresent => serde_json::json!({}),
            HostComputerMethod::ListApps => serde_json::json!({"apps": [], "truncated": false}),
            HostComputerMethod::ListWindows => {
                serde_json::json!({"windows": [], "truncated": false})
            }
            HostComputerMethod::GetAppState => empty_snapshot(),
            HostComputerMethod::CaptureWindow => {
                serde_json::json!({"relative_path": "capture.png"})
            }
            HostComputerMethod::ExecuteAction => {
                serde_json::json!({"snapshot_required": true})
            }
            HostComputerMethod::ResumeControl => serde_json::json!({"phase": "active"}),
        };
        Ok(RpcResponse::Success(RpcSuccessResponse {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result,
        }))
    }
}

fn empty_snapshot() -> serde_json::Value {
    serde_json::json!({
        "snapshot_id": "00000000-0000-0000-0000-000000000001",
        "generation": 1,
        "captured_at_unix_ms": 0,
        "tree_mode": "full",
        "base_snapshot_id": null,
        "elements": [],
        "focused_element_index": null,
        "screenshot_ref": null,
        "truncated": false
    })
}

fn future_context() -> RequestContext {
    RequestContext {
        turn_id: Some("turn_1".to_string()),
        deadline_unix_ms: i64::MAX,
    }
}

#[tokio::test]
async fn client_never_sends_a_command_before_handshake() {
    let transport = RecordingTransport::default();
    let client = HostComputerClient::new(transport.clone(), SecretToken::from_bytes([7; 32]));

    let status = client.permission_status(future_context()).await.unwrap();

    assert_eq!(status.accessibility, PermissionState::Granted);
    assert_eq!(
        transport.methods(),
        [
            HostComputerMethod::Handshake,
            HostComputerMethod::PermissionStatus
        ]
    );
}

#[tokio::test]
async fn a_successful_handshake_is_reused() {
    let transport = RecordingTransport::default();
    let client = HostComputerClient::new(transport.clone(), SecretToken::from_bytes([8; 32]));

    client.permission_status(future_context()).await.unwrap();
    client.permission_status(future_context()).await.unwrap();

    assert_eq!(
        transport.methods(),
        [
            HostComputerMethod::Handshake,
            HostComputerMethod::PermissionStatus,
            HostComputerMethod::PermissionStatus
        ]
    );
}

#[tokio::test]
async fn client_decodes_a_bounded_app_snapshot() {
    let transport = RecordingTransport::default();
    let client = HostComputerClient::new(transport.clone(), SecretToken::from_bytes([9; 32]));

    let snapshot = client
        .get_app_state(123, None, future_context())
        .await
        .unwrap();

    assert_eq!(snapshot.generation, 1);
    assert_eq!(
        transport.methods(),
        [
            HostComputerMethod::Handshake,
            HostComputerMethod::GetAppState
        ]
    );
}

#[tokio::test]
async fn every_request_contains_the_session_token() {
    let transport = RecordingTransport::default();
    let client = HostComputerClient::new(transport.clone(), SecretToken::from_bytes([9; 32]));

    client.permission_status(future_context()).await.unwrap();

    let requests = transport.requests.lock().unwrap();
    assert!(
        requests
            .iter()
            .all(|request| !request.meta.session_token.is_empty())
    );
    assert!(
        requests
            .windows(2)
            .all(|pair| pair[0].meta.session_token == pair[1].meta.session_token)
    );
}

#[tokio::test]
async fn expired_deadline_fails_without_transport_call() {
    let transport = RecordingTransport::default();
    let client = HostComputerClient::new(transport.clone(), SecretToken::from_bytes([10; 32]));

    let error = client
        .permission_status(RequestContext {
            turn_id: None,
            deadline_unix_ms: 1,
        })
        .await
        .unwrap_err();

    assert_eq!(error.code(), HostComputerErrorCode::DeadlineExceeded);
    assert!(transport.methods().is_empty());
}

#[tokio::test]
async fn mismatched_response_id_is_rejected() {
    let transport = RecordingTransport::with_wrong_response_id();
    let client = HostComputerClient::new(transport, SecretToken::from_bytes([11; 32]));

    let error = client
        .permission_status(future_context())
        .await
        .unwrap_err();

    assert_eq!(error.code(), HostComputerErrorCode::InvalidRequest);
}
