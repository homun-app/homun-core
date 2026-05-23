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
fn all_browser_methods_serialize_to_sidecar_names() {
    let methods = [
        (BrowserMethod::Health, "browser.health"),
        (BrowserMethod::Profiles, "browser.profiles"),
        (BrowserMethod::Start, "browser.start"),
        (BrowserMethod::Stop, "browser.stop"),
        (BrowserMethod::Tabs, "browser.tabs"),
        (BrowserMethod::Open, "browser.open"),
        (BrowserMethod::Focus, "browser.focus"),
        (BrowserMethod::CloseTab, "browser.close_tab"),
        (BrowserMethod::Navigate, "browser.navigate"),
        (BrowserMethod::Snapshot, "browser.snapshot"),
        (BrowserMethod::Screenshot, "browser.screenshot"),
        (BrowserMethod::Act, "browser.act"),
        (BrowserMethod::ArmFileChooser, "browser.arm_file_chooser"),
        (BrowserMethod::RespondDialog, "browser.respond_dialog"),
        (BrowserMethod::WaitDownload, "browser.wait_download"),
        (BrowserMethod::Console, "browser.console"),
        (BrowserMethod::Pdf, "browser.pdf"),
    ];

    for (method, expected) in methods {
        assert_eq!(serde_json::to_value(method).unwrap(), expected);
    }
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
