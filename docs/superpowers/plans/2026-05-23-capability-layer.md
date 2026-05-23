# Capability Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first production-oriented `crates/capabilities` slice with provider-neutral contracts, fake providers, policy gating, audit, channel contracts and managed-provider boundaries.

**Architecture:** Add a new Rust workspace crate that owns capability contracts independently from subagents and memory. The first slice uses in-memory providers and audit so `make test` remains local and deterministic; live MCP/Composio adapters come after the contracts are stable.

**Tech Stack:** Rust 2024, `serde`, `serde_json`, standard library collections, existing workspace test style.

---

## File Structure

- Create `crates/capabilities/Cargo.toml`: crate metadata and serde dependencies.
- Create `crates/capabilities/src/lib.rs`: public module exports.
- Create `crates/capabilities/src/types.rs`: shared ids, provider metadata, tools, calls, connections, triggers, channels and skill manifests.
- Create `crates/capabilities/src/error.rs`: typed `CapabilityError` and `CapabilityResult`.
- Create `crates/capabilities/src/policy.rs`: provider/tool visibility and execution policy.
- Create `crates/capabilities/src/provider.rs`: `CapabilityProvider` trait and fake provider implementation for tests and first integration.
- Create `crates/capabilities/src/audit.rs`: in-memory audit log with secret redaction.
- Create `crates/capabilities/src/facade.rs`: `CapabilityFacade` orchestrating providers, policy and audit.
- Create `crates/capabilities/src/channel.rs`: `ChannelProvider` trait and normalized message contracts.
- Create `crates/capabilities/tests/contracts.rs`: serialization and manifest contract tests.
- Create `crates/capabilities/tests/policy.rs`: visibility, execution and managed boundary tests.
- Create `crates/capabilities/tests/facade.rs`: provider registry, tool calls, audit and multiuser tests.
- Create `crates/capabilities/tests/channel.rs`: normalized channel contract tests.
- Modify `Cargo.toml`: add `crates/capabilities` to the workspace.
- Modify `docs/work-memory.md`: record implementation decisions after the slice is complete.

## Task 1: Workspace Crate And Contracts

**Files:**
- Create: `crates/capabilities/Cargo.toml`
- Create: `crates/capabilities/src/lib.rs`
- Create: `crates/capabilities/src/types.rs`
- Create: `crates/capabilities/src/error.rs`
- Test: `crates/capabilities/tests/contracts.rs`
- Modify: `Cargo.toml`

- [x] Add failing tests for provider ids, action classes, managed metadata and skill manifest serialization.
- [x] Run `cargo test -p local-first-capabilities --test contracts` and verify it fails because the crate/types do not exist.
- [x] Implement minimal contracts and typed errors.
- [x] Run `cargo test -p local-first-capabilities --test contracts`.
- [x] Commit as `Add capability contracts`.

## Task 2: Policy And Fake Providers

**Files:**
- Create: `crates/capabilities/src/policy.rs`
- Create: `crates/capabilities/src/provider.rs`
- Test: `crates/capabilities/tests/policy.rs`
- Modify: `crates/capabilities/src/lib.rs`

- [x] Add failing tests for disabled providers, unauthorized user/workspace access, model-visible versus executable tools and managed cloud permission.
- [x] Run `cargo test -p local-first-capabilities --test policy` and verify missing API failures.
- [x] Implement `CapabilityPolicy`, `ToolAccessDecision`, `CapabilityProvider` and `FakeCapabilityProvider`.
- [x] Run `cargo test -p local-first-capabilities --test policy`.
- [x] Commit as `Add capability policy and fake providers`.

## Task 3: Facade And Audit

**Files:**
- Create: `crates/capabilities/src/audit.rs`
- Create: `crates/capabilities/src/facade.rs`
- Test: `crates/capabilities/tests/facade.rs`
- Modify: `crates/capabilities/src/lib.rs`

- [x] Add failing tests for listing providers, listing policy-filtered tools, executing allowed calls, denying managed calls without consent, audit redaction and multiuser connection isolation.
- [x] Run `cargo test -p local-first-capabilities --test facade` and verify missing API failures.
- [x] Implement `CapabilityFacade` and `InMemoryCapabilityAudit`.
- [x] Run `cargo test -p local-first-capabilities --test facade`.
- [x] Commit as `Add capability facade and audit`.

## Task 4: Channel Contracts

**Files:**
- Create: `crates/capabilities/src/channel.rs`
- Test: `crates/capabilities/tests/channel.rs`
- Modify: `crates/capabilities/src/lib.rs`

- [x] Add failing tests for normalized inbound messages, outbound messages, thread ids and channel capabilities.
- [x] Run `cargo test -p local-first-capabilities --test channel` and verify missing API failures.
- [x] Implement `ChannelProvider`, `ChannelMessage`, `OutboundChannelMessage` and `ChannelCapabilities`.
- [x] Run `cargo test -p local-first-capabilities --test channel`.
- [x] Commit as `Add channel capability contracts`.

## Task 5: Full Verification And Memory

**Files:**
- Modify: `docs/work-memory.md`
- Modify: `docs/superpowers/plans/2026-05-23-capability-layer.md`

- [x] Mark completed plan items.
- [x] Update work memory with what was built and why.
- [x] Run `make test`.
- [x] Commit as `Document capability layer implementation`.

## Self-Review

- Spec coverage: provider-neutral contracts, fake providers, policy, audit, channels, skills and managed-provider gating are covered. Live MCP/Composio adapters are intentionally deferred by the spec.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: `CapabilityProvider`, `CapabilityFacade`, `CapabilityPolicy`, `CapabilityError`, `ChannelProvider` and `SkillManifest` are named consistently across tasks.
