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
