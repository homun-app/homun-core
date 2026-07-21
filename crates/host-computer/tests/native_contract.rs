use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use local_first_host_computer::{
    client::{HostComputerClient, HostComputerClientError, RequestContext, SecretToken},
    protocol::{
        HostComputerMethod, JsonRpcVersion, PROTOCOL_VERSION, RpcRequest, RpcResponse,
        RpcSuccessResponse,
    },
    transport::HostComputerTransport,
};

#[derive(Clone, Default)]
struct InventoryTransport {
    methods: Arc<Mutex<Vec<HostComputerMethod>>>,
}

#[async_trait]
impl HostComputerTransport for InventoryTransport {
    async fn call(&self, request: RpcRequest) -> Result<RpcResponse, HostComputerClientError> {
        self.methods.lock().unwrap().push(request.method);
        let result = match request.method {
            HostComputerMethod::Handshake => serde_json::json!({
                "protocol_version": PROTOCOL_VERSION,
                "helper_build": "test",
                "helper_pid": 42,
                "host_os_version": "14.5",
                "capabilities": ["list_apps", "list_windows"]
            }),
            HostComputerMethod::ListApps => serde_json::json!({
                "apps": [{
                    "identity": {"pid": 100, "process_start_time_unix_ms": 1234},
                    "display_name": "Notes",
                    "bundle_id": "com.apple.Notes",
                    "activation_policy": "regular",
                    "is_active": true,
                    "is_hidden": false
                }],
                "truncated": false
            }),
            HostComputerMethod::ListWindows => serde_json::json!({
                "windows": [{
                    "identity": {"pid": 100, "window_id": 55},
                    "title": "Note",
                    "bounds": {"x": 0.0, "y": 0.0, "width": 600.0, "height": 400.0},
                    "is_minimized": false,
                    "is_on_screen": true,
                    "display_id": 1
                }],
                "truncated": false
            }),
            _ => serde_json::json!({}),
        };
        Ok(RpcResponse::Success(RpcSuccessResponse {
            jsonrpc: JsonRpcVersion::V2,
            id: request.id,
            result,
        }))
    }
}

fn context() -> RequestContext {
    RequestContext {
        turn_id: Some("turn_inventory".to_string()),
        deadline_unix_ms: i64::MAX,
    }
}

#[tokio::test]
async fn client_decodes_stable_app_and_window_identities() {
    let transport = InventoryTransport::default();
    let client = HostComputerClient::new(transport, SecretToken::from_bytes([5; 32]));

    let apps = client.list_apps(false, context()).await.unwrap();
    let windows = client.list_windows(context()).await.unwrap();

    assert_eq!(apps.apps[0].identity.pid, 100);
    assert_eq!(apps.apps[0].identity.process_start_time_unix_ms, 1234);
    assert_eq!(windows.windows[0].identity.window_id, 55);
    assert!(!apps.truncated);
    assert!(!windows.truncated);
}
