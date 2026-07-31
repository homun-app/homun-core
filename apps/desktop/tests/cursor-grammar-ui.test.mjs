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
const chatView = await readFile(
  new URL("../src/components/ChatView.tsx", import.meta.url),
  "utf8",
);
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const chatStyles = await readFile(new URL("../src/styles/chat.css", import.meta.url), "utf8").catch(
  (error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  },
);
const composerShell = await readFile(
  new URL("../src/components/ComposerShell.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const runtimeContextPanel = await readFile(
  new URL("../src/components/RuntimeContextPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const adaptiveWorkspaceIsland = await readFile(
  new URL("../src/components/AdaptiveWorkspaceIsland.tsx", import.meta.url),
  "utf8",
);
const workspaceIslandStyles = await readFile(
  new URL("../src/styles/workspace-island.css", import.meta.url),
  "utf8",
);
const chatApi = await readFile(new URL("../src/lib/chatApi.ts", import.meta.url), "utf8");
const coreBridge = await readFile(new URL("../src/lib/coreBridge.ts", import.meta.url), "utf8");
const composerStyles = await readFile(
  new URL("../src/styles/composer.css", import.meta.url),
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

test("the transcript uses the flat role and operational message grammar", () => {
  for (const className of [
    "chat-message-agent",
    "chat-message-user-band",
    "chat-message-meta",
    "chat-message-actions-slot",
    "chat-operational-row",
  ]) {
    assert.match(chatView, new RegExp(`\\b${className}\\b`));
  }
  assert.match(chatView, /<details\s+className="chat-operational-row"/);
  assert.match(chatView, /<summary>/);
  assert.doesNotMatch(chatView, /message-bubble\s+user|user\s+message-bubble/);
  assert.doesNotMatch(chatView, /"message\s+(?:user|assistant|system)\b/);
});

test("chat.css exclusively owns the migrated transcript grammar", () => {
  for (const selector of [
    ".thread-content",
    ".thread-message-list",
    ".thread-message-row",
    ".chat-message-agent",
    ".chat-message-user-band",
    ".chat-message-meta",
    ".chat-message-actions-slot",
    ".chat-operational-row",
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(chatStyles, new RegExp(escaped));
    assert.doesNotMatch(
      legacyStyles,
      new RegExp(`(?:^|[},])\\s*${escaped}\\s*(?=[,{])`, "m"),
    );
  }
  assert.match(
    main,
    /import "\.\/styles\/foundation\.css";\s*import "\.\/styles\/menus\.css";\s*import "\.\/styles\/sidebar\.css";\s*import "\.\/styles\/chat\.css";/,
  );
});

test("runtime context is fetched through the scoped thread endpoint", () => {
  assert.match(chatApi, /runtimeContext\(threadId:\s*string\)/);
  assert.match(chatApi, /threads\/\$\{encodeURIComponent\(threadId\)\}\/runtime-context/);
  assert.match(coreBridge, /runtimeContext:\s*\(threadId:\s*string\)/);
});

test("runtime context refresh follows the durable terminal cursor", () => {
  assert.match(
    app,
    /runtimeContextRevision=\{\s*threadAttention\.terminalEventIds\[activeThread\.threadId\]\s*\?\?\s*0\s*\}/,
  );
  assert.match(chatView, /runtimeContextRevision:\s*number/);
  assert.match(chatView, /\[thread\.threadId,\s*runtimeContextRevision\]/);
  assert.doesNotMatch(chatView, /runtimeContextRefreshKey/);
});

test("composer runtime uses the exclusive dialog chain and renders factual context inline", () => {
  assert.match(composerShell, /rootOpen\("runtime"\)/);
  assert.match(composerShell, /<RuntimeContextPanel/);
  assert.doesNotMatch(composerShell, /homun:open-runtime-context/);
  assert.match(composerShell, /id="composer-runtime-trigger"[\s\S]*?aria-haspopup="dialog"/);
  assert.match(composerShell, /id="composer-runtime-menu"[\s\S]*?surfaceRole="dialog"/);
  assert.match(menuSurface, /surfaceRole\?:\s*"menu"\s*\|\s*"dialog"/);
  assert.match(menuSurface, /role=\{surfaceRole\}/);
});

test("runtime panel exposes only approved redacted categories", () => {
  for (const field of [
    "effectiveModel",
    "selectedNextModel",
    "provider",
    "locality",
    "role",
    "contextWindow",
    "usedTokens",
    "percent",
    "contributions",
    "compacted",
  ]) {
    assert.match(runtimeContextPanel, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(
    runtimeContextPanel,
    /value\.(?:prompt|path|memoryContent|price|hash|baseUrl)|base_url/i,
  );
  assert.match(runtimeContextPanel, /composer\.runtime\.nextTurnModel/);
  assert.match(runtimeContextPanel, /value\.selectedNextModel\s*\?\?/);
  assert.match(runtimeContextPanel, /<section[\s\S]*?aria-labelledby=/);
});

test("the adaptive workspace island replaces every persistent status owner", () => {
  assert.match(chatView, /<AdaptiveWorkspaceIsland/);
  assert.match(chatView, /projectWorkspaceSections/);
  assert.match(adaptiveWorkspaceIsland, /useState<WorkspaceSectionId\s*\|\s*null>\(null\)/);
  assert.match(adaptiveWorkspaceIsland, /role="region"/);
  assert.match(workspaceIslandStyles, /\.workspace-island-rail/);
  assert.doesNotMatch(
    chatView,
    /from "\.\/WorkspaceIsland"|<WorkspaceIsland\b|chat-status-stack|islandOpen/,
  );
  assert.doesNotMatch(
    legacyStyles,
    /\.chat-status-stack|\.unified-status-panel|\.workspace-island-pill|\.workspace-island-panel|--island-reserve/,
  );
});

test("legacy CSS cannot recreate message, activity, or generated-file surfaces", () => {
  const selectors = new Set(
    Array.from(legacyStyles.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g))
      .flatMap((match) => match[1].trim().startsWith("@") ? [] : match[1].split(","))
      .map((selector) => selector.trim()),
  );
  const migratedMessageSelectors = new Set([
    ".message",
    ".message.user",
    ".message.user > p",
    ".message.user > .rich-message",
    ".message.assistant",
    ".message.system",
    ".message.assistant p",
    ".message.system p",
    ".message.assistant .rich-message",
    ".message.system .rich-message",
    ".message.pending p",
    ".message footer",
  ]);
  const duplicateSurfaces = [...selectors].filter((selector) => (
    migratedMessageSelectors.has(selector)
    || selector.startsWith(".message.user > .rich-message ")
    || selector.startsWith(".message.user ")
    || selector.startsWith(".message.assistant")
    || selector.startsWith(".message.system")
    || selector.startsWith(".msg-activity")
    || selector === ".msg-artifacts"
  ));

  assert.deepEqual(duplicateSurfaces, []);
  assert.doesNotMatch(legacyStyles, /@keyframes\s+(?:message-in|msg-activity-pulse)\b/);
  assert.doesNotMatch(
    legacyStyles,
    /\.message\.user\s*>\s*(?:p|\.rich-message)\s*\{[\s\S]*?(?:border-radius:\s*18px|padding:\s*12px 16px|background:\s*var\(--surface-muted\))/,
  );

  for (const selector of [
    ".message",
    ".chat-message-agent",
    ".chat-message-user-band",
    ".chat-message-system",
    ".message.pending p",
    ".chat-message-meta",
    ".msg-activity",
    ".msg-artifacts",
  ]) {
    assert.match(chatStyles, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(chatStyles, /@keyframes\s+message-in\b/);
  assert.match(chatStyles, /@keyframes\s+msg-activity-pulse\b/);
  assert.match(
    chatStyles,
    /\.chat-message-user-band\s*\{[\s\S]*?width:\s*fit-content;[\s\S]*?border:\s*1px solid[\s\S]*?background:\s*color-mix/,
  );
  assert.match(
    chatStyles,
    /\.chat-message-agent,[\s\S]*?\.chat-message-system\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/,
  );
});

test("ChatView delegates the prompt surface to the thin ComposerShell boundary", () => {
  assert.match(
    chatView,
    /import\s+\{[^}]*\bComposerShell\b[^}]*\}\s+from\s+"\.\/ComposerShell"/s,
  );
  assert.match(chatView, /<ComposerShell\b/);
  assert.doesNotMatch(
    chatView,
    /\b(?:addMenuOpen|fileMenuOpen|skillMenuOpen|modelMenuOpen)\b/,
  );
  assert.doesNotMatch(chatView, /composer-pop/);

  for (const token of [
    "layeredMenuState",
    "MenuSurface",
    "IconButton",
    "composer-metadata-row",
    'chainId="composer"',
  ]) {
    assert.match(composerShell, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const label of ["add", "model", "mode", "environment", "runtimeContext"]) {
    assert.match(composerShell, new RegExp(`composer\\.${label}`));
  }
  for (const layer of ["add", "model", "mode", "runtime", "files", "capabilities", "connectors", "models"]) {
    assert.match(composerShell, new RegExp(`[\"']${layer}[\"']`));
  }
});

test("composer.css exclusively owns the compact prompt geometry", () => {
  assert.match(
    main,
    /import "\.\/styles\/chat\.css";\s*import "\.\/styles\/composer\.css";/,
  );
  for (const selector of [
    ".composer-surface",
    ".composer-prompt-row",
    ".composer-metadata-row",
    ".composer-model-button",
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(composerStyles, new RegExp(escaped));
    assert.doesNotMatch(
      legacyStyles,
      new RegExp(`(?:^|[},])\\s*${escaped}\\s*(?=[,{])`, "m"),
    );
  }
  assert.match(composerStyles, /min-height:\s*44px/);
  assert.match(composerStyles, /border-radius:\s*(?:var\([^)]*10[^)]*\)|10px)/);
  assert.match(composerStyles, /text-overflow:\s*ellipsis/);
  assert.equal((`${legacyStyles}\n${composerStyles}`.match(/\.composer-model-button\s*\{/g) ?? []).length, 1);
});

test("composer keeps prior effective-model provenance separate from the next-turn override", () => {
  assert.match(chatView, /lastAssistantEffectiveModel/);
  assert.match(chatView, /threadMessages[\s\S]*?role\s*===\s*"assistant"[\s\S]*?\.model/);
  assert.match(composerShell, /selectedNextTurnModel/);
  assert.match(composerShell, /effectiveModelLabel/);
  assert.doesNotMatch(
    composerShell,
    /effectiveModelLabel\s*=\s*[^\n]*selectedNextTurnModel/,
  );
});

test("composer reducer delegates Add children to exclusive nested-layer state", () => {
  assert.match(
    composerShell,
    /action\.type === "open-nested"[\s\S]*?openLayer\(state, action\.id, null, true\)/,
  );
  assert.match(composerShell, /openNested\("files"\)/);
  assert.match(composerShell, /openNested\("models"\)/);
  assert.match(
    composerShell,
    /const childOpen = \(id: string\) => menuState\.chain\[1\] === id/,
  );
  for (const child of ["files", "capabilities", "connectors", "models"]) {
    assert.match(
      composerShell,
      new RegExp(`open=\\{rootOpen\\(\"add\"\\) && childOpen\\(\"${child}\"\\)\\}`),
    );
  }
});

test("accepted submissions reset every next-turn model while rejected submissions retain it", () => {
  assert.match(chatView, /selectedModelAfterSubmission\(current, accepted\)/);
  assert.doesNotMatch(
    chatView,
    /if \(accepted && suggestedModel && modelOverride === suggestedModel\.value\) \{\s*setSelectedModel\(null\)/,
  );
});

test("assistant model provenance uses only gateway effective_model evidence", () => {
  assert.match(chatView, /effectiveModelFromGateway\(result\.effective_model\)/);
  assert.match(chatView, /latestAssistantEffectiveModel\(threadMessages\)/);
  assert.doesNotMatch(
    chatView,
    /result\.effective_model \?\?[\s\S]*?activeModelInfo\?\.model/,
  );
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

test("MenuSurface portals a labeled same-chain surface with menu semantics by default", () => {
  assert.match(menuSurface, /createPortal/);
  assert.match(menuSurface, /data-menu-chain=\{chainId\}/);
  assert.match(menuSurface, /surfaceRole\s*=\s*"menu"/);
  assert.match(menuSurface, /role=\{surfaceRole\}/);
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
