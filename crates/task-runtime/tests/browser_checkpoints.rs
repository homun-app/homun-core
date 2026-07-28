use local_first_task_runtime::{NewBrowserCheckpoint, ObjectiveMode, TaskStore};
use serde_json::json;

fn active_objective(store: &TaskStore, thread: &str, objective: &str) -> u64 {
    store
        .upsert_objective_contract(
            "user",
            "workspace",
            thread,
            "message",
            objective,
            ObjectiveMode::Mixed,
            &json!({}),
            &json!(["browser"]),
            &json!({"kind": "browser_done"}),
            "active",
        )
        .unwrap()
        .revision
}

fn checkpoint(thread: &str, revision: u64, target: &str, secret_ref: &str) -> NewBrowserCheckpoint {
    NewBrowserCheckpoint {
        checkpoint_id: format!("checkpoint-{thread}-{target}"),
        user_id: "user".into(),
        workspace_id: "workspace".into(),
        thread_id: thread.into(),
        target_id: target.into(),
        objective_revision: revision,
        schema_version: 1,
        url: "https://rail.example/checkout".into(),
        origin: "https://rail.example".into(),
        browser_epoch: "container-42".into(),
        cdp_target_id: Some("CDP-42".into()),
        generation: 7,
        draft_secret_ref: Some(secret_ref.into()),
        draft_control_count: 2,
        omitted_sensitive_count: 1,
        omitted_bounded_count: 0,
        expires_at: 2_000_000_000,
    }
}

#[test]
fn browser_checkpoint_round_trips_metadata_without_draft_values() {
    let store = TaskStore::open_in_memory().unwrap();
    let revision = active_objective(&store, "thread", "Book a train");
    let input = checkpoint("thread", revision, "booking", "browser-draft:opaque-1");

    assert!(store.upsert_browser_checkpoint(&input).unwrap());
    let record = store
        .load_active_browser_checkpoint("user", "workspace", "thread", "booking")
        .unwrap()
        .unwrap();

    assert_eq!(record.objective_revision, revision);
    assert_eq!(
        record.draft_secret_ref.as_deref(),
        Some("browser-draft:opaque-1")
    );
    assert_eq!(record.generation, 7);

    let continuation = store
        .load_active_browser_checkpoint_for_thread("user", "workspace", "thread")
        .unwrap()
        .expect("thread has a recoverable browser checkpoint");
    assert_eq!(continuation.target_id, "booking");
    assert_eq!(continuation.generation, 7);
}

#[test]
fn stale_objective_revision_cannot_overwrite_browser_checkpoint() {
    let store = TaskStore::open_in_memory().unwrap();
    let old_revision = active_objective(&store, "thread", "Book a train");
    assert!(
        store
            .upsert_browser_checkpoint(&checkpoint("thread", old_revision, "booking", "secret-old"))
            .unwrap()
    );
    let current_revision = active_objective(&store, "thread", "Book a train and a hotel");
    assert!(current_revision > old_revision);

    let mut stale = checkpoint("thread", old_revision, "booking", "secret-stale");
    stale.generation = 99;
    assert!(!store.upsert_browser_checkpoint(&stale).unwrap());
    assert!(
        store
            .load_active_browser_checkpoint("user", "workspace", "thread", "booking")
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .load_active_browser_checkpoint_for_thread("user", "workspace", "thread")
            .unwrap()
            .is_none()
    );
}

#[test]
fn terminal_objective_cannot_load_restorable_browser_checkpoint() {
    let store = TaskStore::open_in_memory().unwrap();
    let revision = active_objective(&store, "thread", "Book a train");
    assert!(
        store
            .upsert_browser_checkpoint(&checkpoint(
                "thread",
                revision,
                "booking",
                "secret-terminal"
            ))
            .unwrap()
    );
    assert!(
        store
            .transition_objective_contract_status(
                "user",
                "workspace",
                "thread",
                revision,
                "completed"
            )
            .unwrap()
    );

    assert!(
        store
            .load_active_browser_checkpoint("user", "workspace", "thread", "booking")
            .unwrap()
            .is_none()
    );
}

#[test]
fn browser_checkpoint_cleanup_is_scope_exact_idempotent_and_expiry_returns_secret_refs() {
    let store = TaskStore::open_in_memory().unwrap();
    let first_revision = active_objective(&store, "first", "First objective");
    let second_revision = active_objective(&store, "second", "Second objective");
    let mut expired = checkpoint("first", first_revision, "booking", "secret-expired");
    expired.expires_at = 100;
    assert!(store.upsert_browser_checkpoint(&expired).unwrap());
    assert!(
        store
            .upsert_browser_checkpoint(&checkpoint(
                "second",
                second_revision,
                "booking",
                "secret-live"
            ))
            .unwrap()
    );

    assert_eq!(
        store
            .take_expired_browser_checkpoint_secret_refs(101)
            .unwrap(),
        vec!["secret-expired"]
    );
    assert!(
        store
            .take_expired_browser_checkpoint_secret_refs(101)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .load_active_browser_checkpoint("user", "workspace", "second", "booking")
            .unwrap()
            .is_some()
    );
    assert_eq!(
        store
            .delete_browser_checkpoints_for_thread("user", "workspace", "second")
            .unwrap(),
        vec!["secret-live"]
    );
    assert!(
        store
            .delete_browser_checkpoints_for_thread("user", "workspace", "second")
            .unwrap()
            .is_empty()
    );
}
