use local_first_browser_automation::{
    BrowserActionDecision, BrowserAutomationError, BrowserMethod, BrowserPolicy,
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
            "kind": "fill",
            "fields": [{"ref": "e1", "value": "redacted"}]
        }),
    );

    assert_eq!(decision, BrowserActionDecision::Allow);
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

    assert!(matches!(click, BrowserActionDecision::NeedsApproval { .. }));
    assert!(matches!(submit, BrowserActionDecision::NeedsApproval { .. }));
}
