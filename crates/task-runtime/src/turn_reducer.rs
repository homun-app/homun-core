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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelEffectProjection {
    pub effect_class: local_first_execution_protocol::EffectClass,
    pub status: local_first_execution_protocol::EffectReceiptStatus,
}

pub struct KernelProjectionInput<'a> {
    pub turn_events: &'a [TurnEvent],
    pub runtime_plan: Option<&'a crate::RuntimePlanRecord>,
    pub uncertain_effects: &'a [KernelEffectProjection],
    pub terminal_reason: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelActivePlanProjection {
    pub goal: Option<String>,
    pub plan_json: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelTurnProjection {
    pub turn: TurnStateSnapshot,
    pub active_plan: Option<KernelActivePlanProjection>,
    pub requires_user_effect_resolution: bool,
    pub terminal_reason: Option<String>,
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
                    | TurnEventKind::ChoicePrompt
                    | TurnEventKind::VaultPropose
                    | TurnEventKind::VaultReveal
                    | TurnEventKind::PaymentApproval
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
            | TurnEventKind::ChoicePrompt
            | TurnEventKind::VaultPropose
            | TurnEventKind::VaultReveal
            | TurnEventKind::PaymentApproval
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

pub fn reduce_kernel_projection(input: KernelProjectionInput<'_>) -> KernelTurnProjection {
    let turn = reduce_turn_events(input.turn_events);
    let active_plan = input.runtime_plan.and_then(|plan| {
        if plan.status != "open" {
            return None;
        }
        Some(KernelActivePlanProjection {
            goal: plan
                .plan_json
                .get("goal")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|goal| !goal.is_empty())
                .map(str::to_string),
            plan_json: plan.plan_json.clone(),
        })
    });
    let requires_user_effect_resolution = input.uncertain_effects.iter().any(|effect| {
        effect.status == local_first_execution_protocol::EffectReceiptStatus::Uncertain
            && effect.effect_class == local_first_execution_protocol::EffectClass::ExternalWrite
    });

    KernelTurnProjection {
        turn,
        active_plan,
        requires_user_effect_resolution,
        terminal_reason: input.terminal_reason.map(str::to_string),
    }
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

#[cfg(test)]
mod kernel_projection_tests {
    use super::*;
    use crate::RuntimePlanRecord;
    use local_first_execution_protocol::{EffectClass, EffectReceiptStatus};

    #[test]
    fn read_receipts_do_not_block_projected_plan_or_terminal_turn() {
        let plan = RuntimePlanRecord {
            user_id: "u1".into(),
            workspace_id: "w1".into(),
            thread_id: "thread-a".into(),
            status: "open".into(),
            plan_json: serde_json::json!({
                "goal": "trova un treno",
                "steps": [
                    {"id": "s1", "title": "Cerca risultati", "status": "done"},
                    {"id": "s2", "title": "Leggi risultati", "status": "doing"}
                ]
            }),
            objective_revision: 0,
            revision: 1,
            stall_turns: 0,
            last_resume_done: Some(1),
            created_at: 1,
            updated_at: 2,
        };
        let events = vec![
            TurnEvent {
                event_id: 1,
                turn_id: "turn-a".into(),
                seq: 1,
                kind: TurnEventKind::PlanUpdate,
                payload: plan.plan_json.clone(),
                created_at: 1,
            },
            TurnEvent {
                event_id: 2,
                turn_id: "turn-a".into(),
                seq: 2,
                kind: TurnEventKind::Done,
                payload: serde_json::json!({"text": "risultati letti"}),
                created_at: 2,
            },
        ];
        let effects = vec![KernelEffectProjection {
            effect_class: EffectClass::Read,
            status: EffectReceiptStatus::Uncertain,
        }];

        let projection = reduce_kernel_projection(KernelProjectionInput {
            turn_events: &events,
            runtime_plan: Some(&plan),
            uncertain_effects: &effects,
            terminal_reason: Some("canonical_completed"),
        });

        assert_eq!(projection.turn.status, ReducedTurnStatus::Completed);
        assert_eq!(
            projection.active_plan.as_ref().unwrap().goal.as_deref(),
            Some("trova un treno")
        );
        assert!(!projection.requires_user_effect_resolution);
        assert!(projection.turn.is_terminal);
    }
}
