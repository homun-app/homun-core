import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
const legacyStyles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const foundation = await readFile(new URL("../src/styles/foundation.css", import.meta.url), "utf8").catch(
  (error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  },
);
const iconButton = await readFile(
  new URL("../src/components/ui/IconButton.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const menuSurface = await readFile(
  new URL("../src/components/ui/MenuSurface.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const menus = await readFile(new URL("../src/styles/menus.css", import.meta.url), "utf8").catch(
  (error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  },
);
const sidebarFilters = await readFile(
  new URL("../src/components/SidebarFilters.tsx", import.meta.url),
  "utf8",
);
const sidebar = await readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
const sidebarStyles = await readFile(
  new URL("../src/styles/sidebar.css", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const sidebarFilterState = await readFile(
  new URL("../src/lib/sidebarFilterState.mjs", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const reducedMotion = foundation.match(
  /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/,
)?.[0] ?? "";

test("the desktop entrypoint uses the compact visual foundation", () => {
  assert.doesNotMatch(main, /@fontsource\/hanken-grotesk/);
  assert.match(
    main,
    /import "\.\/styles\.css";\s*import "\.\/styles\/foundation\.css";\s*import "\.\/styles\/menus\.css";/,
  );
});

test("the sidebar uses the canonical persisted thread filter projection", () => {
  assert.match(sidebarFilterState, /homun\.sidebar\.threadFilter\.v2/);
  assert.match(sidebar, /readSidebarThreadFilter/);
  assert.match(sidebar, /writeSidebarThreadFilter/);
  assert.match(sidebar, /projectThreads/);
  assert.match(sidebar, /PERSONAL_WORKSPACE_ID/);
  assert.match(sidebar, /Date\.now\(\)/);
  assert.match(sidebar, /workspaceId:\s*thread\.workspace_id/);
  assert.doesNotMatch(sidebar, /\bthreadMatchesFilter\b/);
  assert.doesNotMatch(sidebar, /\brequiresAttention\b/);
  assert.doesNotMatch(`${sidebar}\n${sidebarFilters}`, /\battentionOnly\b/);
  assert.doesNotMatch(sidebarFilters, /filter\.(?:date|sources)\b/);
});

test("SidebarFilters is a compact hierarchical MenuSurface chain", () => {
  for (const token of [
    "ListFilter",
    "IconButton",
    "MenuSurface",
    'role="menuitemradio"',
    'role="menuitemcheckbox"',
    't("filters.clear")',
    'chainId="sidebar-filters"',
  ]) {
    assert.match(sidebarFilters, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const staleToken of [
    "SlidersHorizontal",
    "sidebar-filter-panel",
    "filter-chip",
    "filter-segments",
  ]) {
    assert.doesNotMatch(sidebarFilters, new RegExp(staleToken));
  }
  assert.match(sidebarFilters, /SIDEBAR_FILTER_ROOT_ROWS\.map/);
  assert.match(sidebarFilters, /toggleAttentionFilterStates/);
  assert.match(sidebarFilters, /sidebarFilterBadgeModel/);
  assert.match(sidebarFilters, /freshSidebarThreadFilter/);
});

test("sidebar styles load after shared menus and own sidebar selectors", () => {
  assert.match(main, /import "\.\/styles\/menus\.css";\s*import "\.\/styles\/sidebar\.css";/);
  const cssSelectors = (css) => new Set(
    Array.from(css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g))
      .flatMap((match) => match[1].trim().startsWith("@") ? [] : match[1].split(","))
      .map((selector) => selector.trim()),
  );
  const cssClasses = (selectors) => new Set(
    [...selectors].flatMap((selector) => selector.match(/\.[A-Za-z_][\w-]*/g) ?? []),
  );
  const sidebarClasses = cssClasses(cssSelectors(sidebarStyles));
  const legacySelectors = cssSelectors(legacyStyles);
  const legacyClasses = cssClasses(legacySelectors);
  const ownedFamilies = [
    { label: "nav drawer", matches: (name) => name === ".nav-drawer" },
    {
      label: "navigation rail",
      matches: (name) => name === ".navigation-rail" || name.startsWith(".rail-"),
    },
    { label: "settings drawer", matches: (name) => name === ".settings-drawer" },
    { label: "settings navigation", matches: (name) => name.startsWith(".set-nav-") },
    { label: "settings subnavigation", matches: (name) => name.startsWith(".set-subnav-") },
    { label: "drawer resizer", matches: (name) => name === ".drawer-resizer" },
    ...[
      "titlebar",
      "topbar",
      "nav",
      "scroll",
      "footer",
      "profile",
      "thread",
      "project",
      "chats",
      "section",
      "row",
      "eyebrow",
    ].map((family) => ({
      label: `drawer ${family}`,
      matches: (name) => name.startsWith(`.drawer-${family}`),
    })),
    { label: "sidebar filters", matches: (name) => name.startsWith(".sidebar-filter") },
    { label: "thread status", matches: (name) => name === ".thread-status-dot" },
  ];
  for (const family of ownedFamilies) {
    const owned = [...sidebarClasses].filter(family.matches);
    assert.ok(owned.length > 0, `${family.label} selectors must exist in sidebar.css`);
    assert.deepEqual(
      [...legacyClasses].filter(family.matches),
      [],
      `${family.label} selectors must not remain in styles.css`,
    );
  }

  // These selectors coordinate sidebar state with global workspace chrome and intentionally stay.
  const legacySidebarAllowlist = [
    ".app-shell.drawer-closed .cc-dock.full",
    ".app-shell.drawer-closed .task-topbar",
    ".app-shell.drawer-closed::before",
    ".app-shell.drawer-open::before",
  ];
  assert.deepEqual(
    [...legacySelectors]
      .filter((selector) => selector.includes(".drawer-open") || selector.includes(".drawer-closed"))
      .sort(),
    legacySidebarAllowlist,
  );
  const retiredFilters = /filter-chip|filter-segments|sidebar-filter-panel|drawer-filter-bar/;
  assert.doesNotMatch(sidebarStyles, retiredFilters);
  assert.doesNotMatch(legacyStyles, retiredFilters);
});

test("IconButton exposes its label and semantic tooltip", () => {
  assert.match(iconButton, /aria-label=\{label\}/);
  assert.match(iconButton, /role="tooltip"/);
  assert.match(iconButton, /className="ui-tooltip"/);
  assert.match(menus, /\.ui-icon-button:focus\s*>\s*\.ui-tooltip/);
});

test("IconButton static markup composes descriptions and exposes badge context once", async () => {
  const server = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  try {
    const { IconButton } = await server.ssrLoadModule("/src/components/ui/IconButton.tsx");
    const withoutPressed = renderToStaticMarkup(React.createElement(
      IconButton,
      { label: "Models" },
      "M",
    ));
    assert.doesNotMatch(withoutPressed, /aria-pressed=/);

    const markup = renderToStaticMarkup(React.createElement(
      IconButton,
      {
        label: "Models",
        pressed: false,
        tooltip: "Choose model",
        badge: "2",
        badgeLabel: "2 models need attention",
        "aria-describedby": "external-description",
      },
      "M",
    ));
    assert.match(markup, /aria-label="Models"/);
    assert.match(markup, /aria-pressed="false"/);
    assert.match(markup, /class="ui-icon-button__badge" aria-hidden="true">2<\/span>/);

    const describedBy = markup.match(/aria-describedby="([^"]+)"/)?.[1].split(" ") ?? [];
    const tooltipId = markup.match(/role="tooltip" class="ui-tooltip" id="([^"]+)"/)?.[1];
    const badgeDescriptionId = markup.match(
      /id="([^"]+)" class="ui-visually-hidden">2 models need attention<\/span>/,
    )?.[1];
    assert.deepEqual(describedBy, ["external-description", tooltipId, badgeDescriptionId]);

    const derivedBadgeMarkup = renderToStaticMarkup(React.createElement(
      IconButton,
      { label: "Notifications", badge: 3 },
      "N",
    ));
    assert.match(derivedBadgeMarkup, /class="ui-visually-hidden">3<\/span>/);
    assert.match(derivedBadgeMarkup, /aria-describedby="[^"]+"/);
  } finally {
    await server.close();
  }
});

test("IconButton badge text meets small-text contrast in every theme", () => {
  const danger = legacyStyles.match(/--danger:\s*(#[0-9a-f]{6});/i)?.[1];
  const badge = menus.match(/\.ui-icon-button__badge\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  const foreground = badge.match(/color:\s*(#[0-9a-f]{3,6});/i)?.[1];
  assert.ok(danger && foreground, "badge foreground and danger colors must be explicit");

  const luminance = (hex) => {
    const normalized = hex.length === 4
      ? hex.slice(1).split("").map((digit) => digit.repeat(2)).join("")
      : hex.slice(1);
    const channels = normalized.match(/../g).map((value) => Number.parseInt(value, 16) / 255);
    const linear = channels.map((value) => (
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    ));
    return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
  };
  const contrast = (Math.max(luminance(danger), luminance(foreground)) + 0.05)
    / (Math.min(luminance(danger), luminance(foreground)) + 0.05);
  assert.ok(contrast >= 4.5, `expected at least 4.5:1 contrast, received ${contrast.toFixed(2)}:1`);
});

test("MenuSurface portals a labeled same-chain menu", () => {
  assert.match(menuSurface, /createPortal/);
  assert.match(menuSurface, /data-menu-chain=\{chainId\}/);
  assert.match(menuSurface, /role="menu"/);
  assert.match(menuSurface, /aria-label=\{label\}/);
});

test("MenuSurface delegates interaction and placement decisions to tested helpers", () => {
  for (const helper of [
    "computeMenuPlacement",
    "enabledMenuItemIndexes",
    "createPlacementRefreshScheduler",
    "getMenuKeyboardAction",
    "getRovingTabIndexes",
    "initialMenuFocusTarget",
    "menuPlacementChanged",
    "menuPlacementEvents",
    "observeGeometryChanges",
    "observeSubtreeContentChanges",
    "shouldAssignInitialMenuFocus",
    "shouldDismissMenuPointer",
    "shouldRenderMenu",
    "shouldRestoreMenuFocus",
  ]) {
    assert.match(menuSurface, new RegExp(`\\b${helper}\\b`));
  }
  assert.match(menuSurface, /shouldRestoreMenuFocus\(parentId, portalIds\)/);
  assert.doesNotMatch(menuSurface, /!open \|\| parentId != null/);
});

test("MenuSurface re-establishes roving state before search focus after every render", () => {
  const focusEffect = menuSurface.match(
    /useLayoutEffect\(\(\) => \{\s*if \(!open \|\| placement\.visibility !== "visible"\)[\s\S]*?\n  \}\);/,
  )?.[0] ?? "";
  assert.match(focusEffect, /applyRovingTabIndexes\(allItems, items, tabIndexes\);/);
  assert.doesNotMatch(focusEffect, /\.focus\(\)/);
  assert.match(menuSurface, /tabIndex=\{-1\}/);
});

test("MenuSurface measures unclipped content when recomputing placement", () => {
  assert.match(menuSurface, /const menuHeight = menu\.scrollHeight;/);
  assert.match(menuSurface, /placementRefresh\.refresh\(\);/);
  assert.match(menuSurface, /placementRefresh\.cancel\(\);/);
  assert.match(menuSurface, /document\.getElementById\(parentId\)/);
  assert.match(menuSurface, /\[anchorRef\.current, menuRef\.current, parentMenu\]/);
  assert.match(menuSurface, /observeGeometryChanges/);
  assert.match(menuSurface, /observeSubtreeContentChanges/);
  assert.match(menuSurface, /menuPlacementChanged/);
});

test("IconButton keeps child tooltips fixed, measured, and non-interactive", () => {
  assert.match(iconButton, /computeTooltipPlacement/);
  assert.match(iconButton, /observeGeometryChanges/);
  assert.match(menus, /\.ui-tooltip\s*\{[\s\S]*position:\s*fixed;/);
  assert.match(menus, /\.ui-tooltip\s*\{[\s\S]*pointer-events:\s*none;/);
});

test("the foundation uses native typography and the compact spacing scale", () => {
  assert.match(
    foundation,
    /--font-sans:\s*-apple-system,\s*BlinkMacSystemFont[^;]*;/,
  );
  assert.match(foundation, /--space-1:\s*4px;/);
  assert.match(foundation, /--space-2:\s*8px;/);
  assert.match(foundation, /--space-3:\s*12px;/);
  assert.match(foundation, /--space-4:\s*16px;/);
  assert.match(foundation, /--space-6:\s*24px;/);
});

test("the foundation defines compact control and motion tokens", () => {
  assert.match(foundation, /--control-height:\s*30px;/);
  assert.match(foundation, /--icon-size:\s*16px;/);
  assert.match(foundation, /--radius-control:\s*7px;/);
  assert.match(foundation, /--radius-panel:\s*10px;/);
  assert.match(foundation, /--motion-fast:\s*120ms;/);
});

test("the foundation preserves unmigrated legacy values", () => {
  assert.match(foundation, /--s1:\s*4px;/);
  assert.match(foundation, /--s2:\s*8px;/);
  assert.match(foundation, /--s3:\s*12px;/);
  assert.match(foundation, /--s4:\s*16px;/);
  assert.match(foundation, /--s5:\s*20px;/);
  assert.match(foundation, /--s6:\s*24px;/);
  assert.match(foundation, /--radius:\s*8px;/);
  assert.match(foundation, /--radius-card:\s*14px;/);
  assert.match(foundation, /--radius-lg:\s*18px;/);
});

test("interactive elements share fast color transitions", () => {
  assert.match(foundation, /:where\([^)]*\[role="menuitem"\][^)]*\)/);
  assert.match(foundation, /color\s+var\(--motion-fast\)\s+ease/);
  assert.match(foundation, /background-color\s+var\(--motion-fast\)\s+ease/);
  assert.match(foundation, /border-color\s+var\(--motion-fast\)\s+ease/);
  assert.match(foundation, /opacity\s+var\(--motion-fast\)\s+ease/);
});

test("the foundation respects reduced motion", () => {
  assert.match(reducedMotion, /animation-duration:/);
  assert.match(reducedMotion, /animation-iteration-count:/);
  assert.match(reducedMotion, /scroll-behavior:/);
  assert.match(reducedMotion, /transition-duration:/);
});
