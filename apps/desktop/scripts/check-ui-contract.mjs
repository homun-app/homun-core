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
assertContains("src/styles.css", "background: color-mix(in srgb, var(--surface) 82%, transparent);", "Embedded artifact list must inherit the active surface theme");
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
assertRepoContains("crates/desktop-gateway/src/main.rs", "If the user explicitly asks to create, show, update, verify, or test a plan", "chat loop must force explicit plan requests through update_plan");
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
assertContains("src/data/mockData.ts", "label: \"settings.computer\"", "Settings sidebar Local computer label must use i18n");
assertContains("src/lib/coreBridge.ts", "secret_value?: string", "Vault bridge must expose optional raw secret material only for the encrypted accept path");
assertContains("src/components/ChatComputerPanel.tsx", "const browserRunning = Boolean(live?.active && live?.novnc_url)", "live computer browser state must distinguish running activity from idle availability");
assertContains("src/components/ChatComputerPanel.tsx", "const terminalRunning = Boolean(live?.terminal_active || terminal.some((entry) => entry.running))", "terminal dock must be driven by running terminal activity, not completed history");
assertContains("src/components/ChatComputerPanel.tsx", "const ownedLiveActivity = hasLiveActivity && live?.thread_id === threadId", "live computer activity must not appear across chats without a matching owner");
assertNotContains("src/components/ChatComputerPanel.tsx", "cc-dock-activity", "computer island header must show only Computer and LIVE, never prompt/activity text");
assertNotContains("src/styles.css", ".cc-dock-activity", "computer island must not reserve header space for prompt/activity text");
assertNotContains("src/components/ChatComputerPanel.tsx", "const ownedByThisThread = !hasLiveActivity", "idle global computer availability must not count as thread ownership");
assertMatches(
  "src/components/ChatView.tsx",
  /const showComputerActivity =\s*activeApprovels\.length > 0 \|\|\s*planStepRunning \|\|\s*smokeTestRunning \|\|\s*detailsOpen;/m,
  "inline computer activity must be driven only by active approvals/runs or explicit details",
);
assertNotMatches(
  "src/components/ChatView.tsx",
  /const showComputerActivity =[\s\S]*visibleComputerSession\.(timeline|artifacts)\.length > 0[\s\S]*?;/m,
  "completed computer timeline/artifacts must not reopen the inline Computer card",
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
assertContains("src/components/BrandKitPanel.tsx", "builtin:template-preview/", "template gallery must render built-in previews when the catalog declares preview_ref");
assertContains("src/components/BrandKitPanel.tsx", "TemplateCardPreview", "template gallery cards must route preview rendering through a dedicated component");
assertContains("src/components/BrandKitPanel.tsx", "template-card-contract", "template gallery must keep the metadata contract fallback for catalogs without preview_ref");
assertContains("src/components/BrandKitPanel.tsx", "selection_notes", "template gallery must expose catalog selection rationale, not only visual decoration");
assertContains("src/components/BrandKitPanel.tsx", "entry.selection_notes ?? []", "template gallery must tolerate legacy catalog entries without selection_notes");
assertContains("src/components/BrandKitPanel.tsx", "Import PPTX", "Presentations must expose manual PPTX template import");
assertContains("src/components/BrandKitPanel.tsx", "TEMPLATE_SOURCE_LINKS", "Presentations must keep provider-agnostic template source links");
assertContains("src/components/BrandKitPanel.tsx", "TemplateSourceDirectory", "Presentations must separate external template sources from installed templates");
assertNotContains("src/components/BrandKitPanel.tsx", "sourceFilter === \"slidescarnival\"", "SlidesCarnival must not be a hard-coded installed-catalog source filter");
assertContains("src/components/BrandKitPanel.tsx", "attribution_required", "Presentations must surface attribution state for imported/source templates");
assertContains("src/components/BrandKitPanel.tsx", "TemplateDetailModal", "template gallery must expose a catalog detail view before use");
assertContains("src/components/BrandKitPanel.tsx", "useTemplate(entry", "template gallery must start chat workflows from the selected catalog entry");
assertContains("src/components/BrandKitPanel.tsx", ".templateSourceAttachment(entry.id)", "imported PPTX templates must resolve their source attachment only when used");
assertContains("src/components/BrandKitPanel.tsx", "await refreshTemplates()", "PPTX import must refresh the reusable catalog instead of immediately starting chat");
assertContains("src/plugins/registry.tsx", "startTemplateWorkflow", "plugin host must expose a typed template workflow handoff");
assertContains("src/App.tsx", "handleStartTemplateWorkflow", "App must own the template workflow chat creation path");
assertContains("src/App.tsx", "template_ref=", "template workflow prompt must preserve the canonical template reference");
assertContains("src/App.tsx", "Do not generate the deck yet.", "template workflow must start with discovery and planning, not immediate deck generation");
assertNotContains("src/App.tsx", "Aiutami a creare una presentazione", "template workflow default visible prompt must remain English");
assertContains("src/lib/coreBridge.ts", "importPptxTemplate", "Desktop bridge must expose PPTX template import");
assertContains("src/lib/coreBridge.ts", "templateSourceAttachment", "Desktop bridge must resolve local template attachments without exposing paths in the catalog");
assertContains("src/lib/coreBridge.ts", "attachments?: CoreChatAttachment[]", "streamed prompt commits must be able to preserve user attachments");

assertContains("src/components/ChatView.tsx", "coreBridge.submitChatPromptStream", "composer must submit prompts through the local chat transport");
assertContains("src/lib/coreBridge.ts", "submitBrowserRuntimeChatPromptStream", "Electron bridge must stream from the local Gemma runtime through Electron-safe transport");
assertContains("src/lib/coreBridge.ts", "enqueueTurn(", "Electron bridge must submit chat turns through the Rust gateway's turn broker");
assertContains("src/lib/chatApi.ts", "/api/chat/turns", "broker turn API must POST turns to the local gateway endpoint");
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
assertContains("src/components/ChatView.tsx", "onOpenWorkbench={(tab) =>", "chat header (island or kebab menu) must wire onOpenWorkbench(tab) to open the docked Workbench");
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
assertContains("src/components/ChatView.tsx", "detailsOpen || workbenchOpen ? \" panel-open\" : \"\"", "right-side panels must reserve layout space instead of covering the chat");
assertContains("src/styles.css", "top: calc(var(--window-chrome-height, 44px) + 8px);", "workbench island must sit below native chrome with breathing room");
assertContains("src/styles.css", "right: 12px;", "workbench island must keep a visible margin from the window edge");
assertContains("src/styles.css", "border-radius: 16px;", "workbench island must share the rounded shell geometry");
assertContains("src/styles.css", "box-shadow: 0 18px 44px", "workbench island must read as a floating inspector, not a flat column");
assertNotContains("src/components/ChatView.tsx", "panel-menu-wrap--corner", "chat topbar must not expose a second workbench launcher");
assertNotContains("src/styles.css", ".panel-menu-wrap--corner", "chat topbar workbench launcher must not compete with the workspace island");
assertNotContains("src/styles.css", "z-index: 220;", "chat header workspace/review menu must not overlay native window controls");
assertContains("src/components/ChatView.tsx", "<ArtifactsPanel", "artifact review must use the rich preview/diff surface in the workbench");
assertContains("src/styles.css", ".artifacts-panel.embedded .artifacts-panel-body", "artifact review workbench must style the embedded artifacts panel directly");
assertContains("src/styles.css", ".artifacts-panel.embedded .artifacts-preview", "artifact review preview must be a bounded card in the workbench");
assertContains("src/styles.css", ".workbench-artifacts-list .artifact-row-wrap", "artifact review must frame artifacts as cards inside the workbench");
assertContains("src/styles.css", ".workbench-artifacts-list .artifact-preview-doc", "artifact preview content must be padded and bounded inside the workbench");
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
assertContains("src/components/ChatView.tsx", "layoutSignal={`${expanded ? \"expanded\" : \"docked\"}:${width}`}", "workbench must refit Memory when fullscreen or width changes");
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
