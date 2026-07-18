use local_first_memory::{
    DataSensitivity, MemoryEvent, MemoryEvolutionKind, MemoryEvolutionMetadata,
    MemoryEvolutionProposal, MemoryFacade, MemoryRecord, MemoryRef, MemoryRefKind, MemoryStatus,
    PrivacyDomain, RelationKind, SQLiteMemoryStore, UserId, WorkspaceId, memory_evolution_metadata,
    memory_is_current_at, prepare_memory_evolution_record, write_memory_evolution_metadata,
};

fn memory(workspace: &str, text: &str) -> MemoryRecord {
    let user = UserId::new("local-user");
    let workspace = WorkspaceId::new(workspace);
    MemoryRecord {
        reference: MemoryRef::generated(MemoryRefKind::Memory, user.clone(), workspace.clone()),
        user_id: user,
        workspace_id: workspace,
        memory_type: "fact".to_string(),
        text: text.to_string(),
        aliases: Vec::new(),
        language_hints: vec!["it".to_string()],
        confidence: 0.9,
        status: MemoryStatus::Confirmed,
        privacy_domain: PrivacyDomain::new("personal"),
        sensitivity: DataSensitivity::Internal,
        metadata: serde_json::json!({"source":"test"}),
        created_at: "unix:100".to_string(),
        updated_at: "unix:100".to_string(),
        last_seen_at: Some("unix:100".to_string()),
        supersedes: Vec::new(),
        superseded_by: None,
        correction_of: None,
    }
}

fn metadata(kind: MemoryEvolutionKind, targets: Vec<MemoryRef>) -> MemoryEvolutionMetadata {
    MemoryEvolutionMetadata {
        kind,
        target_refs: targets,
        valid_from: Some(100),
        valid_until: Some(200),
        last_confirmed_at: Some(110),
        reinforcement_count: 1,
        classifier: "extractor-v1".to_string(),
        classifier_confidence: 0.91,
    }
}

#[test]
fn evolution_contract_round_trips_without_overwriting_other_metadata() {
    let target = memory("project-a", "old fact");
    let evolution = metadata(MemoryEvolutionKind::Updates, vec![target.reference]);
    let mut value = serde_json::json!({"source":"conversation","certainty":"committed"});

    write_memory_evolution_metadata(&mut value, &evolution).unwrap();

    assert_eq!(memory_evolution_metadata(&value).unwrap(), Some(evolution));
    assert_eq!(value["source"], "conversation");
    assert_eq!(value["certainty"], "committed");
}

#[test]
fn evolution_contract_rejects_an_inverted_temporal_range() {
    let mut evolution = metadata(MemoryEvolutionKind::Independent, Vec::new());
    evolution.valid_from = Some(201);
    evolution.valid_until = Some(200);
    let mut value = serde_json::json!({});

    let error = write_memory_evolution_metadata(&mut value, &evolution).unwrap_err();

    assert!(error.contains("valid_until"), "{error}");
    assert!(value.get("evolution").is_none());
}

#[test]
fn current_predicate_excludes_superseded_expired_and_terminal_records() {
    let mut record = memory("project-a", "current fact");
    write_memory_evolution_metadata(
        &mut record.metadata,
        &metadata(MemoryEvolutionKind::Independent, Vec::new()),
    )
    .unwrap();

    assert!(!memory_is_current_at(&record, 99, true));
    assert!(memory_is_current_at(&record, 199, true));
    assert!(!memory_is_current_at(&record, 200, true));

    record.metadata["evolution"]["valid_until"] = serde_json::Value::Null;
    record.superseded_by = Some(memory("project-a", "replacement").reference);
    assert!(!memory_is_current_at(&record, 199, true));

    record.superseded_by = None;
    record.status = MemoryStatus::Stale;
    assert!(!memory_is_current_at(&record, 199, true));

    record.status = MemoryStatus::Candidate;
    assert!(memory_is_current_at(&record, 199, true));
    assert!(!memory_is_current_at(&record, 199, false));
}

#[test]
fn evolution_contract_rejects_cross_scope_targets() {
    let new_record = memory("project-a", "new fact");
    let other_scope = memory("project-b", "old fact");
    let proposal = MemoryEvolutionProposal {
        request_id: "request-1".to_string(),
        record: new_record,
        evolution: metadata(
            MemoryEvolutionKind::Updates,
            vec![other_scope.reference.clone()],
        ),
    };

    let error = prepare_memory_evolution_record(&proposal, &[other_scope]).unwrap_err();

    assert!(error.contains("scope"), "{error}");
}

#[test]
fn derived_memory_is_always_a_candidate_with_structural_provenance() {
    let source = memory("project-a", "The user works on payments");
    let proposal = MemoryEvolutionProposal {
        request_id: "request-derive".to_string(),
        record: memory("project-a", "The user probably owns the payments roadmap"),
        evolution: metadata(MemoryEvolutionKind::Derives, vec![source.reference.clone()]),
    };

    let prepared = prepare_memory_evolution_record(&proposal, &[source.clone()]).unwrap();

    assert_eq!(prepared.status, MemoryStatus::Candidate);
    assert_eq!(
        memory_evolution_metadata(&prepared.metadata)
            .unwrap()
            .unwrap()
            .target_refs,
        vec![source.reference]
    );
    assert_eq!(RelationKind::Extends.as_str(), "extends");
    assert_eq!(RelationKind::ConflictsWith.as_str(), "conflicts_with");
}

fn facade() -> MemoryFacade {
    MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap())
}

fn proposal(
    request_id: &str,
    kind: MemoryEvolutionKind,
    record: MemoryRecord,
    targets: Vec<MemoryRef>,
) -> MemoryEvolutionProposal {
    let mut evolution = metadata(kind, targets);
    evolution.valid_until = None;
    MemoryEvolutionProposal {
        request_id: request_id.to_string(),
        record,
        evolution,
    }
}

#[test]
fn duplicate_reinforces_without_creating_a_row_and_replay_is_idempotent() {
    let facade = facade();
    let target = memory("project-a", "The launch is Friday");
    facade.upsert_memory(&target).unwrap();
    let request = proposal(
        "request-duplicate",
        MemoryEvolutionKind::Duplicate,
        memory("project-a", "Launch happens Friday"),
        vec![target.reference.clone()],
    );

    let first = facade.evolve_memory(request.clone()).unwrap();
    let replay = facade.evolve_memory(request).unwrap();
    let stored = facade
        .get_memory_for_ui(&target.reference, &target.user_id, &target.workspace_id)
        .unwrap()
        .unwrap();
    let evolution = memory_evolution_metadata(&stored.metadata)
        .unwrap()
        .unwrap();

    assert!(!first.created);
    assert_eq!(first, replay);
    assert_eq!(
        facade
            .list_memories_for_ui(&target.user_id, &target.workspace_id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(evolution.reinforcement_count, 2);
    assert!(evolution.last_confirmed_at.is_some());
    assert!(stored.confidence > target.confidence);
}

#[test]
fn update_supersedes_old_memory_and_creates_traversable_history() {
    let facade = facade();
    let old = memory("project-a", "The launch is Friday");
    facade.upsert_memory(&old).unwrap();
    let request = proposal(
        "request-update",
        MemoryEvolutionKind::Updates,
        memory("project-a", "The launch is Monday"),
        vec![old.reference.clone()],
    );

    let result = facade.evolve_memory(request).unwrap();
    let stored_old = facade
        .get_memory_for_ui(&old.reference, &old.user_id, &old.workspace_id)
        .unwrap()
        .unwrap();
    let relations = facade
        .list_relations_for_ui(&old.user_id, &old.workspace_id)
        .unwrap();

    assert!(result.created);
    assert_eq!(
        stored_old.superseded_by,
        Some(result.record.reference.clone())
    );
    assert_eq!(result.record.supersedes, vec![old.reference.clone()]);
    assert!(relations.iter().any(|relation| {
        relation.relation_type == RelationKind::Supersedes.as_str()
            && relation.source_ref == result.record.reference
            && relation.target_ref == old.reference
    }));
}

#[test]
fn extension_keeps_both_current_and_derivation_stays_reviewable() {
    let facade = facade();
    let source = memory("project-a", "The payments team owns checkout");
    facade.upsert_memory(&source).unwrap();

    let extension = facade
        .evolve_memory(proposal(
            "request-extend",
            MemoryEvolutionKind::Extends,
            memory("project-a", "The payments team also owns refunds"),
            vec![source.reference.clone()],
        ))
        .unwrap();
    let derived = facade
        .evolve_memory(proposal(
            "request-derive",
            MemoryEvolutionKind::Derives,
            memory("project-a", "Payments probably owns the revenue roadmap"),
            vec![source.reference.clone(), extension.record.reference.clone()],
        ))
        .unwrap();
    let relations = facade
        .list_relations_for_ui(&source.user_id, &source.workspace_id)
        .unwrap();
    let evidence = facade
        .evidence_for_ui(
            &derived.record.reference,
            &source.user_id,
            &source.workspace_id,
        )
        .unwrap();

    assert!(memory_is_current_at(&source, 150, false));
    assert!(memory_is_current_at(&extension.record, 150, false));
    assert_eq!(derived.record.status, MemoryStatus::Candidate);
    assert!(
        relations
            .iter()
            .any(|relation| relation.relation_type == "extends")
    );
    assert_eq!(evidence.len(), 2);
}

#[test]
fn conflict_never_selects_a_winner_and_secret_input_is_rejected() {
    let facade = facade();
    let target = memory("project-a", "The launch is Friday");
    facade.upsert_memory(&target).unwrap();

    let conflict = facade
        .evolve_memory(proposal(
            "request-conflict",
            MemoryEvolutionKind::Conflict,
            memory("project-a", "The launch is Monday"),
            vec![target.reference.clone()],
        ))
        .unwrap();
    assert_eq!(conflict.record.status, MemoryStatus::Candidate);
    assert!(
        facade
            .get_memory_for_ui(&target.reference, &target.user_id, &target.workspace_id)
            .unwrap()
            .unwrap()
            .superseded_by
            .is_none()
    );

    let mut secret = memory("project-a", "password: test-only-value");
    secret.sensitivity = DataSensitivity::Secret;
    let error = facade
        .evolve_memory(proposal(
            "request-secret",
            MemoryEvolutionKind::Independent,
            secret,
            Vec::new(),
        ))
        .unwrap_err();
    assert!(error.to_string().contains("Vault"), "{error}");
}

#[test]
fn failed_event_write_rolls_back_memory_relations_and_supersession() {
    let facade = facade();
    let old = memory("project-a", "The launch is Friday");
    let replacement = memory("project-a", "The launch is Monday");
    facade.upsert_memory(&old).unwrap();
    facade
        .record_event(&MemoryEvent {
            reference: MemoryRef::new(
                MemoryRefKind::Event,
                old.user_id.clone(),
                old.workspace_id.clone(),
                "memory-evolution:request-rollback",
            ),
            user_id: old.user_id.clone(),
            workspace_id: old.workspace_id.clone(),
            timestamp: "unix:100".to_string(),
            source: "rollback-fixture".to_string(),
            event_type: "fixture".to_string(),
            payload: serde_json::json!({}),
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: DataSensitivity::Internal,
        })
        .unwrap();

    let error = facade
        .evolve_memory(proposal(
            "request-rollback",
            MemoryEvolutionKind::Updates,
            replacement.clone(),
            vec![old.reference.clone()],
        ))
        .unwrap_err();

    assert!(error.to_string().contains("UNIQUE"), "{error}");
    assert!(
        facade
            .get_memory_for_ui(&replacement.reference, &old.user_id, &old.workspace_id)
            .unwrap()
            .is_none()
    );
    assert!(
        facade
            .get_memory_for_ui(&old.reference, &old.user_id, &old.workspace_id)
            .unwrap()
            .unwrap()
            .superseded_by
            .is_none()
    );
    assert!(
        facade
            .list_relations_for_ui(&old.user_id, &old.workspace_id)
            .unwrap()
            .is_empty()
    );
}
