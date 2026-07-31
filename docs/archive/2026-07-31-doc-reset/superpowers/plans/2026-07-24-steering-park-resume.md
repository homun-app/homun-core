# Steering Park + Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** At the finalization boundary, park a chat turn (waiting-for-model) instead of spinning forever when steering can't be interpreted, and resume the SAME turn from its checkpoint when the semantic model returns; plus remove the confidence threshold on the steering path and harden the coordinator.

**Architecture:** Reuse the existing gateway-restart recovery pipeline (checkpoint→abort→requeue→reseed of the same `turn_id`, same assistant bubble). Park = a new `TurnDelivery::Parked` outcome + a new `TaskStatus::Parked` + `finish_agent_run(Aborted, "parked_waiting_for_model")`, steering left `pending`. Resume = coordinator probes model availability and flips `Parked→Queued`; the resumed run reseeds from the park checkpoint and interprets the still-pending steering under its new run_id.

**Tech Stack:** Rust workspace (`local-first-engine`, `local-first-task-runtime`, `local-first-desktop-gateway`), SQLite.

**Spec:** `docs/superpowers/specs/2026-07-24-steering-park-resume-design.md`. Surface map lives in the session; all file:line below are from branch `fabio/browser-stream-recovery`.

## Global Constraints

- Worktree `/Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery`, branch `fabio/browser-stream-recovery`. Every subagent: `cd` into it, confirm `git branch --show-current`, use absolute worktree paths, `git -C <worktree>`; never touch `/Users/fabio/Projects/Homun/app/crates/...` (branch main). If a `cargo -p` result looks wrong, re-run from inside the worktree.
- Comments English; no `Co-Authored-By`; commit on the branch, do not push. `cargo` on the gateway crate is slow — be patient.
- Invariants that MUST NOT regress (the session stabilized these): single assistant bubble per logical `turn_id`; exactly one terminal event per turn via `insert_terminal_event_once`; steering lifecycle `pending→claimed→interpreted→applied→completed`; no duplicate user/assistant messages on resume (reuse `turn_id`, `local_user_{request_id}`, preallocated `assistant_message_id`).
- The park terminal reason string is exactly `"parked_waiting_for_model"`. The new task status string is exactly `"parked"`.
- Machine/state-driven only; no keyword/lexical logic anywhere.

---

## File Structure

- `crates/engine/src/outcome.rs` — add `TurnDelivery::Parked`.
- `crates/engine/src/agent_loop.rs` — fence rework (`:1264` region + `wait_for_interrupting_control` `:45`): drain interpreted controls incl. `continue`, bounded wait, park; emit a park-point checkpoint; set `delivery = Parked`.
- `crates/task-runtime/src/types.rs` — add `TaskStatus::Parked` (`:83`), `as_str`/`parse` arms; handle exhaustive `match` sites.
- `crates/task-runtime/src/store.rs` — `park_chat_turn(...)` fn; widen `latest_resumable_checkpoint_for_turn` (`:1180`) terminal-reason filter; `list_parked_turns_with_due_steering(...)` / a parked-turn lookup; `unpark_chat_turn_to_queued(...)`.
- `crates/desktop-gateway/src/main.rs` — `run_agent_rounds` (`:29411`) / the outcome consumer: handle `TurnDelivery::Parked`; `semantic_decision_auth_fallback` (`:8462`) broaden beyond 401.
- `crates/desktop-gateway/src/turn_executor.rs` — `finalize_agent_run` (`:20`) / the parked branch: keep the bubble open, finish run with the park reason, park the task, no terminal event.
- `crates/desktop-gateway/src/steering_control.rs` — coordinator resume trigger (probe + unpark) + orphan-row handling (`interpret_pending_turn` `:94`, `start` poll `:65`).
- `crates/desktop-gateway/src/semantic_decision.rs` — confidence gate (`:537`) gated on `!steering_control`.

---

## Task 1: Engine — `TurnDelivery::Parked` + fence drain/bounded-wait/park

**Files:**
- Modify: `crates/engine/src/outcome.rs` (`TurnDelivery` enum ~:11)
- Modify: `crates/engine/src/agent_loop.rs` (`wait_for_interrupting_control` :45; fence loop :1264-1273; add a park constant)

**Interfaces:**
- Produces: `TurnDelivery::Parked`; `run_turn` returns `TurnOutcome { delivery: Parked, .. }` when it parks.

- [ ] **Step 1: Write the failing tests** (in `agent_loop.rs` tests, using the existing injected `ModelClient` test harness). Two tests:

```rust
#[tokio::test]
async fn trailing_continue_at_the_fence_is_drained_and_finalizes() {
    // A ModelClient whose finalization_fence() returns PendingInput until a
    // `continue_current_work` interpreted control is drained, then Ready.
    // Assert: run_turn does NOT park and delivers (no hang).
    // (Build on the existing steering test doubles; drive one round then exhaustion.)
}

#[tokio::test]
async fn uninterpreted_pending_steering_at_the_fence_parks_within_budget() {
    // A ModelClient whose finalization_fence() stays PendingInput and
    // current_turn_control() always returns None (rows pending, never interpreted).
    // Assert: run_turn returns delivery == TurnDelivery::Parked within the wait budget,
    // memory_answer empty, and NO Done was emitted. (This would hang against the old spin.)
}
```

- [ ] **Step 2: Run tests, verify fail.** `cargo test -p local-first-engine trailing_continue_at_the_fence uninterpreted_pending_steering_at_the_fence -- --nocapture` → FAIL (Parked variant missing / old code hangs — give the hang test a `tokio::time::timeout` wrapper so it fails fast rather than hanging the suite).

- [ ] **Step 3: Add the variant.** In `outcome.rs`, add `Parked` to `TurnDelivery`:

```rust
pub enum TurnDelivery {
    #[default]
    NoVisibleAnswer,
    Delivered,
    /// The turn hit its finalization boundary with steering still pending that
    /// the coordinator could not interpret (model unavailable). It checkpointed
    /// and parked; the caller keeps the bubble open and finishes the run with
    /// `parked_waiting_for_model` for coordinator-driven resume. No terminal event.
    Parked,
}
```

- [ ] **Step 4: Rework the fence.** Replace the `while` spin at `agent_loop.rs:1264-1273` with drain + bounded-wait + park. Add near the top: `const PARK_WAIT_CYCLES: u32 = 40;` (≈ 40 × the 50ms coordinator poll ≈ 2s). Replace the loop:

```rust
// Drain interpreted controls (including `continue`) so a steering queued/claimed
// while the last tool ran is honored before finalization. If the fence stays
// PendingInput with nothing interpreted (rows pending/claimed the coordinator
// cannot resolve — e.g. the semantic model is unavailable), park instead of
// spinning: exit with a non-delivering Parked outcome for coordinator resume.
let mut park_wait: u32 = 0;
while !final_done
    && model_client.finalization_fence() == crate::FinalizationFence::PendingInput
{
    if let Some(control) = model_client.current_turn_control() {
        apply_turn_control(model_client, &mut ls.messages, &control);
        steering_to_complete.push(control.steering_id);
        if control.disposition == TurnControlDisposition::CancelCurrentWork {
            final_done = true;
        }
        park_wait = 0;
        continue;
    }
    if park_wait >= PARK_WAIT_CYCLES {
        // Park: capture a resumable checkpoint at the boundary and return without
        // delivering. Do NOT force synthesis, do NOT emit Done.
        execution_journal.checkpoint(crate::loop_checkpoint::LoopCheckpoint::from_state(round, &ls));
        return crate::TurnOutcome {
            delivery: TurnDelivery::Parked,
            memory_answer: String::new(),
            image_rejection: None,
            ..Default::default()
        };
    }
    park_wait += 1;
    let _ = model_client.wait_for_turn_control().await;
}
```

Notes for the implementer: `round` is in scope at this point (the loop variable's last value; if not, capture the last round into a `let park_round = round;` before the loop — check the surrounding scope and use the correct round the checkpoint cadence uses). `TurnOutcome`'s other fields (tool_actions, memory_reads, browse_sources, final_plan) default via `..Default::default()`; confirm `TurnOutcome: Default`. `wait_for_turn_control()` is the existing bounded 50ms poll — one call ≈ one cycle. Keep `wait_for_interrupting_control` if still used elsewhere; if it is now unused, delete it.

- [ ] **Step 5: Run tests, verify pass.** `cargo test -p local-first-engine -- trailing_continue_at_the_fence uninterpreted_pending_steering_at_the_fence` → PASS; `cargo test -p local-first-engine` → all pass (existing steering/fence tests still green); `cargo build -p local-first-engine` clean.

- [ ] **Step 6: Commit.**

```bash
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery add crates/engine/src/outcome.rs crates/engine/src/agent_loop.rs
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery commit -m "feat(engine): park at the finalization boundary instead of spinning on pending steering"
```

---

## Task 2: task-runtime — `TaskStatus::Parked`, park/unpark store fns, widened checkpoint filter

**Files:**
- Modify: `crates/task-runtime/src/types.rs` (`TaskStatus` :83, `as_str`/`parse`)
- Modify: `crates/task-runtime/src/store.rs` (new fns; `latest_resumable_checkpoint_for_turn` :1180)

**Interfaces:**
- Produces: `TaskStatus::Parked` (string `"parked"`); `TaskStore::park_chat_turn(turn_id, user_id, workspace_id)`; `TaskStore::unpark_chat_turn_to_queued(turn_id, user_id, workspace_id) -> bool`; `TaskStore::parked_turn_for_pending_steering(...)` (or reuse an existing parked lookup); `latest_resumable_checkpoint_for_turn` accepts `terminal_reason IN ('gateway_restart','parked_waiting_for_model')`.

- [ ] **Step 1: Write the failing tests** (store test module):

```rust
#[test]
fn task_status_parked_round_trips() {
    assert_eq!(TaskStatus::Parked.as_str(), "parked");
    assert_eq!("parked".parse::<TaskStatus>().unwrap(), TaskStatus::Parked);
}

#[test]
fn park_then_resumable_checkpoint_is_readable_and_unpark_queues() {
    // Seed a chat_turn task Running + an agent_run + a resumable checkpoint.
    // park_chat_turn → task status "parked", run aborted "parked_waiting_for_model".
    // latest_resumable_checkpoint_for_turn now returns the checkpoint (filter widened).
    // unpark_chat_turn_to_queued → task status "queued", returns true; second call false.
}
```

- [ ] **Step 2: Run, verify fail.** `cargo test -p local-first-task-runtime task_status_parked park_then_resumable` → FAIL.

- [ ] **Step 3: Add the variant.** In `types.rs`, add `Parked` to `TaskStatus`, its `as_str` arm (`"parked"`), and `parse` arm. Then fix every exhaustive `match status` that now errors — search `grep -rn "TaskStatus::" crates/` and add a `Parked` arm where the compiler flags a non-exhaustive match (treat `Parked` like `Paused`/`WaitingResource` — i.e. an active, non-terminal, non-dispatchable-by-default state; do NOT add it to any "terminal" or "auto-dispatch/Queued-like" set). Confirm the task runner's dispatch query only picks up `queued`/`pending` (so `parked` is not auto-run).

- [ ] **Step 4: Add the store fns.**

```rust
/// Park a running chat turn at its finalization boundary: abort the running
/// agent run with `parked_waiting_for_model` (keeping its resumable checkpoint)
/// and set the task status to `parked` (still active, not auto-dispatched).
/// Steering rows are left `pending` for coordinator-driven resume.
pub fn park_chat_turn(&self, turn_id: &str, user_id: &str, workspace_id: &str) -> TaskRuntimeResult<()> {
    // abort the running run with the park reason (mirror abort_running_agent_runs_for_turn but
    // with terminal_reason = "parked_waiting_for_model"); then UPDATE tasks SET status='parked'
    // WHERE thread/turn matches and status='running'.
}

/// Flip a parked chat turn back to `queued` so the normal runner re-dispatches it
/// (resume). Returns true if a parked row was flipped.
pub fn unpark_chat_turn_to_queued(&self, turn_id: &str, user_id: &str, workspace_id: &str) -> TaskRuntimeResult<bool> { … }
```

Widen `latest_resumable_checkpoint_for_turn` (`store.rs:1195`): change `AND r.terminal_reason = 'gateway_restart'` to `AND r.terminal_reason IN ('gateway_restart','parked_waiting_for_model')`.

- [ ] **Step 5: Run, verify pass.** `cargo test -p local-first-task-runtime -- task_status_parked park_then_resumable` → PASS; `cargo test -p local-first-task-runtime` → all pass; `cargo build -p local-first-task-runtime` clean.

- [ ] **Step 6: Commit.**

```bash
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery add crates/task-runtime/src/types.rs crates/task-runtime/src/store.rs
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery commit -m "feat(task-runtime): Parked task status + park/unpark + widened resume checkpoint filter"
```

---

## Task 3: gateway caller — handle a `Parked` outcome (keep bubble open, park the turn)

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`run_agent_rounds` / the outcome consumer around `:29296-29411`)
- Modify: `crates/desktop-gateway/src/turn_executor.rs` (`finalize_agent_run` :20; the finalize branch that runs after the engine returns)

**Interfaces:**
- Consumes: `TurnDelivery::Parked` (Task 1); `TaskStore::park_chat_turn` (Task 2).

- [ ] **Step 1: Write the failing test** (gateway test): a `run_turn` that returns `TurnDelivery::Parked` → the caller (a) does NOT emit a terminal `Done`/`Cancelled` event for the turn, (b) leaves the assistant bubble non-finalized (delivery state not Completed/Failed), (c) calls `park_chat_turn` (task ends `parked`, run `parked_waiting_for_model`). Use the existing gateway turn-execution test harness (`recovery_reuses_the_existing_assistant_message` neighborhood shows the harness).

- [ ] **Step 2: Run, verify fail.** `cargo test -p local-first-desktop-gateway <park test name> -- --nocapture` → FAIL.

- [ ] **Step 3: Implement.** In the outcome consumer, before the normal Completed/Failed finalize, branch on `outcome.delivery == TurnDelivery::Parked`: call `store.park_chat_turn(turn_id, user, workspace)`, set the assistant bubble to a waiting-for-model activity/delivery state (reuse the existing "waiting for the model" projection used by the steering lifecycle; do NOT set Completed/Failed/Cancelled), and RETURN without going through `finalize_agent_run(Completed/Failed)` and without `emit_turn_event(Done|…)`. Ensure the park path is NOT taken on a normal `Delivered`/`NoVisibleAnswer` outcome (those keep their existing behavior).

- [ ] **Step 4: Run, verify pass.** `cargo test -p local-first-desktop-gateway <park test> -- --nocapture` → PASS; `cargo test -p local-first-desktop-gateway` → all pass (turn-lifecycle tests green); `cargo build -p local-first-desktop-gateway` clean.

- [ ] **Step 5: Commit.**

```bash
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery add crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/turn_executor.rs
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery commit -m "feat(gateway): a parked turn keeps its bubble open and parks the task, no terminal"
```

---

## Task 4: gateway coordinator — resume trigger (probe + unpark) + orphan-row handling

**Files:**
- Modify: `crates/desktop-gateway/src/steering_control.rs` (`start` poll :65; `interpret_pending_turn` :94)

**Interfaces:**
- Consumes: `TaskStore::{unpark_chat_turn_to_queued, latest_resumable_checkpoint_for_turn, park lookups}` (Task 2); `resolve_steering_semantic_decision` (existing).

- [ ] **Step 1: Write the failing tests** (steering_control tests, using the store test double the module already uses):

```rust
// model down: probe returns non-actionable → parked task stays parked, steering pending with backoff.
// model up: probe actionable → unpark (task → queued); steering still pending (resumed run interprets it).
// orphan: pending steering with no Running run AND no park checkpoint → backoff + attempts recorded;
//         after MAX attempts → surfaced terminal (not infinite silent no-op).
```

- [ ] **Step 2: Run, verify fail.** `cargo test -p local-first-desktop-gateway <coordinator resume tests> -- --nocapture` → FAIL.

- [ ] **Step 3: Implement.** In the coordinator poll / `interpret_pending_turn`, when there is NO `Running` run for a due pending steering:
  - If a resumable park checkpoint exists (`latest_resumable_checkpoint_for_turn` returns Some AND the task is `parked`): run an availability PROBE — call `resolve_steering_semantic_decision` WITHOUT `claim_pending_turn_steering` and WITHOUT persisting (discard the decision; use only actionable-vs-fallback). If actionable → `unpark_chat_turn_to_queued` (task → queued; the normal runner resumes it; steering stays pending → interpreted under the new run on the next poll). If not actionable → `release_turn_steering_for_retry`-style backoff on the row (bounded), leave parked.
  - Else (no run, no park checkpoint — orphaned): record the diagnostic + bounded backoff via the steering row's `interpretation_attempts`/`next_retry_at`; after a MAX attempts budget, transition the row to a terminal state (reuse `held` or add a terminal steering status) and surface "couldn't apply your steering — resend" rather than polling forever.
  - The existing `Running`-run path is unchanged (claim→interpret under the live run).

- [ ] **Step 4: Run, verify pass.** `cargo test -p local-first-desktop-gateway <coordinator resume tests>` → PASS; `cargo test -p local-first-desktop-gateway steering` → all pass; `cargo build -p local-first-desktop-gateway` clean.

- [ ] **Step 5: Commit.**

```bash
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery add crates/desktop-gateway/src/steering_control.rs
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery commit -m "feat(gateway): coordinator resumes a parked turn on model recovery; orphan-row backoff"
```

---

## Task 5: gateway semantic — confidence gate off the steering path + auth fallback beyond 401

**Files:**
- Modify: `crates/desktop-gateway/src/semantic_decision.rs` (`:537`)
- Modify: `crates/desktop-gateway/src/main.rs` (`semantic_decision_auth_fallback` :8462)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing tests.** (a) `resolve_model_value_for_context` with `steering_control=true` and a decision at `confidence=0.44` returns an ACTIONABLE steering decision (not `safe_fallback("low_confidence")`); with `steering_control=false` and 0.44 it STILL returns the low-confidence fallback. (b) `semantic_decision_auth_fallback` returns `Some(fallback)` for `Status(403)`, `Status(429)`, `Status(500)`, and a transport error WHEN a different configured provider/model exists; returns `None` when no fallback model exists.

- [ ] **Step 2: Run, verify fail.** `cargo test -p local-first-desktop-gateway <confidence + fallback tests> -- --nocapture` → FAIL.

- [ ] **Step 3: Implement.**
  - `semantic_decision.rs:537`: `if !steering_control && decision.confidence < 0.45 { … }` (thread `steering_control` into the check — it is already a parameter of the function; confirm and reference it).
  - `main.rs:8462` `semantic_decision_auth_fallback`: broaden the trigger from `matches!(error, Status(401))` to also cover `Status(403|429)`, `Status(s) if (500..=599).contains(&s)`, and transport/request errors — in every case delegating to `semantic_decision_auth_fallback_resolved_role` and returning `None` only when no distinct fallback model is configured (so "keep pending on genuine unavailability with no fallback" is preserved). Keep the existing local-JSON-model preference.

- [ ] **Step 4: Run, verify pass.** `cargo test -p local-first-desktop-gateway <confidence + fallback tests>` → PASS; `cargo test -p local-first-desktop-gateway semantic steering` → all pass; `cargo build -p local-first-desktop-gateway` clean.

- [ ] **Step 5: Commit.**

```bash
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery add crates/desktop-gateway/src/semantic_decision.rs crates/desktop-gateway/src/main.rs
git -C /Users/fabio/Projects/Homun/app/.worktrees/fabio/browser-stream-recovery commit -m "fix(steering): no confidence threshold on the steering path; auth fallback beyond 401"
```

---

## Final gates + review + build

- [ ] `cargo test -p local-first-engine`, `-p local-first-task-runtime`, `-p local-first-desktop-gateway` → all pass.
- [ ] `npm --prefix apps/desktop run build && npm --prefix apps/desktop run test:ui-contract && npm --prefix apps/desktop run test:electron` → pass.
- [ ] `git -C <worktree> diff --check` → clean.
- [ ] Whole-diff adversarial review of the turn-engine change (single bubble, one terminal, idempotent replay, steering lifecycle, park-vs-cancel race). Fix Critical/Important findings.
- [ ] Build: `npm --prefix apps/desktop run dist` (release gateway + staged sidecar + electron-builder) for isolated live testing of steering, separate from the browser build.

## Notes for the implementer

- The park path must be a strict superset of "don't finalize early while steering is pending" — it replaces the SPIN, keeping the guarantee. Never emit a `Done` on a parked turn.
- Resume reuses the SAME `turn_id` and assistant bubble; all steering claim/interpret/apply happen under the RESUMED run (steering left `pending` across the park) — do not rebind `claimed_run_id`.
- The probe is a throwaway interpretation (no `claim`, no persist) used only to detect model availability — accept the one extra model call on the rare recovery path.
- Test the park-vs-manual-Stop race: a Stop near a park must still produce exactly one terminal (route park through the same finish/terminal-once machinery).
