use crate::{
    AppState, LocalTaskExecutionError, TaskRecord, execute_capability_browser_task,
    execute_capability_generic, execute_proactive_prompt_task, execute_shell_read_only_task,
    execute_subagent_task,
};
use local_first_execution_protocol::{
    ExecutionFailure, ExecutionOutcome, ValidatedExecutionContract,
};

/// Restricted host boundary available to execution adapters.
///
/// The application state remains private to this module so adapter implementations
/// can only enter the capability-specific dispatch paths exposed below.
pub(crate) struct ExecutionAdapterContext {
    state: AppState,
    contract: ValidatedExecutionContract,
}

impl ExecutionAdapterContext {
    pub(crate) fn new(state: AppState, contract: ValidatedExecutionContract) -> Self {
        Self { state, contract }
    }

    pub(crate) fn authorize_declared_effects(&self) -> Result<(), LocalTaskExecutionError> {
        let task = self.task()?;
        let declared_policy = crate::execution_runtime::execution_policy_for_task(&task);
        let denied = declared_policy
            .allowed_effects
            .iter()
            .filter(|effect| {
                matches!(
                    effect,
                    local_first_execution_protocol::EffectClass::FilesystemWrite
                        | local_first_execution_protocol::EffectClass::ArtifactCreation
                        | local_first_execution_protocol::EffectClass::ExternalWrite
                ) && !self
                    .contract
                    .as_ref()
                    .policy
                    .allowed_effects
                    .contains(effect)
            })
            .collect::<Vec<_>>();
        if denied.is_empty() {
            return Ok(());
        }
        Err(LocalTaskExecutionError {
            message: format!("execution contract denies task-declared effect classes: {denied:?}"),
        })
    }

    #[cfg(test)]
    pub(crate) fn contract(&self) -> &ValidatedExecutionContract {
        &self.contract
    }

    pub(crate) fn execute_capability_browser(
        &self,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        let task = self.task()?;
        execute_capability_browser_task(&self.state, &task, &self.contract)
    }

    pub(crate) fn execute_capability(&self) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        let task = self.task()?;
        execute_capability_generic(&self.state, &task, &self.contract)
    }

    pub(crate) fn execute_subagent(&self) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        let task = self.task()?;
        execute_subagent_task(&self.state, &task, &self.contract)
    }

    pub(crate) fn execute_proactive_prompt(
        &self,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        let task = self.task()?;
        execute_proactive_prompt_task(&self.state, &task, &self.contract)
    }

    pub(crate) fn execute_chat_turn(&self) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        let task = self.task()?;
        let outcome =
            crate::turn_executor::execute_chat_turn_task(&self.state, &task, &self.contract)
                .unwrap_or_else(|error| ExecutionOutcome::Failed {
                    failure: ExecutionFailure::permanent(
                        "chat_execution_failed",
                        crate::redact_sensitive_text(&error.message),
                    ),
                });
        Ok(outcome)
    }

    pub(crate) fn execute_shell_read_only(
        &self,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        let task = self.task()?;
        execute_shell_read_only_task(&self.state, &task)
    }

    fn task(&self) -> Result<TaskRecord, LocalTaskExecutionError> {
        serde_json::from_value(self.contract.as_ref().input.clone()).map_err(|error| {
            LocalTaskExecutionError {
                message: format!("invalid execution task input: {error}"),
            }
        })
    }

    #[cfg(test)]
    pub(crate) fn test_state(&self) -> &AppState {
        &self.state
    }
}
