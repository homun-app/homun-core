use local_first_browser_automation::{BrowserAutomationError, BrowserPolicy};

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
