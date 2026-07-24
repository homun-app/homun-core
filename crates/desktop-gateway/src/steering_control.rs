use local_first_task_runtime::{
    TaskId, TaskRuntimeResult, TaskStatus, TaskStore, TurnSteeringRecord, UserId, WorkspaceId,
};

use crate::semantic_decision::ValidatedSemanticDecision;

const COORDINATOR_POLL_MILLIS: u64 = 500;
const COORDINATOR_BATCH: usize = 16;

/// Bounded attempt budget for an ORPHANED pending steering row (design Part 5): a
/// `pending` steering whose turn has neither a `Running` run nor a resumable
/// `Parked` checkpoint has genuinely completed/cancelled/failed — nothing will ever
/// interpret it. Unlike the parked-model-down backoff (which waits indefinitely for
/// the model to come back — the turn itself is still alive), an orphan can never
/// resolve on its own, so after this many attempts it is surfaced (`held`) instead
/// of polling forever.
const MAX_ORPHAN_INTERPRETATION_ATTEMPTS: u32 = 5;

/// Payload marker for the idempotent "waiting for the model" Activity (see
/// `emit_waiting_for_model_activity_once`). Distinguishes this coordinator-emitted
/// signal from any other Activity text so the dedup check is exact, not
/// text-fragile.
const PARKED_WAITING_ACTIVITY_MARKER: &str = "steering_park_waiting_for_model";

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
            // No live Running run for this turn: it may be Parked (resumable — probe
            // the model and unpark/backoff) or orphaned (genuinely done — backoff
            // then surface). Both branches may call the semantic model, so they run
            // OUTSIDE this lock (mirrors the Some(run_id) branch below, which also
            // calls the model only after releasing the store guard).
            drop(store);
            resolve_pending_without_running_run(state, pending, |thread_id, prompt, active, binding| {
                crate::resolve_steering_semantic_decision(state, thread_id, prompt, active, binding)
            });
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

/// Pure routing decision for a due `pending` steering whose turn has no `Running`
/// agent run (review C1 fix, steering park+resume Build 2). A missing `Running` run
/// row does NOT by itself mean the turn is gone — it is also routinely true, for
/// EVERY turn, during two IN-TRANSIT windows: right after enqueue (before the runner
/// picks the task up) and right after `unpark_chat_turn_to_queued` (before the
/// resumed dispatch's own pre-run work — `execute_chat_turn_task`'s
/// `resolve_semantic_decision`, which can take tens of seconds — finishes and
/// `create_agent_run` finally inserts the NEW run row). Both windows must just wait
/// for a later poll to find the run; treating "no Running run" as orphaned by itself
/// was the actual bug — it regressed instant steering on every turn's first seconds
/// AND, combined with the shared attempts counter, could push a steering that was
/// seconds from being applied by the resumed run straight to `held` instead. The
/// ORPHAN budget is reserved for the two cases nothing will EVER resolve: the task
/// is missing entirely, or it reached a genuinely TERMINAL status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingWithoutRunRoute {
    /// Parked with a resumable checkpoint: probe model availability, maybe unpark.
    ProbeAndMaybeResume,
    /// The task exists and is in any other non-terminal status — Queued, Pending,
    /// Running (pre-run-row), WaitingXxx, Paused, or Parked without a checkpoint yet
    /// (should not normally happen, but "alive" either way). A turn is in flight; do
    /// nothing and let a later poll find its Running run (or its park).
    WaitInTransit,
    /// The task is missing entirely, or reached a terminal status: nothing will ever
    /// interpret this row again.
    Orphaned,
}

fn route_pending_without_running_run(
    task_status: Option<TaskStatus>,
    has_resumable_checkpoint: bool,
) -> PendingWithoutRunRoute {
    match task_status {
        Some(TaskStatus::Parked) if has_resumable_checkpoint => {
            PendingWithoutRunRoute::ProbeAndMaybeResume
        }
        Some(
            TaskStatus::Completed
            | TaskStatus::Failed
            | TaskStatus::Cancelled
            | TaskStatus::Expired,
        )
        | None => PendingWithoutRunRoute::Orphaned,
        Some(_) => PendingWithoutRunRoute::WaitInTransit,
    }
}

/// Coordinator resume trigger + orphan-row handling (design Part 3 + Part 5,
/// steering park+resume Build 2). Called for a due `pending` steering whose turn
/// has NO `Running` agent run. Splits the model probe out as an injected `probe`
/// closure so the routing/backoff/terminal POLICY is directly testable with a
/// hand-built decision — no model, no DB probe required to exercise it (mirrors
/// `persist_interpretation_result`'s own testing style). Production wires
/// `resolve_steering_semantic_decision`; tests substitute a canned decision.
fn resolve_pending_without_running_run<F>(
    state: &crate::AppState,
    pending: &TurnSteeringRecord,
    probe: F,
) where
    F: FnOnce(
        Option<&str>,
        &str,
        Option<&local_first_task_runtime::ObjectiveContractRecord>,
        Option<&crate::RoutingBinding>,
    ) -> ValidatedSemanticDecision,
{
    let now = crate::now_epoch_secs() as i64;
    let task_id = TaskId::new(pending.active_turn_id.clone());
    let user_id = UserId::new(pending.user_id.clone());
    let workspace_id = WorkspaceId::new(pending.workspace_id.clone());

    let (task_status, has_resumable_checkpoint) = {
        let Ok(store) = state.task_store.lock() else {
            return;
        };
        let task_status = store
            .get_task(&task_id, &user_id, &workspace_id)
            .ok()
            .flatten()
            .map(|task| task.status);
        let has_resumable_checkpoint = store
            .latest_resumable_checkpoint_for_turn(
                &pending.active_turn_id,
                &pending.user_id,
                &pending.workspace_id,
            )
            .ok()
            .flatten()
            .is_some();
        (task_status, has_resumable_checkpoint)
    };

    match route_pending_without_running_run(task_status, has_resumable_checkpoint) {
        PendingWithoutRunRoute::WaitInTransit => {
            // In flight (just enqueued, or just unparked and awaiting its resumed
            // dispatch's pre-run work + new agent_run row): do NOTHING. No counter
            // increment, no defer, no probe — a later poll finds the Running run (or,
            // if it parks again, the Parked branch) and interprets normally.
        }
        PendingWithoutRunRoute::ProbeAndMaybeResume => {
            // Otherwise the parked turn is a silent stall from the UI's point of view —
            // no Running run to show activity for. Idempotent: only the first cycle
            // that observes the park actually inserts the event.
            emit_waiting_for_model_activity_once(state, &pending.active_turn_id);

            let objective = state.task_store.lock().ok().and_then(|store| {
                store
                    .load_objective_contract(&pending.user_id, &pending.workspace_id, &pending.thread_id)
                    .ok()
                    .flatten()
            });
            let binding = crate::active_routing_binding(state, Some(&pending.thread_id));
            // THROWAWAY probe: no claim_pending_turn_steering, no persisted result — the
            // only thing that matters is actionable-vs-fallback (design Part 3: the real
            // claim/interpret/apply must happen under the RESUMED run, never bound to
            // this dead parked run_id).
            let decision = probe(
                Some(&pending.thread_id),
                &pending.content,
                objective.as_ref(),
                binding.as_ref(),
            );

            if crate::semantic_decision::actionable_steering_decision(&decision).is_some() {
                // Model is back: unpark so the normal runner re-dispatches and reseeds
                // from the park checkpoint. Steering itself is untouched — it stays
                // `pending` and gets claimed/interpreted under the NEW run on a later
                // poll. `unpark_chat_turn_to_queued` also resets this row's
                // `interpretation_attempts`/backoff (review C1 hardening) so probe
                // backoffs accumulated while parked cannot carry into whatever the
                // resumed turn's coordinator activity does next.
                if let Ok(store) = state.task_store.lock() {
                    let _ = store.unpark_chat_turn_to_queued(
                        &pending.active_turn_id,
                        &pending.user_id,
                        &pending.workspace_id,
                    );
                }
            } else if let Ok(store) = state.task_store.lock() {
                // Model still down: bounded backoff on the row, no restart-thrash. The
                // turn stays Parked until a later probe confirms the model is back.
                let reason = decision
                    .provenance
                    .fallback_reason
                    .as_deref()
                    .unwrap_or("model_unavailable");
                let _ = store.defer_pending_turn_steering(
                    pending.steering_id,
                    pending.revision,
                    reason,
                    now.saturating_add(retry_delay_seconds(pending.interpretation_attempts)),
                );
            }
        }
        PendingWithoutRunRoute::Orphaned => {
            // No Running run AND no resumable Parked checkpoint AND (task missing or
            // terminal) — the turn genuinely completed/cancelled/failed and nothing
            // will ever interpret this row. Bounded backoff first (covers benign
            // races, e.g. the checkpoint/park flip landing a beat after this poll's
            // snapshot); once the attempt budget is exhausted, surface it instead of
            // polling forever.
            let Ok(store) = state.task_store.lock() else {
                return;
            };
            if pending.interpretation_attempts.saturating_add(1) >= MAX_ORPHAN_INTERPRETATION_ATTEMPTS {
                if let Ok(held) = store.hold_pending_turn_steering(
                    &pending.user_id,
                    &pending.workspace_id,
                    &pending.active_turn_id,
                ) {
                    if held > 0 {
                        if let Ok(Some(record)) = store.load_turn_steering(
                            pending.steering_id,
                            &pending.user_id,
                            &pending.workspace_id,
                        ) {
                            crate::publish_steering_changed(&record);
                        }
                    }
                }
            } else {
                let _ = store.defer_pending_turn_steering(
                    pending.steering_id,
                    pending.revision,
                    "turn_orphaned",
                    now.saturating_add(retry_delay_seconds(pending.interpretation_attempts)),
                );
            }
        }
    }
}

/// Idempotent "waiting for the model" signal for a Parked turn (T3-review
/// follow-up): without it a park is a silent stall — there's no Running run for
/// the UI's activity feed to attach to. Emitted via the SAME durable+live fan-out
/// every other Activity uses (`turn_executor::emit_turn_event`), so it shows up
/// exactly like any other in-progress activity line. Deduplicated by checking the
/// durable `turn_events` log for a prior copy first — the coordinator polls every
/// 500ms, so without this it would spam one Activity event per cycle for the
/// entire duration of the park.
fn emit_waiting_for_model_activity_once(state: &crate::AppState, turn_id: &str) {
    let Ok(store) = state.task_store.lock() else {
        return;
    };
    let already_emitted = store
        .read_turn_events(turn_id, 0)
        .map(|events| {
            events.iter().any(|event| {
                event.kind == local_first_task_runtime::TurnEventKind::Activity
                    && event.payload.get("marker").and_then(|value| value.as_str())
                        == Some(PARKED_WAITING_ACTIVITY_MARKER)
            })
        })
        // On a read error, err toward NOT emitting a possible duplicate.
        .unwrap_or(true);
    if already_emitted {
        return;
    }
    let _ = crate::turn_executor::emit_turn_event(
        state,
        &store,
        turn_id,
        local_first_task_runtime::TurnEventKind::Activity,
        serde_json::json!({
            "text": "Waiting for the model",
            "marker": PARKED_WAITING_ACTIVITY_MARKER,
        }),
    );
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

    fn actionable_decision() -> ValidatedSemanticDecision {
        let mut decision = crate::semantic_decision::safe_fallback(None, "unused");
        decision.provenance.fallback_reason = None;
        decision.decision.steering_disposition =
            crate::semantic_decision::SteeringDisposition::FinalizeWithCurrentEvidence;
        decision
    }

    fn fallback_decision(reason: &str) -> ValidatedSemanticDecision {
        crate::semantic_decision::safe_fallback(None, reason)
    }

    /// Seeds a Running chat_turn (with the BrowserSession resource requirement real
    /// chat turns carry) + an aborted agent_run + a resumable checkpoint, then parks
    /// it via `park_chat_turn` — mirrors the engine's finalization-boundary park
    /// (Build 2) so these tests see exactly what the coordinator would see in
    /// production: task `Parked`, a `pending` steering row, no `Running` run.
    fn seed_parked_turn_with_pending_steering(
        state: &crate::AppState,
        turn_id: &str,
        text: &str,
    ) -> local_first_task_runtime::TurnSteeringRecord {
        use local_first_task_runtime::{
            NewAgentRun, ResourceClass, ResourceRequirement, TaskRecord, UserId, WorkspaceId,
        };
        let store = state.task_store.lock().unwrap();
        let mut task = TaskRecord::new(
            turn_id,
            UserId::new("u"),
            WorkspaceId::new("w"),
            "chat_turn",
            "seed goal",
            serde_json::json!({}),
        );
        task.status = TaskStatus::Running;
        task.resource_requirements = vec![ResourceRequirement::new(ResourceClass::BrowserSession, 1)];
        store.insert_chat_turn(&task, "thread", "req-1", "interactive", "full").unwrap();
        store
            .create_agent_run(&NewAgentRun {
                run_id: format!("run-{turn_id}"),
                turn_id: turn_id.to_string(),
                thread_id: "thread".to_string(),
                user_id: "u".to_string(),
                workspace_id: "w".to_string(),
                model: None,
                provider: None,
                prompt_fingerprint: None,
            })
            .unwrap();
        store
            .append_agent_checkpoint(&format!("run-{turn_id}"), 3, &serde_json::json!({"round": 3}), "fp", true)
            .unwrap();
        store.park_chat_turn(turn_id, "u", "w").unwrap();

        store
            .append_turn_steering(
                "u",
                "w",
                "thread",
                turn_id,
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
            .unwrap()
    }

    #[test]
    fn model_down_probe_backs_off_and_keeps_the_task_parked() {
        let state = crate::AppState::for_tests();
        let pending = seed_parked_turn_with_pending_steering(&state, "turn-park-1", "finish now");

        resolve_pending_without_running_run(&state, &pending, |_, _, _, _| {
            fallback_decision("model_unavailable")
        });

        let store = state.task_store.lock().unwrap();
        let task = store
            .get_task(
                &local_first_task_runtime::TaskId::new("turn-park-1"),
                &local_first_task_runtime::UserId::new("u"),
                &local_first_task_runtime::WorkspaceId::new("w"),
            )
            .unwrap()
            .unwrap();
        assert_eq!(task.status, TaskStatus::Parked, "model down: stays parked");

        let row = store.load_turn_steering(pending.steering_id, "u", "w").unwrap().unwrap();
        assert_eq!(row.status, TurnSteeringStatus::Pending, "steering stays pending across the park");
        assert_eq!(row.interpretation_attempts, 1);
        assert!(row.next_retry_at.is_some_and(|value| value > 0));
        assert_eq!(row.last_interpretation_error.as_deref(), Some("model_unavailable"));
    }

    #[test]
    fn model_up_probe_unparks_the_task_and_leaves_steering_pending() {
        let state = crate::AppState::for_tests();
        let pending = seed_parked_turn_with_pending_steering(&state, "turn-park-2", "finish now");

        resolve_pending_without_running_run(&state, &pending, |_, _, _, _| actionable_decision());

        let store = state.task_store.lock().unwrap();
        let task = store
            .get_task(
                &local_first_task_runtime::TaskId::new("turn-park-2"),
                &local_first_task_runtime::UserId::new("u"),
                &local_first_task_runtime::WorkspaceId::new("w"),
            )
            .unwrap()
            .unwrap();
        assert_eq!(task.status, TaskStatus::Queued, "model up: unparked back to queued");

        let row = store.load_turn_steering(pending.steering_id, "u", "w").unwrap().unwrap();
        assert_eq!(row.status, TurnSteeringStatus::Pending, "still pending — the resumed run interprets it");
        assert_eq!(row.interpretation_attempts, 0, "the probe itself is not a recorded interpretation attempt");
    }

    #[test]
    fn orphaned_pending_row_backs_off_then_goes_terminal_after_max_attempts() {
        let state = crate::AppState::for_tests();
        // No task row at all for this turn_id — genuinely orphaned (no Running run,
        // no Parked checkpoint): the turn completed/vanished out from under the row.
        let store = state.task_store.lock().unwrap();
        let mut pending = store
            .append_turn_steering(
                "u",
                "w",
                "thread",
                "turn-orphan",
                &NewTurnSteering {
                    source_message_id: "message-orphan".to_string(),
                    prompt: "finish now".to_string(),
                    visible_prompt: "finish now".to_string(),
                    images: Vec::new(),
                    attachments: serde_json::json!([]),
                    mode: None,
                    model: None,
                },
                1,
            )
            .unwrap();
        drop(store);

        // The probe closure must never be called on the orphan path — a bare,
        // non-capturing closure is `Copy`, so passing it into a `FnOnce` parameter
        // repeatedly across the loop below just copies it each time.
        let unreachable_probe = |_: Option<&str>,
                                 _: &str,
                                 _: Option<&local_first_task_runtime::ObjectiveContractRecord>,
                                 _: Option<&crate::RoutingBinding>| -> ValidatedSemanticDecision {
            panic!("orphan handling must not call the model");
        };

        for attempt in 1..MAX_ORPHAN_INTERPRETATION_ATTEMPTS {
            resolve_pending_without_running_run(&state, &pending, unreachable_probe);
            let store = state.task_store.lock().unwrap();
            let row = store.load_turn_steering(pending.steering_id, "u", "w").unwrap().unwrap();
            assert_eq!(row.status, TurnSteeringStatus::Pending, "attempt {attempt}: still backing off");
            assert_eq!(row.interpretation_attempts, attempt);
            assert_eq!(row.last_interpretation_error.as_deref(), Some("turn_orphaned"));
            drop(store);
            pending = row;
        }

        // Crossing the budget: terminal (`held`), surfaced instead of polling forever.
        resolve_pending_without_running_run(&state, &pending, unreachable_probe);
        let store = state.task_store.lock().unwrap();
        let row = store.load_turn_steering(pending.steering_id, "u", "w").unwrap().unwrap();
        assert_eq!(row.status, TurnSteeringStatus::Held, "surfaced instead of polling forever");
    }

    #[test]
    fn waiting_for_model_activity_is_emitted_once_for_a_parked_turn() {
        let state = crate::AppState::for_tests();
        seed_parked_turn_with_pending_steering(&state, "turn-park-3", "finish now");

        emit_waiting_for_model_activity_once(&state, "turn-park-3");
        emit_waiting_for_model_activity_once(&state, "turn-park-3");

        let store = state.task_store.lock().unwrap();
        let events = store.read_turn_events("turn-park-3", 0).unwrap();
        let waiting_activity_count = events
            .iter()
            .filter(|event| {
                event.kind == local_first_task_runtime::TurnEventKind::Activity
                    && event.payload.get("marker").and_then(|value| value.as_str())
                        == Some(PARKED_WAITING_ACTIVITY_MARKER)
            })
            .count();
        assert_eq!(waiting_activity_count, 1, "idempotent — emitted exactly once despite two calls");
    }

    /// Review C1 regression: the window between `unpark_chat_turn_to_queued` (task ->
    /// Queued, then the scheduler flips it Running) and the resumed dispatch's OWN
    /// new `create_agent_run` row (which lands only after `execute_chat_turn_task`'s
    /// pre-run semantic call, potentially tens of seconds later) must NOT be treated
    /// as orphaned. Before the fix, "no Running run" alone routed here to the orphan
    /// arm, consuming the orphan-attempt budget with a counter ALSO fed by ordinary
    /// probe backoffs — a model outage long enough to accumulate a few backoffs,
    /// followed by recovery + unpark, could land the very next poll (in-transit) on
    /// `held` instead of leaving the steering to be applied by the resumed run.
    #[test]
    fn resume_in_transit_window_is_not_misclassified_as_orphan() {
        let state = crate::AppState::for_tests();
        let turn_id = "turn-c1";
        let mut pending = seed_parked_turn_with_pending_steering(&state, turn_id, "finish now");

        // A model outage: several probe cycles defer while parked, accumulating
        // attempts on the SAME counter the orphan budget also reads.
        for _ in 0..3 {
            resolve_pending_without_running_run(&state, &pending, |_, _, _, _| {
                fallback_decision("model_unavailable")
            });
            let store = state.task_store.lock().unwrap();
            pending = store.load_turn_steering(pending.steering_id, "u", "w").unwrap().unwrap();
            drop(store);
        }
        assert!(pending.interpretation_attempts >= 3, "attempts accumulated from the outage");

        // The model recovers: the probe is actionable -> unpark.
        resolve_pending_without_running_run(&state, &pending, |_, _, _, _| actionable_decision());
        {
            let store = state.task_store.lock().unwrap();
            let task = store
                .get_task(
                    &local_first_task_runtime::TaskId::new(turn_id),
                    &local_first_task_runtime::UserId::new("u"),
                    &local_first_task_runtime::WorkspaceId::new("w"),
                )
                .unwrap()
                .unwrap();
            assert_eq!(task.status, TaskStatus::Queued, "unparked");
        }
        let after_unpark = {
            let store = state.task_store.lock().unwrap();
            store.load_turn_steering(pending.steering_id, "u", "w").unwrap().unwrap()
        };
        assert_eq!(after_unpark.interpretation_attempts, 0, "unpark resets the shared attempts counter");
        assert_eq!(after_unpark.status, TurnSteeringStatus::Pending);

        // In-transit window: the scheduler flips the task Running (mirrors the real
        // acquire step), but the resumed dispatch has not yet created its NEW
        // agent_run row — no Running run exists for this turn yet. This is exactly
        // the window the coordinator's "no Running run" path sees on its very next
        // 500ms poll.
        {
            let store = state.task_store.lock().unwrap();
            let task_id = local_first_task_runtime::TaskId::new(turn_id);
            let mut task = store
                .get_task(
                    &task_id,
                    &local_first_task_runtime::UserId::new("u"),
                    &local_first_task_runtime::WorkspaceId::new("w"),
                )
                .unwrap()
                .unwrap();
            task.status = TaskStatus::Running;
            store.insert_chat_turn(&task, "thread", "req-1", "interactive", "full").unwrap();
        }

        let unreachable_probe = |_: Option<&str>,
                                 _: &str,
                                 _: Option<&local_first_task_runtime::ObjectiveContractRecord>,
                                 _: Option<&crate::RoutingBinding>|
         -> ValidatedSemanticDecision { panic!("in-transit must not probe the model") };
        resolve_pending_without_running_run(&state, &after_unpark, unreachable_probe);

        let store = state.task_store.lock().unwrap();
        let row = store.load_turn_steering(after_unpark.steering_id, "u", "w").unwrap().unwrap();
        assert_eq!(row.status, TurnSteeringStatus::Pending, "still pending — not held");
        assert_eq!(row.interpretation_attempts, 0, "in-transit does not consume the orphan budget");
        assert!(row.next_retry_at.is_none(), "a plain wait, not a deferred retry");
    }
}
