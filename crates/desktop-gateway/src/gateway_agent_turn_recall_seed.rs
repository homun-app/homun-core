//! Agent turn recall seed owner.
//!
//! Owns the pre-loop consumption of automatic recall evidence: it seeds
//! `LoopState::memory_reads` and publishes the matching recall stream event
//! before the model loop starts. It does not own recall retrieval, recall-tool
//! execution, memory learning, browser execution or subagents.

use super::*;

pub(crate) async fn seed_agent_turn_recall(
    loop_state: &mut local_first_engine::LoopState,
    tx: &StreamSink,
    applies_new_input: bool,
    payload: Option<local_first_subagents::RecallStreamPayload>,
) {
    if applies_new_input {
        seed_loop_memory_reads(loop_state, payload.as_ref());
    }
    if applies_new_input && let Some(payload) = payload {
        let _ = emit_stream_event(tx, GenerateStreamEvent::Recall { payload }).await;
    }
}
