# Sidebar and Composer Spacing Refinement

**Date:** 2026-07-31

**Status:** Approved

## Goal

Refine spacing, margins, and interaction surfaces in the desktop sidebar and composer menus without
changing navigation, menu ownership, themes, or agent-loop behavior.

## Scope

- Keep the floating Homun sidebar shape and all existing themes.
- Give project and conversation rows one consistent compact rhythm.
- Render hover as a quiet full-row surface and active as the same surface with slightly stronger
  contrast; do not add borders, pills, or layout movement.
- Keep thread time and actions in the same stable trailing region so hover cannot resize a row.
- Use 32px rows for one-line menu commands.
- Use content-aware rows with a 44px minimum for mode entries that contain title and description.
- Increase internal menu/search padding enough to separate content from the border while keeping the
  overall menu compact.
- Clarify the vertical relationship between prompt, attachment trays, and metadata without enlarging
  the composer.
- Leave transcript typography and message layout unchanged.

## Interaction Contract

- Hover, focus-visible, and active states share geometry and differ only in color.
- Disabled items never acquire an active hover surface.
- Nested menu placement, keyboard navigation, Escape unwinding, outside dismissal, and focus restore
  remain owned by `MenuSurface` and `layeredMenuState`.
- Sidebar attention dots, archive/pin actions, filtering, grouping, and selection remain unchanged.

## Verification

- Add static UI contracts for descriptive menu geometry and stable sidebar hover ownership.
- Run cursor-grammar tests, UI contract, Electron tests, typecheck, and production build.
- Inspect the real Electron UI at desktop and narrow viewport widths in dark and one alternate theme.
- Verify menu labels do not overlap, hover does not shift timestamps/actions, and composer metadata
  remains on screen without horizontal overflow.
