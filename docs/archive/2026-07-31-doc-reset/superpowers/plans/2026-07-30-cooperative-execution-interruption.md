# Cooperative Execution Interruption Plan

**Goal:** Stop long-running agent work promptly when the canonical task is cancelled, its lease is
lost or its deadline expires, without adding another execution API or persisted lifecycle.

**Architecture:** `ExecutionRuntime` owns one volatile control for each dispatched attempt and
monitors the authoritative task record. `ExecutionAdapterContext` carries that control beside the
existing contract and host. The chat host bridges interruption into the existing turn cancellation
path, while effect claims and final journal commit remain the durable correctness boundaries.

## Task 1: Specify and test the volatile attempt control

- [x] Add priority tests for cancellation, lease loss and deadline signals.
- [x] Add a runtime test proving a cooperative adapter observes cancellation before returning.
- [x] Implement the control without stores, gateway state or persistence.

## Task 2: Monitor authoritative attempt ownership

- [x] Start one monitor only while an adapter is executing.
- [x] Signal cancellation from task status, lease loss from owner/fence drift and deadline from the
      validated contract.
- [x] Stop and await the monitor before terminal validation; never detach the adapter.

## Task 3: Connect the existing host and agent loop

- [x] Make every `ExecutionAdapterContext` host entry fail before dispatch if already interrupted.
- [x] Pass the same control through `ExecutionHost::execute_chat_turn`.
- [x] Bridge it to the registered turn cancel/abort path so model and in-flight async tools unwind.
- [x] Check it again at generic capability and browser dispatch chokepoints.

## Task 4: Verify the complete boundary

- [x] Run focused runtime, turn executor and ownership tests.
- [x] Run formatting, Clippy with denied warnings and the Rust workspace tests.
- [x] Run frontend tests, typecheck, build and dependency audits.
- [x] Restart dev and verify gateway health and projection worker state.
