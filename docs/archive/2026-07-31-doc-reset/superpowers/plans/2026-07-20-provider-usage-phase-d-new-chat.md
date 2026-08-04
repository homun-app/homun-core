# Provider Usage Phase D: New-Chat Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace empty-chat prompt examples with the approved lightweight usage overview while keeping the Homun identity and composer dominant.

**Architecture:** A focused `ChatUsageOverview` component loads only the compact summary read model and owns its 7d/30d/all filter. `ChatEmptyHero` becomes presentational and disappears through the existing empty-thread condition as soon as the first user message is present.

**Tech Stack:** React 19, TypeScript, existing coreBridge, CSS, i18next, Node UI contract tests.

---

**Dependency:** Complete and verify [Phase C](./2026-07-20-provider-usage-phase-c-settings.md) first.

## File map

- Create `apps/desktop/src/components/ChatUsageOverview.tsx`: compact new-chat usage surface.
- Modify `apps/desktop/src/components/ChatView.tsx`: remove prompt chips and mount the overview.
- Modify `apps/desktop/src/lib/usageViewModel.ts` and `.mjs`: compact row formatting.
- Create `apps/desktop/src/lib/newChatUsage.test.mjs`: pure and structural regressions.
- Modify `apps/desktop/package.json`: focused new-chat test script.
- Modify `apps/desktop/src/styles.css`: approved flat layout and responsive composer placement.
- Modify `apps/desktop/src/i18n/locales/{en,it,es,fr,de}.json`: compact summary copy.
- Modify `apps/desktop/scripts/check-ui-contract.mjs`: reject reintroduction of prompt chips.

### Task 1: Define compact summary behavior

**Files:**
- Modify: `apps/desktop/src/lib/usageViewModel.ts`
- Modify: `apps/desktop/src/lib/usageViewModel.mjs`
- Create: `apps/desktop/src/lib/newChatUsage.test.mjs`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Write failing compact-summary tests**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { compactUsageRows } from "./usageViewModel.mjs";

test("compact summary keeps cost provenance visible", () => {
  const rows = compactUsageRows({
    input_tokens: 1000, output_tokens: 400, reasoning_tokens: 50,
    active_providers: 2, dominant_model: "model-a", trend_percent: -12,
    cost: {
      provider_reported_microusd: 1200000,
      catalog_estimated_microusd: 300000,
      manual_estimated_microusd: 0,
      unknown_cost_attempts: 1,
    },
  }, "en-US");
  assert.equal(rows.cost.primary, "$1.20 reported");
  assert.equal(rows.cost.secondary, "$0.30 estimated · 1 unknown");
});

test("empty history returns a first-use state instead of zero-heavy KPIs", () => {
  assert.deepEqual(compactUsageRows({ logical_calls: 0 }, "en-US"), { kind: "empty" });
});
```

- [ ] **Step 2: Run the focused test for RED**

Run: `cd apps/desktop && node --test src/lib/newChatUsage.test.mjs`

Expected: FAIL because `compactUsageRows` and the test script do not exist.

- [ ] **Step 3: Implement compact rows**

Return either `{ kind: "empty" }` or a ready object with exactly five display groups: tokens, cost, providers, dominant model and trend. Preserve unknown/estimated labels and return a `coverageWarning` when either coverage percentage is below 100.

- [ ] **Step 4: Add and run the package script**

Add `"test:new-chat-usage": "node --test src/lib/newChatUsage.test.mjs"`.

Run:

```bash
cd apps/desktop
npm run test:new-chat-usage
npm run test:usage-ui
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit compact view logic**

```bash
git add apps/desktop/src/lib/usageViewModel.ts apps/desktop/src/lib/usageViewModel.mjs \
  apps/desktop/src/lib/newChatUsage.test.mjs apps/desktop/package.json
git commit -m "feat(usage-ui): define compact new-chat summary"
```

### Task 2: Build `ChatUsageOverview`

**Files:**
- Create: `apps/desktop/src/components/ChatUsageOverview.tsx`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing component contract assertions**

```javascript
assertContains("src/components/ChatUsageOverview.tsx", 'const WINDOWS: UsageWindow[] = ["7d", "30d", "all"]', "New chat must support all approved windows");
assertContains("src/components/ChatUsageOverview.tsx", 'aria-live="polite"', "Usage load state must be announced");
assertContains("src/components/ChatUsageOverview.tsx", 'coreBridge.usageSummary(window)', "New chat must read the canonical summary");
assertNotContains("src/components/ChatUsageOverview.tsx", "usageModels", "New chat must not load full analytics");
```

- [ ] **Step 2: Run UI contracts for RED**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement loading and race safety**

The component owns `window`, `summary`, `loading` and `error`. Use a request generation ref; discard responses from prior windows. Keep prior summary while refreshing. Errors show one compact retry action and never block the composer.

- [ ] **Step 4: Implement the visual hierarchy**

Render in this order:

1. period segmented control;
2. one horizontal/stacking metric row;
3. coverage note when required;
4. optional slot for one future suggestion, omitted in Phase D.

The component has one outer semantic section and functional separators only. Do not create nested bordered KPI cards.

- [ ] **Step 5: Run contracts and typecheck for GREEN**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the component**

```bash
git add apps/desktop/src/components/ChatUsageOverview.tsx apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(usage-ui): add new-chat usage overview"
```

### Task 3: Remove prompt examples and integrate the overview

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing removal/integration assertions**

```javascript
assertNotContains("src/components/ChatView.tsx", "EMPTY_HERO_CHIPS", "New chat must not keep canned prompt chips");
assertNotContains("src/components/ChatView.tsx", "chat-hero-chip", "New chat must not render canned prompt buttons");
assertContains("src/components/ChatView.tsx", "<ChatUsageOverview />", "Empty hero must mount compact usage");
```

- [ ] **Step 2: Run UI contracts for RED**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: FAIL because current source still contains `EMPTY_HERO_CHIPS`.

- [ ] **Step 3: Simplify `ChatEmptyHero`**

Remove `EMPTY_HERO_CHIPS`, the chip mapping, prompt seed callback and imports used only by those chips. Change the component signature to `function ChatEmptyHero()`. Keep the current inline brandmark SVG block byte-for-byte, followed in this exact DOM order by the existing `chat.emptyHero` heading, the existing `chat.emptyHeroSub` paragraph and `<ChatUsageOverview />`. Do not introduce a new brandmark component as part of this phase.

Keep the existing empty-thread condition. Do not add local state to hide the hero: the first persisted/optimistic user message already makes the normal conversation render.

- [ ] **Step 4: Remove obsolete seed wiring**

Delete the `onPick` prop from the `ChatEmptyHero` call and any state setter used only by canned chips. Preserve composer attachment, microphone, model selector and submit behavior.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
cd apps/desktop
npm run test:new-chat-usage
npm run test:ui-contract
npm run typecheck
```

Expected: all commands exit 0 and no chip identifiers remain.

- [ ] **Step 6: Commit the hero integration**

```bash
git add apps/desktop/src/components/ChatView.tsx apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(chat): replace prompt chips with usage overview"
```

### Task 4: Apply the approved flat layout and localization

**Files:**
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/i18n/locales/fr.json`
- Modify: `apps/desktop/src/i18n/locales/de.json`

- [ ] **Step 1: Add copy for compact states**

Add keys under `chat.usageOverview` for 7 days, 30 days, all, tokens, cost, providers, model, trend, coverage, no history, retry and open Settings. Use concise copy; the Italian empty state is exactly `I dati di utilizzo inizieranno dalla prima chiamata registrata.`

- [ ] **Step 2: Replace obsolete chip copy only after verifying no consumers**

Run: `rg -n "heroChip" apps/desktop/src`

Expected before removal: matches only locale files. Remove the unused `chat.heroChip` trees from all five catalogs together.

- [ ] **Step 3: Implement minimal CSS**

Rules:

- `.chat-hero` remains centered but uses a wider max width;
- `.chat-usage-overview` has no decorative outer border or shadow;
- one top/bottom separator may use `var(--line)`;
- metric columns use whitespace, not nested containers;
- the composer remains at least 640px wide when space allows;
- at max-width 760px, metrics stack into two columns, then one below 520px;
- text uses `var(--text)`/`var(--text-muted)` and accents use `var(--brand)`;
- no fixed height that could hide the composer at 200% zoom.

- [ ] **Step 4: Run localization and production checks**

Run:

```bash
cd apps/desktop
npm run test:electron
npm run test:new-chat-usage
npm run test:ui-contract
npm run typecheck
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit layout and copy**

```bash
git add apps/desktop/src/styles.css apps/desktop/src/i18n/locales
git commit -m "style(chat): refine new-chat usage layout"
```

### Task 5: Phase D verification gate

**Files:**
- Verify only; no expected source edits.

- [ ] **Step 1: Run full desktop regression**

Run:

```bash
cd apps/desktop
npm run test:new-chat-usage
npm run test:usage-ui
npm run test:ui-contract
npm run test:electron
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Perform real Electron QA**

Verify on a fresh empty thread and a populated thread:

- no canned prompt examples;
- Homun mark, greeting and subtitle remain;
- 7d/30d/all update without flicker;
- composer remains the primary action;
- the overview disappears immediately after the first optimistic user message;
- returning to a new empty chat shows the overview again;
- loading/error/empty/partial states do not move the composer off-screen;
- keyboard and 200% zoom remain usable.

- [ ] **Step 3: Record corrections only if required**

If real QA changed source:

```bash
git add apps/desktop
git commit -m "fix(chat): close new-chat usage QA gaps"
```
