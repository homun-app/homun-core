use local_first_desktop_gateway::usage_store::{UsageStore, UsageWindow};
use local_first_inference_usage::{
    InferencePurpose, Locality, NormalizedUsage, UsageAttemptEvent, UsageContext,
};

fn completed_attempt(
    call_id: &str,
    attempt_id: &str,
    user_id: &str,
    workspace_id: &str,
    usage: NormalizedUsage,
    at: i64,
) -> UsageAttemptEvent {
    let mut context = UsageContext::new(call_id, InferencePurpose::ChatResponse, user_id);
    context.workspace_id = Some(workspace_id.to_string());
    UsageAttemptEvent::started(
        context,
        attempt_id,
        "provider-a",
        "model-a",
        Locality::Cloud,
        at,
    )
    .completed(at + 1, usage)
}

#[test]
fn file_ledger_aggregates_known_and_unknown_usage_and_purges_exact_scope() {
    let path = std::env::temp_dir().join(format!("homun-usage-{}.sqlite", uuid::Uuid::new_v4()));
    let store = UsageStore::open(&path).unwrap();
    store
        .append(&completed_attempt(
            "call-known",
            "attempt-known",
            "user-a",
            "workspace-a",
            NormalizedUsage {
                input_tokens: Some(120),
                output_tokens: Some(30),
                ..NormalizedUsage::default()
            },
            100,
        ))
        .unwrap();
    store
        .append(&completed_attempt(
            "call-unknown",
            "attempt-unknown",
            "user-a",
            "workspace-b",
            NormalizedUsage::default(),
            200,
        ))
        .unwrap();
    store
        .append(&completed_attempt(
            "other-user",
            "other-user-attempt",
            "user-b",
            "workspace-b",
            NormalizedUsage {
                input_tokens: Some(9),
                output_tokens: Some(3),
                ..NormalizedUsage::default()
            },
            300,
        ))
        .unwrap();

    let summary = store.summary("user-a", UsageWindow::All, 1_000).unwrap();
    assert_eq!(summary.logical_calls, 2);
    assert_eq!(summary.known_usage_attempts, 1);
    assert_eq!(summary.unknown_usage_attempts, 1);
    assert_eq!(summary.usage_coverage_percent, 50);
    assert_eq!(summary.input_tokens, 120);
    assert_eq!(summary.output_tokens, 30);

    assert_eq!(store.purge_workspace("user-a", "workspace-a").unwrap(), 1);
    assert_eq!(
        store.events_for_scope("user-a", Some("workspace-b")).unwrap().len(),
        1
    );
    assert_eq!(
        store.events_for_scope("user-b", Some("workspace-b")).unwrap().len(),
        1
    );

    drop(store);
    let _ = std::fs::remove_file(path);
}

#[test]
fn ledger_file_never_contains_prompt_content() {
    const SENTINEL: &str = "USAGE_SECRET_SENTINEL_47";
    let path = std::env::temp_dir().join(format!("homun-usage-{}.sqlite", uuid::Uuid::new_v4()));
    let store = UsageStore::open(&path).unwrap();
    store
        .append(&completed_attempt(
            "privacy-call",
            "privacy-attempt",
            "user-a",
            "workspace-a",
            NormalizedUsage {
                input_tokens: Some(SENTINEL.len() as u64),
                output_tokens: Some(1),
                ..NormalizedUsage::default()
            },
            100,
        ))
        .unwrap();
    drop(store);

    let bytes = std::fs::read(&path).unwrap();
    assert!(!bytes.windows(SENTINEL.len()).any(|window| window == SENTINEL.as_bytes()));
    let _ = std::fs::remove_file(path);
}
