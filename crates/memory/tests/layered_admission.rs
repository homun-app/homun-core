use local_first_memory::{
    Exchange, LearnHooks, MemoryFacade, MemoryReuseEnvelope, MemoryStatus, PERSONAL_WORKSPACE,
    SQLiteMemoryStore, UserId, WorkspaceId, persist_learn_extraction, prepare_learn_prompt,
    promote_aged_candidates,
};

fn facade() -> MemoryFacade {
    MemoryFacade::new(SQLiteMemoryStore::open_in_memory().expect("memory store"))
}

fn exchange(user: &str, assistant: &str) -> Exchange {
    Exchange {
        user_message: user.to_string(),
        assistant_message: assistant.to_string(),
        thread_id: Some("thread-personal".to_string()),
        turn_id: Some("turn-1".to_string()),
        reuse_envelope: MemoryReuseEnvelope::normal(),
        ..Exchange::default()
    }
}

fn empty_hooks() -> LearnHooks<'static> {
    LearnHooks {
        persist_graph: None,
        store_episode: None,
        backfill_embeddings: None,
    }
}

#[test]
fn extractor_treats_current_assistant_and_actions_as_observed_episode_evidence() {
    let facade = facade();
    let user = UserId::new("owner");
    let workspace = WorkspaceId::new(PERSONAL_WORKSPACE);
    let mut exchange = exchange(
        "Preferisco interfacce minimali",
        "Bulgari blocca sempre i browser automatici",
    );
    exchange.actions = "browser returned a challenge page".to_string();

    let (system, prompt) = prepare_learn_prompt(&facade, &user, &workspace, &exchange, None)
        .expect("salient exchange");

    assert!(system.contains("OBSERVED ASSISTANT OUTCOME"));
    assert!(system.contains("must never become durable memory"));
    assert!(prompt.contains("TRUSTED USER STATEMENT"));
    assert!(prompt.contains("OBSERVED ASSISTANT OUTCOME"));
    assert!(prompt.contains("OBSERVED ACTIONS"));
}

#[test]
fn assistant_derived_technical_claim_cannot_become_confirmed_personal_memory() {
    let facade = facade();
    let user = UserId::new("owner");
    let workspace = WorkspaceId::new(PERSONAL_WORKSPACE);
    let exchange = exchange(
        "Analizza il sito",
        "Bulgari blocca sempre i browser automatici",
    );
    let extracted = serde_json::json!({
        "memories": [{
            "memory_type": "fact",
            "text": "Bulgari blocca sempre i browser automatici",
            "sensitivity": "internal",
            "confidence": 0.99,
            "metadata": {
                "scope": "personal",
                "certainty": "committed",
                "admission": {"origin": "assistant_derived"}
            }
        }],
        "entities": [],
        "relations": [],
        "episode": "È stato analizzato il comportamento tecnico del sito."
    });

    assert!(persist_learn_extraction(
        &facade,
        &user,
        &workspace,
        &extracted.to_string(),
        &exchange,
        empty_hooks(),
    ));

    let memories = facade
        .list_memories_for_ui(&user, &workspace)
        .expect("memories");
    assert!(memories.iter().all(|memory| {
        memory.text != "Bulgari blocca sempre i browser automatici"
            || memory.status != MemoryStatus::Confirmed
    }));
}

#[test]
fn explicit_personal_preference_is_confirmed_with_admission_provenance_and_evidence() {
    let facade = facade();
    let user = UserId::new("owner");
    let workspace = WorkspaceId::new(PERSONAL_WORKSPACE);
    let exchange = exchange(
        "Preferisco interfacce minimali",
        "Terrò l'interfaccia essenziale.",
    );
    let extracted = serde_json::json!({
        "memories": [{
            "memory_type": "preference",
            "text": "L'utente preferisce interfacce minimali",
            "sensitivity": "internal",
            "confidence": 0.96,
            "metadata": {
                "scope": "personal",
                "certainty": "committed",
                "admission": {"origin": "user_explicit"}
            }
        }],
        "entities": [],
        "relations": [],
        "episode": "L'utente ha espresso una preferenza per interfacce minimali."
    });

    assert!(persist_learn_extraction(
        &facade,
        &user,
        &workspace,
        &extracted.to_string(),
        &exchange,
        empty_hooks(),
    ));

    let memories = facade
        .list_memories_for_ui(&user, &workspace)
        .expect("memories");
    let preference = memories
        .iter()
        .find(|memory| memory.memory_type == "preference")
        .expect("preference persisted");
    assert_eq!(preference.status, MemoryStatus::Confirmed);
    assert_eq!(
        preference.metadata["admission"]["source_thread_id"],
        "thread-personal"
    );
    assert_eq!(preference.metadata["admission"]["source_turn_id"], "turn-1");
    assert!(
        !facade
            .evidence_for_ui(&preference.reference, &user, &workspace)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn candidate_age_never_promotes_without_confirmation() {
    let facade = facade();
    let user = UserId::new("owner");
    let workspace = WorkspaceId::new(PERSONAL_WORKSPACE);
    let exchange = exchange(
        "Sto valutando una nuova interfaccia",
        "Possiamo esplorarla.",
    );
    let extracted = serde_json::json!({
        "memories": [{
            "memory_type": "goal",
            "text": "L'utente sta valutando una nuova interfaccia",
            "sensitivity": "internal",
            "confidence": 0.4,
            "metadata": {
                "scope": "personal",
                "certainty": "considered",
                "admission": {"origin": "user_explicit"}
            }
        }],
        "entities": [],
        "relations": [],
        "episode": "È stata valutata una possibile interfaccia."
    });
    assert!(persist_learn_extraction(
        &facade,
        &user,
        &workspace,
        &extracted.to_string(),
        &exchange,
        empty_hooks(),
    ));

    assert_eq!(promote_aged_candidates(&facade, &user, &workspace), 0);
    let candidate = facade
        .list_memories_for_ui(&user, &workspace)
        .unwrap()
        .into_iter()
        .find(|memory| memory.memory_type == "goal")
        .expect("candidate");
    assert_eq!(candidate.status, MemoryStatus::Candidate);
}
