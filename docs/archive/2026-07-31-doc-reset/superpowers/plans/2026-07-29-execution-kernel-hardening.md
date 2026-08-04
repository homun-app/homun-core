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

- [x] Add a registry test proving `unknown` resolves to `None` and wildcard registration is rejected.
- [x] Run `cargo test -p local-first-desktop-gateway task_registry::tests -- --nocapture` and verify it fails against the catch-all behavior.
- [x] Change `register` to reject `*`, remove the production wildcard and the dead local fallback, and retain only explicit production kinds.
- [x] Re-run the focused registry test and verify it passes.
- [x] Add a runtime test proving an unsupported kind commits `Failed(permanent, unsupported_execution_kind)` and implement the canonical failure path.

### Task 2: Restricted adapter context

**Files:**
- Create: `crates/desktop-gateway/src/execution_adapter_context.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/execution_runtime.rs`
- Modify: `crates/desktop-gateway/src/task_registry.rs`
- Modify: `crates/desktop-gateway/tests/execution_ownership_inventory.rs`

- [x] Add an ownership test proving the production `GatewayExecutionAdapter` trait does not contain `AppState`.
- [x] Run `cargo test -p local-first-desktop-gateway --test execution_ownership_inventory -- --nocapture` and verify it fails.
- [x] Add `ExecutionAdapterContext` with private state and capability-specific methods, then pass it to adapters from `spawn_blocking`.
- [x] Update all production and test adapters to use the restricted context.
- [x] Re-run runtime and ownership tests and verify they pass.
- [x] Add failing tests for the real capability/subagent `allowed_actions` format and normalize it into `ExecutionPolicy`.
- [x] Add a failing test proving a task cannot widen authoritative contract effects, then deny before adapter dispatch.
- [x] Require autonomy level 4 and no requested approval before projecting `approved_automation` as preauthorized.

### Task 3: Regression and documentation

**Files:**
- Modify: `docs/TURN_CONTRACT.md`
- Modify: `docs/superpowers/specs/2026-07-29-execution-kernel-hardening-design.md`
- Modify: `docs/superpowers/plans/2026-07-29-execution-kernel-hardening.md`

- [x] Document explicit adapter registration and the restricted dispatch boundary.
- [ ] Run scoped `rustfmt --check` on changed Rust files.
- [ ] Run `cargo test -p local-first-desktop-gateway execution_runtime -- --nocapture`.
- [ ] Run `cargo test -p local-first-desktop-gateway --test execution_ownership_inventory -- --nocapture`.
- [ ] Run `cargo test --workspace`.
- [ ] Run `RUSTFLAGS='-D warnings' cargo build --workspace`.
