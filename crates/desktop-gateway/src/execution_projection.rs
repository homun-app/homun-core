use local_first_execution_protocol::ExecutionOutcome;
use local_first_execution_protocol::{ValidatedExecutionContract, WakeCondition};
use local_first_task_runtime::{
    AgentRunStatus, ExecutionProjection, TaskRecord, TaskStatus, TurnEventKind,
};
use time::OffsetDateTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ChatProjectionDecision {
    pub(crate) task_status: TaskStatus,
    pub(crate) run_status: Option<AgentRunStatus>,
    pub(crate) event_kind: TurnEventKind,
}

pub(crate) fn chat_projection_decision(outcome: &ExecutionOutcome) -> ChatProjectionDecision {
    let projection = ExecutionProjection::from_outcome(outcome);
    let event_kind = match outcome {
        ExecutionOutcome::Completed { .. } => TurnEventKind::Done,
        ExecutionOutcome::Suspended { .. } => TurnEventKind::Suspended,
        ExecutionOutcome::Cancelled { .. } => TurnEventKind::Cancelled,
        ExecutionOutcome::Failed { .. } => TurnEventKind::Error,
    };
    ChatProjectionDecision {
        task_status: projection.task_status,
        run_status: projection.run_status,
        event_kind,
    }
}

pub(crate) async fn project_chat_execution(
    state: &crate::AppState,
    task: &TaskRecord,
    contract: &ValidatedExecutionContract,
    outcome: &ExecutionOutcome,
) -> Result<(), crate::LocalTaskExecutionError> {
    let projection_ref = format!(
        "{}:{}",
        contract.as_ref().execution_id,
        contract.as_ref().revision
    );
    if state
        .task_store
        .lock()
        .map_err(projection_lock_error)?
        .read_turn_events(task.task_id.as_str(), 0)
        .map_err(projection_store_error)?
        .iter()
        .any(|event| {
            event
                .payload
                .get("projection_ref")
                .and_then(|value| value.as_str())
                == Some(projection_ref.as_str())
        })
    {
        return Ok(());
    }

    let metadata = projection_metadata(state, task, outcome)?;
    let thread_id = metadata
        .get("thread_id")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            task.input_json
                .get("thread_id")
                .and_then(serde_json::Value::as_str)
        })
        .ok_or_else(|| projection_error("chat projection has no thread_id"))?;
    let assistant_message_id = metadata
        .get("assistant_message_id")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            task.input_json
                .get("assistant_message_id")
                .and_then(serde_json::Value::as_str)
        })
        .ok_or_else(|| projection_error("chat projection has no assistant_message_id"))?;
    let decision = chat_projection_decision(outcome);

    project_task_state(state, task, decision.task_status, outcome)?;
    project_agent_run(state, task, &metadata, decision.run_status)?;
    project_message_state(state, thread_id, assistant_message_id, outcome)?;
    project_objective(state, task, thread_id, &metadata, outcome)?;
    project_human_wait(state, thread_id, assistant_message_id, &metadata, outcome).await?;

    if let ExecutionOutcome::Completed { .. } = outcome {
        let answer = metadata
            .get("answer")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        crate::mirror_reply_to_channel_if_any(state, thread_id, answer).await;
    }

    let (wake_kind, scoped_ref) = match outcome {
        ExecutionOutcome::Suspended { wake, .. } => wake_projection_fields(wake),
        _ => (None, None),
    };
    let terminal_text = match outcome {
        ExecutionOutcome::Completed { .. } => metadata
            .get("answer")
            .and_then(serde_json::Value::as_str)
            .map(crate::strip_chat_markers),
        _ => None,
    };
    let payload = serde_json::json!({
        "projection_ref": projection_ref,
        "execution_id": contract.as_ref().execution_id,
        "revision": contract.as_ref().revision,
        "assistant_message_id": assistant_message_id,
        "wake_kind": wake_kind,
        "scoped_ref": scoped_ref,
        "text": terminal_text,
    });
    let store = state.task_store.lock().map_err(projection_lock_error)?;
    crate::turn_executor::emit_turn_event(
        state,
        &store,
        task.task_id.as_str(),
        decision.event_kind,
        payload,
    )
    .map_err(projection_store_error)
}

pub(crate) async fn replay_committed_chat_projections(
    state: &crate::AppState,
    limit: usize,
) -> Result<usize, crate::LocalTaskExecutionError> {
    let records = state
        .task_store
        .lock()
        .map_err(projection_lock_error)?
        .committed_executions(limit)
        .map_err(projection_store_error)?;
    let mut replayed = 0usize;
    for record in records {
        if record.contract.as_ref().kind != "chat_turn" {
            continue;
        }
        let contract = record.contract;
        let scope = &contract.as_ref().scope;
        let task_id = local_first_task_runtime::TaskId::new(contract.as_ref().execution_id.clone());
        let user_id = local_first_task_runtime::UserId::new(scope.user_id.clone());
        let workspace_id = local_first_task_runtime::WorkspaceId::new(scope.workspace_id.clone());
        let task = state
            .task_store
            .lock()
            .map_err(projection_lock_error)?
            .get_task(&task_id, &user_id, &workspace_id)
            .map_err(projection_store_error)?;
        let Some(task) = task else {
            continue;
        };
        let Some(outcome) = record.outcome else {
            continue;
        };
        project_chat_execution(state, &task, &contract, outcome.as_ref()).await?;
        replayed += 1;
    }
    Ok(replayed)
}

fn projection_metadata(
    state: &crate::AppState,
    task: &TaskRecord,
    outcome: &ExecutionOutcome,
) -> Result<serde_json::Value, crate::LocalTaskExecutionError> {
    let checkpoint_metadata = || {
        state
            .task_store
            .lock()
            .map_err(projection_lock_error)?
            .latest_checkpoint(&task.task_id, &task.user_id, &task.workspace_id)
            .map_err(projection_store_error)?
            .map(|checkpoint| {
                checkpoint
                    .payload
                    .get("state")
                    .cloned()
                    .unwrap_or(checkpoint.payload)
            })
            .ok_or_else(|| projection_error("visible execution projection has no checkpoint"))
    };
    match outcome {
        ExecutionOutcome::Completed { output, .. }
            if output
                .get("assistant_message_id")
                .and_then(serde_json::Value::as_str)
                .is_some() =>
        {
            Ok(output.clone())
        }
        ExecutionOutcome::Completed { .. } | ExecutionOutcome::Suspended { .. } => {
            checkpoint_metadata()
        }
        ExecutionOutcome::Cancelled { .. } | ExecutionOutcome::Failed { .. } => {
            checkpoint_metadata().or_else(|_| Ok(task.input_json.clone()))
        }
    }
}

fn project_task_state(
    state: &crate::AppState,
    task: &TaskRecord,
    status: TaskStatus,
    outcome: &ExecutionOutcome,
) -> Result<(), crate::LocalTaskExecutionError> {
    let store = state.task_store.lock().map_err(projection_lock_error)?;
    let mut current = store
        .get_task(&task.task_id, &task.user_id, &task.workspace_id)
        .map_err(projection_store_error)?
        .ok_or_else(|| projection_error("chat task disappeared before projection"))?;
    current.status = status;
    current.blocked_reason = match outcome {
        ExecutionOutcome::Completed { .. } => None,
        ExecutionOutcome::Suspended { wake, .. } => Some(format!("waiting for {wake:?}")),
        ExecutionOutcome::Cancelled { .. } => Some("cancelled by user".to_string()),
        ExecutionOutcome::Failed { failure } => Some(failure.redacted_detail.clone()),
    };
    current.not_before = match outcome {
        ExecutionOutcome::Suspended {
            wake: WakeCondition::At { unix_seconds },
            ..
        } => OffsetDateTime::from_unix_timestamp(*unix_seconds).ok(),
        _ => None,
    };
    current.lease_owner = None;
    current.lease_expires_at = None;
    current.last_heartbeat_at = None;
    current.updated_at = OffsetDateTime::now_utc();
    store
        .release_resources(&current)
        .map_err(projection_store_error)?;
    store.insert_task(&current).map_err(projection_store_error)
}

fn project_agent_run(
    state: &crate::AppState,
    task: &TaskRecord,
    metadata: &serde_json::Value,
    run_status: Option<AgentRunStatus>,
) -> Result<(), crate::LocalTaskExecutionError> {
    let Some(run_status) = run_status else {
        return Ok(());
    };
    let store = state.task_store.lock().map_err(projection_lock_error)?;
    let run_id = metadata
        .get("agent_run_id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            store
                .list_agent_runs_for_turn(
                    task.task_id.as_str(),
                    task.user_id.as_str(),
                    task.workspace_id.as_str(),
                )
                .ok()
                .and_then(|runs| runs.last().map(|run| run.run_id.clone()))
        });
    let Some(run_id) = run_id else {
        return Ok(());
    };
    if store
        .list_agent_runs_for_turn(
            task.task_id.as_str(),
            task.user_id.as_str(),
            task.workspace_id.as_str(),
        )
        .map_err(projection_store_error)?
        .iter()
        .any(|run| run.run_id == run_id && run.status == run_status)
    {
        return Ok(());
    }
    let reason = match run_status {
        AgentRunStatus::Completed => "canonical_completed",
        AgentRunStatus::Aborted => "canonical_suspended_or_cancelled",
        AgentRunStatus::Failed => "canonical_failed",
        AgentRunStatus::Running => return Ok(()),
    };
    store
        .finish_agent_run(&run_id, run_status, Some(reason))
        .map_err(projection_store_error)?;
    if let Ok(data_dir) = crate::gateway_data_dir() {
        crate::working_ledger::materialize(
            &store,
            &data_dir,
            task.user_id.as_str(),
            task.workspace_id.as_str(),
            metadata
                .get("thread_id")
                .and_then(serde_json::Value::as_str)
                .or_else(|| {
                    task.input_json
                        .get("thread_id")
                        .and_then(serde_json::Value::as_str)
                })
                .unwrap_or_default(),
        )
        .map_err(projection_error)?;
    }
    Ok(())
}

fn project_message_state(
    state: &crate::AppState,
    thread_id: &str,
    assistant_message_id: &str,
    outcome: &ExecutionOutcome,
) -> Result<(), crate::LocalTaskExecutionError> {
    let delivery = match outcome {
        ExecutionOutcome::Completed { .. } => {
            local_first_desktop_gateway::MessageDeliveryState::Delivered
        }
        ExecutionOutcome::Suspended {
            wake: WakeCondition::User { .. },
            ..
        } => local_first_desktop_gateway::MessageDeliveryState::Delivered,
        ExecutionOutcome::Suspended {
            wake: WakeCondition::Approval { .. } | WakeCondition::EffectResolution { .. },
            ..
        } => local_first_desktop_gateway::MessageDeliveryState::WaitingUser,
        ExecutionOutcome::Suspended { .. } => {
            local_first_desktop_gateway::MessageDeliveryState::Streaming
        }
        ExecutionOutcome::Cancelled { .. } => {
            local_first_desktop_gateway::MessageDeliveryState::Cancelled
        }
        ExecutionOutcome::Failed { .. } => {
            local_first_desktop_gateway::MessageDeliveryState::Failed
        }
    };
    let updated = state
        .chat_store
        .lock()
        .map_err(projection_lock_error)?
        .set_message_delivery_state(thread_id, assistant_message_id, delivery)
        .map_err(|error| projection_error(error.to_string()))?;
    if !updated && !matches!(outcome, ExecutionOutcome::Failed { .. }) {
        return Err(projection_error(format!(
            "chat projection message is missing: {assistant_message_id}"
        )));
    }
    Ok(())
}

fn project_objective(
    state: &crate::AppState,
    task: &TaskRecord,
    thread_id: &str,
    metadata: &serde_json::Value,
    outcome: &ExecutionOutcome,
) -> Result<(), crate::LocalTaskExecutionError> {
    let status = match outcome {
        ExecutionOutcome::Completed { .. } => "completed",
        ExecutionOutcome::Cancelled { .. } => "cancelled",
        ExecutionOutcome::Suspended { .. } | ExecutionOutcome::Failed { .. } => return Ok(()),
    };
    let Some(revision) = metadata
        .get("objective_revision")
        .and_then(serde_json::Value::as_u64)
    else {
        return Ok(());
    };
    state
        .task_store
        .lock()
        .map_err(projection_lock_error)?
        .transition_objective_contract_status(
            task.user_id.as_str(),
            task.workspace_id.as_str(),
            thread_id,
            revision,
            status,
        )
        .map_err(projection_store_error)?;
    Ok(())
}

async fn project_human_wait(
    state: &crate::AppState,
    thread_id: &str,
    assistant_message_id: &str,
    metadata: &serde_json::Value,
    outcome: &ExecutionOutcome,
) -> Result<(), crate::LocalTaskExecutionError> {
    match outcome {
        ExecutionOutcome::Suspended {
            wake: WakeCondition::User { .. },
            ..
        } => {
            let Some(envelope) = metadata.get("awaiting_user").cloned() else {
                return Err(projection_error("user suspension has no HITL envelope"));
            };
            let envelope: local_first_engine::HitlEnvelope = serde_json::from_value(envelope)
                .map_err(|error| projection_error(error.to_string()))?;
            let store =
                crate::lock_store(state).map_err(|error| projection_error(error.message))?;
            crate::persist_hitl_wait_payload(
                &store,
                state,
                thread_id,
                assistant_message_id,
                envelope.wait_kind_key(),
                envelope.payload,
            );
        }
        ExecutionOutcome::Suspended {
            wake: WakeCondition::Approval { .. } | WakeCondition::EffectResolution { .. },
            ..
        } => {
            let message = crate::lock_store(state).ok().and_then(|store| {
                store
                    .message(thread_id, assistant_message_id)
                    .ok()
                    .flatten()
            });
            if let Some(message) = message {
                crate::activate_remote_approvals_from_message(state, thread_id, &message).await;
            }
        }
        _ => {}
    }
    Ok(())
}

fn wake_projection_fields(wake: &WakeCondition) -> (Option<&'static str>, Option<&str>) {
    match wake {
        WakeCondition::At { .. } => (Some("at"), None),
        WakeCondition::Signal { correlation_id, .. } => (Some("signal"), Some(correlation_id)),
        WakeCondition::User { wait_ref } => (Some("user"), Some(wait_ref)),
        WakeCondition::Approval { approval_ref } => (Some("approval"), Some(approval_ref)),
        WakeCondition::ModelAvailable { role } => (Some("model_available"), Some(role)),
        WakeCondition::Resource { class } => (Some("resource"), Some(class)),
        WakeCondition::EffectResolution { receipt_ref } => {
            (Some("effect_resolution"), Some(receipt_ref.as_ref()))
        }
    }
}

fn projection_store_error(
    error: local_first_task_runtime::TaskRuntimeError,
) -> crate::LocalTaskExecutionError {
    projection_error(error.to_string())
}

fn projection_lock_error<T>(error: std::sync::PoisonError<T>) -> crate::LocalTaskExecutionError {
    projection_error(error.to_string())
}

fn projection_error(message: impl Into<String>) -> crate::LocalTaskExecutionError {
    crate::LocalTaskExecutionError {
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use local_first_execution_protocol::{
        CancelReason, CheckpointDataRef, CheckpointEnvelope, DurableDataRef, ExecutionContract,
        ExecutionFailure, ExecutionOutcome, ExecutionScope, ValidatedExecutionContract,
        ValidatedExecutionOutcome, WakeCondition,
    };
    use local_first_task_runtime::{
        AgentRunStatus, NewAgentRun, TaskRecord, TaskStatus, TurnEventKind, UserId, WorkspaceId,
    };

    fn suspended(wake: WakeCondition) -> ExecutionOutcome {
        ExecutionOutcome::Suspended {
            wake,
            checkpoint: CheckpointEnvelope::new(
                "turn-1",
                1,
                "chat_turn",
                1,
                CheckpointDataRef::Redacted {
                    record_ref: DurableDataRef::from_store_id("0123456789abcdef0123456789abcdef")
                        .expect("valid ref"),
                },
            ),
        }
    }

    #[test]
    fn every_chat_outcome_has_one_lifecycle_projection() {
        let cases = [
            (
                ExecutionOutcome::completed(serde_json::json!({})),
                TaskStatus::Completed,
                Some(AgentRunStatus::Completed),
                TurnEventKind::Done,
            ),
            (
                suspended(WakeCondition::User {
                    wait_ref: "turn-1:1:user".to_string(),
                }),
                TaskStatus::WaitingUserApproval,
                Some(AgentRunStatus::Completed),
                TurnEventKind::Suspended,
            ),
            (
                suspended(WakeCondition::ModelAvailable {
                    role: "primary".to_string(),
                }),
                TaskStatus::Parked,
                Some(AgentRunStatus::Aborted),
                TurnEventKind::Suspended,
            ),
            (
                ExecutionOutcome::Cancelled {
                    reason: CancelReason::User,
                },
                TaskStatus::Cancelled,
                Some(AgentRunStatus::Aborted),
                TurnEventKind::Cancelled,
            ),
            (
                ExecutionOutcome::Failed {
                    failure: ExecutionFailure::permanent("no_reply", "No reply"),
                },
                TaskStatus::Failed,
                Some(AgentRunStatus::Failed),
                TurnEventKind::Error,
            ),
        ];

        for (outcome, task_status, run_status, event_kind) in cases {
            let decision = chat_projection_decision(&outcome);
            assert_eq!(decision.task_status, task_status);
            assert_eq!(decision.run_status, run_status);
            assert_eq!(decision.event_kind, event_kind);
        }
    }

    #[tokio::test]
    async fn replaying_a_committed_projection_is_a_noop() {
        let state = crate::AppState::for_tests();
        let thread = state
            .chat_store
            .lock()
            .expect("chat store")
            .create_thread("workspace-1")
            .expect("thread");
        let mut assistant = local_first_desktop_gateway::seeded_ready_message(
            &thread.thread_id,
            "2027-01-15T08:00:00Z".to_string(),
        );
        assistant.id = "assistant-projection-1".to_string();
        assistant.delivery_state = local_first_desktop_gateway::MessageDeliveryState::Streaming;

        let mut task = TaskRecord::new(
            "turn-projection-1",
            UserId::new("user-1"),
            WorkspaceId::new("workspace-1"),
            "chat_turn",
            "projection test",
            serde_json::json!({
                "thread_id": thread.thread_id,
                "assistant_message_id": assistant.id,
            }),
        );
        task.status = TaskStatus::Running;
        task.lease_owner = Some("worker-1".to_string());
        state
            .task_store
            .lock()
            .expect("task store")
            .insert_task(&task)
            .expect("task");
        state
            .task_store
            .lock()
            .expect("task store")
            .create_agent_run(&NewAgentRun {
                run_id: "run-projection-1".to_string(),
                turn_id: task.task_id.as_str().to_string(),
                thread_id: thread.thread_id.clone(),
                user_id: task.user_id.as_str().to_string(),
                workspace_id: task.workspace_id.as_str().to_string(),
                model: None,
                provider: None,
                prompt_fingerprint: None,
            })
            .expect("run");
        let contract: ValidatedExecutionContract = ExecutionContract::new(
            task.task_id.as_str(),
            "chat_turn",
            ExecutionScope {
                user_id: task.user_id.as_str().to_string(),
                workspace_id: task.workspace_id.as_str().to_string(),
                thread_id: Some(thread.thread_id.clone()),
            },
            serde_json::json!({}),
        )
        .try_into()
        .expect("contract");
        let outcome = ExecutionOutcome::completed(serde_json::json!({
            "kind": "chat_turn",
            "thread_id": thread.thread_id,
            "assistant_message_id": assistant.id,
            "agent_run_id": "run-projection-1",
            "answer": "done",
        }));
        {
            let store = state.task_store.lock().expect("task store");
            store.create_execution(&contract).expect("create execution");
            store
                .commit_execution_outcome(
                    &ValidatedExecutionOutcome::new(outcome.clone(), &contract)
                        .expect("validated outcome"),
                )
                .expect("commit outcome");
        }

        replay_committed_chat_projections(&state, 100)
            .await
            .expect_err("projection must remain pending while the message is missing");
        assert!(
            state
                .task_store
                .lock()
                .expect("task store")
                .read_turn_events(task.task_id.as_str(), 0)
                .expect("events")
                .iter()
                .all(|event| event.payload["projection_ref"] != "turn-projection-1:1")
        );

        state
            .chat_store
            .lock()
            .expect("chat store")
            .append_assistant_message(&thread.thread_id, &assistant)
            .expect("assistant");
        replay_committed_chat_projections(&state, 100)
            .await
            .expect("recovered projection");
        replay_committed_chat_projections(&state, 100)
            .await
            .expect("idempotent replay");

        let store = state.task_store.lock().expect("task store");
        let projected = store
            .get_task(&task.task_id, &task.user_id, &task.workspace_id)
            .expect("load task")
            .expect("task exists");
        assert_eq!(projected.status, TaskStatus::Completed);
        let events = store
            .read_turn_events(task.task_id.as_str(), 0)
            .expect("events");
        assert_eq!(
            events
                .iter()
                .filter(|event| event.payload["projection_ref"] == "turn-projection-1:1")
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .find(|event| event.payload["projection_ref"] == "turn-projection-1:1")
                .expect("terminal projection event")
                .payload["text"],
            "done"
        );
        drop(store);
        let message = state
            .chat_store
            .lock()
            .expect("chat store")
            .message(&thread.thread_id, &assistant.id)
            .expect("message lookup")
            .expect("message");
        assert_eq!(
            message.delivery_state,
            local_first_desktop_gateway::MessageDeliveryState::Delivered
        );
    }

    #[test]
    fn completed_projection_does_not_acknowledge_a_missing_message() {
        let state = crate::AppState::for_tests();
        let outcome = ExecutionOutcome::completed(serde_json::json!({"answer": "done"}));

        let error = project_message_state(&state, "missing-thread", "missing-message", &outcome)
            .expect_err("missing completed message must keep projection pending");

        assert!(error.message.contains("message"));
    }
}
