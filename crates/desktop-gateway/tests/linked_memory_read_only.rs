use local_first_memory::{
    DataSensitivity, Exchange, LearnHooks, LinkedMemoryReadRef, MemoryCollectionKey, MemoryFacade,
    MemoryRecord, MemoryRef, MemoryRefKind, MemoryReuseEnvelope, MemorySourceGrant, MemoryStatus,
    MemoryWritePolicy, PrivacyDomain, SQLiteMemoryStore, UserId, WorkspaceId,
    persist_learn_extraction, prepare_learn_prompt, recall_authorized_sources_on_facade,
};
use std::collections::{BTreeSet, HashMap};

const LINKED_SENTINEL: &str = "NEBULA-7429";

fn insert_memory(
    facade: &MemoryFacade,
    user: &UserId,
    workspace: &WorkspaceId,
    key: &str,
    text: &str,
) -> MemoryRef {
    let reference = MemoryRef::new(MemoryRefKind::Memory, user.clone(), workspace.clone(), key);
    facade
        .upsert_memory(&MemoryRecord {
            reference: reference.clone(),
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            memory_type: "fact".to_string(),
            text: text.to_string(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 1.0,
            status: MemoryStatus::Confirmed,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: DataSensitivity::Private,
            metadata: serde_json::json!({"scope":"project","source":"manual"}),
            created_at: "unix:1800000000".to_string(),
            updated_at: "unix:1800000000".to_string(),
            last_seen_at: None,
            supersedes: Vec::new(),
            superseded_by: None,
            correction_of: None,
        })
        .unwrap();
    facade
        .upsert_embedding(&reference, user, workspace, "fixture", &[1.0, 0.0])
        .unwrap();
    reference
}

#[test]
fn linked_recall_remains_read_only_across_learning_revocation_and_other_projects() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let user = UserId::new("owner");
    let source = WorkspaceId::new("source-project");
    let consumer = WorkspaceId::new("consumer-project");
    let isolated = WorkspaceId::new("isolated-project");
    let source_ref = insert_memory(
        &facade,
        &user,
        &source,
        "linked-sentinel",
        "Il codice collegato e NEBULA-7429",
    );
    facade
        .upsert_memory_source_grant(&MemorySourceGrant {
            id: "grant-source-consumer".to_string(),
            consumer_user_id: user.clone(),
            consumer_workspace_id: consumer.clone(),
            source_user_id: user.clone(),
            source_workspace_id: source.clone(),
            collections: BTreeSet::from([MemoryCollectionKey::Knowledge]),
            max_sensitivity: DataSensitivity::Private,
            overrides: HashMap::new(),
            expires_at: None,
            revoked_at: None,
            policy_version: 1,
            created_by: "owner".to_string(),
            created_at: "unix:1800000000".to_string(),
            updated_at: "unix:1800000000".to_string(),
        })
        .unwrap();

    let recalled = recall_authorized_sources_on_facade(
        &facade,
        &user,
        &consumer,
        "codice collegato",
        &[1.0, 0.0],
        1_800_000_000,
        None,
    )
    .unwrap();
    let hit = recalled
        .hits
        .iter()
        .find(|hit| hit.memory_ref == source_ref.to_string())
        .expect("authorized linked hit");
    assert!(hit.text.contains(LINKED_SENTINEL));
    let read = LinkedMemoryReadRef {
        source_workspace_id: source.as_str().to_string(),
        grant_id: hit.grant_id.clone().unwrap(),
        policy_version: hit.policy_version.unwrap(),
        memory_ref: hit.memory_ref.clone(),
        source_revision: hit.source_revision.clone(),
    };
    assert!(
        facade
            .validate_linked_memory_read(&user, &consumer, &read, 1_800_000_000)
            .unwrap()
    );

    let exchange = Exchange {
        user_message: "Nel consumer il colore locale e verde".to_string(),
        assistant_message: format!("Il codice collegato e {LINKED_SENTINEL}"),
        actions: format!("recall_memory returned {LINKED_SENTINEL}"),
        reuse_envelope: MemoryReuseEnvelope::user_input_only(vec![read.clone()]),
        ..Exchange::default()
    };
    let (_, learn_prompt) =
        prepare_learn_prompt(&facade, &user, &consumer, &exchange, Some("Consumer"))
            .expect("direct user input remains learnable");
    assert!(learn_prompt.contains("colore locale"));
    assert!(!learn_prompt.contains(LINKED_SENTINEL));

    let extracted_user_input = serde_json::json!({
        "memories": [{
            "memory_type": "fact",
            "text": "Nel consumer il colore locale e verde",
            "confidence": 0.95,
            "sensitivity": "internal",
            "metadata": {"scope":"project","source":"desktop_chat"}
        }],
        "entities": [],
        "relations": [],
        "episode": ""
    });
    assert!(persist_learn_extraction(
        &facade,
        &user,
        &consumer,
        &extracted_user_input.to_string(),
        Some("thread-linked"),
        MemoryWritePolicy::UserInputOnly,
        LearnHooks {
            persist_graph: None,
            store_episode: None,
            backfill_embeddings: None,
        },
    ));
    let consumer_memories = facade.list_memories_for_ui(&user, &consumer).unwrap();
    assert!(
        consumer_memories
            .iter()
            .any(|memory| memory.text.contains("colore locale"))
    );
    assert!(
        consumer_memories
            .iter()
            .all(|memory| !memory.text.contains(LINKED_SENTINEL))
    );

    facade
        .revoke_memory_source_grant(&user, &consumer, "grant-source-consumer", 1_800_000_001)
        .unwrap();
    assert!(
        !facade
            .validate_linked_memory_read(&user, &consumer, &read, 1_800_000_001)
            .unwrap()
    );
    let after_revoke = recall_authorized_sources_on_facade(
        &facade,
        &user,
        &consumer,
        "codice collegato",
        &[1.0, 0.0],
        1_800_000_001,
        None,
    )
    .unwrap();
    assert!(
        after_revoke
            .hits
            .iter()
            .all(|hit| !hit.text.contains(LINKED_SENTINEL))
    );
    let other_project = recall_authorized_sources_on_facade(
        &facade,
        &user,
        &isolated,
        "codice collegato",
        &[1.0, 0.0],
        1_800_000_001,
        None,
    )
    .unwrap();
    assert!(
        other_project
            .hits
            .iter()
            .all(|hit| !hit.text.contains(LINKED_SENTINEL))
    );
    assert!(
        facade
            .get_memory_for_ui(&source_ref, &user, &source)
            .unwrap()
            .is_some()
    );
}
