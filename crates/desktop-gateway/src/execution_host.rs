use crate::{
    AppState, LocalTaskExecutionError, TaskRecord, execute_capability_browser_task,
    execute_capability_generic, execute_proactive_prompt_task, execute_shell_read_only_task,
    execute_subagent_task,
};
use local_first_execution_protocol::{
    ExecutionFailure, ExecutionOutcome, ValidatedExecutionContract,
};

pub(crate) trait ExecutionHost: Send + Sync {
    fn authorize_declared_effects(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<(), LocalTaskExecutionError>;

    fn execute_capability_browser(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError>;

    fn execute_capability(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError>;

    fn execute_subagent(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError>;

    fn execute_proactive_prompt(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError>;

    fn execute_chat_turn(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError>;

    fn execute_shell_read_only(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError>;
}

#[derive(Clone)]
pub(crate) struct GatewayExecutionHost {
    state: AppState,
}

impl GatewayExecutionHost {
    pub(crate) fn new(state: AppState) -> Self {
        Self { state }
    }

    fn task(contract: &ValidatedExecutionContract) -> Result<TaskRecord, LocalTaskExecutionError> {
        serde_json::from_value(contract.as_ref().input.clone()).map_err(|error| {
            LocalTaskExecutionError {
                message: format!("invalid execution task input: {error}"),
            }
        })
    }
}

impl ExecutionHost for GatewayExecutionHost {
    fn authorize_declared_effects(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<(), LocalTaskExecutionError> {
        let task = Self::task(contract)?;
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
                ) && !contract.as_ref().policy.allowed_effects.contains(effect)
            })
            .collect::<Vec<_>>();
        if denied.is_empty() {
            return Ok(());
        }
        Err(LocalTaskExecutionError {
            message: format!("execution contract denies task-declared effect classes: {denied:?}"),
        })
    }

    fn execute_capability_browser(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        let task = Self::task(contract)?;
        execute_capability_browser_task(&self.state, &task, contract)
    }

    fn execute_capability(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        let task = Self::task(contract)?;
        execute_capability_generic(&self.state, &task, contract)
    }

    fn execute_subagent(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        let task = Self::task(contract)?;
        execute_subagent_task(&self.state, &task, contract)
    }

    fn execute_proactive_prompt(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        let task = Self::task(contract)?;
        execute_proactive_prompt_task(&self.state, &task, contract)
    }

    fn execute_chat_turn(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        let task = Self::task(contract)?;
        let outcome = crate::turn_executor::execute_chat_turn_task(&self.state, &task, contract)
            .unwrap_or_else(|error| ExecutionOutcome::Failed {
                failure: ExecutionFailure::permanent(
                    "chat_execution_failed",
                    crate::redact_sensitive_text(&error.message),
                ),
            });
        Ok(outcome)
    }

    fn execute_shell_read_only(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        let task = Self::task(contract)?;
        execute_shell_read_only_task(&self.state, &task)
    }
}
