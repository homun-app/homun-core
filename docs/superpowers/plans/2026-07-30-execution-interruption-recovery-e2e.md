# Execution Interruption And Recovery E2E Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and close the remaining interruption boundaries for the single `ExecutionContract -> ExecutionOutcome` loop without adding another lifecycle API.

**Architecture:** Keep the execution journal and task lease as durable authority. Add deterministic tests at the external-effect boundary: an abandoned claimed effect must become `Uncertain` immediately and a cancelled shell command must terminate its complete process group. Reuse the existing runtime tests for model cancellation, active deadline, lease reclaim, proactive interruption wiring and recovered-outcome idempotency.

**Tech Stack:** Rust, Tokio, rusqlite, Unix process groups, the existing execution runtime and effect receipt store.

---

### Task 1: Terminalize abandoned effect dispatches

**Files:**
- Modify: `crates/desktop-gateway/src/effect_host.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [x] Add a failing test that drops a dispatch guard after `EffectDecision::Execute` and asserts the receipt is immediately `Uncertain`.
- [x] Make `EffectLease` the mandatory RAII dispatch guard, with explicit complete, uncertain and verified-not-applied terminal methods.
- [x] Apply the guard automatically to every connector, browser and capability lease so cancellation cannot leave a receipt in `Started`.
- [x] Prove a second claim resolves the same receipt and never executes it again.

### Task 2: Terminate complete command process groups

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [x] Add a failing Unix test that aborts a shell command whose child is waiting and proves the descendant PID is no longer alive.
- [x] Spawn each project command in its own process group and retain a drop guard while output is awaited.
- [x] Use the same command runner for sandboxed and explicitly approved unsandboxed execution.
- [x] Re-run the focused process and effect tests.

### Task 3: Execute the recovery matrix

**Files:**
- Modify: `docs/architecture/agent-loop.md`
- Modify: `docs/superpowers/specs/2026-07-30-long-running-execution-host-design.md`

- [x] Run the focused model cancellation and attached engine abort tests.
- [x] Run active deadline, lease loss/reclaim and recovered-outcome idempotency tests.
- [x] Run effect receipt, projection restart and continuation tests.
- [x] Document which guarantees are deterministic local E2E and which still require a live external-provider smoke.

### Task 4: Verify and publish

**Files:**
- Modify only documentation required by the resulting behavior.

- [x] Run formatting, Clippy with denied warnings and all Rust workspace tests.
- [x] Run Electron tests, UI contract, typecheck, build and dependency audits.
- [x] Remove only dead code exposed by the implementation.
- [x] Commit and push `main`, restart dev, and verify ports `1420` and `18765` plus gateway health.
