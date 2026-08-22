//! Agent turn recovery checkpoint seed owner.
//!
//! Owns the pre-loop consumption of a validated durable checkpoint into
//! `LoopState`. Checkpoint validation and the pure checkpoint application helper
//! stay in their existing owners.

use super::*;

pub(crate) fn seed_agent_turn_recovery_checkpoint(
    loop_state: &mut local_first_engine::LoopState,
    recovery_checkpoint: Option<local_first_engine::LoopCheckpoint>,
    checkpoint_input_present: bool,
) {
    let checkpoint_input = if checkpoint_input_present {
        loop_state.messages.last().cloned()
    } else {
        None
    };
    gateway_agent_turn_outcomes::apply_agent_recovery_checkpoint(
        loop_state,
        recovery_checkpoint,
        checkpoint_input,
    );
}
