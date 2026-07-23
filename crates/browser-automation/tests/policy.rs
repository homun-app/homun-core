use local_first_browser_automation::{
    policy::contains_final_payment_action, BrowserActionDecision, BrowserAutomationError,
    BrowserMethod, BrowserPolicy,
};

#[test]
fn policy_blocks_unsupported_protocols() {
    let policy = BrowserPolicy::default();

    let error = policy
        .assert_navigation_allowed("file:///etc/passwd")
        .unwrap_err();

    assert_eq!(
        error,
        BrowserAutomationError::NavigationBlocked("unsupported protocol:file".to_string())
    );
}

#[test]
fn policy_blocks_private_network_without_explicit_opt_in() {
    let policy = BrowserPolicy::default();

    let error = policy
        .assert_navigation_allowed("http://127.0.0.1:3000")
        .unwrap_err();

    assert_eq!(
        error,
        BrowserAutomationError::PrivateNetworkBlocked("127.0.0.1".to_string())
    );
}

#[test]
fn policy_allows_private_network_with_explicit_opt_in() {
    let policy = BrowserPolicy::default().with_private_network(true);

    policy
        .assert_navigation_allowed("http://127.0.0.1:3000")
        .unwrap();
}

#[test]
fn policy_allows_form_fill_drafts_without_submit() {
    let decision = BrowserPolicy::default().classify_tool_call(
        BrowserMethod::Act,
        &serde_json::json!({
            "kind": "fill_form",
            "fields": [{"ref": "e1", "value": "redacted"}]
        }),
    );

    assert_eq!(decision, BrowserActionDecision::Allow);
}

#[test]
fn policy_allows_observation_actions_without_approval() {
    for params in [
        serde_json::json!({"kind": "hover", "ref": "e1"}),
        serde_json::json!({"kind": "scroll_into_view", "ref": "e1"}),
        serde_json::json!({"kind": "wait", "text": "Risultati"}),
        serde_json::json!({"kind": "batch", "actions": [
            {"kind": "hover", "ref": "e1"},
            {"kind": "wait", "text": "Risultati"}
        ]}),
    ] {
        let decision = BrowserPolicy::default().classify_tool_call(BrowserMethod::Act, &params);

        assert_eq!(decision, BrowserActionDecision::Allow);
    }
}

#[test]
fn policy_requires_approval_for_clicks_and_submit_typing() {
    let click = BrowserPolicy::default().classify_tool_call(
        BrowserMethod::Act,
        &serde_json::json!({"kind": "click", "ref": "e1"}),
    );
    let submit = BrowserPolicy::default().classify_tool_call(
        BrowserMethod::Act,
        &serde_json::json!({"kind": "type", "ref": "e1", "text": "hello", "submit": true}),
    );
    let enter = BrowserPolicy::default().classify_tool_call(
        BrowserMethod::Act,
        &serde_json::json!({"kind": "press_key", "text": "Enter"}),
    );
    let tab = BrowserPolicy::default().classify_tool_call(
        BrowserMethod::Act,
        &serde_json::json!({"kind": "press_key", "text": "Tab"}),
    );

    assert!(matches!(click, BrowserActionDecision::NeedsApproval { .. }));
    assert!(matches!(
        submit,
        BrowserActionDecision::NeedsApproval { .. }
    ));
    assert!(matches!(enter, BrowserActionDecision::NeedsApproval { .. }));
    assert_eq!(tab, BrowserActionDecision::Allow);
}

#[test]
fn policy_requires_approval_when_batch_contains_manual_action() {
    let decision = BrowserPolicy::default().classify_tool_call(
        BrowserMethod::Act,
        &serde_json::json!({
            "kind": "batch",
            "actions": [
                {"kind": "wait", "text": "Risultati"},
                {"kind": "click", "ref": "e1"}
            ]
        }),
    );

    assert!(matches!(
        decision,
        BrowserActionDecision::NeedsApproval { .. }
    ));
}

#[test]
fn policy_checks_nested_payment_actions_inside_batch() {
    let snapshot = "- button \"Paga ora\" [ref=e9]\n- button \"Continua\" [ref=e2]";
    let action = serde_json::json!({
        "kind": "batch",
        "actions": [
            {"kind": "click", "ref": "e2"},
            {"kind": "click", "ref": "e9"}
        ]
    });

    let reason = BrowserPolicy::default()
        .classify_tool_call(BrowserMethod::Act, &action);

    assert!(matches!(reason, BrowserActionDecision::NeedsApproval { .. }));
    assert!(contains_final_payment_action(&action, snapshot));
}
