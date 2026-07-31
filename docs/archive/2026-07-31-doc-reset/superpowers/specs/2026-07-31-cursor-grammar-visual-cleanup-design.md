# Cursor-Grammar Visual Cleanup Design

**Status:** Approved
**Date:** 2026-07-31
**Scope:** Phase 1 - shell, sidebar, chat, composer, menus, filters, runtime context, adaptive workspace island

## Goal

Give Homun the visual discipline and interaction grammar observed in Cursor Agents without copying Cursor's product identity. Homun keeps its floating sidebar island, themes, accents, durable agent states, security surfaces, artifacts, sources, and browser/computer runtime.

This phase changes presentation and UI composition. It must not weaken or replace the canonical agent-loop, approval, sandbox, vault, connector, task-runtime, artifact, or effect-receipt contracts.

## Reference Findings

The live Cursor comparison covered the active chat, new-agent state, automations, sidebar filters, composer add menu, model selection, context usage, collapsed tools island, and expanded tool panel.

Cursor's clarity comes primarily from:

- system typography and a small, consistent type scale;
- flat content with few framed surfaces;
- subtle borders and almost no persistent shadows;
- compact rows and controls with stable dimensions;
- actions revealed on hover or keyboard focus without shifting layout;
- one contextual menu chain at a time;
- metadata outside the main prompt field;
- a collapsed tool island that expands only when needed.

The current Homun implementation has concrete sources of visual inconsistency:

- `styles.css` is over 16,000 lines and contains duplicate composer/model rules;
- `ChatView.tsx` is over 10,000 lines and owns the composer plus many unrelated surfaces;
- the add menu and model picker can remain open simultaneously;
- the current filter is a card containing pills instead of a compact hierarchical menu;
- the open workspace status panel reserves substantial chat width;
- Hanken Grotesk gives the UI a rounder, less native density than the target grammar;
- several panels use radius, border, and filled backgrounds where spacing would be sufficient.

## Design Principles

1. **Grammar, not imitation.** Adopt Cursor-like hierarchy, density, interaction, and restraint. Preserve Homun themes, semantic statuses, security UX, runtime projections, and artifact workflows.
2. **State remains factual.** UI status is always projected from canonical runtime data. Visual cleanup must not infer completion, browser activity, artifact availability, or context usage.
3. **One surface per purpose.** Sections are unframed by default. Cards are reserved for artifacts, repeated results, approvals, verification, and genuinely bounded tools.
4. **Stable geometry.** Hover, focus, badges, long labels, and dynamic state must not resize controls or move neighboring content.
5. **Progressive migration.** Replace a surface and remove its old CSS in the same step. Do not add a second design layer at the end of the monolithic stylesheet.

## Visual Foundation

### Typography

- Use the native system stack: `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `system-ui`, `sans-serif`.
- Use JetBrains Mono only for code, token counts, identifiers, keyboard hints, and technical labels.
- Base UI text: 13px.
- Conversation body: 14px.
- Secondary metadata: 12px.
- Compact labels: 11px only where space is structurally constrained.
- Do not scale font size with viewport width.
- Use zero letter spacing except uppercase technical labels, which may use a small positive value.

### Geometry

- Spacing scale: 4, 8, 12, 16, and 24px.
- Standard control height: 28-32px.
- Composer minimum height: approximately 44px.
- Standard icon size: 15-16px with a light Lucide stroke.
- Standard radius: 6-8px.
- Composer and primary bounded panels: 10px maximum.
- Pill radius only for true tags, statuses, segmented controls, or circular actions.
- Shadows are limited to menus and transient overlays.

### Themes

Keep every existing Homun surface theme and the independent accent selector. All themes share identical typography, dimensions, spacing, states, and component behavior. Only neutral colors and the selected accent vary.

Semantic green, amber, and red remain distinct from the chosen accent and retain the same meaning across themes.

## Shell And Sidebar

The floating sidebar island remains a Homun signature.

- Keep a 6-8px outer inset.
- Use an approximately 10px outer radius, one subtle border, and no prominent shadow.
- Reduce the initial width to approximately 260-270px while keeping the resizer.
- Keep the sidebar independently collapsible; closed state returns all available width to the workspace.
- Use compact 28-30px navigation and conversation rows.
- Keep selection as a subtle background only, without an accent border.
- Reserve trailing action space so pin, archive, and menu controls can appear on hover/focus without shifting timestamps.
- Make the account footer smaller and quieter.
- Keep scrollbars nearly invisible until scrolling or hover.
- Remove nested panels, decorative pills, and redundant separators from the sidebar.

### Sidebar Filter

Place a 15px `ListFilter`/funnel icon at the right edge of the Workspace conversation-list heading. Keep create/add as a separate action.

The filter trigger:

- has a stable 26-28px hit target;
- is visually transparent at rest;
- uses the standard hover surface and a tooltip;
- displays a small dot or count when filters are active;
- anchors the menu directly below itself.

The filter menu is hierarchical and compact. It supports grouping, ordering, state, type, period, project, channel, and archived visibility. `Requires attention` is a state filter. Selected entries use a trailing checkmark. `Clear filters` appears only when needed. Active filters remain persisted using the existing filter state contract.

## Chat Surface

- Use a centered conversation column approximately 760-820px wide.
- Agent messages are flat and unframed.
- User messages use a thin bordered band with an almost transparent background, not a filled chat bubble.
- Keep headings restrained and body line height consistent.
- Reveal timestamps and secondary message actions primarily on hover/focus.
- Keep action hit targets stable even when their icons are visually hidden.
- Condense tool calls, activity, and generated-file summaries into expandable rows.
- Keep approval and uncertain-effect verification inline with the owning conversation, using operational density rather than dashboard cards.
- Do not move or narrow the chat when the adaptive workspace island is collapsed.

## Composer

The composer is a thin prompt surface that grows only with content.

Inside the composer:

- add button on the left;
- prompt input in the center;
- voice or send/cancel action on the right.

Outside the prompt surface, on a quiet metadata row:

- interaction mode;
- effective model;
- workspace/runtime environment;
- runtime and context usage.

The metadata row must not increase the perceived weight of the composer. Long values truncate without moving controls.

### Add Menu And Model Selection

The add menu supports search and compact entries for modes, images/files, models, capabilities, and connectors. Descriptions are removed from primary rows and moved to tooltips or contextual detail.

Model selection is reachable from both the effective-model metadata control and the `Models` submenu. It provides search, an `Auto` option, the actual current selection, provider grouping when useful, and concise locality metadata.

All composer overlays are governed by one menu state. Opening one closes every other composer overlay. `Escape` closes the current layer; a second `Escape` closes its parent; clicking outside closes the full chain. Keyboard arrows, Enter, and focus restoration are supported.

## Runtime And Context

The metadata-row context control opens a bounded `Runtime & Context` panel above the composer.

It shows only factual metadata:

- effective model used by the turn;
- provider;
- local, cloud, or cloud-through-local-runtime locality;
- resolved turn role;
- model context-window maximum;
- used tokens and percentage;
- conversation contribution;
- compacted-summary contribution;
- file and artifact contribution;
- authorized-memory contribution;
- system-contract and tool contribution;
- compaction already applied.

Costs and historical usage remain in the Usage view. Missing categories display as unavailable rather than zero unless the runtime can prove zero.

If the current gateway projection does not expose these values, add a metadata-only contract sourced from the canonical model run, prompt snapshot, and compaction records. Do not reconstruct token categories from rendered chat text.

## Adaptive Workspace Island

The right-side island is capability- and state-driven rather than a fixed clone of Cursor's toolbar.

Potential sections are:

- activity and plan progress;
- browser/computer;
- artifacts;
- files and sources;
- a future terminal slot that remains absent until a real terminal runtime exists.

Visibility rules:

- Activity appears only when a plan, active execution, or recent durable activity exists.
- Artifacts appears only when the conversation owns managed outputs.
- Files/Sources appears only when files, attachments, or evidence sources exist.
- Browser/Computer appears only for an active session or a verifiable persisted snapshot.
- Empty or unavailable capabilities render no icon.
- Waiting, running, unread, and failed states use semantic badges on the owning section.

The island is collapsed by default. Clicking a visible section opens a resizable side panel. Clicking the active section closes it. Selecting a different section swaps panel content without an intermediate close. The browser section may show a small live preview while active and opens the existing full browser/computer panel on command.

## Interaction Contract

- Rest: transparent or base surface.
- Hover: one subtle surface change, no geometry change.
- Selected: slightly stronger neutral surface and primary text.
- Running/waiting/failed: semantic status indicator, not a large tinted fill.
- Keyboard focus: visible, thin, theme-aware focus ring.
- Transition duration: 100-140ms.
- Respect `prefers-reduced-motion`.
- Icon-only controls always have tooltips and accessible names.
- Hover-revealed controls remain reachable through keyboard focus.
- Popovers never overlap the viewport edge or composer input.
- Nested menus open in the available direction and retain parent selection.

## Component Boundaries

Introduce focused primitives rather than continuing to grow `ChatView.tsx` and `styles.css`:

- `MenuSurface`: menu shell, search, nested menu, keyboard navigation, placement, and dismissal.
- `IconButton`: dimensions, tooltip, hover, focus, badge, and disabled state.
- `ComposerShell`: input geometry, attachments, submit state, and metadata row.
- `RuntimeContextPanel`: metadata-only runtime/context projection.
- `AdaptiveWorkspaceIsland`: section availability, badges, collapsed rail, and open panel selection.
- shared sidebar row and filter primitives.

Split styles by ownership: foundation/tokens, shell, sidebar, chat, composer, menus, and workspace island. New files may still use global class names initially to avoid a framework migration, but every selector must have one owning component and one definition.

## Data Flow

1. Canonical thread, task, artifact, browser, and execution projections remain authoritative.
2. `ChatView` or a dedicated view model maps those projections into visible island sections.
3. The runtime-context bridge returns metadata only and is scoped to user, workspace, thread, and turn.
4. Composer selection state controls only the next request. The UI separately displays the model that the runtime actually used.
5. Filters continue to operate on the existing conversation projection and attention contract.
6. No visual component owns lifecycle, completion, approval, receipt, browser, or artifact truth.

## Migration Sequence

1. Establish system typography, geometry tokens, interaction states, and shared menu/icon primitives.
2. Migrate the sidebar interior and hierarchical filters while retaining the outer island.
3. Migrate chat rows, user bands, agent text, message actions, and expandable operational rows.
4. Extract and rebuild the composer plus exclusive overlay state.
5. Add the runtime-context projection and panel.
6. Replace the persistent status column with the adaptive workspace island and connect existing panels.
7. Delete replaced components, duplicate selectors, unused translations, and obsolete style blocks.
8. Extend the same foundation to Automations, Presentations, Proactivity, and Settings in later phases.

## Verification

Automated checks must cover:

- exclusive composer overlays and nested-menu dismissal;
- filter persistence, active count, grouping, ordering, and `Requires attention`;
- island section visibility from factual projections;
- effective-model versus selected-model display;
- context metadata redaction and unavailable-value handling;
- keyboard navigation and focus restoration;
- absence of retired selectors and duplicate owned rules;
- production typecheck/build and existing Electron contracts.

Real Electron visual QA must cover every existing theme and representative accents at wide and narrow desktop sizes. Scenarios include idle, working, waiting, failed, completed, long conversations, code, approvals, uncertain effects, artifacts present/absent, files present/absent, active/inactive browser, short/long model names, normal/high/compacted context, nested menus, hover, focus, and reduced motion.

Screenshots and layout checks must prove:

- no overlap or viewport escape;
- no hover-induced layout shift;
- no clipped labels or controls;
- stable composer and island dimensions;
- readable contrast in every theme;
- no blank browser preview or artifact panel;
- sidebar, chat, composer, and open panel remain usable at the minimum supported desktop size.

## Acceptance Criteria

- The Phase 1 surface reads as one coherent visual system in every Homun theme.
- The sidebar remains recognizably Homun while its interior follows the new grammar.
- The chat is flatter, quieter, and more legible than the current implementation.
- The composer is thin, metadata is external, and only one overlay can be open.
- Runtime/context values are factual and metadata-only.
- The right island shows only capabilities and outputs that actually exist.
- Hover, focus, selected, waiting, running, and failed states are consistent and accessible.
- Replaced CSS and dead component code are removed during migration.
- Existing agent-loop, sandbox, vault, connector, approval, task, artifact, browser, automation, and presentation behavior remains green.
