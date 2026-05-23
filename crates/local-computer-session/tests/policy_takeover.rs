use local_first_local_computer_session::{
    ApprovalState, ComputerSessionCreate, LocalComputerSessionManager, LocalComputerSessionStore,
    ShellCommandPolicy, ShellRisk, TakeoverState,
};

#[test]
fn shell_policy_classifies_read_write_destructive_and_network_commands() {
    let policy = ShellCommandPolicy::default();

    assert_eq!(policy.classify("pwd").risk, ShellRisk::ReadOnly);
    assert_eq!(
        policy.classify("git status --short").risk,
        ShellRisk::ReadOnly
    );
    assert_eq!(
        policy.classify("npm install").risk,
        ShellRisk::NetworkOrInstall
    );
    assert_eq!(policy.classify("touch report.md").risk, ShellRisk::Write);
    assert_eq!(
        policy.classify("rm -rf target").risk,
        ShellRisk::Destructive
    );

    assert!(!policy.classify("git status --short").approval_required);
    assert!(policy.classify("npm install").approval_required);
    assert!(policy.classify("rm -rf target").approval_required);
}

#[test]
fn takeover_and_approval_states_are_persisted_and_visible() {
    let manager =
        LocalComputerSessionManager::new(LocalComputerSessionStore::open_in_memory().unwrap());
    let session = manager
        .create_session(session_create("session_takeover", "task_browser"))
        .unwrap();

    manager
        .request_takeover(
            &session.session_id,
            "user_1",
            "workspace_1",
            "Login o 2FA richiesto",
        )
        .unwrap();
    manager
        .request_approval(
            &session.session_id,
            "user_1",
            "workspace_1",
            "submit_booking",
            "Invio prenotazione esterna",
        )
        .unwrap();

    let snapshot = manager
        .read_model()
        .snapshot(&session.session_id, "user_1", "workspace_1")
        .unwrap()
        .unwrap();

    assert_eq!(snapshot.takeover_state, TakeoverState::Requested);
    assert_eq!(snapshot.approval_state, ApprovalState::WaitingUser);
    assert_eq!(
        snapshot.last_error_redacted.as_deref(),
        Some("Login o 2FA richiesto")
    );
}

fn session_create(session_id: &str, task_id: &str) -> ComputerSessionCreate {
    ComputerSessionCreate {
        session_id: session_id.to_string(),
        task_id: task_id.to_string(),
        workflow_id: Some("workflow_fixture".to_string()),
        user_id: "user_1".to_string(),
        workspace_id: "workspace_1".to_string(),
        title: "Computer locale".to_string(),
        subtitle: "Fixture session".to_string(),
        risk_level: "medium".to_string(),
        progress_total: 3,
    }
}
