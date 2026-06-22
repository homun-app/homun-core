# Browser Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first production-ready browser automation module with an OpenClaw-inspired Node/TypeScript Playwright sidecar, Rust typed client, policy boundary, Capability provider and Durable Task Runtime executor.

**Architecture:** Keep Playwright out of Rust. The Node/TypeScript sidecar owns browser/CDP execution over stdio JSON lines; Rust owns contracts, policy, artifacts, task scheduling, approvals, audit and capability exposure. First implementation ships the managed `assistant` profile; attach-only `user` profile remains in the contract but not enabled.

**Tech Stack:** Rust 2024, serde/serde_json, local-first-task-runtime, local-first-capabilities, Node 25+, TypeScript, `tsx`, `vitest`, `playwright-core`.

---

## File Structure

- Create `runtimes/browser-automation/package.json`: sidecar scripts and dependencies.
- Create `runtimes/browser-automation/tsconfig.json`: TypeScript config.
- Create `runtimes/browser-automation/src/contracts.ts`: JSON-line request/response and browser action types.
- Create `runtimes/browser-automation/src/browser/errors.ts`: typed sidecar errors.
- Create `runtimes/browser-automation/src/browser/artifacts.ts`: artifact path confinement.
- Create `runtimes/browser-automation/src/browser/navigation_guard.ts`: URL/protocol/private-network policy.
- Create `runtimes/browser-automation/src/browser/profiles.ts`: `assistant` profile config and browser executable discovery.
- Create `runtimes/browser-automation/src/browser/session_manager.ts`: Playwright lifecycle, tab labels and page lookup.
- Create `runtimes/browser-automation/src/browser/snapshot.ts`: role snapshot and refs.
- Create `runtimes/browser-automation/src/browser/actions.ts`: atomic action executor.
- Create `runtimes/browser-automation/src/server.ts`: stdio JSON lines server.
- Create `runtimes/browser-automation/tests/*.test.ts`: sidecar unit and fixture tests.
- Create `crates/browser-automation`: Rust crate with `types.rs`, `policy.rs`, `artifacts.rs`, `client.rs`, `sidecar.rs`, `task_executor.rs`.
- Modify root `Cargo.toml`: add `crates/browser-automation`.
- Modify `crates/capabilities`: add dependency on `local-first-browser-automation` and `browser_provider.rs`.
- Modify `Makefile`: add browser sidecar install/test targets and include browser Rust tests in existing workspace tests.
- Modify docs and work memory after implementation.

---

### Task 1: Sidecar Contracts And Tests

**Files:**
- Create: `runtimes/browser-automation/package.json`
- Create: `runtimes/browser-automation/tsconfig.json`
- Create: `runtimes/browser-automation/src/contracts.ts`
- Create: `runtimes/browser-automation/src/browser/errors.ts`
- Test: `runtimes/browser-automation/tests/contracts.test.ts`

- [x] Write failing Vitest tests for JSON-line envelopes, success responses and typed browser errors.
- [x] Run `cd runtimes/browser-automation && npm test -- contracts.test.ts` and verify missing modules fail.
- [x] Implement package config, TypeScript config, contracts and typed errors.
- [x] Run `cd runtimes/browser-automation && npm install`.
- [x] Run `cd runtimes/browser-automation && npm test -- contracts.test.ts`.
- [x] Commit as `Add browser sidecar contracts`.

Expected contract names:

```ts
export type BrowserMethod =
  | "browser.health"
  | "browser.profiles"
  | "browser.start"
  | "browser.stop"
  | "browser.tabs"
  | "browser.open"
  | "browser.focus"
  | "browser.close_tab"
  | "browser.navigate"
  | "browser.snapshot"
  | "browser.screenshot"
  | "browser.act"
  | "browser.arm_file_chooser"
  | "browser.respond_dialog"
  | "browser.wait_download"
  | "browser.console"
  | "browser.pdf";
```

### Task 2: Sidecar Policy, Artifacts And Stdio Server

**Files:**
- Create: `runtimes/browser-automation/src/browser/artifacts.ts`
- Create: `runtimes/browser-automation/src/browser/navigation_guard.ts`
- Create: `runtimes/browser-automation/src/server.ts`
- Test: `runtimes/browser-automation/tests/navigation_guard.test.ts`
- Test: `runtimes/browser-automation/tests/artifacts.test.ts`
- Test: `runtimes/browser-automation/tests/server.test.ts`

- [x] Write failing tests that block `file:`, `data:`, `javascript:`, loopback/private network without opt-in and artifact path traversal.
- [x] Write failing server test that sends one JSON line and receives a matching `id`.
- [x] Run targeted npm tests and verify failures.
- [x] Implement navigation guard, artifact root resolver and stdio server dispatch.
- [x] Run targeted npm tests.
- [x] Commit as `Add browser sidecar policy server`.

### Task 3: Sidecar Browser Engine

**Files:**
- Create: `runtimes/browser-automation/src/browser/profiles.ts`
- Create: `runtimes/browser-automation/src/browser/session_manager.ts`
- Create: `runtimes/browser-automation/src/browser/snapshot.ts`
- Create: `runtimes/browser-automation/src/browser/actions.ts`
- Test: `runtimes/browser-automation/tests/browser_fixture.test.ts`
- Test fixture: `runtimes/browser-automation/tests/fixtures/form.html`

- [x] Write failing fixture test for `start -> open -> snapshot -> fill -> click submit -> snapshot`.
- [x] Write failing test for stale ref after navigation.
- [x] Run browser fixture tests and verify missing engine failures.
- [x] Implement managed `assistant` profile, browser discovery/launch, tab labels, snapshot refs and atomic actions.
- [x] Run browser fixture tests.
- [x] Commit as `Add browser sidecar engine`.

### Task 4: Rust Browser Automation Crate

**Files:**
- Modify: `Cargo.toml`
- Create: `crates/browser-automation/Cargo.toml`
- Create: `crates/browser-automation/src/lib.rs`
- Create: `crates/browser-automation/src/types.rs`
- Create: `crates/browser-automation/src/policy.rs`
- Create: `crates/browser-automation/src/artifacts.rs`
- Create: `crates/browser-automation/src/client.rs`
- Create: `crates/browser-automation/src/sidecar.rs`
- Test: `crates/browser-automation/tests/contracts.rs`
- Test: `crates/browser-automation/tests/policy.rs`
- Test: `crates/browser-automation/tests/client.rs`

- [x] Write failing Rust tests for serde contracts, policy denies and client envelope parsing.
- [x] Run `cargo test -p local-first-browser-automation`.
- [x] Implement types, policy, artifacts, client and sidecar process wrapper.
- [x] Run `cargo test -p local-first-browser-automation`.
- [x] Commit as `Add Rust browser automation client`.

### Task 5: Capability Provider

**Files:**
- Modify: `crates/capabilities/Cargo.toml`
- Modify: `crates/capabilities/src/lib.rs`
- Create: `crates/capabilities/src/browser_provider.rs`
- Test: `crates/capabilities/tests/browser_provider.rs`

- [x] Write failing tests for browser tool listing, action classes and policy-gated tool call.
- [x] Run `cargo test -p local-first-capabilities --test browser_provider`.
- [x] Implement `BrowserCapabilityProvider` over a trait-backed browser client.
- [x] Run the targeted test.
- [x] Commit as `Add browser capability provider`.

### Task 6: Durable Task Executor

**Files:**
- Modify: `crates/browser-automation/src/task_executor.rs`
- Test: `crates/browser-automation/tests/task_executor.rs`

- [x] Write failing tests for browser task resource declaration, checkpoint result, manual blocker mapping and completed action output.
- [x] Run `cargo test -p local-first-browser-automation --test task_executor`.
- [x] Implement `BrowserTaskExecutor` and task payload contracts.
- [x] Run the targeted test.
- [x] Commit as `Add browser task executor`.

### Task 7: Integration, Makefile And Docs

**Files:**
- Modify: `Makefile`
- Modify: `PROJECT.md`
- Modify: `docs/work-memory.md`
- Modify: `docs/superpowers/plans/2026-05-23-browser-automation.md`
- Test: `runtimes/browser-automation/tests/integration_stdio.test.ts`

- [x] Add `browser-sync`, `browser-test` and `test-browser` Makefile targets.
- [x] Add stdio integration test that starts the sidecar process and calls `browser.health`.
- [x] Run `make browser-test`.
- [x] Run `cargo test --workspace`.
- [x] Run `make test`.
- [x] Update docs and work-memory with production-ready status and remaining non-goals.
- [x] Mark this plan complete.
- [x] Commit as `Document browser automation runtime`.
