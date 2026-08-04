# Six-Month Usage Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the new-chat composer anchored at the bottom, give the two-line welcome and infographic deliberate vertical rhythm, and render a real-data activity heatmap over 26 week columns independently from the numeric Usage filter.

**Architecture:** Keep `UsageWindow` unchanged at the gateway boundary. Add a Home-only calendar window in the shared calendar view model, load the daily `all` series once, and keep summary/suggestion requests driven by `7d / 30d / all`. Render greeting headline and prompt as separate localized values, then restore the empty-chat shell to the standard three-row layout.

**Tech Stack:** React 19, TypeScript, i18next JSON catalogs, CSS Grid, Node test runner, Electron/Vite.

---

## File map

- `apps/desktop/src/lib/usageCalendar.ts`: typed Home-only 26-week calendar calculation.
- `apps/desktop/src/lib/usageCalendar.mjs`: testable runtime mirror of the calculation.
- `apps/desktop/src/lib/usageCalendar.test.mjs`: date range, coverage, and invariance tests.
- `apps/desktop/src/components/UsageCalendar.tsx`: accepts the Home window and keeps recent weeks visible when horizontally scrollable.
- `apps/desktop/src/components/ChatUsageOverview.tsx`: separates filtered summary state from the fixed daily series.
- `apps/desktop/src/components/ChatView.tsx`: renders the welcome as two semantic text levels.
- `apps/desktop/src/lib/chatGreeting.test.mjs`: validates the two-part localized catalog in every supported language.
- `apps/desktop/src/i18n/locales/{en,it,es,fr,de}.json`: stores `headline` and `prompt` independently for every curated greeting.
- `apps/desktop/src/styles.css`: spatial hierarchy, infographic alignment, and bottom composer layout.
- `apps/desktop/scripts/check-ui-contract.mjs`: static regression checks for the approved shell and data-flow boundaries.

### Task 1: Add the Home 26-week calendar window

**Files:**
- Modify: `apps/desktop/src/lib/usageCalendar.test.mjs`
- Modify: `apps/desktop/src/lib/usageCalendar.mjs`
- Modify: `apps/desktop/src/lib/usageCalendar.ts`

- [ ] **Step 1: Write the failing date-window tests**

Add these cases to `usageCalendar.test.mjs`:

```js
test("home calendar occupies 26 Sunday-based week columns and ends today", () => {
  const days = buildCalendarDays(seriesFixture, "home-26w", jul21 * 1_000);
  assert.equal(new Date(days[0].day_epoch * 1_000).getUTCDay(), 0);
  assert.equal(days.at(-1).day_epoch, jul21);
  assert.equal(Math.ceil(days.length / 7), 26);
  assert.ok(days.every((day) => day.day_epoch <= jul21));
});

test("home calendar preserves unavailable and covered zero days", () => {
  const days = buildCalendarDays(seriesFixture, "home-26w", jul21 * 1_000);
  assert.equal(days[0].state, "unavailable");
  assert.equal(days.find((day) => day.day_epoch === jul17).state, "zero");
  assert.equal(days.at(-1).state, "active");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd apps/desktop
node --test src/lib/usageCalendar.test.mjs
```

Expected: FAIL because `home-26w` currently falls through to the coverage-started `all` behavior and does not produce 26 week columns.

- [ ] **Step 3: Implement the window in both calendar modules**

In `usageCalendar.ts`, extend the display type without changing `coreBridge.UsageWindow`:

```ts
export type UsageWindowLike = "7d" | "30d" | "all";
export type UsageCalendarWindowLike = UsageWindowLike | "home-26w";

const DAY_SECONDS = 86_400;
const HOME_WEEK_COLUMNS = 26;

export function buildCalendarDays(
  series: UsageDailySeriesLike,
  window: UsageCalendarWindowLike,
  nowMs = Date.now(),
): CalendarDay[] {
  const offsetSeconds = clampOffset(series.timezone_offset_minutes) * 60;
  const todayEpoch = localDayEpoch(Math.floor(nowMs / 1_000), offsetSeconds);
  const coverageEpoch = series.coverage_started_at == null
    ? null
    : localDayEpoch(series.coverage_started_at, offsetSeconds);
  const weekday = new Date(todayEpoch * 1_000).getUTCDay();
  const homeStartEpoch = todayEpoch
    - (weekday + (HOME_WEEK_COLUMNS - 1) * 7) * DAY_SECONDS;
  const startEpoch = window === "7d"
    ? todayEpoch - 6 * DAY_SECONDS
    : window === "30d"
      ? todayEpoch - 29 * DAY_SECONDS
      : window === "home-26w"
        ? homeStartEpoch
        : coverageEpoch ?? todayEpoch;
  const points = new Map((series.days ?? []).map((point) => [point.day_epoch, point]));
  const days: CalendarDay[] = [];
  for (let dayEpoch = startEpoch; dayEpoch <= todayEpoch; dayEpoch += DAY_SECONDS) {
    const point = points.get(dayEpoch) ?? emptyPoint(dayEpoch);
    const covered = coverageEpoch != null && dayEpoch >= coverageEpoch;
    const active = covered
      && (finiteNonnegative(point.attempts) > 0 || totalTokens(point) > 0);
    days.push({
      ...emptyPoint(dayEpoch),
      ...point,
      day_epoch: dayEpoch,
      state: !covered ? "unavailable" : active ? "active" : "zero",
      intensity: 0,
    });
  }
  const activeDays = days.filter((day) => day.state === "active");
  const levels = usageIntensityLevels(activeDays.map((day) => totalTokens(day) || 1));
  activeDays.forEach((day, index) => { day.intensity = levels[index] || 1; });
  return days;
}
```

Apply the same constants and branch in `usageCalendar.mjs`, omitting TypeScript annotations.

- [ ] **Step 4: Run the calendar tests and verify GREEN**

Run:

```bash
cd apps/desktop
node --test src/lib/usageCalendar.test.mjs
```

Expected: all calendar tests PASS, including the existing `7d`, `30d`, and `all` behavior.

- [ ] **Step 5: Commit the calendar view model**

```bash
git add apps/desktop/src/lib/usageCalendar.ts \
  apps/desktop/src/lib/usageCalendar.mjs \
  apps/desktop/src/lib/usageCalendar.test.mjs
git commit -m "feat(usage-ui): add fixed home activity window"
```

### Task 2: Separate daily activity from filtered summary data

**Files:**
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`
- Modify: `apps/desktop/src/components/ChatUsageOverview.tsx`
- Modify: `apps/desktop/src/components/UsageCalendar.tsx`

- [ ] **Step 1: Write failing UI contract checks**

Replace the broad daily-usage assertion in `check-ui-contract.mjs` with exact Home requirements:

```js
assertContains(
  "src/components/ChatUsageOverview.tsx",
  'coreBridge.usageDaily("all", timezoneOffsetMinutes)',
  "Home heatmap must load the full canonical daily series independently",
);
assertContains(
  "src/components/ChatUsageOverview.tsx",
  'window="home-26w"',
  "Home heatmap must render the fixed 26-week display window",
);
assertNotContains(
  "src/components/ChatUsageOverview.tsx",
  "coreBridge.usageDaily(selectedWindow",
  "Changing summary filters must not change the Home heatmap range",
);
assertContains(
  "src/components/UsageCalendar.tsx",
  "scrollNode.scrollLeft = scrollNode.scrollWidth",
  "Overflowing Home calendars must begin on the newest weeks",
);
```

- [ ] **Step 2: Run the contract and verify RED**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
```

Expected: FAIL because daily usage still receives `selectedWindow`, the calendar prop is not `home-26w`, and no recent-week scroll alignment exists.

- [ ] **Step 3: Widen the calendar component's display-only type**

In `UsageCalendar.tsx`, import `UsageCalendarWindowLike` from `usageCalendar`, change the prop type, and add a scroll ref:

```tsx
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
} from "react";
import type { UsageDailySeries } from "../lib/coreBridge";
import {
  buildCalendarDays,
  resolvedProviderLabel,
  routeLabel,
  totalKnownCost,
  totalTokens,
  type CalendarDay,
  type UsageCalendarWindowLike,
} from "../lib/usageCalendar";

interface UsageCalendarProps {
  series: UsageDailySeries;
  window: UsageCalendarWindowLike;
  locale?: string;
  density?: "compact" | "comfortable";
  onSelectDay?: (dayEpoch: number) => void;
  providerLabels?: Record<string, string>;
}

const scrollRef = useRef<HTMLDivElement>(null);
const lastDayEpoch = days.at(-1)?.day_epoch ?? null;

useEffect(() => {
  if (window !== "home-26w") return;
  const scrollNode = scrollRef.current;
  if (scrollNode) scrollNode.scrollLeft = scrollNode.scrollWidth;
}, [window, days.length, lastDayEpoch]);
```

Attach `ref={scrollRef}` to `.usage-calendar-scroll`. Keep the existing tooltip and keyboard behavior unchanged.

- [ ] **Step 4: Split summary and calendar loading in ChatUsageOverview**

Replace the single combined loader with two independent callbacks and states:

```tsx
const [summaryLoading, setSummaryLoading] = useState(true);
const [summaryError, setSummaryError] = useState(false);
const [calendarLoading, setCalendarLoading] = useState(true);
const [calendarError, setCalendarError] = useState(false);
const summaryGenerationRef = useRef(0);
const calendarGenerationRef = useRef(0);

const loadSummary = useCallback(async (selectedWindow: UsageWindow) => {
  const generation = ++summaryGenerationRef.current;
  setSummaryLoading(true);
  setSummaryError(false);
  try {
    const nextSummary = await coreBridge.usageSummary(selectedWindow);
    if (summaryGenerationRef.current === generation) setSummary(nextSummary);
  } catch {
    if (summaryGenerationRef.current === generation) setSummaryError(true);
  } finally {
    if (summaryGenerationRef.current === generation) setSummaryLoading(false);
  }
}, []);

const loadCalendar = useCallback(async () => {
  const generation = ++calendarGenerationRef.current;
  setCalendarLoading(true);
  setCalendarError(false);
  try {
    const timezoneOffsetMinutes = -new Date().getTimezoneOffset();
    const [nextDaily, providers] = await Promise.all([
      coreBridge.usageDaily("all", timezoneOffsetMinutes),
      coreBridge.providers().catch(() => null),
    ]);
    if (calendarGenerationRef.current !== generation) return;
    setDaily(nextDaily);
    if (providers) {
      setProviderLabels(Object.fromEntries(
        providers.providers.map((provider) => [provider.id, provider.label]),
      ));
    }
  } catch {
    if (calendarGenerationRef.current === generation) setCalendarError(true);
  } finally {
    if (calendarGenerationRef.current === generation) setCalendarLoading(false);
  }
}, []);
```

Use one effect keyed by `window` for `loadSummary(window)` and one mount-only effect for `loadCalendar()`. Increment the matching generation ref in each cleanup.

Render the calendar whenever `daily` exists, even when the filtered summary is empty:

```tsx
{daily && (
  <div className="chat-usage-infographic">
    <UsageCalendar
      series={daily}
      window="home-26w"
      locale={i18n.resolvedLanguage}
      density="compact"
      providerLabels={providerLabels}
    />
    <div className="chat-usage-summary">
      {rows?.kind === "ready" && summary ? (
        <>
          <UsageMetric
            label={t("settings.usage.metrics.calls")}
            value={formatCount(summary.logical_calls, i18n.resolvedLanguage)}
          />
          <UsageMetric
            label={t("chat.usageOverview.tokens")}
            value={formatCount(totalTokens, i18n.resolvedLanguage)}
          />
          <UsageMetric
            label={t("chat.usageOverview.cost")}
            value={formatMicrousd(summary.cost_microusd, i18n.resolvedLanguage)}
          />
          <UsageMetric
            label={t("chat.usageOverview.dataQuality")}
            value={`${coverage}%`}
            tone={coverage < 100 ? "warning" : undefined}
          />
          <div className="chat-usage-route">
            <span>{t("chat.usageOverview.route")}</span>
            <strong title={dominantRoute}>{dominantRoute}</strong>
          </div>
        </>
      ) : (
        <p className="chat-usage-empty">{t("chat.usageOverview.empty")}</p>
      )}
    </div>
  </div>
)}
```

The polite status region must expose independent retry actions:

```tsx
{summaryLoading && !summary && t("chat.usageOverview.loading")}
{calendarLoading && !daily && t("chat.usageOverview.loading")}
{summaryError && (
  <button type="button" onClick={() => void loadSummary(window)}>
    {t("chat.usageOverview.retry")}
  </button>
)}
{calendarError && (
  <button type="button" onClick={() => void loadCalendar()}>
    {t("chat.usageOverview.retry")}
  </button>
)}
```

- [ ] **Step 5: Run contract, calendar tests, and typecheck**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
npm run test:usage-infographic
npm run typecheck
```

Expected: all commands exit 0; the contract proves the fixed daily range and TypeScript accepts the display-only window.

- [ ] **Step 6: Commit the independent data flows**

```bash
git add apps/desktop/scripts/check-ui-contract.mjs \
  apps/desktop/src/components/ChatUsageOverview.tsx \
  apps/desktop/src/components/UsageCalendar.tsx
git commit -m "feat(usage-ui): decouple home heatmap from filters"
```

### Task 3: Split every curated greeting into headline and prompt

**Files:**
- Modify: `apps/desktop/src/lib/chatGreeting.test.mjs`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/i18n/locales/fr.json`
- Modify: `apps/desktop/src/i18n/locales/de.json`
- Modify: `apps/desktop/src/components/ChatView.tsx:8845-8881`

- [ ] **Step 1: Write a failing catalog-shape test**

Extend `chatGreeting.test.mjs`:

```js
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("every locale exposes separate greeting headline and prompt text", () => {
  for (const locale of ["en", "it", "es", "fr", "de"]) {
    const catalog = JSON.parse(readFileSync(join(here, `../i18n/locales/${locale}.json`), "utf8"));
    for (const context of ["named", "anonymous", "project", "returning"]) {
      for (const index of ["0", "1", "2", "3"]) {
        const entry = catalog.chat.greetings[context][index];
        assert.equal(typeof entry.headline, "string", `${locale}.${context}.${index}.headline`);
        assert.equal(typeof entry.prompt, "string", `${locale}.${context}.${index}.prompt`);
        assert.ok(entry.headline.trim().length > 0);
        assert.ok(entry.prompt.trim().length > 0);
      }
    }
  }
});
```

- [ ] **Step 2: Run the greeting test and verify RED**

Run:

```bash
cd apps/desktop
node --test src/lib/chatGreeting.test.mjs
```

Expected: FAIL because each catalog entry is currently a single string.

- [ ] **Step 3: Convert all five greeting catalogs**

For every `named`, `anonymous`, `project`, and `returning` entry, use this exact object shape:

```json
"0": {
  "headline": "{{salutation}}, {{name}}.",
  "prompt": "Where should we start?"
}
```

Preserve each locale's existing curated copy by placing the salutation sentence in `headline` and the remaining sentence in `prompt`. For anonymous, project, and returning variants, `headline` is the localized `{{salutation}}.`; the existing contextual sentence becomes `prompt`. Do not translate, rewrite, or combine phrases during this mechanical split.

Italian named example:

```json
"0": {
  "headline": "{{salutation}}, {{name}}.",
  "prompt": "Da dove cominciamo?"
}
```

Italian project example:

```json
"0": {
  "headline": "{{salutation}}.",
  "prompt": "Riprendiamo il progetto?"
}
```

- [ ] **Step 4: Render the two translation leaves in ChatEmptyHero**

Replace the combined `greeting` value and single heading with:

```tsx
const interpolation = {
  name: displayName.trim(),
  salutation: t(`chat.greetings.period.${period}`),
};
const greetingHeadline = t(`${greetingKey}.headline`, interpolation);
const greetingPrompt = t(`${greetingKey}.prompt`, interpolation);

return (
  <div className="chat-hero">
    <div className="chat-hero-welcome">
      <h1 className="chat-hero-headline">{greetingHeadline}</h1>
      <p className="chat-hero-prompt">{greetingPrompt}</p>
    </div>
    <ChatUsageOverview
      threadId={thread.threadId}
      onOpenUsageSettings={onOpenUsageSettings}
      onUseForTask={onUseForTask}
    />
  </div>
);
```

- [ ] **Step 5: Run greeting and locale parity tests**

Run:

```bash
cd apps/desktop
node --test src/lib/chatGreeting.test.mjs
node --test tests/i18n-parity.test.mjs
```

Expected: both suites PASS and all locales have identical key structure.

- [ ] **Step 6: Commit the typographic greeting model**

```bash
git add apps/desktop/src/lib/chatGreeting.test.mjs \
  apps/desktop/src/i18n/locales/en.json \
  apps/desktop/src/i18n/locales/it.json \
  apps/desktop/src/i18n/locales/es.json \
  apps/desktop/src/i18n/locales/fr.json \
  apps/desktop/src/i18n/locales/de.json \
  apps/desktop/src/components/ChatView.tsx
git commit -m "feat(chat-ui): split welcome typography"
```

### Task 4: Restore the bottom composer and create deliberate spatial rhythm

**Files:**
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`
- Modify: `apps/desktop/src/styles.css:2605-2713`
- Modify: `apps/desktop/src/styles.css:7178-7420`
- Modify: `apps/desktop/src/styles.css:7520-7555`

- [ ] **Step 1: Add failing layout contract assertions**

Replace the old narrow empty-chat rule assertion with:

```js
assertContains(
  "src/styles.css",
  ".active-task-layout.is-empty {\n  grid-template-rows: 58px minmax(0, 1fr) auto;",
  "Empty chat must keep the composer in the standard bottom row",
);
assertNotContains(
  "src/styles.css",
  "grid-template-rows: 58px 1fr auto 1fr",
  "Empty chat must not vertically center the composer with a balancing row",
);
assertContains("src/components/ChatView.tsx", "chat-hero-headline", "Welcome needs a primary typographic line");
assertContains("src/components/ChatView.tsx", "chat-hero-prompt", "Welcome needs a secondary typographic line");
assertContains("src/styles.css", ".chat-hero-welcome", "Welcome hierarchy needs a dedicated layout group");
```

- [ ] **Step 2: Run the UI contract and verify RED**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
```

Expected: FAIL because the four-row centered composer and old single title class are still present.

- [ ] **Step 3: Restore the three-row empty layout**

Replace the centered empty-chat override near the main layout with:

```css
.active-task-layout.is-empty {
  grid-template-rows: 58px minmax(0, 1fr) auto;
}
.active-task-layout.is-empty .thread-scroll {
  overflow-y: auto;
  overflow-x: hidden;
}
```

Remove the old `justify-content: flex-end`, four-row balancing rule, and the mobile `58px auto auto minmax(24px, 1fr)` override. At `max-width: 760px`, retain the same three rows and allow `.thread-scroll` to own vertical scrolling.

- [ ] **Step 4: Implement the approved welcome and infographic spacing**

Replace the old `.chat-hero-title` styling with:

```css
.chat-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(100%, 920px);
  box-sizing: border-box;
  margin-inline: auto;
  padding: clamp(40px, 7vh, 76px) 24px 40px;
  text-align: center;
}
.chat-hero-welcome {
  display: grid;
  justify-items: center;
  gap: clamp(8px, 1vh, 10px);
  max-width: 760px;
}
.chat-hero-headline {
  margin: 0;
  color: var(--text);
  font-family: var(--font-sans);
  font-size: clamp(28px, 2.6vw, 34px);
  font-weight: 620;
  letter-spacing: -0.03em;
  line-height: 1.12;
  text-wrap: balance;
}
.chat-hero-prompt {
  margin: 0;
  color: var(--muted);
  font-size: clamp(14px, 1.25vw, 16px);
  font-weight: 400;
  line-height: 1.45;
  text-wrap: balance;
}
.chat-usage-overview {
  width: 100%;
  margin-top: clamp(36px, 6vh, 72px);
  padding: 14px 16px 12px;
  box-sizing: border-box;
  border-radius: 15px;
  background: color-mix(in srgb, var(--surface-muted) 64%, transparent);
  text-align: left;
}
```

For the compact calendar, replace centered flex scrolling with safe centering:

```css
.chat-usage-infographic .usage-calendar-scroll {
  display: block;
}
.chat-usage-infographic .usage-calendar-grid {
  margin-inline: auto;
}
.chat-usage-infographic .usage-calendar-legend {
  justify-content: center;
}
```

At `max-width: 760px`, use these compact rules:

```css
.chat-hero {
  padding: 32px 16px 28px;
}
.chat-usage-overview {
  margin-top: 32px;
}
.chat-usage-infographic {
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
}
.chat-usage-summary {
  padding: 12px 0 0;
  border-left: 0;
  border-top: 1px solid var(--line);
}
```

- [ ] **Step 5: Run contract and focused UI tests**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
npm run test:usage-infographic
npm run test:new-chat-usage
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the spatial layout**

```bash
git add apps/desktop/scripts/check-ui-contract.mjs apps/desktop/src/styles.css
git commit -m "feat(chat-ui): anchor composer below usage home"
```

### Task 5: Run full gates and verify the rendered desktop app

**Files:**
- Modify only if a verified regression requires a focused fix and a new failing test.

- [ ] **Step 1: Run the complete frontend gate**

Run:

```bash
cd apps/desktop
npm run test:electron
npm run test:usage-ui
npm run test:new-chat-usage
npm run test:usage-infographic
npm run test:ui-contract
npm run typecheck
npm run build
```

Expected: every command exits 0. Existing Vite chunk-size warnings may be reported, but no test, type, or build error is allowed.

- [ ] **Step 2: Build the unsigned local macOS package**

Run:

```bash
cd apps/desktop
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
hdiutil verify dist-installers/Homun-0.1.1-arm64.dmg
```

Expected: Electron Builder exits 0 and `hdiutil` reports a valid checksum.

- [ ] **Step 3: Launch only the new package for visual verification**

Close any already-running Homun instance, then run:

```bash
open -n "$PWD/dist-installers/mac-arm64/Homun.app" --args --use-mock-keychain
```

Expected: the packaged app opens using the real local Usage ledger without blocking on the unsigned build's Keychain identity.

- [ ] **Step 4: Verify the real UI at target widths**

Check the live app at approximately 1280 px and 760 px:

- the headline and secondary prompt are distinct and remain stable;
- the infographic has 36–72 px of breathing room below the welcome on desktop;
- the composer stays in the bottom row before and after the first message;
- the calendar spans 26 weekly columns and ends on the current date;
- `7d / 30d / all` changes numbers but not calendar endpoints;
- pre-coverage days are unavailable, not zero;
- horizontal overflow opens on the newest weeks;
- hover and keyboard focus show the real provider-qualified day tooltip;
- dark and light themes preserve contrast and spacing.

- [ ] **Step 5: Check repository scope**

Run:

```bash
git diff --check
git status --short --branch
```

Expected: no unstaged implementation changes remain after the task commits, and no unrelated root-worktree files appear in this feature worktree.
