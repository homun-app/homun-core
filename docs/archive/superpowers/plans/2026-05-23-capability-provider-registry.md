# Capability Provider Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent provider configuration and user/workspace grants for the Capability Layer.

**Architecture:** Implement `registry.rs` inside `crates/capabilities`, backed by SQLite. The registry derives `PolicyContext` for existing `CapabilityFacade` calls and stores metadata needed by durable task execution.

**Tech Stack:** Rust 2024, rusqlite bundled, serde, serde_json, local-first-task-runtime resource classes.

---

### Task 1: Registry Contracts And Store

**Files:**
- Modify: `crates/capabilities/Cargo.toml`
- Modify: `crates/capabilities/src/lib.rs`
- Create: `crates/capabilities/src/registry.rs`
- Test: `crates/capabilities/tests/provider_registry.rs`

- [x] Write failing tests for schema, provider config roundtrip, grant policy context and disabled grants.
- [x] Implement registry contract types and SQLite store.
- [x] Run `cargo test -p local-first-capabilities --test provider_registry`.
- [x] Commit as `Add capability provider registry store`.

### Task 2: Connections, Tool Cache And Resource Hints

**Files:**
- Modify: `crates/capabilities/src/registry.rs`
- Test: `crates/capabilities/tests/provider_registry.rs`

- [x] Write failing tests for connection secret refs, tool cache and resource hints.
- [x] Implement connection config, tool cache and provider resource/rate metadata.
- [x] Run `cargo test -p local-first-capabilities --test provider_registry`.
- [x] Commit as `Add capability registry metadata cache`.

### Task 3: Facade Integration And Docs

**Files:**
- Modify: `crates/capabilities/tests/provider_registry.rs`
- Modify: `PROJECT.md`
- Modify: `docs/work-memory.md`
- Modify: `docs/superpowers/plans/2026-05-23-capability-provider-registry.md`

- [x] Write integration test using registry-derived `PolicyContext` with `CapabilityFacade`.
- [x] Mark completed plan steps.
- [x] Update work memory.
- [x] Run `make test`.
- [x] Commit as `Document capability provider registry`.
