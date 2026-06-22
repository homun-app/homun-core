# OpenClaw Browser Parity Plan

Date: 2026-05-28

## Goal

Bring the browser automation runtime to OpenClaw-style reliability while keeping
the project local-first, simpler than Homun, and integrated with our Rust task
runtime and Electron UI.

## Scope

- Browser contract parity for the actions we actually need now.
- Deterministic observe/act/verify loop.
- Real-time Computer locale checkpoints.
- Robust form handling for autocomplete/date/time/search flows.
- Safe completion criteria and explicit blockers.

## Non-Scope

- Copying the whole OpenClaw plugin architecture.
- Cloud browser execution.
- Payment/login/personal-data automation without explicit gates.
- Docker/noVNC until the Playwright loop is reliable.

## Current State

Implemented:

- Playwright AI snapshots with aria refs.
- `urls=true` snapshot links.
- `fill_form` action contract exposed to the planner.
- Ref validation against the current snapshot.
- Snapshot-after-action behavior in the sidecar.
- No-progress guard in the Rust browser loop.
- Live per-iteration checkpoints in the desktop gateway.
- OpenClaw-style sidecar primitives: `hover`, `scroll_into_view`, richer
  bounded `wait`, and guarded `batch`.
- Normalized action timeout/stale/dialog errors in the sidecar.
- Rust policy handling for observation-only actions and batch approval
  inheritance.
- Stale-ref recovery in the Rust loop: snapshot fresh, record the event, and
  continue with current refs instead of repeating blindly.
- Train-search fixture that completes cookie acceptance, station autocomplete,
  date selection, time selection, search click, async wait and result
  extraction.
- Common cookie/consent overlay preflight in the sidecar, including OneTrust
  selectors that can block pointer events without appearing as useful AI refs.
- Automatic assistant-profile fallback from headless to visible for
  protocol/connection failures that indicate headless blocking. The open result
  reports `fallbackFromHeadless`.
- OpenClaw-compatible canonical action names in the sidecar:
  `clickCoords`, `fill`, `press`, `select`, `scrollIntoView`, `evaluate`,
  `resize`, `close`, and guarded `batch`, while preserving legacy aliases.
- Efficient interactive snapshots (`mode=efficient`, `interactive`, `compact`,
  `depth`) derived from Playwright AI snapshots so the model sees actionable
  controls without keyword-based pruning.
- The desktop gateway now routes browser tasks through the observe/act browser
  loop by default when `HOMUN_BROWSER_LOOP_CONTROLLER` is enabled; the
  old rigid read-only executor is fallback only.
- Browser loop prompt switched to an OpenClaw-style contract and no longer
  relies on train-specific controller actions.
- Browser loop planner now supports context ablation through
  `HOMUN_BROWSER_CONTEXT_PROFILE=full|compact|minimal`. The default
  `compact` profile builds a budgeted action frame instead of passing a raw
  snapshot prefix, preserving relevant refs, goal matches and recent failure
  memory.
- Smoke benchmark recorded in
  `output/gemma4-browser-context-smoke-20260528-193119/result.md`: `compact`
  reduced average prompt size from 16,177 to 8,666 chars while keeping planner
  JSON parseable in 4/4 decisions. `minimal` was smaller but less grounded.

Still missing:

- stable tab hygiene and target reuse;
- dialog blocker surface;
- real-site validation on Trenitalia and ItaloTreno with the new loop and
  Gemma planner.
- full end-to-end A/B/C context ablation after the current sidecar
  `BROWSER_TAB_NOT_FOUND` lifecycle failure is fixed.

## Implementation Sequence

1. Browser sidecar contract hardening
   - Normalize action schema closer to OpenClaw.
   - Add bounded timeouts to actions.
   - Add `hover`, `scrollIntoView`, `batch`, richer `wait`.
   - Return normalized action errors: stale ref, timeout, dialog, navigation
     blocked, unsupported action.

2. Controller recovery rules
   - If stale ref: snapshot same target, retry once with fresh ref.
   - If no progress: do not repeat same action/ref/hash; require strategy
     change or blocker.
   - Cookie/banner preflight before field entry.
   - Use canonical `fill` for visible multi-field forms.

3. Fixture parity tests
   - Cookie banner before form.
   - Autocomplete station fields.
   - Date picker and time picker.
   - Search button producing delayed results.
   - Result extraction stops before purchase/login.

4. Real-site validation
   - Prompt directly for Trenitalia.
   - Prompt directly for ItaloTreno.
   - Compare Computer locale checkpoints with expected plan.
   - Do not mark success without extracted options.

5. UI/observability polish
   - Show concise current step while running.
   - Collapse Computer locale after final answer.
   - Keep full iteration artifact available.

## Verification Commands

```bash
npm run typecheck
npm test -- --run
cargo test -p local-first-browser-automation --test browser_loop -- --nocapture
cargo test -p local-first-desktop-gateway browser_loop_controller -- --nocapture
cargo test -p local-first-desktop-gateway train -- --nocapture
HOMUN_BROWSER_CONTEXT_PROFILE=compact cargo test -p local-first-desktop-gateway browser_loop_controller -- --nocapture
git diff --check
```

## Acceptance Criteria

- The loop never repeats the same ineffective browser action until max
  iterations.
- Every action is tied to the latest snapshot or explicitly recovered after a
  stale-ref failure.
- Computer locale shows live progress during the loop.
- For train tasks, the chat answer contains real extracted options or a clear
  blocker, never a claimed search without results.
- Direct Trenitalia and ItaloTreno prompts reach a stable result or a precise
  blocker with the step where the site stopped us.
