use local_first_task_runtime::{TaskRuntimeResult, TaskStore, TurnSteeringRecord};

use crate::semantic_decision::ValidatedSemanticDecision;

const COORDINATOR_POLL_MILLIS: u64 = 500;
const COORDINATOR_BATCH: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SteeringInterpretationError {
    ModelUnavailable,
    InvalidModelOutput(String),
}

impl SteeringInterpretationError {
    fn code(&self) -> &str {
        match self {
            Self::ModelUnavailable => "model_unavailable",
            Self::InvalidModelOutput(code) => code,
        }
    }
}

fn retry_delay_seconds(attempts: u32) -> i64 {
    2_i64.saturating_pow(attempts.min(6)).clamp(2, 60)
}

pub(crate) fn persist_interpretation_result(
    store: &TaskStore,
    claimed: &TurnSteeringRecord,
    run_id: &str,
    result: Result<ValidatedSemanticDecision, SteeringInterpretationError>,
    now: i64,
) -> TaskRuntimeResult<TurnSteeringRecord> {
    match result {
        Ok(decision) => {
            if crate::semantic_decision::actionable_steering_decision(&decision).is_none() {
                let reason = decision
                    .provenance
                    .fallback_reason
                    .as_deref()
                    .unwrap_or("non_actionable_semantic_decision");
                return store.release_turn_steering_for_retry(
                    claimed.steering_id,
                    claimed.revision,
                    reason,
                    now.saturating_add(retry_delay_seconds(claimed.interpretation_attempts)),
                );
            }
            store.mark_turn_steering_interpreted(
                claimed.steering_id,
                claimed.revision,
                &serde_json::to_value(decision)?,
                run_id,
            )
        }
        Err(error) => store.release_turn_steering_for_retry(
            claimed.steering_id,
            claimed.revision,
            error.code(),
            now.saturating_add(retry_delay_seconds(claimed.interpretation_attempts)),
        ),
    }
}

pub(crate) fn start(state: crate::AppState) {
    tokio::spawn(async move {
        loop {
            let now = crate::now_epoch_secs() as i64;
            let due = state
                .task_store
                .lock()
                .ok()
                .and_then(|store| {
                    store
                        .list_due_pending_turn_steering(now, COORDINATOR_BATCH)
                        .ok()
                })
                .unwrap_or_default();
            for steering in due {
                let attempt_state = state.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    interpret_pending_turn(&attempt_state, &steering)
                })
                .await;
            }
            tokio::time::sleep(std::time::Duration::from_millis(
                COORDINATOR_POLL_MILLIS,
            ))
            .await;
        }
    });
}

fn interpret_pending_turn(state: &crate::AppState, pending: &TurnSteeringRecord) {
    use local_first_task_runtime::AgentRunStatus;

    let (run_id, objective, claimed) = {
        let Ok(store) = state.task_store.lock() else {
            return;
        };
        let run_id = store
            .list_agent_runs_for_turn(
                &pending.active_turn_id,
                &pending.user_id,
                &pending.workspace_id,
            )
            .ok()
            .and_then(|runs| {
                runs.into_iter()
                    .rev()
                    .find(|run| run.status == AgentRunStatus::Running)
                    .map(|run| run.run_id)
            });
        let Some(run_id) = run_id else {
            return;
        };
        let objective = store
            .load_objective_contract(
                &pending.user_id,
                &pending.workspace_id,
                &pending.thread_id,
            )
            .ok()
            .flatten();
        let claimed = store
            .claim_pending_turn_steering(
                &pending.user_id,
                &pending.workspace_id,
                &pending.thread_id,
                &pending.active_turn_id,
                &run_id,
                0,
            )
            .unwrap_or_default();
        (run_id, objective, claimed)
    };
    if claimed.is_empty() {
        return;
    }

    let binding = crate::active_routing_binding(state, Some(&pending.thread_id));
    for steering in claimed {
        let decision = crate::resolve_steering_semantic_decision(
            state,
            Some(&steering.thread_id),
            &steering.content,
            objective.as_ref(),
            binding.as_ref(),
        );
        let record = state.task_store.lock().ok().and_then(|store| {
            persist_interpretation_result(
                &store,
                &steering,
                &run_id,
                Ok(decision),
                crate::now_epoch_secs() as i64,
            )
            .ok()
        });
        if let Some(record) = record {
            crate::publish_steering_changed(&record);
        }
    }
}

#[cfg(test)]
mod tests {
    use local_first_task_runtime::{NewTurnSteering, TaskStore, TurnSteeringStatus};

    use super::*;

    fn queued(store: &TaskStore, text: &str) -> local_first_task_runtime::TurnSteeringRecord {
        store
            .append_turn_steering(
                "u",
                "w",
                "thread",
                "turn-1",
                &NewTurnSteering {
                    source_message_id: format!("message-{text}"),
                    prompt: text.to_string(),
                    visible_prompt: text.to_string(),
                    images: Vec::new(),
                    attachments: serde_json::json!([]),
                    mode: None,
                    model: None,
                },
                1,
            )
            .unwrap();
        store
            .claim_pending_turn_steering("u", "w", "thread", "turn-1", "run-1", 0)
            .unwrap()
            .remove(0)
    }

    #[test]
    fn valid_model_decision_becomes_interpreted_not_applied() {
        let store = TaskStore::open_in_memory().unwrap();
        let claimed = queued(&store, "answer now using current evidence");
        let decision = crate::semantic_decision::safe_fallback(None, "test");
        let mut decision = decision;
        decision.provenance.fallback_reason = None;
        decision.decision.steering_disposition =
            crate::semantic_decision::SteeringDisposition::FinalizeWithCurrentEvidence;

        let record = persist_interpretation_result(
            &store,
            &claimed,
            "run-1",
            Ok(decision),
            10,
        )
        .unwrap();

        assert_eq!(record.status, TurnSteeringStatus::Interpreted);
        assert!(record.applied_at.is_none());
        assert_eq!(
            record.semantic_decision_json.unwrap()["steering_disposition"],
            "finalize_with_current_evidence"
        );
    }

    #[test]
    fn model_unavailability_remains_pending_for_retry() {
        let store = TaskStore::open_in_memory().unwrap();
        let claimed = queued(&store, "use the evidence already collected");

        let record = persist_interpretation_result(
            &store,
            &claimed,
            "run-1",
            Err(SteeringInterpretationError::ModelUnavailable),
            10,
        )
        .unwrap();

        assert_eq!(record.status, TurnSteeringStatus::Pending);
        assert_eq!(record.last_interpretation_error.as_deref(), Some("model_unavailable"));
        assert!(record.next_retry_at.is_some_and(|value| value > 10));
        assert!(record.semantic_decision_json.is_none());
    }

    #[test]
    fn semantic_fallback_is_treated_as_unavailable_not_as_control() {
        let store = TaskStore::open_in_memory().unwrap();
        let claimed = queued(&store, "do not stop; continue the existing investigation");
        let fallback = crate::semantic_decision::safe_fallback(None, "low_confidence");

        let record = persist_interpretation_result(
            &store,
            &claimed,
            "run-1",
            Ok(fallback),
            10,
        )
        .unwrap();

        assert_eq!(record.status, TurnSteeringStatus::Pending);
        assert_eq!(record.last_interpretation_error.as_deref(), Some("low_confidence"));
    }
}
