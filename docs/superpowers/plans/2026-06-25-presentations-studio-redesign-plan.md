# Presentations Studio Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Presentations addon into a compact studio workspace with a brand rail and a template-first catalog.

**Architecture:** Keep existing runtime/API contracts. Refactor only the React structure and CSS for `BrandKitPanel`, adding local search/source filters without changing `templateCatalog`, import, or `startTemplateWorkflow` semantics.

**Tech Stack:** React, TypeScript, existing `coreBridge`, CSS tokens in `apps/desktop/src/styles.css`, existing UI contract script.

---

### Task 1: Refactor Presentations Component

**Files:**
- Modify: `apps/desktop/src/components/BrandKitPanel.tsx`

- [ ] **Step 1: Add catalog filter state**

Add `query` and `sourceFilter` state next to the existing `filter` state:

```ts
const [query, setQuery] = useState("");
const [sourceFilter, setSourceFilter] = useState<"all" | "local" | "slidescarnival" | "homun">("all");
```

- [ ] **Step 2: Replace visible template filtering**

Replace the current `visible` expression with a filter that checks kind, source, and text:

```ts
const visible = templates.filter((entry) => {
  const matchesKind = filter === "all" || entry.kind === filter;
  const matchesSource =
    sourceFilter === "all" ||
    (sourceFilter === "local" && entry.is_imported) ||
    (sourceFilter === "slidescarnival" && entry.source_provider === "slidescarnival") ||
    (sourceFilter === "homun" && !entry.is_imported && entry.source_provider !== "slidescarnival");
  const haystack = [
    entry.name,
    entry.description,
    entry.id,
    entry.provider,
    entry.source_provider,
    entry.design_template,
    entry.design_theme,
    entry.design_profile,
    ...(entry.selection_notes ?? []),
    ...entry.tags,
    ...entry.use_cases,
    ...entry.audience,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const needle = query.trim().toLowerCase();
  return matchesKind && matchesSource && (!needle || haystack.includes(needle));
});
```

- [ ] **Step 3: Split layout into rail and workspace**

Wrap the panel in `presentation-studio`, move the brand form into `presentation-brand-rail`, and keep catalog in `presentation-template-workspace`.

- [ ] **Step 4: Add search and source chips**

Add a search input and source chips above the catalog grid. Keep `Import PPTX` visible in the workspace header.

- [ ] **Step 5: Add empty state**

When `visible.length === 0`, render a quiet empty state with text explaining no templates match.

### Task 2: Replace Presentations Styling

**Files:**
- Modify: `apps/desktop/src/styles.css`

- [ ] **Step 1: Replace the existing Presentations CSS block**

Replace the section starting at `/* ── Brand Kit (Presentations plugin)` through the end of the template detail strip rules with studio workspace styles:

```css
.presentation-studio { display: grid; grid-template-columns: minmax(220px, 280px) minmax(0, 1fr); gap: 18px; align-items: start; }
.presentation-brand-rail, .presentation-template-workspace { border: 1px solid var(--line); border-radius: 14px; background: var(--surface); box-shadow: var(--shadow-soft); }
```

Use existing token names (`--surface`, `--line`, `--muted`, `--accent`) and keep controls no larger than the surrounding Settings UI.

- [ ] **Step 2: Style card hierarchy**

Make cards larger and more visual: preview first, title/description second, metadata subdued, `Use template` as the only strong CTA.

- [ ] **Step 3: Style modal**

Keep the existing modal behavior but align it with the island vocabulary: 14px radius, compact header, large preview, thumbnail strip.

- [ ] **Step 4: Add responsive behavior**

At narrow widths, stack workspace and brand rail with the catalog first:

```css
@media (max-width: 980px) {
  .presentation-studio { grid-template-columns: 1fr; }
  .presentation-template-workspace { order: 1; }
  .presentation-brand-rail { order: 2; }
}
```

### Task 3: Verify and Document

**Files:**
- Modify: `docs/DEVELOPMENT.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Update durable status**

Record that the Presentations page has the studio layout slice: compact brand rail, catalog workspace, search/source filters, and unchanged API/runtime contracts.

- [ ] **Step 2: Run gates**

Run:

```bash
npm run test:ui-contract
npm run build
git diff --check
```

Expected: all pass. The Vite chunk-size warning is acceptable and pre-existing.

- [ ] **Step 3: Commit**

Stage only the plan, UI code/CSS, and docs:

```bash
git add docs/superpowers/plans/2026-06-25-presentations-studio-redesign-plan.md apps/desktop/src/components/BrandKitPanel.tsx apps/desktop/src/plugins/presentations/locales/en.json apps/desktop/src/plugins/presentations/locales/it.json apps/desktop/src/styles.css docs/DEVELOPMENT.md docs/roadmap.md
git commit -m "feat: redesign presentations studio"
```

## Self-Review

- Spec coverage: implements the approved studio layout, compact brand rail, catalog-first workspace, search/source filters, card hierarchy, modal polish, and responsive behavior.
- Placeholder scan: no placeholders remain.
- Type consistency: uses existing `TemplateCatalogEntry`, `coreBridge`, and `PluginHost` contracts.
