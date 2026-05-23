# Skill Runtime Untrusted Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a WASM runner adapter for untrusted local skill modules.

**Architecture:** Extend `crates/skill-runtime` with `WasmSkillRunnerConfig` and `WasmSkillRunner`. The adapter uses Wasmtime with fuel enabled, rejects host imports, writes request JSON into guest memory, calls `run(ptr,len) -> packed ptr/len`, reads JSON output and relies on `SkillRuntime` for final trace/output validation.

**Tech Stack:** Rust 2024, wasmtime, wat for tests, serde_json, local-first-skill-runtime.

---

## File Structure

- Modify `crates/skill-runtime/Cargo.toml`.
- Add `crates/skill-runtime/src/wasm_runner.rs`.
- Modify `crates/skill-runtime/src/lib.rs`.
- Add `crates/skill-runtime/tests/wasm_runner.rs`.
- Update `PROJECT.md`.
- Update `docs/work-memory.md`.

### Task 1: WASM Config And Import Rejection

- [x] Write failing tests for module root validation and rejecting modules with imports.
- [x] Run `cargo test -p local-first-skill-runtime --test wasm_runner config`.
- [x] Implement `WasmSkillRunnerConfig` and import inspection.
- [x] Run targeted tests until green.
- [ ] Commit as `Add wasm skill runner config`.

### Task 2: WASM Protocol And Fuel

- [ ] Write failing tests for memory/run protocol, output limits and fuel exhaustion.
- [ ] Run `cargo test -p local-first-skill-runtime --test wasm_runner`.
- [ ] Implement `WasmSkillRunner`.
- [ ] Run targeted tests until green.
- [ ] Commit as `Add wasm skill runner`.

### Task 3: Verification And Docs

- [ ] Run `cargo test -p local-first-skill-runtime`.
- [ ] Run `cargo test --workspace`.
- [ ] Run `make test`.
- [ ] Update `PROJECT.md`, this plan and `docs/work-memory.md`.
- [ ] Run `git diff --check`.
- [ ] Commit as `Document wasm skill runner`.
