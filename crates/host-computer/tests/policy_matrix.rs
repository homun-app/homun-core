use local_first_host_computer::session::{HostSessionCoordinator, HostSessionPhase, SessionError};
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

#[test]
fn approval_is_exact_expires_and_is_consumed_once() {
    let mut sessions = HostSessionCoordinator::default();
    sessions
        .start("session-1", "com.example.Editor", 1_000)
        .unwrap();
    sessions
        .request_approval(
            "session-1",
            "digest-a",
            ActionCategory::TextEntry,
            "Enter text in the editor",
            1_100,
        )
        .unwrap();

    assert_eq!(
        sessions.approve("session-1", "digest-b", 1_200),
        Err(SessionError::ActionDigestMismatch)
    );
    sessions.approve("session-1", "digest-a", 1_200).unwrap();
    assert!(
        !sessions
            .consume_approval("session-1", "digest-b", 1_201)
            .unwrap()
    );
    assert!(
        sessions
            .consume_approval("session-1", "digest-a", 1_201)
            .unwrap()
    );
    assert!(
        !sessions
            .consume_approval("session-1", "digest-a", 1_202)
            .unwrap()
    );

    sessions
        .request_approval(
            "session-1",
            "digest-c",
            ActionCategory::TextEntry,
            "Enter text in the editor",
            2_000,
        )
        .unwrap();
    assert_eq!(
        sessions.approve("session-1", "digest-c", 302_001),
        Err(SessionError::ApprovalExpired)
    );
}

#[test]
fn pause_resume_cancel_transitions_are_generation_scoped() {
    let mut sessions = HostSessionCoordinator::default();
    let started = sessions
        .start("session-2", "com.example.Editor", 1_000)
        .unwrap();
    assert_eq!(started.phase, HostSessionPhase::Observing);
    let paused = sessions.pause("session-2", 1_100).unwrap();
    assert_eq!(paused.phase, HostSessionPhase::PausedByUser);
    assert_eq!(
        sessions.resume("session-2", paused.generation + 1, 1_200),
        Err(SessionError::GenerationMismatch)
    );
    let resumed = sessions
        .resume("session-2", paused.generation, 1_200)
        .unwrap();
    assert_eq!(resumed.phase, HostSessionPhase::Observing);
    let cancelled = sessions.cancel("session-2", 1_300).unwrap();
    assert_eq!(cancelled.phase, HostSessionPhase::Cancelled);
    assert_eq!(
        sessions.pause("session-2", 1_400),
        Err(SessionError::TerminalSession)
    );
}

#[test]
fn only_one_session_can_be_active_and_cancel_releases_the_slot() {
    let mut sessions = HostSessionCoordinator::default();
    sessions.start("session-a", "Editor", 1).unwrap();
    assert_eq!(sessions.active_snapshot().unwrap().session_id, "session-a");
    assert_eq!(
        sessions.start("session-b", "Calendar", 2),
        Err(SessionError::ActiveSessionExists)
    );
    sessions.cancel_active(3).unwrap();
    assert!(sessions.active_snapshot().is_none());
    assert!(sessions.start("session-b", "Calendar", 4).is_ok());
}

#[test]
fn denying_an_approval_releases_the_active_session_slot() {
    let mut sessions = HostSessionCoordinator::default();
    sessions.start("first", "Notes", 1).unwrap();
    sessions
        .request_approval(
            "first",
            "digest",
            ActionCategory::Reversible,
            "Press button",
            2,
        )
        .unwrap();

    let denied = sessions.deny("first", "digest", 3).unwrap();
    assert_eq!(denied.phase, HostSessionPhase::Failed);
    assert_eq!(denied.error_code.as_deref(), Some("approval_denied"));
    assert!(sessions.active_snapshot().is_none());
    assert!(sessions.start("second", "Mail", 4).is_ok());
}

#[test]
fn observed_app_name_replaces_the_session_placeholder() {
    let mut sessions = HostSessionCoordinator::default();
    sessions.start("session", "Mac Apps", 1).unwrap();

    let snapshot = sessions.mark_observing_app("session", "Notes", 2).unwrap();

    assert_eq!(snapshot.app, "Notes");
    assert_eq!(snapshot.phase, HostSessionPhase::Observing);
}
