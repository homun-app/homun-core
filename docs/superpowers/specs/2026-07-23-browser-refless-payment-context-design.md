# Ref-less Committing Actions: Focus-Scoped Payment Context Design

**Date:** 2026-07-23

**Status:** Approved in conversation (design deferred to technical verification, verified against code); awaiting written-spec review

> **Post-implementation status (2026-07-23, final whole-slice review):** implemented and green, but the adversarial whole-slice review found the ref-less leg is **NOT fully closed** — a must-fix cluster of schema-legal bypasses (Enter spellings, `scroll`+ref click, `selector`/`commit` fields) and a likely OOPIF fail-open for real cross-origin PSP iframes. See `docs/superpowers/2026-07-23-overnight-weakness-triage.md` (TOP PRIORITY section). The slice defends a cooperative model, not an adversarial one, until that cluster is fixed holistically.

**Scope:** Close the ref-less leg of the machine payment floor on the browse sub-turn (branch `fabio/browser-stream-recovery`). Follow-up item 1 of the final whole-branch review of the *Browser Semantic Effect Gate* slice. Item 2 (binding the approval grant to merchant/amount) is a **separate spec**, deliberately out of scope here.

## Gap being closed

The machine payment floor keys on `action.ref`. A committing action with no ref cannot be floored:

- `press`/`press_key` with Enter/Return — submits the form that contains the focus;
- `clickCoords` — a coordinate click, floor-blind by construction.

On a payment page, a model that under-declares such an action `ordinary` is not backstopped by the floor (the approval card still gates any *declared* payment). Verified against the code: the gateway never constructs `clickCoords` (the vision fallback is a retry-with-images seed, not a coordinate-click generator), and the `browser_act` schema does not expose it — it can only arrive as a model hallucination.

## Principles (unchanged from the effect-gate slice)

1. Signals are machine-only — DOM/ARIA contracts and frame origins; no label/keyword text feeds the payment decision.
2. Floors only raise, never lower; conflicts reject rather than silently upgrade.
3. Fail-closed on ambiguity.
4. The Payment Approval Card remains the only grant.

## Design

### 1. Sidecar signal: `focusPaymentContext`

The observation gains a boolean `focusPaymentContext`, computed with the exact same machine contracts as the per-ref floor, evaluated on the focused element:

- `true` when `document.activeElement` (hopping into same-process frames where accessible) is inside a `<form>` containing an `input[autocomplete^="cc-"]`, or inside a frame whose origin matches the existing PSP host-suffix list;
- `false` otherwise, and `false` on the legacy-snapshot fallback (same degraded path as the empty per-ref floor — pre-existing, documented).

Like `paymentFloorRefs` (same lesson from the effect-gate slice), the field rides on **every** sidecar response the gateway reads observations from: `snapshot()` and `act()`. The gateway mirrors it into the executor state at the same four sites where `payment_floor_refs` is updated.

Why focus-scoped is correct, not just quieter: Enter submits *the form that contains the focus* — the signal tracks exactly the mechanism that makes a ref-less Enter dangerous. An Enter pressed while focus is in a search or coupon field on the same checkout page is genuinely not a payment submit, and is not floored.

### 2. Gateway gate: page floor for ref-less committing actions

`effective_action_class` gains a page-level floor input alongside the per-ref floor set. A committing action **without a usable ref** (`press`/`press_key` Enter/Return) is floored `payment_commit` when either machine-derived condition holds:

- the last observation reported `focusPaymentContext = true`; **or**
- an earlier action **in the same bundle** targeted a ref in `paymentFloorRefs` (the model typed into a card field and then presses Enter — the focus is now there; inferable from the bundle content without re-reading the page).

The raised class flows through the existing lattice: declared `payment_commit` → standalone + card (unchanged flow); declared lower → `BROWSER_ACTION_CLASS_CONFLICT`, and inside a bundle the existing "payment never in a bundle" rule rejects the whole bundle. The rejection message for the bundle case must be precise: name the ref-less action, state the payment context, and instruct the standalone-approved retry. The flow then self-converges: the model re-issues the `type` alone (allowed), the next observation carries `focusPaymentContext = true`, and the standalone Enter is floored → card.

Outside payment context, ref-less committing actions behave exactly as today — no new friction.

### 3. Coordinate clicks and unknown committing kinds: typed reject

In the browse act path, `clickCoords` — and any committing `kind` outside the schema enum — is rejected with typed `BROWSER_UNSUPPORTED_COMMITTING_ACTION`, directing the model to click a specific `[ref=…]` control (which then gets the precise per-ref floor). No capability is lost: the schema already excludes these; only a hallucinated call can produce them. The task-executor path (`crates/browser-automation`) keeps its own approval gate and is untouched.

### 4. Model guidance (semantic, not lexical)

The `browser_act` description adds: on a payment page, prefer clicking the specific confirm control over pressing Enter — the per-ref floor is more precise, and approval is asked exactly when needed. Guidance by meaning; no word lists.

## Residual risk (documented, not hidden)

A site script listening for Enter at document level (outside the focused form) could submit a payment form while focus is elsewhere; no machine signal fires. The action remains gated by the model's own declaration and the card requirement for declared payments — the same residual class as the missing independent verifier, tracked in the effect-gate spec's residual gaps. This spec narrows the ref-less gap to that corner; it does not claim to eliminate it.

## Verification strategy

Rust (`browser_safety` + gateway):
1. Ref-less `press Enter`, `focusPaymentContext = true`, declared `ordinary` → `BROWSER_ACTION_CLASS_CONFLICT`.
2. Same with declared `payment_commit`, valid card → allowed once (standalone); no card → `BROWSER_PAYMENT_APPROVAL_REQUIRED`.
3. Same with `focusPaymentContext = false` → allowed as ordinary (no new friction).
4. Bundle `[type→floored ref, press Enter]` → whole bundle rejected with the precise typed message.
5. Bundle with no floored-ref predecessor and no focus context → press Enter passes as today.
6. `clickCoords` (and an unknown committing kind) in the browse act path → `BROWSER_UNSUPPORTED_COMMITTING_ACTION`.

Sidecar (TypeScript, real headless fixtures):
7. checkout fixture: focus in the cc field → `focusPaymentContext = true` on the snapshot AND on an `act()` response; focus in the non-cc search field → `false`.
8. train fixture (no cc/PSP): always `false` (non-regression).

## Non-goals

- No grant binding to merchant/amount/currency (item 2, separate spec — the hard part is the trust model of the *current* snapshot at claim time, which must be machine-derived, not model-supplied).
- No change to the approval-card flow, the bundle prohibition, or the effect-class vocabulary.
- No lexical signal anywhere.

## Delivery boundary

Implementation, tests, packaging, and any live validation are separate gates. No real payment is authorized by this design.
