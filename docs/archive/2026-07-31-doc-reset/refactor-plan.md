# Refactor plan — splitting long files & dead-code cleanup

Living roadmap for tidying the codebase. Each step is **behaviour-preserving** and
must stay green: `cargo check && cargo test -p local-first-desktop-gateway`,
`cd apps/desktop && npm run build` (tsc + vite), `python3 scripts/find_italian.py
--frontend`, and en/it i18n key parity.

## Done (branch `chore/overnight-cleanup`)

- Removed the dead provider **"activate"** path (single-active → enable/disable left
  it orphaned): `coreBridge.activateProvider`, the `POST /api/providers/{id}/activate`
  route + `activate_provider` handler, `activeId` state, `settings.setActive` i18n,
  `.set-prov.active`/`.set-prov-dot` CSS, unused `AutomationCandidate*` imports.
- Removed two genuinely-dead gateway fns: `today_iso`, `contact_episodes_dated`.
- Extracted gateway HTTP helpers → `apps/desktop/src/lib/gatewayHttp.ts` (leaf module),
  unblocking coreBridge feature splits (no import cycle).

## Gotchas discovered (read before continuing)

1. **`cargo check` ≠ `cargo test` for dead code.** A function used ONLY by a
   `#[cfg(test)]` test is reported "never used" by the non-test build but removing it
   breaks `cargo test` (e.g. `normalize_for_dedup`, `ingest_attachments`). Before
   deleting any "never used" fn, grep the symbol across `crates/` **including tests**;
   delete only if zero refs. Always run `cargo test`, not just `cargo check`.
2. **Never-read struct fields** (`label`, `soul_md`, `mime_type`, `nickname`,
   `preferred_channel`, `avatar`, `kind`, `start`/`date_only`/`is_future`) are still
   flagged. Removing a field means updating every construction site AND checking
   serialization (Serialize → frontend / Deserialize ← persisted JSON). Do these
   one-by-one, deliberately — not in a sweep.
3. **Import cycles.** New frontend feature modules must import the HTTP helpers from
   `gatewayHttp.ts` and types/URL/auth from `gatewayConfig.ts` (both leaves), NEVER
   back from `coreBridge.ts`. coreBridge imports the feature modules + re-exports their
   public types so existing `import { type X } from "../lib/coreBridge"` keeps working.
4. **Rust extraction from `main.rs`** is compiler-verified (safe once it builds + tests
   pass) but high-touch: the moved cluster's private deps in main.rs must become
   `pub(crate)`. Do the LOW-coupling clusters first; expect a visibility fix-loop.

## Frontend splits (tsc + vite verify everything)

### `coreBridge.ts` (3.3k) — by feature, re-export types
Order (lowest coupling first):
1. `connectorBridge.ts` — `electronMcp*`, `electronComposio*`, `electronFs*` + their
   types (`McpConnectResult`, `ComposioConnectResult`, `FsEntry`, `FsFilePayload`).
   ~750 LOC. Re-export the types from coreBridge.
2. `memoryBridge.ts` — `electronMemory*` (dashboard/items/graph/wiki/goals/consolidate/
   decide/export/graphify) + `MemoryGraph*`, `MemoryWikiPage`, `scopeQuery`.
3. `systemBridge.ts` — system/runtime/workspace fns + `SystemStatus`, `UpdateInfo`,
   `TimezoneInfo`, `LanguageInfo`, `WorkspaceRecord`.
Keep the single `coreBridge` object in coreBridge.ts, assembled from the imports — so
no call site changes.

### `SettingsView.tsx` (4.9k) — by pane
1. `SettingsUIKit.tsx` — `CopyButton`, `Toggle`, `ToggleRow`, `TimezoneRow`,
   `LanguageRow`, `ApprovelRoutingRow`, `LocalComputerToggle` (pure UI, no parent state).
2. `ProviderSettings.tsx` — `RuntimePane` + `ProviderDetailView` + `PROVIDER_PRESETS`.
3. `SkillsSettings.tsx` — `SkillssPane`, `MarketplaceView`, `SkillsDetailView`, tree,
   security section.
4. `ConnectorsSettings.tsx` — `ConnectorsPane` + Composio/MCP/FS sub-views (most
   coupled; do last).

### `ChatView.tsx` (7.6k)
1. `messageParser.ts` — pure parsers + regexes (`parseArtifacts`, `parsePlanSteps`,
   `parseActivitySteps`, `parseOperationalPlanItems`, `PLAN_PROPOSE_RE`, …). Pure → safe.
2. `MessageRenderer.tsx` — `MessageActionBar`, `MessageAttachmentList`, formatting
   helpers (presentational).
3. `ArtifactManager.tsx` — artifact list/preview/CSV components.
4. `ProposalCards.tsx` — `GoalProposeCard`, `PlanProposeCard`, `PlanProgressCard`,
   `ChoicesCard`.
5. `MemoryWorkbench.tsx` — `GoalsPanel` + `MemoryGraphPanel` (ForceGraph2D; do last).

## Backend splits (`main.rs`, 29k) — `cargo check && cargo test`

Risk-ranked (lower first). Each new `mod` file is a sibling under
`crates/desktop-gateway/src/`; expose shared main.rs items as `pub(crate)`.

1. **`providers_api.rs`** (LOW) — provider/role/routing handlers + `provider_view`,
   `providers_response`, registry load/save helpers. Mostly file-backed (not AppState),
   so low coupling.
2. **`memory_ml.rs`** (MED) — embeddings, cosine/jaccard/dedup, graph link/orphan
   sweep, consolidation, `learn_from_exchange`. Needs a `MemoryFacade` getter on
   AppState; high value (~1.6k LOC).
3. **`computer_session.rs`** (MED) — browser/CDP/noVNC env + container detection +
   computer-session events.
4. **`automations_api.rs`** (MED-HIGH) — automation CRUD + connector event polling +
   tool-schema generators. Stateful; do after providers.
5. **`chat_inference.rs`** (HIGH, DEFER) — streaming/prompt build; tightly coupled to
   chat store + artifacts + memory. Needs prep before extraction.

## Suggested next session

Do `connectorBridge.ts` (frontend, fully tsc/vite-verified) and `providers_api.rs`
(backend, compiler-verified) together — both are the lowest-risk, highest-value cuts
and validate the extraction pattern end to end.
