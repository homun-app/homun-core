use local_first_local_computer_session::{
    ArtifactCreate, ComputerEventCreate, ComputerSessionCreate, LocalComputerSessionManager,
    LocalComputerSessionStore, SurfaceKind,
};
use serde_json::json;

#[test]
fn read_model_redacts_browser_shell_artifacts_and_raw_payloads() {
    let manager =
        LocalComputerSessionManager::new(LocalComputerSessionStore::open_in_memory().unwrap());
    let session = manager
        .create_session(ComputerSessionCreate {
            session_id: "session_sensitive".to_string(),
            task_id: "task_sensitive".to_string(),
            workflow_id: None,
            user_id: "user_1".to_string(),
            workspace_id: "workspace_1".to_string(),
            title: "Computer locale".to_string(),
            subtitle: "Operazione con dati sensibili".to_string(),
            risk_level: "high".to_string(),
            progress_total: 4,
        })
        .unwrap();

    manager
        .append_event(ComputerEventCreate {
            session_id: session.session_id.clone(),
            surface: SurfaceKind::Browser,
            kind: "computer_frame_captured".to_string(),
            status: "done".to_string(),
            title: "Pagina account".to_string(),
            subtitle: "https://bank.example/account?token=abc&email=fabio@example.com".to_string(),
            payload: json!({
                "url": "https://bank.example/account?token=abc&email=fabio@example.com",
                "dom_snapshot": "<input name=password value=hunter2>",
                "form_fields": { "password": "hunter2" }
            }),
            artifact_refs: vec![],
            approval_required: false,
        })
        .unwrap();
    manager
        .append_terminal_output(
            &session.session_id,
            "user_1",
            "workspace_1",
            "TOKEN=sk-live-secret password=hunter2\nvalidazione completata",
        )
        .unwrap();
    manager
        .create_artifact(ArtifactCreate {
            session_id: session.session_id.clone(),
            artifact_id: "artifact_secret".to_string(),
            title: "report-token-sk-live-secret.pdf".to_string(),
            kind: "pdf".to_string(),
            path_ref: "/private/tmp/report-token-sk-live-secret.pdf".to_string(),
            size_bytes: 2048,
            preview_ref: Some("preview-secret".to_string()),
        })
        .unwrap();

    let snapshot = manager
        .read_model()
        .snapshot(&session.session_id, "user_1", "workspace_1")
        .unwrap()
        .unwrap();
    let serialized = serde_json::to_string(&snapshot).unwrap();

    assert_eq!(
        snapshot.current_url_redacted.as_deref(),
        Some("https://bank.example/account")
    );
    assert!(
        snapshot
            .terminal_excerpt_redacted
            .join("\n")
            .contains("[REDACTED]")
    );
    assert!(!serialized.contains("hunter2"));
    assert!(!serialized.contains("sk-live-secret"));
    assert!(!serialized.contains("fabio@example.com"));
    assert!(!serialized.contains("dom_snapshot"));
    assert!(!serialized.contains("/private/tmp"));
    assert!(snapshot.timeline.iter().all(|item| item.payload_redacted));
}
