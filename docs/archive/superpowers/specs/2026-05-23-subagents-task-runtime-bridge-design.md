# Subagents Durable Task Runtime Bridge Design

## Goal

Connect subagent workflows to the Durable Task Runtime so agent steps can be queued, resource-governed, leased, checkpointed and resumed through the shared task infrastructure.

## Scope

This design adds a bridge inside `crates/subagents`. It does not move subagent semantics into `crates/task-runtime`.

In scope:

- Convert `WorkflowTaskSpec` and `SubagentTask` into durable `TaskRecord` values.
- Persist workflow dependencies in `TaskStore`.
- Preserve subagent task JSON, permission envelope, budgets, agent id and contract.
- Declare `llm_inference` resource usage for subagent execution.
- Provide a `TaskExecutor` adapter that calls `SubagentRunner`.
- Map successful subagent results to completed durable tasks.
- Map failed/timed-out/cancelled subagent results to retryable durable failures.

Out of scope:

- Replacing `SubagentOrchestrator`.
- Real async worker pools.
- Browser automation.
- UI screens.
- Multi-process executor registration.

## Architecture

```text
WorkflowTaskSpec[]
  -> SubagentTaskRuntimeBridge
  -> TaskStore
     -> tasks
     -> task_dependencies

TaskRuntime
  -> SubagentTaskExecutor
  -> SubagentRunner
  -> JsonRuntime
```

The bridge lives in `crates/subagents/src/task_runtime_bridge.rs` because it understands `SubagentTask`, `AgentId`, contracts and permission envelopes. `crates/task-runtime` stays generic.

## Data Mapping

Each subagent task becomes:

- `TaskRecord.task_id`: `SubagentTask.task_id`
- `TaskRecord.workflow_id`: caller-provided durable workflow id
- `TaskRecord.kind`: `subagent.<agent_id>`
- `TaskRecord.goal`: `SubagentTask.goal`
- `TaskRecord.input_json`: full serialized `SubagentTask`
- `TaskRecord.permission_context`: serialized `PermissionEnvelope`
- `TaskRecord.resource_requirements`: `llm_inference: 1`
- `TaskRecord.retry_policy`: conservative retry policy for transient runtime failures

Workflow dependencies are stored through `TaskStore::add_dependency`.

## Executor Mapping

`SubagentTaskExecutor` reconstructs `SubagentTask` from `TaskRecord.input_json` and calls `SubagentRunner::run_generate_json`.

Result mapping:

- `SubagentStatus::Succeeded` -> `ExecutorResult::Completed`
- `SubagentStatus::Failed` -> `ExecutorResult::RetryableFailure`
- `SubagentStatus::TimedOut` -> `ExecutorResult::RetryableFailure`
- `SubagentStatus::Cancelled` -> `ExecutorResult::RetryableFailure`

The completed output is the full serialized `SubagentResult`, so downstream audit/import code can still inspect agent id, metrics and output.

## Testing

Tests should prove:

- A workflow is enqueued into `TaskStore` with dependencies.
- The durable task contains the full subagent payload and permission context.
- The task declares `llm_inference`.
- A successful fake runtime response completes through `TaskRuntime`.
- A failed fake runtime response becomes retryable durable state.

