# Provider Usage Phase C: Settings Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete, accessible `Settings → Usage` surface for overview, models, providers and processes.

**Architecture:** Typed bridge methods consume the provenance-rich Phase B read models. A focused `UsageSettingsPane` owns loading/filtering and delegates deterministic formatting to a small pure module; charts use semantic HTML/CSS bars with text equivalents and no new visualization dependency.

**Tech Stack:** React 19, TypeScript, existing coreBridge/gateway helpers, CSS, i18next, Node test runner.

---

**Dependency:** Complete and verify [Phase B](./2026-07-20-provider-usage-phase-b-provider-accounting.md) first.

## File map

- Modify `apps/desktop/src/types.ts`: add the `usage` settings section ID.
- Modify `apps/desktop/src/data/mockData.ts`: add Usage to the account settings group.
- Modify `apps/desktop/src/components/SettingsView.tsx`: route the new section.
- Create `apps/desktop/src/components/UsageSettingsPane.tsx`: full settings experience.
- Create `apps/desktop/src/lib/usageViewModel.ts`: typed deterministic formatting and view helpers.
- Create `apps/desktop/src/lib/usageViewModel.mjs`: Node-testable equivalent.
- Create `apps/desktop/src/lib/usageViewModel.test.mjs`: behavior tests.
- Modify `apps/desktop/src/lib/coreBridge.ts`: usage types and API methods.
- Modify `apps/desktop/src/styles.css`: flat responsive usage layout.
- Modify `apps/desktop/src/i18n/locales/{en,it,es,fr,de}.json`: complete copy.
- Modify `apps/desktop/package.json`: focused usage UI test script.
- Modify `apps/desktop/scripts/check-ui-contract.mjs`: structural regression assertions.
- Modify `apps/desktop/tests/i18n-parity.test.mjs`: keep catalog parity gate green.

### Task 1: Add typed bridge contracts and deterministic formatting

**Files:**
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Create: `apps/desktop/src/lib/usageViewModel.ts`
- Create: `apps/desktop/src/lib/usageViewModel.mjs`
- Create: `apps/desktop/src/lib/usageViewModel.test.mjs`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Write failing view-model tests**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { costLabel, coverageState, providerLimitLabel } from "./usageViewModel.mjs";

test("reported and estimated costs are never merged into one unlabeled number", () => {
  assert.deepEqual(costLabel({ reported: 1200000, estimated: 300000, unknown: 2 }, "en-US"), {
    reported: "$1.20 reported",
    estimated: "$0.30 estimated",
    unknown: "2 attempts unknown",
  });
});

test("manual budget cannot be labeled provider quota", () => {
  assert.equal(providerLimitLabel({ source: "manual_budget", remainingPercent: 40 }), "40% of manual budget remaining");
});

test("partial coverage remains visible", () => {
  assert.deepEqual(coverageState(82, 64), { tone: "warning", label: "82% usage · 64% cost" });
});
```

- [ ] **Step 2: Run the focused test for RED**

Run: `cd apps/desktop && node --test src/lib/usageViewModel.test.mjs`

Expected: FAIL because the view-model modules do not exist.

- [ ] **Step 3: Define coreBridge usage types**

Add exact response types for:

```ts
export type UsageWindow = "7d" | "30d" | "all";
export type UsageCostBreakdown = {
  provider_reported_microusd: number;
  catalog_estimated_microusd: number;
  manual_estimated_microusd: number;
  not_billed_attempts: number;
  unknown_cost_attempts: number;
  cost_coverage_percent: number;
};
export type UsageSummaryView = {
  window: UsageWindow;
  coverage_started_at: number | null;
  logical_calls: number;
  attempts: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  usage_coverage_percent: number;
  active_providers: number;
  dominant_model: string | null;
  trend_percent: number | null;
  cost: UsageCostBreakdown;
};
```

Define equally typed `UsageModelRow`, `UsageProviderRow`, `UsageProcessRow`, `ProviderUsagePolicy` and snapshot state. Add bridge methods using `gatewayGetJson`, `gatewayPostJson` and `gatewayPutJson`:

```ts
usageSummary(window: UsageWindow)
usageModels(window: UsageWindow)
usageProviders(window: UsageWindow)
usageProcesses(window: UsageWindow)
refreshProviderUsage(providerId: string)
providerUsagePolicy(providerId: string)
setProviderUsagePolicy(providerId: string, policy: ProviderUsagePolicy)
```

- [ ] **Step 4: Implement pure formatting helpers**

Keep `.ts` and `.mjs` behavior identical. Format micro-USD with `Intl.NumberFormat`, retain separate reported/estimated/unknown labels, clamp percentages to 0–100, and never display `NaN`, `Infinity` or a negative value.

- [ ] **Step 5: Run focused tests and typecheck for GREEN**

Run:

```bash
cd apps/desktop
node --test src/lib/usageViewModel.test.mjs
npm run typecheck
```

Expected: tests PASS and TypeScript exits 0.

- [ ] **Step 6: Add the package script and commit**

Add `"test:usage-ui": "node --test src/lib/usageViewModel.test.mjs"`.

```bash
git add apps/desktop/src/lib/coreBridge.ts apps/desktop/src/lib/usageViewModel.ts \
  apps/desktop/src/lib/usageViewModel.mjs apps/desktop/src/lib/usageViewModel.test.mjs \
  apps/desktop/package.json
git commit -m "feat(usage-ui): add typed usage read models"
```

### Task 2: Add `Usage` to Settings navigation and load states

**Files:**
- Modify: `apps/desktop/src/types.ts`
- Modify: `apps/desktop/src/data/mockData.ts`
- Modify: `apps/desktop/src/components/SettingsView.tsx`
- Create: `apps/desktop/src/components/UsageSettingsPane.tsx`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing UI-contract assertions**

```javascript
assertContains("src/types.ts", '  | "usage"', "Settings must expose a Usage section");
assertContains("src/data/mockData.ts", 'id: "usage"', "Settings drawer must list Usage");
assertContains("src/components/SettingsView.tsx", '<UsageSettingsPane />', "Settings must render Usage");
assertContains("src/components/UsageSettingsPane.tsx", 'role="tablist"', "Usage views must be keyboard-addressable tabs");
assertContains("src/components/UsageSettingsPane.tsx", 'aria-live="polite"', "Usage loading and errors must be announced");
```

- [ ] **Step 2: Run UI contracts for RED**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: FAIL on the new Usage assertions.

- [ ] **Step 3: Add the navigation entry**

Add `"usage"` to `SettingsSectionId`, add a `ChartNoAxesCombined` icon entry directly after Runtime in the account group, add `usage: "settings.usage.title"` to `SECTION_TITLES`, import `UsageSettingsPane`, and render it only for `section === "usage"`.

- [ ] **Step 4: Implement pane state management**

`UsageSettingsPane` owns:

```ts
type UsageTab = "overview" | "models" | "providers" | "processes";
const WINDOWS: UsageWindow[] = ["7d", "30d", "all"];
```

On window change, use one request generation ref and `Promise.all` to load summary/models/providers/processes. Ignore stale responses. Render explicit `loading`, `empty`, `partial`, `error` and `ready` states. Keep the last successful data visible during a refresh and add a discreet busy indicator instead of blanking the pane.

- [ ] **Step 5: Implement accessible tab behavior**

Use buttons with `role="tab"`, `aria-selected`, roving `tabIndex`, ArrowLeft/ArrowRight navigation and associated `role="tabpanel"`. Filter buttons use `aria-pressed`. The heading remains the Settings page heading; tabs do not create nested modal surfaces.

- [ ] **Step 6: Run contracts and typecheck for GREEN**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit Settings navigation and shell**

```bash
git add apps/desktop/src/types.ts apps/desktop/src/data/mockData.ts \
  apps/desktop/src/components/SettingsView.tsx apps/desktop/src/components/UsageSettingsPane.tsx \
  apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(usage-ui): add Settings usage workspace"
```

### Task 3: Build Overview and Models views

**Files:**
- Modify: `apps/desktop/src/components/UsageSettingsPane.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing semantic UI assertions**

Require source to contain separate labels/classes for `reported`, `estimated`, `unknown`, `usage-coverage`, `latency-p50`, `latency-p95`, `retry-count` and `fallback-count`.

- [ ] **Step 2: Run UI contracts for RED**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: FAIL because the panels are not implemented.

- [ ] **Step 3: Implement Overview**

Use one flat `.usage-surface` with functional section separators. Render:

- logical calls and attempts;
- input/output/reasoning/cache tokens;
- active providers and dominant model;
- reported, estimated and unknown cost as separate rows;
- usage and cost coverage meters;
- a 7/30/all daily activity strip using CSS grid cells with an accessible text summary;
- `Dati autorevoli dal {date}` when coverage start exists.

No KPI is wrapped in an additional bordered card. Use typography and spacing for grouping.

- [ ] **Step 4: Implement Models**

Render a semantic table on wide screens and definition rows on narrow screens. Columns: model, effective provider, calls, tokens, cost provenance, median latency, p95, success rate, retries/fallbacks and dominant purpose. Sorting buttons expose `aria-sort`; default sort is total tokens descending.

- [ ] **Step 5: Add responsive and dark-theme CSS**

Use existing tokens only: `--surface`, `--surface-muted`, `--line`, `--text`, `--text-muted`, `--brand`, `--amber`, `--red`. At max-width 760px, switch metrics and model rows to one column; never force horizontal page scroll.

- [ ] **Step 6: Run contracts, typecheck and build**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
npm run typecheck
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit Overview and Models**

```bash
git add apps/desktop/src/components/UsageSettingsPane.tsx apps/desktop/src/styles.css \
  apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(usage-ui): show overview and model analytics"
```

### Task 4: Build Providers and Processes with policy editing

**Files:**
- Modify: `apps/desktop/src/components/UsageSettingsPane.tsx`
- Modify: `apps/desktop/src/lib/usageViewModel.ts`
- Modify: `apps/desktop/src/lib/usageViewModel.mjs`
- Modify: `apps/desktop/src/lib/usageViewModel.test.mjs`
- Modify: `apps/desktop/src/styles.css`

- [ ] **Step 1: Add failing provider-separation tests**

Add tests proving:

- a manual budget uses `manual` copy even when account snapshot is unavailable;
- an old successful snapshot becomes stale but is not discarded;
- unsupported and unauthorized have different labels;
- unknown cost disables the “remaining budget” percentage and displays a coverage warning.

- [ ] **Step 2: Run focused tests for RED**

Run: `cd apps/desktop && npm run test:usage-ui`

Expected: FAIL on missing provider helpers.

- [ ] **Step 3: Implement Providers**

Each provider row has three sibling sections:

1. `Misurato da Homun` with calls/tokens/cost coverage;
2. `Stato account provider` with state, value, reset and fetched-at;
3. `Budget manuale` with explicit local label.

Refresh calls `refreshProviderUsage`. Unsupported disables refresh with explanatory text. Unauthorized never asks for a second key; it says the normal key cannot access this information.

- [ ] **Step 4: Implement the policy editor**

Use an inline expandable editor, not a modal. Fields: monthly USD budget, reset day 1–28, timezone, threshold 1–100 and per-model price overrides. Validate client-side for immediate feedback and rely on server validation for authority. Save through `setProviderUsagePolicy`, then reload the provider row.

- [ ] **Step 5: Implement Processes**

Group exact backend purposes into display families without losing the raw purpose in details:

```ts
const PROCESS_FAMILIES = {
  chat: ["chat_response", "title_generation", "intent_routing"],
  memory: ["memory_extraction", "memory_recall", "memory_compaction", "embedding"],
  planning: ["planning", "evaluation"],
  subagents: ["subagent"],
  automations: ["automation"],
  artifacts: ["artifact_generation", "vision_analysis"],
  other: ["other"],
} as const;
```

Render calls, attempts, tokens, cost, success, latency and coverage per family.

- [ ] **Step 6: Run focused tests and production build**

Run:

```bash
cd apps/desktop
npm run test:usage-ui
npm run test:ui-contract
npm run typecheck
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit Providers and Processes**

```bash
git add apps/desktop/src/components/UsageSettingsPane.tsx apps/desktop/src/lib/usageViewModel.ts \
  apps/desktop/src/lib/usageViewModel.mjs apps/desktop/src/lib/usageViewModel.test.mjs \
  apps/desktop/src/styles.css
git commit -m "feat(usage-ui): add provider and process accounting"
```

### Task 5: Add complete localization and accessibility copy

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/i18n/locales/fr.json`
- Modify: `apps/desktop/src/i18n/locales/de.json`
- Modify: `apps/desktop/tests/i18n-parity.test.mjs`

- [ ] **Step 1: Add the complete `settings.usage` key tree**

Include keys for title, four tabs, three windows, loading/empty/error/stale/partial states, metrics, cost provenance, account states, manual budget, policy fields, save/refresh actions and screen-reader chart summaries. Use these canonical labels:

| Meaning | English | Italian | Spanish | French | German |
|---|---|---|---|---|---|
| Usage | Usage | Utilizzo | Uso | Utilisation | Nutzung |
| Measured by Homun | Measured by Homun | Misurato da Homun | Medido por Homun | Mesuré par Homun | Von Homun gemessen |
| Provider account | Provider account | Account provider | Cuenta del proveedor | Compte fournisseur | Anbieterkonto |
| Manual budget | Manual budget | Budget manuale | Presupuesto manual | Budget manuel | Manuelles Budget |
| Incomplete coverage | Incomplete coverage | Copertura incompleta | Cobertura incompleta | Couverture incomplète | Unvollständige Abdeckung |
| Reported | Reported | Dichiarato | Declarado | Déclaré | Gemeldet |
| Estimated | Estimated | Stimato | Estimado | Estimé | Geschätzt |
| Unknown | Unknown | Non disponibile | No disponible | Indisponible | Nicht verfügbar |

- [ ] **Step 2: Add focused Usage parity without absorbing historical locale drift**

Keep the existing full-catalog `LANGS = ["es", "fr", "de"]` check unchanged because Italian has documented historical drift outside this feature. Add a separate test that recursively compares only the `settings.usage` subtree key paths in `it`, `es`, `fr` and `de` with English. The test must fail for a missing or extra Usage key in any supported locale.

- [ ] **Step 3: Run localization and UI tests**

Run:

```bash
cd apps/desktop
npm run test:electron
npm run test:usage-ui
npm run typecheck
```

Expected: locale parity and typecheck PASS.

- [ ] **Step 4: Commit localized Usage**

```bash
git add apps/desktop/src/i18n/locales apps/desktop/tests/i18n-parity.test.mjs
git commit -m "feat(usage-ui): localize usage analytics"
```

### Task 6: Phase C verification gate

**Files:**
- Verify only; no expected source edits.

- [ ] **Step 1: Run the complete desktop gate**

Run:

```bash
cd apps/desktop
npm run test:usage-ui
npm run test:ui-contract
npm run test:electron
npm run typecheck
npm run build
```

Expected: every command exits 0.

- [ ] **Step 2: Run backend usage regressions**

Run:

```bash
cargo test -p local-first-desktop-gateway usage
cargo test -p local-first-desktop-gateway --test usage_accounting
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Perform real UI QA**

Launch the desktop app with a QA database containing reported, estimated, local-not-billed, unknown and stale provider rows. Verify with mouse and keyboard:

- all four tabs and three time windows;
- no nested-card visual clutter;
- no horizontal overflow at 760px and 1100px;
- tab order and visible focus;
- readable dark theme and 200% zoom;
- manual budget never labeled quota.

- [ ] **Step 4: Record corrections only if required**

If QA required source changes:

```bash
git add apps/desktop
git commit -m "fix(usage-ui): close Settings usage QA gaps"
```
