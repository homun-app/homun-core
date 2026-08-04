# Execution Kernel Hardening Design

**Date:** 2026-07-29

**Status:** Approved by the preceding code audit and implementation request.

## Purpose

Close the remaining gap between Homun's durable lifecycle contract and the code that dispatches adapters. An execution kind must resolve explicitly, and an adapter must not receive the unrestricted application state as part of its public execution contract.

## Scope

This increment changes only the adapter boundary and registry resolution. It does not replace the task broker, journal, Vault, sandbox, browser runtime, connectors, HITL protocol, or read-model projector.

## Invariants

1. Every production execution kind maps to an explicit exact or prefix registration.
2. Unknown execution kinds fail before adapter code runs.
3. The obsolete legacy local adapter and its arithmetic fallback are removed because no production producer emits that task kind.
4. `GatewayExecutionAdapter` receives an `ExecutionAdapterContext`, not `AppState`.
5. The context exposes capability-specific dispatch methods and keeps the underlying `AppState` private outside its module.
6. Existing domain gates remain authoritative and may be stricter than the execution contract.
7. Adapter errors still become canonical `ExecutionOutcome::Failed` values and remain journal-owned.

## Components

### Task executor registry

The registry retains exact and trailing-prefix matching. Catch-all `*` registrations are rejected. This makes a missing adapter a typed runtime failure instead of silently selecting legacy local execution.

### Execution adapter context

A new sibling module owns `ExecutionAdapterContext`. Its private state reference can be used only by methods corresponding to registered adapter families: browser capability, generic capability, subagent, proactive prompt, chat turn, shell read-only, and local read-only.

The adapter trait can select one of these host operations but cannot read stores or network clients directly. Later receipt and outbox work can therefore be added in this one module without changing the stable adapter trait again.

There is no generic local fallback. The existing read-only shell operation remains an explicit `local_shell_task` registration.

## Error handling

Unknown kinds commit a permanent canonical failure with code `unsupported_execution_kind` before any adapter dispatch. Invalid wildcard registration fails immediately during registry construction and tests. Existing adapter failures retain their current redacted transient outcome behavior.

## Verification

- Registry tests prove exact and prefix ordering without a fallback.
- Runtime tests prove an unsupported kind never invokes an adapter and records no fabricated local success.
- Ownership inventory proves the production adapter trait contains no `AppState` parameter.
- Existing execution-runtime, task-runtime, workspace build, and warning gates remain green.

## Follow-up boundary

This increment creates the enforcement point. The next increments move effect authorization and receipt dispatch into the context, add journal-owned attempts, and separate local projection from external delivery.

## Implementation result

- Production registry resolution is explicit and wildcard registration is forbidden.
- Unknown kinds terminalize through the journal as permanent typed failures.
- `GatewayExecutionAdapter` receives only `ExecutionAdapterContext`.
- Capability/subagent `allowed_actions` are normalized into canonical effect classes, and the context rejects task-declared effects absent from the authoritative contract.
- `approved_automation` becomes preauthorized only at autonomy level 4 with no required approval.
- The legacy local adapter, arithmetic fallback, and their tests were removed as dead code.
