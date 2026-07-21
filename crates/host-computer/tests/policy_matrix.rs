use local_first_host_computer::{grants::GrantLevel, policy::*};

fn request(category: ActionCategory) -> PolicyRequest {
    PolicyRequest {
        category,
        protected_target: false,
        low_risk_typing_enabled: false,
        approval_matches: false,
    }
}

#[test]
fn observe_and_control_grants_have_distinct_scope() {
    let policy = HostActionPolicy;
    assert_eq!(
        policy.decide(Some(GrantLevel::Observe), &request(ActionCategory::Observe)),
        PolicyDecision::Allowed
    );
    assert_eq!(
        policy.decide(
            Some(GrantLevel::Observe),
            &request(ActionCategory::Reversible)
        ),
        PolicyDecision::GrantRequired(GrantLevel::Control)
    );
}

#[test]
fn consequential_actions_require_exact_approval() {
    let policy = HostActionPolicy;
    for category in [
        ActionCategory::TextEntry,
        ActionCategory::FileWrite,
        ActionCategory::ExternalCommunication,
        ActionCategory::Purchase,
        ActionCategory::SystemSettings,
        ActionCategory::Destructive,
    ] {
        assert_eq!(
            policy.decide(Some(GrantLevel::Control), &request(category)),
            PolicyDecision::ApprovalRequired(category)
        );
        let mut approved = request(category);
        approved.approval_matches = true;
        assert_eq!(
            policy.decide(Some(GrantLevel::Control), &approved),
            PolicyDecision::Allowed
        );
    }
}

#[test]
fn hard_denials_precede_grants_and_approvals() {
    let policy = HostActionPolicy;
    let mut terminal = request(ActionCategory::TerminalInput);
    terminal.approval_matches = true;
    assert_eq!(
        policy.decide(Some(GrantLevel::Control), &terminal),
        PolicyDecision::Denied(HardDeny::TerminalInput)
    );
    let mut protected = request(ActionCategory::Reversible);
    protected.protected_target = true;
    assert_eq!(
        policy.decide(Some(GrantLevel::Control), &protected),
        PolicyDecision::Denied(HardDeny::ProtectedTarget)
    );
}
