# Skill Runtime Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hardened process runner adapter for trusted local skill handlers.

**Architecture:** Extend `crates/skill-runtime` with `ProcessSkillRunnerConfig` and `ProcessSkillRunner`. The adapter launches an executable without a shell, validates executable/cwd roots, clears inherited env, sends request JSON on stdin, reads output JSON from stdout, enforces timeout and defers final trace/output validation to `SkillRuntime`.

**Tech Stack:** Rust 2024, std::process, serde_json, tempfile for tests, local-first-skill-runtime.

---

## File Structure

- Add `crates/skill-runtime/src/process_runner.rs`.
- Modify `crates/skill-runtime/src/lib.rs`.
- Add `crates/skill-runtime/tests/process_runner.rs`.
- Update `PROJECT.md`.
- Update `docs/work-memory.md`.

### Task 1: Process Runner Config Guardrails

- [x] Write failing tests for executable root and working-directory root validation.
- [x] Run `cargo test -p local-first-skill-runtime --test process_runner config`.
- [x] Implement `ProcessSkillRunnerConfig`.
- [x] Run targeted tests until green.
- [ ] Commit as `Add process skill runner config`.

### Task 2: Process Runner Protocol

- [ ] Write failing tests for stdin/stdout JSON protocol, env clearing, timeout and bad output.
- [ ] Run `cargo test -p local-first-skill-runtime --test process_runner`.
- [ ] Implement `ProcessSkillRunner`.
- [ ] Run targeted tests until green.
- [ ] Commit as `Add process skill runner`.

### Task 3: Verification And Docs

- [ ] Run `cargo test -p local-first-skill-runtime`.
- [ ] Run `cargo test --workspace`.
- [ ] Run `make test`.
- [ ] Update `PROJECT.md`, this plan and `docs/work-memory.md`.
- [ ] Run `git diff --check`.
- [ ] Commit as `Document skill runtime adapters`.
