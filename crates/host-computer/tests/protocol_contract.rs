use local_first_host_computer::protocol::{
    HostComputerErrorCode, HostComputerMethod, JsonRpcVersion, PROTOCOL_VERSION, RpcRequest,
    RpcResponse,
};

fn request_fixture() -> &'static str {
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../runtimes/host-computer/macos/Fixtures/handshake-request-v1.json"
    ))
}

#[test]
fn handshake_fixture_round_trips_without_shape_drift() {
    let raw = request_fixture();
    let request: RpcRequest = serde_json::from_str(raw).unwrap();

    assert_eq!(request.jsonrpc, JsonRpcVersion::V2);
    assert_eq!(request.meta.protocol_version, PROTOCOL_VERSION);
    assert!(matches!(request.method, HostComputerMethod::Handshake));
    assert_eq!(
        serde_json::to_value(request).unwrap(),
        serde_json::from_str::<serde_json::Value>(raw).unwrap()
    );
}

#[test]
fn response_fixture_decodes_as_success() {
    let raw = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../runtimes/host-computer/macos/Fixtures/handshake-response-v1.json"
    ));
    let response: RpcResponse = serde_json::from_str(raw).unwrap();

    let result = response.into_result().unwrap();
    assert_eq!(result["protocol_version"], PROTOCOL_VERSION);
    assert_eq!(result["helper_pid"], 4242);
}

#[test]
fn unknown_fields_are_rejected() {
    let mut value: serde_json::Value = serde_json::from_str(request_fixture()).unwrap();
    value["unexpected"] = serde_json::json!(true);

    let error = serde_json::from_value::<RpcRequest>(value).unwrap_err();
    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn request_debug_redacts_session_token() {
    let request: RpcRequest = serde_json::from_str(request_fixture()).unwrap();
    let rendered = format!("{request:?}");

    assert!(!rendered.contains("test-session-token-32-bytes-long"));
    assert!(rendered.contains("[REDACTED]"));
}

#[test]
fn all_v1_error_codes_are_stable() {
    let cases = [
        (
            HostComputerErrorCode::AuthenticationFailed,
            "authentication_failed",
        ),
        (HostComputerErrorCode::ProtocolMismatch, "protocol_mismatch"),
        (HostComputerErrorCode::InvalidRequest, "invalid_request"),
        (
            HostComputerErrorCode::PermissionMissing,
            "permission_missing",
        ),
        (HostComputerErrorCode::AppNotGranted, "app_not_granted"),
        (HostComputerErrorCode::ApprovalRequired, "approval_required"),
        (
            HostComputerErrorCode::SecureInputBlocked,
            "secure_input_blocked",
        ),
        (
            HostComputerErrorCode::TerminalInputBlocked,
            "terminal_input_blocked",
        ),
        (HostComputerErrorCode::StaleSnapshot, "stale_snapshot"),
        (HostComputerErrorCode::TargetNotFound, "target_not_found"),
        (HostComputerErrorCode::DeadlineExceeded, "deadline_exceeded"),
        (HostComputerErrorCode::PayloadTooLarge, "payload_too_large"),
        (
            HostComputerErrorCode::HelperUnavailable,
            "helper_unavailable",
        ),
        (HostComputerErrorCode::HostLocked, "host_locked"),
        (
            HostComputerErrorCode::UnsupportedPlatform,
            "unsupported_platform",
        ),
    ];

    for (code, expected) in cases {
        assert_eq!(code.as_str(), expected);
        assert_eq!(serde_json::to_value(code).unwrap(), expected);
    }
}

#[test]
fn protocol_version_mismatch_is_rejected() {
    let mut request: RpcRequest = serde_json::from_str(request_fixture()).unwrap();
    request.meta.protocol_version = PROTOCOL_VERSION + 1;

    let error = request.validate_protocol_version().unwrap_err();
    assert_eq!(error.code, HostComputerErrorCode::ProtocolMismatch);
}
