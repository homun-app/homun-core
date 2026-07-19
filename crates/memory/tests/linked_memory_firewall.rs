use local_first_memory::{
    Exchange, LearnHooks, LinkedMemoryReadRef, MemoryFacade, MemoryReuseEnvelope,
    MemoryWritePolicy, SQLiteMemoryStore, UserId, WorkspaceId, persist_learn_extraction,
    prepare_learn_prompt,
};

fn linked_read() -> LinkedMemoryReadRef {
    LinkedMemoryReadRef {
        source_workspace_id: "personal".to_string(),
        grant_id: "grant-personal-project".to_string(),
        policy_version: 4,
        memory_ref: "memory:owner:personal:fact-nebula".to_string(),
        source_revision: "sha256:revision".to_string(),
    }
}

#[test]
fn linked_turn_exposes_only_direct_user_input_to_the_extractor() {
    let exchange = Exchange {
        user_message: "Il mio colore locale e verde".into(),
        assistant_message: "Il codice collegato e NEBULA-7429".into(),
        actions: "recall_memory returned NEBULA-7429".into(),
        prev_assistant: Some("La memoria collegata dice NEBULA-7429".into()),
        reuse_envelope: MemoryReuseEnvelope::user_input_only(vec![linked_read()]),
        ..Exchange::default()
    };

    let material = exchange
        .learn_material()
        .expect("user input remains learnable");

    assert_eq!(material.user_message, "Il mio colore locale e verde");
    assert!(material.assistant_message.is_empty());
    assert!(material.actions.is_empty());
    assert!(material.prev_assistant.is_none());
}

#[test]
fn linked_payload_is_absent_from_the_extractor_prompt() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let user = UserId::new("owner");
    let workspace = WorkspaceId::new("project-a");
    let exchange = Exchange {
        user_message: "Il mio colore locale e verde".into(),
        assistant_message: "Il codice collegato e NEBULA-7429".into(),
        actions: "recall_memory returned NEBULA-7429".into(),
        prev_assistant: Some("La memoria collegata dice NEBULA-7429".into()),
        reuse_envelope: MemoryReuseEnvelope::user_input_only(vec![linked_read()]),
        ..Exchange::default()
    };

    let (_system, prompt) =
        prepare_learn_prompt(&facade, &user, &workspace, &exchange, Some("Project A"))
            .expect("salient user input produces an extractor prompt");

    assert!(prompt.contains("colore locale"));
    assert!(!prompt.contains("NEBULA-7429"));
    assert!(!prompt.contains("ACTIONS PERFORMED"));
}

#[test]
fn blocked_or_inconsistent_envelopes_expose_no_learn_material() {
    let mut blocked = Exchange {
        user_message: "Local user fact".into(),
        reuse_envelope: MemoryReuseEnvelope::blocked_unknown(),
        ..Exchange::default()
    };
    assert!(blocked.learn_material().is_none());

    blocked.reuse_envelope = MemoryReuseEnvelope {
        write_policy: MemoryWritePolicy::Normal,
        linked_reads: vec![linked_read()],
    };
    assert!(blocked.learn_material().is_none());

    blocked.reuse_envelope = MemoryReuseEnvelope::user_input_only(Vec::new());
    assert!(blocked.learn_material().is_none());
}

#[test]
fn blocked_policy_cannot_reach_memory_or_future_writer_hooks() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let user = UserId::new("owner");
    let workspace = WorkspaceId::new("project-a");
    let content = serde_json::json!({
        "memories": [{
            "memory_type": "fact",
            "text": "NEBULA-7429 must never persist",
            "sensitivity": "internal",
            "confidence": 0.99,
            "metadata": {"scope": "project"}
        }],
        "entities": [],
        "relations": [],
        "episode": "NEBULA-7429 episode"
    });

    let persisted = persist_learn_extraction(
        &facade,
        &user,
        &workspace,
        &content.to_string(),
        Some("thread-a"),
        MemoryWritePolicy::BlockedUnknown,
        LearnHooks {
            persist_graph: None,
            store_episode: None,
            backfill_embeddings: None,
        },
    );

    assert!(!persisted);
    assert!(
        facade
            .list_memories_for_ui(&user, &workspace)
            .unwrap()
            .is_empty()
    );
}
