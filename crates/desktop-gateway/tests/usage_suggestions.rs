use local_first_desktop_gateway::usage_store::{SuggestionAction, UsageStore};
use local_first_desktop_gateway::usage_suggestions::{
    ApplyUsageSuggestionRequest, SuggestionActionScope, validate_apply_request,
};

fn action(key: &str, value: &str, created_at: i64) -> SuggestionAction {
    SuggestionAction {
        action_id: format!("{key}-{created_at}"),
        suggestion_key: key.into(),
        user_id: "local".into(),
        workspace_id: Some("workspace-a".into()),
        thread_id: None,
        current_provider: "openrouter".into(),
        current_model: "expensive".into(),
        target_provider: "ollama".into(),
        target_model: "efficient".into(),
        role: "orchestrator".into(),
        action: value.into(),
        scoring_policy_version: "usage-suggestion-v1".into(),
        created_at,
    }
}

#[test]
fn dismissed_equivalent_suggestion_is_suppressed_for_thirty_days() {
    let store = UsageStore::open_in_memory().unwrap();
    store
        .append_suggestion_action(&action("key-1", "dismissed", 100))
        .unwrap();
    assert!(
        store
            .is_suggestion_suppressed("local", "key-1", 100 + 29 * 86_400)
            .unwrap()
    );
    assert!(
        !store
            .is_suggestion_suppressed("local", "key-1", 100 + 31 * 86_400)
            .unwrap()
    );
}

#[test]
fn failed_client_preference_change_can_remain_actionable() {
    let store = UsageStore::open_in_memory().unwrap();
    store
        .append_suggestion_action(&action("key-role", "preference_changed", 100))
        .unwrap();
    assert!(
        !store
            .is_suggestion_suppressed("local", "key-role", 101)
            .unwrap()
    );
}

#[test]
fn suggestion_history_contains_metadata_only() {
    let store = UsageStore::open_in_memory().unwrap();
    store
        .append_suggestion_action(&action("key-privacy", "used_for_task", 200))
        .unwrap();
    let columns = store.suggestion_action_columns().unwrap();
    assert!(!columns.iter().any(|column| {
        ["prompt", "content", "message", "explanation"]
            .iter()
            .any(|forbidden| column.contains(forbidden))
    }));
}

#[test]
fn apply_requires_explicit_confirmation() {
    let error = validate_apply_request(
        &ApplyUsageSuggestionRequest {
            confirmed: false,
            action: SuggestionActionScope::UseForTask,
            thread_id: Some("thread-a".into()),
        },
        &[SuggestionActionScope::UseForTask],
        "ollama",
        "qwen",
        "orchestrator",
    )
    .unwrap_err();
    assert_eq!(error, "usage_suggestion_confirmation_required");
}
