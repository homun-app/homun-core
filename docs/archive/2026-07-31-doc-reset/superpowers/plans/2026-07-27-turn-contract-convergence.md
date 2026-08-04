# Turn Contract convergence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make human-wait one harness-owned turn phase (`AwaitingUser`), starting by converging `CHOICES` onto the same stop path as `pending_confirm`, and remove/quarantine parallel contracts that confuse ownership.

**Architecture:** Do not invent a second wait mechanism. Extend the existing confirm pipeline (`request_confirm` / `ACTIONABLE_CARD_MARKER_TAGS` / `WaitingUserApproval`) so `Choice` is a kind of the same stop. Gate plan nudges and `forced_synthesis` whenever that stop is open. Kill or wire half-landed flags (`needs_clarification`) and quarantine dead scaffolds (`tool_exec`) so the solid foundations stay obvious.

**Tech Stack:** Rust (`crates/engine`, `crates/desktop-gateway`), existing marker/event expansion, desktop `ChoicesCard` resume path, cargo tests.

**Contract docs:** [TURN_CONTRACT.md](../../TURN_CONTRACT.md), [foundations-and-kill-list](../2026-07-27-foundations-and-kill-list.md).

---

## File map

| File | Responsibility |
|---|---|
| `docs/TURN_CONTRACT.md` | Living invariant (already written) |
| `crates/engine/src/markers.rs` | Admit `CHOICES` into actionable protocol **or** shared helper “blocks turn” |
| `crates/engine/src/agent_loop.rs` | No nudge / no forced_synthesis on wait; treat choice like confirm |
| `crates/engine/src/outcome.rs` + gateway `turn_executor.rs` | Surface wait disposition; consume `needs_clarification` or delete |
| `crates/desktop-gateway/src/main.rs` (emit path) | Emitting CHOICES sets `request_confirm` / wait |
| Desktop `ChoicesCard` / resume | Resume must resolve wait (same as approval), not only append chat |
| `crates/desktop-gateway/src/tool_exec.rs` | Removed: dead scaffold, not the live chokepoint |
| `docs/STATO.md` | Checkpoint after each slice |

---

## Task 1: Contract tests that fail today (TDD)

**Files:**
- Create or extend: `crates/engine/src/agent_loop.rs` tests (or `markers.rs` / plan nudge unit tests)
- Reference: existing `needs_clarification_disposition_is_visible_on_the_outcome`

- [x] **Step 1: Write failing test — CHOICES present ⇒ plan-completion nudge must not fire**
- [x] **Step 2: Write failing test — actionable/wait path includes CHOICES**
- [x] **Step 3: Run tests — expect FAIL** (observed: model called twice)
- [x] **Step 4: Commit** — deferred until user asks

---

## Task 2: Minimal harness gate (safe slice — no full park yet if blocked)

- [x] Absorbed into Task 3 (`should_nudge_for_open_plan` + awaiting_user_choice exit)

---

## Task 3: CHOICES = same stop as confirm

- [x] **Step 1: Add `CHOICES` to actionable protocol**
- [x] **Step 2/3: Loop delivers wait; skip forced_synthesis / no plan reconcile-done**
- [x] **Step 4: Gateway** `agent_turn_waits_for_user` true for CHOICES
- [ ] **Step 5: Desktop resume** — still click→composer (acceptable for smoke); RPC unify later
- [x] **Step 6: Tests green**
- [x] **Step 7: Update** `TURN_CONTRACT.md` mapping row

---

## Task 4: `needs_clarification` — wire or delete

- [ ] Still open (forced_synthesis already skipped when flag set / clarify loop_exit)

---

## Task 5: Quarantine / kill confusion (no behavior change)

- [x] **Step 1: delete dead `tool_exec.rs` scaffold and remove `mod tool_exec;`**
- [ ] **Step 2–3:** tool_safety header + scrub drive docs — later

---

## Task 6: Observability / STATO

- [x] STATO checkpoint with test commands
- [ ] Live smoke by user
- [x] Link from agent-loop / CAPISALDI (prior slice)

---

## Out of scope (explicit)

- Browser/Trenitalia-specific fixes
- Full marker→parts migration
- Deleting `crates/orchestrator`
- Retiring NDJSON recovery in the same PR as CHOICES park
- Rewriting ChatView

---

## Done when

1. Choosing via `CHOICES` parks the turn like confirm.
2. Plan nudge + forced_synthesis cannot run over an open user-wait.
3. Kill list items in Task 5 are scrubbed/quarantined.
4. `TURN_CONTRACT.md` matches code; STATO points here.
