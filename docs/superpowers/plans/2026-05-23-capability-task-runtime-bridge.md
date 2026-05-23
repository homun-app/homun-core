# Capability Durable Task Runtime Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute capability tool calls through the shared Durable Task Runtime.

**Architecture:** Add a bridge module in `crates/capabilities` that converts tool calls into durable tasks and provides a `TaskExecutor` adapter around `CapabilityFacade`.

**Tech Stack:** Rust 2024, serde_json, local-first-task-runtime, existing capability facade/provider contracts.

---

### Task 1: Capability Task Bridge

**Files:**
- Modify: `crates/capabilities/Cargo.toml`
- Modify: `crates/capabilities/src/lib.rs`
- Create: `crates/capabilities/src/task_runtime_bridge.rs`
- Test: `crates/capabilities/tests/task_runtime_bridge.rs`

- [ ] Write failing tests for enqueueing a `CapabilityCall`, preserving policy/call payload and assigning resource requirements by provider kind.
- [ ] Add dependency on `local-first-task-runtime`.
- [ ] Implement `CapabilityTaskRuntimeBridge`.
- [ ] Run `cargo test -p local-first-capabilities --test task_runtime_bridge`.
- [ ] Commit as `Add capability task runtime bridge`.

### Task 2: Capability Task Executor

**Files:**
- Modify: `crates/capabilities/src/task_runtime_bridge.rs`
- Test: `crates/capabilities/tests/task_runtime_bridge.rs`

- [ ] Write failing tests for successful durable execution and policy denial mapping.
- [ ] Implement `CapabilityTaskExecutor`.
- [ ] Run `cargo test -p local-first-capabilities --test task_runtime_bridge`.
- [ ] Commit as `Add capability durable task executor`.

### Task 3: Documentation And Verification

**Files:**
- Modify: `PROJECT.md`
- Modify: `docs/work-memory.md`
- Modify: `docs/superpowers/plans/2026-05-23-capability-task-runtime-bridge.md`

- [ ] Mark completed plan steps.
- [ ] Update work memory.
- [ ] Run `make test`.
- [ ] Commit as `Document capability task runtime bridge`.

