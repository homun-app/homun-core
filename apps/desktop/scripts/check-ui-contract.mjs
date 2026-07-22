import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const removedShellName = ["t", "auri"].join("");
const removedShellSourceDir = ["src", removedShellName].join("-");
const removedShellPackageScope = `@${removedShellName}-apps`;
const removedShellGlobal = `__${removedShellName.toUpperCase()}__`;

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function readFromRepo(path) {
  return readFileSync(join(root, "..", "..", path), "utf8");
}

function assertContains(file, text, description) {
  const source = read(file);
  if (!source.includes(text)) {
    throw new Error(`${description}: expected ${file} to contain ${text}`);
  }
}

function assertSource(file, snippets) {
  for (const snippet of snippets) {
    assertContains(file, snippet, `${file} UI contract`);
  }
}

function assertNotContains(file, text, description) {
  const source = read(file);
  if (source.includes(text)) {
    throw new Error(`${description}: expected ${file} not to contain ${text}`);
  }
}

function assertMissing(path, description) {
  if (existsSync(join(root, path))) {
    throw new Error(`${description}: expected ${path} to be absent`);
  }
}

function assertRepoContains(file, text, description) {
  const source = readFromRepo(file);
  if (!source.includes(text)) {
    throw new Error(`${description}: expected ${file} to contain ${text}`);
  }
}

function assertRepoNotContains(file, text, description) {
  const source = readFromRepo(file);
  if (source.includes(text)) {
    throw new Error(`${description}: expected ${file} not to contain ${text}`);
  }
}

function assertMatches(file, pattern, description) {
  const source = read(file);
  if (!pattern.test(source)) {
    throw new Error(`${description}: expected ${file} to match ${pattern}`);
  }
}

function assertNotMatches(file, pattern, description) {
  const source = read(file);
  if (pattern.test(source)) {
    throw new Error(`${description}: expected ${file} not to match ${pattern}`);
  }
}

assertContains("package.json", "electron:dev", "desktop app must run through Electron");
assertContains("package.json", "package:prepare", "desktop package must prepare production-like Electron resources");
assertContains("package.json", "package:smoke", "desktop package must support production-like smoke testing without Vite");
assertContains("package.json", "\"electron\"", "desktop app must depend on Electron");
assertNotContains("package.json", removedShellName, "desktop package must not expose removed shell scripts or dependencies");
assertMissing(removedShellSourceDir, "removed shell source tree must be absent from the desktop app");
assertContains("electron/main.cjs", "contextIsolation: true", "Electron shell must keep renderer isolation enabled");
assertContains("electron/main.cjs", "nodeIntegration: false", "Electron shell must not expose Node to the renderer");
assertContains("electron/main.cjs", "sandbox: true", "Electron shell must run the renderer sandboxed");
assertContains("electron/main.cjs", "titleBarStyle: \"hidden\"", "Electron shell must keep native OS controls with a hidden titlebar");
assertContains("electron/main.cjs", "trafficLightPosition", "macOS native traffic lights must have an explicit aligned position");
assertContains("electron/main.cjs", "titleBarOverlay", "Windows/Linux native window controls must use the Window Controls Overlay");
assertNotContains("electron/main.cjs", "frame: false", "desktop shell must not replace native OS window controls with fake HTML controls");
assertContains("electron/main.cjs", "ensureGateway", "Electron shell must own desktop gateway lifecycle");
assertContains("electron/main.cjs", "HOMUN_DESKTOP_GATEWAY_TOKEN", "Electron shell must generate/pass the local gateway token");
assertContains("electron/main.cjs", "HOMUN_DESKTOP_RESOURCES_DIR", "Electron shell must support production-like local resource smoke tests");
assertContains("electron/main.cjs", "before-quit", "Electron shell must stop managed gateway process on app quit");
assertContains("electron/main.cjs", "const mainWindows = new Set();", "Electron shell must retain BrowserWindow references");
assertContains("electron/main.cjs", "mainWindows.add(window);", "Electron shell must keep created windows alive");
assertContains("electron/main.cjs", "mainWindows.delete(window);", "Electron shell must release windows only after close");
assertContains("electron/preload.cjs", "contextBridge.exposeInMainWorld", "Electron preload must expose only minimal runtime config");
assertNotContains("electron/preload.cjs", "platform: process.platform", "renderer must not depend on platform-specific native control alignment");
assertNotContains("electron/preload.cjs", "windowAction", "renderer must not own native window control behavior");
assertContains("scripts/prepare-package.mjs", "local-first-desktop-gateway", "package preparation must copy the gateway binary");
assertContains("scripts/electron-dev.mjs", "waitForDevServer", "Electron dev shell must wait for Vite before launch");
assertContains("scripts/electron-dev.mjs", "stopGatewayOnPort", "Electron dev shell must clear stale gateway listeners before Electron owns lifecycle");
assertContains("src/styles.css", "--window-drag-height", "Electron shell must reserve native window control space");
assertContains("src/styles.css", "-webkit-app-region: drag", "Electron shell must expose a draggable titlebar region");
assertContains("src/styles.css", "-webkit-app-region: no-drag", "interactive controls must remain clickable inside Electron");
assertContains("src/lib/accent.ts", "\"dark\"", "appearance surface themes must include a dark preset");
assertContains("src/components/OnboardingWizard.tsx", 'href="https://homun.app/docs/"', "onboarding must link to the canonical documentation site");
assertNotContains("src/components/OnboardingWizard.tsx", "https://docs.homun.app", "onboarding must not use the retired documentation host");
assertContains("src/components/OnboardingWizard.tsx", 'type Step = "prereq" | "computer" | "model" | "done"', "onboarding must have a computer preparation step");
assertContains("src/components/OnboardingWizard.tsx", "prepareSetupComputer", "computer step must start backend preparation");
assertContains("src/components/OnboardingWizard.tsx", "setupComputerStatus", "computer step must render observed backend status");
assertContains("src/components/OnboardingWizard.tsx", 't("onboarding.checkAgain")', "prerequisite screen must expose immediate recheck");
assertContains("src/lib/accent.ts", 'export const DEFAULT_THEME: ThemeName = "dark";', "fresh installs must default to the dark surface theme");
assertContains("src/lib/accent.ts", 'export const DEFAULT_ACCENT = "#157a6e";', "fresh installs must keep the Homun teal accent");
assertContains("src/types.ts", '  | "usage"', "Settings must expose a Usage section");
assertContains("src/data/mockData.ts", 'id: "usage"', "Settings drawer must list Usage");
assertContains("src/components/SettingsView.tsx", "<UsageSettingsPane />", "Settings must render Usage");
assertNotContains("src/components/SettingsView.tsx", "AdaptiveFloorBlock", "Settings must not expose the retired adaptive-floor experiment");
assertNotContains("src/lib/coreBridge.ts", "adaptive_floor", "Desktop runtime settings must not expose the retired adaptive-floor field");
assertContains("src/components/UsageSettingsPane.tsx", 'role="tablist"', "Usage views must be keyboard-addressable tabs");
assertContains("src/components/UsageSettingsPane.tsx", 'aria-live="polite"', "Usage loading and errors must be announced");
assertContains("src/components/UsageSettingsPane.tsx", 'className="reported"', "reported cost must stay separately labeled");
assertContains("src/components/UsageSettingsPane.tsx", 'className="estimated"', "estimated cost must stay separately labeled");
assertContains("src/components/UsageSettingsPane.tsx", 'className="unknown"', "unknown cost must stay visible");
assertContains("src/components/UsageSettingsPane.tsx", "usage-coverage", "usage coverage must remain visible");
assertContains("src/components/UsageSettingsPane.tsx", "retry-count", "model rows must expose retries");
assertContains("src/components/ChatUsageOverview.tsx", 'const WINDOWS: UsageWindow[] = ["7d", "30d", "all"]', "New chat must support all approved windows");
assertContains("src/components/ChatUsageOverview.tsx", 'aria-live="polite"', "New-chat Usage load state must be announced");
assertContains("src/components/ChatUsageOverview.tsx", "coreBridge.usageSummary(selectedWindow)", "New chat must read the canonical summary");
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
assertNotContains("src/components/ChatUsageOverview.tsx", "usageModels", "New chat must not load full analytics");
assertNotContains("src/components/ChatView.tsx", "EMPTY_HERO_CHIPS", "New chat must not keep canned prompt chips");
assertNotContains("src/components/ChatView.tsx", "chat-hero-chip", "New chat must not render canned prompt buttons");
assertContains("src/components/ChatView.tsx", "<ChatUsageOverview", "Empty hero must mount compact usage");
assertContains("src/components/ChatView.tsx", "onUseForTask", "Confirmed task suggestions must reach the composer model override");
assertContains("src/components/ChatView.tsx", "enqueueTurn(thread.threadId, requestId, promptWithReplyContext", "Active task instructions must be queued as steering");
assertSource("src/components/ActiveTurnStatus.tsx", ["Attività", "onStop", "attempt"]);
assertSource("src/components/PendingSteeringQueue.tsx", ["onEdit", "onDelete", "onSendNow"]);
assertSource("src/components/ChatView.tsx", ["active-turn-tail", "pendingSteering"]);
assertContains("src/components/ChatView.tsx", "{streaming && (", "Stop must remain available while the composer stays operational");
assertContains("src/components/ChatView.tsx", "{(value.trim() || composerImages.length > 0) && (", "Send must remain available independently from Stop");
assertContains("src/lib/chatApi.ts", "res.status === 201 || res.status === 202", "Turn enqueue must accept steering responses");
assertContains("src/components/UsageSuggestion.tsx", "usage-suggestion-confirm", "Suggestion changes must use an explicit confirmation surface");
assertContains("src/components/UsageSuggestion.tsx", "confirmed: true", "Apply request must be explicitly confirmed");
assertContains("src/components/UsageSuggestion.tsx", "onDismiss", "Suggestions must be dismissible");
assertNotContains("src/components/UsageSuggestion.tsx", "useEffect(() => onApply", "Mounting must never apply a suggestion");
assertContains("src/components/ChatUsageOverview.tsx", ".slice(0, 1)", "Home must render at most one model suggestion");
assertContains("src/styles.css", ".chat-usage-infographic", "New-chat usage must provide a dedicated infographic layout");
assertContains("src/styles.css", ".usage-calendar-grid", "Usage calendar must use a shared compact grid");
assertContains("src/styles.css", ".usage-calendar-tooltip", "Usage calendar must provide an unclipped callout");
assertContains("src/styles.css", ".app-shell.drawer-open > .workspace {\n    grid-column: 1;", "Narrow Settings content must stay in the visible grid column");
assertContains("src/styles.css", ".app-shell.drawer-open > .settings-workspace {\n    padding-left: calc(min(var(--drawer-width, 292px), 292px) + 24px);", "Narrow Settings content must clear the overlay navigation");
assertContains("src/styles.css", ".active-task-layout.is-empty {\n  grid-template-rows: 58px minmax(0, 1fr) auto;", "Empty chat must keep the composer in the same bottom row as active conversations");
assertNotContains("src/styles.css", "grid-template-rows: 58px 1fr auto 1fr", "Empty chat must not vertically center the composer with spacer rows");
assertContains("src/styles.css", ".active-task-layout.is-empty .thread-content {\n  width: min(100%, 960px);", "Empty chat must give the six-month heatmap enough desktop width");
assertContains("src/styles.css", "@container chat-workspace (max-width: 860px) {\n  .chat-usage-infographic {", "The heatmap summary must stack before horizontal scrolling is needed");
assertContains("src/styles.css", ".chat-usage-infographic .usage-calendar--compact {\n    --usage-cell: 11px;\n    --usage-gap: 3px;", "Compact windows must shrink the Home cells before exposing horizontal scroll");
assertNotContains("src/components/UsageSettingsPane.tsx", "latency-p50", "Models must not show latency until canonical aggregates expose it");
assertNotContains("src/components/UsageSettingsPane.tsx", "fallback-count", "Models must not show fallback placeholders as measured data");
assertContains("src/components/UsageSettingsPane.tsx", "modelCostProvenance", "Per-model cost must disclose reported, estimated, unknown, or not-billed provenance");
assertContains("src/components/UsageSettingsPane.tsx", "coreBridge.setRole({", "Settings must apply confirmed role instructions through the canonical role API");
assertContains("src/lib/coreBridge.ts", "usageDaily:", "Usage must expose the real daily series");
assertContains("src/components/UsageCalendar.tsx", 'role="grid"', "Usage calendar must expose an accessible grid");
assertContains("src/components/UsageCalendar.tsx", 'role="gridcell"', "Usage days must be keyboard reachable");
assertContains("src/components/UsageCalendar.tsx", "onFocus", "Keyboard focus must reveal day details");
assertContains("src/components/UsageCalendar.tsx", "dominant_provider", "Usage callouts must preserve provider provenance");
assertNotContains("src/components/ChatView.tsx", "chat-hero-mark", "New chat must not keep the decorative brandmark");
assertNotContains("src/components/ChatView.tsx", "chat.emptyHeroSub", "New chat must not keep the fixed subtitle");
assertContains("src/components/ChatView.tsx", "selectGreetingKey", "New chat must select a stable curated greeting");
assertContains("src/components/ChatView.tsx", "chat-hero-headline", "New chat must render the primary greeting separately");
assertContains("src/components/ChatView.tsx", "chat-hero-prompt", "New chat must render the rotating prompt as secondary typography");
assertContains("src/styles.css", ".chat-hero-welcome", "New chat must give the welcome block its own spacing hierarchy");
assertContains("src/data/mockData.ts", 'id: "m1_ready"', "The bootstrap greeting must be recognized as a removable placeholder");
assertContains("src/components/ChatUsageOverview.tsx", "<UsageCalendar", "New chat must render the real activity calendar");
assertContains("src/components/ChatUsageOverview.tsx", "coreBridge.usageDaily", "New chat must load real daily usage");
assertContains("src/components/ChatUsageOverview.tsx", "dominant_provider", "New chat must render provider-qualified routes");
assertContains("src/components/ChatUsageOverview.tsx", "onOpenUsageSettings", "New chat must open the complete Usage workspace");
assertContains("src/components/UsageSettingsPane.tsx", "coreBridge.usageDaily", "Settings Usage must load the same real daily series as Home");
assertContains("src/components/UsageSettingsPane.tsx", "<UsageCalendar", "Settings Overview must lead with the shared activity calendar");
assertContains("src/components/UsageSettingsPane.tsx", "dominant_provider", "Settings Overview must preserve provider-qualified model identity");
assertNotContains("src/components/UsageSettingsPane.tsx", "usage-metrics", "Settings Overview must not keep the old KPI tile grid");
for (const locale of ["en", "it", "es", "fr", "de"]) {
  assertNotContains(`src/i18n/locales/${locale}.json`, '"adaptiveFloorTitle"', `${locale} must not retain the retired adaptive-floor label`);
  assertNotContains(`src/i18n/locales/${locale}.json`, '"adaptiveFloorDesc"', `${locale} must not retain the retired adaptive-floor description`);
  assertNotContains(`src/i18n/locales/${locale}.json`, '"adaptiveFloorShadow"', `${locale} must not retain the retired adaptive-floor shadow copy`);
  assertContains(`src/i18n/locales/${locale}.json`, '"use_for_task"', `${locale} must translate the task suggestion action`);
  assertContains(`src/i18n/locales/${locale}.json`, '"change_role_preference"', `${locale} must translate the preference suggestion action`);
  assertContains(`src/i18n/locales/${locale}.json`, '"dismiss"', `${locale} must translate suggestion dismissal`);
  assertContains(`src/i18n/locales/${locale}.json`, '"macAppsTitle"', `${locale} must translate Mac Apps settings`);
  assertContains(`src/i18n/locales/${locale}.json`, '"macAppsBeta"', `${locale} must label Mac Apps as beta`);
  assertContains(`src/i18n/locales/${locale}.json`, '"macAppsOptIn"', `${locale} must translate the explicit beta opt-in`);
  assertContains(`src/i18n/locales/${locale}.json`, '"macAppsLocalScreenshot"', `${locale} must explain the local-only screenshot policy`);
  assertContains(`src/i18n/locales/${locale}.json`, '"restrictions"', `${locale} must explain host control restrictions`);
}
assertContains("src/components/SettingsView.tsx", "settings.computer.containedTitle", "contained computer must remain explicit");
assertContains("src/components/SettingsView.tsx", "settings.computer.macAppsTitle", "host apps need a separate section");
assertContains("src/components/SettingsView.tsx", "mac_apps_beta_enabled", "Mac Apps must expose an explicit persisted opt-in");
assertContains("src/components/SettingsView.tsx", 'window.addEventListener("focus", refreshWhenVisible)', "Mac Apps must refresh after returning from System Settings");
assertContains("src/components/SettingsView.tsx", 'document.addEventListener("visibilitychange", refreshWhenVisible)', "Mac Apps must refresh when the app becomes visible");
assertContains("src/lib/coreBridge.ts", 'state: "unsupported" | "disabled" | "setup" | "ready" | "active" | "paused" | "error"', "host status must expose the canonical beta state machine");
assertContains("src/components/SettingsView.tsx", "revokeHostComputerGrant", "host app grants must be revocable");
assertContains("src/components/SettingsView.tsx", "presentHostComputerPermission", "TCC prompts must require a local button click");
assertNotContains("src/components/SettingsView.tsx", "grantHostComputerApp(session", "an agent session must never create grants");
assertMatches(
  "src/styles.css",
  /\.onb-model\s*\{[^}]*color:\s*var\(--o-text\);[^}]*\}/m,
  "onboarding model buttons must explicitly use readable foreground text",
);
assertMatches(
  "src/lib/accent.ts",
  /value === "freddo" \|\| value === "avorio" \|\| value === "neutro" \|\| value === "sabbia" \|\| value === "dark"/,
  "persisted dark surface theme must be accepted by the theme validator",
);
assertContains("src/styles.css", ":root[data-theme=\"dark\"]", "dark surface theme must define CSS tokens");
assertContains("src/styles.css", "color-scheme: dark", "dark surface theme must advertise dark controls to the browser");
assertContains("src/components/SettingsView.tsx", "dark:", "Appearance picker previews must include literal dark swatch values");
assertContains("src/styles.css", "background: color-mix(in srgb, var(--surface) 94%, transparent);", "Workspace Island pill must inherit the active surface theme");
assertContains("src/styles.css", "background: color-mix(in srgb, var(--surface) 96%, transparent);", "Workspace Island panel/menu must inherit the active surface theme");
assertContains("src/components/ChatView.tsx", "chat-status-stack", "Workspace and Computer islands must share one status stack");
assertContains("src/styles.css", ".chat-status-stack", "Workspace and Computer islands must be laid out by one stack");
assertContains("src/styles.css", ".cc-dock {\n  position: relative;", "Computer dock must not use an independent absolute position that overlaps Workspace Island");
assertContains("src/styles.css", "background: color-mix(in srgb, var(--surface) 95%, transparent);", "Computer dock must inherit the active surface theme");
assertNotContains("src/styles.css", "background: rgba(255, 255, 255, 0.98);", "Workspace Island pill must not force a light background");
assertNotContains("src/styles.css", "background: rgba(255, 255, 255, 0.985);", "Workspace Island panel must not force a light background");
assertNotContains("src/styles.css", "background: rgba(255, 255, 255, 0.99);", "Workspace Island menu must not force a light background");
assertNotContains("src/styles.css", "background: rgba(255, 255, 255, 0.97);", "Computer dock must not force a light background");
assertContains("src/styles.css", "background: color-mix(in srgb, var(--surface) 96%, transparent);", "Workbench chrome must inherit the active surface theme");
assertContains("src/styles.css", "background: linear-gradient(180deg, var(--surface-muted), var(--surface));", "Workbench body must inherit the active surface theme");
assertNotContains("src/components/ChatView.tsx", "<ul className=\"artifacts-list\">", "artifact resources must not render a permanent inner sidebar");
assertContains("src/styles.css", "background: color-mix(in srgb, var(--red-soft) 42%, var(--surface));", "Settings danger zone must inherit the active surface theme");
assertNotContains("src/styles.css", "background: #fffafa;", "Settings danger zone must not force a light background");
assertNotContains("src/styles.css", "border: 1px solid #f1c4c6;", "Settings danger zone must not force a light border");
assertContains("src/styles.css", ".settings-workspace .set-modal-overlay", "Settings modals must stay inside the settings content island");
assertContains("src/styles.css", ".set-contact.is-me {\n  border-color: var(--line-strong);\n  background: var(--surface);\n}", "Contacts self card must use neutral surface tokens");
assertNotContains("src/styles.css", ".set-contact.is-me { border-color: var(--brand-soft); background: var(--brand-soft); }", "Contacts self card must not force a light brand background");
assertNotContains("src/styles.css", "background: color-mix(in srgb, var(--brand-soft) 38%, var(--surface));", "Contacts self card must not tint the full card with brand color");
assertContains("src/styles.css", "color: var(--text);\n  background: var(--surface-muted);\n  font-family: ui-monospace", "inline markdown code must stay readable in dark theme");
assertContains("src/styles.css", "color: var(--text);\n  font-family: ui-monospace", "markdown code blocks must use theme text color");
assertContains("src/styles.css", "background: var(--surface-muted);\n}\n\n.rich-code-block figcaption", "markdown code blocks must use theme surfaces");
assertNotMatches(
  "src/styles.css",
  /\.rich-inline-code\s*\{[\s\S]*?color: #3b4149;[\s\S]*?\}/m,
  "markdown inline code must not force dark text",
);
assertNotMatches(
  "src/styles.css",
  /\.rich-code-block pre,\n\.rich-mermaid-block pre\s*\{[\s\S]*?color: #24272d;[\s\S]*?\}/m,
  "markdown code blocks must not force dark text",
);
assertNotMatches(
  "src/styles.css",
  /\.code-view-body\s*\{[\s\S]*?color: #24272d;[\s\S]*?\}/m,
  "Workbench code viewer must not force dark text",
);
assertNotContains("src/styles.css", "background: rgba(255, 255, 255, 0.96);", "Workbench/artifact chrome must not force a light background");
assertNotContains("src/styles.css", "background: rgba(255, 255, 255, 0.82);", "Embedded artifact list must not force a light background");
assertNotContains("src/styles.css", "background: rgba(248, 248, 247, 0.72), rgba(255, 255, 255, 0.96)", "Workbench body must not force a light gradient");

assertContains("src/components/Sidebar.tsx", "nav-drawer", "expanded navigation must be a drawer");
assertContains("src/components/Shell.tsx", "window-chrome", "desktop shell must render a custom draggable window chrome");
assertNotContains("src/components/Shell.tsx", "window-light close", "custom chrome must not render fake traffic lights");
assertNotContains("src/components/Shell.tsx", "window-sidebar-toggle", "sidebar toggle must not live inside the native window-control row");
assertNotContains("src/components/Shell.tsx", "drawer-edge-hotspot", "collapsed sidebar must not open from a left-edge hover hotspot");
assertContains("src/components/ChatView.tsx", "task-collapsed-controls", "collapsed sidebar's reopen + search must live in the chat header (no-drag), not a fixed overlay");
assertContains("src/components/ChatView.tsx", "onExpandSidebar", "collapsed sidebar's in-header opener must reopen the drawer");
assertNotContains("src/components/Shell.tsx", "transientDrawerOpen", "collapsed sidebar must not maintain hover-open transient drawer state");
assertContains("src/styles.css", "--drawer-island-gap", "sidebar must be laid out as a floating island with stable margins");
assertContains("src/styles.css", ".window-chrome", "custom window chrome must own the top drag/header strip");
assertNotContains("src/styles.css", ".window-light", "custom window chrome must not draw fake traffic lights");
assertContains("src/styles.css", "pointer-events: none", "custom window chrome wrapper must not sit as a click-blocking overlay");
assertContains("src/styles.css", ".window-drag-strip", "custom window chrome must use explicit drag strips instead of dragging over controls");
assertContains("src/styles.css", ".task-collapsed-controls", "collapsed reopen/search controls styled in the chat header");
assertContains("src/styles.css", ".task-collapsed-action svg", "sidebar toggle icon must not intercept pointer events from the button");
assertContains("src/styles.css", ".app-shell.drawer-open > .nav-drawer", "open sidebar and Settings nav must use the same island styling");
assertContains("src/components/Sidebar.tsx", "drawer-titlebar-action", "expanded sidebar toggle + search must live in the top titlebar row");
assertNotContains("src/components/Sidebar.tsx", "drawer-new-action", "sidebar search row must not include a global new-chat plus button");
assertNotContains("src/components/Sidebar.tsx", "the gear becomes a back-to-app arrow", "Settings nav must not keep a duplicate footer back action");
assertContains("src/styles.css", "overflow-y: auto;\n  overflow-x: hidden;", "expanded project trees must scroll inside the sidebar middle region instead of covering footer actions");
assertContains("src/styles.css", ".drawer-scroll::-webkit-scrollbar", "sidebar middle scrollbars must stay visually minimal");
assertContains("src/styles.css", "z-index: 200", "custom window chrome must stay above the sidebar island");
assertContains("src/styles.css", ".app-shell.drawer-closed .task-topbar", "closed sidebar header must clear the top-left toggle/search controls");
assertNotContains("src/components/Shell.tsx", "drawer-floating-host", "collapsed sidebar must not render a hover-only transient island");
assertNotContains("src/components/Sidebar.tsx", "presentation?: \"pinned\" | \"floating\"", "drawer should not keep an unused transient presentation mode");
assertNotContains("src/styles.css", ".nav-drawer.floating-island", "floating drawer styling should not remain without the hover-open mode");
assertNotContains("src/components/Shell.tsx", "<NavigationRail", "closed sidebar must not render a persistent icon rail");
assertContains("src/components/Sidebar.tsx", "linear-sidebar-nav", "expanded sidebar must use grouped Linear-style workspace navigation");
assertContains("src/components/Sidebar.tsx", "MemorySourcesDialog", "project menu must open memory sources separately from Project Access");
assertContains("src/components/MemorySourcesDialog.tsx", "Read only", "linked sources must state read-only access");
assertContains("src/components/MemorySourcesDialog.tsx", "coreBridge.upsertMemorySource", "memory source grants must persist through the typed bridge");
assertContains("src/components/MemorySourcesDialog.tsx", "coreBridge.revokeMemorySource", "memory sources must support immediate revocation");
assertContains("src/components/MemorySourcesDialog.tsx", "openModifyGrant", "available linked sources must support reviewing their authorization");
assertContains("src/components/MemorySourcesDialog.tsx", "revokeConfirmation", "revocation must require an explicit confirmation state");
assertContains("src/components/MemoryPublicationDialog.tsx", "proposed_text", "publication must preview exact text before approval");
assertContains("src/components/MemoryPublicationDialog.tsx", "coreBridge.updateMemoryPublication", "changed publication fields must be revalidated by the server before approval");
assertContains("src/components/MemoryPublicationDialog.tsx", "proposal.proposal_version", "publication mutations must bind to the server preview version");
assertContains("src/components/MemoryPublicationDialog.tsx", "destination_workspace_id: destinationWorkspaceId", "initial publication preview must be created only after a destination is selected");
assertContains("src/components/MemoryPublicationDialog.tsx", "hydrateFromServer(next)", "reopened pending publication previews must hydrate the exact server draft");
assertNotContains("src/components/MemoryPublicationDialog.tsx", "initialText", "publication preview must not seed a client-side recall payload");
assertContains("src/components/MemoryPublicationDialog.tsx", "coreBridge.approveMemoryPublication", "publication must require explicit approval");
assertContains("src/components/MemoryPublicationDialog.tsx", "coreBridge.rejectMemoryPublication", "publication must support rejection without writes");
assertContains("src/components/MemoryPublicationDialog.tsx", "function dismissDialog()", "publication dismissal must be a local-only action");
assertContains("src/components/MemoryPublicationDialog.tsx", "function rejectProposal()", "publication rejection must remain an explicit action");
assertContains("src/components/MemoryPublicationDialog.tsx", "coreBridge.memoryPublication", "publication conflicts must reconcile against the latest server proposal");
assertContains("src/components/MemoryPublicationDialog.tsx", "reconcilePublicationConflict", "stale publication mutations must refresh or close safely");
assertContains("src/components/MemoryPublicationDialog.tsx", "publication_preview_stale", "destination drift must refresh the latest publication review");
assertContains("src/i18n/locales/it.json", "La destinazione è cambiata", "destination drift must explain that the refreshed review needs attention");
assertContains("src/components/MemoryPublicationDialog.tsx", "event.target === event.currentTarget", "publication backdrop dismissal must not submit a rejection");
assertNotContains("src/components/MemoryPublicationDialog.tsx", "rejectAndClose", "local dialog exits must never invoke a stale reject request");
assertContains("src/components/MemoryUsagePopover.tsx", "hit.source_workspace_id === consumerWorkspaceId", "publication must be limited to the current consumer workspace");
assertContains("src/components/MemoryUsagePopover.tsx", "hit.grant_id === null", "publication must never be offered for linked or legacy sources");
assertContains("src/i18n/locales/en.json", "linked_memory_read_only", "linked publication rejection must have a user-facing reason");
assertContains("src/components/ChatView.tsx", "onPublicationApproved={refreshAfterChatSubmit}", "successful publication must refresh persisted task data");
assertContains("src/components/MemorySourcesDialog.tsx", "closeDialog", "all dialog exits must reset transient source-management state");
assertContains("src/components/MemorySourcesDialog.tsx", "Never consulted", "missing last-access timestamps must be disclosed clearly");
assertContains("src/components/MemorySourcesDialog.tsx", "focusTrap", "memory source dialog must retain keyboard focus until closed");
assertContains("src/components/Sidebar.tsx", "projectMenuTriggerRef", "memory source dialog must retain a stable project-row opener, not a transient menu item");
assertContains("src/components/Sidebar.tsx", "data-project-menu-trigger", "stable project menu triggers must be addressable for focus restoration");
assertContains("src/components/MemorySourcesDialog.tsx", "isConnected", "memory source dialog must restore focus only to a mounted opener and use a stable fallback");
assertContains("src/components/MemorySourcesDialog.tsx", "sourceRequestGenerationRef", "source loading must reject stale workspace responses");
assertContains("src/components/MemorySourcesDialog.tsx", "candidateRequestGenerationRef", "candidate loading must reject stale source responses");
assertContains("src/components/MemorySourcesDialog.tsx", "aria-pressed={selected?.effect === \"allow\"}", "allow override state must be exposed to assistive technology");
assertContains("src/components/MemorySourcesDialog.tsx", "aria-pressed={selected?.effect === \"deny\"}", "deny override state must be exposed to assistive technology");
assertNotContains("src/components/ProjectAccessDialog.tsx", "MemorySourcesDialog", "contact access must not own source grants");
assertContains("src/components/Sidebar.tsx", "data-nav-section={section}", "sidebar nav rows must expose registry-driven operational sections");
assertContains("src/components/Sidebar.tsx", "data-promoted={item.promoted === true ? \"true\" : \"false\"}", "sidebar must preserve promoted addon metadata");
assertContains("src/components/Sidebar.tsx", "data-project-tree=\"personal\"", "sidebar must expose Personal as a first-class chat category");
assertContains("src/components/Sidebar.tsx", "data-project-tree=\"projects\"", "sidebar must expose Projects as a first-class tree, not only a dropdown switcher");
assertContains("src/components/Sidebar.tsx", "drawer-personal-tree", "Personal must render as a section like Projects, not as a duplicated active workspace row");
assertContains("src/components/Sidebar.tsx", "collapsedNavGroups", "sidebar operational groups must collapse independently");
assertContains("src/components/Sidebar.tsx", "expandedGroups", "Personal and Projects trees must collapse independently");
assertContains("src/components/Sidebar.tsx", "expandedProjectIds", "project rows must expand independently without switching workspace");
assertContains("src/components/Sidebar.tsx", "coreBridge.chatThreads(projectId)", "inactive project rows must load their thread tree without becoming active");
assertContains("src/components/Sidebar.tsx", "drawer-new-chat-menu", "global New chat must expose a workspace chooser instead of creating blindly in the active scope");
assertContains("src/components/Sidebar.tsx", "drawer-new-chat-search", "global New chat picker must scale with many projects through search");
assertContains("src/components/Sidebar.tsx", "NEW_CHAT_PROJECT_LIMIT", "global New chat picker must cap visible projects instead of dumping the full workspace list");
assertContains("src/components/Sidebar.tsx", "createProjectFromFolder", "global New chat picker must support creating a project from an existing folder");
assertContains("src/components/Sidebar.tsx", "newChatProjectModal", "global New chat picker must support creating a new project without leaving the flow");
assertContains("src/components/Sidebar.tsx", "onCreateteChatThread(PERSONAL_WORKSPACE_ID)", "global New chat must allow creating explicitly in Personal");
assertContains("src/components/Sidebar.tsx", "onCreateteChatThread(project.id)", "global New chat must allow creating explicitly in a selected project");
assertNotContains("src/components/Sidebar.tsx", "threadMenu.thread.pinned ? \"Remove pin\" : \"Pin\"", "thread overflow menu must not duplicate hover pin action");
assertNotContains("src/components/Sidebar.tsx", "runThreadAction(() => onArchiveChatThread(threadMenu.thread.threadId))", "thread overflow menu must not duplicate hover archive action");
assertNotContains("src/components/Sidebar.tsx", "setSwitcherOpen", "project navigation must not be primarily driven by a workspace dropdown");
assertContains("src/App.tsx", "summarizeThreadTitle", "frontend optimistic chat titles must be synthesized, not first-prompt slices");
assertContains("src/App.tsx", "advanceActivity === true", "chat preview ordering must advance only from explicit completed assistant turns");
assertNotContains("src/App.tsx", "nextActivityMessageCount > thread.messageCount", "opening/loading an existing chat must not infer new activity from message count");
assertContains("src/components/ChatView.tsx", "onMessagesChange(promptMessages)", "chat title must update as soon as the user prompt is accepted");
assertContains("src/components/ChatView.tsx", "advanceActivity: true", "completed assistant turns must explicitly advance chat activity ordering");
assertContains("src/components/ChatView.tsx", "const shouldAutoTitleAfterSubmit = isPlaceholderThreadTitle(thread.title)", "auto-title must be authorized only by a real submitted turn, not by opening a historical chat");
assertContains("src/components/ChatView.tsx", "persistAutoTitleForCompletedTurn(", "auto-title must persist from the completed chat stream path");
assertNotContains("src/components/ChatView.tsx", "coreBridge\n      .autoTitleThread", "auto-title must not be driven by a mount/update effect on historical messages");
assertRepoContains("crates/desktop-gateway/src/main.rs", "is_placeholder_chat_title(&thread.title)", "autotitle endpoint must be a no-op for already titled chats");
assertRepoContains("crates/desktop-gateway/src/main.rs", "\"type\": \"thread.turn_started\"", "external turns must publish a visible-turn event after messages are persisted");
assertRepoContains("crates/desktop-gateway/src/main.rs", "start_visible_conversation_turn", "external channels and scheduled work must use the shared visible-turn helper");
assertRepoContains("crates/desktop-gateway/src/main.rs", "\"approval\"", "remote approval continuations must identify their visible-turn source");
assertRepoContains("crates/desktop-gateway/src/main.rs", "approval_continuation_visible_text", "remote approval continuations must create an explicit visible user bubble");
assertNotContains("src/App.tsx", "runAgentTurnHeadless", "frontend must not expose a headless agent-turn path");
assertRepoNotContains("crates/desktop-gateway/src/main.rs", "async fn run_agent_turn(", "backend must not keep a headless agent-turn helper that can bypass visible placeholders");
assertRepoContains("crates/desktop-gateway/src/main.rs", "run_agent_turn_into_message", "backend agent turns must stream into persisted assistant messages");
assertRepoContains("crates/desktop-gateway/src/main.rs", "OPERATIONAL PLAN: for a non-trivial MULTI-STEP task, call update_plan and then continue executing", "chat loop must maintain the canonical plan through update_plan and continue in the same turn");
assertContains("src/App.tsx", "pendingEventThreadIdsRef", "event-driven thread navigation must not drop updates while React is switching active threads");
assertContains("src/App.tsx", "event.type === \"thread.turn_started\"", "desktop client must handle visible turn start events");
assertContains("src/lib/coreBridge.ts", "assistant_message_id?: string", "app event contract must expose persisted assistant message ids");
assertContains("src/components/ChatView.tsx", "eventParts: normalizeChatEventParts(result.assistant_message.event_parts)", "completed chat turns must preserve structured event parts from the gateway result");
assertContains("src/lib/chatApi.ts", "export async function cancelTurn(", "chat cancellation must call the broker cancel_turn endpoint (DELETE /turns/{id})");
assertContains("src/lib/coreBridge.ts", "await cancelTurn(`turn_${requestId}`)", "Stop must cancel the running turn on the broker by its derived turn id, not a client-side socket close");
assertContains("src/plugins/registry.tsx", "navSection?: \"work\" | \"create\" | \"workspace\" | \"more\"", "plugin manifest must declare sidebar placement by operational role");
assertContains("src/plugins/presentations/index.tsx", "navSection: \"create\"", "presentations addon must be promoted into the create section");
assertContains("src/plugins/proattivita/index.tsx", "navSection: \"work\"", "proactivity addon must be promoted into the work section");
assertContains("src/components/ChatView.tsx", "{sidebarCollapsed && (", "chat header must render the reopen/search controls when the sidebar is collapsed");
assertContains("src/components/Shell.tsx", "{drawerOpen && !isSettings && (", "main drawer must render when open");
assertContains("src/components/Sidebar.tsx", "drawer-profile", "open drawer footer must show the user profile + settings");
assertContains("src/components/ChatView.tsx", "composer-surface", "prompt composer must have a stable anchored surface");
assertContains("src/components/ChatView.tsx", "local-computer-card", "active task must expose a local computer activity card");
assertContains("src/components/ChatView.tsx", "timelineCollapsed", "computer timeline must keep collapsed state");
assertContains("src/components/ChatView.tsx", "computerCardCollapsed", "local computer card must be collapsible after answers");
assertContains("src/components/SettingsView.tsx", "secret_value: manualSecretValue.trim()", "Vault manual entry must send raw secret material through the encrypted gateway path");
assertContains("src/components/SettingsView.tsx", "pin: manualSecretPin", "Vault manual entry must require the local PIN when saving secret material");
assertContains("src/components/SettingsView.tsx", "setManualSecretValue(\"\")", "Vault manual entry must clear the raw secret from renderer state after saving");
assertContains("src/components/SettingsView.tsx", "const [vaultAddOpen, setVaultAddOpen]", "Vault manual entry must open from an explicit Add modal state");
assertContains("src/components/SettingsView.tsx", "className=\"set-modal vault-add-modal\"", "Vault manual entry form must render inside a themed modal");
assertContains("src/components/SettingsView.tsx", "openVaultAddModal", "Vault saved-record list must expose an Add action");
assertNotContains("src/components/SettingsView.tsx", "span className=\"set-card-name\">{t(\"settings.vaultSaveSensitive\")}</span>", "Vault sensitive tab must not lead with the embedded save form");
assertContains("src/components/SettingsView.tsx", "className=\"vault-pane\"", "Vault settings cards must be laid out with explicit vertical spacing");
assertContains("src/styles.css", ".vault-pane", "Vault settings card spacing must be owned by CSS, not inline margins");
assertContains("src/components/SettingsView.tsx", "const [vaultTab, setVaultTab]", "Vault settings must split PIN and sensitive data into local tabs");
assertContains("src/components/SettingsView.tsx", "className=\"set-seg vault-tabs\"", "Vault settings tabs must reuse the Settings segmented tabs pattern");
assertContains("src/components/SettingsView.tsx", "role=\"tabpanel\"", "Vault settings tab bodies must expose tabpanel semantics");
assertContains("src/lib/coreBridge.ts", "vaultRecords: () => electronVaultRecords()", "Vault bridge must expose record listing");
assertContains("src/lib/coreBridge.ts", "vaultRecordDelete: (id: string) => electronVaultRecordDelete(id)", "Vault bridge must expose record deletion");
assertContains("src/lib/coreBridge.ts", "vaultRecordUpdate: (id: string, input: VaultRecordUpdateInput) => electronVaultRecordUpdate(id, input)", "Vault bridge must expose metadata-only record editing");
assertContains("src/lib/coreBridge.ts", "vaultRecordReveal: (id: string, pin: string) => electronVaultRecordReveal(id, pin)", "Vault bridge must expose PIN-gated record reveal");
assertContains("src/components/SettingsView.tsx", "coreBridge.vaultRecords()", "Vault settings must load saved records from the gateway");
assertContains("src/components/SettingsView.tsx", "coreBridge.vaultRecordDelete(record.id)", "Vault settings must delete records through the gateway");
assertContains("src/components/SettingsView.tsx", "coreBridge.vaultRecordUpdate(editingVaultRecord.id", "Vault settings must edit record metadata through the gateway");
assertContains("src/components/SettingsView.tsx", "coreBridge.vaultRecordReveal(editingVaultRecord.id", "Vault settings must reveal encrypted values only through the PIN-gated gateway path");
assertContains("src/components/SettingsView.tsx", "editVaultPin", "Vault record editing must ask for the local PIN before revealing or rewriting secret material");
assertContains("src/components/SettingsView.tsx", "editVaultSecretValue", "Vault record editing must allow correcting the encrypted value after PIN unlock");
assertContains("src/components/SettingsView.tsx", "className=\"vault-record-edit\"", "Vault settings must render an inline metadata editor");
assertContains("src/components/SettingsView.tsx", "vault-record-list", "Vault settings must render a saved-record list under sensitive data");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/vault/records", "Gateway must expose Vault record listing");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/vault/records/{id}", "Gateway must expose Vault record deletion");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/vault/records/{id}/reveal", "Gateway must expose PIN-gated Vault record reveal");
assertRepoContains("crates/desktop-gateway/src/main.rs", "patch(vault_record_update)", "Gateway must expose metadata-only Vault record editing");
assertContains("src/components/SettingsView.tsx", "t(\"settings.vaultEncrypted\")", "Vault status badge must use translations");
assertContains("src/i18n/locales/it.json", "\"vaultEncrypted\": \"Cifrato\"", "Italian locale must translate the Vault encrypted badge");
assertContains("src/i18n/locales/en.json", "\"vaultEncrypted\": \"Encrypted\"", "English locale must translate the Vault encrypted badge");
assertContains("src/data/mockData.ts", "label: \"settings.vault\"", "Settings sidebar Vault label must use i18n");
assertContains("src/data/mockData.ts", "label: \"settings.computer.title\"", "Settings sidebar Computer label must use i18n");
assertContains("src/lib/coreBridge.ts", "secret_value?: string", "Vault bridge must expose optional raw secret material only for the encrypted accept path");
assertContains("src/components/ChatComputerPanel.tsx", "const browserRunning = Boolean(live?.active && live?.novnc_url)", "live computer browser state must distinguish running activity from idle availability");
assertContains("src/components/ChatComputerPanel.tsx", "const terminalRunning = Boolean(live?.terminal_active || terminal.some((entry) => entry.running))", "terminal dock must be driven by running terminal activity, not completed history");
assertContains("src/components/ChatComputerPanel.tsx", "const ownedLiveActivity = hasLiveActivity && live?.thread_id === threadId", "live computer activity must not appear across chats without a matching owner");
assertNotContains("src/components/ChatComputerPanel.tsx", "cc-dock-activity", "computer island header must show only Computer and LIVE, never prompt/activity text");
assertNotContains("src/styles.css", ".cc-dock-activity", "computer island must not reserve header space for prompt/activity text");
assertNotContains("src/components/ChatComputerPanel.tsx", "const ownedByThisThread = !hasLiveActivity", "idle global computer availability must not count as thread ownership");
assertContains("src/components/ChatComputerPanel.tsx", "hostComputerSession", "computer panel must consume host state");
assertContains("src/components/ChatComputerPanel.tsx", "approveHostComputerAction", "pending host actions need explicit consent");
assertContains("src/components/ChatComputerPanel.tsx", "resumeHostComputerSession", "physical takeover must be explicitly resumable");
assertContains("src/components/ChatComputerPanel.tsx", "cancelHostComputerSession", "host sessions must be cancellable");
assertNotContains("src/components/ChatComputerPanel.tsx", "pendingAction.params", "sensitive action parameters must never render");
assertNotContains(
  "src/components/ChatView.tsx",
  "const showComputerActivity =",
  "computer activity must use the shared inspector instead of a second inline panel",
);
assertContains("src/components/ChatView.tsx", "approval-scope-options", "approval UI must make temporary vs fixed scope explicit");
assertContains("src/lib/providerPresets.ts", "https://api.z.ai/api/paas/v4", "Z.ai standard preset must keep the standard GLM endpoint");
assertContains("src/lib/providerPresets.ts", "https://api.z.ai/api/coding/paas/v4", "Z.ai coding preset must keep the coding GLM endpoint");
assertContains("src/components/SettingsView.tsx", "v.id === p.id || normUrl(v.base_url) === normUrl(p.baseUrl)", "provider preset cards must match by stable id before URL fallback");
assertContains("src/components/SettingsView.tsx", "imageRoleMissingHint", "model routing must explain when no image-generation role model is available");
assertContains("src/components/SettingsView.tsx", "profileImageUpload", "Account profile photo upload must remain available from the avatar menu");
assertContains("src/components/SettingsView.tsx", "profileImageDecodeError", "Account profile photo upload must report unsupported/corrupt image files");
assertContains("src/components/SettingsView.tsx", "profileImageMenuOpen", "Account profile image click must expose upload/remove actions");
assertContains("src/components/SettingsView.tsx", "profile-image-menu", "Account profile image actions must render as an anchored menu");
assertNotContains("src/components/SettingsView.tsx", "className=\"set-btn\" onClick={clearProfileImage}", "Account profile image remove action must not be duplicated outside the avatar menu");
assertNotContains("src/components/SettingsView.tsx", "className=\"set-btn\"\n              onClick={openProfileImagePicker}", "Account profile image upload action must not be duplicated outside the avatar menu");
assertContains("src/components/Sidebar.tsx", "useSetting(\"profileImage\"", "Settings sidebar profile header must read the saved profile photo");
assertContains("src/components/Sidebar.tsx", "set-nav-avatar-img", "Settings sidebar profile header must render the saved profile photo");
assertContains("src/components/ProjectAccessDialog.tsx", "project-access-permissions", "Project Access must expose explicit per-contact permission toggles");
assertContains("src/components/ProjectAccessDialog.tsx", "can_trigger_automations: canTriggerAutomations", "Project Access grants must use the selected automation permission");
assertContains("src/components/ProjectAccessDialog.tsx", "can_use_project_memory: canUseProjectMemory", "Project Access grants must use the selected memory permission");
assertContains("src/components/ProjectAccessDialog.tsx", "can_receive_replies: canReceiveReplies", "Project Access grants must use the selected reply permission");
assertContains("src/components/ProjectAccessDialog.tsx", "can_receive_artifacts: canReceiveArtifacts", "Project Access grants must use the selected artifact permission");
assertContains("src/components/ProjectAccessDialog.tsx", "project-access-denies", "Project Access must expose explicit capability deny controls");
assertContains("src/components/ProjectAccessDialog.tsx", "capability_denies: selectedCapabilityDenies", "Project Access grants must persist selected capability denies");
assertContains("src/components/ProjectAccessDialog.tsx", "updateGrantCapabilityDeny", "Project Access must allow editing capability denies on existing grants");
assertContains("src/components/AutomationsView.tsx", "t(\"automations.ifThis\")", "Event automation builder must expose the IF part explicitly");
assertContains("src/components/AutomationsView.tsx", "t(\"automations.filter\")", "Event automation builder must expose the FILTER part explicitly");
assertContains("src/i18n/locales/en.json", "\"ifThis\": \"If this happens\"", "Event automation IF label must be localized in English");
assertContains("src/i18n/locales/en.json", "\"filter\": \"Filter\"", "Event automation FILTER label must be localized in English");
// S1b-T3 split BrandKitPanel.tsx (compositor only) into TemplateGallery.tsx
// (catalog/search/tabs/import/delete/use + detail modal) and TemplateCard.tsx
// (full-bleed grid card + the live/raster/contract preview renderers); pure
// helpers (brandPreviewOverride etc.) moved to presentationsShared.ts. Locks
// below follow each symbol to its new file.
assertContains("src/components/TemplateGallery.tsx", "TemplateLivePreview", "template gallery must render the pack's live preview.html when the catalog declares preview_html_ref");
assertContains("src/components/TemplateCard.tsx", "entry.preview_html_ref", "template gallery must route card/detail rendering by the catalog's preview_html_ref field");
assertContains("src/components/TemplateCard.tsx", "TemplateCardPreview", "template gallery cards must route preview rendering through a dedicated component");
assertContains("src/components/TemplateCard.tsx", "template-card-contract", "template gallery must keep the metadata contract fallback for catalogs without preview_ref");
assertContains("src/components/TemplateGallery.tsx", "selection_notes", "template gallery must expose catalog selection rationale, not only visual decoration");
assertContains("src/components/TemplateGallery.tsx", "entry.selection_notes ?? []", "template gallery must tolerate legacy catalog entries without selection_notes");
assertContains("src/components/TemplateGallery.tsx", "Import PPTX", "Presentations must expose manual PPTX template import");
assertContains("src/components/TemplateGallery.tsx", "TEMPLATE_SOURCE_LINKS", "Presentations must keep provider-agnostic template source links");
assertContains("src/components/TemplateGallery.tsx", "TemplateSourceDirectory", "Presentations must separate external template sources from installed templates");
assertContains("src/components/TemplateGallery.tsx", "attribution_required", "Presentations must surface attribution state for imported/source templates");
assertContains("src/components/TemplateGallery.tsx", "TemplateDetailModal", "template gallery must expose a catalog detail view before use");
assertContains("src/components/TemplateGallery.tsx", "useTemplate(entry", "template gallery must start chat workflows from the selected catalog entry");
assertContains("src/components/TemplateGallery.tsx", ".templateSourceAttachment(entry.id)", "imported PPTX templates must resolve their source attachment only when used");
assertContains("src/components/TemplateGallery.tsx", "await refreshTemplates()", "PPTX import must refresh the reusable catalog instead of immediately starting chat");
assertNotContains("src/components/TemplateCard.tsx", "templateThemeClass", "the synthetic CSS-preview branch was retired by the live renderer previews — it must not come back");
assertNotContains("src/components/TemplateGallery.tsx", "templateThemeClass", "the synthetic CSS-preview branch was retired by the live renderer previews — it must not come back");
assertNotContains("src/components/BrandKitPanel.tsx", "templateThemeClass", "the synthetic CSS-preview branch was retired by the live renderer previews — it must not come back");
assertNotContains("src/components/TemplateCard.tsx", "builtin:template-preview/", "the synthetic CSS-preview branch was retired by the live renderer previews — it must not come back");
assertNotContains("src/components/TemplateGallery.tsx", "builtin:template-preview/", "the synthetic CSS-preview branch was retired by the live renderer previews — it must not come back");
assertContains("src/components/presentationsShared.ts", "brandPreviewOverride", "the brand kit must recolor catalog previews live");
assertContains("src/components/TemplateCard.tsx", "brandPreviewOverride", "template cards must apply the live brand recolor");
// S1b-T4: dark editorial surfaces (editorial_noir/editorial_bold) own their palette —
// the live recolor only swaps --brand/--accent, not --surface, so it must be guarded there.
assertContains("src/components/TemplateCard.tsx", "DARK_SURFACE_THEMES", "live brand recolor must be guarded against dark editorial surfaces");
// S1b/S3-T3: the colour guard must NOT skip the whole override on dark packs — only the
// colour vars are conditional; the font override (@font-face/--head/--body) always applies.
assertContains("src/components/presentationsShared.ts", "opts.colorSafe", "brandPreviewOverride must gate colour vars behind colorSafe while always emitting the font override");
assertContains("src/components/TemplateCard.tsx", "brandPreviewOverride(brandKit, { colorSafe })", "template cards must always call brandPreviewOverride (font applies everywhere) and pass colorSafe to gate only the colour vars");
assertNotContains("src/components/TemplateCard.tsx", "allowRecolor", "the recolor guard must no longer skip the entire override (font must survive on dark packs) — use colorSafe instead");
// S1b-T3: purpose tabs (entry.category) replaced the old kind+source tabs.
assertContains("src/components/TemplateGallery.tsx", "entry.category", "template gallery tabs must filter by the catalog's category field, not kind/source");
assertContains("src/components/BrandKitPanel.tsx", "TemplateCatalogGallery", "BrandKitPanel must stay a thin compositor wiring the gallery + brand chip/drawer");
assertContains("src/plugins/registry.tsx", "startTemplateWorkflow", "plugin host must expose a typed template workflow handoff");
assertContains("src/App.tsx", "handleStartTemplateWorkflow", "App must own the template workflow chat creation path");
assertContains("src/App.tsx", "template_ref=", "template workflow prompt must preserve the canonical template reference");
assertContains("src/App.tsx", "Do not generate the deck yet.", "template workflow must start with discovery and planning, not immediate deck generation");
assertContains("src/App.tsx", "make_document", "document packs must route to make_document from Use template");
assertNotContains("src/App.tsx", "Aiutami a creare una presentazione", "template workflow default visible prompt must remain English");
// S2 T6: Use template builds a deterministic routing binding (App.tsx uses the
// camelCase field per TS convention; the wire-format lock below on chatApi.ts guards
// the literal `routing_binding` key the Rust gateway's EnqueueTurnRequest reads).
assertContains("src/App.tsx", "routingBinding", "Use template must build a deterministic routing binding");
assertContains("src/lib/coreBridge.ts", "importPptxTemplate", "Desktop bridge must expose PPTX template import");
assertContains("src/lib/coreBridge.ts", "templateSourceAttachment", "Desktop bridge must resolve local template attachments without exposing paths in the catalog");
assertContains("src/lib/coreBridge.ts", "attachments?: CoreChatAttachment[]", "streamed prompt commits must be able to preserve user attachments");

assertContains("src/components/ChatView.tsx", "coreBridge.submitChatPromptStream", "composer must submit prompts through the local chat transport");
assertContains("src/lib/coreBridge.ts", "submitBrowserRuntimeChatPromptStream", "Electron bridge must stream from the local Gemma runtime through Electron-safe transport");
assertContains("src/lib/coreBridge.ts", "enqueueTurn(", "Electron bridge must submit chat turns through the Rust gateway's turn broker");
assertContains("src/lib/chatApi.ts", "/api/chat/turns", "broker turn API must POST turns to the local gateway endpoint");
// S2 T6: enqueueTurn must forward the routing binding under the exact wire key the Rust
// gateway's EnqueueTurnRequest.routing_binding reads (main.rs), so "Use template" attaches a
// deterministic routing binding instead of pleading in the prompt.
assertContains("src/lib/chatApi.ts", "routing_binding", "Use template must attach a deterministic routing binding");
assertNotContains("src/lib/coreBridge.ts", "127.0.0.1:8765", "renderer must not call Gemma runtime directly");
assertContains("src/lib/gatewayConfig.ts", "localFirstDesktop", "desktop renderer must receive packaged gateway config through Electron preload");
assertContains("src/lib/gatewayConfig.ts", "VITE_HOMUN_DESKTOP_GATEWAY_TOKEN", "desktop renderer may receive the local gateway token through Vite env in tests/dev");
assertContains("src/lib/gatewayConfig.ts", "Authorization", "desktop gateway requests must send bearer authorization");
assertContains("src/lib/coreBridge.ts", "/api/tasks/queue", "Electron task queue must load from the local gateway");
assertContains("src/lib/coreBridge.ts", "/api/tasks/executor", "Electron task executor status must load from the local gateway");
assertContains("src/lib/coreBridge.ts", "/api/tasks/run_next", "Electron task execution must run through the local gateway");
assertContains("src/lib/coreBridge.ts", "/api/approvals/", "Electron approvals must mutate through the local gateway");
assertContains("src/lib/coreBridge.ts", "/api/local-computer/sessions/", "Electron local computer sessions must load from the local gateway");
assertContains("src/lib/coreBridge.ts", "/artifacts/", "Electron local computer artifact previews must load from the local gateway");
assertContains("src/lib/coreBridge.ts", "/api/memory/dashboard", "Electron memory dashboard must load from the local gateway");
assertContains("src/lib/coreBridge.ts", "/api/capabilities/snapshot", "Electron capability registry must load from the local gateway");
assertContains("src/lib/coreBridge.ts", "/api/vault/proposals/accept", "Vault proposal cards must persist through the local gateway");
assertContains("src/lib/coreBridge.ts", "/api/vault/proposals/dismiss", "Vault proposal cards must dismiss through the local gateway");
assertContains("src/lib/coreBridge.ts", "/api/vault/pin/status", "Vault PIN status must load through the local gateway");
assertContains("src/lib/coreBridge.ts", "/api/vault/pin/setup", "Vault PIN setup must persist through the local gateway");
assertContains("src/lib/coreBridge.ts", "/api/vault/pin/verify", "Vault PIN verification must run through the local gateway");
assertContains("src/lib/coreBridge.ts", "/api/vault/payment-approvals/approve", "Payment approvals must verify through the local gateway");
assertContains("src/components/ChatView.tsx", "PAYMENT_APPROVAL_RE", "Chat must parse Payment Approval Card markers");
assertContains("src/components/ChatView.tsx", "coreBridge.vaultPaymentApprovalApprove", "Payment Approval Card must verify PIN/CVV through the bridge");
assertContains("src/components/ChatView.tsx", "messageId={messageId}", "Payment Approval Card must receive the source message id for transcript rewrite");
assertContains("src/lib/coreBridge.ts", "message_id: ctx.messageId", "Payment approvals must include source message id when available");
assertContains("src/data/mockData.ts", "id: \"vault\"", "Vault must be a separate Settings section");
assertContains("src/data/mockData.ts", "id: \"sandbox\"", "Sandbox must be a separate Settings section");
assertContains("src/components/SettingsView.tsx", "<SandboxSettingsView />", "Settings must render the dedicated Sandbox pane");
assertContains("src/lib/coreBridge.ts", "/policy`", "coreBridge must POST per-workspace sandbox/approval overrides");
assertContains("src/components/SettingsView.tsx", "coreBridge.vaultPinSetup", "Vault Settings must configure the local PIN through the bridge");
assertContains("src/components/ChatView.tsx", "coreBridge.vaultProposalAccept", "Vault proposal card must expose an accept action");
assertContains("src/components/ChatView.tsx", "Save to Vault", "Vault proposal card must offer an explicit save action");
assertContains("src/App.tsx", "mapCoreMemoryDashboard", "desktop memory page must map the gateway memory dashboard read model");
assertContains("src/App.tsx", "mapCoreCapabilitySnapshot", "desktop connections page must map the gateway capability read model");
assertContains("src/lib/chatApi.ts", "/api/chat/threads", "chat threads must load from the local Rust gateway first");
assertContains("src/lib/chatApi.ts", "hydrateThreadSnapshot", "chat API must keep a local cache synchronized with gateway thread snapshots");
assertContains("src/lib/chatApi.ts", "localThreads", "chat threads must keep an Electron-safe fallback cache");
// NOTE: client-side commit assertions removed — the turn broker is now the source of truth
// and persists the assistant message server-side on done (no client commit_prompt_result).
assertContains("src/lib/coreBridge.ts", "result.computer_session = await electronLocalComputerSession", "streamed prompt results must refresh the real local computer read model after the turn completes");
assertContains("src/lib/coreBridge.ts", "trimRepeatedContinuetionPrefix", "automatic continuation joins must avoid duplicating overlapping model output");
assertContains("src/lib/chatApi.ts", "recentChatContext", "Electron chat fallback must expose recent thread context to the local prompt builder");
assertContains("src/lib/chatApi.ts", "rawRecentChatContext", "Electron chat must expose raw recent context for Rust-side budgeting");
assertContains("src/lib/chatApi.ts", "buildJuicePromptChatContext", "Electron chat fallback must budget/compress context before prompt building");
assertContains("src/lib/contextBudget.ts", "buildJuicePromptChatContext", "Electron chat fallback must have a dedicated JuicePrompt-style context budget module");
assertContains("src/lib/contextBudget.ts", "redactSensitiveText", "Electron context budget must redact sensitive text before compression");
assertContains("src/lib/contextBudget.ts", "context compressed: earlier chat", "Electron context budget must mark compressed older chat context");
assertContains("src/lib/chatApi.ts", "rawRecentChatContext(threadId", "Electron gateway requests must include recent thread context");
assertContains("src/lib/chatApi.ts", "streamListeners", "chat streaming must use local browser listener dispatch");
assertContains("src/lib/chatApi.ts", "/create_task", "chat message task actions must call the local gateway");
assertNotContains("src/lib/coreBridge.ts", "invoke<", "frontend bridge must not call removed native invoke");
assertNotContains("src/lib/coreBridge.ts", removedShellGlobal, "frontend bridge must not inspect removed shell globals");
assertNotContains("src/lib/chatApi.ts", removedShellPackageScope, "chat API must not import removed shell packages");

assertContains("src/components/RichMessage.tsx", "lazy(() => import(\"./RichMessageRenderer\")", "rich markdown renderer must be lazy loaded");
assertContains("src/components/RichMessage.tsx", "memo(function RichMessage", "rich markdown messages must be memoized to avoid rerendering completed chat history");
assertContains("src/components/RichMessage.tsx", "streaming={streaming}", "streaming messages must render live through the streaming-aware renderer");
assertContains("src/components/RichMessageRenderer.tsx", "export default memo(RichMessageRenderer)", "rich markdown renderer must be memoized after lazy load");
assertContains("src/components/RichMessageRenderer.tsx", "repairNestedMarkdownFences", "rich renderer must repair duplicated fenced code openers from local model output");
assertContains("src/components/ChatView.tsx", "threadMessages.map", "chat transcript must use normal document flow in Electron");
assertContains("src/styles.css", ".thread-message-list", "chat transcript must stack rows in normal flow");
assertContains("src/styles.css", ".thread-message-row", "chat transcript rows must not be absolutely positioned");
assertNotContains("src/components/ChatView.tsx", "useVirtualizer", "chat transcript must not use old Tauri-era virtualization in the base Electron path");
assertNotContains("src/styles.css", ".virtual-message-row", "chat transcript must not use absolute virtual rows in the base Electron path");
assertContains("src/components/ChatView.tsx", "streamingFrameRef", "chat streaming must throttle visible updates in Electron");
assertContains("src/components/ChatView.tsx", "setOptimisticMessages", "chat streaming must keep visible text in the React message state");
assertContains("src/components/ChatView.tsx", "<AssistantMessageBody", "streaming answers must render through the normal message body component");
assertMatches(
  "src/components/ChatView.tsx",
  /isStreamingMessage \? \([\s\S]*?<AssistantMessageBody[\s\S]*?\n\s+streaming\n[\s\S]*?\)/m,
  "streaming answers must keep rich markdown/progress parsing enabled while streaming",
);
assertContains("src/components/ChatView.tsx", "<WorkspaceIsland", "closed operational plan markers must feed the ambient workspace island");
assertContains("src/components/ChatView.tsx", "workspacePlanSteps", "workspace island must derive progress from closed operational plan markers");
assertContains("src/components/WorkspaceIsland.tsx", "Panel mode", "workspace island must expose its expand/collapse preference menu");
assertContains("src/components/WorkspaceIsland.tsx", "wi-progress", "workspace island must render collapsible progress inside the island");
assertContains("src/components/WorkspaceIsland.tsx", "if (!hasWorkspaceState && !hadWorkspaceState) return null", "workspace island must stay hidden when a thread has no real workspace state, while preserving completed state after a run");
assertContains("src/components/ChatView.tsx", "threadHasMessages={threadMessages.length > 0}", "workspace island must not treat project memory artifacts as state for an empty new chat");
assertContains("src/components/WorkspaceIsland.tsx", "(threadHasMessages || streaming || computerLive) &&", "workspace island must appear for thread-owned content, stream, or owned live computer work");
assertContains("src/components/ChatView.tsx", "onOpenInspector={openUtilityTab}", "chat header and island must route views through the inspector reducer");
// The redundant "Plan N/M" row was removed — Progress IS the plan (one section, not two).
// Sources (artifacts + uploaded files) are fused into the island; each opens the Workbench.
assertContains("src/components/WorkspaceIsland.tsx", "wi-sources", "workspace island must render the fused Sources section");
// The activity row reveals its accumulated conversation steps INLINE. It used to open the
// Workbench "activity" tab, but that tab renders background TASKS (activeTasks), not these
// conversation activity steps — so clicking showed nothing. The island now owns the reveal.
assertContains("src/components/WorkspaceIsland.tsx", "onClick={() => setActivityOpen((value) => !value)}", "workspace island activity row must reveal its accumulated steps inline");
assertContains("src/components/WorkspaceIsland.tsx", "wi-activity-list", "workspace island must render the inline activity list");
// Cockpit redesign: one fused card — Objective → Progress (3-step window) → Activity →
// Sources. Sources (artifacts + uploaded files) are fused back IN and open the Workbench;
// Goals/Memory stay out. The separate ProjectContextPanel is retired (island owns the goal).
assertContains(
  "src/components/WorkspaceIsland.tsx",
  "threeStepWindow",
  "island plan must use the 3-step auto-focus window"
);
assertNotContains(
  "src/components/WorkspaceIsland.tsx",
  "onOpenWorkbench(\"goals\")",
  "goals row must be removed from the island"
);
assertNotContains(
  "src/components/WorkspaceIsland.tsx",
  "onOpenWorkbench(\"memoria\")",
  "memory row must be removed from the island"
);
// Task 4c: the objective sits at the top of the Objective → Plan → Activity hierarchy,
// rendered as a text block (conditional — hidden when the workspace has no objective).
assertContains(
  "src/components/WorkspaceIsland.tsx",
  "wi-goal",
  "island must render the project objective as a text block"
);
// Task 5: the rows dropped from the island (artifacts/files/activity) resurface behind
// a header kebab menu that reopens the docked Workbench on the right tab.
assertContains(
  "src/components/ChatView.tsx",
  "<ChatHeaderMenu",
  "chat header must expose a kebab menu for artifacts/files/screenshots/background activity"
);
assertContains("src/components/InspectorTabStrip.tsx", "role=\"tablist\"", "inspector must expose an ARIA tab list");
assertContains("src/components/InspectorTabStrip.tsx", "startPointerDrag", "inspector tabs must support pointer-based reorder");
assertContains("src/components/InspectorTabStrip.tsx", "onPointerUp={finishPointerDrag}", "inspector tabs must commit pointer reorder on release");
assertContains("src/components/InspectorTabStrip.tsx", "const currentX = event.clientX;", "inspector pointer reorder must use the release coordinate even when the platform emits no intermediate move");
assertContains("src/components/InspectorTabStrip.tsx", "onActivate(drag.tabId);", "captured pointer clicks must still activate the selected inspector tab");
assertContains("src/components/InspectorTabStrip.tsx", "draggingTabId", "inspector drag must expose visible transient state");
assertContains("src/components/InspectorTabStrip.tsx", 'aria-grabbed={draggingTabId === tab.id}', "inspector drag state must be exposed accessibly");
assertContains("src/components/InspectorTabStrip.tsx", 'drop-before', "inspector drag must mark the insertion side");
assertContains("src/components/InspectorTabStrip.tsx", 'window.addEventListener("blur", clearPointerDrag)', "inspector drag must clean up if the window loses focus");
assertContains("src/components/InspectorTabStrip.tsx", "scrollIntoView", "the active inspector tab must remain visible");
assertContains("src/components/InspectorTabStrip.tsx", "onWheel={onTabStripWheel}", "vertical wheel input over the tab strip must navigate horizontal overflow");
assertContains("src/styles.css", ".inspector-workspace-header {\n  position: relative;\n  z-index: 201;", "inspector tabs must sit above the native window drag strip");
assertContains("src/styles.css", ".inspector-tab {\n  position: relative;", "inspector tabs must provide stable positioning for drag indicators");
assertContains("src/styles.css", "flex: 0 0 auto;\n  width: clamp(112px, 14vw, 180px);", "inspector tabs must not shrink through their children");
assertContains("src/styles.css", ".inspector-tab-title {\n  flex: 1 1 auto;\n  min-width: 0;", "inspector tab titles must ellipsize inside their own tab");
assertContains("src/styles.css", ".inspector-tab.dragging {", "the dragged inspector tab must have visible feedback");
assertContains("src/styles.css", ".inspector-tab.drop-before::before,", "inspector drag must draw an insertion marker");
assertContains("src/styles.css", ".dragging-inspector-tab,", "inspector drag must keep a grabbing cursor across the window");
assertContains("src/components/InspectorWorkspace.tsx", "role=\"separator\"", "inspector must expose a keyboard resize separator");
assertContains("src/components/InspectorWorkspace.tsx", "onPointerDown", "inspector resizing must use pointer events");
assertContains("src/components/InspectorWorkspace.tsx", "setPointerCapture", "inspector resizing must retain the pointer over embedded previews");
assertContains("src/components/InspectorWorkspace.tsx", "releasePointerCapture", "inspector resizing must release pointer capture when it finishes");
assertContains("src/components/InspectorWorkspace.tsx", 'window.addEventListener("blur"', "inspector resizing must clean up if the window loses focus");
assertContains("src/components/InspectorWorkspace.tsx", "onToggleFocus", "inspector must expose focus mode without destroying tabs");
assertContains("src/components/InspectorWorkspace.tsx", "hidden={tab.id !== state.activeTabId}", "inactive tab panels must remain mounted and hidden");
assertContains("src/components/InspectorWorkspace.tsx", "scrollPositionsRef", "inspector tabs must retain independent reading positions");
assertContains("src/components/InspectorWorkspace.tsx", "panel.scrollTop = scrollPositionsRef.current.get(state.activeTabId) ?? 0", "the active inspector tab must restore its reading position");
assertContains("src/components/InspectorWorkspace.tsx", "tab.id === state.activeTabId", "only the visible inspector tab may update its saved reading position");
assertContains("src/styles.css", ".inspector-tab-panel {\n  min-width: 0;\n  min-height: 0;\n  height: 100%;\n  overflow-y: auto;", "inspector tab panels must own document scrolling");
assertContains("src/styles.css", ".inspector-tab-panel .artifacts-preview-body {\n  overflow: visible;", "embedded artifact documents must use the tab scroll owner");
assertContains("src/styles.css", ".inspector-tab-panel .workbench-files {\n  overflow: visible;", "inspector lists must use the tab scroll owner");
assertContains("src/styles.css", "grid-template-columns: minmax(420px, 1fr) minmax(420px, var(--inspector-width));", "chat and inspector must be real sibling columns");
assertContains("src/styles.css", ".active-task-layout.inspector-open > .chat-status-stack", "the working island must not create a third column");
assertNotContains("src/styles.css", ".workbench {\n  position: absolute", "legacy workbench must not float above the chat");
assertContains("src/components/ChatView.tsx", "useReducer(inspectorWorkspaceReducer", "chat must use one inspector reducer");
assertContains("src/components/ChatView.tsx", "loadInspectorState(thread.threadId", "inspector state must be scoped by thread");
assertContains("src/components/ChatView.tsx", "saveInspectorState(thread.threadId", "inspector state changes must persist by thread");
assertContains("src/components/ChatView.tsx", "Promise.all(restored.tabs.map", "restored resource tabs must be revalidated as one batch");
assertContains("src/components/ChatView.tsx", "coreBridge.fsFile(tab.payload.path, thread.threadId)", "restored file tabs must recheck current authorization");
assertContains("src/components/ChatView.tsx", "inspectorResourcesReady", "restored resources must stay hidden until validation completes");
assertContains("src/components/ChatView.tsx", "reconcileMemoryArtifacts", "artifact polling must preserve an unchanged catalog");
assertNotContains("src/components/ChatView.tsx", "memoryArtifactsRevision", "artifact validation must not use an unconditional revision counter");
assertContains("src/components/ChatView.tsx", "selectedResourceRevision", "artifact preview reloads must follow a semantic resource revision");
assertNotContains("src/components/ChatView.tsx", "setArtifactsOpen", "legacy open boolean must not compete with inspector state");
assertNotContains("src/components/ChatView.tsx", "setWorkbenchTab", "legacy active-tab state must be removed");
assertContains("src/components/ChatView.tsx", "`file:${normalizedPath}`", "file tabs must dedupe by canonical path");
assertContains("src/components/ChatView.tsx", "`artifact:${artifact.thread}:${artifact.name}`", "artifact tabs must dedupe by provenance and name");
assertNotContains("src/styles.css", ".artifacts-panel.embedded .artifacts-panel-body {\n  grid-template-columns:", "artifact preview must not keep a permanent inner sidebar");
assertNotContains("src/components/ChatView.tsx", "detailsOpen && (", "computer detail must use the shared inspector");
assertNotContains("src/styles.css", ".computer-detail-panel {\n  position: absolute", "computer detail must not float separately");
assertContains("src/styles.css", "@container chat-workspace (max-width: 960px)", "narrow behavior must follow available chat width");
assertContains("src/components/ChatView.tsx", "descriptor.kind === \"sources\"", "sources must have an inspector adapter");
assertContains("src/components/ChatView.tsx", "onOpenArtifact(sourceArtifact)", "artifact sources must open their resource tab");
assertContains("src/components/ChatView.tsx", "descriptor.kind === \"subagents\"", "subagents must have an inspector adapter");
assertContains("src/components/ChatView.tsx", "subagent.updated_at", "subagent views must expose their latest timestamp");
assertContains("src/components/InspectorTabStrip.tsx", 't("chat.inspector.closeTab"', "inspector tabs must have a specific localized close label");
assertContains("src/components/InspectorWorkspace.tsx", 't("chat.inspector.resize"', "inspector separator must have a localized resize label");
assertContains("src/components/InspectorWorkspace.tsx", "aria-valuenow", "inspector separator must expose its current width to assistive technology");
assertContains("src/components/InspectorWorkspace.tsx", "aria-valuemin={minPercent}", "inspector separator must expose its reachable minimum");
assertContains("src/components/InspectorWorkspace.tsx", "aria-valuemax={maxPercent}", "inspector separator must expose its reachable maximum");
assertContains("src/components/ChatView.tsx", "fileLoadGenerationRef", "file revalidation must ignore stale authorization responses");
assertContains("src/styles.css", ".active-task-layout.inspector-focused > .composer-surface", "focused inspector must hide the current composer surface");
assertNotContains("src/styles.css", ".active-task-layout.inspector-focused > .composer-shell", "focused inspector must not target the removed composer shell class");
assertNotContains("src/components/ChatView.tsx", "panel-menu-wrap--corner", "chat topbar must not expose a second workbench launcher");
assertNotContains("src/styles.css", ".panel-menu-wrap--corner", "chat topbar workbench launcher must not compete with the workspace island");
assertNotContains("src/styles.css", "z-index: 220;", "chat header workspace/review menu must not overlay native window controls");
assertContains("src/components/ChatView.tsx", "<ArtifactsPanel", "artifact review must use the rich preview/diff surface in the workbench");
assertContains("src/styles.css", ".artifacts-panel.embedded .artifacts-panel-body", "artifact review workbench must style the embedded artifacts panel directly");
assertContains("src/styles.css", ".artifacts-panel.embedded .artifacts-panel-body {\n  min-height: 0;\n  padding: 0;", "embedded artifacts must not add an outer content frame");
assertContains("src/styles.css", ".artifacts-panel.embedded .artifacts-preview {\n  min-width: 0;\n  overflow: hidden;\n  border: 0;", "artifact preview must use the inspector as its only frame");
assertContains("src/styles.css", ".artifacts-panel.embedded .artifact-preview-doc {\n  padding: 0;\n  border: 0;", "artifact documents must not render as nested cards");
assertContains("src/styles.css", ".workbench-artifacts-list .artifact-row-wrap {\n  overflow: hidden;\n  border: 0;", "artifact rows must avoid nested card borders");
assertContains("src/components/ChatView.tsx", "fileStatus === \"missing\"", "missing files must expose a dedicated recoverable state");
assertNotContains("src/components/ChatView.tsx", "{planSteps.length > 0 && <PlanProgressCard steps={planSteps} />}", "operational plan markers must not render duplicate inline cards inside the assistant answer");
assertContains("src/components/ChatView.tsx", "{readable && <RichMessage text={readable} streaming={streaming} eventParts={eventParts} />}", "assistant markdown must stay progressive while the message streams");
assertContains("src/components/ChatView.tsx", "{planPropose && !streaming && onChoose && (", "actionable plan proposal cards must wait for a completed non-streaming message");
assertContains("src/components/ChatView.tsx", "streamingUserPinnedRef", "chat must keep new streaming responses visible");
assertNotContains("src/components/ChatView.tsx", "STREAM_TYPEWRITER_INTERVAL_MS", "chat streaming must not use timer-based typewriter rendering");
assertNotContains("src/components/ChatView.tsx", "streamingTextRef", "chat streaming must not bypass React with a manual DOM text node");

assertContains("src/components/ChatView.tsx", "messageContentKind", "message actions must derive from response content type");
assertContains("src/components/ChatView.tsx", "onExplainCode", "code responses must expose code-specific contextual actions");
assertContains("src/components/ChatView.tsx", "onImproveCode", "code responses must expose code improvement action");
assertContains("src/components/ChatView.tsx", "reply-context-card", "composer must show the active reply context before submit");
assertContains("src/components/ChatView.tsx", "message-action-menu", "secondary message actions must stay behind a compact menu");
assertContains("src/components/ChatView.tsx", "runMessageMenuAction", "message overflow actions must close the menu before running");
assertContains("src/components/ChatView.tsx", "message-latency-summary", "message metrics must be visible without dominating the answer");
assertContains("src/components/ChatView.tsx", "normalizeGoalText", "goals manager must normalize goal text before comparing suggestions");
assertContains("src/components/ChatView.tsx", "dedupeGoalDrafts", "goals manager must dedupe suggested goals against existing project goals");
assertContains("src/components/ChatView.tsx", "decideMemory(g.reference, \"delete\")", "goals manager must allow deleting saved project goals");
assertContains("src/components/ChatView.tsx", "resizeFitTimer", "memory graph must refit after the workbench/canvas changes size");
assertContains("src/components/ChatView.tsx", "layoutSignal", "memory graph must receive an explicit workbench layout signal");
assertContains("src/components/ChatView.tsx", "layoutSignal={`${inspector.activeTabId}:${inspectorRatio}`}", "inspector must refit Memory when the active tab or width changes");
assertContains("src/components/ChatView.tsx", "requestAnimationFrame", "memory graph resize refit must wait for the resized canvas to paint");
assertContains("src/components/ChatView.tsx", "d3ReheatSimulation", "memory graph resize refit must restart layout before fitting");
assertContains("src/styles.css", ".memory-graph-canvas canvas", "memory graph must size the ForceGraph canvas, not only an svg");
assertNotContains("src/components/ChatView.tsx", "canCreateteTask={assistantTextMessage}", "message action menu must not advertise unverified task creation for every assistant text");
assertNotContains("src/components/ChatView.tsx", "canCreateteAutomation={assistantTextMessage}", "message action menu must not advertise unverified automation creation for every assistant text");
assertNotContains("src/components/ChatView.tsx", "\"Use a skill\"", "composer add menu must expose user-facing capabilities, not implementation terms");
assertNotContains("src/components/ChatView.tsx", "t(\"chat.searchSkill\")", "composer capability picker must not expose skill terminology");
assertContains("src/components/ChatView.tsx", "t(\"chat.searchCapability\")", "composer capability picker must search capabilities");
assertContains("src/components/ChatView.tsx", "t(\"chat.noCapabilities\")", "composer capability picker must use capability empty state");
assertContains("src/components/ChatView.tsx", "t(\"chat.forcedCapabilityNextMessage\")", "forced capability chip must use user-facing capability terminology");
assertContains("src/components/ChatView.tsx", "{m.desc && <small>{m.desc}</small>}", "composer mode picker must explain what each mode does");
assertContains("src/components/ChatView.tsx", "!m.projectOnly || linkedFolder != null", "composer must hide project-only modes without a linked project folder");
assertContains("src/i18n/locales/en.json", "\"searchCapability\"", "English chat locale must include capability search label");
assertContains("src/i18n/locales/it.json", "\"searchCapability\"", "Italian chat locale must include capability search label");
assertContains("src/components/ChatView.tsx", "value.trim() && (", "composer improve prompt action must only render when there is prompt text to improve");
assertNotContains("src/components/ChatView.tsx", "/^fn\\s+", "code-specific message actions must not rely on fragile plain-text Rust heuristics");
assertNotContains("src/components/ChatView.tsx", "/^let\\s+", "code-specific message actions must not rely on fragile plain-text variable heuristics");
assertContains("src/components/ChatView.tsx", "cancelStreamingRequestRef", "chat must allow users to stop a visible streaming response");
assertContains("src/components/ChatView.tsx", "catalogsMissingModels", "chat must refresh an empty provider catalog even when an active model is already known");
assertContains("src/components/ChatView.tsx", "RUNTIME_MODELS_CHANGED_EVENT", "chat model picker must react immediately to provider changes without a page refresh");
assertContains("src/components/SettingsView.tsx", "refreshEmptyLocalOllamaCatalogs", "settings must discover local Ollama models automatically when its catalog is empty");
assertContains("src/components/SettingsView.tsx", "isLocalOllamaProvider", "settings must distinguish keyless local Ollama from authenticated cloud endpoints");
assertContains("src/components/OnboardingWizard.tsx", "isLocalOllamaProvider", "onboarding must not ask for an API key when a custom local Ollama endpoint is selected");
assertContains("src/components/OnboardingWizard.tsx", "const providerId = \"ollama\"", "onboarding must update the canonical local Ollama provider instead of creating duplicates");
assertContains("src/components/OnboardingWizard.tsx", "await coreBridge.refreshProviderModels(providerId)", "onboarding provider setup must persist the discovered catalog before entering chat");
assertNotContains(
  "src/components/ChatView.tsx",
  "PLAN_PROPOSE››([\\s\\S]*?)(?:‹‹\\/PLAN_PROPOSE››|$)",
  "plan proposal cards must require a closed marker so truncated JSON is not accepted as an actionable plan",
);
assertContains("src/App.tsx", "const ids = new Set<string>(backgroundStreamIds)", "sidebar busy state must include durable background stream ids");
assertContains("src/App.tsx", "if (streamingThreadId) ids.add(streamingThreadId)", "sidebar busy state must include the active visible stream");
assertContains("src/App.tsx", "task.status === \"running\" || task.status === \"queued\"", "sidebar busy state must ignore completed or failed tasks");
assertContains("src/App.tsx", "pendingLocalMessageThreadIdsRef", "chat polling must know which threads have optimistic local messages");
assertContains("src/App.tsx", "shouldPreserveLocalMessages", "backend refresh must not wipe visible local messages before gateway persistence");
assertContains("src/App.tsx", "setThreadMessagesFromBackend", "backend chat snapshots must pass through the stale-safe message updater");
assertContains("src/App.tsx", "pendingTemplateAutoSubmit", "template workflows must be handed to the visible chat renderer");
assertContains("src/App.tsx", "onAutoSubmitConsumed", "template auto-submit triggers must be consumed after entering the chat pipeline");
assertContains("src/components/ChatView.tsx", "autoSubmit?: ChatAutoSubmit | null", "ChatView must accept external chat-start triggers without bypassing streaming UI");
assertContains("src/components/ChatView.tsx", "submitPrompt(\n      autoSubmit.prompt", "external chat-start triggers must reuse the normal visible submit pipeline");
assertNotContains("src/App.tsx", "template_workflow_", "template workflows must not start a parallel invisible stream from App");
// The dock now has ONE enlarge/contract control (right-aligned): fullscreen ⇄ back.
assertContains("src/components/ChatComputerPanel.tsx", "setView(fullscreen ? \"expanded\" : \"full\")", "Computer dock must expose a single enlarge/contract control (fullscreen ⇄ expanded)");
assertContains("src/components/ChatComputerPanel.tsx", "fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />", "Computer dock enlarge/contract control must use fullscreen/minimize icons");
assertContains("src/styles.css", ".cc-dock,\n.cc-scrim {\n  pointer-events: auto;", "Computer dock controls must be clickable inside the non-interactive status stack");
assertContains("src/styles.css", ".cc-dock.full {\n  position: fixed;", "Computer fullscreen dock must escape the status stack and anchor inside the chat viewport");
assertContains("src/styles.css", "left: calc(var(--drawer-island-gap) + var(--drawer-width, 292px) + 24px);", "Computer fullscreen dock must start to the right of the sidebar island");
assertContains("src/styles.css", "width: min(1040px, calc(100vw - var(--drawer-width, 292px) - 72px));", "Computer fullscreen must be large but bounded by the chat area");
assertContains("src/components/RichMessage.tsx", "STRAY_REASONING_MARKER_RE", "streaming renderer must strip stray or malformed reasoning markers from the visible answer body");
assertContains("src/components/ChatView.tsx", "VAULT_PROPOSE_RE", "chat renderer must parse vault proposal markers");
assertContains("src/components/ChatView.tsx", "VaultProposeCard", "chat renderer must render sensitive-data vault proposal cards");
// The strip regex (COMPOSIO_MARKERS_RE, which lists VAULT_PROPOSE|…) was refactored out of
// ChatView into src/lib/markers.ts; ChatView imports and applies it (see COMPOSIO_MARKERS_RE below).
assertContains("src/lib/markers.ts", "VAULT_PROPOSE|", "vault proposal markers must be stripped from visible prose");
assertContains("src/components/ChatView.tsx", "COMPOSIO_MARKERS_RE", "chat renderer must apply the marker-strip regex to visible prose");
assertContains("src/components/ChatView.tsx", "VAULT_REVEAL_RE", "chat renderer must parse vault reveal markers");
assertContains("src/components/ChatView.tsx", "VaultRevealCard", "chat renderer must render PIN-gated vault reveal cards");
assertContains("src/lib/markers.ts", "VAULT_REVEAL|", "vault reveal markers must be stripped from visible prose");

assertContains("src/types.ts", "\"learning\"", "auto-learning must be a first-class view");
assertContains("src/components/LearningView.tsx", "learning-view", "auto-learning must have a dedicated page");
assertContains("src/components/LearningView.tsx", "habit-card", "learning page must expose learned habits");
assertContains("src/components/LearningView.tsx", "automation-proposal", "learning page must expose possible automations");
assertNotContains("src/components/AutomationsView.tsx", "totali", "automations summary total label must use i18n");
assertNotContains("src/components/AutomationsView.tsx", "attive", "automations summary active label must use i18n");
assertContains("src/styles.css", "@media (max-width: 860px)", "responsive shell must define tablet/mobile behavior");

assertRepoContains("Cargo.toml", "\"crates/desktop-gateway\"", "workspace must include the desktop gateway crate");
assertRepoContains("crates/desktop-gateway/src/lib.rs", "build_chat_runtime_prompt", "desktop gateway must own chat runtime prompt construction");
assertRepoContains("crates/desktop-gateway/src/lib.rs", "ContextCompressor", "desktop gateway must use Rust context compression");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/chat/build_prompt", "desktop gateway must expose prompt build endpoint");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/chat/turns", "desktop gateway must expose the broker turn endpoint (the only chat path)");
assertRepoContains("apps/desktop/src/lib/coreBridge.ts", "export type CoreChatStreamEvent", "desktop renderer must expose structured chat stream events");
assertRepoContains("apps/desktop/src/lib/chatApi.ts", "listenChatStreamEvent", "chat API must expose structured chat stream subscription");
assertRepoContains("apps/desktop/src/components/ChatView.tsx", "listenChatStreamEvent", "ChatView must consume structured chat stream events");
assertRepoContains("apps/desktop/src/components/ChatView.tsx", "eventParts", "ChatView must pass structured event parts into assistant rendering");
assertRepoContains("apps/desktop/src/lib/coreBridge.ts", "event_parts", "core chat message must expose persisted structured event parts");
assertRepoContains("apps/desktop/src/App.tsx", "mapCoreChatEventParts", "desktop app must hydrate persisted structured event parts");
assertRepoNotContains("apps/desktop/src/components/ChatView.tsx", "eventPartToLegacyMarker", "ChatView must not synthesize legacy markers from structured event parts");
assertRepoNotContains("apps/desktop/src/components/ChatView.tsx", "visibleStreamingText", "streaming messages must keep prose text separate from structured event parts");
assertRepoContains("apps/desktop/src/components/ChatView.tsx", "shouldDropStructuredMarkerDelta", "ChatView must drop legacy marker deltas after receiving structured event parts");
assertNotContains("src/App.tsx", "‹‹CHOICES››", "new proactivity choice prompts must use structured event parts, not marker text");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/tasks/queue", "desktop gateway must expose task queue read model endpoint");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/tasks/executor", "desktop gateway must expose task executor status endpoint");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/tasks/run_next", "desktop gateway must expose the first local task executor endpoint");
assertRepoContains("crates/desktop-gateway/src/main.rs", "start_task_executor_worker", "desktop gateway must start a background task executor worker");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/local-computer/sessions/{session_id}", "desktop gateway must expose local computer session read model endpoint");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/local-computer/sessions/{session_id}/artifacts/{artifact_id}/preview", "desktop gateway must expose redacted local computer artifact previews");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/memory/dashboard", "desktop gateway must expose memory dashboard read model endpoint");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/capabilities/snapshot", "desktop gateway must expose capability registry snapshot endpoint");
assertRepoContains("crates/desktop-gateway/src/main.rs", "TaskUiReadModel", "desktop gateway must use the task runtime UI read model");
assertRepoContains("crates/desktop-gateway/src/main.rs", "LocalComputerReadModel", "desktop gateway must use the local computer UI read model");
assertRepoContains("crates/desktop-gateway/src/main.rs", "MemoryUiReadModel", "desktop gateway must use the memory UI read model");
assertRepoContains("crates/desktop-gateway/src/main.rs", "CapabilityRegistryStore", "desktop gateway must use the capability registry store");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/chat/threads", "desktop gateway must expose persistent thread endpoints");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/messages/{message_id}/create_task", "desktop gateway must create durable tasks from chat messages");
assertRepoContains("crates/desktop-gateway/src/main.rs", "link_brain_tasks_to_thread", "desktop gateway must link Brain-created operational tasks to the thread (and local computer read models)");
assertRepoContains("crates/desktop-gateway/src/main.rs", "LocalComputerSessionStore", "desktop gateway must persist computer sessions for operational tasks");
assertRepoContains("crates/desktop-gateway/src/main.rs", "HOMUN_BROWSER_HEADLESS", "desktop gateway must allow visible Playwright browser sessions");
assertRepoContains("crates/desktop-gateway/src/main.rs", "require_gateway_token", "desktop gateway must protect chat endpoints with a local token");
assertRepoContains("crates/desktop-gateway/src/main.rs", "AllowOrigin::list", "desktop gateway CORS must use an explicit origin allowlist");
assertRepoContains("crates/desktop-gateway/src/main.rs", "HeaderValue::from_static(\"null\")", "desktop gateway CORS must allow packaged file-origin renderer with bearer token");
assertRepoContains("crates/desktop-gateway/src/chat_store.rs", "create table if not exists chat_threads", "desktop gateway must persist chat threads in SQLite");
assertRepoContains("crates/desktop-gateway/src/chat_store.rs", "create table if not exists chat_messages", "desktop gateway must persist chat messages in SQLite");
assertRepoContains("crates/desktop-gateway/src/main.rs", "Body::from_stream", "desktop gateway must proxy runtime stream without buffering the full answer");

assertContains(
  "src/components/ChatView.tsx",
  "<MessageActivity",
  "per-turn activity must be rendered inline in each assistant message"
);

assertNotContains(
  "src/components/ProjectContextPanel.tsx",
  "pcp-objective",
  "objective is owned by the working island; the project panel must not duplicate it"
);

console.log("UI contract checks passed");
