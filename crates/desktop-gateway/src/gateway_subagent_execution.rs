//! Subagent task execution owner.
//!
//! Keeps `subagent.*` dispatch out of the gateway root while reusing the
//! canonical execution outcome mapping shared with non-browser capabilities.

use super::*;
use local_first_subagents::SubagentTaskExecutor;

/// Runs a `subagent.*` task through the real `SubagentTaskExecutor` and maps
/// its `ExecutorResult` into the canonical execution protocol.
pub(crate) fn execute_subagent_task(
    state: &AppState,
    task: &TaskRecord,
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
) -> Result<local_first_execution_protocol::ExecutionOutcome, LocalTaskExecutionError> {
    // Pick the model that best fits THIS task's goal: the semantic stage-2
    // router with heuristic fallback over the "orchestrator" role.
    let goal = task
        .input_json
        .get("goal")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let router = match resolve_role_for_task(goal, "orchestrator") {
        Some(resolved) => build_router_for_resolved(&resolved),
        None => router_for_role("orchestrator"),
    };

    let mut executor = SubagentTaskExecutor::new(router);
    let executor_id = executor.executor_id().to_string();
    let result = executor
        .execute_step(task, None)
        .map_err(|error| LocalTaskExecutionError {
            message: format!("subagent executor failed: {error}"),
        })?;

    gateway_capability_execution::task_execution_outcome_from_executor_result(
        state,
        task,
        contract,
        &executor_id,
        "subagent",
        result,
    )
}
