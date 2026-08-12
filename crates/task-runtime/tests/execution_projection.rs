use local_first_execution_protocol::{
    CancelReason, CheckpointDataRef, CheckpointEnvelope, DurableDataRef, EffectReceiptRef,
    ExecutionFailure, ExecutionOutcome, WakeCondition,
};
use local_first_task_runtime::{
    AgentRunStatus, ExecutionProjection, ExecutionPublicEventKind, ReducedTurnStatus, TaskStatus,
    reduced_terminal_status_matches_task_status,
};
use serde_json::json;

const DURABLE_STORE_ID: &str = "0123456789abcdef0123456789abcdef";

fn suspended(wake: WakeCondition) -> ExecutionOutcome {
    ExecutionOutcome::Suspended {
        wake,
        checkpoint: CheckpointEnvelope::new(
            "exec-projection",
            1,
            "chat_turn",
            1,
            CheckpointDataRef::Public {
                record_ref: DurableDataRef::from_store_id(DURABLE_STORE_ID).unwrap(),
            },
        ),
    }
}

#[test]
fn every_canonical_outcome_has_one_projection() {
    let cases = vec![
        (
            ExecutionOutcome::completed(json!({"ok": true})),
            TaskStatus::Completed,
            Some(AgentRunStatus::Completed),
            true,
            ExecutionPublicEventKind::Completed,
        ),
        (
            suspended(WakeCondition::At {
                unix_seconds: 1_800_000_000,
            }),
            TaskStatus::WaitingTime,
            None,
            false,
            ExecutionPublicEventKind::Suspended,
        ),
        (
            suspended(WakeCondition::Signal {
                kind: "connector.message".into(),
                correlation_id: "message-1".into(),
            }),
            TaskStatus::WaitingExternalEvent,
            None,
            false,
            ExecutionPublicEventKind::Suspended,
        ),
        (
            suspended(WakeCondition::Resource {
                class: "browser_session".into(),
            }),
            TaskStatus::WaitingResource,
            None,
            false,
            ExecutionPublicEventKind::Suspended,
        ),
        (
            suspended(WakeCondition::ModelAvailable {
                role: "chat".into(),
            }),
            TaskStatus::Parked,
            Some(AgentRunStatus::Aborted),
            false,
            ExecutionPublicEventKind::Suspended,
        ),
        (
            suspended(WakeCondition::User {
                wait_ref: "wait:user-1".into(),
            }),
            TaskStatus::WaitingUserApproval,
            Some(AgentRunStatus::Completed),
            false,
            ExecutionPublicEventKind::Suspended,
        ),
        (
            suspended(WakeCondition::Approval {
                approval_ref: "approval:payment-1".into(),
            }),
            TaskStatus::WaitingUserApproval,
            Some(AgentRunStatus::Completed),
            false,
            ExecutionPublicEventKind::Suspended,
        ),
        (
            suspended(WakeCondition::EffectResolution {
                receipt_ref: EffectReceiptRef::from_store_id("11111111111111111111111111111111")
                    .unwrap(),
            }),
            TaskStatus::WaitingUserApproval,
            None,
            false,
            ExecutionPublicEventKind::Suspended,
        ),
        (
            ExecutionOutcome::Cancelled {
                reason: CancelReason::User,
            },
            TaskStatus::Cancelled,
            Some(AgentRunStatus::Aborted),
            true,
            ExecutionPublicEventKind::Cancelled,
        ),
        (
            ExecutionOutcome::Failed {
                failure: ExecutionFailure::transient("provider_busy", "Provider unavailable"),
            },
            TaskStatus::Failed,
            Some(AgentRunStatus::Failed),
            true,
            ExecutionPublicEventKind::Failed,
        ),
        (
            ExecutionOutcome::Failed {
                failure: ExecutionFailure::permanent("no_reply", "No reply"),
            },
            TaskStatus::Failed,
            Some(AgentRunStatus::Failed),
            true,
            ExecutionPublicEventKind::Failed,
        ),
        (
            ExecutionOutcome::Failed {
                failure: ExecutionFailure::policy_denied("effect_denied", "Effect denied"),
            },
            TaskStatus::Failed,
            Some(AgentRunStatus::Failed),
            true,
            ExecutionPublicEventKind::Failed,
        ),
    ];

    for (outcome, task_status, run_status, terminal, event_kind) in cases {
        let projection = ExecutionProjection::from_outcome(&outcome);
        assert_eq!(projection.task_status, task_status);
        assert_eq!(projection.run_status, run_status);
        assert_eq!(projection.terminal, terminal);
        assert_eq!(projection.event_kind, event_kind);

        if projection.terminal {
            let reduced = match projection.event_kind {
                ExecutionPublicEventKind::Completed => ReducedTurnStatus::Completed,
                ExecutionPublicEventKind::Cancelled => ReducedTurnStatus::Cancelled,
                ExecutionPublicEventKind::Failed => ReducedTurnStatus::Failed,
                ExecutionPublicEventKind::Suspended => unreachable!("suspended is not terminal"),
            };
            assert!(reduced_terminal_status_matches_task_status(
                reduced,
                projection.task_status,
            ));
        }
    }
}
