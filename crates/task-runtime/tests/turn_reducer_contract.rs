use local_first_task_runtime::{
    REDUCED_TERMINAL_TURN_EVENT_KIND_SQL_LIST, ReducedTurnStatus, TaskStatus, TurnEvent,
    TurnEventKind, reduce_turn_events, reduced_terminal_status_matches_task_status,
    turn_event_kind_is_terminal,
};
use serde_json::json;

fn event(seq: i64, kind: TurnEventKind, payload: serde_json::Value) -> TurnEvent {
    TurnEvent {
        event_id: seq,
        turn_id: "turn-1".to_string(),
        seq,
        kind,
        payload,
        created_at: 1_786_000_000 + seq,
    }
}

#[test]
fn empty_event_log_reduces_to_empty() {
    let snapshot = reduce_turn_events(&[]);

    assert_eq!(snapshot.status, ReducedTurnStatus::Empty);
    assert!(!snapshot.is_terminal);
    assert_eq!(snapshot.last_seq, 0);
    assert!(snapshot.contradictions.is_empty());
}

#[test]
fn error_terminal_carries_visible_failure_text() {
    let snapshot = reduce_turn_events(&[event(
        1,
        TurnEventKind::Error,
        json!({
            "text": "Turn stopped before finishing: plan is incomplete",
            "projection_ref": "turn-1:1"
        }),
    )]);

    assert_eq!(snapshot.status, ReducedTurnStatus::Failed);
    assert!(snapshot.is_terminal);
    assert_eq!(snapshot.terminal_event_seq, Some(1));
    assert_eq!(
        snapshot.failure_text.as_deref(),
        Some("Turn stopped before finishing: plan is incomplete")
    );
    assert!(snapshot.contradictions.is_empty());
}

#[test]
fn terminal_state_ignores_later_activity_but_reports_the_contradiction() {
    let snapshot = reduce_turn_events(&[
        event(1, TurnEventKind::Done, json!({"text": "done"})),
        event(
            2,
            TurnEventKind::Activity,
            json!({"text": "still thinking"}),
        ),
    ]);

    assert_eq!(snapshot.status, ReducedTurnStatus::Completed);
    assert!(snapshot.is_terminal);
    assert_eq!(snapshot.terminal_event_seq, Some(1));
    assert_eq!(snapshot.last_seq, 2);
    assert_eq!(snapshot.contradictions.len(), 1);
    assert_eq!(snapshot.contradictions[0].code, "event_after_terminal");
    assert_eq!(
        snapshot.contradictions[0].owner_to_remove,
        "activity_projection"
    );
}

#[test]
fn duplicate_terminal_events_keep_first_terminal_and_report_conflict() {
    let snapshot = reduce_turn_events(&[
        event(1, TurnEventKind::Error, json!({"text": "failed"})),
        event(2, TurnEventKind::Done, json!({"text": "done"})),
    ]);

    assert_eq!(snapshot.status, ReducedTurnStatus::Failed);
    assert_eq!(snapshot.terminal_event_kind, Some(TurnEventKind::Error));
    assert_eq!(snapshot.contradictions.len(), 1);
    assert_eq!(snapshot.contradictions[0].code, "multiple_terminal_events");
    assert_eq!(
        snapshot.contradictions[0].owner_to_remove,
        "terminal_writer"
    );
}

#[test]
fn suspended_event_classifies_user_or_approval_wait() {
    let user = reduce_turn_events(&[event(
        1,
        TurnEventKind::Suspended,
        json!({"wake_kind": "user"}),
    )]);
    assert_eq!(user.status, ReducedTurnStatus::WaitingUser);
    assert!(!user.is_terminal);

    let approval = reduce_turn_events(&[event(
        1,
        TurnEventKind::Suspended,
        json!({"wake_kind": "approval"}),
    )]);
    assert_eq!(approval.status, ReducedTurnStatus::WaitingApproval);
    assert!(!approval.is_terminal);
}

#[test]
fn failed_terminal_without_visible_reason_is_a_contradiction() {
    let snapshot = reduce_turn_events(&[event(
        1,
        TurnEventKind::Error,
        json!({"text": null, "projection_ref": "turn-1:1"}),
    )]);

    assert_eq!(snapshot.status, ReducedTurnStatus::Failed);
    assert_eq!(snapshot.failure_text, None);
    assert_eq!(snapshot.contradictions.len(), 1);
    assert_eq!(
        snapshot.contradictions[0].code,
        "failed_terminal_missing_text"
    );
    assert_eq!(
        snapshot.contradictions[0].owner_to_remove,
        "execution_projection"
    );
}

#[test]
fn terminal_kind_authority_is_public_and_matches_sql_boundary() {
    let terminals = [
        TurnEventKind::Done,
        TurnEventKind::Error,
        TurnEventKind::Cancelled,
    ];
    for kind in terminals {
        assert!(turn_event_kind_is_terminal(kind));
    }

    for kind in [
        TurnEventKind::Delta,
        TurnEventKind::Reasoning,
        TurnEventKind::Activity,
        TurnEventKind::PlanUpdate,
        TurnEventKind::Tool,
        TurnEventKind::Recall,
        TurnEventKind::Suspended,
        TurnEventKind::Aborted,
        TurnEventKind::Retry,
        TurnEventKind::Queued,
        TurnEventKind::StepAdvance,
        TurnEventKind::Heartbeat,
    ] {
        assert!(!turn_event_kind_is_terminal(kind), "{kind:?}");
    }

    assert_eq!(
        REDUCED_TERMINAL_TURN_EVENT_KIND_SQL_LIST,
        "'done', 'error', 'cancelled'"
    );
}

#[test]
fn reduced_terminal_status_matches_the_persisted_task_terminal_status() {
    assert!(reduced_terminal_status_matches_task_status(
        ReducedTurnStatus::Completed,
        TaskStatus::Completed,
    ));
    assert!(reduced_terminal_status_matches_task_status(
        ReducedTurnStatus::Failed,
        TaskStatus::Failed,
    ));
    assert!(reduced_terminal_status_matches_task_status(
        ReducedTurnStatus::Cancelled,
        TaskStatus::Cancelled,
    ));

    assert!(!reduced_terminal_status_matches_task_status(
        ReducedTurnStatus::Completed,
        TaskStatus::Failed,
    ));
    assert!(!reduced_terminal_status_matches_task_status(
        ReducedTurnStatus::Failed,
        TaskStatus::Completed,
    ));
    assert!(!reduced_terminal_status_matches_task_status(
        ReducedTurnStatus::Cancelled,
        TaskStatus::Expired,
    ));
    assert!(!reduced_terminal_status_matches_task_status(
        ReducedTurnStatus::Running,
        TaskStatus::Running,
    ));
    assert!(!reduced_terminal_status_matches_task_status(
        ReducedTurnStatus::WaitingUser,
        TaskStatus::WaitingUserApproval,
    ));
}
