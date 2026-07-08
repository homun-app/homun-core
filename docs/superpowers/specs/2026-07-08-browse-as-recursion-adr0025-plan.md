# ADR 0025 — browse-as-recursion: execution plan (2026-07-08)

Follows the completed ADR 0024 (motore #1 extracted into `engine::agent_loop::run_turn`, generic over
the seams). ADR 0025 makes the browser a **delegated sub-agent** `browse(goal) → BrowseResult`: the
manager (the strong model, the one guarded loop) stays the driver for the whole turn and calls the
browser as ONE encapsulated capability. Internally `browse` is **the same `run_turn`, invoked
recursively** with a browser-only toolset, the browser model, and an ISOLATED `LoopState`.

## Why 0024 makes this tractable

`run_turn<M, C, B, P, J, K, Pol, E>` is already generic over its seams. `browse` runs GATEWAY-side: it
builds a sub-set of browser seams (ModelClient = browser model, CapabilityExecutor = browser-only,
fresh isolated `LoopState`) and calls `engine::run_turn(...)`. The engine knows nothing about
recursion — the gateway orchestrates `run_turn → execute_tool(browse) → run_turn(sub)`. It terminates
at the TYPE level: the sub-turn's CapabilityExecutor is a different type (browser-only, no nested
`browse`), so it's a distinct monomorphization — no infinite recursion. The isolated `LoopState` is
what eliminates the marker-flood / context pollution on the main path — by construction, not by patch.

## Design decisions (the ADR's open questions, resolved SOTA)

1. **`browse` granularity:** per informational NEED (often = one plan step). The sub-loop navigates N
   pages internally for ONE goal, with its own nav budget. The manager issues one `browse` per need.
2. **Stop condition:** the sub-loop's normal Observe/Verify (the browser model decides "goal reached →
   extract → return") + a budget backstop (nav-cap → best-effort `found=false`). No ad-hoc halting
   machine. `found`/`confidence` = the sub-model's self-assessment.
3. **Retries:** the MANAGER (capable model) refines the goal and re-issues `browse`, max 2, then marks
   the step `blocked`. The F2 verification lives here — the right place.
4. **Runtime:** in-process (recursive `run_turn` call), coherent with ADR 0021 (one engine).

## The tool the manager sees

```
browse(goal: string, hints?: { url?, container? }) -> BrowseResult
BrowseResult { found: bool, answer: string, sources: string[], confidence: "high"|"low", note?: string }
```

The manager verifies `answer` against the step criterion, advances its plan (done/retry/blocked). The
sub-agent's snapshots/clicks/reasoning stay inside the sub-loop; only `BrowseResult` returns.

## Phased rollout (gated, behind `HOMUN_CHAT_BROWSE_SUBAGENT`, default OFF)

- **1.1 scaffolding:** `engine::browse::BrowseResult` (serde) + `browse_subagent_enabled()` flag. Test:
  BrowseResult (de)serializes; flag reads env. (this slice)
- **1.2 recursive executor:** `GatewayBrowseExecutor` — seed an isolated `LoopState` (browser
  system-prompt + goal), build browser-only sub-seams (browser ModelClient, browser-only
  CapabilityExecutor over the 6 granular tools, a fresh BrowserExecutor, isolated EventSink), call
  `engine::run_turn`, map `TurnOutcome` + the sub-`LoopState` → `BrowseResult` (answer = accumulated,
  sources = browse_sources, found/confidence from a light judgment). Test: goal→answer, context
  isolation (manager `LoopState` untouched), `found=false` on impossible goal.
- **2 manager tool:** expose `browse` in the manager's toolset; the dispatch routes it to 1.2. Granular
  tools hidden from the manager behind the flag. Test: manager gets a clean BrowseResult.
- **3 verify + routing:** the manager verifies + routes the plan (done/retry/blocked). Mostly emerges
  from the existing loop. Test: wrong answer → retry; impossible → blocked.
- **4 flip ON + retire:** delete the browser-branch model-switch + `try_advance_frontier_from_evidence`.
  Regression on a Polymarket-style query (plan rises live, clean context, "unavailable" handled).

Each slice brings its test (bottom-up, gated). `reconcile_on_delivery` / `enforce_monotonic_plan_progress`
/ `StreamMarkerFilter` stay as defense-in-depth but stop being the primary mechanism.

## Convergence note

The dormant drive/orchestrator `browse` SubagentTask and this path converge on the SAME
`SubagentTask → SubagentResult` contract (`crates/subagents`). Step 1.2 may implement `BrowseResult`
directly first (simpler, testable); wiring the SubagentResult envelope + retiring the dormant parallel
is a later convergence slice — do NOT build a third path.
