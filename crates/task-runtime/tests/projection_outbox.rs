use local_first_task_runtime::{
    ProjectionStatus, TaskStore,
    projection_outbox::{CHAT_LIFECYCLE_PROJECTION, projection_ref},
};
use rusqlite::{Connection, params};
use std::path::PathBuf;
use uuid::Uuid;

fn file_store() -> (PathBuf, TaskStore) {
    let path = std::env::temp_dir().join(format!(
        "homun-projection-outbox-test-{}.sqlite",
        Uuid::new_v4()
    ));
    let store = TaskStore::open(&path).expect("open task store");
    (path, store)
}

#[test]
fn projection_outbox_schema_round_trips_pending_rows() {
    let (path, store) = file_store();
    let reference = projection_ref("turn-1", 1, CHAT_LIFECYCLE_PROJECTION);
    let connection = Connection::open(&path).expect("open raw connection");
    connection
        .execute(
            "INSERT INTO execution_projection_outbox (
                projection_ref, execution_id, revision, projection_kind, status,
                attempt_count, claim_token, created_at, updated_at
             ) VALUES (?1, ?2, 1, ?3, 'pending', 0, 0, 1, 1)",
            params![reference, "turn-1", CHAT_LIFECYCLE_PROJECTION],
        )
        .expect("seed pending projection");

    let row = store
        .projection_outbox_record(&reference)
        .expect("read projection")
        .expect("projection exists");

    assert_eq!(row.projection_ref, reference);
    assert_eq!(row.execution_id, "turn-1");
    assert_eq!(row.revision, 1);
    assert_eq!(row.projection_kind, CHAT_LIFECYCLE_PROJECTION);
    assert_eq!(row.status, ProjectionStatus::Pending);
    assert_eq!(row.attempt_count, 0);
    assert_eq!(row.claim_token, 0);
    assert_eq!(row.claim_owner, None);
    assert_eq!(row.blocked_on_ref, None);

    std::fs::remove_file(path).ok();
}

#[test]
fn projection_outbox_rejects_invalid_status_and_duplicate_source() {
    let (path, _store) = file_store();
    let connection = Connection::open(&path).expect("open raw connection");
    let reference = projection_ref("turn-1", 1, CHAT_LIFECYCLE_PROJECTION);
    connection
        .execute(
            "INSERT INTO execution_projection_outbox (
                projection_ref, execution_id, revision, projection_kind, status,
                attempt_count, claim_token, created_at, updated_at
             ) VALUES (?1, ?2, 1, ?3, 'pending', 0, 0, 1, 1)",
            params![reference, "turn-1", CHAT_LIFECYCLE_PROJECTION],
        )
        .expect("seed projection");

    let invalid = connection.execute(
        "INSERT INTO execution_projection_outbox (
            projection_ref, execution_id, revision, projection_kind, status,
            attempt_count, claim_token, created_at, updated_at
         ) VALUES ('invalid', 'turn-2', 1, 'chat_lifecycle', 'lost', 0, 0, 1, 1)",
        [],
    );
    assert!(invalid.is_err());

    let duplicate = connection.execute(
        "INSERT INTO execution_projection_outbox (
            projection_ref, execution_id, revision, projection_kind, status,
            attempt_count, claim_token, created_at, updated_at
         ) VALUES ('different-ref', 'turn-1', 1, 'chat_lifecycle', 'pending', 0, 0, 1, 1)",
        [],
    );
    assert!(duplicate.is_err());

    std::fs::remove_file(path).ok();
}
