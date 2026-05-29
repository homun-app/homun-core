# OpenClaw Browser Port Field Depth Report

Date: 2026-05-28

## Local Flow Map

- Electron chat creates `browser_task` work in `crates/desktop-gateway/src/main.rs`.
- `execute_browser_read_only_task` now routes to `execute_browser_loop_read_only_task` by default when `LOCAL_FIRST_BROWSER_LOOP_CONTROLLER` is enabled.
- The gateway starts `runtimes/browser-automation` as a local stdio sidecar.
- `BrowserLoopRunner` in `crates/browser-automation/src/browser_loop.rs` performs observe -> decide -> act -> observe.
- `RuntimeBrowserLoopPlanner` in `crates/desktop-gateway/src/browser_loop_controller.rs` asks Gemma for one JSON decision at a time.
- The sidecar executes Playwright actions in `runtimes/browser-automation/src/browser/actions.ts` and returns fresh snapshots through `session_manager.ts`.
- Snapshot shaping lives in `runtimes/browser-automation/src/browser/snapshot.ts`.

## Observability And Logging Plan

Existing signals checked: task checkpoints, browser loop iterations, snapshot hashes, action status, sidecar structured errors, fixture tests.

Missing signals: real-site per-step planner prompts/responses are not yet persisted as a compact markdown tasklist artifact.

Minimal instrumentation needed: save redacted planner decisions, action result, snapshot hash and blocked reason per iteration. Do not persist raw page text beyond redacted excerpts.

Missing observability does not block the OpenClaw contract port, but it blocks final claims about Trenitalia/Italo real-site success.

| Signal | Source | Proves | Gap | Action |
| --- | --- | --- | --- | --- |
| Browser loop iteration | Gateway checkpoints | action order and progress | no full planner artifact | persist compact tasklist |
| Snapshot hash | `BrowserLoopRunner` | DOM/page changed after action | no visual diff | add optional screenshot labels |
| Sidecar error code | `actions.ts` | timeout/stale/dialog class | limited real-site taxonomy | extend after failures |
| Planner JSON | Gemma runtime | model decision quality | not durable enough | redact and save per task |

## Primary Hypotheses

1. The old path failed because the runtime mixed agent planning with site-specific heuristics.
Evidence: gateway still had a rigid train executor and keyword-based snapshot pruning.

2. The model lost controls because the planner prompt received pruned snapshots.
Evidence: calendar/dropdown controls can be numeric or generic and were not guaranteed to survive keyword filtering.

3. The sidecar action contract was not OpenClaw-compatible enough.
Evidence: missing canonical `fill`, `select`, `press`, `scrollIntoView`, `clickCoords`, `evaluate`, and efficient snapshots.

## Secondary Bottlenecks

- Gemma may still be too weak for long browser workflows without a stronger planner prompt and memory of plan state.
- Real sites can block headless or require visible browser fallback.
- Autocomplete fields require real typing, not direct fill.
- Batch actions must stay bounded and produce fresh snapshots.
- The UI can still obscure Computer locale details if too verbose.

## Implementation Library Research

OpenClaw inspected locally at `/tmp/openclaw`, MIT licensed. Relevant files:

- `extensions/browser/skills/browser-automation/SKILL.md`
- `extensions/browser/src/browser-tool.schema.ts`
- `extensions/browser/src/browser/routes/agent.act.normalize.ts`
- `extensions/browser/src/browser/pw-role-snapshot.ts`
- `extensions/browser/src/browser/pw-tools-core.snapshot.ts`
- `extensions/browser/src/browser/pw-tools-core.interactions.ts`

Decision: port the contract and methodology, not the full plugin/gateway stack.

## Falsification Checks

- If fixture tests cannot drive autocomplete, calendar, wait and canonical actions, the sidecar port is incomplete.
- If the gateway still uses the old browser executor by default, the architecture change is incomplete.
- If real-site tests still stop after partial fields, inspect saved planner decisions before changing selectors.
- If snapshots do not contain relevant controls, fix snapshot shaping before blaming Gemma.

## Affected Verification Matrix

| Slice | Command or inspection | Proves | Status |
| --- | --- | --- | --- |
| Browser sidecar TS | `npm run typecheck` | TypeScript contract compiles | pass |
| Browser sidecar fixtures | `npm test -- --run` | OpenClaw-style actions and snapshots work locally | pass |
| Browser Rust crate | `cargo test -p local-first-browser-automation -- --nocapture` | loop, policy, executor contracts still pass | pass |
| Desktop gateway planner | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway browser_loop_controller -- --nocapture` | planner JSON contract and validation pass | pass |
| Gateway routing | `rg execute_browser_read_only_task crates/desktop-gateway/src/main.rs` | loop is default browser executor | pass |
| Real browser sites | Trenitalia/Italo via app with Gemma | validates planner capability | pending |
| Docs/memory | `docs/work-memory.md` | durable decision recorded | pass |

## Decision And Next Step

Keep Electron/Rust/Python architecture and port OpenClaw browser methodology into our sidecar/loop. Next step is a real app test through Gemma on direct Trenitalia and direct Italo prompts, with planner decisions persisted so failures identify model, snapshot, or site blocker.

## Durable Memory Updates

Updated `docs/work-memory.md` and `docs/plans/2026-05-28-openclaw-browser-parity.md`.
