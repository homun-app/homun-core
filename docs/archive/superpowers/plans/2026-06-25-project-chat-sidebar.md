# Project Chat Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project chat creation and project management discoverable from the sidebar, following the Codex-style project tree model.

**Architecture:** Keep the existing sidebar ownership in `Sidebar.tsx`. Use existing `coreBridge` workspace/chat APIs; no backend changes. Replace inline project editing with a shared project modal and expose row-hover project/thread actions.

**Tech Stack:** React, TypeScript, lucide-react, existing gateway bridge, CSS contract checks.

---

### Task 1: Project Row Actions

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/styles.css`

- [x] Add hover actions to each project row: compose new chat and context menu.
- [x] Implement project context menu with rename/settings, folder linking, reveal in Finder when folder exists, and delete.
- [x] Keep expand/collapse independent from workspace switching.

### Task 2: Unified Project Modal

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/styles.css`

- [x] Replace inline edit with the same modal pattern used for new project.
- [x] Support name and folder in both create and edit flows.
- [x] Save edit by applying rename and folder updates through existing bridge APIs.

### Task 3: Thread Row Actions

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/styles.css`

- [x] Show relative time on each chat row.
- [x] Reveal pin/archive/more actions on hover without requiring right-click.
- [x] Keep existing context menu as the overflow action.

### Task 4: Verification

**Files:**
- Test: `apps/desktop/scripts/check-ui-contract.mjs`

- [x] Run `npm run test:ui-contract`.
- [x] Run `npm run build`.
- [x] Run `git diff --check`.
