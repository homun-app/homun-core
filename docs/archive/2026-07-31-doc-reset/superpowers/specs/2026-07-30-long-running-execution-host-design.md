# Long-Running Execution Host Design

**Date:** 2026-07-30

**Status:** Increments 1 and 2 implemented and verified in the dev runtime.

## Purpose

Make the existing execution kernel safe at long-running interruption boundaries without creating
a second adapter API. The canonical input remains `ExecutionContract` and the canonical result
remains `ExecutionOutcome`.

## Current gap

`GatewayExecutionAdapter` receives a restricted context, but that context still owns the complete
`AppState` and dispatches directly into gateway internals. Adapter execution is blocking. The
runtime checks deadline before dispatch and lease ownership after dispatch, while the effect host
already fences mutations with task status, lease generation, execution revision and fencing token.

This leaves two gaps:

1. the adapter boundary is syntactically restricted but still coupled to ambient application state;
2. a deadline that expires during a long adapter can reject a later commit, but the effect-claim
   transaction does not yet reject a mutation solely because that deadline has elapsed.

## Decision

Introduce an `ExecutionHost` trait as the only gateway implementation allowed to own `AppState`.
`ExecutionAdapterContext` contains only a validated contract and an `Arc<dyn ExecutionHost>`.
Adapters keep the same single `execute(context) -> ExecutionOutcome` contract and call explicit
host operations through the context.

Long-running interruption uses a fail-closed boundary:

- task cancellation prevents subsequent effect claims and the runtime commits `Cancelled(User)`;
- lease loss prevents subsequent effect claims and rejects the stale outcome commit;
- an elapsed deadline prevents subsequent effect claims and replaces a late adapter result with
  `Failed(permanent, execution_deadline_exceeded)`;
- a consequential operation already in flight at the interruption boundary is never fabricated as
  cancelled or retried. Its receipt remains the authority and may become `Uncertain`.

This increment deliberately does not detach or forcibly kill blocking adapter threads. Hard-killing
one could allow an untracked remote mutation after the runtime reported cancellation. Cooperative
async interruption can be added adapter-by-adapter after all dispatch points consume this host.

## Components

### Execution host

`execution_host.rs` owns `GatewayExecutionHost` and the private `AppState`. Its trait exposes only
the registered adapter families: browser capability, generic capability, subagent, proactive
prompt, chat turn and read-only shell.

### Adapter context

`execution_adapter_context.rs` becomes a data-free facade over the host and validated contract. It
may expose contract metadata, but cannot return stores, clients, Vault state, connector state or
`AppState`.

### Effect boundary

The atomic capability receipt claim additionally verifies that neither task deadline nor expiry is
due. The check occurs in the same immediate SQLite transaction that verifies status, owner, lease,
revision and fence, so no adapter can race a stale pre-check into a mutation claim.

### Runtime terminal boundary

After adapter return and before outcome validation/commit, the runtime checks the authoritative
deadline again. Cancellation has precedence, then deadline, then the adapter outcome. Lease loss
continues to reject the attempt instead of manufacturing an outcome for a worker that no longer
owns it.

## Rejected alternatives

1. **Convert only the adapter trait to async.** Rejected because synchronous executors would still
   block or continue after future cancellation, producing a false interruption guarantee.
2. **Abort `spawn_blocking` on deadline.** Rejected because dropping the join handle does not stop
   the underlying operation and can orphan an external side effect.
3. **Add another long-running adapter interface.** Rejected because Homun requires one extensible
   execution contract, not parallel lifecycle APIs.

## Verification

- ownership inventory proves `ExecutionAdapterContext` contains no `AppState`;
- runtime tests prove a result returned after the deadline cannot commit as success;
- effect receipt tests prove no capability mutation can be claimed after deadline or expiry;
- existing unknown-kind, lease stealing, cancellation, receipt, projection, browser, HITL and Vault
  tests remain green;
- workspace formatting, Clippy with denied warnings, frontend tests/build and audits remain green.

## Follow-up

The second increment adds one in-memory attempt control supplied through the existing
`ExecutionAdapterContext`. It is not a persisted contract and it owns no lifecycle state. The
runtime remains the only component that reads authoritative task cancellation, lease generation
and deadline, then signals the control while an adapter is running.

For chat execution, the host bridges that signal into the existing per-turn cancellation path.
This drops the in-flight model/browser/connector/sandbox future, aborts the registered stream task
and lets command subprocesses terminate through their existing `kill_on_drop` configuration.
Capability dispatch also checks the same control before entering a tool, closing the race between
an engine round and a newly observed interruption.

`proactive_prompt` uses the same control directly in a `select` against its agent-turn future. Its
stream request id is derived from the already durable assistant message id, so cancellation can
abort the exact generation without creating another live-turn registry.

The runtime still waits for the adapter thread to unwind. It never detaches effect-capable work.
The durable terminal precedence remains cancellation, lease ownership, deadline, adapter result;
the control only improves stop latency. If a remote effect has already crossed its dispatch
boundary, its receipt remains Completed or Uncertain and is never rewritten as cancelled.

Rejected for increment 2:

1. Persisting a cancellation-token state machine, because task and execution journal already own
   that state.
2. Passing `AppState` or task-store handles into adapters, because it would reopen the ownership
   boundary closed by increment 1.
3. Returning immediately when the monitor fires, because `spawn_blocking` would continue detached
   and could perform an untracked side effect.

## Implementation result

- `ExecutionAdapterContext` retains only the validated contract and `Arc<dyn ExecutionHost>`.
- `GatewayExecutionHost` is the only adapter-host implementation that owns `AppState`.
- Capability receipt claims atomically reject elapsed task deadlines and expiry in addition to
  status, owner, lease generation, revision and fence mismatches.
- A result returned after the contract deadline is normalized to the canonical permanent deadline
  failure before journal commit; authoritative cancellation still takes precedence.
- The redundant consecutive pre-commit task reload was removed.
- `ExecutionRuntime` now monitors cancellation, lease generation and deadline while the adapter is
  running, then signals one volatile `ExecutionAttemptControl`.
- Interactive and proactive agent turns consume that signal without adding a persisted lifecycle;
  capability/browser dispatch retain their final pre-effect cancellation checks.
- Effect leases now terminalize abandoned dispatches on drop. A cancelled connector, browser or
  capability future cannot leave a claimed write in `Started`; it becomes `Uncertain` immediately
  and the same logical call can only resolve it, never execute it again.
- Project shell commands run in a dedicated Unix process group. Cancellation and timeout terminate
  the complete command tree for both sandboxed and explicitly approved unsandboxed execution.

## Deterministic recovery matrix

The local suites exercise the production contracts with controlled adapters and transports:

| Boundary | Deterministic evidence |
| --- | --- |
| model cancellation | live-turn notify aborts the attached engine task; durable task cancellation stops the runtime adapter |
| browser/capability cancellation | dispatch checks the turn signal; sidecar teardown is bounded by its transport timeout; claimed writes become `Uncertain` and no later action is dispatched |
| sandbox cancellation | aborting the command kills its process-group descendant, not only the shell wrapper |
| connector interruption | abandoned `EffectLease` becomes `Uncertain` before any recovery claim and cannot execute again |
| active deadline | monitor signals the attempt and a late success is replaced by `execution_deadline_exceeded` |
| lease loss/restart | stale commit is rejected; a newer fence reclaims the running attempt; a committed outcome is recovered without re-running the adapter |
| projection restart | pending/claimed outbox work and uncertain receipt resolution converge without duplicate acknowledgement |
| proactive execution | the same `ExecutionAttemptControl` races the proactive agent future and aborts its exact stream request |

These tests do not fabricate a real remote provider acknowledgement. Installed-app smoke remains the
separate proof for provider transport, real browser/CDP state and connector delivery reconciliation.
