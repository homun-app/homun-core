pub(crate) fn wake_for_agent_stop(
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
    stop: &local_first_engine::TurnStop,
    action: Option<&str>,
) -> Option<local_first_execution_protocol::WakeCondition> {
    match stop {
        local_first_engine::TurnStop::SuspendedUser => {
            Some(local_first_execution_protocol::WakeCondition::User {
                wait_ref: format!(
                    "{}:{}:user",
                    contract.as_ref().execution_id,
                    contract.as_ref().revision
                ),
            })
        }
        local_first_engine::TurnStop::SuspendedApproval => {
            Some(local_first_execution_protocol::WakeCondition::Approval {
                approval_ref: format!(
                    "{}:{}:approval:{}",
                    contract.as_ref().execution_id,
                    contract.as_ref().revision,
                    action.unwrap_or("action_card")
                ),
            })
        }
        local_first_engine::TurnStop::SuspendedEffect { receipt_ref } => Some(
            local_first_execution_protocol::WakeCondition::EffectResolution {
                receipt_ref: receipt_ref.clone(),
            },
        ),
        local_first_engine::TurnStop::SuspendedModel { role } => Some(
            local_first_execution_protocol::WakeCondition::ModelAvailable { role: role.clone() },
        ),
        local_first_engine::TurnStop::Completed | local_first_engine::TurnStop::Failed { .. } => {
            None
        }
    }
}
