use local_first_memory::{
    DataSensitivity, MemoryEntity, MemoryEvent, MemoryEvidence, MemoryRecord, MemoryRef,
    MemoryRefKind, MemoryRelation, MemoryStatus, PrivacyDomain, SQLiteMemoryStore, UserId,
    WorkspaceId,
};

#[test]
fn store_round_trips_events_and_isolates_users() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let event = event("user_1", "workspace_1", "evt_1");

    store.record_event(&event).unwrap();

    assert_eq!(
        store
            .get_event(
                &event.reference,
                &UserId::new("user_1"),
                &WorkspaceId::new("workspace_1")
            )
            .unwrap(),
        Some(event)
    );
    assert_eq!(
        store
            .get_event(
                &event_ref("user_1", "workspace_1", "evt_1"),
                &UserId::new("user_2"),
                &WorkspaceId::new("workspace_1")
            )
            .unwrap(),
        None
    );
}

#[test]
fn store_upserts_memories_and_applies_tombstones() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let mut memory = memory("user_1", "workspace_1", "mem_1");

    store.upsert_memory(&memory).unwrap();
    memory.status = MemoryStatus::Confirmed;
    memory.confidence = 0.91;
    store.upsert_memory(&memory).unwrap();

    let loaded = store
        .get_memory(&memory.reference, &memory.user_id, &memory.workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(loaded.status, MemoryStatus::Confirmed);
    assert_eq!(loaded.confidence, 0.91);

    store
        .tombstone(
            &memory.reference,
            &memory.user_id,
            &memory.workspace_id,
            "user deleted",
        )
        .unwrap();

    assert_eq!(
        store
            .get_memory(&memory.reference, &memory.user_id, &memory.workspace_id)
            .unwrap(),
        None
    );
}

#[test]
fn store_links_entities_relations_and_evidence() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let project = entity("user_1", "workspace_1", "project:acme", "project", "Acme");
    let tool = entity("user_1", "workspace_1", "tool:zed", "tool", "Zed");
    let relation = relation(
        "user_1",
        "workspace_1",
        "rel_1",
        project.reference.clone(),
        "uses_tool",
        tool.reference.clone(),
    );
    let memory = memory("user_1", "workspace_1", "mem_1");
    let event = event("user_1", "workspace_1", "evt_1");

    store.upsert_entity(&project).unwrap();
    store.upsert_entity(&tool).unwrap();
    store.upsert_relation(&relation).unwrap();
    store.upsert_memory(&memory).unwrap();
    store.record_event(&event).unwrap();
    store
        .link_evidence(&MemoryEvidence {
            memory_ref: memory.reference.clone(),
            evidence_ref: event.reference.clone(),
            note: "Observed while opening the project".to_string(),
        })
        .unwrap();

    assert_eq!(
        store
            .relations_for(&project.reference, &project.user_id, &project.workspace_id)
            .unwrap(),
        vec![relation]
    );
    assert_eq!(
        store
            .evidence_for(&memory.reference, &memory.user_id, &memory.workspace_id)
            .unwrap()[0]
            .evidence_ref,
        event.reference
    );
}

fn event(user: &str, workspace: &str, key: &str) -> MemoryEvent {
    MemoryEvent {
        reference: event_ref(user, workspace, key),
        user_id: UserId::new(user),
        workspace_id: WorkspaceId::new(workspace),
        timestamp: "2026-05-23T08:00:00Z".to_string(),
        source: "desktop".to_string(),
        event_type: "open_app".to_string(),
        payload: serde_json::json!({"app": "Zed"}),
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
    }
}

fn memory(user: &str, workspace: &str, key: &str) -> MemoryRecord {
    MemoryRecord {
        reference: MemoryRef::new(
            MemoryRefKind::Memory,
            UserId::new(user),
            WorkspaceId::new(workspace),
            key,
        ),
        user_id: UserId::new(user),
        workspace_id: WorkspaceId::new(workspace),
        memory_type: "preference".to_string(),
        text: "Fabio prefers Zed for Acme work".to_string(),
        aliases: vec!["Zed preference".to_string()],
        language_hints: vec!["en".to_string(), "it".to_string()],
        confidence: 0.7,
        status: MemoryStatus::Candidate,
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
        metadata: serde_json::json!({}),
    }
}

fn entity(user: &str, workspace: &str, key: &str, entity_type: &str, name: &str) -> MemoryEntity {
    MemoryEntity {
        reference: MemoryRef::new(
            MemoryRefKind::Entity,
            UserId::new(user),
            WorkspaceId::new(workspace),
            key,
        ),
        user_id: UserId::new(user),
        workspace_id: WorkspaceId::new(workspace),
        entity_type: entity_type.to_string(),
        name: name.to_string(),
        canonical_key: key.to_string(),
        aliases: vec![],
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
        metadata: serde_json::json!({}),
    }
}

fn relation(
    user: &str,
    workspace: &str,
    key: &str,
    source_ref: MemoryRef,
    relation_type: &str,
    target_ref: MemoryRef,
) -> MemoryRelation {
    MemoryRelation {
        reference: MemoryRef::new(
            MemoryRefKind::Relation,
            UserId::new(user),
            WorkspaceId::new(workspace),
            key,
        ),
        user_id: UserId::new(user),
        workspace_id: WorkspaceId::new(workspace),
        source_ref,
        relation_type: relation_type.to_string(),
        target_ref,
        confidence: 0.8,
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
        evidence: vec![],
    }
}

fn event_ref(user: &str, workspace: &str, key: &str) -> MemoryRef {
    MemoryRef::new(
        MemoryRefKind::Event,
        UserId::new(user),
        WorkspaceId::new(workspace),
        key,
    )
}
