# Subagents Capability Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect `crates/subagents` to `crates/capabilities` so subagent tool access can use the provider-neutral Capability Layer.

**Architecture:** Add a bridge module in `local-first-subagents` that maps existing subagent permission envelopes and agent tool scopes into `local-first-capabilities` policy contexts and access plans. Keep the old `ToolDefinition` path intact during migration.

**Tech Stack:** Rust 2024, existing subagent crate, `local-first-capabilities`.

---

## Task 1: Capability Bridge Contracts

**Files:**
- Modify: `crates/subagents/Cargo.toml`
- Modify: `crates/subagents/src/lib.rs`
- Create: `crates/subagents/src/capability_bridge.rs`
- Test: `crates/subagents/tests/capability_bridge.rs`

- [x] Add failing tests for mapping task permissions into `PolicyContext`.
- [x] Add failing tests for model-visible versus executable capability tools with `ToolAgent`.
- [x] Add failing tests for managed provider denial unless cloud opt-in is set.
- [x] Run `cargo test -p local-first-subagents --test capability_bridge` and verify missing API failures.
- [x] Implement bridge conversion and access planning.
- [x] Run `cargo test -p local-first-subagents --test capability_bridge`.
- [x] Commit as `Connect subagents to capability policy`.

## Task 2: Verification And Memory

**Files:**
- Modify: `docs/work-memory.md`
- Modify: `docs/superpowers/plans/2026-05-23-subagents-capability-bridge.md`

- [x] Mark completed plan items.
- [x] Update work memory with the bridge decision.
- [x] Run `make test`.
- [x] Commit as `Document subagent capability bridge`.
