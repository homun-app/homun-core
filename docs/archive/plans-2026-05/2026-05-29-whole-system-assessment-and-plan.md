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

---

## Progress

- **P1 — DONE** (commit 488f685): `brain_materialize_tasks` plan_only()s first; a
  browser-targeting plan materializes ONE `browser_task` (observe-act loop) via
  `materialize_browser_loop_task` instead of static `capability.browser.*` steps.
  Live-validated: A1.6 default-on Brain (no flag) + Trenitalia prompt → queued
  `orchestrator_browser_*` of kind `browser_task`. Closes the example↔app gap and
  the A1.6 regression. Next: P2 (wire non-browser capability execution).
- **P2 — DONE (MCP wired; Composio/skill typed-pending)** (this commit):
  `execute_capability_generic` builds a live provider from the registry and
  dispatches via `CapabilityFacade::call_tool`. MCP executes end-to-end through
  the crate's real `McpStdioTransport`; Composio/skill report a typed
  "kind not yet wired". Removed the `execute_unwired_registered_task` stub.
  Remaining for full P2: a real Composio HTTP transport + skill-runner provider
  wiring, and a configured MCP connection to demo live (pairs with P4 connectors).
- **P3 — DONE (explicit save loop; auto-learning pending)** (commits 2ae5810 +
  4ebc503): READ — Brain uses a real `MemoryFacade` provider (`context_pack`,
  policy-filtered) instead of Noop, at both build sites. WRITE — explicit
  "save to memory" persists a CONFIRMED record + projects a markdown wiki page
  (stable-ref frontmatter linking record↔page), via a new `/save_to_memory`
  endpoint; UI wired gateway-first. Live-validated: dashboard memories=1/
  wiki_pages=1/confirmed, `notes/*.md` written. Memory = markdown + graph indexed
  by SQLite, per design. Remaining: graph entities/relations from free text +
  automatic extraction (MemoryAgent) = Phase B/10; Composio/skill capability
  transports (P2 tail); P4 UI (memory browser shows wiki+graph).

### P4.3 Composio — model + calibration (direct/BYO confirmed)

Decision (ADR 0009 addendum): **direct / BYO key, no backend, no white labeling**
(white labeling is inherently a backend/operator pattern — OAuth client secrets
can't ship in a distributed client; confirmed via Composio docs). Local-first:
each user pastes their own Composio key; consent shows "Composio" (managed auth).

Live calibration (user key): v1/v2 endpoints are RETIRED (410 → v3). The ONLY
live API is `https://backend.composio.dev/api/v3` with `x-api-key` — our
transport/base/path/auth are CONFIRMED correct (the API parsed the request and
validated the header). The user's current key (`ak_…`, 23 chars) is rejected as
`Invalid API key (10401)` — almost certainly a legacy-platform key; needs
regenerating on the current v3 dashboard.

Remaining (grounded on v3, build can proceed; final live test needs a valid key):
- Backend connect-per-service endpoints via the transport: `GET /toolkits`
  (app list), `GET /auth_configs` + `POST /connected_accounts/link` {auth_config_id,
  user_id} → connectUrl, `GET /connected_accounts?user_ids=` (poll ACTIVE).
  Use link() (initiate() retired 2026-05-08), args-aware gate (list/connect free,
  execute behind approval).
- UI ConnectionsView: paste key once → toolkit list → "Connect" → open connectUrl
  → poll → connected.

#### P4.3 — DONE (connect + execute wired & grounded; final OAuth is the user's)

- **Connect flow (eb78093)**: gateway endpoints connect/toolkits/link/connections,
  live-validated against real v3 (`POST /composio/link {gmail}` →
  `{redirect_url, connected_account_id}`; `GET /composio/connections` →
  INITIALIZING). Per-workspace Composio entity (`composio_entity_id()` =
  active workspace) isolates connected accounts per project.
- **Connect UI (6768327)**: `ComposioPanel` in ConnectionsView — probe →
  needs-key (password input, never echoed) → paste key (`POST /connect`, a 2xx =
  v3-validated) → searchable toolkit grid (`GET /toolkits`) → "Connect"
  (`POST /link`) opens redirect_url in the browser → polls connections ~36s so
  INITIALIZING → ACTIVE flips live → "Connesso" badge. 4 gateway-first bridge
  methods; `gatewayErrorDetail` unwraps `{error:{message}}`.
- **Execute v3-direct (d66facb)**: grounded the execute path with a zero-side-
  effect probe (`POST /api/v3/tools/execute/NONEXISTENT…` → "Tool not found",
  404) — path routable, x-api-key accepted, `{user_id, arguments}` body is
  v3-correct. The crate's `call_tool` already targets this exactly (the "pre-v3"
  issue was only in `list_tools`, off the execute path). Two fixes: provider
  `user_id` now = `composio_entity_id()` (matches link-time entity; previously
  "local-user" → no connected account); transport surfaces the v3
  `{error:{message}}` body on non-2xx.
- **Remaining**: a final live execute test needs an ACTIVE connection — the user
  completes the OAuth from the UI (click Connect → browser → grant). Everything
  up to and including that click is wired and grounded.

### P4.1 — DONE (workspace scoping complete, chat included)

- Backend re-scoping (tasks/memory/capabilities) on `active_workspace_id()`:
  prior work.
- **Switcher UI (179ce93)**: WorkspaceSwitcher in the NavDrawer — list/select
  (full reload to re-scope every cached view) / create, gateway-first.
- **Chat threads scoped (this commit)**: `chat_threads` gained a `workspace_id`
  column (additive, guarded ALTER; existing rows → 'default'); `threads()` /
  `create_thread()` take a `workspace_id` and the gateway passes
  `active_workspace_id()`. The active-thread pointer is now a per-project
  settings key (`active_thread_id::{workspace}`), so switching projects never
  points chat at a foreign thread. A project is never empty: `threads()`
  auto-seeds a fresh thread for an empty/new project (mirrors the initial seed);
  deleting a project's last thread reseeds it. New test
  `threads_are_scoped_per_project_with_independent_active_pointer` locks
  isolation + independent active pointer + reseed-on-empty. This closes the
  cross-project chat-leak gap noted in 179ce93.

### P4.2 — STARTED (General section: active model visible)

- **Active model in Settings → General (4a553d4)**: gateway `GET
  /api/runtime/model` reports the live backend/model (mirrors
  `build_browser_inference_router`); the previously-empty General section renders
  it with cloud/local + capable/limited badges and warns on the gemma fallback
  or a missing cloud key. Directly addresses the de-gemma origin ("am I on cloud
  or gemma4?"). Live-validated.
- **Remaining P4.2**: autonomy-level + privacy-domain toggles wired to real
  policy read/write (today privacy section is static); audit-log section (stub).
  Dynamic model *switching* from the UI is deferred — it needs a product decision
  (hot-swap vs restart of the in-process runtime; where the cloud key is stored)
  and a router-rebuild path; today the backend is env-configured at startup.

## Session summary (2026-05-30)

Five green, live-validated slices, all on the user's P4 asks (settings, project
management, connectors) and the de-gemma thesis:
1. Composio connect UI (6768327) — paste key → toolkits → link → poll.
2. Composio execute v3-direct (d66facb) — grounded path; fixed entity mismatch.
3. Project (workspace) switcher UI (179ce93).
4. Chat threads scoped per project (596d5b4) — closes the switcher's leak gap.
5. Settings → General active-model visibility (4a553d4).

Open next (no blockers): MCP/skills connect UI (pairs with Composio); audit-log
section; memory browser + dedicated browser-monitoring viewport (P4.4); dynamic
model switching (needs the design decision above). A final live Composio *execute*
needs the user to complete one OAuth from the new UI.

## Session addendum (2026-05-30, part 2 — live UI test + headless hardening)

Drove the running app via computer-use and verified the three UI slices live
(workspace create→reload→auto-seed; Composio needs-key panel; Settings→General).
The visual test surfaced real bugs that unit tests could not:

6. **De-gemma chat labels (98014d4)**: the running backend is mistral-small
   (capable) but the chat said "Gemma" everywhere (author label, typing
   indicators, seeded message, dropdown). Made the assistant's voice
   model-neutral so it is correct regardless of backend.
7. **Active-model single source of truth (104215b)**: the reporter claimed the
   mistralrs default was "mistral-small" while the router loads "Qwen/Qwen3-4B".
   Extracted shared default-model constants (used by BOTH router and reporter) +
   a pure, unit-tested `resolve_active_model`. 7 branch tests.
8. **MCP server connect endpoint (3f68da8)**: `POST /api/capabilities/mcp/connect`
   registers a local stdio MCP server (mirrors Composio connect); metadata via
   `mcp_stdio_config_to_metadata` (round-trip tested against the executor's
   reader); best-effort spawn→initialize→tools/list discovery with transparent
   `discovery_error`. 3 tests; live-validated on an isolated gateway.

Screen locked mid-session (user stepped away) → pivoted to backend-only,
test-backed work (no unverifiable GUI changes). Test count: 75 bin / 24 lib.

Still deferred until the screen is unlockable (need visual verification): the
"Progetti" nav still lists MOCK projects separate from the real switcher; the
chat-header "Gemma 4 MLX" health pill still names the MLX process (needs
backend-aware runtime health); ConnectionsView MCP form; skill EXECUTION wiring
(needs a manifest+WASM artifact to validate).
