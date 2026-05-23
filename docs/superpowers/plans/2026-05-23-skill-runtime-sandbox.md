# Skill Runtime Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local skill runtime sandbox boundary that can execute skill tools through validated, permission-aware runners.

**Architecture:** Create `crates/skill-runtime` with contracts, sandbox policy, a runner trait, an in-memory runner, an executable capability provider and integration tests through the existing Durable Task Runtime bridge. The runtime denies undeclared filesystem/network access and keeps arbitrary external execution out of scope until adapter confinement is proven.

**Tech Stack:** Rust 2024, serde, serde_json, time, url, local-first-capabilities, local-first-task-runtime.

---

## File Structure

- Modify root `Cargo.toml` to add `crates/skill-runtime`.
- Add `crates/skill-runtime/Cargo.toml`.
- Add `crates/skill-runtime/src/lib.rs`.
- Add `crates/skill-runtime/src/error.rs`.
- Add `crates/skill-runtime/src/types.rs`.
- Add `crates/skill-runtime/src/policy.rs`.
- Add `crates/skill-runtime/src/runner.rs`.
- Add `crates/skill-runtime/src/provider.rs`.
- Add `crates/skill-runtime/tests/contracts.rs`.
- Add `crates/skill-runtime/tests/policy.rs`.
- Add `crates/skill-runtime/tests/provider.rs`.
- Add `crates/skill-runtime/tests/task_runtime_bridge.rs`.
- Update `PROJECT.md`.
- Update `docs/work-memory.md`.

### Task 1: Contracts And Sandbox Policy

- [x] Write failing tests for runtime request/output contracts and sandbox denial of undeclared network/filesystem access.
- [x] Run `cargo test -p local-first-skill-runtime --test contracts --test policy` and verify failures.
- [x] Implement crate skeleton, error types, contracts and `SkillSandboxPolicy`.
- [x] Run targeted tests until green.
- [x] Commit as `Add skill runtime contracts`.

### Task 2: Runner And Executable Provider

- [x] Write failing tests for `InMemorySkillRunner`, post-run trace validation and `SkillRuntimeCapabilityProvider`.
- [x] Run `cargo test -p local-first-skill-runtime --test provider` and verify failures.
- [x] Implement `SkillRunner`, `InMemorySkillRunner`, `SkillRuntime` and `SkillRuntimeCapabilityProvider`.
- [x] Run targeted tests until green.
- [ ] Commit as `Add skill runtime provider`.

### Task 3: Durable Task Runtime Integration

- [ ] Write failing integration test that enqueues a skill tool through `CapabilityTaskRuntimeBridge` and completes it via `CapabilityTaskExecutor`.
- [ ] Run `cargo test -p local-first-skill-runtime --test task_runtime_bridge` and verify failure.
- [ ] Add any missing bridge helpers needed for the skill runtime provider.
- [ ] Run targeted test until green.
- [ ] Commit as `Integrate skill runtime with task runtime`.

### Task 4: Verification And Docs

- [ ] Run `cargo test -p local-first-skill-runtime`.
- [ ] Run `cargo test --workspace`.
- [ ] Run `make test`.
- [ ] Update `PROJECT.md`, this plan and `docs/work-memory.md`.
- [ ] Run `git diff --check`.
- [ ] Commit as `Document skill runtime sandbox`.
