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

- [ ] Add failing tests for managed metadata.
- [ ] Add failing tests for mapping Composio tools to `CapabilityTool`.
- [ ] Add failing tests for tool execution request/response mapping.
- [ ] Add failing tests for connection and trigger mapping.
- [ ] Run `cargo test -p local-first-capabilities --test composio_provider` and verify missing API failures.
- [ ] Implement `ComposioTransport`, `ComposioCapabilityProvider`, `ComposioProviderConfig`, `ComposioToolPolicy`, and `InMemoryComposioTransport`.
- [ ] Run `cargo test -p local-first-capabilities --test composio_provider`.
- [ ] Commit as `Add Composio managed provider`.

## Task 2: Verification And Memory

**Files:**
- Modify: `docs/work-memory.md`
- Modify: `docs/superpowers/plans/2026-05-23-composio-managed-provider.md`

- [ ] Mark completed plan items.
- [ ] Update work memory with Composio managed boundary.
- [ ] Run `make test`.
- [ ] Commit as `Document Composio managed provider`.
