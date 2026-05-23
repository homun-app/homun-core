# Process Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready Rust Process Manager for supervising local sidecars and helper processes.

**Architecture:** Add a new `local-first-process-manager` crate with typed contracts, SQLite registry, bounded logs, health checks, fake and real supervisors, and a facade usable by the Rust Core. Keep task scheduling in Durable Task Runtime and process lifecycle here.

**Tech Stack:** Rust 2024, serde/serde_json, rusqlite bundled, reqwest blocking, time.

---

## File Structure

- Create `crates/process-manager/Cargo.toml`.
- Create `crates/process-manager/src/lib.rs`.
- Create `crates/process-manager/src/types.rs` for contracts.
- Create `crates/process-manager/src/error.rs` for typed errors.
- Create `crates/process-manager/src/log_buffer.rs` for bounded logs.
- Create `crates/process-manager/src/store.rs` for SQLite registry and snapshots.
- Create `crates/process-manager/src/health.rs` for health checks.
- Create `crates/process-manager/src/supervisor.rs` for fake and local process supervisors.
- Create `crates/process-manager/src/manager.rs` for lifecycle facade.
- Add crate to root `Cargo.toml`.
- Add tests in `crates/process-manager/tests`.
- Update `PROJECT.md` and `docs/work-memory.md`.

---

### Task 1: Contracts And SQLite Registry

- [x] Write failing tests for process spec/status serialization and SQLite spec/snapshot round trip.
- [x] Run `cargo test -p local-first-process-manager --test contracts --test store` and verify crate missing/failing.
- [x] Implement crate skeleton, contracts, errors and SQLite store.
- [x] Run targeted tests until green.
- [x] Commit as `Add process manager contracts`.

### Task 2: Logs, Health And Fake Supervisor

- [ ] Write failing tests for bounded log buffer, injected health probe, and fake supervisor lifecycle through `ProcessManager`.
- [ ] Run targeted tests and verify failures.
- [ ] Implement log buffer, health evaluator, supervisor trait, fake supervisor and manager facade.
- [ ] Run targeted tests until green.
- [ ] Commit as `Add process manager facade`.

### Task 3: Local Process Supervisor

- [ ] Write failing integration test that spawns a real short-lived local process, captures output, observes exit and exposes snapshots.
- [ ] Run targeted test and verify failure.
- [ ] Implement local process supervisor with stdout/stderr capture, idempotent start, stop/kill and status polling.
- [ ] Run targeted test until green.
- [ ] Commit as `Add local process supervisor`.

### Task 4: Verification And Docs

- [ ] Run `cargo test -p local-first-process-manager`.
- [ ] Run `cargo test --workspace`.
- [ ] Run `make test`.
- [ ] Update `PROJECT.md`, this plan and `docs/work-memory.md`.
- [ ] Run `git diff --check`.
- [ ] Commit as `Document process manager runtime`.
