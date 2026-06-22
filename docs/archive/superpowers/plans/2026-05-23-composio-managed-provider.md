# Composio Managed Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Composio managed provider adapter behind the existing Capability Layer without making cloud execution implicit.

**Architecture:** Implement `ComposioCapabilityProvider` with a transport trait and in-memory test transport. The provider declares a managed-cloud boundary, maps Composio tool/account/trigger shapes into internal contracts, and relies on `CapabilityPolicy`/`CapabilityFacade` for opt-in enforcement.

**Tech Stack:** Rust 2024, serde_json, existing `CapabilityProvider` trait, fake transport for local tests.

---

## Task 1: Composio Managed Provider

**Files:**
- Create: `crates/capabilities/src/composio.rs`
- Modify: `crates/capabilities/src/lib.rs`
- Test: `crates/capabilities/tests/composio_provider.rs`

- [x] Add failing tests for managed metadata.
- [x] Add failing tests for mapping Composio tools to `CapabilityTool`.
- [x] Add failing tests for tool execution request/response mapping.
- [x] Add failing tests for connection and trigger mapping.
- [x] Run `cargo test -p local-first-capabilities --test composio_provider` and verify missing API failures.
- [x] Implement `ComposioTransport`, `ComposioCapabilityProvider`, `ComposioProviderConfig`, `ComposioToolPolicy`, and `InMemoryComposioTransport`.
- [x] Run `cargo test -p local-first-capabilities --test composio_provider`.
- [x] Commit as `Add Composio managed provider`.

## Task 2: Verification And Memory

**Files:**
- Modify: `docs/work-memory.md`
- Modify: `docs/superpowers/plans/2026-05-23-composio-managed-provider.md`

- [x] Mark completed plan items.
- [x] Update work memory with Composio managed boundary.
- [x] Run `make test`.
- [x] Commit as `Document Composio managed provider`.
