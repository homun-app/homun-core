# Steering Park + Resume, Confidence-Gate Removal, Coordinator Robustness — Design

**Date:** 2026-07-24

**Status:** Approved in conversation (full park+resume chosen); awaiting written-spec review

**Branch:** `fabio/browser-stream-recovery`. Build 2 (steering), separate from the browser build. Implements the spec `docs/superpowers/specs/2026-07-23-semantic-steering-control-design.md` sections that were designed but never built: park-at-boundary + coordinator-driven resume.

Closes the overnight-triage CRITICAL 1 (finalization fence hang), CRITICAL 2 (confidence 0.45 threshold silently disabling steering), and IMPORTANT 5 (coordinator orphan-row busy-poll + auth-fallback-401-only).

## Key finding that shapes the design

Park/resume is **not greenfield**. A checkpoint→abort→requeue→reseed pipeline already exists for gateway-restart recovery: the engine checkpoints each round (`LoopCheckpoint::from_state`, `append_agent_checkpoint(…, resumable=true)`), `recover_chat_turns_at_boot` aborts a stale run with `terminal_reason="gateway_restart"`, re-queues the SAME `turn_id`, and `latest_resumable_checkpoint_for_turn` (gated to `terminal_reason='gateway_restart'`) reseeds a fresh `run_turn` via `LoopCheckpoint::apply_to`, reusing the SAME assistant bubble. Park reuses this substrate with a new terminal reason and a coordinator-driven (not boot-driven) requeue.

Two hard invariants the design must reconcile (from the surface map):
- **(a)** the coordinator interprets steering only against a `Running` agent run (`steering_control.rs` early-returns otherwise) — a parked turn has no Running run;
- **(b)** interpreted/applied steering is bound to `claimed_run_id`, but a resumed turn runs under a NEW `run_id`.

The design resolves both by **leaving steering `pending` across the park** and doing the real claim→interpret→apply only under the resumed run.

## Part 1 — Fence rework: drain, bounded-wait, then park (CRITICAL 1)

`agent_loop.rs` finalization fence (currently an infinite spin `while !final_done && finalization_fence()==PendingInput { wait_for_interrupting_control().await; … }`). Replace with:

1. **Drain interpreted controls (including `continue`).** While the fence is `PendingInput` and `current_turn_control()` returns `Some` (it returns interpreted rows, continue included), apply it (`apply_turn_control`), push to `steering_to_complete`, set `final_done` on cancel. Applying moves the row `interpreted→applied`, which clears it from the fence's `pending|claimed|interpreted` count. This alone fixes the **trailing-`continue`** hang (a continue gets interpreted by the coordinator, drained here, and finalization proceeds — the refinement is incorporated into the forced synthesis).
2. **Bounded wait for uninterpreted rows.** If the fence stays `PendingInput` with NO interpreted control available (rows still `pending`/`claimed` — the coordinator is working or the model is unavailable), wait a bounded number of coordinator cycles (`PARK_WAIT_BUDGET`, ~a few seconds of `wait_for_turn_control` polls). If an interpreted row appears within the budget → back to step 1.
3. **Park.** If the budget elapses with rows still uninterpreted, PARK: emit a final `LoopCheckpoint` for the current round, and return a **non-delivering, parked** `TurnOutcome` (new signal — see below). Do NOT force synthesis, do NOT emit `Done`. The in-loop "don't finalize early while steering pending" guarantee is preserved (we exit without delivering, rather than spinning).

**Outcome signal.** Add `TurnDelivery::Parked` (or `TurnOutcome.parked: bool`). On `Parked`: `memory_answer` empty, no terminal event from the engine.

## Part 2 — Caller handles a parked turn (`run_agent_rounds` / `turn_executor.rs`)

When `run_turn` returns `Parked`:

- **Bubble stays open.** Do NOT finalize/commit the assistant bubble; set its delivery/activity state to a **waiting-for-model** marker (reuse the existing activity mechanism; the UI shows "Waiting for the model" — the label already exists in the steering lifecycle mapping). Do NOT emit a `Done`/`Cancelled` terminal event.
- **Finish the run with a park reason.** `finish_agent_run(run_id, Aborted, "parked_waiting_for_model")` (reuse the abort mechanism + a new terminal_reason string; the last resumable checkpoint is already persisted). The engine's per-round checkpoint plus the explicit park-point checkpoint guarantee a resumable row.
- **Park the task, do NOT auto-redispatch.** Set the chat_turn `TaskStatus` to a new **`Parked`** variant (added to `TaskStatus`), which the normal task runner does NOT pick up (unlike `Queued`, which would busy-restart). Only the coordinator's resume trigger moves `Parked→Queued`. `active_chat_turn_on` must treat `Parked` as **still active** (so a new user message becomes steering on the same logical turn, not a new turn) — add `Parked` to the active set (it is NOT in the `completed/failed/cancelled/expired/finalizing` inactive set).
- **Leave steering `pending`.** Do not claim or interpret at park.

## Part 3 — Coordinator-driven resume (steering_control.rs)

Extend the 500ms coordinator poll. For each due `pending` steering whose turn has **no `Running` run** but **is `Parked`** (a resumable park checkpoint exists):

1. **Availability probe.** Call `resolve_steering_semantic_decision` **without claiming and without persisting** (a throwaway interpretation whose only output we use is up/down — actionable vs fallback/error). This tests whether the semantic model is back.
2. **Model up (actionable):** transition the parked task `Parked→Queued` so the normal runner re-dispatches it. The resumed turn creates a NEW `Running` run and reseeds from the park checkpoint (`latest_resumable_checkpoint_for_turn` — widen its filter to accept `terminal_reason IN ('gateway_restart','parked_waiting_for_model')`). The steering is still `pending`; the coordinator's next poll now finds a `Running` run and interprets it **normally under the new run_id** (claim→interpret→the resumed live turn applies it). This sidesteps invariant (b): all binding happens under the resumed run.
3. **Model down (fallback/error):** set the steering row's `next_retry_at` with bounded backoff (reuse `retry_delay_seconds`, 2→60s); the turn stays `Parked`. No restart-thrash — the turn is only re-dispatched once the probe confirms the model is up.

The probe cost (one throwaway model call on the recovery path) is accepted for correctness; recovery is rare, and it avoids restarting the turn while the model is still down.

**Idempotency/dedup preserved:** resume reuses the same `turn_id` and assistant bubble; the terminal `Done` on the resumed run still goes through `insert_terminal_event_once`; no new user/assistant message is minted (the existing `local_user_{request_id}` / preallocated `assistant_message_id` dedup holds).

## Part 4 — Confidence-gate removal on the steering path (CRITICAL 2)

`semantic_decision.rs::resolve_model_value_for_context`, the `if decision.confidence < 0.45 { safe_fallback("low_confidence") }` runs BEFORE the `steering_control` branch, so it silently converts a valid steering decision (e.g. a clear `finalize_with_current_evidence` at confidence 0.44) into a non-actionable fallback → stuck `pending` forever. Fix: gate it on `!steering_control` (`if !steering_control && decision.confidence < 0.45 { … }`). The spec is explicit: no numeric threshold on the steering path; an uncertain model must instead return `needs_clarification`. This also removes the second hang trigger (a low-confidence steer that never becomes actionable). New-turn routing keeps the threshold unchanged.

## Part 5 — Coordinator robustness (IMPORTANT 5)

- **Orphaned pending rows.** A `pending` steering whose turn has neither a `Running` run nor a `Parked` checkpoint (the turn genuinely completed/cancelled) is currently re-selected every 500ms and silently no-ops forever (the early return is BEFORE `claim`, so attempts/backoff are never recorded). Fix: for such a row, record the diagnostic and set `next_retry_at` (bounded backoff); after a bounded number of attempts, mark it terminal (a new steering status or `held`) and surface "couldn't apply your steering — resend" rather than polling forever.
- **Auth fallback beyond 401.** `semantic_decision_auth_fallback` fires only on `RuntimeClientError::Status(401)`. Broaden it so the configured secondary-model fallback is ALSO attempted on other provider failures where a working fallback exists (403/429/5xx, and transport where a DIFFERENT provider/model is configured) — while keeping "keep pending on genuine unavailability" (no fallback model → stay pending, per spec). The point: not attempting a configured fallback on a non-401 failure is the gap; keep-pending-on-transport with no fallback is correct.

## Non-goals (this build)

- `needs_clarification` park (IMPORTANT 9) and multi-steer-per-round: the park mechanism this build adds makes the `needs_clarification` park a natural follow-up, but it is not required to close the CRITICALs; deferred unless trivial once park lands.
- `wait_if_busy` / local-provider timeout (MINOR 7): the semantic-model contention concern is mitigated by park (the turn no longer spins on the shared model), but wiring a real single-flight/timeout is a separate follow-up.
- No change to the browser build, payment gate, or grant binding.

## Verification strategy

Engine (`agent_loop` tests, injected ModelClient):
- A trailing `continue` interpreted at the fence is drained and the turn finalizes (no hang, no park).
- Uninterpreted `pending` steering + model unavailable at the fence → the turn PARKS within the wait budget (returns `Parked`, no `Done`, checkpoint present) — a test that would hang against the old spin.
- A `finalize`/`cancel` interpreted at the fence still applies exactly once.

Coordinator/store (task-runtime + gateway):
- Park sets task `Parked`, run aborted with `parked_waiting_for_model`, steering left `pending`, checkpoint `resumable`.
- Coordinator probe: model down → backoff, task stays `Parked`; model up → task `Queued`, resume reseeds from the park checkpoint, steering interpreted under the new run and applied, one terminal `Done`, same bubble.
- `active_chat_turn_on` treats `Parked` as active (a new user message becomes steering, not a new turn).
- Orphaned pending row (no run, no park) → backoff + bounded attempts + terminal surface, not infinite poll.
- Confidence 0.44 on the steering path → actionable (not `low_confidence` fallback); on the new-turn path → still gated.
- Auth fallback: 401/403/429/5xx/transport-with-configured-fallback → attempts the secondary model; no configured fallback → stays pending.

Installed-app checks (documented, run by the user): make the semantic model unavailable, send steering, verify "Waiting for the model"; restore the model, verify the SAME turn resumes and applies the steering with one answer and one bubble; verify no hang, no duplicate bubble.

## Risks and Mitigations

- **Restart-thrash on a down model** — mitigated by the probe (requeue only after the probe confirms availability) + backoff.
- **Cross-run steering binding (invariant b)** — mitigated by leaving steering `pending` across the park; all claim/interpret/apply happen under the resumed run.
- **Double terminal / duplicate bubble** — resume reuses the same `turn_id`, bubble, and `insert_terminal_event_once`; covered by the existing restart-recovery tests plus new park tests.
- **Park racing a manual Stop** — a user Stop near the park must produce exactly one terminal; the design routes park through the same `finish_agent_run`/terminal-once machinery and must be tested against the cancel race (`attach_turn_engine_abort`).
- **A parked turn never resumes (model never returns)** — bounded by the orphan-handling backoff + terminal surface (Part 5): after a max attempt budget the parked turn is finalized with an honest "couldn't interpret your steering" answer rather than parked forever.

## Delivery

TDD, per-task review with an adversarial pass on the turn-engine parts (this is the lifecycle the session spent effort stabilizing — single bubble, one terminal, idempotent replay must not regress). Then a whole-diff review, one commit set, and a build separate from the browser build for isolated live testing.
