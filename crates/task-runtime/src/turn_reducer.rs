use crate::{TaskStatus, TurnEvent, TurnEventKind};

pub const REDUCED_TERMINAL_TURN_EVENT_KIND_SQL_LIST: &str = "'done', 'error', 'cancelled'";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReducedTurnStatus {
    Empty,
    Running,
    WaitingUser,
    WaitingApproval,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnContradiction {
    pub code: &'static str,
    pub detail: String,
    pub owner_to_remove: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnStateSnapshot {
    pub status: ReducedTurnStatus,
    pub is_terminal: bool,
    pub last_seq: i64,
    pub terminal_event_seq: Option<i64>,
    pub terminal_event_kind: Option<TurnEventKind>,
    pub failure_text: Option<String>,
    pub contradictions: Vec<TurnContradiction>,
}

impl Default for TurnStateSnapshot {
    fn default() -> Self {
        Self {
            status: ReducedTurnStatus::Empty,
            is_terminal: false,
            last_seq: 0,
            terminal_event_seq: None,
            terminal_event_kind: None,
            failure_text: None,
            contradictions: Vec::new(),
        }
    }
}

pub fn reduce_turn_events(events: &[TurnEvent]) -> TurnStateSnapshot {
    let mut snapshot = TurnStateSnapshot::default();
    let mut ordered = events.to_vec();
    ordered.sort_by_key(|event| (event.seq, event.event_id));

    for event in ordered {
        snapshot.last_seq = snapshot.last_seq.max(event.seq);
        if snapshot.is_terminal {
            if turn_event_kind_is_terminal(event.kind) {
                snapshot.contradictions.push(TurnContradiction {
                    code: "multiple_terminal_events",
                    detail: format!(
                        "terminal {:?} at seq {} after {:?} at seq {:?}",
                        event.kind,
                        event.seq,
                        snapshot.terminal_event_kind,
                        snapshot.terminal_event_seq
                    ),
                    owner_to_remove: "terminal_writer",
                });
            } else if matches!(
                event.kind,
                TurnEventKind::Activity
                    | TurnEventKind::PlanUpdate
                    | TurnEventKind::StepAdvance
                    | TurnEventKind::Heartbeat
            ) {
                snapshot.contradictions.push(TurnContradiction {
                    code: "event_after_terminal",
                    detail: format!(
                        "non-terminal {:?} at seq {} after terminal",
                        event.kind, event.seq
                    ),
                    owner_to_remove: "activity_projection",
                });
            }
            continue;
        }

        match event.kind {
            TurnEventKind::Done => {
                snapshot.status = ReducedTurnStatus::Completed;
                snapshot.is_terminal = true;
                snapshot.terminal_event_seq = Some(event.seq);
                snapshot.terminal_event_kind = Some(event.kind);
            }
            TurnEventKind::Error => {
                snapshot.status = ReducedTurnStatus::Failed;
                snapshot.is_terminal = true;
                snapshot.terminal_event_seq = Some(event.seq);
                snapshot.terminal_event_kind = Some(event.kind);
                snapshot.failure_text = event
                    .payload
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string);
                if snapshot.failure_text.is_none() {
                    snapshot.contradictions.push(TurnContradiction {
                        code: "failed_terminal_missing_text",
                        detail: "failed terminal event has no visible text".to_string(),
                        owner_to_remove: "execution_projection",
                    });
                }
            }
            TurnEventKind::Cancelled => {
                snapshot.status = ReducedTurnStatus::Cancelled;
                snapshot.is_terminal = true;
                snapshot.terminal_event_seq = Some(event.seq);
                snapshot.terminal_event_kind = Some(event.kind);
            }
            TurnEventKind::Suspended => {
                snapshot.status = match event
                    .payload
                    .get("wake_kind")
                    .and_then(serde_json::Value::as_str)
                {
                    Some("approval") | Some("effect_resolution") => {
                        ReducedTurnStatus::WaitingApproval
                    }
                    _ => ReducedTurnStatus::WaitingUser,
                };
            }
            TurnEventKind::Delta
            | TurnEventKind::Reasoning
            | TurnEventKind::Activity
            | TurnEventKind::PlanUpdate
            | TurnEventKind::Tool
            | TurnEventKind::Recall
            | TurnEventKind::Retry
            | TurnEventKind::Queued
            | TurnEventKind::StepAdvance
            | TurnEventKind::Heartbeat
            | TurnEventKind::Aborted => {
                if snapshot.status == ReducedTurnStatus::Empty {
                    snapshot.status = ReducedTurnStatus::Running;
                }
            }
        }
    }

    snapshot
}

pub fn turn_event_kind_is_terminal(kind: TurnEventKind) -> bool {
    matches!(
        kind,
        TurnEventKind::Done | TurnEventKind::Error | TurnEventKind::Cancelled
    )
}

pub fn reduced_terminal_status_matches_task_status(
    reduced: ReducedTurnStatus,
    task_status: TaskStatus,
) -> bool {
    matches!(
        (reduced, task_status),
        (ReducedTurnStatus::Completed, TaskStatus::Completed)
            | (ReducedTurnStatus::Failed, TaskStatus::Failed)
            | (ReducedTurnStatus::Cancelled, TaskStatus::Cancelled)
    )
}
