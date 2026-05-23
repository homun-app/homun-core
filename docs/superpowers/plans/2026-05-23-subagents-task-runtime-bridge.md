# Subagents Durable Task Runtime Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let subagent workflow steps run through the shared Durable Task Runtime.

**Architecture:** Add a bridge module in `crates/subagents` that converts subagent workflow specs into durable task records and provides a `TaskExecutor` adapter around `SubagentRunner`.

**Tech Stack:** Rust 2024, serde_json, local-first-task-runtime, existing subagent runner/runtime traits.

---

### Task 1: Bridge Contracts And Workflow Enqueue

**Files:**
- Modify: `crates/subagents/Cargo.toml`
- Modify: `crates/subagents/src/lib.rs`
- Create: `crates/subagents/src/task_runtime_bridge.rs`
- Test: `crates/subagents/tests/task_runtime_bridge.rs`

- [ ] Write failing tests for workflow enqueue, dependency persistence, permission context and `llm_inference` resource declaration.
- [ ] Add dependency on `local-first-task-runtime`.
- [ ] Implement `SubagentTaskRuntimeBridge`.
- [ ] Run `cargo test -p local-first-subagents --test task_runtime_bridge`.
- [ ] Commit as `Add subagent task runtime bridge`.

### Task 2: Subagent Task Executor

**Files:**
- Modify: `crates/subagents/src/task_runtime_bridge.rs`
- Test: `crates/subagents/tests/task_runtime_bridge.rs`

- [ ] Write failing tests for successful runtime completion and retryable failure mapping.
- [ ] Implement `SubagentTaskExecutor`.
- [ ] Run `cargo test -p local-first-subagents --test task_runtime_bridge`.
- [ ] Commit as `Add subagent durable task executor`.

### Task 3: Documentation And Verification

**Files:**
- Modify: `PROJECT.md`
- Modify: `docs/work-memory.md`
- Modify: `docs/superpowers/plans/2026-05-23-subagents-task-runtime-bridge.md`

- [ ] Mark completed plan steps.
- [ ] Update work memory.
- [ ] Run `make test`.
- [ ] Commit as `Document subagent task runtime bridge`.

