# Long-Running Execution Host Design

**Date:** 2026-07-30

**Status:** Implemented and verified in the dev runtime.

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

Once this boundary is green in the live application, migrate model, browser, connector and sandbox
activities to cooperative async cancellation tokens supplied by `ExecutionHost`. That follow-up
changes scheduling latency, not lifecycle identity or effect ownership.

## Implementation result

- `ExecutionAdapterContext` retains only the validated contract and `Arc<dyn ExecutionHost>`.
- `GatewayExecutionHost` is the only adapter-host implementation that owns `AppState`.
- Capability receipt claims atomically reject elapsed task deadlines and expiry in addition to
  status, owner, lease generation, revision and fence mismatches.
- A result returned after the contract deadline is normalized to the canonical permanent deadline
  failure before journal commit; authoritative cancellation still takes precedence.
- The redundant consecutive pre-commit task reload was removed.
