# Overnight weakness triage — 2026-07-23

Prepared autonomously overnight (branch `fabio/browser-stream-recovery`). Two independent read-only audits, plus the state of the two browser slices executed this session. Nothing below except the browser-slice code was modified — the steering / stream-recovery findings are **for your triage**, not yet touched.

## What shipped this session (browser, all reviewed + green)

- **Semantic effect gate slice** (`0a5d362c..5b7319a6` + fixes `994524b5`, `dc40a617`): model-declared `action_class`, machine payment floor (cc-autocomplete + PSP origin), keyword payment tables deleted, goal budget, durable protocol metrics, per-call sidecar deadline, `browser_done` scoping. Final whole-branch review: 6 safety invariants hold, strictly safer than the old keyword gate. Two must-fixes (floor coverage for cc-form inputs; batch+timebox floor eval) applied.
- **Ref-less payment context slice** (in progress): page-level focus-scoped floor for Enter-submit + `clickCoords` reject. Task 1 landed (`eb9d877d`) with one ordering fix in flight; Task 2 (sidecar `focusPaymentContext`) pending.

## Effect-gate residual follow-ups (already in that slice's spec)

1. **Grant not machine-bound to merchant/amount** — `validate_payment_approval` (crates/vault/src/payment.rs) exists but has **zero production callers**; a valid grant can be spent on any control declared `payment_commit` in the same thread. Highest-value payment-safety follow-up. (Deferred by decision; its own spec, because the hard part is trusting the *current* snapshot at claim time — must be machine-derived, not model-supplied.)
2. Payment-Act timeout may double-consume a grant (consumed before dispatch; abandoned CDP call may still land) — warrants a user-facing warning.
3. PSP full-page checkouts over-floor every control → approval noise.
4. Ref-less committing gap for a **document-level** Enter listener outside the focused form — not covered by the focus-scoped floor (the ref-less slice narrows, does not eliminate).

---

## NEW pre-slice weaknesses (steering / stream-recovery / original browser protocol)

Ranked most-severe first. Line numbers from the current branch; re-grep before acting.

### CRITICAL 1 — Turn-finalization fence can hang the turn forever
`crates/engine/src/agent_loop.rs:1255-1264` + `wait_for_interrupting_control` (agent_loop.rs:44-58) + `GatewayModelClient::wait_for_turn_control` (model_client.rs:672-682) + `TaskStore::fence_chat_turn_finalization` (task-runtime/store.rs:1059-1084).
The post-loop drain loops while the fence returns `PendingInput` (any steering row `pending`/`claimed`/`interpreted`), but `wait_for_interrupting_control` only resolves for a **non-continue** disposition. Triggers: (a) a trailing `continue_current_work` steer interpreted after the loop breaks → fence stays `PendingInput`, wait never returns, row never applied → deadlock; (b) perpetual `low_confidence` (see CRITICAL 2); (c) semantic model unavailable at turn end. Runs inside `spawn_blocking` → a hot 50 ms DB poll on the shared store mutex that never terminates and emits no terminal `done`. **Contradicts** the steering spec ("park in a waiting-for-model state instead of spinning additional model rounds"). Fix needs a park-vs-spin design decision.

### CRITICAL 2 — `confidence < 0.45` gate silently disables steering (the threshold the design forbids)
`crates/desktop-gateway/src/semantic_decision.rs:537-541`, in the shared `resolve_model_value_for_context` (used by both new-turn routing and steering). A valid steering decision at confidence 0.44 → `safe_fallback("low_confidence")` → non-actionable → `release_turn_steering_for_retry` → pending forever ("Waiting for the model"), and feeds CRITICAL 1(b). **Contradicts spec line 50 explicitly** ("There is no additional numeric confidence threshold: an uncertain model must choose `needs_clarification`"). Fix: bypass the gate on the steering path only (it also guards new-turn routing, so don't remove globally). This is the same contradiction flagged at session start ([[browser-protocol-steering-analysis]]). **Pair CRITICAL 1+2 as the first morning target.**

### IMPORTANT 3 — Multi-line browser answers truncated to first line at browse→manager boundary
`crates/engine/src/browse.rs`: `browse_result_for_manager` emits `answer: {answer}` on one line (browse.rs:286-289) but the answer is free-form multi-line prose; `browse_result_from_manager_text` captures only the first line (browse.rs:348-350) and drops the rest, or worse, a dropped line equal to `sources:`/`items:`/`fields_missing:`/`evidence:` flips the parser and fabricates structured fields. Silent content loss on the delegated-browse happy path (e.g. a 3-option train result → only option 1 reaches the manager). Fix: length-prefix or fence the answer, or serialize the whole result as JSON.

### IMPORTANT 4 — `structuralDelta` naive set-diff (delta observation mode)
`runtimes/browser-automation/src/browser/snapshot.ts:531-541`. Reports only added lines → **removals invisible** (cleared banners/spinners → "[no structural changes]"); genuinely-new **duplicate** lines dropped; **ref churn** makes the "delta" the whole page (silent truncation) — opposite of intended savings; and delta shows only delta text but returns full `refs` → model gets refs for unseen lines. Fix: sequence-aware diff, or drop delta mode.

### IMPORTANT 5 — Steering coordinator only runs while run `Running`, busy-polls otherwise; auth fallback 401-only
`crates/desktop-gateway/src/steering_control.rs:94-139` + main.rs:8407-8470. A pending steer whose turn has no live run is re-selected every 500 ms and silently no-ops forever (early return before `claim`, so attempts/backoff never touched). Auth fallback fires only on `Status(401)` — a local model unreachable (connection refused/timeout → `Request`/`Io`) or 403/429/5xx never triggers the configured secondary-model fallback (the incomplete `3b642fa4` wip). Fix: back off/record on orphaned rows; broaden fallback trigger beyond 401 (keep-pending-on-transport is correct; not *attempting* the fallback is the gap).

### IMPORTANT 6 — `recoverTurnStream` turns a transient status-probe failure into a hard error
`apps/desktop/src/lib/turnStreamRecovery.mjs:54-63`. A single `getStatus` failure throws `turn_stream_state_unavailable` out of the whole recovery loop with no retry — precisely during a gateway restart/blip, the moment recovery matters. Stream `connect` transport errors ARE tolerated (48-50), but the status probe is not. **Contradicts** the stream-recovery design (transient disconnect must not become a false terminal error). Fix: retry the status probe with the same bounded backoff as connect.

### MINOR 7 — `wait_if_busy` dead field; local provider ignores `request_timeout_seconds`
Hardcoded `true`, never read except one test; `MistralRsProvider::generate_json` (crates/inference/src/mistralrs_provider.rs:90-110) ignores both `wait_if_busy` and `request_timeout_seconds` (no single-flight, no timeout wrapper). The steering decision's 45 s bound is not enforced on the local path, and it contends with the running turn on the same model — a hung local generation blocks the interpreter worker indefinitely. (This is the "semantic contention" flagged at session start, now with the exact reason the 45 s is a no-op.)

### MINOR 8 — Stale-ref auto-recovery returns success → defeats no-progress budget; substring detection
`crates/desktop-gateway/src/main.rs:23161-23221`. Stale-ref recovery returns `Ok(...)` → resets `browser_no_progress = 0`, so a ref-churning SPA can loop act→stale→snapshot→act indefinitely without tripping `max_no_progress: 2` (only rounds/wall-clock stop it). Detection is `contains("stale")||contains("detached")` — misses other Playwright phrasings.

### MINOR 9 — `needs_clarification` synthesizes instead of parking; only first steer applied per round
`agent_loop.rs:227-228,409-410` + `model_client.rs:54-117`. `NeedsClarification` breaks with `final_done=false` → forced synthesis produces a normal answer instead of parking with a clarification prompt (contradicts spec). `current_turn_control` applies only `.next()` → extra `interpreted` rows orphaned; a `NoVisibleAnswer` exit leaves applied steering stuck in "Applying…".

### MINOR 10 — `browse_result_from_outcome` false-negative on no-answer substring
`crates/engine/src/browse.rs:209-210`: `contains("couldn't produce a final answer")` misclassifies a legitimate answer that quotes the phrase as `found:false`.

---

### Recommended morning order
1. **CRITICAL 1+2 together** (steering fence hang + confidence threshold) — the highest-value pair; 2 is a targeted spec-alignment, 1 needs a park-vs-spin decision.
2. **IMPORTANT 3** (multi-line browse answer loss) — silent, on the happy path, cheap to fix.
3. **IMPORTANT 6** (stream-recovery status-probe retry) — cheap, matches the design's own goal.
4. **IMPORTANT 4, 5**; then the minors.

Each should go through the normal spec→plan→subagent-driven flow (steering is safety-adjacent). None were touched overnight.
