use crate::LocalTaskExecutionError;
use crate::execution_control::ExecutionAttemptControl;
use crate::execution_host::ExecutionHost;
use local_first_execution_protocol::{ExecutionOutcome, ValidatedExecutionContract};
use std::sync::Arc;

/// Restricted host boundary available to execution adapters.
///
/// The application state remains private to the host implementation so adapters
/// can only enter the capability-specific dispatch paths exposed below.
pub(crate) struct ExecutionAdapterContext {
    host: Arc<dyn ExecutionHost>,
    contract: ValidatedExecutionContract,
    control: Arc<ExecutionAttemptControl>,
}

impl ExecutionAdapterContext {
    pub(crate) fn new(
        host: Arc<dyn ExecutionHost>,
        contract: ValidatedExecutionContract,
        control: Arc<ExecutionAttemptControl>,
    ) -> Self {
        Self {
            host,
            contract,
            control,
        }
    }

    pub(crate) fn authorize_declared_effects(&self) -> Result<(), LocalTaskExecutionError> {
        self.ensure_active()?;
        self.host.authorize_declared_effects(&self.contract)
    }

    #[cfg(test)]
    pub(crate) fn contract(&self) -> &ValidatedExecutionContract {
        &self.contract
    }

    #[cfg(test)]
    pub(crate) fn is_interrupted(&self) -> bool {
        self.control.interruption().is_some()
    }

    fn ensure_active(&self) -> Result<(), LocalTaskExecutionError> {
        if let Some(interruption) = self.control.interruption() {
            return Err(LocalTaskExecutionError {
                message: format!("execution interrupted before host dispatch: {interruption:?}"),
            });
        }
        Ok(())
    }

    pub(crate) fn execute_capability_browser(
        &self,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        self.ensure_active()?;
        self.host.execute_capability_browser(&self.contract)
    }

    pub(crate) fn execute_capability(&self) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        self.ensure_active()?;
        self.host.execute_capability(&self.contract)
    }

    pub(crate) fn execute_subagent(&self) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        self.ensure_active()?;
        self.host.execute_subagent(&self.contract)
    }

    pub(crate) fn execute_proactive_prompt(
        &self,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        self.ensure_active()?;
        self.host
            .execute_proactive_prompt(&self.contract, self.control.clone())
    }

    pub(crate) fn execute_chat_turn(&self) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        self.ensure_active()?;
        self.host
            .execute_chat_turn(&self.contract, self.control.clone())
    }

    pub(crate) fn execute_shell_read_only(
        &self,
    ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
        self.ensure_active()?;
        self.host.execute_shell_read_only(&self.contract)
    }
}
