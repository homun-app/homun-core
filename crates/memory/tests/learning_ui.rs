use local_first_memory::{
    AutomationCandidateCreateRequest, AutomationCandidateStatus, AutomationRiskLevel,
    DataSensitivity, LearningUiReadModel, MemoryAccessRequest, MemoryEvent, MemoryExtraction,
    MemoryFacade, MemoryLifecycleRequest, MemoryRef, MemoryRefKind, PrivacyDomain,
    RoutineInference, SQLiteMemoryStore, UserId, WorkspaceId,
};

#[test]
fn learning_ui_combines_candidate_memories_routines_and_automation_proposals() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let event_ref = event_ref("evt_1");
    facade.record_event(&event(&event_ref)).unwrap();

    let extraction: MemoryExtraction = serde_json::from_value(serde_json::json!({
        "memories": [{
            "memory_type": "preference",
            "text": "Fabio wants travel searches compared before booking",
            "confidence": 0.78,
            "privacy_domain": "personal",
            "sensitivity": "private",
            "evidence_refs": [event_ref.to_string()],
            "metadata": {"learned_from": "browser_task"}
        }]
    }))
    .unwrap();
    facade
        .apply_extraction(&user, &workspace, extraction)
        .unwrap();

    let routine: RoutineInference = serde_json::from_value(serde_json::json!({
        "routines": [{
            "name": "Morning project briefing",
            "intent": "Prepare local git, task and notes summary before work starts",
            "confidence": 0.84,
            "schedule_hint": {"cadence": "weekday_morning"},
            "privacy_domain": "work",
            "sensitivity": "private",
            "evidence_refs": [event_ref.to_string()],
            "metadata": {"learned_from": "desktop_events"}
        }]
    }))
    .unwrap();
    let routine_summary = facade
        .apply_routine_inference(&user, &workspace, routine)
        .unwrap();

    let proposal = facade
        .propose_automation(AutomationCandidateCreateRequest {
            request: lifecycle_request(),
            routine_ref: Some(routine_summary.routine_refs[0].clone()),
            title: "Briefing mattutino progetto".to_string(),
            summary: "Prepara un riepilogo locale prima di iniziare il lavoro.".to_string(),
            trigger: "Giorni feriali alle 08:45".to_string(),
            actions: vec![
                "Legge repository locale".to_string(),
                "Raccoglie task aperti".to_string(),
                "Propone il riepilogo senza inviare nulla".to_string(),
            ],
            risk_level: AutomationRiskLevel::Low,
            autonomy_level: 2,
            status: AutomationCandidateStatus::Candidate,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: DataSensitivity::Private,
            evidence_refs: vec![event_ref.clone()],
            proposal_json: serde_json::json!({"source": "AutomationAgent"}),
        })
        .unwrap();

    let ui = LearningUiReadModel::new(&facade);
    let snapshot = ui
        .snapshot(&access_request(vec!["personal", "work"]))
        .unwrap();

    assert_eq!(snapshot.summary.learned_items, 2);
    assert_eq!(snapshot.summary.automation_candidates, 1);
    assert_eq!(snapshot.insights.len(), 2);
    assert!(
        snapshot
            .insights
            .iter()
            .all(|insight| !insight.evidence.is_empty())
    );
    assert!(
        snapshot
            .insights
            .iter()
            .any(|insight| insight.title == "Morning project briefing")
    );
    assert_eq!(
        snapshot.automation_proposals[0].reference,
        proposal.reference
    );
    assert_eq!(snapshot.automation_proposals[0].evidence, vec![event_ref]);
    assert_eq!(
        snapshot.automation_proposals[0].status,
        AutomationCandidateStatus::Candidate
    );
}

#[test]
fn learning_ui_applies_privacy_domains_before_exposing_learned_items() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let work_event = event_ref("evt_work");
    let personal_event = event_ref("evt_personal");

    let extraction: MemoryExtraction = serde_json::from_value(serde_json::json!({
        "memories": [
            {
                "memory_type": "preference",
                "text": "Work insight",
                "confidence": 0.8,
                "privacy_domain": "work",
                "sensitivity": "private",
                "evidence_refs": [work_event.to_string()]
            },
            {
                "memory_type": "preference",
                "text": "Personal insight",
                "confidence": 0.8,
                "privacy_domain": "personal",
                "sensitivity": "private",
                "evidence_refs": [personal_event.to_string()]
            }
        ]
    }))
    .unwrap();
    facade
        .apply_extraction(&user, &workspace, extraction)
        .unwrap();

    let ui = LearningUiReadModel::new(&facade);
    let snapshot = ui.snapshot(&access_request(vec!["work"])).unwrap();

    assert_eq!(snapshot.insights.len(), 1);
    assert_eq!(snapshot.insights[0].summary, "Work insight");
    assert_eq!(snapshot.summary.hidden_by_policy, 1);
}

fn lifecycle_request() -> MemoryLifecycleRequest {
    MemoryLifecycleRequest {
        actor_id: "AutomationAgent".to_string(),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        purpose: "propose automation".to_string(),
    }
}

fn access_request(domains: Vec<&str>) -> MemoryAccessRequest {
    MemoryAccessRequest {
        actor_id: "learning_ui".to_string(),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        purpose: "show learned habits and automation candidates".to_string(),
        allowed_domains: domains.into_iter().map(PrivacyDomain::new).collect(),
        max_sensitivity: DataSensitivity::Private,
        allow_raw_payload: false,
        allow_export: false,
        broad_query: false,
    }
}

fn event(reference: &MemoryRef) -> MemoryEvent {
    MemoryEvent {
        reference: reference.clone(),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        timestamp: "2026-05-23T10:00:00Z".to_string(),
        source: "browser".to_string(),
        event_type: "task_observed".to_string(),
        payload: serde_json::json!({"raw": "must not be exposed in learning ui"}),
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
    }
}

fn event_ref(key: &str) -> MemoryRef {
    MemoryRef::new(
        MemoryRefKind::Event,
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        key,
    )
}
