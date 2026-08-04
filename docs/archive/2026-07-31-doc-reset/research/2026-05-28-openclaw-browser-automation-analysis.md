# OpenClaw Browser Automation Analysis

Source checked: https://github.com/openclaw/openclaw  
Local clone: `/tmp/openclaw`  
Commit checked: `00fb15253cbdfacec3cd2c34a22ace4d753c6184` (`2026-05-28 08:13:31 +0200`)  
License: MIT

## Local Flow Map

- Plugin entry: `extensions/browser/plugin-registration.ts`
  - Registers a single model-visible tool named `browser`.
  - The tool description teaches the model the operating pattern: use snapshot+act, keep the same `targetId`, prefer `refs="aria"`, do not use blind waits, use `profile="user"` only when cookies/login matter.
- Tool schema: `extensions/browser/src/browser-tool.schema.ts`
  - One flat action schema: `status`, `start`, `tabs`, `open`, `snapshot`, `screenshot`, `navigate`, `act`, `dialog`, `upload`, `pdf`, etc.
  - `act` supports atomic actions: `click`, `type`, `press`, `select`, `fill`, `wait`, `evaluate`, `batch`, `resize`, `close`.
- Browser gateway: `extensions/browser/src/browser/routes/*`
  - HTTP control server exposes `/snapshot`, `/act`, `/navigate`, `/screenshot`, `/tabs`, etc.
  - Routes enforce current URL policy before reading from a tab and post-navigation policy after actions.
- Runtime engine: `extensions/browser/src/browser/pw-tools-core.*`
  - Uses `playwright-core@1.60.0`.
  - Uses Playwright `page.ariaSnapshot({ mode: "ai" })` for AI snapshots when available.
  - Stores refs from snapshots and restores them before actions.
- Ref model: `extensions/browser/src/browser/pw-role-snapshot.ts` and `pw-session.ts`
  - AI snapshots preserve Playwright refs like `e13`.
  - `refLocator()` resolves refs through `aria-ref=e13` when refs mode is `aria`.
  - Fallback role refs resolve via `getByRole(role, { name, exact: true })` plus `nth` for duplicates.
- Sandbox computer: `src/agents/sandbox/browser.ts`
  - Optional Docker browser container with CDP and noVNC.
  - Can expose a visible browser desktop while keeping automation local.
- Agent loop: `packages/agent-core/src/agent-loop.ts`
  - The model calls tools, receives tool results, then continues the same loop.
  - There is no separate hardcoded "fill Trenitalia" executor in the core path.

## Key OpenClaw Patterns

1. Browser is a single model-visible tool, not many independent browser tools.

   This matters because the model sees one coherent contract. It learns that
   `snapshot` precedes `act`, and that refs/target ids must stay paired. Our
   capability layer currently exposes multiple lower-level methods and the
   desktop gateway still contains task-specific browser logic.

2. Snapshot is the source of truth.

   OpenClaw's browser automation skill says: read before click, use the same
   target, act with refs from the latest snapshot, then snapshot again after
   navigation/modal/form changes. That matches Homun's working pattern.

3. Ref stability is delegated to Playwright/CDP instead of our own DOM labels.

   OpenClaw uses Playwright's AI aria snapshot and `aria-ref` locator support.
   Our current sidecar builds its own snapshot from DOM/accessibility-like data
   and then classifies fields. That is why custom widgets such as Trenitalia
   date/time buttons and Italo station widgets are fragile.

4. Existing-session and managed-browser paths are separated.

   OpenClaw has:
   - managed OpenClaw browser profile;
   - existing user browser profile via Chrome MCP;
   - sandbox browser bridge for containerized runs.

   For us the useful part is not Chrome MCP itself. The useful part is the
   abstraction: profile/capability decides which driver can execute which
   action, and unsupported actions fail with explicit guidance.

5. The gateway enforces safety around every action.

   `agent.act.ts` checks unsupported actions for existing sessions, current URL
   policy, post-interaction navigation, new tabs, dialog blockers and evaluate
   permissions. This is stronger than our current "is this click safe" checks
   because it observes effects after the action.

6. Tool output is wrapped as untrusted external content.

   Snapshot/console/tabs results are wrapped before entering the model context.
   This is important for prompt-injection hygiene. We have redaction/audit
   pieces, but browser snapshots should be explicitly marked as untrusted tool
   content in the Brain context.

7. Visible computer is an observer surface, not the automation primitive.

   OpenClaw can expose noVNC for the sandbox browser. The agent still acts via
   CDP/Playwright. For our UI this supports the "Computer locale" design:
   thumbnail/live view is for user trust and debugging; actions still go through
   the controlled browser API.

## Why Our Current Flow Still Breaks

Our current train executor does this shape:

1. Create deterministic task plan.
2. Open source.
3. Build field list from a snapshot.
4. Run a batch `fill_form`.
5. Try source-specific extraction.

That can work on simple HTML forms and TrovaTreno direct URLs, but it fails on
modern travel sites because the page state changes after every action:

- station fields create autocomplete state;
- date/time are custom buttons/widgets, not plain inputs;
- Italo exposes visible form text without reliable textbox refs in our snapshot;
- click/search may create navigation or dynamic results that need a fresh
  snapshot before the next decision.

OpenClaw and Homun do not solve this with more regex. They solve it with an
action loop:

```text
goal -> snapshot -> decide one narrow action -> act -> snapshot -> verify -> next action
```

The important missing piece in our project is therefore not another
`browser_form_fields_for_snapshot()` heuristic. It is a browser action loop
that lets the Brain/tool controller decide from the current page after every
state transition.

## What To Borrow

Borrow architecture and selected implementation ideas, not whole files.

- Use one high-level browser capability contract for the Brain:
  - `browser.status`
  - `browser.open`
  - `browser.snapshot`
  - `browser.act`
  - `browser.screenshot`
  - `browser.tabs`
  - `browser.dialog`
- Move source-specific train logic out of `desktop-gateway/src/main.rs`.
- Add Playwright AI snapshot mode to `runtimes/browser-automation`.
  - Prefer `page.ariaSnapshot({ mode: "ai" })`.
  - Preserve `eN` refs.
  - Resolve actions via `aria-ref=eN`.
  - Keep role/name fallback for browsers/pages where `aria-ref` fails.
- Store refs per `targetId`/tab, and restore them before action.
- Add explicit post-action state:
  - current URL;
  - target id after navigation;
  - blocked dialog state;
  - new tab detection;
  - screenshot/artifact id when requested.
- Add a Browser Operating Loop in Rust:
  - plan step;
  - last snapshot;
  - selected action;
  - expected observation;
  - retry/stale-ref recovery;
  - stop condition.
- Keep approvals at semantic gates:
  - domain access: once/always;
  - visible/headless/auto;
  - submit/search allowed;
  - login/personal data/payment/acquisition always separate.

## What Not To Borrow

- Do not import OpenClaw's full plugin/runtime system.
- Do not use Chrome MCP as the first path. Our sidecar can stay
  Playwright-first.
- Do not add Docker/noVNC before the browser action loop works. The UI preview
  is useful, but it will not fix task completion.
- Do not hide this behind site-specific train adapters as the main solution.
  Site adapters may be useful later, but the generic loop must exist first.

## Proposed Local Implementation Sequence

1. `runtimes/browser-automation`: add `snapshot_format: "ai"` and
   `refs_mode: "aria"`.
   - Use Playwright `page.ariaSnapshot({ mode: "ai" })` when available.
   - Return `{ snapshot, refs, stats, target_id, url }`.
   - Test that a fixture button/input ref can be clicked/filled via `aria-ref`.

2. `runtimes/browser-automation`: replace our ref resolver with a two-mode
   resolver.
   - `aria`: `page.locator("aria-ref=eN")`.
   - `role`: current role/name fallback.
   - Test stale ref guidance: old ref fails with "snapshot again" message.

3. `crates/browser-automation`: formalize `BrowserObservation` and
   `BrowserActionResult`.
   - Include snapshot hash, URL, target id, dialogs, artifacts, blocked reason.

4. `crates/desktop-gateway`: create `browser_loop` module.
   - Input: operational plan + current task.
   - Output: step status updates + final extracted data.
   - The gateway no longer hardcodes per-source form fill inside `main.rs`.

5. Brain/controller integration.
   - For each step, give the model compact current snapshot + allowed actions.
   - Require JSON action decision.
   - Validate action against policy before executing.
   - Snapshot again after each action.

6. Tests before real sites.
   - Fixture with custom station autocomplete.
   - Fixture with date/time as buttons opening popovers.
   - Fixture with search results rendered after async click.
   - Fixture with modal/cookie banner.
   - End-to-end "train booking simulation" that must produce options and stop
     before purchase.

## Observability Needed

Each browser loop iteration should persist a compact event:

```json
{
  "iteration": 3,
  "step_id": "source_trenitalia_date",
  "url_before": "...",
  "snapshot_hash_before": "...",
  "action": {"kind": "click", "ref": "e42", "label": "28 Mag 2026"},
  "policy": "allowed",
  "url_after": "...",
  "snapshot_hash_after": "...",
  "observation": "calendar opened",
  "status": "done"
}
```

The UI should show only the readable step summary by default. The full
iteration log stays in Computer locale / artifact.

## Falsification Checks

| Claim | What would falsify it | Check |
| --- | --- | --- |
| Our main blocker is snapshot/action architecture, not model quality | A deterministic fixture with autocomplete/date widgets passes with current batch fill | Add fixture and run current executor |
| Playwright AI snapshot improves custom widget handling | The same fixture exposes no usable `aria-ref` controls | Add sidecar AI snapshot test |
| Browser loop improves real sites | Trenitalia/Italo still fail at same point after action->snapshot loop | Run real prompt with iteration artifact |
| Need Electron/noVNC is secondary | Visible browser does not change extraction success | Compare headless vs visible with same browser loop |

## Decision

The next browser task should not add more site-specific filling logic. It should
move us toward the OpenClaw/Homun operating loop:

- Playwright AI snapshot + aria refs;
- one browser action at a time;
- fresh snapshot after every action;
- Brain/controller chooses next action from current observation;
- deterministic policy validates before execution;
- completion only when success criteria are met.

This is the smallest path that addresses the user's actual complaint: "se non
fa un piano e non sa seguire il piano non fara' mai nulla".

## Implementation Notes Added Locally

Implemented from the OpenClaw pattern on 2026-05-28:

- `runtimes/browser-automation` supports Playwright AI snapshots with
  `urls=true`, appending visible links to the snapshot for navigation
  disambiguation.
- AI snapshot ref parsing accepts arbitrary Playwright refs, not only `eN`.
- `crates/browser-automation::BrowserLoopRunner` detects no-progress iterations
  by comparing URL and snapshot hash before/after each action.
- The runner stops after repeated no-progress actions instead of burning all
  iterations on the same stale or ineffective action.
- `crates/desktop-gateway::RuntimeBrowserLoopPlanner` exposes `fill_form` as a
  first-class allowed action and validates every field against current snapshot
  refs.
- The controller prompt tells the model to use `fill_form` for visible
  multi-field forms and to change strategy after a `no_progress` iteration.
- `BrowserLoopRunner` exposes per-iteration observer callbacks; the desktop
  gateway now persists Computer locale checkpoints as the loop runs, not only
  after the whole source finishes.

Verified with:

- `npm run typecheck` in `runtimes/browser-automation`;
- `npm test -- --run` in `runtimes/browser-automation`;
- `cargo test -p local-first-browser-automation --test browser_loop -- --nocapture`;
- `cargo test -p local-first-desktop-gateway browser_loop_controller -- --nocapture`;
- `cargo test -p local-first-desktop-gateway train -- --nocapture`.
