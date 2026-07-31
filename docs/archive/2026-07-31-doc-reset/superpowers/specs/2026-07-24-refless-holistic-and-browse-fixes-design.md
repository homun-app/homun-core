# Ref-less Holistic Close + Browser/Browse Correctness — Design & Plan

**Date:** 2026-07-24

**Status:** Approved in conversation (scope: this build). Steering fixes are a **separate build**; grant→merchant binding is a **separate design**.

**Branch:** `fabio/browser-stream-recovery`. Builds on the ref-less slice (`…505c5665`) whose final review returned must-fix-first.

This build closes the ref-less payment-floor leg for real (against a confused/adversarial model, not only a cooperative one) and fixes the clear browser/browse correctness findings from the overnight triage. It does NOT touch the steering engine (next build) or the grant→merchant binding (its own design).

---

## Part 1 — Ref-less holistic close

Root cause: the gateway's "is this action committing/submitting?" predicate does not match what the sidecar actually executes, so several schema-legal spellings submit a payment form ungated. The cure is a single canonical predicate at the gateway chokepoint, plus a robust (OS-focus-independent) payment-context signal.

### 1.1 Canonical committing/submitting predicate (`browser_safety.rs`)

Replace the ad-hoc `is_committing_action` matching with a predicate aligned to the sidecar's real execution (`runtimes/browser-automation/src/browser/actions.ts`):

- `click` / `clickCoords` — committing (clickCoords also rejected upstream, see 1.3).
- `press` — read the **`key`** field; `press_key` — read the **`text`** field (the sidecar uses `text` for `press_key`). Committing when that field, lowercased, ∈ `{enter, return, numpadenter, "\n", "\r"}`.
- `type` / `fill` — committing when `submit == true`, OR the text **ends with** `\n`/`\r` (Playwright presses Enter for a trailing newline — trailing only, so a multi-line textarea whose text does not end in newline is NOT over-gated), OR a `commit` field (lowercased) ∈ the enter-set.
- `hold` — remains gated (as today).

`is_refless_committing` (used for the page floor) = committing AND has no floorable `ref` (press/press_key Enter, or a `type/fill` submit whose ref is not the target being floored — but note: a `type submit=true` carries the field ref and is handled by the ref floor, so ref-less specifically means the submit gesture has no ref, i.e. press/press_key Enter). Keep it precise: `is_refless_committing` = committing press/press_key Enter (no ref).

### 1.2 Payment context is robust and machine-derived (fixes IMPORTANT C — OOPIF — and D — cross-tab)

The fragile signal was `focusPaymentContext` via `document.hasFocus()`, which is false for a real cross-origin PSP OOPIF whenever the app is not OS-frontmost. Replace reliance on it with a signal that does not depend on OS focus:

- **Last-acted-floored, per target.** The gateway already knows, for each `act`, which `ref` it targeted and the floored-ref set from the pre-act observation (`payment_floor_refs`). After an act that targets a ref ∈ `payment_floor_refs`, set `last_acted_floored[target_id] = true`; a snapshot/navigation that changes the page clears it for that target. This is frame-aware for free, because the per-ref floor (`computePaymentFloorRefs`, `locator.evaluate`) already floors card inputs inside cross-origin OOPIFs correctly.
- **Per-target state.** Replace the single global `last_focus_payment_context: bool` with a per-`target_id` map (both the focus flag and the last-acted flag), so a snapshot of tab A cannot clear tab B's payment context (fixes IMPORTANT D).
- A ref-less committing action on `target_id` is floored `payment_commit` when ANY holds: `focusPaymentContext[target]` (kept for the main-frame autofocus case), OR `last_acted_floored[target]`, OR (in a bundle) an earlier item targeted a floored ref.

`focusPaymentContext` stays as a best-effort secondary signal (works for same-process/main-frame cc-forms); it is no longer the sole PSP-iframe signal.

### 1.3 Reject non-schema execution fields (fixes IMPORTANT E; generalizes clickCoords)

In the browse act path (single action and each bundle item), before the gate, reject with typed `BROWSER_UNSUPPORTED_COMMITTING_ACTION`:

- `kind == "clickCoords"` (already done);
- any `kind` not in the `browser_act` schema enum;
- any action carrying a non-schema, execution-affecting field the sidecar honors but the schema does not expose: `selector`, and `commit` on a non-Enter meaning is folded into 1.1 rather than rejected (a `commit` that means Enter is handled as committing; `selector` is rejected because it bypasses the ref floor). Reject `selector`.

The reject must run before any payment-approval claim/secret side effect (already enforced for clickCoords; extend to the generalized check).

### 1.4 Sidecar `scroll`+ref bug (fixes CRITICAL B)

`runtimes/browser-automation/src/browser/actions.ts` currently does `if (action.ref) requireRef(refs, action.ref).click()` for `scroll` — a scroll must never click. Change `scroll` with a ref to `scrollIntoViewIfNeeded()` (no click). Verify no test/flow relies on scroll-clicking; if the model wants to click, it uses `click`. Defense-in-depth: the gateway also treats an action whose `ref` ∈ `payment_floor_refs` as gated regardless of kind (so any future kind acting on a floored control is caught).

### 1.5 Tests

Rust (`browser_safety` + gateway):
- Each Enter spelling (`NumpadEnter`, `\n`, `\r`) and `press_key` with `text:"Enter"` → committing / floored in payment context.
- `type` with `text` ending in `\n` in payment context, declared `ordinary` → `CONFLICT`; internal-newline textarea text (not ending in newline) → NOT committing.
- Last-acted-floored: act on a floored ref, then a ref-less Enter (no focus context) → floored. Per-target: acting on tab B's floored ref, then a tab-A snapshot, then Enter on tab B → still floored.
- `selector` field and any non-enum committing kind → typed reject before any claim; a `scroll` with a ref ∈ floored → gated.

Sidecar (TS): `scroll` with a ref does not click (asserts no navigation/click side effect, element scrolled into view); a **two-origin** (127.0.0.1 + localhost) OOPIF fixture — a card input inside a cross-origin iframe gets floored by the per-ref floor (proving the last-acted-floored path catches the PSP-iframe Enter); existing tests stay green.

---

## Part 2 — Browser/browse correctness

### 2.1 Browse answer serialization (IMPORTANT 3)

`crates/engine/src/browse.rs`: `browse_result_for_manager` emits `answer: {answer}` on one line and `browse_result_from_manager_text` keeps only the first line, silently dropping multi-line answers and mis-parsing a dropped `sources:`/`items:` line. Fix: serialize the whole `BrowseResult` as a single JSON object (round-trip via serde) instead of the line-prefixed text format; parse it back as JSON. Keep a fallback that treats a non-JSON string as the answer (back-compat for any in-flight value). Tests: a multi-line answer and an answer literally containing `sources:` round-trip intact.

### 2.2 Stream-recovery status-probe retry (IMPORTANT 6)

`apps/desktop/src/lib/turnStreamRecovery.mjs`: a single `getStatus` failure throws `turn_stream_state_unavailable` out of the recovery loop. Fix: retry the status probe with the same bounded backoff used for the stream `connect`, and only surface a terminal error after the recovery budget is exhausted. Test: a transient status failure followed by success recovers without a terminal error.

### 2.3 `structuralDelta` sequence-aware (IMPORTANT 4)

`runtimes/browser-automation/src/browser/snapshot.ts`: the naive set-diff hides removals, drops genuinely-new duplicate lines, and collapses under ref churn. Fix: make it a real line-sequence diff that reports both additions and removals (marked), preserves duplicates by position, and — because ref reassignment defeats line-identity — falls back to returning the full interact snapshot (not "[no structural changes]") when the added-line ratio exceeds a threshold, so the model never acts on a misleadingly empty delta. Also carry the refs matching the shown lines. Tests: removal surfaced; duplicate new line kept; ref-churn → full snapshot fallback.

### 2.4 Minors

- **Stale-ref no-progress (MINOR 8):** `main.rs` stale-ref recovery returns `Ok(...)` which resets `browser_no_progress`. Do not reset the no-progress counter on a stale-ref recovery (it is not real progress), so a ref-churning SPA still trips `max_no_progress`. Broaden detection beyond `stale`/`detached` to the common Playwright phrasings (`not attached`, `no node found`).
- **No-answer substring (MINOR 10):** `browse.rs:209` `contains("couldn't produce a final answer")` — make it a whole-string/anchored check (the sub-agent emits this as the entire answer), not a substring, so a legitimate answer quoting the phrase is not discarded.

---

## Out of scope (explicit)

- Steering engine (fence hang, confidence threshold, coordinator, needs_clarification, wait_if_busy) — **next build**.
- Grant→merchant/amount binding (effect-gate item 2) — **separate design** (unsolved trust model for the current snapshot).
- Effect-gate residuals 2 (payment-Act timeout double-consume) and 3 (PSP full-page over-floor) — carried to a later pass; noted in triage.

## Delivery

TDD + per-task review (payment-safety parts get an adversarial cross-task pass). One commit at the end of the build's green gates, then a build for live testing. No real payment authorized.
