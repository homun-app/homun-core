use local_first_memory::{
    DataSensitivity, MemoryCreateRequest, MemoryFacade, MemoryLifecycleRequest, MemoryRef,
    MemoryRefKind, MemoryStatus, MemoryUpdatePatch, PrivacyDomain, SQLiteMemoryStore, UserId,
    WorkspaceId,
};

#[test]
fn facade_creates_and_updates_candidate_memory_with_audit() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let request = write_request();

    let created = facade
        .create_memory_candidate(MemoryCreateRequest {
            request: request.clone(),
            memory_type: "preference".to_string(),
            text: "Fabio uses VS Code".to_string(),
            aliases: vec![],
            language_hints: vec!["en".to_string()],
            confidence: 0.6,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: DataSensitivity::Private,
            evidence_refs: vec![],
            metadata: serde_json::json!({"source": "ui"}),
        })
        .unwrap();

    assert_eq!(created.status, MemoryStatus::Candidate);
    assert_eq!(created.created_at, created.updated_at);
    assert_eq!(
        created.last_seen_at.as_deref(),
        Some(created.created_at.as_str())
    );

    let updated = facade
        .update_memory(
            &request,
            &created.reference,
            MemoryUpdatePatch {
                text: Some("Fabio prefers Zed".to_string()),
                aliases: Some(vec!["editor preference".to_string()]),
                language_hints: None,
                confidence: Some(0.92),
                privacy_domain: None,
                sensitivity: None,
                metadata: Some(serde_json::json!({"source": "manual"})),
                last_seen_at: Some("2026-05-23T09:00:00Z".to_string()),
            },
        )
        .unwrap();

    assert_eq!(updated.text, "Fabio prefers Zed");
    assert_eq!(updated.aliases, vec!["editor preference"]);
    assert_eq!(updated.confidence, 0.92);
    assert_eq!(updated.created_at, created.created_at);
    assert_ne!(updated.updated_at, created.updated_at);
    assert_eq!(
        updated.last_seen_at.as_deref(),
        Some("2026-05-23T09:00:00Z")
    );
    // Access audit is intentionally disabled (see facade tests aligned to 0): the
    // read path no longer records audit rows, so the count is always 0.
    assert_eq!(facade.access_audit_count().unwrap(), 0);
}

#[test]
fn facade_enforces_lifecycle_transitions() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let request = write_request();
    let memory = create_candidate(&facade, &request, "Candidate memory");

    let confirmed = facade
        .confirm_memory(&request, &memory.reference, "user confirmed")
        .unwrap();
    assert_eq!(confirmed.status, MemoryStatus::Confirmed);

    let rejected = facade.reject_memory(&request, &memory.reference, "too late");
    assert_eq!(rejected.unwrap_err(), "cannot reject confirmed memory");

    let stale = facade
        .mark_memory_stale(&request, &memory.reference, "no longer true")
        .unwrap();
    assert_eq!(stale.status, MemoryStatus::Stale);
}

#[test]
fn facade_merges_memories_and_tracks_supersession_refs() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let request = write_request();
    let canonical = create_candidate(&facade, &request, "Canonical memory");
    let duplicate = create_candidate(&facade, &request, "Duplicate memory");

    let merged = facade
        .merge_memories(
            &request,
            &canonical.reference,
            vec![duplicate.reference.clone()],
            "same fact",
        )
        .unwrap();

    assert_eq!(merged.supersedes, vec![duplicate.reference.clone()]);
    let loaded_duplicate = facade
        .get_memory_for_ui(
            &duplicate.reference,
            &request.user_id,
            &request.workspace_id,
        )
        .unwrap()
        .unwrap();
    assert_eq!(loaded_duplicate.superseded_by, Some(canonical.reference));
}

#[test]
fn facade_tombstones_memory_and_rejects_cross_user_delete() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let request = write_request();
    let memory = create_candidate(&facade, &request, "Delete me");

    let other_user_request = MemoryLifecycleRequest {
        actor_id: "ui".to_string(),
        user_id: UserId::new("user_2"),
        workspace_id: WorkspaceId::new("workspace_1"),
        purpose: "test".to_string(),
    };

    let denied = facade.delete_memory(&other_user_request, &memory.reference, "wrong user");
    assert_eq!(
        denied.unwrap_err(),
        "cannot access ref outside user/workspace"
    );

    facade
        .delete_memory(&request, &memory.reference, "user deleted")
        .unwrap();
    assert!(
        facade
            .get_memory_for_ui(&memory.reference, &request.user_id, &request.workspace_id)
            .unwrap()
            .is_none()
    );
}

fn create_candidate(
    facade: &MemoryFacade,
    request: &MemoryLifecycleRequest,
    text: &str,
) -> local_first_memory::MemoryRecord {
    facade
        .create_memory_candidate(MemoryCreateRequest {
            request: request.clone(),
            memory_type: "fact".to_string(),
            text: text.to_string(),
            aliases: vec![],
            language_hints: vec!["en".to_string()],
            confidence: 0.7,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: DataSensitivity::Private,
            evidence_refs: vec![MemoryRef::new(
                MemoryRefKind::Event,
                request.user_id.clone(),
                request.workspace_id.clone(),
                "event_1",
            )],
            metadata: serde_json::json!({}),
        })
        .unwrap()
}

fn write_request() -> MemoryLifecycleRequest {
    MemoryLifecycleRequest {
        actor_id: "ui".to_string(),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        purpose: "memory lifecycle test".to_string(),
    }
}
