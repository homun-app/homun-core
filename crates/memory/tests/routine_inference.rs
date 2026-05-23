use local_first_memory::{
    DataSensitivity, MemoryFacade, MemoryRef, MemoryRefKind, PrivacyDomain, RoutineInference,
    RoutineStatus, SQLiteMemoryStore, UserId, WorkspaceId,
};

#[test]
fn facade_imports_routine_inference_candidates_with_evidence() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let event_ref = MemoryRef::new(
        MemoryRefKind::Event,
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        "event_1",
    );
    let inference: RoutineInference = serde_json::from_value(serde_json::json!({
        "routines": [{
            "name": "Morning Acme startup",
            "intent": "Open Acme workspace and check project state",
            "confidence": 0.82,
            "schedule_hint": {"period": "weekday_morning"},
            "privacy_domain": "work",
            "sensitivity": "private",
            "evidence_refs": [event_ref.to_string()],
            "metadata": {"source_agent": "MemoryAgent"}
        }]
    }))
    .unwrap();

    let summary = facade
        .apply_routine_inference(
            &UserId::new("user_1"),
            &WorkspaceId::new("workspace_1"),
            inference,
        )
        .unwrap();

    assert_eq!(summary.routines_imported, 1);
    let routine = facade
        .get_routine_for_test(
            &summary.routine_refs[0],
            &UserId::new("user_1"),
            &WorkspaceId::new("workspace_1"),
        )
        .unwrap()
        .unwrap();
    assert_eq!(routine.status, RoutineStatus::Candidate);
    assert_eq!(routine.evidence, vec![event_ref]);
    assert_eq!(routine.privacy_domain, PrivacyDomain::new("work"));
    assert_eq!(routine.sensitivity, DataSensitivity::Private);
}
