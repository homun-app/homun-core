# Browser Automation Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the browser automation runtime so every advertised browser method has local, policy-gated behavior and can be surfaced through capabilities and durable tasks.

**Architecture:** Keep Playwright execution in the Node/TypeScript sidecar and orchestration in Rust. The sidecar owns real browser primitives, artifact confinement, file chooser/download/dialog handling and console capture; Rust owns typed contracts, capability exposure, task execution, UI read models and tests.

**Tech Stack:** Rust 2024, serde/serde_json, local-first-task-runtime, local-first-capabilities, Node 25+, TypeScript, `tsx`, `vitest`, `playwright-core`.

---

## File Structure

- Modify `runtimes/browser-automation/src/browser/artifacts.ts`: normalize output artifact metadata and upload validation errors.
- Modify `runtimes/browser-automation/src/browser/profiles.ts`: expose assistant and attach-only user profile metadata.
- Modify `runtimes/browser-automation/src/browser/actions.ts`: support click wrapping for armed file chooser.
- Modify `runtimes/browser-automation/src/browser/session_manager.ts`: implement focus, close tab, screenshot, pdf, console, dialog response, file chooser and download handling.
- Modify `runtimes/browser-automation/src/server.ts`: dispatch all browser methods and validate params centrally.
- Add/modify `runtimes/browser-automation/tests/*.test.ts`: test artifact-producing methods and event-driven browser operations on real fixtures.
- Modify `crates/browser-automation/src/types.rs`: keep Rust method contracts aligned with sidecar methods.
- Modify `crates/browser-automation/src/task_executor.rs`: include browser UI metadata in redacted checkpoints.
- Modify `crates/capabilities/src/browser_provider.rs`: expose all browser tools with action classes.
- Modify `crates/task-runtime/src/ui.rs`: expose browser task metadata without raw input.
- Add/modify Rust tests for contracts, capability provider, task executor and UI read model.
- Modify `PROJECT.md` and `docs/work-memory.md` after verification.

---

### Task 1: Sidecar Event And Artifact Methods

- [x] Write failing Vitest coverage for `browser.screenshot`, `browser.pdf`, `browser.console`, `browser.respond_dialog`, `browser.arm_file_chooser`, `browser.wait_download`, `browser.focus` and `browser.close_tab`.
- [x] Run targeted Vitest and verify failures come from missing dispatch/behavior.
- [x] Implement artifact metadata, page event capture, focus/close tab, screenshot/pdf writing, console ring buffer, dialog response, armed file chooser and download saving.
- [x] Run targeted Vitest until green.
- [x] Commit as `Harden browser sidecar methods`.

### Task 2: User Profile Contract

- [x] Write failing tests for `browser.profiles` exposing `assistant` and attach-only `user`, and `browser.start` returning a manual-action error if user profile has no CDP endpoint.
- [x] Run targeted Vitest and verify failures.
- [x] Implement user profile metadata and guarded attach-only start path.
- [x] Run targeted Vitest until green.
- [x] Commit as `Add browser user profile contract`.

### Task 3: Rust Contracts, Capability Provider And Task UI

- [x] Write failing Rust tests for full browser method serialization, expanded capability tool listing, browser task checkpoint metadata and browser task UI detail.
- [x] Run targeted Rust tests and verify failures.
- [x] Implement expanded capability mapping and browser-specific UI metadata without exposing raw input.
- [x] Run targeted Rust tests until green.
- [x] Commit as `Expose production browser capabilities`.

### Task 4: Full Verification And Docs

- [x] Run `make browser-test`.
- [x] Run `cargo test --workspace`.
- [x] Run `make test`.
- [x] Update `PROJECT.md`, this plan and `docs/work-memory.md`.
- [x] Run `git diff --check`.
- [x] Commit as `Document production browser automation`.
