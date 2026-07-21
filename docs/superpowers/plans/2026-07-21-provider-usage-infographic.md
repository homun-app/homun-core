# Provider Usage Infographic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current text-heavy Usage surfaces with a real-data daily infographic, stable dynamic greetings, and provider-qualified model accounting.

**Architecture:** The append-only inference ledger remains canonical. The gateway adds daily and provider-model route read models; the desktop bridge consumes them through shared pure calendar helpers and one accessible calendar component used by both new chat and Settings. Greeting selection, calendar completion, intensity, and formatting stay deterministic and testable.

**Tech Stack:** Rust, rusqlite/SQLite, Axum, React 19, TypeScript, CSS, i18next, Node test runner.

---

## File map

- Modify `crates/desktop-gateway/src/usage_store.rs`: daily series, dominant route, and provider-model aggregation.
- Modify `crates/desktop-gateway/src/main.rs`: daily endpoint, enriched summary, and route-aware models response.
- Modify `apps/desktop/src/lib/coreBridge.ts`: exact daily and route contracts.
- Create `apps/desktop/src/lib/usageCalendar.{ts,mjs}` and test: calendar completion and intensity.
- Create `apps/desktop/src/lib/chatGreeting.{ts,mjs}` and test: stable curated greeting selection.
- Create `apps/desktop/src/components/UsageCalendar.tsx`: shared accessible contribution calendar.
- Modify `apps/desktop/src/components/ChatUsageOverview.tsx`: compact infographic.
- Modify `apps/desktop/src/components/UsageSettingsPane.tsx`: full infographic and provider-qualified models.
- Modify `apps/desktop/src/components/ChatView.tsx` and `apps/desktop/src/App.tsx`: greeting and Settings navigation.
- Modify `apps/desktop/src/styles.css`, five locale catalogs, package scripts, and UI contracts.

### Task 1: Add truthful daily and provider-model read models

**Files:**
- Modify: `crates/desktop-gateway/src/usage_store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write the failing provider-route test**

Add a provider/model fixture and this test:

```rust
#[test]
fn model_routes_keep_equal_models_separate_by_provider() {
    let store = UsageStore::open_in_memory().unwrap();
    store.append(&completed_route_fixture("a", "ollama-local", "qwen", 100, 10, 86_400)).unwrap();
    store.append(&completed_route_fixture("b", "ollama-cloud", "qwen", 200, 20, 86_400)).unwrap();
    let routes = store.model_routes("local", UsageWindow::All, 172_800).unwrap();
    assert_eq!(routes.len(), 2);
    assert_eq!((&routes[0].provider_id, &routes[0].model_id), ("ollama-cloud", "qwen"));
    assert_eq!((&routes[1].provider_id, &routes[1].model_id), ("ollama-local", "qwen"));
}
```

- [ ] **Step 2: Run RED**

Run: `cargo test -p local-first-desktop-gateway model_routes_keep_equal_models_separate_by_provider --lib`

Expected: compile failure because the fixture and `model_routes` are absent.

- [ ] **Step 3: Implement provider-model aggregation**

Add a serializable `UsageRouteRow` with explicit `provider_id`, `model_id`, the existing counters, and `UsageCostBreakdown`. Query terminal events grouped by both normalized columns and sort by input + output + reasoning tokens, with provider/model stable ties.

- [ ] **Step 4: Run GREEN**

Run: `cargo test -p local-first-desktop-gateway model_routes_keep_equal_models_separate_by_provider --lib`

Expected: one test passes.

- [ ] **Step 5: Write failing daily-series tests**

```rust
#[test]
fn daily_series_uses_local_day_and_same_pair_for_dominant_route() {
    let store = UsageStore::open_in_memory().unwrap();
    store.append(&completed_route_fixture("a", "ollama-local", "qwen", 100, 10, 86_100)).unwrap();
    store.append(&completed_route_fixture("b", "openrouter", "qwen", 300, 20, 86_500)).unwrap();
    let series = store.daily_series("local", UsageWindow::SevenDays, 172_800, 60).unwrap();
    assert_eq!(series.days.len(), 1);
    assert_eq!(series.days[0].day_epoch, 86_400);
    assert_eq!(series.days[0].dominant_provider.as_deref(), Some("openrouter"));
    assert_eq!(series.days[0].dominant_model.as_deref(), Some("qwen"));
}
```

Add another test asserting `coverage_started_at` is the earliest real terminal event and no zero rows are fabricated by the store.

- [ ] **Step 6: Run daily RED**

Run: `cargo test -p local-first-desktop-gateway daily_series_ --lib`

Expected: compile failure because `daily_series` is absent.

- [ ] **Step 7: Implement `UsageDailySeries`**

Add `UsageDailySeries` with `coverage_started_at`, `generated_at`, `timezone_offset_minutes`, and `days`. Each `UsageDailyPoint` contains the local `day_epoch`, call/attempt/outcome counters, five token counters, `UsageCostBreakdown`, and one `dominant_provider`/`dominant_model` pair. Query the raw terminal-event ledger so distinct calls and cost provenance stay exact. Clamp timezone offset to `-840..=840` and derive the dominant pair from the same grouped route row.

- [ ] **Step 8: Enrich summary and routes**

Add `dominant_provider: Option<String>` to `UsageSummary`. Replace the model-only winner query with one grouped by provider and model, then assign both fields from that row. Register `GET /api/usage/daily`, parse a defaulted `timezone_offset_minutes`, and make `/api/usage/models` return `model_routes`.

- [ ] **Step 9: Run backend GREEN**

```bash
cargo test -p local-first-desktop-gateway usage_store::tests --lib
cargo test -p local-first-desktop-gateway --lib get_usage
```

Expected: all matching tests pass.

- [ ] **Step 10: Commit**

```bash
git add crates/desktop-gateway/src/usage_store.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(usage): expose daily provider-qualified analytics"
```

### Task 2: Add pure calendar and greeting behavior

**Files:**
- Create: `apps/desktop/src/lib/usageCalendar.ts`
- Create: `apps/desktop/src/lib/usageCalendar.mjs`
- Create: `apps/desktop/src/lib/usageCalendar.test.mjs`
- Create: `apps/desktop/src/lib/chatGreeting.ts`
- Create: `apps/desktop/src/lib/chatGreeting.mjs`
- Create: `apps/desktop/src/lib/chatGreeting.test.mjs`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Write failing calendar tests**

```javascript
test("covered missing days are zero while pre-coverage days are unavailable", () => {
  const days = buildCalendarDays(seriesFixture, "7d", Date.UTC(2026, 6, 21));
  assert.equal(days[0].state, "unavailable");
  assert.equal(days[4].state, "zero");
  assert.equal(days[6].state, "active");
});

test("a single outlier does not flatten every active day", () => {
  assert.deepEqual(usageIntensityLevels([10, 20, 30, 10_000]), [1, 2, 3, 4]);
});

test("route label contains the real provider and model", () => {
  assert.equal(routeLabel({ dominant_provider: "ollama-cloud", dominant_model: "qwen" }), "ollama-cloud → qwen");
});
```

- [ ] **Step 2: Run calendar RED**

Run: `cd apps/desktop && node --test src/lib/usageCalendar.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement calendar helpers and run GREEN**

Implement identical `.ts` and `.mjs` exports: `buildCalendarDays`, `usageIntensityLevels`, `totalTokens`, `routeLabel`, and callout projections. Use UTC accessors for the synthetic local-day epoch. Then rerun the calendar test and expect all tests to pass.

- [ ] **Step 4: Write failing greeting tests**

```javascript
test("the same seed stays stable", () => {
  assert.equal(selectGreetingKey({ hour: 9, hasName: true, seed: "thread-a" }), selectGreetingKey({ hour: 9, hasName: true, seed: "thread-a" }));
});

test("different seeds rotate through the curated catalog", () => {
  const keys = new Set(["a", "b", "c", "d"].map((seed) => selectGreetingKey({ hour: 15, hasName: true, seed })));
  assert.ok(keys.size > 1);
});

test("night and morning use different periods", () => {
  assert.notEqual(greetingPeriod(23), greetingPeriod(8));
});
```

- [ ] **Step 5: Run greeting RED**

Run: `cd apps/desktop && node --test src/lib/chatGreeting.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 6: Implement greeting selection and run GREEN**

Export `greetingPeriod(hour)` and `selectGreetingKey({ hour, hasName, hasProject, returning, seed })`. Return translation keys only; hash the seed deterministically. Add `test:usage-infographic` to run both new test files, then run it and expect all tests to pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/lib/usageCalendar.* apps/desktop/src/lib/chatGreeting.* apps/desktop/package.json
git commit -m "feat(usage-ui): define calendar and greeting behavior"
```

### Task 3: Build the shared accessible calendar

**Files:**
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Create: `apps/desktop/src/components/UsageCalendar.tsx`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing UI contracts**

```javascript
assertContains("src/lib/coreBridge.ts", "usageDaily:", "Usage must expose the real daily series");
assertContains("src/components/UsageCalendar.tsx", 'role="grid"', "Calendar must expose a grid");
assertContains("src/components/UsageCalendar.tsx", 'role="gridcell"', "Days must be keyboard reachable");
assertContains("src/components/UsageCalendar.tsx", "onFocus", "Focus must reveal day details");
assertContains("src/components/UsageCalendar.tsx", "dominant_provider", "Callout must preserve provider provenance");
```

- [ ] **Step 2: Run contracts for RED**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: failure on the missing bridge/component.

- [ ] **Step 3: Add bridge contracts**

Define `UsageDailySeries`, `UsageDailyPoint`, `UsageRouteIdentity`, and provider-qualified `UsageModelRow`. Add `usageDaily(window, timezoneOffsetMinutes)` and encode both query parameters using `URLSearchParams`.

- [ ] **Step 4: Implement `UsageCalendar`**

Accept series, window, locale, density, and optional day selection. Render a week-column contribution grid, text legend, and one shared floating callout for hover/focus. Buttons use date-based accessible names and `aria-describedby`; unavailable dates remain described and visually distinct.

- [ ] **Step 5: Run GREEN**

```bash
cd apps/desktop
npm run test:ui-contract
npm run test:usage-infographic
npm run typecheck
```

Expected: all commands pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/coreBridge.ts apps/desktop/src/components/UsageCalendar.tsx apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(usage-ui): add accessible real-data calendar"
```

### Task 4: Redesign the real new-chat surface

**Files:**
- Modify: `apps/desktop/src/components/ChatUsageOverview.tsx`
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/i18n/locales/{en,it,es,fr,de}.json`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing new-chat contracts**

Reject `chat-hero-mark` and `chat.emptyHeroSub`; require `selectGreetingKey`, `UsageCalendar`, `usageDaily`, a provider-model route label, and `onOpenUsageSettings`.

- [ ] **Step 2: Run RED**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: failure because the old brandmark, subtitle, and metric strip remain.

- [ ] **Step 3: Implement the greeting**

Read `displayName` with `useSetting`. Initialize one greeting key from the hour, project presence, thread id, and `CHAT_VIEW_SESSION_ID`; never recompute it on Usage refresh. Remove the SVG and fixed paragraph.

- [ ] **Step 4: Implement the compact infographic**

Load summary and daily series together with request-generation race safety. Render the period control, shared calendar, four concise metrics, real dominant route, and Settings action. Keep prior successful data during refresh and explicit empty/partial states.

- [ ] **Step 5: Wire Settings navigation**

Pass `onOpenUsageSettings` from `App` through `ChatView` and `ChatEmptyHero`. Store the current view, select `usage`, clear the sub-section, and open Settings.

- [ ] **Step 6: Add copy and CSS**

Add matching curated greeting and infographic keys to all five locales. Replace the five-column strip with one quiet surface, contribution grid, four teal levels, compact tabular figures, edge-safe tooltip, and responsive rules. Do not add nested bordered cards.

- [ ] **Step 7: Run GREEN**

```bash
cd apps/desktop
npm run test:new-chat-usage
npm run test:usage-infographic
npm run test:ui-contract
npm run typecheck
```

Expected: all commands pass.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/components/ChatUsageOverview.tsx apps/desktop/src/components/ChatView.tsx apps/desktop/src/App.tsx apps/desktop/src/styles.css apps/desktop/src/i18n/locales apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(chat): replace usage strip with real infographic"
```

### Task 5: Redesign `Settings → Usage`

**Files:**
- Modify: `apps/desktop/src/components/UsageSettingsPane.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/i18n/locales/{en,it,es,fr,de}.json`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing Settings contracts**

Require `UsageCalendar` in Overview, explicit `provider_id` and `model_id` rendering in Models, and existing separate reported/estimated/unknown cost classes. Reject the old eight-cell `.usage-metrics` grid.

- [ ] **Step 2: Run RED**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: failure because Settings still renders the flat grid and model-only key.

- [ ] **Step 3: Load daily data**

Add `daily` to `UsageData` and the existing race-safe `Promise.all`. Keep prior complete data visible during refresh and supply the browser timezone offset.

- [ ] **Step 4: Rebuild Overview and Models**

Place the real calendar first, followed by a concise summary rail and semantic cost/coverage sections. Render Models as `provider → model`, with both values available to assistive technology and the pair as React key. Sort without collapsing identical model ids.

- [ ] **Step 5: Refine remaining views and CSS**

Preserve Provider/Process behavior while aligning typography, spacing, meters, and empty states. At wide widths use calendar plus summary rail; below 900 px stack them. Tables scroll only their axis and never clip provider/model.

- [ ] **Step 6: Run frontend GREEN**

```bash
cd apps/desktop
npm run test:usage-ui
npm run test:usage-infographic
npm run test:new-chat-usage
npm run test:ui-contract
npm run test:electron
npm run typecheck
npm run build
```

Expected: all commands pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/components/UsageSettingsPane.tsx apps/desktop/src/styles.css apps/desktop/src/i18n/locales apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(settings): make Usage a provider-aware infographic"
```

### Task 6: Verify real data and rendered behavior

**Files:**
- Modify only files required by defects found during verification.

- [ ] **Step 1: Run final gates**

```bash
cargo test -p local-first-desktop-gateway usage_store::tests --lib
cargo test -p local-first-desktop-gateway --lib
cd apps/desktop
npm run test:usage-ui
npm run test:usage-infographic
npm run test:new-chat-usage
npm run test:ui-contract
npm run test:electron
npm run typecheck
npm run build
```

Expected: all applicable tests pass; pre-existing warnings are reported separately.

- [ ] **Step 2: Verify API truth**

Start gateway and frontend with the existing Homun profile. Compare `/api/usage/summary`, `/api/usage/daily`, and `/api/usage/models` with Home and Settings. Confirm equal model ids from different providers remain separate.

- [ ] **Step 3: Verify the real rendered app**

Use the in-app browser at desktop-wide and about 1280 px. Test periods, hover, keyboard focus, tooltip edges, Settings navigation, long route names, dark theme, and light-theme regression. Capture screenshots only from the implemented app.

- [ ] **Step 4: Fix defects through RED/GREEN**

For each behavioral defect, add a focused failing test or contract, verify RED, implement the smallest correction, then repeat its automated and visual check.

- [ ] **Step 5: Audit the diff**

```bash
git diff --check main...HEAD
git status --short
git log --oneline main..HEAD
```

Expected: no whitespace errors, only scoped files changed, and no user-owned root-worktree files staged.

- [ ] **Step 6: Commit verification fixes if present**

Stage only files touched for this feature and commit them as `fix(usage-ui): resolve rendered infographic defects`.
