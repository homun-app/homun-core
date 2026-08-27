//! Agent stream drain orchestration.
//!
//! Owns draining raw agent stream entries into visible assistant messages and,
//! on broker turns, durable turn-event fanout. Pure parsing, persistence
//! helpers, HITL wait snapshots, and browser execution remain separate owners.

use super::*;

#[derive(Debug, Clone)]
pub(crate) struct AgentTurnResult {
    pub(crate) text: String,
    pub(crate) actionable_cards: Vec<ActionableCard>,
    pub(crate) outcome: local_first_engine::TurnOutcome,
}

pub(crate) struct BrokerAgentTurnResult {
    pub(crate) outcome: local_first_engine::TurnOutcome,
}

pub(crate) async fn drain_agent_stream_into_message(
    state: &AppState,
    thread_id: &str,
    assistant_message_id: &str,
    entry: std::sync::Arc<StreamEntry>,
    requested_delivery_state: local_first_desktop_gateway::MessageDeliveryState,
) -> Result<Option<AgentTurnResult>, String> {
    if let Ok(mut stored_id) = entry.assistant_message_id.lock() {
        *stored_id = Some(assistant_message_id.to_string());
    }
    let mut streamed_text = String::new();
    let mut final_text: Option<String> = None;
    let mut last_flush = std::time::Instant::now();
    let mut last_flushed_len = 0usize;
    let mut memory_reuse = StreamMemoryReuseCollector::default();

    let (snapshot, mut brx) = {
        let buf = entry.lines.lock().expect("stream lines lock");
        (buf.clone(), entry.tx.subscribe())
    };
    for line in snapshot {
        let terminal = apply_agent_stream_line(&line, &mut streamed_text, &mut final_text);
        memory_reuse.observe_line(&line);
        persist_recall_event_part(state, thread_id, assistant_message_id, &line);
        if streamed_text.len() != last_flushed_len
            && last_flush.elapsed() >= std::time::Duration::from_millis(200)
        {
            update_channel_assistant_message(
                state,
                thread_id,
                assistant_message_id,
                &streamed_text,
            );
            last_flush = std::time::Instant::now();
            last_flushed_len = streamed_text.len();
        }
        if terminal {
            break;
        }
    }

    while final_text.is_none() {
        match brx.recv().await {
            Ok(line) => {
                let terminal = apply_agent_stream_line(&line, &mut streamed_text, &mut final_text);
                memory_reuse.observe_line(&line);
                persist_recall_event_part(state, thread_id, assistant_message_id, &line);
                if streamed_text.len() != last_flushed_len
                    && last_flush.elapsed() >= std::time::Duration::from_millis(200)
                {
                    update_channel_assistant_message(
                        state,
                        thread_id,
                        assistant_message_id,
                        &streamed_text,
                    );
                    last_flush = std::time::Instant::now();
                    last_flushed_len = streamed_text.len();
                }
                if terminal {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }

    let outcome = wait_for_stream_outcome(entry).await;
    let raw_final_text = final_text.unwrap_or(streamed_text);
    let remote_approval = remote_approval_intent_from_raw_text(&raw_final_text);
    let actionable_cards = actionable_cards_from_raw_text(&raw_final_text);
    if let Some(intent) = remote_approval.as_ref() {
        memory_reuse.observe_remote_approval(intent);
    }
    memory_reuse.observe_actionable_cards(&actionable_cards);
    let mut final_text = strip_chat_markers(&raw_final_text);
    if final_text.is_empty() && actionable_cards.is_empty() {
        return Ok(None);
    }
    if final_text.is_empty() {
        final_text = "Waiting for your approval.".to_string();
    }
    finalize_streamed_assistant_message(
        state,
        thread_id,
        assistant_message_id,
        &raw_final_text,
        &memory_reuse,
        requested_delivery_state,
    )?;
    Ok(Some(AgentTurnResult {
        text: final_text,
        actionable_cards,
        outcome,
    }))
}

/// Like `drain_agent_stream_into_message` but additionally mirrors each raw
/// stream event into the turn_events durable log + per-turn live broadcast via
/// `fanout_turn_event`. Used by the broker executor path; the automation path
/// keeps using the plain drain.
pub(crate) async fn drain_agent_stream_into_message_with_fanout(
    state: &AppState,
    thread_id: &str,
    user_message_id: &str,
    assistant_message_id: &str,
    entry: std::sync::Arc<StreamEntry>,
    turn_id: &str,
    requested_delivery_state: local_first_desktop_gateway::MessageDeliveryState,
) -> Result<BrokerAgentTurnResult, String> {
    if let Ok(mut stored_id) = entry.assistant_message_id.lock() {
        *stored_id = Some(assistant_message_id.to_string());
    }
    let mut streamed_text = String::new();
    let mut final_text: Option<String> = None;
    let mut last_flush = std::time::Instant::now();
    let mut last_flushed_len = 0usize;
    let mut memory_reuse = StreamMemoryReuseCollector::default();

    let (snapshot, mut brx) = {
        let buf = entry.lines.lock().expect("stream lines lock");
        (buf.clone(), entry.tx.subscribe())
    };
    for line in snapshot {
        let terminal = apply_agent_stream_line(&line, &mut streamed_text, &mut final_text);
        memory_reuse.observe_line(&line);
        persist_redacted_user_text_from_stream_line(state, thread_id, user_message_id, &line);
        persist_recall_event_part(state, thread_id, assistant_message_id, &line);
        fanout_turn_event(state, turn_id, &line);
        if streamed_text.len() != last_flushed_len
            && last_flush.elapsed() >= std::time::Duration::from_millis(200)
        {
            update_channel_assistant_message(
                state,
                thread_id,
                assistant_message_id,
                &streamed_text,
            );
            last_flush = std::time::Instant::now();
            last_flushed_len = streamed_text.len();
        }
        if terminal {
            break;
        }
    }

    let mut typed_outcome = None;
    let mut typed_outcome_grace_started: Option<std::time::Instant> = None;
    while final_text.is_none() {
        if typed_outcome.is_some() {
            let started = typed_outcome_grace_started.get_or_insert_with(std::time::Instant::now);
            let elapsed = started.elapsed();
            let grace = std::time::Duration::from_millis(75);
            if elapsed >= grace {
                break;
            }
            match tokio::time::timeout(grace - elapsed, brx.recv()).await {
                Ok(Ok(line)) => {
                    let terminal =
                        apply_agent_stream_line(&line, &mut streamed_text, &mut final_text);
                    memory_reuse.observe_line(&line);
                    persist_redacted_user_text_from_stream_line(
                        state,
                        thread_id,
                        user_message_id,
                        &line,
                    );
                    persist_recall_event_part(state, thread_id, assistant_message_id, &line);
                    fanout_turn_event(state, turn_id, &line);
                    if streamed_text.len() != last_flushed_len
                        && last_flush.elapsed() >= std::time::Duration::from_millis(200)
                    {
                        update_channel_assistant_message(
                            state,
                            thread_id,
                            assistant_message_id,
                            &streamed_text,
                        );
                        last_flush = std::time::Instant::now();
                        last_flushed_len = streamed_text.len();
                    }
                    if terminal {
                        break;
                    }
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) | Err(_) => break,
            }
            continue;
        }
        let outcome_ready = entry.outcome_ready.notified();
        if let Some(outcome) = entry.outcome.lock().ok().and_then(|slot| slot.clone()) {
            typed_outcome = Some(outcome);
            typed_outcome_grace_started = Some(std::time::Instant::now());
            continue;
        }
        tokio::select! {
            received = brx.recv() => match received {
            Ok(line) => {
                let terminal = apply_agent_stream_line(&line, &mut streamed_text, &mut final_text);
                memory_reuse.observe_line(&line);
                persist_redacted_user_text_from_stream_line(
                    state,
                    thread_id,
                    user_message_id,
                    &line,
                );
                persist_recall_event_part(state, thread_id, assistant_message_id, &line);
                fanout_turn_event(state, turn_id, &line);
                if streamed_text.len() != last_flushed_len
                    && last_flush.elapsed() >= std::time::Duration::from_millis(200)
                {
                    update_channel_assistant_message(
                        state,
                        thread_id,
                        assistant_message_id,
                        &streamed_text,
                    );
                    last_flush = std::time::Instant::now();
                    last_flushed_len = streamed_text.len();
                }
                if terminal {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            _ = outcome_ready => {
                typed_outcome = entry.outcome.lock().ok().and_then(|slot| slot.clone());
                typed_outcome_grace_started = Some(std::time::Instant::now());
            }
        }
    }

    // The engine publishes the typed outcome only after all stream emissions.
    // Drain any lines already queued before using the outcome as the transport close.
    while let Ok(line) = brx.try_recv() {
        apply_agent_stream_line(&line, &mut streamed_text, &mut final_text);
        memory_reuse.observe_line(&line);
        persist_redacted_user_text_from_stream_line(state, thread_id, user_message_id, &line);
        persist_recall_event_part(state, thread_id, assistant_message_id, &line);
        fanout_turn_event(state, turn_id, &line);
    }
    let outcome = match typed_outcome {
        Some(outcome) => outcome,
        None => wait_for_stream_outcome(entry.clone()).await,
    };

    let raw_final_text = final_text.unwrap_or(streamed_text);
    let remote_approval = remote_approval_intent_from_raw_text(&raw_final_text);
    let actionable_cards = actionable_cards_from_raw_text(&raw_final_text);
    if let Some(intent) = remote_approval.as_ref() {
        memory_reuse.observe_remote_approval(intent);
    }
    memory_reuse.observe_actionable_cards(&actionable_cards);
    let final_text = strip_chat_markers(&raw_final_text);
    if !(final_text.is_empty() && actionable_cards.is_empty()) {
        finalize_streamed_assistant_message(
            state,
            thread_id,
            assistant_message_id,
            &raw_final_text,
            &memory_reuse,
            requested_delivery_state,
        )?;
    }
    Ok(BrokerAgentTurnResult { outcome })
}
