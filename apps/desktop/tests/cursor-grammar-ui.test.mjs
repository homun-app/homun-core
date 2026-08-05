import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const main = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
const packageManifest = await readFile(new URL("../package.json", import.meta.url), "utf8");
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
const composerContainer = await readFile(
  new URL("../src/components/ComposerContainer.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const computerDetailPanel = await readFile(
  new URL("../src/components/ComputerDetailPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatEmptyHero = await readFile(
  new URL("../src/components/ChatEmptyHero.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatTopbar = await readFile(
  new URL("../src/components/ChatTopbar.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageAttachmentList = await readFile(
  new URL("../src/components/MessageAttachmentList.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageActionBar = await readFile(
  new URL("../src/components/MessageActionBar.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatBranchPicker = await readFile(
  new URL("../src/components/ChatBranchPicker.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatFollowUps = await readFile(
  new URL("../src/components/ChatFollowUps.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageEditBox = await readFile(
  new URL("../src/components/MessageEditBox.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageMetaCopy = await readFile(
  new URL("../src/components/MessageMetaCopy.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageStatusBadges = await readFile(
  new URL("../src/components/MessageStatusBadges.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatSystemMessageHeader = await readFile(
  new URL("../src/components/ChatSystemMessageHeader.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const pendingAssistantMessage = await readFile(
  new URL("../src/components/PendingAssistantMessage.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageActivity = await readFile(
  new URL("../src/components/MessageActivity.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const assistantThinkingState = await readFile(
  new URL("../src/components/AssistantThinkingState.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const operationalPlanPreview = await readFile(
  new URL("../src/components/OperationalPlanPreview.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageChoiceCard = await readFile(
  new URL("../src/components/MessageChoiceCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messagePlanProposeCard = await readFile(
  new URL("../src/components/MessagePlanProposeCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageDiffCard = await readFile(
  new URL("../src/components/MessageDiffCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageGoalProposeCard = await readFile(
  new URL("../src/components/MessageGoalProposeCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageVaultRevealCard = await readFile(
  new URL("../src/components/MessageVaultRevealCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageSandboxReadOnlyCard = await readFile(
  new URL("../src/components/MessageSandboxReadOnlyCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageComposioReconnectCard = await readFile(
  new URL("../src/components/MessageComposioReconnectCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const inlineUncertainEffectPanel = await readFile(
  new URL("../src/components/InlineUncertainEffectPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const inlineApprovelPanel = await readFile(
  new URL("../src/components/InlineApprovelPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messagePaymentApprovalCard = await readFile(
  new URL("../src/components/MessagePaymentApprovalCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageFsAuthorizeCard = await readFile(
  new URL("../src/components/MessageFsAuthorizeCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageSandboxEscalateCard = await readFile(
  new URL("../src/components/MessageSandboxEscalateCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageComposioConfirmCard = await readFile(
  new URL("../src/components/MessageComposioConfirmCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageConnectSuggestCard = await readFile(
  new URL("../src/components/MessageConnectSuggestCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageVaultProposeCard = await readFile(
  new URL("../src/components/MessageVaultProposeCard.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const artifactsPanel = await readFile(
  new URL("../src/components/ArtifactsPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const goalsPanel = await readFile(
  new URL("../src/components/GoalsPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const memoryGraphPanel = await readFile(
  new URL("../src/components/MemoryGraphPanel.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const memoryView = await readFile(
  new URL("../src/components/MemoryView.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const inspectorView = await readFile(
  new URL("../src/components/InspectorView.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const assistantMessageBody = await readFile(
  new URL("../src/components/AssistantMessageBody.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatResumeMarkers = await readFile(
  new URL("../src/lib/chatResumeMarkers.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatEventParts = await readFile(
  new URL("../src/lib/chatEventParts.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatViewMessages = await readFile(
  new URL("../src/lib/chatViewMessages.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatPayloadParsers = await readFile(
  new URL("../src/components/ChatPayloadParsers.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const chatMessageMarkerParser = await readFile(
  new URL("../src/components/ChatMessageMarkerParser.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const messageArtifacts = await readFile(
  new URL("../src/components/MessageArtifacts.tsx", import.meta.url),
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
const runtimeContextHook = await readFile(
  new URL("../src/lib/useRuntimeContext.ts", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const adaptiveWorkspaceIsland = await readFile(
  new URL("../src/components/AdaptiveWorkspaceIsland.tsx", import.meta.url),
  "utf8",
);
const workspaceIslandSections = await readFile(
  new URL("../src/components/WorkspaceIslandSections.tsx", import.meta.url),
  "utf8",
).catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
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

function cssBlock(styles, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?\\n\\}`, "m"))?.[0] ?? "";
}

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
  const transcriptMarkup = `${chatView}\n${assistantMessageBody}`;
  for (const className of [
    "chat-message-agent",
    "chat-message-user-band",
    "chat-message-meta",
    "chat-message-actions-slot",
    "chat-operational-row",
  ]) {
    assert.match(transcriptMarkup, new RegExp(`\\b${className}\\b`));
  }
  assert.match(assistantMessageBody, /<details\s+className="chat-operational-row"/);
  assert.match(assistantMessageBody, /<summary>/);
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
  assert.match(chatView, /useRuntimeContext\(\{\s*threadId:\s*thread\.threadId,\s*runtimeContextRevision/);
  assert.match(runtimeContextHook, /export function useRuntimeContext/);
  assert.match(runtimeContextHook, /const refreshRuntimeContext = useCallback/);
  assert.match(runtimeContextHook, /\[refreshRuntimeContext,\s*runtimeContextRevision\]/);
  assert.match(runtimeContextHook, /runtimeContextRequestRef/);
  assert.doesNotMatch(chatView, /runtimeContextRequestRef/);
  assert.doesNotMatch(chatView, /setRuntimeContextLoading/);
  assert.doesNotMatch(chatView, /runtimeContextRefreshKey/);
});

test("runtime context refreshes when the composer dialog is opened", () => {
  assert.match(chatView, /onRefreshRuntimeContext=\{refreshRuntimeContext\}/);
  assert.match(composerShell, /onRefreshRuntimeContext:\s*\(\)\s*=>\s*void\s*\|\s*Promise<void>/);
  assert.match(
    composerShell,
    /id="composer-runtime-trigger"[\s\S]*?onClick=\{\(\)\s*=>\s*\{[\s\S]*?props\.onRefreshRuntimeContext\(\);[\s\S]*?openRoot\("runtime"\)/,
  );
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
  assert.match(runtimeContextPanel, /className="composer-runtime-usage-bar"[\s\S]*?role="progressbar"/);
  assert.match(runtimeContextPanel, /composer-runtime-contributions/);
  assert.match(runtimeContextPanel, /composer-runtime-segment--/);
  assert.match(composerStyles, /\.composer-runtime-usage-bar\s*\{[\s\S]*?height:\s*6px;/);
  assert.match(composerStyles, /\.composer-runtime-swatch--conversation/);
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

test("phase one has one visual owner and no retired runtime surface", async () => {
  const styleOwners = [
    foundation,
    menus,
    sidebarStyles,
    chatStyles,
    composerStyles,
    workspaceIslandStyles,
    legacyStyles,
  ];
  for (const selector of [
    ".menu-surface",
    ".sidebar-filters",
    ".chat-message-user-band",
    ".composer-surface",
    ".workspace-island-rail",
  ]) {
    assert.equal(
      styleOwners.filter((styles) => styles.replace(/\/\*[\s\S]*?\*\//g, "").includes(selector)).length,
      1,
      `${selector} must occur in exactly one style module`,
    );
  }

  assert.doesNotMatch(packageManifest, /@fontsource\/hanken-grotesk/);
  assert.doesNotMatch(
    `${chatView}\n${sidebar}\n${sidebarFilters}\n${composerShell}\n${legacyStyles}`,
    /composer-pop|sidebar-filter-panel|filter-chip|filter-segments|chat-status-stack|unified-status-panel|workspace-island-pill|addMenuOpen|fileMenuOpen|skillMenuOpen|modelMenuOpen/,
  );
  await assert.rejects(
    readFile(new URL("../src/components/ProjectContextPanel.tsx", import.meta.url), "utf8"),
    { code: "ENOENT" },
  );
});

test("phase one transient controls keep named anchors and escape ownership", () => {
  assert.match(menuSurface, /getMenuKeyboardAction\(event\.key/);
  assert.match(menuSurface, /action\.type === "none"[\s\S]*?onCloseCurrent\(\)/);
  assert.match(menuSurface, /anchorRef\.current\?\.focus/);
  for (const source of [sidebarFilters, composerShell]) {
    const surfaces = source.match(/<MenuSurface[\s\S]*?(?:\/>|<\/MenuSurface>)/g) ?? [];
    assert.ok(surfaces.length > 0);
    for (const surface of surfaces) {
      assert.match(surface, /\bid=(?:"[^"]+"|\{[^}]+\})/);
      assert.match(surface, /\blabel=\{/);
      assert.match(surface, /\banchorRef=\{/);
      assert.match(surface, /\bonCloseCurrent=\{/);
    }
  }
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
    /\.chat-message-user-band\s*\{[\s\S]*?width:\s*fit-content;[\s\S]*?margin-left:\s*auto;[\s\S]*?align-self:\s*flex-end;/,
  );
  assert.match(
    chatStyles,
    /\.chat-message-agent,[\s\S]*?\.chat-message-system\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/,
  );
});

test("sent user messages stay right aligned without a bubble frame", () => {
  const userBand = cssBlock(chatStyles, ".chat-message-user-band");
  assert.match(userBand, /margin-left:\s*auto;/);
  assert.match(userBand, /align-self:\s*flex-end;/);
  assert.match(userBand, /border:\s*0;/);
  assert.match(userBand, /background:\s*transparent;/);
  assert.doesNotMatch(userBand, /background:\s*color-mix|border:\s*1px solid/);
});

test("message edit prompt keeps a usable multiline geometry", () => {
  const editShell = cssBlock(chatStyles, ".message-edit");
  const editTextarea = cssBlock(chatStyles, ".message-edit textarea");
  assert.match(editShell, /width:\s*min\(620px,\s*100%\);/);
  assert.match(editTextarea, /min-width:\s*min\(420px,\s*100%\);/);
  assert.match(editTextarea, /min-height:\s*96px;/);
  assert.doesNotMatch(legacyStyles, /\.message-edit(?:\s|\{|:)/);
});

test("ChatView delegates the prompt surface to the thin ComposerShell boundary", () => {
  assert.match(
    composerContainer || chatView,
    /import\s+\{[^}]*\bComposerShell\b[^}]*\}\s+from\s+"\.\/ComposerShell"/s,
  );
  assert.match(composerContainer || chatView, /<ComposerShell\b/);
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

test("ChatView delegates composer state and submit ownership to ComposerContainer", () => {
  assert.match(chatView, /import \{ ComposerContainer \} from "\.\/ComposerContainer";/);
  assert.match(chatView, /<ComposerContainer[\s\S]*?onSubmit=\{submitComposerPrompt\}/);
  assert.doesNotMatch(chatView, /function Composer\(/);
  assert.doesNotMatch(chatView, /const \[selectedModel,\s*setSelectedModel\]/);
  assert.doesNotMatch(chatView, /const \[attachments,\s*setAttachments\]/);
  assert.match(composerContainer, /export function ComposerContainer/);
  assert.match(composerContainer, /<ComposerShell/);
  assert.match(composerContainer, /selectedModelAfterSubmission/);
  assert.match(composerContainer, /coreBridge\.runtimeModels/);
});

test("InspectorView delegates local computer inspector rendering to ComputerDetailPanel", () => {
  assert.doesNotMatch(chatView, /import \{ ComputerDetailPanel \} from "\.\/ComputerDetailPanel";/);
  assert.match(inspectorView, /import \{ ComputerDetailPanel \} from "\.\/ComputerDetailPanel";/);
  assert.match(inspectorView, /<ComputerDetailPanel[\s\S]*?session=\{computerSession\}/);
  assert.doesNotMatch(chatView, /function ComputerDetailPanel\(/);
  assert.match(computerDetailPanel, /export function ComputerDetailPanel/);
  assert.match(computerDetailPanel, /className="computer-detail-panel"/);
  assert.match(computerDetailPanel, /onSelectSurface\(surface\.id\)/);
  assert.match(computerDetailPanel, /onClick=\{paused \? onResume : onPause\}/);
});

test("ChatView delegates empty-thread hero rendering to ChatEmptyHero", () => {
  assert.match(chatView, /import \{ ChatEmptyHero \} from "\.\/ChatEmptyHero";/);
  assert.match(chatView, /<ChatEmptyHero[\s\S]*?sessionSeed=\{CHAT_VIEW_SESSION_ID\}/);
  assert.doesNotMatch(chatView, /function ChatEmptyHero\(/);
  assert.match(chatEmptyHero, /export function ChatEmptyHero/);
  assert.match(chatEmptyHero, /selectGreetingKey/);
  assert.match(chatEmptyHero, /<ChatUsageOverview/);
  assert.match(chatEmptyHero, /chat-hero-headline/);
  assert.match(chatEmptyHero, /chat-hero-prompt/);
});

test("ChatView delegates the chat topbar to ChatTopbar", () => {
  assert.match(chatView, /from "\.\/ChatTopbar";/);
  assert.match(chatView, /<ChatTopbar/);
  assert.doesNotMatch(chatView, /<header className="task-topbar"/);
  assert.doesNotMatch(chatView, /task-collapsed-controls/);
  assert.match(chatTopbar, /export function ChatTopbar/);
  assert.match(chatTopbar, /<header className="task-topbar"/);
  assert.match(chatTopbar, /<ChatHeaderMenu/);
});

test("ChatView does not keep the retired unused inline computer timeline component", () => {
  assert.doesNotMatch(chatView, /function InlineTimeline\(/);
});

test("ChatView delegates message attachment rendering to MessageAttachmentList", () => {
  assert.match(chatView, /import \{ MessageAttachmentList \} from "\.\/MessageAttachmentList";/);
  assert.match(chatView, /<MessageAttachmentList attachments=\{displayMessage\.attachments\}/);
  assert.doesNotMatch(chatView, /function MessageAttachmentList\(/);
  assert.match(messageAttachmentList, /export function MessageAttachmentList/);
  assert.match(messageAttachmentList, /message-image-attachment/);
  assert.match(messageAttachmentList, /message-attachment-chip/);
  assert.match(messageAttachmentList, /formatFileSize\(attachment\.sizeBytes\)/);
});

test("ChatView delegates message action rendering to MessageActionBar", () => {
  assert.match(chatView, /import \{ MessageActionBar \} from "\.\/MessageActionBar";/);
  assert.match(chatView, /<MessageActionBar[\s\S]*?onSaveAsGoal=\{\(\) => saveMessageAsGoal\(displayMessage\.text\)\}/);
  assert.doesNotMatch(chatView, /function MessageActionBar\(/);
  assert.doesNotMatch(chatView, /resolveMessageActionMenuPlacement/);
  assert.match(messageActionBar, /export function MessageActionBar/);
  assert.match(messageActionBar, /message-action-menu-feedback/);
  assert.match(messageActionBar, /message-latency-summary/);
  assert.match(messageActionBar, /resolveMessageActionMenuPlacement/);
});

test("ChatView delegates branch variant controls to ChatBranchPicker", () => {
  assert.match(chatView, /from "\.\/ChatBranchPicker";/);
  assert.match(chatView, /<ChatBranchPicker/);
  assert.doesNotMatch(chatView, /className="branch-picker"/);
  assert.doesNotMatch(chatView, /branch-rename/);
  assert.match(chatBranchPicker, /export function ChatBranchPicker/);
  assert.match(chatBranchPicker, /className="branch-picker"/);
  assert.match(chatBranchPicker, /branch-rename/);
});

test("ChatView delegates follow-up suggestion rendering to ChatFollowUps", () => {
  assert.match(chatView, /from "\.\/ChatFollowUps";/);
  assert.match(chatView, /<ChatFollowUps/);
  assert.doesNotMatch(chatView, /className="chat-followups"/);
  assert.match(chatFollowUps, /export function ChatFollowUps/);
  assert.match(chatFollowUps, /className="chat-followups"/);
  assert.match(chatFollowUps, /chat\.followUpQuestions/);
});

test("ChatView delegates inline message editing to MessageEditBox", () => {
  assert.match(chatView, /from "\.\/MessageEditBox";/);
  assert.match(chatView, /<MessageEditBox/);
  assert.doesNotMatch(chatView, /className="message-edit"/);
  assert.doesNotMatch(chatView, /message-edit-actions/);
  assert.match(messageEditBox, /export function MessageEditBox/);
  assert.match(messageEditBox, /className="message-edit"/);
  assert.match(messageEditBox, /event\.key === "Enter" && \(event\.metaKey \|\| event\.ctrlKey\)/);
  assert.match(messageEditBox, /event\.key === "Escape"/);
});

test("ChatView delegates message metadata copy to MessageMetaCopy", () => {
  assert.match(chatView, /from "\.\/MessageMetaCopy";/);
  assert.match(chatView, /<MessageMetaCopy/);
  assert.doesNotMatch(chatView, /className="chat-message-meta-copy"/);
  assert.doesNotMatch(chatView, /MemoryUsagePopover/);
  assert.doesNotMatch(chatView, /formatChatDuration/);
  assert.match(messageMetaCopy, /export function MessageMetaCopy/);
  assert.match(messageMetaCopy, /className="chat-message-meta-copy"/);
  assert.match(messageMetaCopy, /MemoryUsagePopover/);
  assert.match(messageMetaCopy, /formatChatDuration/);
  assert.match(messageMetaCopy, /visibleMessageMetadata/);
});

test("ChatView delegates post-message status badges to MessageStatusBadges", () => {
  assert.match(chatView, /from "\.\/MessageStatusBadges";/);
  assert.match(chatView, /<MessageStatusBadges/);
  assert.doesNotMatch(chatView, /className="message-incomplete-note"/);
  assert.doesNotMatch(chatView, /className="auto-continue-status"/);
  assert.match(messageStatusBadges, /export function MessageStatusBadges/);
  assert.match(messageStatusBadges, /className="message-incomplete-note"/);
  assert.match(messageStatusBadges, /className="auto-continue-status"/);
  assert.match(messageStatusBadges, /chat\.responseLikelyInterrupted/);
  assert.match(messageStatusBadges, /chat\.autoCompleting/);
});

test("ChatView delegates system message headers to ChatSystemMessageHeader", () => {
  assert.match(chatView, /from "\.\/ChatSystemMessageHeader";/);
  assert.match(chatView, /<ChatSystemMessageHeader/);
  assert.doesNotMatch(chatView, /className="assistant-label system-label"/);
  assert.doesNotMatch(chatView, /Clock3/);
  assert.match(chatSystemMessageHeader, /export function ChatSystemMessageHeader/);
  assert.match(chatSystemMessageHeader, /className="assistant-label system-label"/);
  assert.match(chatSystemMessageHeader, /Clock3/);
  assert.match(chatSystemMessageHeader, /chat\.roleSystem/);
});

test("ChatView delegates pending assistant rendering to PendingAssistantMessage", () => {
  assert.match(chatView, /from "\.\/PendingAssistantMessage";/);
  assert.match(chatView, /<PendingAssistantMessage/);
  assert.doesNotMatch(chatView, /className="message chat-message-agent pending"/);
  assert.doesNotMatch(chatView, /Sparkles/);
  assert.match(pendingAssistantMessage, /export function PendingAssistantMessage/);
  assert.match(pendingAssistantMessage, /className="message chat-message-agent pending"/);
  assert.match(pendingAssistantMessage, /AssistantThinkingState/);
  assert.match(pendingAssistantMessage, /chat\.roleAssistant/);
});

test("ChatView delegates message activity rendering to MessageActivity", () => {
  assert.match(chatView, /import \{ MessageActivity \} from "\.\/MessageActivity";/);
  assert.match(chatView, /<MessageActivity text=\{displayMessage\.text\} live=\{false\}/);
  assert.doesNotMatch(chatView, /function MessageActivity\(/);
  assert.doesNotMatch(chatView, /function parseActivitySteps\(/);
  assert.match(chatPayloadParsers, /import \{ parseActivitySteps \} from "\.\/MessageActivity";/);
  assert.match(messageActivity, /export function MessageActivity/);
  assert.match(messageActivity, /export function parseActivitySteps/);
  assert.match(messageActivity, /msg-activity-steps/);
  assert.match(messageActivity, /ACTIVITY_RE/);
});

test("ChatView delegates assistant thinking rendering to AssistantThinkingState", () => {
  assert.match(chatView, /import \{ AssistantThinkingState, type ChatStreamStatus \} from "\.\/AssistantThinkingState";/);
  assert.match(chatView, /<AssistantThinkingState status=\{streamStatus\}/);
  assert.doesNotMatch(chatView, /function AssistantThinkingState\(/);
  assert.doesNotMatch(chatView, /interface ChatStreamStatus/);
  assert.match(assistantThinkingState, /export interface ChatStreamStatus/);
  assert.match(assistantThinkingState, /export function AssistantThinkingState/);
  assert.match(assistantThinkingState, /assistant-thinking-state/);
  assert.match(assistantThinkingState, /thinking-elapsed/);
});

test("ChatView delegates generated artifact rendering to MessageArtifacts", () => {
  assert.match(chatView, /from "\.\/MessageArtifacts";/);
  assert.match(assistantMessageBody, /<MessageArtifacts text=\{text\} onOpen=\{onOpenArtifact\}/);
  assert.doesNotMatch(chatView, /function MessageArtifacts\(/);
  assert.doesNotMatch(chatView, /function ArtifactCardRow\(/);
  assert.doesNotMatch(chatView, /function InlineArtifactPreview\(/);
  assert.doesNotMatch(chatView, /function parseArtifacts\(/);
  assert.match(messageArtifacts, /export function MessageArtifacts/);
  assert.match(messageArtifacts, /export function ArtifactsList/);
  assert.match(messageArtifacts, /export function ArtifactPreviewBody/);
  assert.match(messageArtifacts, /export function parseArtifacts/);
  assert.match(messageArtifacts, /export async function buildArtifactPreview/);
  assert.match(messageArtifacts, /export async function triggerArtifactDownload/);
  assert.match(messageArtifacts, /msg-artifacts/);
});

test("InspectorView delegates the artifacts workbench panel to ArtifactsPanel", () => {
  assert.match(chatView, /from "\.\/InspectorView";/);
  assert.doesNotMatch(chatView, /from "\.\/ArtifactsPanel";/);
  assert.match(inspectorView, /from "\.\/ArtifactsPanel";/);
  assert.match(inspectorView, /<ArtifactsPanel[\s\S]*artifacts=\{\[resourceArtifact\]\}/);
  assert.doesNotMatch(chatView, /function ArtifactsPanel\(/);
  assert.doesNotMatch(chatView, /function applyPreview\(/);
  assert.match(artifactsPanel, /export function ArtifactsPanel/);
  assert.match(artifactsPanel, /<ArtifactPreviewBody[\s\S]*?preview=\{preview\}/);
  assert.match(artifactsPanel, /coreBridge\.artifactVersions/);
  assert.match(artifactsPanel, /diffStats/);
  assert.match(artifactsPanel, /triggerArtifactDownload/);
});

test("InspectorView delegates the goals workbench panel to GoalsPanel", () => {
  assert.match(chatView, /from "\.\/InspectorView";/);
  assert.doesNotMatch(chatView, /from "\.\/GoalsPanel";/);
  assert.match(inspectorView, /from "\.\/GoalsPanel";/);
  assert.match(inspectorView, /<GoalsPanel[\s\S]*data=\{goalsData\}/);
  assert.doesNotMatch(chatView, /function GoalsPanel\(/);
  assert.doesNotMatch(chatView, /function normalizeGoalText\(/);
  assert.doesNotMatch(chatView, /function dedupeGoalDrafts\(/);
  assert.match(goalsPanel, /export function GoalsPanel/);
  assert.match(goalsPanel, /function normalizeGoalText/);
  assert.match(goalsPanel, /function dedupeGoalDrafts/);
  assert.match(goalsPanel, /coreBridge\.addGoal/);
  assert.match(goalsPanel, /coreBridge\.promoteGoals/);
});

test("InspectorView delegates memory graph rendering to MemoryGraphPanel", () => {
  assert.match(chatView, /from "\.\/InspectorView";/);
  assert.doesNotMatch(chatView, /from "\.\/MemoryGraphPanel";/);
  assert.match(inspectorView, /from "\.\/MemoryGraphPanel";/);
  assert.match(inspectorView, /<MemoryGraphPanel threadId=\{threadId\} layoutSignal=\{layoutSignal\}/);
  assert.doesNotMatch(chatView, /function MemoryGraphPanel\(/);
  assert.doesNotMatch(chatView, /react-force-graph-2d/);
  assert.doesNotMatch(chatView, /const GRAPH_KIND_STYLE/);
  assert.match(memoryGraphPanel, /export function MemoryGraphPanel/);
  assert.match(memoryGraphPanel, /react-force-graph-2d/);
  assert.match(memoryGraphPanel, /const GRAPH_KIND_STYLE/);
  assert.match(memoryGraphPanel, /resizeFitTimer/);
  assert.match(memoryView, /from "\.\/MemoryGraphPanel";/);
  assert.doesNotMatch(memoryView, /from "\.\/ChatView";/);
});

test("ChatView delegates inspector body rendering to InspectorView", () => {
  assert.match(chatView, /from "\.\/InspectorView";/);
  assert.match(chatView, /<InspectorView[\s\S]*descriptor=\{tab\}/);
  assert.doesNotMatch(chatView, /function InspectorView\(/);
  assert.doesNotMatch(chatView, /fileStatus === "missing"/);
  assert.doesNotMatch(chatView, /coreBridge\.taskQueue/);
  assert.doesNotMatch(chatView, /coreBridge\.fsList/);
  assert.match(inspectorView, /export function InspectorView/);
  assert.match(inspectorView, /fileStatus === "missing"/);
  assert.match(inspectorView, /\.taskQueue\(/);
  assert.match(inspectorView, /\.fsList\(/);
});

test("ChatView delegates message and formatting helpers to chatViewMessages", () => {
  assert.match(chatView, /from "\.\.\/lib\/chatViewMessages";/);
  assert.doesNotMatch(chatView, /function describeBridgeError\(/);
  assert.doesNotMatch(chatView, /function withChatMetrics\(/);
  assert.doesNotMatch(chatView, /function formatChatDuration\(/);
  assert.doesNotMatch(chatView, /function messageContentKind\(/);
  assert.doesNotMatch(chatView, /function fileLocalPath\(/);
  assert.match(chatViewMessages, /export function describeBridgeError/);
  assert.match(chatViewMessages, /export function withChatMetrics/);
  assert.match(chatViewMessages, /export function chatMessageFromAssistantResult/);
  assert.match(chatViewMessages, /export function fileLocalPath/);
  assert.match(chatViewMessages, /fileLocalPathFromBridge/);
});

test("ChatView delegates structured payload parsing to ChatPayloadParsers", () => {
  assert.match(chatView, /from "\.\/ChatPayloadParsers";/);
  assert.doesNotMatch(chatView, /function eventPayload\(/);
  assert.doesNotMatch(chatView, /function parseVaultProposalPayload\(/);
  assert.doesNotMatch(chatView, /function parseVaultRevealPayload\(/);
  assert.doesNotMatch(chatView, /function parsePaymentApprovalPayload\(/);
  assert.doesNotMatch(chatView, /function parseChoicePromptPayload\(/);
  assert.doesNotMatch(chatView, /function latestPlanMarkdown\(/);
  assert.doesNotMatch(chatView, /function latestActivitySteps\(/);
  assert.match(chatPayloadParsers, /export function eventPayload/);
  assert.match(chatPayloadParsers, /export function parseVaultProposalPayload/);
  assert.match(chatPayloadParsers, /export function parsePaymentApprovalPayload/);
  assert.match(chatPayloadParsers, /export function parseChoicePromptPayload/);
  assert.match(chatPayloadParsers, /export function latestActivitySteps/);
});

test("ChatView delegates assistant message body rendering to AssistantMessageBody", () => {
  assert.match(chatView, /from "\.\/AssistantMessageBody";/);
  assert.match(chatView, /<AssistantMessageBody[\s\S]*text=\{displayMessage\.text\}/);
  assert.doesNotMatch(chatView, /const AssistantMessageBody = memo/);
  assert.doesNotMatch(chatView, /function humanizeToolSlugs/);
  assert.doesNotMatch(chatView, /parseComposioConfirm\(text, eventParts\)/);
  assert.match(assistantMessageBody, /export const AssistantMessageBody = memo/);
  assert.match(assistantMessageBody, /parseComposioConfirm\(text, eventParts\)/);
  assert.match(assistantMessageBody, /visibleMessageText\(visible\)/);
});

test("ChatView delegates resume marker persistence to chatResumeMarkers", () => {
  assert.match(chatView, /from "\.\.\/lib\/chatResumeMarkers";/);
  assert.doesNotMatch(chatView, /RESUME_MARKER_TTL_MS/);
  assert.doesNotMatch(chatView, /function resumeMarkerKey/);
  assert.doesNotMatch(chatView, /window\.localStorage\.(?:setItem|getItem|removeItem)/);
  assert.match(chatResumeMarkers, /export interface ResumeMarker/);
  assert.match(chatResumeMarkers, /RESUME_MARKER_TTL_MS/);
  assert.match(chatResumeMarkers, /window\.localStorage\.setItem/);
  assert.match(chatResumeMarkers, /window\.localStorage\.getItem/);
  assert.match(chatResumeMarkers, /window\.localStorage\.removeItem/);
});

test("ChatView delegates chat event projection helpers to chatEventParts", () => {
  assert.match(chatView, /from "\.\.\/lib\/chatEventParts";/);
  assert.doesNotMatch(chatView, /function chatEventPartFromStream/);
  assert.doesNotMatch(chatView, /function normalizeChatEventParts/);
  assert.doesNotMatch(chatView, /function shouldDropStructuredMarkerDelta/);
  assert.doesNotMatch(chatView, /function replayStatusFromProjection/);
  assert.doesNotMatch(chatView, /function threadTailAwaitsUser/);
  assert.doesNotMatch(chatView, /interface ActiveTurnProjection/);
  assert.match(chatEventParts, /export function chatEventPartFromStream/);
  assert.match(chatEventParts, /export function normalizeChatEventParts/);
  assert.match(chatEventParts, /export function shouldDropStructuredMarkerDelta/);
  assert.match(chatEventParts, /export function replayStatusFromProjection/);
  assert.match(chatEventParts, /export function threadTailAwaitsUser/);
  assert.match(chatEventParts, /export interface ActiveTurnProjection/);
});

test("ChatView does not retain retired unused chat mode helpers", () => {
  assert.doesNotMatch(chatView, /function isLatestAssistantMessage/);
  assert.doesNotMatch(chatView, /const CHAT_MODES:/);
  assert.doesNotMatch(chatView, /type ChatMode =/);
  assert.doesNotMatch(chatView, /Systematic debugging \(code projects\)/);
});

test("ChatView does not retain retired topbar status props", () => {
  assert.doesNotMatch(chatView, /activeHealth/);
  assert.doesNotMatch(chatView, /activeModelInfo/);
  assert.doesNotMatch(chatView, /headerModelLabel/);
  assert.doesNotMatch(chatView, /headerToolPolicy/);
  assert.doesNotMatch(chatView, /health: RuntimeHealth/);
  assert.doesNotMatch(chatView, /task: TaskItem/);
  assert.doesNotMatch(app, /health=\{runtimeItems\}/);
  assert.doesNotMatch(app, /task=\{selectedTask\}/);
});

test("ChatView does not retain retired unused UI flags", () => {
  assert.doesNotMatch(chatView, /modelOpen/);
  assert.doesNotMatch(chatView, /timelineCollapsed/);
  assert.doesNotMatch(chatView, /setTimelineCollapsed/);
  assert.doesNotMatch(chatView, /chatExported/);
  assert.doesNotMatch(chatView, /setChatExported/);
});

test("ChatView delegates workspace island section bodies", () => {
  assert.match(chatView, /from "\.\/WorkspaceIslandSections";/);
  assert.match(chatView, /<WorkspaceIslandSections/);
  assert.doesNotMatch(chatView, /workspace-island-activity/);
  assert.doesNotMatch(chatView, /workspace-island-browser/);
  assert.doesNotMatch(chatView, /workspace-island-files/);
  assert.match(workspaceIslandSections, /export function WorkspaceIslandSections/);
  assert.match(workspaceIslandSections, /workspace-island-activity/);
  assert.match(workspaceIslandSections, /workspace-island-browser/);
  assert.match(workspaceIslandSections, /workspace-island-files/);
});

test("InspectorView delegates operational plan preview rendering and parsing", () => {
  assert.match(inspectorView, /from "\.\/OperationalPlanPreview";/);
  assert.match(inspectorView, /<OperationalPlanPreview collapsed=\{false\} markdown=\{operationalPlanMarkdown\}/);
  assert.match(inspectorView, /parseOperationalPlanItems\(operationalPlanMarkdown\)/);
  assert.doesNotMatch(chatView, /function OperationalPlanPreview\(/);
  assert.doesNotMatch(chatView, /function parseOperationalPlanItems\(/);
  assert.doesNotMatch(chatView, /function planPreviewItems\(/);
  assert.match(operationalPlanPreview, /export function OperationalPlanPreview/);
  assert.match(operationalPlanPreview, /export function parseOperationalPlanItems/);
  assert.match(operationalPlanPreview, /operational-plan-preview/);
});

test("ChatView delegates choice prompt rendering to MessageChoiceCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageChoiceCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageChoiceCard";/);
  assert.match(assistantMessageBody, /<ChoicesCard prompt=\{choices\} onChoose=\{onChoose\}/);
  assert.doesNotMatch(chatView, /function ChoicesCard\(/);
  assert.doesNotMatch(chatView, /interface ChoicePrompt/);
  assert.match(messageChoiceCard, /export interface ChoicePrompt/);
  assert.match(messageChoiceCard, /export function ChoicesCard/);
  assert.match(messageChoiceCard, /choices-card/);
});

test("ChatView delegates proposed plan rendering to MessagePlanProposeCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessagePlanProposeCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessagePlanProposeCard";/);
  assert.match(assistantMessageBody, /<PlanProposeCard plan=\{planPropose\} onAnswer=\{onChoose\}/);
  assert.doesNotMatch(chatView, /function PlanProposeCard\(/);
  assert.doesNotMatch(chatView, /interface PlanProposal/);
  assert.match(messagePlanProposeCard, /export interface PlanProposal/);
  assert.match(messagePlanProposeCard, /export function PlanProposeCard/);
  assert.match(messagePlanProposeCard, /plan-card-gate/);
});

test("ChatView does not retain the retired inline operational plan progress card", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessagePlanProgressCard";/);
  assert.doesNotMatch(chatView, /<PlanProgressCard/);
  assert.doesNotMatch(chatView, /function PlanProgressCard\(/);
  assert.doesNotMatch(chatView, /interface PlanStep/);
  assert.doesNotMatch(chatView, /function parsePlanSteps\(/);
  assert.match(chatPayloadParsers, /export interface PlanStep/);
  assert.match(chatPayloadParsers, /export function parsePlanSteps\(markdown: string\): PlanStep\[\]/);
});

test("ChatView delegates diff message rendering to MessageDiffCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageDiffCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageDiffCard";/);
  assert.match(assistantMessageBody, /<DiffCard key=\{`diff-\$\{index\}`\} payload=\{part\.payload\}/);
  assert.doesNotMatch(chatView, /function DiffCard\(/);
  assert.match(messageDiffCard, /export function DiffCard/);
  assert.match(messageDiffCard, /DiffEventPayload/);
  assert.match(messageDiffCard, /diff-card/);
});

test("ChatView delegates proposed goal rendering to MessageGoalProposeCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageGoalProposeCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageGoalProposeCard";/);
  assert.match(assistantMessageBody, /<GoalProposeCard objectives=\{goalPropose\} threadId=\{threadId\}/);
  assert.doesNotMatch(chatView, /function GoalProposeCard\(/);
  assert.match(messageGoalProposeCard, /export function GoalProposeCard/);
  assert.match(messageGoalProposeCard, /coreBridge\.projectGoals/);
  assert.match(messageGoalProposeCard, /\.addGoal/);
  assert.match(messageGoalProposeCard, /goal-propose-card/);
});

test("ChatView delegates vault reveal rendering to MessageVaultRevealCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageVaultRevealCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageVaultRevealCard";/);
  assert.match(assistantMessageBody, /<VaultRevealCard proposal=\{vaultReveal\}/);
  assert.doesNotMatch(chatView, /function VaultRevealCard\(/);
  assert.doesNotMatch(chatView, /interface VaultRevealProposal/);
  assert.match(messageVaultRevealCard, /export interface VaultRevealProposal/);
  assert.match(messageVaultRevealCard, /export function VaultRevealCard/);
  assert.match(messageVaultRevealCard, /coreBridge\.vaultRecordReveal/);
  assert.match(messageVaultRevealCard, /Vault unlock required/);
});

test("ChatView delegates sandbox read-only rendering to MessageSandboxReadOnlyCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageSandboxReadOnlyCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageSandboxReadOnlyCard";/);
  assert.match(assistantMessageBody, /<SandboxReadOnlyCard target=\{readOnlyBlocked\.target\}/);
  assert.doesNotMatch(chatView, /function SandboxReadOnlyCard\(/);
  assert.match(messageSandboxReadOnlyCard, /export function SandboxReadOnlyCard/);
  assert.match(messageSandboxReadOnlyCard, /coreBridge\.setRuntimeSettings/);
  assert.match(messageSandboxReadOnlyCard, /sandbox_mode: "workspace-write"/);
  assert.match(messageSandboxReadOnlyCard, /sandboxReadOnlyTitle/);
});

test("ChatView delegates Composio reconnect rendering to MessageComposioReconnectCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageComposioReconnectCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageComposioReconnectCard";/);
  assert.match(assistantMessageBody, /<ComposioReconnectCard slug=\{reconnectSlug\}/);
  assert.doesNotMatch(chatView, /function ComposioReconnectCard\(/);
  assert.match(messageComposioReconnectCard, /export function ComposioReconnectCard/);
  assert.match(messageComposioReconnectCard, /connectComposioToolkit/);
  assert.match(messageComposioReconnectCard, /chat\.openingReconnection/);
});

test("ChatView delegates uncertain effect verification to InlineUncertainEffectPanel", () => {
  assert.match(chatView, /from "\.\/InlineUncertainEffectPanel";/);
  assert.match(chatView, /<InlineUncertainEffectPanel\s+effects=\{uncertainEffects\}/);
  assert.doesNotMatch(chatView, /function InlineUncertainEffectPanel\(/);
  assert.doesNotMatch(chatView, /function effectFamilyLabel\(/);
  assert.doesNotMatch(chatView, /function formatEffectTime\(/);
  assert.match(inlineUncertainEffectPanel, /export function InlineUncertainEffectPanel/);
  assert.match(inlineUncertainEffectPanel, /effectFamilyLabel/);
  assert.match(inlineUncertainEffectPanel, /formatEffectTime/);
  assert.match(inlineUncertainEffectPanel, /verifiedNotApplied/);
});

test("ChatView delegates inline approvals to InlineApprovelPanel", () => {
  assert.match(chatView, /from "\.\/InlineApprovelPanel";/);
  assert.match(chatView, /<InlineApprovelPanel[\s\S]*approvals=\{activeApprovels\}/);
  assert.doesNotMatch(chatView, /function InlineApprovelPanel\(/);
  assert.doesNotMatch(chatView, /const surfaceIcons:/);
  assert.match(inlineApprovelPanel, /export function InlineApprovelPanel/);
  assert.match(inlineApprovelPanel, /const surfaceIcons:/);
  assert.match(inlineApprovelPanel, /busyId === approval\.id/);
  assert.match(inlineApprovelPanel, /approval-plan-preview/);
});

test("ChatView delegates payment approval rendering to MessagePaymentApprovalCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessagePaymentApprovalCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessagePaymentApprovalCard";/);
  assert.match(assistantMessageBody, /<PaymentApprovalCard[\s\S]*proposal=\{paymentApproval\}/);
  assert.doesNotMatch(chatView, /function PaymentApprovalCard\(/);
  assert.doesNotMatch(chatView, /function formatPaymentAmount\(/);
  assert.match(messagePaymentApprovalCard, /export interface PaymentApprovalProposal/);
  assert.match(messagePaymentApprovalCard, /export function PaymentApprovalCard/);
  assert.match(messagePaymentApprovalCard, /coreBridge\.vaultPaymentApprovalApprove/);
  assert.match(messagePaymentApprovalCard, /formatPaymentAmount/);
});

test("ChatView delegates filesystem authorization rendering to MessageFsAuthorizeCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageFsAuthorizeCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageFsAuthorizeCard";/);
  assert.match(assistantMessageBody, /<FsAuthorizeCard[\s\S]*path=\{fsAuthorize\.path\}/);
  assert.doesNotMatch(chatView, /function FsAuthorizeCard\(/);
  assert.match(messageFsAuthorizeCard, /export function FsAuthorizeCard/);
  assert.match(messageFsAuthorizeCard, /coreBridge\.fsAuthorize/);
  assert.match(messageFsAuthorizeCard, /chat\.authorizationFailed/);
});

test("ChatView delegates sandbox escalation rendering to MessageSandboxEscalateCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageSandboxEscalateCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageSandboxEscalateCard";/);
  assert.match(assistantMessageBody, /<SandboxEscalateCard[\s\S]*command=\{sandboxEscalate\.command\}/);
  assert.doesNotMatch(chatView, /function SandboxEscalateCard\(/);
  assert.match(messageSandboxEscalateCard, /export function SandboxEscalateCard/);
  assert.match(messageSandboxEscalateCard, /coreBridge\.runEscalate/);
  assert.match(messageSandboxEscalateCard, /Run without sandbox/);
});

test("ChatView delegates Composio and MCP confirmations to MessageComposioConfirmCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageComposioConfirmCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageComposioConfirmCard";/);
  assert.match(assistantMessageBody, /<ComposioConfirmCard action=\{action\}/);
  assert.doesNotMatch(chatView, /function ComposioConfirmCard\(/);
  assert.doesNotMatch(chatView, /function parseComposioConfirm\(/);
  assert.doesNotMatch(chatView, /COMPOSIO_CONFIRM_RE/);
  assert.doesNotMatch(chatView, /from "\.\/ChatMessageMarkerParser";/);
  assert.match(assistantMessageBody, /from "\.\/ChatMessageMarkerParser";/);
  assert.match(chatMessageMarkerParser, /export function parseComposioConfirm/);
  assert.match(chatMessageMarkerParser, /COMPOSIO_CONFIRM_RE/);
  assert.match(chatMessageMarkerParser, /MCP_CONFIRM_RE/);
  assert.match(chatMessageMarkerParser, /SANDBOX_ESCALATE_RE/);
  assert.doesNotMatch(chatView, /const COMPOSIO_FIELD_LABELS:/);
  assert.doesNotMatch(chatView, /const OPAQUE_FIELD_KEYS =/);
  assert.doesNotMatch(chatView, /function humanizeFieldKey\(/);
  assert.doesNotMatch(chatView, /function humanizeToolName\(/);
  assert.match(messageComposioConfirmCard, /export interface ComposioPendingAction/);
  assert.match(messageComposioConfirmCard, /export function ComposioConfirmCard/);
  assert.match(messageComposioConfirmCard, /export function humanizeToolName/);
  assert.match(messageComposioConfirmCard, /coreBridge\.composioExecute/);
  assert.match(messageComposioConfirmCard, /coreBridge\.mcpExecute/);
  assert.match(messageComposioConfirmCard, /confirmDestructiveAction/);
});

test("ChatView delegates capability suggestions to MessageConnectSuggestCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageConnectSuggestCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageConnectSuggestCard";/);
  assert.match(assistantMessageBody, /<ConnectSuggestCard[\s\S]*suggest=\{connectSuggest\}/);
  assert.doesNotMatch(chatView, /function ConnectSuggestCard\(/);
  assert.doesNotMatch(chatView, /function ConnectSuggestRow\(/);
  assert.doesNotMatch(chatView, /const CONNECT_KIND_META:/);
  assert.match(messageConnectSuggestCard, /export interface ConnectSuggest/);
  assert.match(messageConnectSuggestCard, /export function ConnectSuggestCard/);
  assert.match(messageConnectSuggestCard, /coreBridge\.mcpConnect/);
  assert.match(messageConnectSuggestCard, /coreBridge\.catalogInstall/);
  assert.match(messageConnectSuggestCard, /connectComposioToolkit/);
});

test("ChatView delegates vault proposal rendering to MessageVaultProposeCard", () => {
  assert.doesNotMatch(chatView, /from "\.\/MessageVaultProposeCard";/);
  assert.match(assistantMessageBody, /from "\.\/MessageVaultProposeCard";/);
  assert.match(assistantMessageBody, /<VaultProposeCard[\s\S]*proposal=\{vaultPropose\}/);
  assert.doesNotMatch(chatView, /function VaultProposeCard\(/);
  assert.match(messageVaultProposeCard, /export interface VaultProposal/);
  assert.match(messageVaultProposeCard, /export function VaultProposeCard/);
  assert.match(messageVaultProposeCard, /coreBridge\.vaultProposalAccept/);
  assert.match(messageVaultProposeCard, /coreBridge\.vaultProposalDismiss/);
  assert.match(messageVaultProposeCard, /Similar Vault record exists/);
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

test("shared menus keep compact commands separate from descriptive rows", () => {
  assert.match(
    menus,
    /\.menu-surface\s*\{[\s\S]*?padding:\s*6px;/,
  );
  assert.match(
    menus,
    /\.menu-item\s*\{[\s\S]*?height:\s*32px;[\s\S]*?min-height:\s*32px;/,
  );
  assert.match(
    composerStyles,
    /\.composer-menu-list \.menu-item:has\(\.menu-item__label small\)\s*\{[\s\S]*?height:\s*auto;[\s\S]*?min-height:\s*44px;/,
  );
  assert.match(
    composerStyles,
    /\.composer-menu-list \.menu-item__label small\s*\{[\s\S]*?line-height:\s*1\.3;/,
  );
});

test("sidebar hover and active states share one stable full-row surface", () => {
  assert.match(
    sidebarStyles,
    /\.drawer-thread-row:hover \.drawer-thread-main,[\s\S]*?\.drawer-thread-row:focus-within \.drawer-thread-main\s*\{[\s\S]*?background:\s*var\(--surface-hover\);/,
  );
  assert.match(
    sidebarStyles,
    /\.drawer-thread-actions\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/,
  );
  assert.match(
    sidebarStyles,
    /\.drawer-thread-row\s*\{[\s\S]*?min-height:\s*30px;/,
  );
  assert.match(
    sidebarStyles,
    /\.drawer-project-row:hover,[\s\S]*?\.drawer-project-row:focus-within\s*\{/,
  );
  assert.doesNotMatch(sidebarStyles, /\.drawer-project:focus-within/);
});

test("composer spacing keeps prompt and metadata compact but distinct", () => {
  assert.match(
    composerStyles,
    /\.composer-surface\s*\{[\s\S]*?margin:\s*6px auto 10px;[\s\S]*?gap:\s*8px;/,
  );
  assert.match(
    composerStyles,
    /\.composer-metadata-row\s*\{[\s\S]*?padding:\s*0 4px;/,
  );
});

test("composer keeps prior effective-model provenance separate from the next-turn override", () => {
  assert.match(chatView, /lastAssistantEffectiveModel/);
  assert.match(chatView, /threadMessages[\s\S]*?role\s*===\s*"assistant"[\s\S]*?\.model/);
  assert.match(composerShell, /selectedNextTurnModel/);
  assert.match(composerShell, /effectiveModelLabel/);
  assert.match(composerShell, /composerModelButtonLabel/);
  assert.doesNotMatch(composerShell, /modelButtonLabel:\s*string/);
  assert.doesNotMatch(chatView, /const modelButtonLabel = selectedModel[\s\S]*?activeModel[\s\S]*?effectiveModelLabel;/);
  assert.doesNotMatch(
    composerShell,
    /effectiveModelLabel\s*=\s*[^\n]*selectedNextTurnModel/,
  );
});

test("runtime context trigger is icon-only while retaining accessible text", () => {
  assert.match(
    composerShell,
    /id="composer-runtime-trigger"[\s\S]*?className="composer-runtime-button"[\s\S]*?aria-label=\{t\("composer\.runtimeContext"\)\}[\s\S]*?title=\{t\("composer\.runtimeContext"\)\}/,
  );
  assert.doesNotMatch(
    composerShell,
    /id="composer-runtime-trigger"[\s\S]*?<span>\{t\("composer\.runtimeContext"\)\}<\/span>/,
  );
  assert.match(composerStyles, /\.composer-runtime-button\s*\{[\s\S]*?width:\s*26px;[\s\S]*?justify-content:\s*center;/);
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
  assert.match(composerContainer, /selectedModelAfterSubmission\(current, accepted\)/);
  assert.doesNotMatch(
    composerContainer,
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
