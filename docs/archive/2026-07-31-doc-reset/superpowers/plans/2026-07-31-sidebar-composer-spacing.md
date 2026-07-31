# Sidebar and Composer Spacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine sidebar hover/active surfaces and composer menu spacing without changing behavior.

**Architecture:** Extend the existing static cursor-grammar contract, then adjust only the three
owned style modules. Existing React markup and layered-menu state remain unchanged.

**Tech Stack:** CSS custom properties, React/Electron, Node `node:test`.

---

### Task 1: Lock the spacing contract

**Files:**
- Modify: `apps/desktop/tests/cursor-grammar-ui.test.mjs`

- [x] Add assertions requiring a 32px base menu row, a 44px descriptive mode row, full-row sidebar
  hover, stable trailing actions, and compact composer spacing.
- [x] Run `cd apps/desktop && npm run test:cursor-grammar` and verify failure on the new selectors.

### Task 2: Refine owned styles

**Files:**
- Modify: `apps/desktop/src/styles/menus.css`
- Modify: `apps/desktop/src/styles/composer.css`
- Modify: `apps/desktop/src/styles/sidebar.css`

- [x] Set one-line menu rows to 32px and descriptive composer mode rows to a 44px minimum with
  separate title/description line heights.
- [x] Give menu borders 6px internal padding and search 32px height without changing placement.
- [x] Normalize composer outer margin, tray spacing, prompt padding, and metadata separation.
- [x] Give sidebar project/thread rows a shared 30px rhythm, inset full-row hover, stable active fill,
  and action controls that inherit the row surface without a nested border.
- [x] Re-run cursor grammar and UI contract tests until green.

### Task 3: Verify the real desktop

**Files:**
- No production changes expected.

- [x] Run Electron tests, typecheck, and production build.
- [x] Inspect Add and Mode menus for overlap and balanced margins.
- [x] Inspect sidebar hover, active, timestamps, and action reveal in dark and Cold themes.
- [x] Prepare the verified implementation for commit.
