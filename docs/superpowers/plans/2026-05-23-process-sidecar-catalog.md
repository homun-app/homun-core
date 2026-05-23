# Process Sidecar Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the Process Manager to concrete local sidecar configurations for Gemma/MLX, browser automation and MCP stdio servers.

**Architecture:** Keep `ProcessManager` generic. Add a `SidecarProcessCatalog` that builds `ProcessSpec` values for known local components and can register them into `ProcessRegistryStore`; execution remains explicit through `ProcessManager`.

**Tech Stack:** Rust 2024, local-first-process-manager, rusqlite, serde.

---

## File Structure

- Modify `crates/process-manager/src/lib.rs`: export sidecar catalog types.
- Create `crates/process-manager/src/sidecars.rs`: concrete spec builders for Gemma, browser and MCP stdio.
- Add `crates/process-manager/tests/sidecars.rs`: verify stable specs and registry registration.
- Update `PROJECT.md` and `docs/work-memory.md`.

---

### Task 1: Sidecar Process Catalog

- [x] Write failing tests for Gemma, browser and MCP process specs.
- [x] Run `cargo test -p local-first-process-manager --test sidecars` and verify failures.
- [x] Implement `SidecarProcessCatalog`, `McpProcessConfig` and registration helper.
- [x] Run targeted tests until green.
- [x] Commit as `Add sidecar process catalog`.

### Task 2: Verification And Docs

- [ ] Run `cargo test -p local-first-process-manager`.
- [ ] Run `cargo test --workspace`.
- [ ] Run `make test`.
- [ ] Update `PROJECT.md`, this plan and `docs/work-memory.md`.
- [ ] Run `git diff --check`.
- [ ] Commit as `Document sidecar process catalog`.
