use local_first_local_computer_session::{
    ComputerEventCreate, ComputerSessionCreate, LocalComputerSessionManager,
    LocalComputerSessionStore, SessionStatus, SurfaceKind,
};
use serde_json::json;

#[test]
fn store_persists_session_surfaces_events_and_schema() {
    let store = LocalComputerSessionStore::open_in_memory().unwrap();
    assert_eq!(store.schema_version().unwrap(), 1);

    let manager = LocalComputerSessionManager::new(store);
    let session = manager
        .create_session(ComputerSessionCreate {
            session_id: "session_train".to_string(),
            task_id: "task_train".to_string(),
            workflow_id: Some("workflow_trip".to_string()),
            user_id: "user_1".to_string(),
            workspace_id: "workspace_1".to_string(),
            title: "Computer locale".to_string(),
            subtitle: "Ricerca treni con browser e verifica shell".to_string(),
            risk_level: "medium".to_string(),
            progress_total: 3,
        })
        .unwrap();

    manager
        .start_surface(&session.session_id, SurfaceKind::Browser, "Browser locale")
        .unwrap();
    manager
        .append_event(ComputerEventCreate {
            session_id: session.session_id.clone(),
            surface: SurfaceKind::Browser,
            kind: "computer_action_started".to_string(),
            status: "running".to_string(),
            title: "Aprire risultati treni".to_string(),
            subtitle: "Navigazione su dominio consentito".to_string(),
            payload: json!({ "url": "https://example.test/search?token=secret" }),
            artifact_refs: vec![],
            approval_required: false,
        })
        .unwrap();

    let loaded = manager
        .store()
        .session(&session.session_id, "user_1", "workspace_1")
        .unwrap()
        .unwrap();
    let events = manager
        .store()
        .events_for_session(&session.session_id, "user_1", "workspace_1")
        .unwrap();

    assert_eq!(loaded.status, SessionStatus::Running);
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].kind, "computer_session_started");
    assert_eq!(events[1].kind, "computer_surface_started");
    assert_eq!(events[2].title, "Aprire risultati treni");
}
