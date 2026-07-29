# Execution Kernel Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make execution adapter resolution fail closed and remove unrestricted `AppState` access from the adapter trait.

**Architecture:** Keep the existing journal and adapter implementations, but place application-state access behind a sibling `ExecutionAdapterContext` module. Register every supported execution family explicitly and reject catch-all registrations.

**Tech Stack:** Rust 2024, Tokio, Cargo tests, existing execution protocol and task runtime.

---

### Task 1: Fail-closed registry

**Files:**
- Modify: `crates/desktop-gateway/src/task_registry.rs`
- Modify: `crates/desktop-gateway/src/execution_runtime.rs`

- [ ] Add a registry test proving `unknown` resolves to `None` and wildcard registration is rejected.
- [ ] Run `cargo test -p local-first-desktop-gateway task_registry::tests -- --nocapture` and verify it fails against the catch-all behavior.
- [ ] Change `register` to reject `*`, remove the production wildcard, and explicitly register `local_task`.
- [ ] Re-run the focused registry test and verify it passes.

### Task 2: Restricted adapter context

**Files:**
- Create: `crates/desktop-gateway/src/execution_adapter_context.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/execution_runtime.rs`
- Modify: `crates/desktop-gateway/src/task_registry.rs`
- Modify: `crates/desktop-gateway/tests/execution_ownership_inventory.rs`

- [ ] Add an ownership test proving the production `GatewayExecutionAdapter` trait does not contain `AppState`.
- [ ] Run `cargo test -p local-first-desktop-gateway --test execution_ownership_inventory -- --nocapture` and verify it fails.
- [ ] Add `ExecutionAdapterContext` with private state and capability-specific methods, then pass it to adapters from `spawn_blocking`.
- [ ] Update all production and test adapters to use the restricted context.
- [ ] Re-run runtime and ownership tests and verify they pass.

### Task 3: Regression and documentation

**Files:**
- Modify: `docs/TURN_CONTRACT.md`
- Modify: `docs/superpowers/specs/2026-07-29-execution-kernel-hardening-design.md`
- Modify: `docs/superpowers/plans/2026-07-29-execution-kernel-hardening.md`

- [ ] Document explicit adapter registration and the restricted dispatch boundary.
- [ ] Run scoped `rustfmt --check` on changed Rust files.
- [ ] Run `cargo test -p local-first-desktop-gateway execution_runtime -- --nocapture`.
- [ ] Run `cargo test -p local-first-desktop-gateway --test execution_ownership_inventory -- --nocapture`.
- [ ] Run `cargo test --workspace`.
- [ ] Run `RUSTFLAGS='-D warnings' cargo build --workspace`.
