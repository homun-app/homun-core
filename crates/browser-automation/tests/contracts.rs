use local_first_browser_automation::{
    BrowserMethod, BrowserRequest, BrowserResponse, BrowserSidecarError,
};

#[test]
fn browser_request_serializes_sidecar_method_names() {
    let request = BrowserRequest::new(
        "req_1",
        BrowserMethod::Snapshot,
        serde_json::json!({"target_id": "booking"}),
    );

    let json = serde_json::to_value(&request).unwrap();

    assert_eq!(json["id"], "req_1");
    assert_eq!(json["method"], "browser.snapshot");
    assert_eq!(json["params"]["target_id"], "booking");
}

#[test]
fn browser_response_deserializes_success_and_error_envelopes() {
    let success: BrowserResponse = serde_json::from_value(serde_json::json!({
        "id": "req_1",
        "ok": true,
        "result": {"status": "ready"}
    }))
    .unwrap();
    let error: BrowserResponse = serde_json::from_value(serde_json::json!({
        "id": "req_2",
        "ok": false,
        "error": {
            "code": "BROWSER_STALE_REF",
            "message": "ref is stale",
            "retryable": true,
            "manual_action_required": false
        }
    }))
    .unwrap();

    assert_eq!(success.result().unwrap()["status"], "ready");
    assert_eq!(
        error.error().unwrap(),
        &BrowserSidecarError {
            code: "BROWSER_STALE_REF".to_string(),
            message: "ref is stale".to_string(),
            retryable: true,
            manual_action_required: false,
        }
    );
}
