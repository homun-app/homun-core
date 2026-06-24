# Agentic Workspace UX Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the first UX slice from the Agentic Workspace spec: thread-owned activity/computer surfaces, clean dock lifecycle, progressive plan rendering guardrails, and stable sidebar busy indicators.

**Architecture:** Keep the current Electron React shell. Harden the existing `ChatComputerPanel`, `ChatView`, `Sidebar`, gateway live-state read model, and UI contract checks instead of introducing a new layout. The first slice changes behavior and guardrails before any large visual redesign.

**Tech Stack:** React/TypeScript frontend, Rust desktop gateway, `apps/desktop/scripts/check-ui-contract.mjs`, existing Cargo tests.

---

### Task 1: Activity Ownership Contract

**Files:**
- Modify: `apps/desktop/src/components/ChatComputerPanel.tsx`
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `apps/desktop/scripts/check-ui-contract.mjs`
- Test: `cargo test -p local-first-desktop-gateway contained_computer_live -- --nocapture`

- [x] Ensure `ChatComputerPanel` renders only when the live computer owner matches the active chat thread.
- [x] Ensure completed terminal history does not keep a live dock visible.
- [x] Ensure gateway live state exposes `thread_id` only from active browser activity or running terminal entries.

### Task 2: Dock Lifecycle Contract

**Files:**
- Modify: `apps/desktop/src/components/ChatComputerPanel.tsx`
- Test: `apps/desktop/scripts/check-ui-contract.mjs`

- [x] Add explicit derived booleans for `browserRunning`, `terminalRunning`, `ownedLiveActivity`.
- [x] Hide the dock when there is no running browser/terminal activity for the active thread.
- [x] Keep completed file links in the message/artifact surfaces, not in the live dock.

### Task 3: Progressive Plan Guardrail

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Test: `apps/desktop/scripts/check-ui-contract.mjs`

- [x] Keep `PlanProgressCard` visible during streaming when closed `‹‹PLAN››` markers arrive.
- [x] Keep `RichMessage` streaming-aware for assistant text.
- [x] Ensure actionable `PLAN_PROPOSE` stays gated behind closed markers and final non-streaming state.

### Task 4: Sidebar Busy Cleanup

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Test: `apps/desktop/scripts/check-ui-contract.mjs`

- [x] Busy indicators come only from active stream ids and queued/running task read models.
- [x] Completed/failed task read models do not keep thread busy.
- [x] Background stream ids remain a separate source from active thread streaming.

### Task 5: Docs And Gate

**Files:**
- Modify: `docs/DEVELOPMENT.md`
- Modify: `docs/plans/2026-06-22-batch-1042-artifacts-memory.md`

- [x] Mark UX.1 as closed only after tests pass.
- [x] Run `npm run test:ui-contract`.
- [x] Run focused gateway tests for live computer state.
- [x] Run `npm run build`.
- [x] Run `git diff --check`.
