//! Agent turn outcome/checkpoint helpers.

use local_first_subagents::{GenerateStreamEvent, TokenMetrics};

/// Apply a durable engine checkpoint and optionally append the new user input
/// that caused the resume.
pub(crate) fn apply_agent_recovery_checkpoint(
    state: &mut local_first_engine::LoopState,
    checkpoint: Option<local_first_engine::LoopCheckpoint>,
    new_input: Option<serde_json::Value>,
) {
    if let Some(checkpoint) = checkpoint {
        checkpoint.apply_to(state);
        if let Some(new_input) = new_input {
            state.messages.push(new_input);
        }
    }
}

/// Surface a terminal image rejection and return the delivered turn outcome.
pub(crate) async fn deliver_image_rejection(
    tx: &crate::StreamSink,
    outcome: local_first_engine::TurnOutcome,
    rejection: String,
) -> local_first_engine::TurnOutcome {
    let _ = crate::emit_stream_event(
        tx,
        GenerateStreamEvent::Done {
            text: rejection.clone(),
            metrics: TokenMetrics::zero(),
            redacted_user_text: None,
        },
    )
    .await;
    delivered_image_rejection_outcome(outcome, rejection)
}

/// Build the terminal outcome for an image rejection that has already been surfaced with `Done`.
/// Keeping this pure makes the stream event and outcome delivery state move together.
pub(crate) fn delivered_image_rejection_outcome(
    mut outcome: local_first_engine::TurnOutcome,
    rejection: String,
) -> local_first_engine::TurnOutcome {
    outcome.memory_answer = rejection;
    outcome.stop = local_first_engine::TurnStop::Completed;
    outcome
}
