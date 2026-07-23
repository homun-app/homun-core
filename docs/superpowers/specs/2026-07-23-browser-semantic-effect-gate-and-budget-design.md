# Browser Semantic Effect Gate, Goal Budget, and Protocol Observability Design

**Date:** 2026-07-23

**Status:** Approved in conversation; awaiting written-spec review

**Scope:** The delegated `browse` sub-turn on the existing Homun Chromium runtime (branch `fabio/browser-stream-recovery`). Builds on the approved *Browser Observe–Actions–Extract* and *Browser Effects and Turn Stream Recovery* designs.

## Purpose

Two independent defects and two hardening items in the bounded browser protocol, delivered as one slice:

1. The final-payment safety gate decides meaning with a **keyword phrase table** (`FINAL_PAYMENT_LABEL_PATTERNS`, mirrored in `crates/browser-automation/src/policy.rs`). It fails on other languages, synonyms, and icon-only buttons, and — critically — it **fails open**: an unlabeled or unmatched control is treated as non-payment and executed without approval. This violates the project principle that natural-language meaning belongs to the model, not to a lexical table.
2. The browser budget is a **latency budget calibrated on one benchmark**, not a **goal budget**. Fixed constants (5 rounds, 55 s wall-clock) couple success to model speed: any incidental obstacle (cookie banner, stale ref, modal, slow load) or a slower local model turns a reachable goal into `timeout`/`partial` while the model was still making progress.
3. Protocol metrics are ephemeral (stderr + a 60-entry in-memory cell cleared at turn end), so the live acceptance gate leaves no analyzable evidence.
4. Individual sidecar calls have no gateway-level deadline, so a wedged CDP call stalls the sub-turn until the 300 s manager deadline; and two minor contract holes remain (per-item bundle schema; the turn-global `browser_done` terminal).

## Principles

1. Natural-language meaning is classified by the model; the code enforces the decision. No keyword, substring, or regex table decides intent — here or in the mirror crate.
2. Safety gates fail **closed**: an uncertain classification, a missing declaration, or an unavailable classifier on a committing action requires payment approval, never silent execution.
3. Machine contracts (DOM/ARIA attributes, iframe/PSP origins) are not natural language. They may **raise** a classification but never lower one.
4. Termination is driven by **verifiable lack of progress**, not by a wall clock. Time is the safety ceiling, not the success criterion.
5. Structural determinism (schemas, budgets, state machines, generation counters, protocol markers) is retained; only lexical interpretation of meaning is removed.

## Goals

1. Replace the payment keyword gate with an in-band, model-declared, fail-closed effect classification, enforced in code.
2. Delete both payment phrase tables; introduce no new lexical table anywhere.
3. Make the round budget a function of the declared result contract, with progress as the primary limiter and wall-clock as a safety ceiling.
4. Persist per-boundary redacted protocol events to the execution journal.
5. Add a per-call sidecar deadline with a typed timeout the loop can act on.
6. Close the per-item bundle schema hole and scope the `browser_done` terminal to the browser sub-turn.

## Non-Goals

- No independent verifier model in this slice. When the dedicated control-plane role exists, an independent classifier can mount **on the same `action_class` contract** without re-architecting the gate.
- No change to the approved effect boundary: login, account actions, and non-payment booking remain permitted when user-directed. Only the final money transfer requires an approval token.
- No CloakBrowser, no proxy/fingerprint work, no model-supplied JavaScript.
- No deliberate cross-turn browse continuation (checkpoint + manager re-`browse`); noted as future work below.
- No change to the retrieval BM25 surfaces, which remain candidate-generation with the model as decider.

## Architecture

### 1. Semantic effect gate (in-band, fail-closed)

**Declared class.** Every action in a bundle whose `kind` is committing — `click`, `press`/`press_key` on Enter/Return, `hold` (the existing committing set in `browser_safety.rs`) — must carry a required `action_class`:

- `ordinary` — navigation, search submission, non-financial form progression, opening results;
- `account` — login, logout, account creation, vault-credential use;
- `booking` — selecting a fare/service or confirming a reservation that does **not** transfer money;
- `payment_commit` — the final action that charges, transfers, authorizes, captures, or commits funds.

These are exactly the action classes of the approved *Browser Effects* design; no new vocabulary is introduced. Non-committing actions (`type`, `hover`, `scroll`, `wait`, `select`) do not require a class.

**Schema enforcement.** `browser_act_tool_schema` requires `action_class` on committing actions (the schema *advertises* the requirement to the model). The binding enforcement is deterministic and lives at the gateway, not at the capability facade: `browser_safety::effective_action_class` (via `evaluate_browser_action`) and `normalize_browser_action_bundle` reject a committing action with no class as typed `BROWSER_ACTION_CLASS_MISSING`; the bundle does not execute and the model re-declares. (Note: `crates/capabilities/src/facade.rs::validate_arguments` checks only top-level `required` + primitive types — it does *not* enforce enums or per-item `actions` shape; that is why the fail-closed enforcement must be — and is — in the gateway gate, not the facade.) This is the fail-closed default: absence never means "ordinary".

**Machine floors (raise-only).** At observe time the sidecar annotates each ref with a machine-derived floor, computed **only** from machine contracts, never from label text:

- a form field with `autocomplete` in `{cc-number, cc-exp, cc-csc, cc-name}` in the control's form → floor `payment_commit` for that form's submit/commit controls;
- a control inside an iframe or on a page whose origin matches a known PSP origin set (`stripe`, `adyen`, `paypal`, `braintree`, `checkout.com`, `klarna`, `nexi`, `worldline`, `satispay`, …) — matched as **origins/domains**, not as label text — → floor `payment_commit`.

The effective class is `max(declared, floor)` over a fixed lattice `ordinary < account < booking < payment_commit`. If a floor exceeds the declared class, the action is rejected as typed `BROWSER_ACTION_CLASS_CONFLICT`; the model must re-declare it as payment, entering the approval flow. Floors never lower a declared class.

**Enforcement (unchanged hard point).** `payment_commit` requires a matching, unconsumed Payment Approval Card, consumed atomically, as a standalone action (payment inside a multi-action bundle stays forbidden). `ordinary`/`account`/`booking` are permitted within the user's request. The `PaymentApprovalGrant` flow, CVV one-shot vault handling, and TTL pruning are unchanged.

**Keyword removal.** `FINAL_PAYMENT_LABEL_PATTERNS` and its enforcement in `browser_safety.rs`, and the mirror `is_final_payment_action`/`contains_final_payment_action` in `crates/browser-automation/src/policy.rs`, are **deleted** (converge, don't duplicate). No raise-only tripwire is retained: the raise role is served by machine floors, and consistency with the no-lexical-semantics principle outweighs the redundancy. The `snapshot_label_for_ref` helper is retained for a future approval-card binding/display use, but as of this slice it has **no caller** — the approval grant is bound to id/thread/TTL/one-shot only (`claim_payment_approval_from_map`). Binding the grant to the specific control (ref + snapshot generation) and to merchant/amount/currency (`crates/vault/src/payment.rs::validate_payment_approval`, currently unwired — zero production callers) is a **follow-up**, tracked in "Known residual gaps" below.

**Prompt-injection note.** The label and page context the model reads are site-controlled and therefore an injection channel. The gate is structured so the model can decide *when to ask* but can never *grant*: the grant is the user-signed card bound to merchant/amount/currency in code. A deceived classifier at worst omits an ask a floor does not cover — which is exactly the case the fail-closed default on committing actions with no resolvable class must cover.

### 2. Goal budget policy

The budget stops distinguishing "how long the user waits" (UX) from "is the model still progressing" (runtime). The current `BrowserBudget` default is `max_elapsed_ms: 300_000 / max_failed_navigations: 8 / max_no_progress: 5` (`crates/engine/src/config.rs`), overridden by the browse executor to `55_000 / 3 / 2` with `browser_max_rounds: 5`. This slice restructures the override:

**Progress as the primary limiter.** The existing `max_no_progress` counter is the real terminator. Progress is verifiable and structural: page generation advanced, actions completed, or `fields_missing` shortened between rounds. A round that produces none of these is no-progress; two consecutive (unchanged `max_no_progress: 2`) terminate. Loops produce no progress and therefore cannot renew budget — this, not the clock, prevents wandering.

**Contract-scaled rounds.** `browser_max_rounds` becomes a deterministic function of the declared `result_contract`, computed in code (no model input, no keyword):

```
rounds = clamp(BASE + ceil(required_fields / 2) + (minimum_items > 3 ? 1 : 0), BASE, ROUND_CAP)
```

with `BASE = 5`, `ROUND_CAP = 10`. A goal that declares a larger shape gets proportionally more rounds; a simple fact stays at the base. The cap is absolute.

**Wall-clock as a safety ceiling.** `max_elapsed_ms` is demoted to a blocked-call ceiling (`90_000`, aligned to the acceptance gate's per-run maximum, not its 60 s median). It protects against wedges; it does not decide success. The `< 60 s` median SLA stays in the acceptance gate, where it measures that scenario — it is not a runtime constant.

**Future work (out of this slice).** Budget exhausted *with evidence of progress* → typed retryable `partial` with a checkpoint, enabling a deliberate manager re-`browse` from the checkpoint (the "manager recovery decision" the Observe–Actions–Extract design already permits, distinct from the forbidden blind second `browse`).

### 3. Durable protocol metrics

A new `AgentExecutionEvent::BrowserProtocol { round, boundary, payload }` variant is added to `crates/engine/src/execution_journal.rs` (beside the existing `BrowserBudgetExceeded`). The same redacted per-boundary summaries produced by `browser_protocol_event_summary` — `manager_browse_start`, `observation`, `action_bundle`, `browser_done`, `terminal_result`, `timeout_fallback`, with `child_run_id`, observation chars/refs, action kinds, stop reason — are recorded to the journal. Stderr and the in-memory activity cell remain for the live UI. Redaction is unchanged and already tested: no raw page text, secrets, credentials, or vault material is persisted.

### 4. Per-call sidecar deadline

Each sidecar RPC (`navigate`, `act`, `snapshot`, `screenshot`) is wrapped in a gateway `tokio::time::timeout`: `navigate` 25 s, `act` 15 s, `snapshot`/`screenshot` 10 s — all within the sub-turn budget. Expiry yields typed `BROWSER_SIDECAR_TIMEOUT`, mapped to a bundle stop reason / error observation the model reads. No automatic retry; the loop decides against its budget. This removes the "wedged CDP call = up to 300 s" path, since the sub-turn's own budget is only checked between rounds.

### 5. Minor hardening

- **Per-item bundle schema.** `browser_act_tool_schema` `actions.items` moves from `{"type":"object"}` to a real schema: a `kind` enum and per-kind fields (with `kind` required). This is model-facing guidance; runtime rejection of a malformed/unknown-kind item happens in `normalize_browser_action_bundle` (gateway) and the sidecar's unknown-kind executor error, not at the capability facade (which does not validate the `actions` array shape).
- **`browser_done` scope.** The turn-terminal special case in `agent_loop.rs` (`if name == "browser_done" …`) is gated on a `browser_subturn` flag on `TurnConfig`. A `browser_done` emitted outside the browser sub-turn (e.g. hallucinated by the manager) receives a typed error instead of terminating the turn.

## Safety invariants

- No payment executes without an unconsumed matching approval.
- A committing action with no resolvable class, or with a classifier/floor conflict, is blocked pending approval — never executed.
- A machine floor can only raise a class; no page text can lower one.
- An approval cannot authorize a larger or different transaction; a channel/automation cannot approve its own payment (unchanged).
- Credentials and payment secrets stay out of prompts, snapshots, logs, and the journal.
- Removing the keyword block does not enable arbitrary page-script execution; `evaluate` stays blocked.

## Verification strategy

### Automated — Rust

1. Effect-gate matrix in `browser_safety`: declared class × machine floor × approval present/absent. Committing action with no class → `BROWSER_ACTION_CLASS_MISSING`; declared `ordinary` under a `payment_commit` floor → `BROWSER_ACTION_CLASS_CONFLICT`; declared `payment_commit` with valid card → executes once; without card → blocked.
2. Lattice test: effective class = `max(declared, floor)`; floor never lowers.
3. No-keyword test: assert the payment phrase tables no longer exist (the gate has no lexical label dependency).
4. Budget test: `rounds` formula across contract shapes; no-progress terminates at 2; wall-clock ceiling at 90 s.
5. Journal test: each boundary records a `BrowserProtocol` event; redaction keeps metrics, drops page text.
6. Sidecar-timeout test: a slow fake sidecar yields typed `BROWSER_SIDECAR_TIMEOUT` within the per-call bound.
7. Schema test: malformed bundle items rejected at the facade gate.
8. `browser_done` scope test: a manager-context `browser_done` does not terminate the turn.

### Automated — TypeScript sidecar

9. A fixture form with `autocomplete="cc-*"` fields and a PSP iframe → refs annotated with a `payment_commit` floor. The existing `train.html` fixture (no payment signals) → no floor, proving non-regression of ordinary submission.

### Live gate (unchanged acceptance)

10. Five consecutive Trenitalia searches (Napoli C.le → Milano C.le, 12 Aug 2026, one-way, one adult), stopping before booking/payment: ≥3 visible solutions, one `browse` call, median < 60 s, no run > 90 s, one terminal chat event. Inspect the installed-app transcript and Computer panel, not only test output. Add one synthetic payment-boundary check exercising the Payment Approval Card with fake transaction data — no real payment.

## Rollout

The effect gate and budget policy ship behind the existing temporary browser-protocol flag so old and new paths can be benchmarked in the worktree. The keyword tables are deleted only after the automated suite and all five live runs pass; the new path becomes the only path, with no hidden lexical fallback retained.

## Risks and Mitigations

- **A weak model mis-declares an action_class.** Machine floors raise payment cases the model understates; the fail-closed default blocks committing actions with no class; the approval card remains the hard grant.
- **A page hides payment intent from both model and floors** (novel PSP, no cc-autocomplete). The fail-closed default still requires a class; an unrecognized committing control with an `ordinary` declaration executes only if no floor fires — the residual risk the future independent verifier addresses. Documented, not silently accepted.
- **Contract-scaled rounds under-budget a hard site.** The progress limiter, not the round count, is primary; a genuinely progressing run reaches the round cap (10), and the future checkpoint/continuation path covers the rest.
- **Journal growth.** Only bounded redacted summaries are recorded, one per boundary, same volume as the existing stderr line.

## Known residual gaps / follow-ups

Surfaced by the final whole-branch review (2026-07-23). The implemented slice is **strictly safer** than the keyword gate it replaced (the old gate failed open on unlabeled and foreign-language controls); these are improvements on top, not regressions.

- **Ref-less committing actions are not floored (open design decision).** The machine floor keys on `action.ref`. A committing action with no ref — `press`/`press_key` Enter/Return (form submit), or a coordinate `clickCoords` — cannot be floored, so on a payment page a model that under-declares it `ordinary` is not backstopped by the floor (the approval card still gates any *declared* payment). The `type submit=true` case on a credit-card field is now covered (cc-form input refs are floored). Closing the ref-less case needs a **page-level payment-context** notion (if the current snapshot contains any cc/PSP floor, treat ref-less committing actions as payment-context and require a class/approval, and/or reject `clickCoords`/unknown kinds in the browse act path since the schema already excludes them). Deferred pending that decision.
- **Approval grant is not machine-bound to the transaction (highest-value follow-up).** `claim_payment_approval_from_map` validates id + thread + TTL + one-shot only. `crates/vault/src/payment.rs::validate_payment_approval` (merchant/domain/amount/currency/fingerprint) exists but has **zero production callers**, so a valid grant can be spent on any control the model declares `payment_commit` in the same thread. Wiring this binding (and the control-level ref/generation binding above) is the natural next slice.
- **Payment-Act timeout could double-consume.** The grant is consumed before dispatch; a `BROWSER_SIDECAR_TIMEOUT` on a payment action abandons a background CDP call that may still land. At-most-once *authorization* holds, but a re-approval after such a timeout could double-pay — warrants a user-facing warning on payment-action timeout.
- **PSP full-page checkouts over-floor.** On a full-page PSP redirect (e.g. `checkout.stripe.com`) every control is floored, so benign "back"/"edit" clicks yield `CLASS_CONFLICT` and needless approval asks — consider scoping the origin floor to embedded PSP frames or to controls in/near the cc-form.
- **Observability granularity.** `browser_protocol_journal_event` records `round: 0` (round not yet threaded) and four allow-list keys are not yet populated by current metric producers — forward-compatible, populate when threadable.
- **Pre-existing, out of slice.** A stale comment/test around `read_only` in `execute_browser_tool` describes a dispatch check that does not exist (`read_only` gates only dialog acceptance); flagged for a separate cleanup.

## Delivery boundary

Implementation, tests, packaging, installed-app replacement, and release publication are separate gates. No real purchase, payment, deployment, or release publication is authorized by this design approval alone.
