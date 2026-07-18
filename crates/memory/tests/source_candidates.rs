use local_first_memory::{
    DataSensitivity, MemoryFacade, MemoryRecord, MemoryRef, MemoryRefKind, MemoryStatus,
    PrivacyDomain, SQLiteMemoryStore, UserId, WorkspaceId,
};

fn record(
    user: &str,
    workspace: &str,
    key: &str,
    status: MemoryStatus,
    sensitivity: DataSensitivity,
) -> MemoryRecord {
    let user_id = UserId::new(user);
    let workspace_id = WorkspaceId::new(workspace);
    MemoryRecord {
        reference: MemoryRef::new(
            MemoryRefKind::Memory,
            user_id.clone(),
            workspace_id.clone(),
            key,
        ),
        user_id,
        workspace_id,
        memory_type: "note".to_string(),
        text: format!("text for {key}"),
        aliases: vec!["must not be projected".to_string()],
        language_hints: vec!["en".to_string()],
        confidence: 0.9,
        status,
        privacy_domain: PrivacyDomain::new("personal"),
        sensitivity,
        metadata: serde_json::json!({"key": key}),
        created_at: "2026-07-17T10:00:00Z".to_string(),
        updated_at: "2026-07-17T10:00:00Z".to_string(),
        last_seen_at: None,
        supersedes: Vec::new(),
        superseded_by: None,
        correction_of: None,
    }
}

#[test]
fn source_candidate_projection_is_scope_exact_active_non_secret_and_size_bounded() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let owner = UserId::new("owner");
    let source = WorkspaceId::new("source");

    for item in [
        record(
            "owner",
            "source",
            "candidate",
            MemoryStatus::Candidate,
            DataSensitivity::Internal,
        ),
        record(
            "owner",
            "source",
            "confirmed",
            MemoryStatus::Confirmed,
            DataSensitivity::Private,
        ),
        record(
            "owner",
            "source",
            "stale",
            MemoryStatus::Stale,
            DataSensitivity::Internal,
        ),
        record(
            "owner",
            "source",
            "rejected",
            MemoryStatus::Rejected,
            DataSensitivity::Internal,
        ),
        record(
            "owner",
            "source",
            "deleted",
            MemoryStatus::Deleted,
            DataSensitivity::Internal,
        ),
        record(
            "owner",
            "source",
            "secret",
            MemoryStatus::Confirmed,
            DataSensitivity::Secret,
        ),
        record(
            "owner",
            "other-workspace",
            "wrong-workspace",
            MemoryStatus::Confirmed,
            DataSensitivity::Internal,
        ),
        record(
            "other-user",
            "source",
            "wrong-user",
            MemoryStatus::Confirmed,
            DataSensitivity::Internal,
        ),
    ] {
        facade.upsert_memory(&item).unwrap();
    }

    let tombstoned = record(
        "owner",
        "source",
        "tombstoned",
        MemoryStatus::Confirmed,
        DataSensitivity::Internal,
    );
    facade.upsert_memory(&tombstoned).unwrap();
    facade
        .tombstone_ref(
            &tombstoned.reference,
            &owner,
            &source,
            "candidate picker test",
        )
        .unwrap();

    let mut oversized_text = record(
        "owner",
        "source",
        "oversized-text",
        MemoryStatus::Confirmed,
        DataSensitivity::Internal,
    );
    oversized_text.text = "x".repeat(1_000_000);
    facade.upsert_memory(&oversized_text).unwrap();

    let mut oversized_metadata = record(
        "owner",
        "source",
        "oversized-metadata",
        MemoryStatus::Confirmed,
        DataSensitivity::Internal,
    );
    oversized_metadata.metadata = serde_json::json!({"blob": "x".repeat(1_000_000)});
    facade.upsert_memory(&oversized_metadata).unwrap();

    let candidates = facade
        .list_memory_source_candidates(&owner, &source, 0, 1_000)
        .unwrap();
    assert_eq!(
        candidates
            .iter()
            .map(|candidate| candidate.reference.key.as_str())
            .collect::<Vec<_>>(),
        vec!["candidate", "confirmed"]
    );
    assert_eq!(candidates[0].memory_type, "note");
    assert_eq!(candidates[0].text, "text for candidate");
    assert_eq!(candidates[0].sensitivity, DataSensitivity::Internal);
    assert_eq!(
        candidates[0].metadata,
        serde_json::json!({"key": "candidate"})
    );
}

#[test]
fn source_candidate_projection_pages_deterministically_and_enforces_hard_limit() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let owner = UserId::new("owner");
    let source = WorkspaceId::new("source");
    for index in 0..130 {
        facade
            .upsert_memory(&record(
                "owner",
                "source",
                &format!("item-{index:03}"),
                MemoryStatus::Confirmed,
                DataSensitivity::Internal,
            ))
            .unwrap();
    }

    let first = facade
        .list_memory_source_candidates(&owner, &source, 10, 10)
        .unwrap();
    assert_eq!(first.len(), 10);
    assert_eq!(first.first().unwrap().reference.key, "item-010");
    assert_eq!(first.last().unwrap().reference.key, "item-019");

    let second = facade
        .list_memory_source_candidates(&owner, &source, 20, 10)
        .unwrap();
    assert_eq!(second.first().unwrap().reference.key, "item-020");
    assert_eq!(second.last().unwrap().reference.key, "item-029");

    let clamped = facade
        .list_memory_source_candidates(&owner, &source, 0, usize::MAX)
        .unwrap();
    assert_eq!(clamped.len(), 100);
    assert_eq!(clamped.last().unwrap().reference.key, "item-099");

    assert!(
        facade
            .list_memory_source_candidates(&owner, &source, 0, 0)
            .unwrap()
            .is_empty()
    );
}
