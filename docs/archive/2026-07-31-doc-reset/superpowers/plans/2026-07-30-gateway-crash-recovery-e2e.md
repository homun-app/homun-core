# Gateway Crash Recovery E2E Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automate a real gateway hard-crash and restart proof for the canonical chat-turn lifecycle and browser checkpoint state.

**Architecture:** Start the production binary against an isolated store, enqueue through HTTP, seed an active attempt through production store APIs, hard-kill the process, restart it and assert convergence through both HTTP and durable read models. Add no second adapter, endpoint or persisted contract.

**Tech Stack:** Rust integration tests, reqwest, rusqlite, task-runtime, real desktop gateway binary.

---

### Task 1: Build the crash snapshot

**Files:**
- Create: `crates/desktop-gateway/tests/gateway_crash_recovery.rs`

- [x] Start the real binary on an isolated directory with one fixed user and workspace.
- [x] Enqueue one turn through `POST /api/chat/turns`.
- [x] Persist one leased attempt, run, agent checkpoint, objective, browser checkpoint, resource reservation and streaming assistant placeholder.
- [x] Hard-kill the process.

### Task 2: Prove boot convergence

**Files:**
- Modify only production files implicated by a failing invariant.

- [x] Restart the real binary with the same directory.
- [x] Assert generation fencing, requeue, lease cleanup and resource release.
- [x] Assert one aborted run/event, preserved agent/browser checkpoints and assistant-message reuse.
- [x] Restart once more and assert recovery idempotency.

### Task 3: Verify and publish

**Files:**
- Update: `docs/superpowers/specs/2026-07-30-gateway-crash-recovery-e2e-design.md`
- Update: `docs/superpowers/plans/2026-07-30-gateway-crash-recovery-e2e.md`

- [x] Run the focused integration test and all affected Rust tests.
- [x] Run formatting and Clippy with denied warnings.
- [x] Run the full Rust, browser and Electron matrices plus audits.
- [x] Verify the active dev server, ports and gateway health before publication.
