# Whole-System Assessment & Plan (2026-05-29)

Re-analysis of the entire project after the de-gemma sweep, to build a complete
plan grounded in what actually exists vs. what is wired. Based on a 4-way
parallel audit (vision/scope, backend crates, desktop UI, gateway wiring).

## The headline finding

**Almost everything is BUILT but not WIRED into the gateway's live loop.** This
is an integration project, not a greenfield one. The 13 backend crates are real
implementations (no `todo!()`/`unimplemented!()` in core paths). The gap is the
**desktop-gateway**: it does not dispatch most of what the crates can do.

## Component state (valid / partial / stub)

| Component | Built? | Wired into gateway loop? | Verdict |
|---|---|---|---|
| Inference router (local+cloud) | ✅ real | ✅ chat + Brain | VALID |
| Orchestrator Brain (plan→durable tasks) | ✅ real | ✅ materialize default-on (capable) | VALID |
| Task runtime (SQLite, approvals, leases) | ✅ real | ✅ worker executes | VALID |
| Browser automation + observe-act loop | ✅ real | ✅ but only on legacy `browser_task` path | PARTIAL (see Gap 1) |
| Capabilities crate (MCP stdio, Composio HTTP, browser) | ✅ real providers | ❌ non-browser → `execute_unwired_registered_task` (blocked) | BUILT, NOT WIRED (Gap 2) |
| Memory (SQLite, encryption, wiki, policy) | ✅ real | ❌ `NoopMemoryContextProvider`; dashboard-only | BUILT, NOT WIRED (Gap 3) |
| Skill runtime (process + WASM sandbox) | ✅ real | ❌ not dispatched by gateway | BUILT, NOT WIRED (Gap 2) |
| Subagents (bridges, runtime client) | ✅ real | ✅ `subagent.*` → executor | VALID (inference external) |
| Secrets, process-manager, context-compression, local-computer-session | ✅ real | ✅ | VALID |
| Desktop UI | chat/tasks/approvals/settings only | — | PARTIAL (Gap 4) |

## The four real gaps

### Gap 1 — Brain browser tasks bypass the observe-act loop (REGRESSION risk)
The working loop (validated end-to-end: extracted Trenitalia options) runs ONLY
in `execute_browser_read_only_task` (legacy `browser_task` kind). The Brain
materializes static `capability.browser.navigate/act` tasks → `execute_capability_browser_task`
= single synchronous calls. We proved static `act` can't do form interaction.
**With A1.6 (Brain default-on for capable), the default path can't complete a
booking** even though the loop can. Browser INTERACTION must route to the loop.

### Gap 2 — Capability execution is browser-only in the gateway
`capability.*` (non-browser: MCP, Composio, skills, connectors) →
`execute_unwired_registered_task` → blocked. The providers EXIST in the
`capabilities` crate (real MCP stdio + Composio HTTP + skill providers) but the
gateway worker never calls `CapabilityFacade::call_tool` for them. So no email /
GitHub / Slack / MCP / skill tool can actually run, even though the Brain can
plan them and the registry lists them.

### Gap 3 — Memory is not in the loop
`MemoryFacade` is real and backs `/api/memory/dashboard`, but it is never read
during planning/chat nor written from task outcomes. The Brain uses
`NoopMemoryContextProvider`. No retrieval into Brain context, no learning from
runs.

### Gap 4 — UI is chat-centric
Functional+wired: Chat, Tasks queue, Approvals, Runtime settings, Connections
(list), Local Computer (embedded in chat). Stub/mock/missing: Memory browser
(stats only), Automations (mock/missing), dedicated Browser monitoring viewport,
Skills editor (missing), Learning insights (mock), Audit log (stub), Brain audit
(mock).

## Prioritized plan (value × unblocks-the-vision, mostly wiring)

The north star (PROJECT.md): an assistant that understands, plans, executes on
the computer with governed autonomy, observes, remembers, learns. Sequence to
make that real end-to-end:

### P1 — Close the browser loop in the product path (Gap 1) [small, high value]
Route Brain browser INTERACTION goals to the observe-act loop instead of static
`capability.browser.act` steps: materialize a single "browser goal" task whose
executor runs `BrowserLoopRunner` (reuse `execute_browser_loop_read_only_task`).
Keep atomic reads (navigate/snapshot) as capability calls. Makes the validated
loop the real app path. Validate via the gateway (not just the example).

### P2 — Wire the capability executor for non-browser providers (Gap 2) [medium, unlocks the whole tool ecosystem]
Replace `execute_unwired_registered_task` with real dispatch to
`CapabilityFacade::call_tool` for `capability.*` (MCP, Composio, skill, native).
The facade + providers already exist. Gate by policy/approval. This single
change turns MCP + skills + connectors from "listed" into "executable" — the
biggest capability unlock for the least new code.

### P3 — Memory in the loop (Gap 3) [medium, makes it "personal"]
Replace `NoopMemoryContextProvider` with a real provider that retrieves
privacy-filtered memory into Brain context; write memory from task outcomes
(and/or MemoryAgent). Wire the dashboard to the same store (already real).

### P4 — Finish the UI surfaces (Gap 4) [large, makes the product whole]
In priority order, each wiring to endpoints that mostly already return real data:
1. Dedicated Local Computer / browser-monitoring viewport (the observe-act run is
   the product's signature surface; today it's only embedded in chat).
2. Memory browser (search, entities/relations, privacy domains) on the real
   memory store.
3. Connectors/MCP/skills management (enable, auth, configure, test) + skills
   editor — pairs with P2.
4. Automations management + Learning insights wired to real data (depends on
   Phase 10 learning, lower priority).
5. Audit log + Brain audit detail.

### Cross-cutting
- Keep the small-local-model fallback (dual-model strategy) intact through all
  of the above; capable backend is primary.
- Each step ships green; validate browser/tool paths live.

## Sequencing rationale
P1 fixes a regression and lands the validated capability in the app. P2 is the
highest leverage (one executor change unlocks MCP/skills/connectors). P3 makes it
personal. P4 makes it whole. P1–P3 are mostly wiring existing crates; P4 is the
real build-out.
