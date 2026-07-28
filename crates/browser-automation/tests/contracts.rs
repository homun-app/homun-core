use local_first_browser_automation::{
    BrowserCheckpoint, BrowserDraftControl, BrowserMethod, BrowserRequest, BrowserResponse,
    BrowserRestoreResult, BrowserSidecarError,
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
        (BrowserMethod::Checkpoint, "browser.checkpoint"),
        (BrowserMethod::Restore, "browser.restore"),
        (BrowserMethod::Rehydrate, "browser.rehydrate"),
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
fn browser_checkpoint_contract_round_trips_exact_wire_shape() {
    let checkpoint: BrowserCheckpoint = serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "targetId": "booking",
        "url": "https://rail.example/checkout",
        "origin": "https://rail.example",
        "browserEpoch": "container-42",
        "cdpTargetId": "ABC123",
        "generation": 9,
        "controls": [{
            "draftRef": "draft-1",
            "tag": "input",
            "type": "email",
            "name": "email",
            "value": "ada@example.test"
        }],
        "omittedSensitiveCount": 2,
        "omittedBoundedCount": 0
    }))
    .unwrap();

    assert_eq!(checkpoint.schema_version, 1);
    assert_eq!(checkpoint.controls.len(), 1);
    assert_eq!(checkpoint.controls[0].draft_ref, "draft-1");
    assert_eq!(
        serde_json::to_value(&checkpoint).unwrap()["browserEpoch"],
        "container-42"
    );
}

#[test]
fn browser_restore_result_deserializes_adoption_tier() {
    let result: BrowserRestoreResult = serde_json::from_value(serde_json::json!({
        "tier": "adopted_live_page",
        "targetId": "booking",
        "generation": 9,
        "url": "https://rail.example/checkout"
    }))
    .unwrap();

    assert_eq!(result.target_id, "booking");
    assert_eq!(result.generation, 9);
    assert_eq!(result.tier.as_str(), "adopted_live_page");
}

#[test]
fn draft_values_are_structured_and_not_displayable_contract_text() {
    let control: BrowserDraftControl = serde_json::from_value(serde_json::json!({
        "draftRef": "draft-1",
        "tag": "select",
        "type": "select-one",
        "value": ["first", "second"]
    }))
    .unwrap();

    assert_eq!(control.draft_ref, "draft-1");
    assert_eq!(control.value.as_array().unwrap().len(), 2);
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
