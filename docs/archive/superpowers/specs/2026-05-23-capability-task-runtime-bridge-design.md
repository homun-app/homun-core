# Capability Durable Task Runtime Bridge Design

## Goal

Let capability/tool calls run through the Durable Task Runtime so connectors, MCP tools, managed providers and future browser capability calls can be queued, resource-governed, leased, retried and approval-gated.

## Scope

This bridge lives inside `crates/capabilities`. `crates/task-runtime` remains generic and does not know provider semantics.

In scope:

- Convert `CapabilityCall` plus `PolicyContext` into durable `TaskRecord`.
- Preserve provider id, tool name, arguments and policy context in task JSON.
- Declare resource requirements based on provider kind:
  - native/local tools: `filesystem_io` by default.
  - MCP tools: `connector_api`.
  - managed providers: `connector_api`.
  - browser providers: `browser_session`.
  - skill providers: `background_maintenance` for now.
- Provide a `TaskExecutor` adapter around `CapabilityFacade::call_tool`.
- Map successful tool calls to `ExecutorResult::Completed`.
- Map denied/failed tool calls to `ExecutorResult::RetryableFailure` initially, so task retry policy governs transient failures.

Out of scope:

- Persistent provider registry.
- Secrets/keychain storage.
- Differentiating terminal vs retryable provider errors.
- Async worker pools.
- UI screens.

## Architecture

```text
CapabilityCall + PolicyContext
  -> CapabilityTaskRuntimeBridge
  -> TaskStore / TaskRecord

TaskRuntime
  -> CapabilityTaskExecutor
  -> CapabilityFacade.call_tool()
```

`CapabilityTaskExecutor` owns a `CapabilityFacade` value because `call_tool` mutates audit state.

## Task Payload

Each durable capability task stores:

```json
{
  "context": "...PolicyContext...",
  "call": "...CapabilityCall..."
}
```

`TaskRecord.permission_context` stores the same `PolicyContext` for UI/audit explainability.

## Testing

Tests must prove:

- A capability call is enqueued as a durable task.
- Provider/tool/policy context are preserved.
- Resource requirements are selected by provider kind.
- A successful durable execution completes and returns tool output.
- A policy denial becomes retryable task failure with the denial reason.

