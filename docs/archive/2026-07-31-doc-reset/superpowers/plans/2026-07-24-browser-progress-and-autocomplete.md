# Browser Progress, Budget-Resets-on-Success, Autocomplete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the browse sub-turn reach its goal on slow models by (1) defining *real* browser progress from machine signals instead of prose, (2) making the wall-clock budget a per-progress stall window (resets on success) with a large absolute cap at both budget levels, and (3) making autocomplete selection actually work on non-ARIA typeaheads.

**Architecture:** Bottom-up across three layers. The sidecar (TS/Playwright) already returns `committedOption`/`suggestions` and computes `structuralDelta`; we (T1) make `confirmAutocomplete` work on non-ARIA typeaheads and stop `fill` from faking progress. We (T2) widen the `BrowserExecutor::execute_browser` seam to return a `ToolOutcomeHint` alongside the text (the trait doc already flags this as the intended extension). The gateway (T3) computes that hint from the sidecar's machine signals per the D2 progress definition, and adds one line of typeahead guidance to the browse prompt. The engine (T4) turns the wall-clock into a stall window that resets on real progress, adds an absolute cap, and fixes the cumulative parent-delegation deadline.

**Tech Stack:** Rust (Cargo workspace: `crates/engine`, `crates/desktop-gateway`), TypeScript + Playwright (`runtimes/browser-automation`). Tests: `cargo test -p local-first-engine`, `cargo test -p local-first-desktop-gateway`, sidecar vitest.

## Global Constraints

- **No lexical intent semantics.** Progress and autocomplete detection use machine signals only (URL change, `committedOption`, `structuralDelta`/`no_change`, ARIA/DOM geometry). Never keyword/label matching. (`[[no-lexical-semantics-principle]]`)
- **Turn-engine invariants must not regress:** exactly one assistant bubble per `turn_id`, exactly one terminal event, idempotent replay, steering lifecycle `pending→claimed→interpreted→applied→completed`, park/resume (Build 2). Every existing `cargo test -p local-first-engine` test stays green.
- **Payment gate (Build 1) untouched:** `action_class` / machine-floor / fail-closed behaviour unchanged; a suggestion click still goes through the same `browser_act` gate.
- **`LoopState` is serialized into checkpoints** — do NOT add an `Instant` field to it. Per-progress timing lives as a `run_turn` local, like `turn_started_at`.
- Comments in English; match surrounding density. Commit directly to the branch; NO `Co-Authored-By` trailer.
- Line numbers below age on every edit — re-grep the named symbol before editing.

---

### Task 1: Sidecar — non-ARIA autocomplete fallback + `fill` doesn't fake progress (D4)

**Files:**
- Modify: `runtimes/browser-automation/src/browser/actions.ts` — `confirmAutocomplete` (~886), `inputComboboxInfo` (~705), the `fill`/`fillFormField` path (~268/~597).
- Test: add a fixture-based test under `runtimes/browser-automation/tests/` following `structural_delta.test.ts` / `browser_fixture.test.ts` (real Playwright page over an inline HTML fixture).

**Interfaces:**
- Produces: `confirmAutocomplete` still returns `{ committed?: string; options: string[] }`; the `type` handler (~330) already surfaces `committedOption`/`suggestions` — unchanged signature.

- [ ] **Step 1: Write the failing test.** Serve an inline HTML fixture with a **non-ARIA** typeahead: a plain `<input id="station">` and a JS `input` listener that, on typing, renders `<div class="suggest"><div class="opt">Napoli Centrale</div><div class="opt">Napoli Campi Flegrei</div></div>` positioned below the input (NO `role`/`aria-*`/`list` on the input). Drive a `type` action with text `"Napoli Centrale"` and assert the result has `committedOption === "Napoli Centrale"` (today it is `undefined` because `confirmAutocomplete` bails on non-ARIA). Add a second fixture with NO suggestion list and assert `committedOption === undefined` and the field still holds the typed text (no misfire).

- [ ] **Step 2: Run it, confirm it fails** (`committed` is `undefined` on the non-ARIA fixture). Run the sidecar test the same way the other `tests/*.test.ts` run (see `package.json`/`vitest` config in `runtimes/browser-automation`).

- [ ] **Step 3: Implement the non-ARIA fallback in `confirmAutocomplete`.** Replace the early `if (!isCombobox) return { options: [] }` bail (~893) with a conservative fallback path. When `!isCombobox`, build a NON-ARIA option locator restricted to *plausible suggestion rows that appeared in response to this type* and reuse the existing `trySelectFromOpenList` with a **stricter** match gate. Concretely:
  - Non-ARIA option locator: `page.locator('[role="option"], [role="listbox"] *:not([role="listbox"]), ul[class*="suggest" i] li, ul[class*="auto" i] li, [class*="suggestion" i]:not(:has(*)), [class*="typeahead" i] li, [class*="dropdown" i] li').locator('visible=true')` — a bounded, visible-only set. Keep `MAX_SUGGESTIONS` cap.
  - Call `trySelectFromOpenList(page, input, nonAriaOptionLocator, typed, timeout)` but require a **strong** match before committing: only commit when the best option's score is `>= 3` (exact or option-startsWith-target) OR there is exactly one visible option AND it contains the target. (Add a `minScore` parameter to `trySelectFromOpenList`, defaulting to `1` so the ARIA path is unchanged; pass `3` from the non-ARIA fallback.) On no list / weak match, return `{ options }` and leave the full typed text — current behaviour.
  - Keep the whole existing ARIA path (when `isCombobox`) byte-for-byte unchanged.

- [ ] **Step 4: Make `fill` not fake progress.** In the `fill`/`fillFormField` path (~268/~597), after `locator.fill(value)`, if the target input is combobox-ish (reuse `inputComboboxInfo` OR the same non-ARIA suggestion probe), do NOT report a committed selection: return the result with `committedOption: undefined` (and let T3 classify a `fill` that opened but did not resolve a suggestion as no-progress). Do not attempt selection on `fill` (its contract is "set the value directly") — the point is only that `fill` must not *look* like a completed typeahead.

- [ ] **Step 5: Run the tests, confirm pass** (non-ARIA fixture now commits "Napoli Centrale"; no-list fixture leaves text and commits nothing; ARIA fixtures from existing tests still pass).

- [ ] **Step 6: Commit** (`git add runtimes/browser-automation/... && git commit -m "fix(browser): select from non-ARIA autocomplete instead of leaving text"`).

---

### Task 2: Engine — widen the `execute_browser` seam to carry a machine outcome (D1)

**Files:**
- Modify: `crates/engine/src/contract.rs` — `BrowserExecutor::execute_browser` (~262), and the in-file test impl (~525).
- Modify: `crates/engine/src/agent_loop.rs` — the browser-granular branch (~710), and the four in-file mock impls (~1674, ~1739, ~1945, ~2018).
- Test: extend an existing `agent_loop.rs` `#[cfg(test)]` test (mock `BrowserExecutor`).

**Interfaces:**
- Produces: `execute_browser` returns `impl Future<Output = (String, ToolOutcomeHint)>` (was `String`). `ToolOutcomeHint` is the existing enum (`Success | NoProgress`, `contract.rs:153`). The gateway impl (T3) supplies the real hint; every test/mock impl returns `(text, ToolOutcomeHint::Success)` to preserve today's behaviour.

- [ ] **Step 1: Write the failing test.** In `agent_loop.rs` tests, add a mock `BrowserExecutor` whose `execute_browser` returns `("Action failed: type timed out".into(), ToolOutcomeHint::NoProgress)`. Run a turn where the model calls a browser tool once; assert `ls.browser_no_progress == 1` afterward (today it is `0` because the branch discards the hint and prose classifies as success). Use the existing test scaffolding (mock `ModelClient`, `TurnConfig` with a browser budget) already present around the other `execute_browser` mock impls.

- [ ] **Step 2: Run it, confirm it fails** (`browser_no_progress` is `0`). Run: `cargo test -p local-first-engine <new_test_name> -- --nocapture`.

- [ ] **Step 3: Widen the trait** (`contract.rs:262`): change the return type to `impl Future<Output = (String, crate::contract::ToolOutcomeHint)> + Send`, and update the doc comment (drop the "bare String, not ToolOutcome" note — it now carries a hint). Update the in-file test impl (~525) to return `(…, ToolOutcomeHint::Success)`.

- [ ] **Step 4: Use the hint in the branch** (`agent_loop.rs:710`): destructure `let (r, hint) = browser_executor.execute_browser(...)` and build the tuple as `(r, ToolEffects { outcome_hint: Some(hint), ..ToolEffects::default() }, interrupted)` instead of `ToolEffects::default()`. Leave the downstream outcome computation (~800) and the browser-granular stalled calc (~844) unchanged — they already read `outcome_hint` first.

- [ ] **Step 5: Update the four mock impls** (`agent_loop.rs` ~1674/~1739/~1945/~2018) to return `(text, ToolOutcomeHint::Success)` except the new no-progress mock from Step 1.

- [ ] **Step 6: Run tests, confirm pass** and that the whole engine suite is green: `cargo test -p local-first-engine`. Expected: new test passes, all prior tests still green (park/resume, steering).

- [ ] **Step 7: Commit** (`git commit -m "feat(engine): browser executor returns a machine outcome hint"`). NOTE: the gateway impl won't compile until T3; if landing T2 alone breaks the workspace build, land T2+T3 as one commit — the reviewer is told they are compile-coupled.

---

### Task 3: Gateway — compute the outcome hint from machine signals + typeahead prompt line (D1/D2/D4)

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` — the gateway's `BrowserExecutor::execute_browser` impl and the `browser_act` result-build block (~23280 success path; the "Action failed" error paths ~23367/~23418; navigation at ~19724/~23278) so the impl returns `(String, ToolOutcomeHint)`; `browse_subagent_system_prompt` (~27085).
- Test: a pure classification helper with `#[cfg(test)]` unit tests (mirror `browser_safety.rs` test style).

**Interfaces:**
- Consumes: the sidecar response `value: serde_json::Value` with `ok`, `committedOption`, `suggestions`, and the existing `no_change`/`snap`/navigation success already computed in this block; `args.kind`.
- Produces: a `fn browser_action_outcome_hint(kind: &str, ok: bool, no_change: bool, committed_option: bool, navigated_ok: bool, errored: bool) -> ToolOutcomeHint` (pure, unit-tested), used to build the impl's `(text, hint)` return.

- [ ] **Step 1: Write the failing test** for the pure helper. Cases (per D2):
  - `("type", ok=true, no_change=false, committed_option=false, …)` → `NoProgress` (typed but selected nothing — the "Napoli ×3" case).
  - `("type", ok=true, committed_option=true, …)` → `Success`.
  - `(any, errored=true)` → `NoProgress` (timeout/failed).
  - `("click", ok=true, no_change=true, …)` → `NoProgress` (page did not change).
  - `("navigate", navigated_ok=true, …)` → `Success`.
  - `("fill", ok=true, committed_option=false, no_change=false, …)` → `NoProgress` (fill left a typeahead unresolved).
  - `("click", ok=true, no_change=false, …)` → `Success`.

- [ ] **Step 2: Run it, confirm it fails** (function undefined). Run: `cargo test -p local-first-desktop-gateway browser_action_outcome_hint -- --nocapture`.

- [ ] **Step 3: Implement the helper.**
```rust
/// Machine classification of a browser action's progress — the D2 contract. NOT prose,
/// NOT label text: the guarded loop's stall/no-progress accounting depends on this
/// distinguishing a goal-advancing action from a no-op re-type or a failure.
fn browser_action_outcome_hint(
    kind: &str,
    ok: bool,
    no_change: bool,
    committed_option: bool,
    navigated_ok: bool,
    errored: bool,
) -> local_first_engine::contract::ToolOutcomeHint {
    use local_first_engine::contract::ToolOutcomeHint::{NoProgress, Success};
    if errored || !ok {
        return NoProgress;
    }
    match kind {
        "navigate" => if navigated_ok { Success } else { NoProgress },
        // A typeahead that did not resolve to a selected suggestion is not progress,
        // even though the input's own text changed (that is why `no_change` alone is
        // insufficient — typing always changes the snapshot).
        "type" | "fill" => if committed_option { Success } else { NoProgress },
        // Any other action: progress iff it changed the page.
        _ => if no_change { NoProgress } else { Success },
    }
}
```

- [ ] **Step 4: Wire it into the impl.** In the success result-build block (~23280) compute `committed_option = value.get("committedOption").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty())`, reuse the existing `no_change`, derive `navigated_ok` for the navigate arm, then set the impl's returned hint via `browser_action_outcome_hint(kind, ok, no_change, committed_option, navigated_ok, false)`. In the two error paths (~23367/~23418, "Action failed") return the text with `NoProgress`. Every exit of the gateway `execute_browser` impl now returns `(text, hint)`.

- [ ] **Step 5: Add ONE line of typeahead guidance** to `browse_subagent_system_prompt` (~27085), appended to the METHOD list, language-neutral, no keyword lists:
  > "When a field shows suggestions as you type, type the name and then pick the matching suggestion before moving on — a typed value with no suggestion selected is usually not accepted."

- [ ] **Step 6: Run tests, confirm pass**: `cargo test -p local-first-desktop-gateway browser_action_outcome_hint` and the crate's browser tests. Confirm the workspace builds with T2 (`cargo build --workspace`).

- [ ] **Step 7: Commit** (`git commit -m "feat(gateway): classify browser progress from machine signals; guide typeahead"`).

---

### Task 4: Engine — stall-window budget that resets on progress + absolute cap + parent-deadline fix (D3)

**Files:**
- Modify: `crates/engine/src/config.rs` — `BrowserBudget` (~31), `BrowserStopReason` (~14), `stop_reason` (~38).
- Modify: `crates/engine/src/agent_loop.rs` — the wall-clock check (~270), the progress-reset point (~853), the parent-delegation deadline (~732).
- Modify: `crates/desktop-gateway/src/main.rs` — the browse sub-turn `TurnConfig.browser_budget` (~27424) and `chat_browser_budget()` (~18028) to supply the new field.
- Test: `config.rs` unit test + an `agent_loop.rs` test.

**Interfaces:**
- Produces: `BrowserBudget { max_elapsed_ms, max_stall_ms, max_failed_navigations, max_no_progress }` (new `max_stall_ms`); `stop_reason(elapsed_ms, stall_ms, failed_navigations, no_progress)` (new `stall_ms` param); `BrowserStopReason::Stall`.

- [ ] **Step 1: Write the failing config test.** In `config.rs` tests: a budget `{ max_elapsed_ms: 300_000, max_stall_ms: 90_000, max_failed_navigations: 3, max_no_progress: 3 }`. Assert: `stop_reason(100_000, 10_000, 0, 0) == None` (100 s elapsed but only 10 s since progress → keep going — the regression case: a progressing browse past the old 90 s ceiling survives); `stop_reason(100_000, 90_001, 0, 0) == Some(Stall)`; `stop_reason(300_001, 0, 0, 0) == Some(WallClock)` (absolute cap); `stop_reason(1_000, 1_000, 3, 0) == Some(FailedNavigations)`.

- [ ] **Step 2: Run it, confirm it fails** (signature mismatch / `Stall` undefined). Run: `cargo test -p local-first-engine config -- --nocapture`.

- [ ] **Step 3: Implement the config change.** Add `Stall` to `BrowserStopReason` (`as_str` → `"stall"`). Add `max_stall_ms: u64` to `BrowserBudget`. New `stop_reason`:
```rust
pub fn stop_reason(self, elapsed_ms: u64, stall_ms: u64, failed_navigations: u32, no_progress: u32) -> Option<BrowserStopReason> {
    if elapsed_ms >= self.max_elapsed_ms { Some(BrowserStopReason::WallClock) }        // absolute cap, never resets
    else if stall_ms >= self.max_stall_ms { Some(BrowserStopReason::Stall) }           // resets on real progress
    else if failed_navigations >= self.max_failed_navigations { Some(BrowserStopReason::FailedNavigations) }
    else if no_progress >= self.max_no_progress { Some(BrowserStopReason::NoProgress) }
    else { None }
}
```

- [ ] **Step 4: Write the failing engine test.** Assert that a browse making a *progress* action (`ToolOutcomeHint::Success`) every round runs past `max_stall_ms` worth of wall-clock (i.e. is NOT stopped by the old absolute-from-start ceiling), and that a browse returning `NoProgress` every round stops with reason `Stall`/`NoProgress` within the window. Reuse the mock-executor scaffolding from T2.

- [ ] **Step 5: Implement the engine change.**
  - Add a `run_turn` local next to `turn_started_at` (~244): `let mut last_browser_progress_at = std::time::Instant::now();`.
  - At the progress-reset point (~853, the `else { ls.browser_no_progress = 0; }` branch), also set `last_browser_progress_at = std::time::Instant::now();`. (This is the D2 "success" point.)
  - At the wall-clock check (~270), compute `let stall_ms = u64::try_from(last_browser_progress_at.elapsed().as_millis()).unwrap_or(u64::MAX);` and call `cfg.browser_budget.stop_reason(elapsed_ms, stall_ms, ls.browser_failed_navigations, ls.browser_no_progress)`. Keep emitting `browser_budget_exceeded:{reason}` (now possibly `stall`).
  - At the parent-delegation deadline (~732): replace `remaining = max_elapsed_ms − turn_started_at.elapsed()` with a fresh absolute-cap timer for this browse call: `let browser_deadline = tokio::time::sleep(std::time::Duration::from_millis(cfg.browser_budget.max_elapsed_ms));` (starts now → the `browse` call gets the full absolute cap from call start, no cumulative shrink, no curl-time inclusion). The sub-turn's own stall window remains the per-progress control.

- [ ] **Step 6: Set the numbers.** In the browse sub-turn `TurnConfig` (`main.rs` ~27424): `max_elapsed_ms: 300_000` (absolute cap), `max_stall_ms: 90_000` (stall window — the old 90 s becomes "90 s WITHOUT progress"), `max_failed_navigations: 4`, `max_no_progress: 3`. In `chat_browser_budget()` (`main.rs` ~18028) add `max_stall_ms` (env `HOMUN_CHAT_BROWSER_MAX_STALL_MS`, clamp `1_000..=600_000`, default `120_000`). Update every other `BrowserBudget { … }` literal in `main.rs` (grep `BrowserBudget {`) and any `crates/*/src` construction to include `max_stall_ms` so the workspace compiles.

- [ ] **Step 7: Run tests, confirm pass** and the whole engine suite green: `cargo test -p local-first-engine` (esp. park/resume + steering unchanged), then `cargo build --workspace`.

- [ ] **Step 8: Commit** (`git commit -m "feat(engine): browser wall-clock is a stall window that resets on progress, plus an absolute cap"`).

---

## Self-Review

**Spec coverage:**
- D1 (structured outcome vs prose) → T2 (seam) + T3 (gateway computes hint). ✓
- D2 (progress definition) → T3 `browser_action_outcome_hint` + T4 uses `browser_no_progress`. ✓
- D3 (two-tier budget, resets on success, both levels) → T4 (config + engine + numbers + parent deadline). ✓
- D4 (non-ARIA autocomplete + fold into `type` + prompt + `fill`) → T1 (sidecar) + T3 Step 5 (prompt). The "expose affordance" sub-point is satisfied because `type` already calls `confirmAutocomplete` automatically (verified `actions.ts:325`); no schema knob needed. ✓
- Invariants (turn engine, payment gate, no lexical semantics) → Global Constraints + T4 runs the full engine suite. ✓

**Placeholder scan:** none — every code step shows the code/logic; test steps name concrete cases. Sidecar test harness code is described against the existing `tests/*.test.ts` fixtures the implementer reads (their exact helper names live in those files).

**Type consistency:** `ToolOutcomeHint` (Success|NoProgress) used identically in T2/T3; `execute_browser` returns `(String, ToolOutcomeHint)` in T2 and every impl in T2/T3; `BrowserBudget.max_stall_ms` + `stop_reason(…, stall_ms, …)` defined in T4 Step 3 and used in T4 Step 5/6; `browser_action_outcome_hint` signature identical in T3 Step 3 and Step 4.

**Note for execution:** T2 and T3 are compile-coupled (the gateway impl must match the widened trait). If landing separately breaks `cargo build --workspace`, land T2+T3 as one commit. T4 is the turn-engine-sensitive task → adversarial review.
