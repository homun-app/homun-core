# Gateway Crash Recovery E2E Design

**Date:** 2026-07-30

**Status:** Implemented and verified

## Purpose

Prove that a real gateway process can crash while it owns a browser-capable chat turn and that a
new process converges the same durable execution without creating another lifecycle contract.

The test remains bounded to the canonical path:

```text
ExecutionContract -> leased attempt -> ExecutionOutcome -> projection
```

Browser checkpoints, agent runs, visible messages and resource reservations are supporting durable
state. They do not become alternative execution owners.

## Scenario

1. Start the real gateway binary with an isolated data directory and the background executor off.
2. Create a thread and enqueue a turn through the public HTTP broker API.
3. Use `TaskStore` to put that same turn in the exact persisted state of an active browser-capable
   attempt: current process generation, lease and fence, resource reservation, running agent run,
   resumable agent checkpoint, active objective and browser checkpoint.
4. Persist the already-owned assistant placeholder as `streaming`.
5. Kill the gateway process without graceful shutdown.
6. Start the same binary on the same data directory with execution still disabled.
7. Verify recovery through the HTTP API and the durable stores.

## Required invariants

- The process generation advances exactly once on restart.
- The stale running task becomes `queued` and retains its original turn id.
- Lease owner, heartbeat, expiry and fencing token are cleared.
- Browser and other resource reservations owned by the dead attempt are released.
- Exactly one `aborted` turn event identifies boot recovery; no terminal event is fabricated.
- The old agent run is `aborted` with `gateway_restart` and its checkpoint remains readable.
- The active browser checkpoint survives unchanged and stays scoped to the same objective revision.
- The existing assistant message is reused and changes from `streaming` to `retrying`; no duplicate
  assistant row is created.
- A repeated restart does not emit another recovery event for the already queued turn.

## Boundary of this proof

This E2E proves process-level crash convergence before the recovered attempt is dispatched again.
It does not claim that an unknown remote browser mutation succeeded, and it never replays one. Live
CDP target adoption and external acknowledgement reconciliation remain separate provider smokes.

## Result

The production lifecycle satisfied every invariant without a runtime patch. The stale behavior was
in the older Python broker harness: its atomicity check covered only the user message, a second
interactive message still expected the retired `409 thread_busy` response instead of durable
steering, and every run competed for a fixed port. The harness now verifies both canonical message
rows, exercises `202 steering_queued`, rejects duplicate assistant ownership and uses an isolated
loopback port.

## Rejected alternatives

1. A test-only provider or execution adapter. It would create behavior absent from production and
   weaken the single-contract requirement.
2. Editing SQLite with an invented task shape. The test uses the broker and `TaskStore` types so
   migrations and serialization remain production-owned.
3. Replaying a browser action after restart. A crash can leave its remote outcome unknown; the
   effect receipt and explicit reconciliation must remain authoritative.
