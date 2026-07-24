# Browser Progress Signal, Budget-Resets-on-Success, and Autocomplete Selection — Design

**Date:** 2026-07-24
**Status:** Approved in conversation (D1–D4 confirmed; "iniziamo così poi testiamo e capiamo")
**Branch:** `fabio/browser-stream-recovery`. Build 3 (browser), separate from Build 1 (payment/browser) and Build 2 (steering).

> ⭐ Code is the source of truth. Line numbers below age on every edit — re-grep the named
> symbol, never trust the number. This spec is the contract; the plan re-reads before touching.

## Problem (root cause, evidence-backed)

A live test ("mi trovi un treno da napoli per milano il 18 agosto alle 8") produced a bad
result: the browse model typed the station name "Napoli"/"Milano" **three times each**,
never selected a station from the autocomplete, and the browse died with
`browser_budget_exceeded:wall_clock` ("Timeout durante la compilazione del form"). The turn
then fell back to ~12 doomed `curl` attempts and an apologetic answer.

Two symptoms, **one root cause**: *browser "progress" is misdefined.*

1. **Prose classification treats everything as success.** A `browser_act` returns plain prose
   (`"Action performed. Updated snapshot: …"`), and even a failure returns prose
   (`"Action failed: type timed out: …"`). `classify_tool_result`
   (`crates/engine/src/execution_journal.rs` ~206) tries `serde_json::from_str`, fails on prose,
   and returns `"success"`. So both a no-op re-type **and a timeout** count as success →
   `browser_no_progress` is reset to 0 every round (`crates/engine/src/agent_loop.rs` ~852) →
   the `max_no_progress` guard (browse sub-turn: `2`) never trips on autocomplete churn.

2. **The only remaining brake is a cumulative wall-clock**, measured from `turn_started_at`
   (absolute, never reset) at two levels:
   - sub-turn: `agent_loop.rs` ~270 (`cfg.browser_budget.stop_reason(turn_started_at.elapsed(), …)`);
   - parent delegation: `agent_loop.rs` ~732 (`remaining = max_elapsed_ms − turn_started_at.elapsed()`),
     which shrinks toward zero and even folds in pre-browse curl time.
   On a slow cloud model (~35–50 s/ReAct round observed in the logs), the browse sub-turn's
   90 s ceiling (`crates/desktop-gateway/src/main.rs` ~27424) is exhausted in ~2 rounds — far
   short of what a multi-field train form needs. The safety backstop became the binding limit
   and chokes a browse that *is* progressing.

3. **Autocomplete selection is hard-gated on ARIA.** The sidecar HAS a capable selector
   (`confirmAutocomplete`, `runtimes/browser-automation/src/browser/actions.ts` ~886) but it
   only runs when the input advertises combobox ARIA (`inputComboboxInfo` ~705:
   `role=combobox`/`aria-autocomplete`/`aria-controls`/`list`). Trenitalia/lefrecce's React
   station picker lacks those → the selector returns immediately, leaving the typed text with
   **no suggestion selected**. The reliable commit path (`commit:"arrow_enter"`: type → wait →
   ArrowDown → Enter, ~319) is **not reachable from the schema** (only `submit` is exposed →
   raw Enter, nothing highlighted). `kind:"fill"` (`locator.fill`) bypasses autocomplete
   entirely yet is advertised as a normal option. The browse sub-agent system prompt
   (`main.rs` ~27085) says nothing about typeaheads.

The naive fix ("reset the timer on the existing success signal") FAILS: the existing signal is
broken (timeouts read as success), so reset-on-success would be reset-always → a stuck browse
never times out. **Progress must be redefined first (D1/D2); only then does a
budget-that-resets-on-success (D3) behave; and D4 makes the autocomplete actually succeed so
"progress" is reachable.** The four parts are one coupled change.

## D1 — Structured action outcome replaces prose classification

Browser actions must carry a **machine outcome**, not be re-derived from prose. This is control
metadata, not intent interpretation (consistent with the existing `ToolOutcomeHint` doc in
`crates/engine/src/contract.rs` ~147).

- The sidecar already returns structured fields for `type`
  (`committedOption?: string`, `suggestions?: string[]`, `ok`, `url`) — `actions.ts` ~52/~330 —
  and computes `structuralDelta` (Build 1 B3). Extend the sidecar's act response so **every**
  action kind returns the machine signals the outcome needs: at minimum
  `{ ok: boolean, errored: boolean, structuralChange: boolean, committedOption?: string }`
  (navigation already distinguishes success/failure).
- The gateway's browser execution (`execute_browser_tool` / the `browser_act` arm in `main.rs`
  ~23085–23300) maps those signals to a `ToolOutcomeHint` and returns it via `ToolEffects`
  (today the browser-granular branch in `agent_loop.rs` ~710 returns `ToolEffects::default()`
  → hint `None` → prose classify). Thread a real `outcome_hint` through that branch.
- The engine consumes `outcome_hint` where it already can (`agent_loop.rs` ~800:
  `outcome_hint … unwrap_or_else(classify_tool_result)`), so the browser-granular stalled
  calc (`agent_loop.rs` ~844) sees the true outcome instead of the prose "success".

`ToolOutcomeHint` today is `Success | NoProgress` (contract.rs ~153). `NoProgress` is
sufficient for the budget (both error and stall increment the same counters);
`failed_navigations` stays navigation-only. **No new enum variant is required** unless the plan
finds a concrete need to separate hard errors — keep the change minimal.

## D2 — Definition of real browser progress

An action counts as **progress** (→ `outcome_hint = Success`, resets stall guards) iff it did
**not** error/timeout **and** at least one of:

- **navigated** to a different URL (successful `browser_navigate`), or
- **committed a field** — for a `type`/autocomplete action, a suggestion was actually selected
  (`committedOption` present, or `selectionConfirmed`), or
- **produced a goal-relevant structural change** that is NOT merely the field echoing its own
  typed text (use `structuralDelta` but exclude the just-typed input's own value churn), or
- **extracted new evidence** (an extract/observe step that yields content not already held).

Everything else — a `type` that leaves the field with no suggestion selected, a timeout, an
empty/blocked/errored action, a stale-ref auto-recovery — is **no progress** (→ `NoProgress`,
increments `browser_no_progress`). This makes autocomplete churn trip `max_no_progress` fast
(the user's "Napoli ×3" stops at the 2nd or 3rd unproductive re-type) instead of running to the
wall-clock.

Rationale for excluding "snapshot changed" alone: typing one character changes the snapshot, so
a pure structural-delta signal would still read re-typing as progress (this is exactly why the
existing no-change guard is defeated). Progress is *goal advancement*, which for a typeahead
means **a suggestion got selected**, not "text appeared in the box".

## D3 — Budget that resets on success (two tiers)

Keep a ceiling, but make the primary control a **stall window** that resets on real progress
(D2). "Un tetto può esserci, ma si resetta ad ogni successo."

- **Stall window (primary, resets on progress):** the wall-clock check at `agent_loop.rs` ~270
  measures time **since the last real-progress event**, not since `turn_started_at`. Add a
  `last_browser_progress_at: Instant` to loop state, initialized when the browser is first used
  and reset wherever `browser_no_progress` is reset to 0 (the D2 progress point,
  `agent_loop.rs` ~853) — the same place the existing `reset_stall_guards` fires. The
  wall-clock budget becomes "max time WITHOUT a success" (e.g. ~60–90 s since last progress),
  paired with `max_no_progress` rounds (~2–3). A browse that keeps selecting/advancing is never
  killed by it.
- **Absolute hard cap (secondary, never resets):** a generous total ceiling so a pathological
  loop cannot run forever — e.g. ~5 min of total browse wall-clock. This is the *only* absolute
  timer; set it well above any legitimate multi-step form.
- **Parent-delegation deadline (`agent_loop.rs` ~732):** stop using a cumulative
  `max_elapsed_ms − elapsed` (which shrinks and includes curl time). Give the `browse` tool call
  the **absolute hard cap** as its hard deadline; the sub-turn's own stall window is the real
  per-progress control. The parent deadline must not fold in pre-browse (curl) time — measure
  from when the `browse` call starts, not from parent turn start.

Concrete numbers are the plan's to set behind the existing env knobs
(`HOMUN_CHAT_BROWSER_*`), with defaults: stall-window wall-clock ≈ 90 s, `max_no_progress` ≈ 3,
`failed_navigations` ≈ 3–4, absolute hard cap ≈ 300 s. Numbers are tunable; the **shape**
(stall-window-resets-on-progress + large absolute cap, at both levels) is the contract.

## D4 — Make autocomplete selection actually work

- **Non-ARIA fallback in `confirmAutocomplete`** (`actions.ts` ~886): when `inputComboboxInfo`
  reports no ARIA combobox, do NOT return immediately. Fall back to a **geometric/DOM heuristic**:
  after typing, wait briefly (~400–600 ms) for a suggestion list to appear near the focused
  input — `[role=option]`/`[role=listbox]` OR a newly-rendered popup/overlay with clickable rows
  positioned adjacent to the field — and select the best textual match against the typed target
  (reuse the existing scoring in `trySelectFromOpenList`/`selectSuggestion` ~830/~757). If no
  list appears, leave the text (current behaviour) and report `committedOption: undefined`.
  The fallback must be conservative: only act when a plausible suggestion container appears in
  response to *this* type, to avoid mis-clicking unrelated page chrome.
- **Fold the reliable commit into `type`'s automatic path** rather than exposing a new knob a
  weak model must learn: a `type` into a typeahead-ish field automatically does type → wait →
  select-suggestion, and the **action result reports whether a suggestion was selected** (the
  D2 progress signal). Keep the raw-`submit` behaviour available for genuine form submits.
- **Stop `fill` from silently defeating autocomplete:** either route `fill` on a combobox-ish
  input through the same suggestion logic, or make `fill` report `committedOption: undefined`
  and no `structuralChange` so it registers as no-progress (steering the model back to `type`).
  The plan picks the least-surprising option; the contract is that `fill` must not *look* like
  progress when it left a typeahead unselected.
- **One line of prompt guidance** in `browse_subagent_system_prompt` (`main.rs` ~27085): for a
  field that shows suggestions as you type, type the name then pick the matching suggestion
  before moving on. Keep it short and language-neutral (no keyword lists — the model reads
  intent; this is procedural guidance, not lexical matching).

## Invariants that MUST NOT regress

- **Turn engine** (the lifecycle stabilised across prior builds): exactly one assistant bubble
  per `turn_id`, exactly one terminal event, idempotent replay, steering lifecycle
  `pending→claimed→interpreted→applied→completed`. The D3 budget change edits the same
  `run_turn` loop that steering/park live in — every existing `agent_loop` test must stay green;
  the park/resume tests (Build 2) must stay green.
- **Payment gate** (Build 1): `action_class`/machine-floor/fail-closed behaviour is untouched.
  D4's autocomplete selection runs on ordinary fields; it must not change how a floored
  (cc-autocomplete/PSP) ref is gated. A suggestion click still goes through the same
  `browser_act` gate.
- **No lexical intent semantics** ([[no-lexical-semantics-principle]]): progress and autocomplete
  detection use machine signals (URL change, `committedOption`, `structuralDelta`, ARIA/DOM
  geometry), never keyword/label text matching.

## Verification strategy

Engine (`agent_loop`/`config` tests, injected `ModelClient`):
- A browser action that errors/timeouts increments `browser_no_progress` (regression: today it
  resets it). N unproductive re-types in a row trip `max_no_progress` and stop the browse with
  reason `no_progress`, NOT `wall_clock`.
- The wall-clock stall window resets on a real-progress action: a browse that makes progress
  every round runs past the old 90 s absolute ceiling and is bounded only by the absolute hard
  cap; a browse that stalls stops within the stall window.
- The parent-delegation deadline is the absolute cap measured from the `browse` call start, not
  a cumulative that shrinks with prior tool time.
- Park/resume + steering lifecycle tests unchanged and green.

Sidecar (`browser-automation` tests):
- `type` into a non-ARIA typeahead with a rendered suggestion list selects the best match and
  returns `committedOption`; with no list, returns `committedOption: undefined` and does not
  mis-click.
- ARIA combobox path unchanged (existing tests green).
- `fill` on a combobox-ish input does not report progress when nothing was selected.

Installed-app (documented, run by the user): repeat the Trenitalia Naples→Milan search; the
browse selects both stations from the autocomplete, submits, and reads results — or, if it
genuinely stalls, stops on `no_progress` with an honest message, not a mid-form wall-clock
timeout. Confirm a slow model is no longer choked at ~2 rounds.

## Non-goals (this build)

- The manager's curl-first strategy (why it treats the real browser as a last resort) — a
  separate manager-routing concern; this build makes the browser *succeed* when used, which is
  the prerequisite.
- Grant→merchant binding, desktop `turnStreamRecovery` "parked" awareness, and other deferred
  triage items — untouched.
- No change to the payment gate, steering, or park/resume mechanisms.

## Delivery

TDD, per-task review with an adversarial pass on the `run_turn` budget/progress change (the
sensitive lifecycle), a whole-diff review, one commit set, and a build separate from Builds 1–2
for isolated live testing. Then iterate from the live Trenitalia test ("poi testiamo e capiamo").
