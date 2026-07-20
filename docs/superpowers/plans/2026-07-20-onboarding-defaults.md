# Onboarding Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fresh and factory-reset installations open Homun with a dark/teal appearance, readable model choices, and the canonical documentation URL.

**Architecture:** Keep defaults in the existing pre-render appearance bootstrap so saved preferences remain authoritative and every onboarding exit path behaves consistently. Add explicit foreground styling to the native model buttons and lock the behavior into the existing source-level UI contract before changing production code.

**Tech Stack:** React 19, TypeScript, CSS custom properties, Node.js UI contract, Vite, Electron.

---

### Task 1: Add the onboarding regression contract

**Files:**
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Write the failing assertions**

Add these assertions next to the existing appearance assertions:

```js
assertContains("src/components/OnboardingWizard.tsx", 'href="https://homun.app/docs/"', "onboarding must link to the canonical documentation site");
assertNotContains("src/components/OnboardingWizard.tsx", "https://docs.homun.app", "onboarding must not use the retired documentation host");
assertContains("src/lib/accent.ts", 'export const DEFAULT_THEME: ThemeName = "dark";', "fresh installs must default to the dark surface theme");
assertContains("src/lib/accent.ts", 'export const DEFAULT_ACCENT = "#157a6e";', "fresh installs must keep the Homun teal accent");
assertMatches(
  "src/styles.css",
  /\.onb-model\s*\{[^}]*color:\s*var\(--o-text\);[^}]*\}/m,
  "onboarding model buttons must explicitly use readable foreground text",
);
```

- [ ] **Step 2: Run the contract and verify the regression is exposed**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: FAIL first on the missing canonical documentation URL; the current source still contains `https://docs.homun.app`, the fallback theme is `freddo`, and `.onb-model` has no foreground color.

- [ ] **Step 3: Commit the red contract**

```bash
git add apps/desktop/scripts/check-ui-contract.mjs
git commit -m "test(onboarding): cover fresh appearance and docs defaults"
```

### Task 2: Implement the minimal defaults fix

**Files:**
- Modify: `apps/desktop/src/components/OnboardingWizard.tsx:342`
- Modify: `apps/desktop/src/lib/accent.ts:138`
- Modify: `apps/desktop/src/styles.css:15598-15608`

- [ ] **Step 1: Correct the documentation destination**

Replace the onboarding footer link with:

```tsx
<a href="https://homun.app/docs/" target="_blank" rel="noreferrer">
  Documentation
</a>
```

- [ ] **Step 2: Change only the unsaved theme fallback**

Replace the theme constant with:

```ts
export const DEFAULT_THEME: ThemeName = "dark";
```

Do not write theme state inside `finish()` or `skip()`: `loadTheme()` must continue returning a stored valid preference before this fallback.

- [ ] **Step 3: Give model buttons an explicit onboarding foreground**

Add the foreground declaration to `.onb-model` without changing its existing layout:

```css
.onb-model {
  color: var(--o-text);
```

- [ ] **Step 4: Run the focused contract**

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: PASS with `UI contract checks passed.`

- [ ] **Step 5: Commit the production fix**

```bash
git add apps/desktop/src/components/OnboardingWizard.tsx apps/desktop/src/lib/accent.ts apps/desktop/src/styles.css
git commit -m "fix(onboarding): use dark teal defaults and readable model cards"
```

### Task 3: Verify compiled and real fresh-state behavior

**Files:**
- Verify only; no production file is expected to change.

- [ ] **Step 1: Run the static and production build gates**

Run: `cd apps/desktop && npm run typecheck && npm run build`

Expected: both commands exit 0; Vite produces the desktop renderer bundle.

- [ ] **Step 2: Run the Electron regression suite**

Run: `cd apps/desktop && npm run test:electron`

Expected: all Electron tests pass with no failed test.

- [ ] **Step 3: Exercise an isolated fresh profile**

Launch the development Electron app with a temporary user-data directory or equivalent isolated profile, complete or skip onboarding, and verify:

```text
Documentation -> https://homun.app/docs/
Model titles -> white and legible on dark cards
First app screen -> dark surfaces with teal controls
Existing stored theme -> remains unchanged when reloaded
```

- [ ] **Step 4: Re-run the focused release evidence**

Run: `cd apps/desktop && npm run test:ui-contract && npm run typecheck && npm run build && npm run test:electron`

Expected: every command exits 0. Record exact totals and any intentionally ignored tests before reporting completion.

- [ ] **Step 5: Check the final diff**

Run: `git diff --check && git status --short && git log --oneline --decorate -4`

Expected: no whitespace errors; only the design, plan, regression contract, and three production files belong to this branch.
