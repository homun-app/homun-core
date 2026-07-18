use local_first_memory::{
    DataSensitivity, MemoryEvolutionKind, MemoryEvolutionMetadata, MemoryEvolutionProposal,
    MemoryRecord, MemoryRef, MemoryRefKind, MemoryStatus, PrivacyDomain, RelationKind, UserId,
    WorkspaceId, memory_evolution_metadata, memory_is_current_at, prepare_memory_evolution_record,
    write_memory_evolution_metadata,
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
