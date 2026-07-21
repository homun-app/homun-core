use local_first_host_computer::policy::{is_protected_bundle_id, is_terminal_bundle_id};
use local_first_host_computer::protocol::{HostComputerErrorCode, SemanticAction};

#[test]
fn hard_denial_error_codes_are_stable() {
    assert_eq!(
        HostComputerErrorCode::SecureInputBlocked.as_str(),
        "secure_input_blocked"
    );
    assert_eq!(
        HostComputerErrorCode::TerminalInputBlocked.as_str(),
        "terminal_input_blocked"
    );
}

#[test]
fn set_value_remains_an_explicit_mutation() {
    assert_eq!(
        serde_json::to_value(SemanticAction::SetValue).unwrap(),
        "set_value"
    );
}

#[test]
fn protected_apps_cannot_receive_a_grant() {
    for bundle_id in [
        "com.apple.loginwindow",
        "com.apple.SecurityAgent",
        "com.apple.LocalAuthentication.UIAgent",
        "com.1password.1password",
        "2BUA8C4S2C.com.1password.browser-helper",
        "com.bitwarden.desktop",
        "com.lastpass.LastPass",
        "com.dashlane.Dashlane",
    ] {
        assert!(is_protected_bundle_id(bundle_id), "{bundle_id}");
    }
    assert!(!is_protected_bundle_id("com.apple.Notes"));
}

#[test]
fn terminal_apps_are_classified_separately() {
    assert!(is_terminal_bundle_id("com.apple.Terminal"));
    assert!(is_terminal_bundle_id("com.googlecode.iterm2"));
    assert!(!is_terminal_bundle_id("com.apple.Notes"));
}
