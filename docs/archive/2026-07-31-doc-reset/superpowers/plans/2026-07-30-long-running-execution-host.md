# Long-Running Execution Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the ambient-state and late-deadline gaps in the single durable execution contract.

**Architecture:** Move `AppState` behind a gateway-owned `ExecutionHost`, leaving adapters with one restricted context and the existing canonical outcome. Enforce deadline/expiry in the same transaction as an effect claim and normalize late adapter returns before journal commit.

**Tech Stack:** Rust, Tokio, rusqlite, the existing execution journal, effect receipts and gateway contract tests.

---

### Task 1: Prove the adapter context is state-free

**Files:**
- Modify: `crates/desktop-gateway/tests/execution_ownership_inventory.rs`
- Create: `crates/desktop-gateway/src/execution_host.rs`
- Modify: `crates/desktop-gateway/src/execution_adapter_context.rs`
- Modify: `crates/desktop-gateway/src/execution_runtime.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [x] Add an inventory assertion that production `execution_adapter_context.rs` contains no `AppState`.
- [x] Run `cargo test -p local-first-desktop-gateway --test execution_ownership_inventory` and observe the new assertion fail.
- [x] Add `ExecutionHost` and `GatewayExecutionHost`, then make the context retain only `Arc<dyn ExecutionHost>` and the validated contract.
- [x] Move test-only direct state access into the test adapters that require it.
- [x] Re-run the inventory and execution-runtime tests until green.

### Task 2: Reject late effect claims atomically

**Files:**
- Modify: `crates/task-runtime/tests/effect_receipts.rs`
- Modify: `crates/task-runtime/src/store.rs`

- [x] Add tests for a running, correctly fenced task whose deadline or expiry is already due.
- [x] Run the focused tests and observe that the current store incorrectly returns `Execute`.
- [x] Extend the transactional `lease_current` predicate with deadline and expiry checks.
- [x] Re-run the focused effect receipt suite until green.

### Task 3: Reject a late adapter success

**Files:**
- Modify: `crates/desktop-gateway/src/execution_runtime.rs`

- [x] Add a runtime test whose adapter advances beyond the contract deadline and returns success.
- [x] Run the focused test and observe a committed `Completed` outcome.
- [x] Apply post-dispatch precedence: authoritative cancellation, elapsed deadline, adapter outcome.
- [x] Re-run execution-runtime tests until green.

### Task 4: Document and verify the complete increment

**Files:**
- Modify: `docs/TURN_CONTRACT.md`
- Modify: `docs/architecture/agent-loop.md`

- [x] Document the state-free host and the no-new-effect interruption guarantee.
- [x] Run `cargo fmt --all -- --check` and `cargo clippy --workspace --all-targets --locked -- -D warnings`.
- [x] Run `cargo test --workspace --locked`.
- [x] Run desktop UI contract, Electron tests, typecheck, build and `npm audit`.
- [x] Restart the dev supervisor and verify ports `1420` and `18765` plus a clean projection health response.
- [x] Review dead code exposed by the migration and remove only code proven unreachable.
