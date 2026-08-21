//! Agent checkpoint request validation.
//!
//! Owns the preflight that turns an incoming chat stream checkpoint payload into
//! a validated engine checkpoint plus the "new input applies" flag. Applying a
//! checkpoint to loop state remains in `gateway_agent_turn_outcomes`; the chat
//! stream and canonical loop remain separate owners.

use super::*;

pub(crate) struct ValidatedAgentCheckpointRequest {
    pub(crate) applies_new_input: bool,
    pub(crate) recovery_checkpoint: Option<local_first_engine::LoopCheckpoint>,
}

pub(crate) fn validate_agent_checkpoint_request(
    request: &ChatGenerateStreamRequest,
) -> Result<ValidatedAgentCheckpointRequest, GatewayError> {
    let recovery_checkpoint = request
        .agent_checkpoint
        .clone()
        .map(serde_json::from_value::<local_first_engine::LoopCheckpoint>)
        .transpose()
        .map_err(|error| invalid_agent_checkpoint_error(error.to_string()))?;

    if let Some(checkpoint) = recovery_checkpoint.as_ref() {
        checkpoint
            .validate_schema()
            .map_err(|error| invalid_agent_checkpoint_error(error.to_string()))?;
    }

    Ok(ValidatedAgentCheckpointRequest {
        applies_new_input: local_first_desktop_gateway::checkpoint_request_applies_new_input(
            request.agent_checkpoint.as_ref(),
            request.checkpoint_input.as_ref(),
        ),
        recovery_checkpoint,
    })
}

fn invalid_agent_checkpoint_error(error: String) -> GatewayError {
    GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "agent_checkpoint_invalid",
        message: format!("Agent checkpoint schema is invalid: {error}"),
    }
}
