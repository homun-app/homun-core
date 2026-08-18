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

function assertOccurrences(file, text, expected, description) {
  const source = read(file);
  const actual = source.split(text).length - 1;
  if (actual !== expected) {
    throw new Error(`${description}: expected ${file} to contain ${text} ${expected} time(s), found ${actual}`);
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
assertContains("src/App.tsx", "function AuthenticatedApp()", "authenticated app effects must mount only after the login gate opens");
assertMatches(
  "src/App.tsx",
  /export default function App\(\)\s*\{\s*return \(\s*<LoginGate>\s*<AuthenticatedApp \/>\s*<\/LoginGate>/,
  "web login must gate the entire authenticated app mount",
);
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
assertContains("src/components/ChatEmptyHero.tsx", "<ChatUsageOverview", "Empty hero must mount compact usage");
assertContains("src/components/ChatView.tsx", "onUseForTask", "Confirmed task suggestions must reach the composer model override");
assertContains("src/components/useChatTurnSubmission.ts", "enqueueTurn(thread.threadId, requestId, promptWithReplyContext", "Active task instructions must be queued as steering");
assertSource("src/components/ActiveTurnStatus.tsx", ["chat.inspector.views.activity", "onStop", "attempt"]);
assertSource("src/components/PendingSteeringQueue.tsx", ["onEdit", "onDelete", "onSendNow"]);
assertSource("src/components/ChatComposerDock.tsx", ["<ActiveTurnStatus", "<PendingSteeringQueue", "<ComposerContainer"]);
assertSource("src/components/ChatView.tsx", ["<ChatComposerDock", "pendingSteering"]);
assertNotContains(
  "src/lib/useAppEventSubscription.ts",
  "navigateToThread(eventThreadId",
  "background events cannot navigate",
);
assertContains(
  "src/lib/useAppEventSubscription.ts",
  "refreshThreadInBackground(eventThreadId)",
  "background events refresh only their cache",
);
assertSource("src/lib/threadSnapshotProjection.mjs", [
  "export function projectThreadSnapshotSelection",
  "const preservedThread = mappedThreads.find(",
  "thread.threadId === activeThreadId",
  'thread.status === "active"',
]);
assertContains(
  "src/styles/sidebar.css",
  ".thread-status-dot.completed-unread",
  "completion uses a fixed teal dot",
);
assertSource("src/components/useChatTurnSubmission.ts", [
  'function openActivityIsland() {\n    hideInspector();\n    bumpActivityNonce();',
  'if (result.status === "queued")',
]);
assertContains("src/components/ChatView.tsx", "onOpenActivity={openActivityIsland}", "ChatView must wire openActivityIsland to the activity handler");
assertNotContains(
  "src/components/ChatView.tsx",
  "setIslandOpen",
  "Activity must target the adaptive section instead of reviving a persistent panel owner",
);
assertContains("src/components/ComposerShell.tsx", "{props.streaming ? (", "Stop must remain available while the composer stays operational");
assertContains("src/components/ComposerShell.tsx", ": canSend ? (", "Send must remain available independently from Stop");
assertContains("src/lib/chatApi.ts", "res.status === 201 || res.status === 202", "Turn enqueue must accept steering responses");
assertContains("src/components/UsageSuggestion.tsx", "usage-suggestion-confirm", "Suggestion changes must use an explicit confirmation surface");
assertContains("src/components/UsageSuggestion.tsx", "confirmed: true", "Apply request must be explicitly confirmed");
assertContains("src/components/UsageSuggestion.tsx", "onDismiss", "Suggestions must be dismissible");
assertNotContains("src/components/UsageSuggestion.tsx", "useEffect(() => onApply", "Mounting must never apply a suggestion");
assertContains("src/components/ChatUsageOverview.tsx", ".slice(0, 1)", "Home must render at most one model suggestion");
assertContains("src/styles.css", ".chat-usage-infographic", "New-chat usage must provide a dedicated infographic layout");
assertContains("src/styles.css", ".usage-calendar-grid", "Usage calendar must use a shared compact grid");
assertContains("src/styles.css", ".usage-calendar-tooltip", "Usage calendar must provide an unclipped callout");
assertContains("src/styles/sidebar.css", ".app-shell.drawer-open > .workspace {\n    grid-column: 1;", "Narrow Settings content must stay in the visible grid column");
assertContains("src/styles/sidebar.css", ".app-shell.drawer-open > .settings-workspace {\n    padding-left: calc(min(var(--drawer-width, 268px), 268px) + 24px);", "Narrow Settings content must clear the overlay navigation");
assertContains("src/styles.css", ".active-task-layout.is-empty {\n  grid-template-rows: 58px minmax(0, 1fr) auto;", "Empty chat must keep the composer in the same bottom row as active conversations");
assertNotContains("src/styles.css", "grid-template-rows: 58px 1fr auto 1fr", "Empty chat must not vertically center the composer with spacer rows");
assertContains("src/styles.css", ".active-task-layout.is-empty .thread-content {\n  width: min(100%, 960px);", "Empty chat must give the six-month heatmap enough desktop width");
assertContains("src/styles.css", "@container chat-workspace (max-width: 860px) {\n  .chat-usage-infographic {", "The heatmap summary must stack before horizontal scrolling is needed");
assertContains("src/styles.css", ".chat-usage-infographic .usage-calendar--compact {\n    --usage-cell: 11px;\n    --usage-gap: 3px;", "Compact windows must shrink the Home cells before exposing horizontal scroll");
assertNotContains("src/components/UsageSettingsPane.tsx", "latency-p50", "Models must not show latency until canonical aggregates expose it");
assertNotContains("src/components/UsageSettingsPane.tsx", "fallback-count", "Models must not show fallback placeholders as measured data");
assertContains("src/components/UsageSettingsPane.tsx", "modelCostProvenance", "Per-model cost must disclose reported, estimated, unknown, or not-billed provenance");
assertContains("src/components/UsageSettingsPane.tsx", "coreBridge.setRole({", "Settings must apply confirmed role instructions through the canonical role API");
assertRepoContains(
  "crates/desktop-gateway/src/gateway_boot_maintenance.rs",
  "run_gateway_boot_maintenance",
  "Gateway boot maintenance must have a dedicated startup owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/main.rs",
  "gateway_boot_maintenance::run_gateway_boot_maintenance(&state);",
  "Gateway startup must delegate idempotent maintenance to the dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_turn_recovery.rs",
  "recover_gateway_chat_turns_at_startup",
  "Gateway turn recovery must have a dedicated startup owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/main.rs",
  "gateway_turn_recovery::recover_gateway_chat_turns_at_startup(&state).await;",
  "Gateway startup must delegate lease-aware chat recovery to the dedicated owner",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway boot maintenance"',
  "Kernel regression gate must run the gateway boot maintenance owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway_turn_recovery"',
  "Kernel regression gate must run the gateway turn recovery owner test",
);
assertRepoContains(
  "scripts/check_gateway_main_contract.py",
  "forbidden_main_startup_snippets",
  "Gateway main slimming must have a dedicated structural contract",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_background_startup.rs",
  "start_gateway_background_services",
  "Gateway background startup must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_routes.rs",
  "build_gateway_router",
  "Gateway route assembly must have a dedicated owner",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway system status"',
  "Kernel regression gate must run the gateway system status owner test",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_recall_context.rs",
  "recall_stream_payload_from_pack",
  "Gateway memory recall context must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_proactivity.rs",
  "run_proactive_review",
  "Gateway proactivity review engine must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_task_maintenance.rs",
  "gc_stale_tasks",
  "Gateway task maintenance must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_background.rs",
  "spawn_memory_consolidation_tick",
  "Gateway memory background jobs must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_remote_approval.rs",
  "remote_approval_intent_from_raw_text",
  "Gateway remote approval marker parsing must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_plugins.rs",
  "plugins_list",
  "Gateway plugin enablement endpoints must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_plugin_packages.rs",
  "install_local_plugin_package",
  "Gateway plugin package endpoints must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_chat_threads.rs",
  "chat_threads",
  "Gateway chat thread endpoints must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_chat_branches.rs",
  "chat_branches",
  "Gateway chat branch endpoints must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_chat_tasks.rs",
  "create_task_from_chat_message",
  "Gateway chat task endpoints must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_chat_memory.rs",
  "save_chat_message_to_memory",
  "Gateway chat memory-save endpoint must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_dedup.rs",
  "is_semantic_duplicate",
  "Gateway memory dedup/suppression must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_dedup.rs",
  "DEDUP_COSINE",
  "Gateway memory semantic dedup threshold must stay with the dedup owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_query_embeddings.rs",
  "memory_query_embedding_cache_key",
  "Gateway memory query embedding cache must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_briefing.rs",
  "format_memory_block_with_provenance",
  "Gateway memory briefing prompt assembly must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_turn_context.rs",
  "project_objective_block",
  "Gateway memory turn context injection must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_clients.rs",
  "gateway_embedding_client",
  "Gateway memory provider clients must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_recall_service.rs",
  "InProcessMemoryRecallService",
  "Gateway memory recall service must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_graph.rs",
  "upsert_memory_relation",
  "Gateway memory graph relation helpers must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_graph_routes.rs",
  "memory_graph_merge",
  "Gateway memory graph routes must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_graph_maintenance.rs",
  "reconcile_memory_scope",
  "Gateway memory graph maintenance must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_graph_persistence.rs",
  "persist_graph",
  "Gateway memory graph persistence must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_contact_profile.rs",
  "contact_profile_refresh",
  "Gateway contact profile routes must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_contacts.rs",
  "contacts_list",
  "Gateway core contact routes must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_contact_perimeter.rs",
  "contact_perimeter_set",
  "Gateway contact perimeter routes must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_contact_relationships.rs",
  "contact_relationship_add",
  "Gateway contact relationship routes must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_contact_profiles.rs",
  "contact_assign_profile",
  "Gateway named contact profile routes must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_model_routes.rs",
  "runtime_models",
  "Gateway runtime model/provider routes must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_project_graph_routes.rs",
  "project_graph_ensure",
  "Gateway project graph and integrity routes must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_capability_routing.rs",
  "gateway_capability_routing_owner_smoke",
  "Gateway capability routing must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_capability_registry.rs",
  "pub(crate) struct CapabilitySnapshotResponse",
  "Gateway capability snapshot DTOs must live with the capability registry owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_capability_registry.rs",
  "pub(crate) fn capability_snapshot_response",
  "Gateway capability snapshot read model must live with the capability registry owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_capability_registry.rs",
  "owner_projects_capability_snapshot_read_model",
  "Gateway capability snapshot owner must have a read-model smoke test",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_capability_registry.rs",
  "pub(crate) fn open_seeded_capability_registry",
  "Gateway capability registry bootstrap must live with the capability registry owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_capability_registry.rs",
  "owner_seeds_browser_provider_with_chat_browser_tools",
  "Gateway capability registry bootstrap must have owner-level coverage",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_browser_runtime.rs",
  "pub(crate) struct ComputerArtifactPreviewResponse",
  "Gateway local computer preview DTO must live with the browser runtime owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_browser_runtime.rs",
  "pub(crate) async fn local_computer_session",
  "Gateway local computer session route must live with the browser runtime owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_browser_runtime.rs",
  "owner_projects_local_computer_artifact_preview",
  "Gateway local computer preview owner must have read-model coverage",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_browser_runtime.rs",
  "pub(crate) struct ContainedComputerLiveResponse",
  "Gateway local computer live DTO must live with the browser runtime owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_browser_runtime.rs",
  "pub(crate) async fn contained_computer_live",
  "Gateway local computer live route must live with the browser runtime owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_browser_runtime.rs",
  "pub(crate) fn spawn_computer_live_publisher",
  "Gateway local computer live publisher must live with the browser runtime owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_browser_runtime.rs",
  "owner_projects_local_computer_live_readiness",
  "Gateway local computer live owner must have readiness coverage",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_system_status.rs",
  "pub(crate) struct SystemStatusResponse",
  "Gateway system status DTO must live with the system status owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_system_status.rs",
  "pub(crate) async fn system_status",
  "Gateway system status route must live with the system status owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_system_status.rs",
  "owner_parses_docker_memory_units",
  "Gateway system status owner must have Docker memory parsing coverage",
);
assertRepoNotContains(
  "crates/desktop-gateway/src/main.rs",
  "struct CapabilitySnapshotResponse",
  "Gateway main must not own capability snapshot DTOs",
);
assertRepoNotContains(
  "crates/desktop-gateway/src/main.rs",
  "fn capability_snapshot_response(",
  "Gateway main must not own capability snapshot read-model mapping",
);
assertRepoNotContains(
  "crates/desktop-gateway/src/main.rs",
  "fn open_seeded_capability_registry(",
  "Gateway main must not own capability registry bootstrap",
);
assertRepoNotContains(
  "crates/desktop-gateway/src/main.rs",
  "fn browser_registry_cached_tools(",
  "Gateway main must not own browser capability seed tools",
);
assertRepoNotContains(
  "crates/desktop-gateway/src/main.rs",
  "struct ComputerArtifactPreviewResponse",
  "Gateway main must not own local computer preview DTOs",
);
assertRepoNotContains(
  "crates/desktop-gateway/src/main.rs",
  "async fn local_computer_session",
  "Gateway main must not own local computer session route",
);
assertRepoNotContains(
  "crates/desktop-gateway/src/main.rs",
  "async fn local_computer_artifact_preview",
  "Gateway main must not own local computer artifact preview route",
);
assertRepoNotContains(
  "crates/desktop-gateway/src/main.rs",
  "struct ContainedComputerLiveResponse",
  "Gateway main must not own local computer live DTOs",
);
assertRepoNotContains(
  "crates/desktop-gateway/src/main.rs",
  "async fn contained_computer_live",
  "Gateway main must not own local computer live route",
);
assertRepoNotContains(
  "crates/desktop-gateway/src/main.rs",
  "struct SystemStatusResponse",
  "Gateway main must not own system status DTOs",
);
assertRepoNotContains(
  "crates/desktop-gateway/src/main.rs",
  "async fn system_status",
  "Gateway main must not own system status route",
);
assertRepoNotContains(
  "crates/desktop-gateway/src/main.rs",
  "fn spawn_computer_live_publisher",
  "Gateway main must not own local computer live publisher",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway model routes"',
  "Kernel regression gate must run the gateway model routes owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway project graph routes"',
  "Kernel regression gate must run the gateway project graph routes owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway capability routing"',
  "Kernel regression gate must run the gateway capability routing owner test",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_tools.rs",
  "record_decision",
  "Gateway memory tools must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_tools.rs",
  "memory_decide",
  "Gateway memory decide route must share the memory tools owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_plan_tools.rs",
  "step_advance_tool_schema",
  "Gateway plan tools must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_chat_markers.rs",
  "strip_chat_markers",
  "Gateway chat marker stripping must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_project_search_tools.rs",
  "query_code_graph",
  "Gateway project search tools must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_datetime_tools.rs",
  "resolve_datetime_tool_schema",
  "Gateway datetime tools must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_runtime_flags.rs",
  "plan_reconcile_on_delivery_flag",
  "Gateway runtime flags must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_prompt_instructions.rs",
  "booking_assumption_choice_instruction",
  "Gateway prompt instructions must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_automation_tools.rs",
  "create_automation_tool_schema",
  "Gateway automation tools must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_automation_formatting.rs",
  "automation_trigger_summary",
  "Gateway automation formatting must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_automation_requests.rs",
  "AutomationCreateRequest",
  "Gateway automation request DTOs must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_template_catalog.rs",
  "template_catalog_owner_smoke",
  "Gateway template catalog must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_project_files.rs",
  "project_files_owner_smoke",
  "Gateway project files must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_browser_tools.rs",
  "browser_tools_owner_smoke",
  "Gateway browser tools must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_main_tests.rs",
  "gateway_main_tests_owner_smoke",
  "Gateway root test module must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_goals.rs",
  "memory_project_briefing",
  "Gateway memory goals and project briefing routes must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_hygiene.rs",
  "memory_hygiene_suggestions",
  "Gateway memory hygiene route and suggestions must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_artifact_memory.rs",
  "register_artifact_memory",
  "Gateway artifact memory registration must have a dedicated owner",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_memory_wiki.rs",
  "memory_wiki_save",
  "Gateway memory wiki projections and routes must have a dedicated owner",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway main ownership contract"',
  "Kernel regression gate must run the gateway main ownership contract",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway recall context"',
  "Kernel regression gate must run the gateway recall context owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway proactivity"',
  "Kernel regression gate must run the gateway proactivity owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway task maintenance"',
  "Kernel regression gate must run the gateway task maintenance owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory background"',
  "Kernel regression gate must run the gateway memory background owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway remote approval"',
  "Kernel regression gate must run the gateway remote approval owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway plugins"',
  "Kernel regression gate must run the gateway plugin owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway plugin packages"',
  "Kernel regression gate must run the gateway plugin package owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway chat threads"',
  "Kernel regression gate must run the gateway chat thread owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway chat branches"',
  "Kernel regression gate must run the gateway chat branch owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway chat tasks"',
  "Kernel regression gate must run the gateway chat task owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway chat memory"',
  "Kernel regression gate must run the gateway chat memory owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory dedup"',
  "Kernel regression gate must run the gateway memory dedup owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory query embeddings"',
  "Kernel regression gate must run the gateway memory query embedding owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory briefing"',
  "Kernel regression gate must run the gateway memory briefing owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory turn context"',
  "Kernel regression gate must run the gateway memory turn context owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory clients"',
  "Kernel regression gate must run the gateway memory client owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory recall service"',
  "Kernel regression gate must run the gateway memory recall service owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory graph"',
  "Kernel regression gate must run the gateway memory graph owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory graph routes"',
  "Kernel regression gate must run the gateway memory graph routes owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory graph maintenance"',
  "Kernel regression gate must run the gateway memory graph maintenance owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory graph persistence"',
  "Kernel regression gate must run the gateway memory graph persistence owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory tools"',
  "Kernel regression gate must run the gateway memory tools owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway plan tools"',
  "Kernel regression gate must run the gateway plan tools owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway chat markers"',
  "Kernel regression gate must run the gateway chat marker owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway project search tools"',
  "Kernel regression gate must run the gateway project search tools owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway datetime tools"',
  "Kernel regression gate must run the gateway datetime tools owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway runtime flags"',
  "Kernel regression gate must run the gateway runtime flags owner test",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_runtime_settings.rs",
  "runtime_settings_owner_smoke",
  "Gateway runtime settings owner must keep a local smoke test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway runtime settings"',
  "Kernel regression gate must run the gateway runtime settings owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway prompt instructions"',
  "Kernel regression gate must run the gateway prompt instructions owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway automation tools"',
  "Kernel regression gate must run the gateway automation tools owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway automation formatting"',
  "Kernel regression gate must run the gateway automation formatting owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway automation requests"',
  "Kernel regression gate must run the gateway automation request owner test",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_automation_routes.rs",
  "automation_routes_owner_smoke",
  "Gateway automation route owner must keep a local smoke test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway automation routes"',
  "Kernel regression gate must run the gateway automation route owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway main tests owner"',
  "Kernel regression gate must run the gateway main test owner smoke",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway template catalog"',
  "Kernel regression gate must run the gateway template catalog owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway project files"',
  "Kernel regression gate must run the gateway project files owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway browser tools"',
  "Kernel regression gate must run the gateway browser tools owner test",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_browser_runtime.rs",
  "browser_runtime_owner_smoke",
  "Gateway browser runtime owner must keep a local smoke test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway browser runtime"',
  "Kernel regression gate must run the gateway browser runtime owner test",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_deliverables.rs",
  "deliverables_owner_smoke",
  "Gateway deliverables owner must keep a local smoke test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway deliverables"',
  "Kernel regression gate must run the gateway deliverables owner test",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_model_routing.rs",
  "model_routing_owner_smoke",
  "Gateway model routing owner must keep a local smoke test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway model routing"',
  "Kernel regression gate must run the gateway model routing owner test",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_tool_execution.rs",
  "tool_execution_owner_smoke",
  "Gateway tool execution owner must keep a local smoke test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway tool execution"',
  "Kernel regression gate must run the gateway tool execution owner test",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_channels.rs",
  "channels_owner_smoke",
  "Gateway channels owner must keep a local smoke test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway channels"',
  "Kernel regression gate must run the gateway channels owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory hygiene"',
  "Kernel regression gate must run the gateway memory hygiene owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway artifact memory"',
  "Kernel regression gate must run the gateway artifact memory owner test",
);
assertRepoContains(
  "crates/desktop-gateway/src/gateway_artifacts.rs",
  "artifacts_owner_smoke",
  "Gateway artifact file owner must keep a local smoke test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway artifacts"',
  "Kernel regression gate must run the gateway artifact file owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway memory wiki"',
  "Kernel regression gate must run the gateway memory wiki owner test",
);
assertRepoContains(
  "scripts/kernel_regression_gate.py",
  '"gateway background startup"',
  "Kernel regression gate must run the gateway background startup owner test",
);
assertContains("src/lib/coreBridge.ts", "usageDaily:", "Usage must expose the real daily series");
assertContains("src/components/UsageCalendar.tsx", 'role="grid"', "Usage calendar must expose an accessible grid");
assertContains("src/components/UsageCalendar.tsx", 'role="gridcell"', "Usage days must be keyboard reachable");
assertContains("src/components/UsageCalendar.tsx", "onFocus", "Keyboard focus must reveal day details");
assertContains("src/components/UsageCalendar.tsx", "dominant_provider", "Usage callouts must preserve provider provenance");
assertNotContains("src/components/ChatView.tsx", "chat-hero-mark", "New chat must not keep the decorative brandmark");
assertNotContains("src/components/ChatView.tsx", "chat.emptyHeroSub", "New chat must not keep the fixed subtitle");
assertContains(
  "src/lib/coreBridge.ts",
  "uncertain_effects: CoreUncertainEffect[];",
  "The task queue must carry the canonical uncertain-effect projection",
);
assertContains(
  "src/lib/coreBridge.ts",
  "/api/effects/${encodeURIComponent(effect.receipt_ref)}/resolve",
  "Uncertain effects must use the existing canonical resolver endpoint",
);
assertContains(
  "src/lib/coreBridge.ts",
  'type: "applied" as const',
  "Manual verification must submit the canonical applied resolution",
);
assertContains(
  "src/lib/coreBridge.ts",
  'type: "not_applied" as const',
  "Manual verification must submit the canonical not-applied resolution",
);
assertContains(
  "src/components/InlineUncertainEffectPanel.tsx",
  "export function InlineUncertainEffectPanel",
  "Uncertain effects must be resolved in their owning conversation",
);
assertContains(
  "src/components/ChatTranscript.tsx",
  "<InlineUncertainEffectPanel",
  "ChatTranscript must delegate uncertain-effect resolution into the conversation surface",
);
assertContains(
  "src/components/ChatView.tsx",
  "<ChatTranscript",
  "ChatView must delegate transcript rendering into the transcript owner",
);
assertContains(
  "src/lib/useTaskQueueController.ts",
  "await coreBridge.resolveUncertainEffect(effect.core, outcome);",
  "Resolution must complete before refreshing canonical read models",
);
assertContains(
  "src/lib/useTaskQueueController.ts",
  "await loadTaskQueue();",
  "Resolution must refresh the canonical task queue",
);
assertMatches(
  "src/lib/useTaskQueueController.ts",
  /if \(effect\.threadId\) \{\s*await refreshChatReadModels\(effect\.threadId\);\s*\}/,
  "Resolution must refresh its related thread without navigating",
);
assertNotContains(
  "src/App.tsx",
  "setUncertainEffectItems((current) => current.filter",
  "Resolution must not optimistically remove an uncertain receipt",
);
assertMissing(
  "src/components/TasksView.tsx",
  "The task runtime must not create a separate user-facing workspace",
);
assertNotContains(
  "src/App.tsx",
  'activeView === "tasks"',
  "Tasks must not remain a desktop route",
);
assertContains(
  "src/components/InlineUncertainEffectPanel.tsx",
  'className="uncertain-effect-card"',
  "The owning conversation must render uncertain effects separately from approvals",
);
assertContains(
  "src/components/InlineUncertainEffectPanel.tsx",
  't("chat.verifiedApplied")',
  "The conversation must expose the verified-applied command",
);
assertContains(
  "src/components/InlineUncertainEffectPanel.tsx",
  't("chat.verifiedNotApplied")',
  "The conversation must expose the verified-not-applied command",
);
assertContains(
  "src/components/InlineUncertainEffectPanel.tsx",
  "busyId === effect.id",
  "Both uncertain-effect actions must share one in-flight guard",
);
assertNotContains(
  "src/components/ChatView.tsx",
  "JSON.stringify(effect.core.evidence",
  "Raw uncertain-effect evidence must not be rendered",
);
assertContains("src/components/ChatEmptyHero.tsx", "selectGreetingKey", "New chat must select a stable curated greeting");
assertContains("src/components/ChatEmptyHero.tsx", "chat-hero-headline", "New chat must render the primary greeting separately");
assertContains("src/components/ChatEmptyHero.tsx", "chat-hero-prompt", "New chat must render the rotating prompt as secondary typography");
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
assertContains("src/styles/workspace-island.css", "background: var(--surface);", "Adaptive workspace surfaces must inherit the active theme");
assertContains("src/components/ChatWorkspaceDock.tsx", "<AdaptiveWorkspaceIsland", "Chat must delegate factual sections to the adaptive island");
assertContains("src/components/ChatView.tsx", "<ChatWorkspaceDock", "Chat must mount the workspace dock owner");
assertNotContains("src/components/ChatView.tsx", "chat-status-stack", "The persistent status stack must stay retired");
assertNotContains("src/styles.css", ".chat-status-stack", "Legacy status-stack geometry must stay retired");
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
assertContains("src/components/ChatTopbar.tsx", "task-collapsed-controls", "collapsed sidebar's reopen + search must live in the chat header (no-drag), not a fixed overlay");
assertContains("src/components/ChatTopbar.tsx", "onExpandSidebar", "collapsed sidebar's in-header opener must reopen the drawer");
assertNotContains("src/components/Shell.tsx", "transientDrawerOpen", "collapsed sidebar must not maintain hover-open transient drawer state");
assertContains("src/styles/sidebar.css", "--drawer-island-gap", "sidebar must be laid out as a floating island with stable margins");
assertContains("src/styles.css", ".window-chrome", "custom window chrome must own the top drag/header strip");
assertNotContains("src/styles.css", ".window-light", "custom window chrome must not draw fake traffic lights");
assertContains("src/styles.css", "pointer-events: none", "custom window chrome wrapper must not sit as a click-blocking overlay");
assertContains("src/styles.css", ".window-drag-strip", "custom window chrome must use explicit drag strips instead of dragging over controls");
assertContains("src/styles.css", ".task-collapsed-controls", "collapsed reopen/search controls styled in the chat header");
assertContains("src/styles.css", ".task-collapsed-action svg", "sidebar toggle icon must not intercept pointer events from the button");
assertContains("src/styles/sidebar.css", ".app-shell.drawer-open > .nav-drawer", "open sidebar and Settings nav must use the same island styling");
assertContains("src/components/Sidebar.tsx", "drawer-titlebar-action", "expanded sidebar toggle + search must live in the top titlebar row");
assertNotContains("src/components/Sidebar.tsx", "drawer-new-action", "sidebar search row must not include a global new-chat plus button");
assertNotContains("src/components/Sidebar.tsx", "the gear becomes a back-to-app arrow", "Settings nav must not keep a duplicate footer back action");
assertContains("src/styles/sidebar.css", "overflow-x: hidden;\n  overflow-y: auto;", "expanded project trees must scroll inside the sidebar middle region instead of covering footer actions");
assertContains("src/styles/sidebar.css", ".drawer-scroll::-webkit-scrollbar", "sidebar middle scrollbars must stay visually minimal");
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
assertContains("src/components/ChatView.tsx", "onMemoryPublicationApproved={refreshAfterChatSubmit}", "successful publication refresh must be passed from the transcript owner");
assertContains("src/components/MessageMetaCopy.tsx", "onPublicationApproved={onMemoryPublicationApproved}", "successful publication must refresh persisted task data");
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
assertContains("src/lib/useChatThreadCreation.ts", "summarizeThreadTitle", "frontend optimistic chat titles must be synthesized, not first-prompt slices");
assertContains("src/lib/useChatReadModelController.ts", "advanceActivity === true", "chat preview ordering must advance only from explicit completed assistant turns");
assertNotContains("src/App.tsx", "nextActivityMessageCount > thread.messageCount", "opening/loading an existing chat must not infer new activity from message count");
assertContains("src/components/useChatTurnSubmission.ts", "onMessagesChange(promptMessages)", "chat title must update as soon as the user prompt is accepted");
assertContains("src/components/useChatTurnSubmission.ts", "advanceActivity: true", "completed assistant turns must explicitly advance chat activity ordering");
assertContains("src/components/useChatTurnSubmission.ts", "const shouldAutoTitleAfterSubmit = isPlaceholderThreadTitle(thread.title)", "auto-title must be authorized only by a real submitted turn, not by opening a historical chat");
assertContains("src/components/useChatTurnSubmission.ts", "persistAutoTitleForCompletedTurn(", "auto-title must persist from the completed chat stream path");
assertContains("src/components/useChatAutoTitle.ts", "coreBridge.autoTitleThread", "auto-title persistence must have one focused owner");
assertNotContains("src/components/ChatView.tsx", "coreBridge.autoTitleThread", "ChatView must not own auto-title persistence");
assertNotContains("src/components/ChatView.tsx", "titledThreadsRef", "ChatView must not own auto-title dedupe state");
assertContains("src/components/useChatMessageEditing.ts", "export function useChatMessageEditing", "message editing must have one focused owner");
assertContains("src/components/useChatMessageEditing.ts", "submitEditedPrompt(", "message editing owner must submit edited turns through the provided gateway path");
assertContains("src/components/useChatMessageEditing.ts", "setOptimisticMessages(base)", "message editing owner must preserve sibling-branch optimistic context");
assertContains("src/components/ChatView.tsx", "useChatMessageEditing({", "ChatView must consume the focused message editing owner");
assertNotContains("src/components/ChatView.tsx", "const [editingMessageId, setEditingMessageId]", "ChatView must not own message editing selected state");
assertNotContains("src/components/ChatView.tsx", "const [editingText, setEditingText]", "ChatView must not own message editing draft state");
assertNotContains("src/components/ChatView.tsx", "function startEditMessage", "ChatView must not own message editing start handler");
assertNotContains("src/components/ChatView.tsx", "function cancelEditMessage", "ChatView must not own message editing cancel handler");
assertNotContains("src/components/ChatView.tsx", "function saveEditedMessage", "ChatView must not own message editing branch submit handler");
assertContains("src/components/useChatMessageActions.ts", "export function useChatMessageActions", "message actions must have one focused owner");
assertContains("src/components/useChatMessageActions.ts", "copyText(", "message copy must have one focused owner");
assertContains("src/components/useChatMessageActions.ts", "captureAppScreenshot(", "chat screenshot capture must have one focused owner");
assertContains("src/components/useChatMessageActions.ts", "coreBridge.setChatMessageFeedback", "message feedback persistence must have one focused owner");
assertContains("src/components/useChatMessageActions.ts", "coreBridge.saveChatMessageToMemory", "message memory saving must have one focused owner");
assertContains("src/components/ChatView.tsx", "useChatMessageActions({", "ChatView must consume the focused message action owner");
assertNotContains("src/components/ChatView.tsx", "const [copiedMessageId, setCopiedMessageId]", "ChatView must not own message copy state");
assertNotContains("src/components/ChatView.tsx", "function copyMessageText", "ChatView must not own message copy action");
assertNotContains("src/components/ChatView.tsx", "function exportChatMarkdown", "ChatView must not keep unused chat markdown export action");
assertNotContains("src/components/ChatView.tsx", "function captureScreenshot", "ChatView must not own screenshot capture action");
assertNotContains("src/components/ChatView.tsx", "function setMessageFeedback", "ChatView must not own feedback persistence action");
assertNotContains("src/components/ChatView.tsx", "function saveMessageAsGoal", "ChatView must not own goal handoff action");
assertNotContains("src/components/ChatView.tsx", "function saveMessageToMemory", "ChatView must not own memory save action");
assertNotContains("src/components/ChatView.tsx", "copyText(", "ChatView must not own clipboard writes");
assertNotContains("src/components/ChatView.tsx", "buildChatMarkdown", "ChatView must not keep unused chat markdown export imports");
assertNotContains("src/components/ChatView.tsx", "captureAppScreenshot(", "ChatView must not own screenshot capture bridge call");
assertRepoContains("crates/desktop-gateway/src/main.rs", "is_placeholder_chat_title(&thread.title)", "autotitle endpoint must be a no-op for already titled chats");
assertRepoContains("crates/desktop-gateway/src/main.rs", "\"type\": \"thread.turn_started\"", "external turns must publish a visible-turn event after messages are persisted");
assertRepoContains("crates/desktop-gateway/src/main.rs", "start_visible_conversation_turn", "external channels and scheduled work must use the shared visible-turn helper");
assertRepoContains("crates/desktop-gateway/src/main.rs", "\"approval\"", "remote approval continuations must identify their visible-turn source");
assertRepoContains("crates/desktop-gateway/src/main.rs", "approval_continuation_visible_text", "remote approval continuations must create an explicit visible user bubble");
assertNotContains("src/App.tsx", "runAgentTurnHeadless", "frontend must not expose a headless agent-turn path");
assertRepoNotContains("crates/desktop-gateway/src/main.rs", "async fn run_agent_turn(", "backend must not keep a headless agent-turn helper that can bypass visible placeholders");
assertRepoContains("crates/desktop-gateway/src/main.rs", "run_agent_turn_into_message", "backend agent turns must stream into persisted assistant messages");
assertRepoContains("crates/desktop-gateway/src/main.rs", "OPERATIONAL PLAN: for a non-trivial MULTI-STEP task, call update_plan and then continue executing", "chat loop must maintain the canonical plan through update_plan and continue in the same turn");
assertNotContains("src/App.tsx", "pendingEventThreadIdsRef", "background event refresh must not depend on a navigation race window");
assertContains("src/App.tsx", "refreshThreadInBackground", "background events must refresh their own durable cache");
assertContains("src/lib/useAppEventSubscription.ts", "event.type === \"thread.turn_started\"", "desktop client must handle visible turn start events");
assertContains("src/lib/coreBridge.ts", "assistant_message_id?: string", "app event contract must expose persisted assistant message ids");
assertContains("src/components/useChatTurnSubmission.ts", "normalizeChatEventParts(result.assistant_message.event_parts)", "completed chat turns must normalize structured event parts from the gateway result");
assertContains("src/lib/chatViewMessages.ts", "eventParts,", "completed chat turns must preserve structured event parts in the assistant message builder");
assertContains("src/lib/chatApi.ts", "export async function cancelTurn(", "chat cancellation must call the broker cancel_turn endpoint (DELETE /turns/{id})");
assertContains("src/lib/coreBridge.ts", "await cancelTurn(turnId);", "Stop must cancel the running turn on the broker via DELETE, not a client-side socket close");
assertContains("src/lib/coreBridge.ts", "serverTurnIdByRequestId.get(requestId) ?? `turn_${requestId}`", "Stop must prefer the server-assigned turn id (resume keeps the existing execution id) and only fall back to the request-derived one");
assertContains("src/lib/chatApi.ts", "console.warn", "cancelTurn must surface non-2xx responses instead of swallowing them silently");
assertContains("src/plugins/registry.tsx", "navSection?: \"work\" | \"create\" | \"workspace\" | \"more\"", "plugin manifest must declare sidebar placement by operational role");
assertContains("src/plugins/presentations/index.tsx", "navSection: \"create\"", "presentations addon must be promoted into the create section");
assertContains("src/plugins/proattivita/index.tsx", "navSection: \"work\"", "proactivity addon must be promoted into the work section");
assertContains("src/components/ChatTopbar.tsx", "{sidebarCollapsed && (", "chat header must render the reopen/search controls when the sidebar is collapsed");
assertContains("src/components/Shell.tsx", "{drawerOpen && !isSettings && (", "main drawer must render when open");
assertContains("src/components/Sidebar.tsx", "drawer-profile", "open drawer footer must show the user profile + settings");
assertContains("src/components/ComposerShell.tsx", "composer-surface", "prompt composer must have a stable anchored surface");
assertContains("src/components/ComputerDetailPanel.tsx", "export function ComputerDetailPanel", "active task must expose local computer activity through the inspector");
assertNotContains("src/components/ChatView.tsx", "timelineCollapsed", "retired computer timeline state must stay out of ChatView");
assertContains("src/components/ChatView.tsx", 'view.key === "computer"', "local computer activity must remain discoverable as an inspector view");
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
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "build_gateway_router", "Gateway route assembly must stay in its dedicated owner");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/api/vault/records", "Gateway must expose Vault record listing");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/api/vault/records/{id}", "Gateway must expose Vault record deletion");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/api/vault/records/{id}/reveal", "Gateway must expose PIN-gated Vault record reveal");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "patch(vault_record_update)", "Gateway must expose metadata-only Vault record editing");
assertContains("src/components/SettingsView.tsx", "t(\"settings.vaultEncrypted\")", "Vault status badge must use translations");
assertContains("src/i18n/locales/it.json", "\"vaultEncrypted\": \"Cifrato\"", "Italian locale must translate the Vault encrypted badge");
assertContains("src/i18n/locales/en.json", "\"vaultEncrypted\": \"Encrypted\"", "English locale must translate the Vault encrypted badge");
assertContains("src/data/mockData.ts", "label: \"settings.vault\"", "Settings sidebar Vault label must use i18n");
assertContains("src/data/mockData.ts", "label: \"settings.computer.title\"", "Settings sidebar Computer label must use i18n");
assertContains("src/lib/coreBridge.ts", "secret_value?: string", "Vault bridge must expose optional raw secret material only for the encrypted accept path");
assertContains("src/components/ChatComputerPanel.tsx", "const browserRunning = Boolean(live?.active && live?.novnc_url)", "live computer browser state must distinguish running activity from idle availability");
assertContains("src/components/ChatComputerPanel.tsx", "view_only=1&viewer=csp-external-v1", "chat computer must invalidate the CSP-blocked inline viewer cached by older desktop releases");
assertOccurrences("src/components/ChatComposerDock.tsx", "<ActiveTurnStatus", 1, "active turn status must have one canonical composer mount");
assertNotContains("src/components/ChatView.tsx", "<ActiveTurnStatus", "ChatView must not remount active turn status outside the composer dock");
assertNotContains("src/components/ChatView.tsx", 'variant="assistant-footer"', "active turn status must not duplicate inside the transcript");
assertContains(
  "src/components/ChatView.tsx",
  "showPendingAssistant={promptSubmitting && !streamingAssistantId && !chatTurnState}",
  "durable active turn status must suppress the duplicate transcript thinking state",
);
assertContains("src/components/ActiveTurnStatus.tsx", 't("chat.inspector.views.activity")', "active turn activity action must use the valid localized inspector key");
assertContains("src/components/PendingSteeringQueue.tsx", "pending-steering-strip", "queued steering must render as a compact request strip");
assertContains("src/lib/coreBridge.ts", "SteeringQueuedDuringSubmissionError", "a submit/steering race must have a typed benign outcome");
assertContains("src/components/useChatTurnSubmission.ts", "error instanceof SteeringQueuedDuringSubmissionError", "the submit/steering race must clear optimistic UI instead of rendering an error");
assertNotContains("src/lib/coreBridge.ts", "Instruction queued on the active task; no second stream was started.", "successful steering must not be represented by a user-visible error");
assertContains("src/components/SettingsView.tsx", "catalogDisplayIdentity(target)", "skill preview must preserve the publisher-qualified target while loading or failing");
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
assertContains("src/components/InlineApprovelPanel.tsx", "approval-scope-options", "approval UI must make temporary vs fixed scope explicit");
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
assertContains("src/App.tsx", "useAutomationController", "App must delegate automation read/actions to the automation controller");
assertNotContains("src/App.tsx", "coreBridge.automations", "App must not own automation dashboard fetching directly");
assertContains("src/App.tsx", "useCapabilityController", "App must delegate capability read model loading to the capability controller");
assertNotContains("src/App.tsx", "coreBridge.capabilities", "App must not own capability fetching directly");
assertContains("src/App.tsx", "useOnboardingSetupGate", "App must delegate onboarding setup checks to the setup gate hook");
assertContains("src/App.tsx", "usePluginController", "App must delegate plugin state loading to the plugin controller");
assertContains("src/App.tsx", "usePluginHostController", "App must delegate plugin host composition to the plugin host controller");
assertContains("src/App.tsx", "useResponsiveDrawer", "App must delegate responsive drawer state to the drawer hook");
assertContains("src/App.tsx", "useTaskQueueController", "App must delegate task queue state and approvals to the task queue controller");
assertContains("src/App.tsx", "useBackgroundStreams", "App must delegate active stream polling to the background streams hook");
assertContains("src/App.tsx", "useAppNavigation", "App must delegate shell navigation/search state to the navigation hook");
assertContains("src/App.tsx", "useThreadAttentionController", "App must delegate thread attention state to the attention controller");
assertContains("src/App.tsx", "useThreadAttentionNotifications", "App must delegate thread attention notifications to the notification hook");
assertContains("src/App.tsx", "useOperationalReadModelPoller", "App must delegate operational read model polling to the poller hook");
assertContains("src/App.tsx", "useAppEventSubscription", "App must delegate app-event websocket subscription to the subscription hook");
assertContains("src/App.tsx", "useInitialChatThreadsLoader", "App must delegate initial chat snapshot loading to the loader hook");
assertContains("src/App.tsx", "useChatThreadMutations", "App must delegate chat thread mutations to the mutation hook");
assertContains("src/App.tsx", "useChatThreadCreation", "App must delegate chat creation workflows to the creation hook");
assertContains("src/App.tsx", "useChatReadModelController", "App must delegate chat read-model lifecycle to the read-model controller");
assertNotContains("src/App.tsx", "coreBridge.setupStatus", "App must not own setup status fetching directly");
assertNotContains("src/App.tsx", "coreBridge.plugins()", "App must not own plugin state fetching directly");
assertNotContains("src/App.tsx", "pluginRegistry", "App must not own plugin registry composition directly");
assertNotContains("src/App.tsx", "composePluginNavItems", "App must not own plugin nav composition directly");
assertNotContains("src/App.tsx", "coreBridge.activeStreams", "App must not own active stream polling directly");
assertNotContains("src/App.tsx", "coreBridge.markThreadSeen", "App must not own thread seen mutations directly");
assertNotContains("src/App.tsx", "hydrateThreadAttentionState", "App must not own thread attention hydration directly");
assertNotContains("src/App.tsx", "projectConversationAttention", "App must not own thread attention projection directly");
assertNotContains("src/App.tsx", "showSystemNotification", "App must not own attention notification dispatch directly");
assertNotContains("src/App.tsx", "notifiedAttentionThreadIdsRef", "App must not own attention notification dedupe state directly");
assertNotContains("src/App.tsx", "operational_read_models_poll unavailable", "App must not own operational read model polling directly");
assertNotContains("src/App.tsx", "appEventHandlerRef", "App must not own app-event websocket dispatch directly");
assertNotContains("src/App.tsx", "wsSubscription", "App must not own websocket subscription directly");
assertNotContains("src/App.tsx", "chat_thread_snapshot unavailable", "App must not own initial chat snapshot loading directly");
assertNotContains("src/App.tsx", "coreBridge.setChatThreadPinned", "App must not own chat thread pin mutations directly");
assertNotContains("src/App.tsx", "coreBridge.archiveChatThread", "App must not own chat thread archive mutations directly");
assertNotContains("src/App.tsx", "coreBridge.unarchiveChatThread", "App must not own chat thread unarchive mutations directly");
assertNotContains("src/App.tsx", "coreBridge.deleteChatThread", "App must not own chat thread delete mutations directly");
assertNotContains("src/App.tsx", "create_chat_thread unavailable", "App must not own chat thread creation directly");
assertNotContains("src/App.tsx", "coreBridge.selectChatThread", "App must not own chat thread selection directly");
assertNotContains("src/App.tsx", "coreBridge.chatMessages", "App must not own chat message fetching directly");
assertNotContains("src/App.tsx", "coreBridge.chatThreads", "App must not own chat thread read-model fetching directly");
assertNotContains("src/App.tsx", "reconcileChatMessages", "App must not own backend message reconciliation directly");
assertNotContains("src/App.tsx", "updateThreadPreview", "App must not own chat preview mutation directly");
assertNotContains("src/App.tsx", "useState<ViewId>", "App must not own shell view state directly");
assertNotContains("src/App.tsx", "setSearchOpen", "App must not own search modal state directly");
assertNotContains("src/App.tsx", "coreBridge.taskQueue", "App must not own task queue fetching directly");
assertNotContains("src/App.tsx", "coreBridge.approveApprovel", "App must not own approval mutations directly");
assertNotContains("src/App.tsx", "coreBridge.resolveUncertainEffect", "App must not own uncertain effect resolution directly");
assertNotContains("src/App.tsx", "window.innerWidth > 1024", "App must not own responsive drawer viewport logic directly");
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
assertContains("src/lib/useChatThreadCreation.ts", "handleStartTemplateWorkflow", "Chat creation hook must own the template workflow chat creation path");
assertContains("src/lib/templateWorkflowPrompt.mjs", "template_ref=", "template workflow prompt must preserve the canonical template reference");
assertContains("src/lib/templateWorkflowPrompt.mjs", "Do not generate the deck yet.", "template workflow must start with discovery and planning, not immediate deck generation");
assertContains("src/lib/templateWorkflowPrompt.mjs", "make_document", "document packs must route to make_document from Use template");
assertNotContains("src/App.tsx", "Aiutami a creare una presentazione", "template workflow default visible prompt must remain English");
// S2 T6: Use template builds a deterministic routing binding (the creation hook uses the
// camelCase field per TS convention; the wire-format lock below on chatApi.ts guards
// the literal `routing_binding` key the Rust gateway's EnqueueTurnRequest reads).
assertContains("src/lib/useChatThreadCreation.ts", "routingBinding", "Use template must build a deterministic routing binding");
assertContains("src/lib/templateWorkflowPrompt.mjs", "presentations.template_deck", "Use template must route presentation templates to the deck workflow");
assertContains("src/lib/templateWorkflowPrompt.mjs", "presentations.template_document", "Use template must route document templates to the document workflow");
assertContains("src/lib/coreBridge.ts", "importPptxTemplate", "Desktop bridge must expose PPTX template import");
assertContains("src/lib/coreBridge.ts", "templateSourceAttachment", "Desktop bridge must resolve local template attachments without exposing paths in the catalog");
assertContains("src/lib/coreBridge.ts", "attachments?: CoreChatAttachment[]", "streamed prompt commits must be able to preserve user attachments");

assertContains("src/components/useChatTurnSubmission.ts", "coreBridge.submitChatPromptStream", "composer must submit prompts through the local chat transport");
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
assertContains("src/components/ChatMessageMarkerParser.ts", "PAYMENT_APPROVAL_RE", "Chat must parse Payment Approval Card markers");
assertContains("src/components/MessagePaymentApprovalCard.tsx", "coreBridge.vaultPaymentApprovalApprove", "Payment Approval Card must verify PIN/CVV through the bridge");
assertContains("src/components/AssistantMessageBody.tsx", "messageId={messageId}", "Payment Approval Card must receive the source message id for transcript rewrite");
assertContains("src/lib/coreBridge.ts", "message_id: ctx.messageId", "Payment approvals must include source message id when available");
assertContains("src/data/mockData.ts", "id: \"vault\"", "Vault must be a separate Settings section");
assertContains("src/data/mockData.ts", "id: \"sandbox\"", "Sandbox must be a separate Settings section");
assertContains("src/components/SettingsView.tsx", "<SandboxSettingsView />", "Settings must render the dedicated Sandbox pane");
assertContains("src/lib/coreBridge.ts", "/policy`", "coreBridge must POST per-workspace sandbox/approval overrides");
assertContains("src/components/SettingsView.tsx", "coreBridge.vaultPinSetup", "Vault Settings must configure the local PIN through the bridge");
assertContains("src/components/MessageVaultProposeCard.tsx", "coreBridge.vaultProposalAccept", "Vault proposal card must expose an accept action");
assertContains("src/components/MessageVaultProposeCard.tsx", "Save to Vault", "Vault proposal card must offer an explicit save action");
assertContains("src/components/MemoryView.tsx", "coreBridge.memoryDashboard", "desktop memory page must own the gateway memory dashboard read model");
assertContains("src/lib/useCapabilityController.ts", "mapCoreCapabilitySnapshot", "desktop connections page must map the gateway capability read model");
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
assertContains("src/lib/chatApi.ts", "publishedStreamSequences.accept(payload)", "chat streaming must deduplicate sequenced publication before listener side effects");
assertContains("src/components/useChatTurnSubmission.ts", "handledBackgroundTurnsRef.current.add(localTurnId)", "locally started turns must be claimed before background attachment can race");
assertContains("src/components/useChatTurnSubmission.ts", "streamOwnerTurnRef.current = localTurnId", "a local turn must have one visible stream owner");
assertContains("src/lib/chatApi.ts", "/create_task", "chat message task actions must call the local gateway");
assertNotContains("src/lib/coreBridge.ts", "invoke<", "frontend bridge must not call removed native invoke");
assertNotContains("src/lib/coreBridge.ts", removedShellGlobal, "frontend bridge must not inspect removed shell globals");
assertNotContains("src/lib/chatApi.ts", removedShellPackageScope, "chat API must not import removed shell packages");

assertContains("src/components/RichMessage.tsx", "lazy(() => import(\"./RichMessageRenderer\")", "rich markdown renderer must be lazy loaded");
assertContains("src/components/RichMessage.tsx", "memo(function RichMessage", "rich markdown messages must be memoized to avoid rerendering completed chat history");
assertContains("src/components/RichMessage.tsx", "streaming={streaming}", "streaming messages must render live through the streaming-aware renderer");
assertContains("src/components/RichMessageRenderer.tsx", "export default memo(RichMessageRenderer)", "rich markdown renderer must be memoized after lazy load");
assertContains("src/components/RichMessageRenderer.tsx", "repairNestedMarkdownFences", "rich renderer must repair duplicated fenced code openers from local model output");
assertContains("src/components/ChatTranscript.tsx", "threadMessages.map", "chat transcript must use normal document flow in Electron");
assertContains("src/styles.css", ".thread-message-list", "chat transcript must stack rows in normal flow");
assertContains("src/styles.css", ".thread-message-row", "chat transcript rows must not be absolutely positioned");
assertNotContains("src/components/ChatView.tsx", "useVirtualizer", "chat transcript must not use old Tauri-era virtualization in the base Electron path");
assertNotContains("src/styles.css", ".virtual-message-row", "chat transcript must not use absolute virtual rows in the base Electron path");
assertContains("src/components/useChatConversationScroll.ts", "streamingFrameRef", "chat streaming must throttle visible updates in Electron");
assertContains("src/components/ChatView.tsx", "setOptimisticMessages", "chat streaming must keep visible text in the React message state");
assertContains("src/components/ChatMessageContent.tsx", "<AssistantMessageBody", "streaming answers must render through the normal message body component");
assertContains("src/components/useChatActivityProjection.ts", "projectedView.browserStatus.failureReason", "browser budget UI must use typed kernel failure reason");
assertNotContains("src/components/useChatActivityProjection.ts", "browser_budget_exceeded", "browser budget marker text must not be parsed in the renderer");
assertContains("src/components/ChatView.tsx", "runtimeViewModel", "ChatView must consume the kernel runtime view model");
assertContains("src/components/ChatView.tsx", "runtimeViewModel.turnUiState", "ChatView lifecycle must come from the runtime view model");
assertContains("src/components/useChatTurnSubmission.ts", "composerMode", "composer submission must receive kernel composer mode");
assertContains("src/lib/chat-runtime/submissionRouting.mjs", "composerModeFromKernel", "submission routing must normalize kernel composer modes");
assertNotContains("src/components/ChatView.tsx", "../lib/markers", "ChatView must not import marker parsing");
assertNotContains("src/components/ChatView.tsx", "latestPlanMarkdown", "ChatView must not read plan marker text directly");
assertNotContains("src/components/ChatView.tsx", "browser_budget_exceeded", "ChatView must not parse browser budget marker text");
assertNotContains("src/components/useChatActivityProjection.ts", 'status === "doing" ? { ...step, status: "done"', "lifecycle code must not auto-complete doing plan steps");
assertContains("src/i18n/locales/it.json", "Tempo massimo del browser raggiunto", "browser timeout is localized");
assertMatches(
  "src/components/ChatMessageContent.tsx",
  /isStreaming\) \{[\s\S]*?<AssistantMessageBody[\s\S]*?\n\s+streaming\n[\s\S]*?\)/m,
  "streaming answers must keep rich markdown/progress parsing enabled while streaming",
);
assertContains("src/components/ChatView.tsx", "workspacePlanSteps", "adaptive activity must derive progress from the durable plan projection");
assertContains("src/components/ChatView.tsx", "projectWorkspaceSections({", "island visibility must use the pure factual projection");
assertContains("src/lib/chat-runtime/browserActivityLifecycle.mjs", "snapshotVerified: Boolean(previewDataUrl)", "inactive browser visibility requires a verified preview");
assertContains("src/components/ChatWorkspaceDock.tsx", "openSectionRequest={{ section: \"activity\", nonce: openActivityNonce }}", "Activity actions must target the adaptive activity section");
assertContains("src/components/AdaptiveWorkspaceIsland.tsx", "useState<WorkspaceSectionId | null>(null)", "adaptive island must be collapsed by default");
assertContains("src/components/AdaptiveWorkspaceIsland.tsx", "setActiveSection(null);\n  }, [threadId]);", "adaptive island state must reset per thread");
assertContains("src/components/AdaptiveWorkspaceIsland.tsx", "role=\"region\"", "adaptive content must expose region semantics");
assertContains("src/components/AdaptiveWorkspaceIsland.tsx", "aria-pressed={activeSection === section.id}", "rail buttons must expose their selected section");
assertContains("src/lib/workspaceIslandSections.mjs", "const sections = [];", "workspace capabilities must be projected from factual input");
assertNotContains("src/lib/workspaceIslandSections.mjs", 'id: "terminal"', "terminal must not appear before the capability exists");
assertNotContains("src/components/ChatView.tsx", "<WorkspaceIsland ", "legacy workspace island must stay retired");
assertNotContains("src/components/ChatView.tsx", "<WorkspaceIsland\n", "legacy workspace island must stay retired");
assertNotContains("src/styles.css", ".workspace-island-panel", "legacy island panel geometry must stay retired");
// Task 5: the rows dropped from the island (artifacts/files/activity) resurface behind
// a header kebab menu that reopens the docked Workbench on the right tab.
assertContains(
  "src/components/ChatTopbar.tsx",
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
assertContains("src/components/ChatView.tsx", "disabled={inspector.open}", "the adaptive island must yield to the inspector column");
assertContains("src/styles.css", "--workspace-current-reserve: 0px;", "the inspector column must clear the adaptive island reserve");
assertNotContains("src/styles.css", ".workbench {\n  position: absolute", "legacy workbench must not float above the chat");
assertContains("src/components/useChatInspectorWorkspace.ts", "inspectorWorkspaceReducer", "inspector workspace must have one focused owner");
assertContains("src/components/useChatInspectorWorkspace.ts", "loadInspectorState", "inspector restore must have one focused owner");
assertContains("src/components/useChatInspectorWorkspace.ts", "saveInspectorState(threadId", "inspector state changes must persist by thread");
assertContains("src/components/useChatInspectorWorkspace.ts", "Promise.all(restored.tabs.map", "restored resource tabs must be revalidated as one batch");
assertContains("src/components/useChatInspectorWorkspace.ts", "filterInspectorState", "inspector authorization filtering must have one focused owner");
assertContains("src/components/useChatInspectorWorkspace.ts", "coreBridge.fsFile", "inspector resource authorization must have one focused owner");
assertContains("src/components/ChatView.tsx", "useChatInspectorWorkspace({", "ChatView must consume the focused inspector workspace owner");
assertNotContains("src/components/ChatView.tsx", "inspectorWorkspaceReducer", "ChatView must not own inspector reducer");
assertNotContains("src/components/ChatView.tsx", "loadInspectorState", "ChatView must not own inspector restore");
assertNotContains("src/components/ChatView.tsx", "filterInspectorState", "ChatView must not own inspector filtering");
assertNotContains("src/components/ChatView.tsx", "coreBridge.fsFile", "ChatView must not own inspector resource authorization");
assertContains("src/components/InspectorView.tsx", "coreBridge.fsFile(path, threadId)", "restored file tabs must recheck current authorization");
assertContains("src/components/ChatView.tsx", "inspectorResourcesReady", "restored resources must stay hidden until validation completes");
assertContains("src/components/useChatMemoryArtifacts.ts", "reconcileMemoryArtifacts", "artifact polling must preserve an unchanged catalog");
assertContains("src/components/ChatView.tsx", "useChatMemoryArtifacts(thread.threadId, messages)", "ChatView must consume the focused artifact catalog owner");
assertNotContains("src/components/ChatView.tsx", "coreBridge.memoryArtifacts", "ChatView must not own artifact catalog loading");
assertNotContains("src/components/ChatView.tsx", "setMemoryArtifactsReloadNonce", "ChatView must not own artifact catalog retry state");
assertContains("src/components/useChatFollowUps.ts", ".chatSuggestions", "follow-up suggestions must have one focused owner");
assertContains("src/components/ChatView.tsx", "useChatFollowUps({", "ChatView must consume the focused follow-up suggestion owner");
assertNotContains("src/components/ChatView.tsx", "coreBridge.chatSuggestions", "ChatView must not own follow-up suggestion loading");
assertContains("src/components/useChatActiveTurnElapsed.ts", "window.setInterval(updateElapsed, 1000)", "active-turn elapsed timing must have one focused owner");
assertContains("src/components/ChatView.tsx", "useChatActiveTurnElapsed({", "ChatView must consume the focused active-turn timer owner");
assertNotContains("src/components/ChatView.tsx", "setActiveTurnElapsedSeconds", "ChatView must not own active-turn elapsed state");
assertContains("src/components/useChatStreamingNotifier.ts", "onStreamingChangeRef", "streaming parent notifications must have one focused owner");
assertContains("src/components/ChatView.tsx", "useChatStreamingNotifier(onStreamingChange)", "ChatView must consume the focused streaming notifier owner");
assertNotContains("src/components/ChatView.tsx", "onStreamingChangeRef", "ChatView must not own streaming notification refs");
assertContains("src/components/useChatActivityProjection.ts", "fetchKernelThreadProjection", "kernel activity projection fetch must have one focused owner");
assertContains("src/components/useChatActivityProjection.ts", "projectKernelThreadView", "kernel activity projection presenter must have one focused owner");
assertNotContains("src/components/useChatActivityProjection.ts", "fetchThreadActivity", "activity projection must not call the legacy activity endpoint");
assertNotContains("src/components/useChatActivityProjection.ts", "latestPlanMarkdown", "activity projection must not reconstruct plan state from markers");
assertNotContains("src/components/useChatActivityProjection.ts", "latestActivitySteps", "activity projection must not reconstruct activity state from markers");
assertContains("src/lib/chat-runtime/planSteps.mjs", "export function parsePlanSteps(markdown)", "workspace plan markdown parsing must have one focused owner");
assertContains("src/lib/chat-runtime/kernelProjectionPresenter.mjs", "projectPlanSteps", "workspace plan projection must be owned by the kernel presenter");
assertNotContains("src/components/useChatActivityProjection.ts", "parsePlanSteps", "activity projection hook must not own workspace plan parsing");
assertContains("src/components/useChatActivityProjection.ts", "createTurnReplayState", "activity projection replay seeding must have one focused owner");
assertContains("src/components/useChatActivityProjection.ts", "replayStatusFromProjection", "activity projection replay status mapping must have one focused owner");
assertContains("src/components/useChatBrowserActivityLifecycle.ts", "useChatActivityProjection({", "browser activity lifecycle must consume the focused durable activity projection owner");
assertNotContains("src/components/ChatView.tsx", "fetchThreadActivity", "ChatView must not own durable activity projection fetch");
assertNotContains("src/components/ChatView.tsx", "fetchKernelThreadProjection", "ChatView must not own kernel activity projection fetch");
assertNotContains("src/components/ChatView.tsx", "latestPlanMarkdown", "ChatView must not own plan marker fallback parsing");
assertNotContains("src/components/ChatView.tsx", "latestActivitySteps", "ChatView must not own activity marker fallback parsing");
assertNotContains("src/components/ChatView.tsx", "parsePlanSteps", "ChatView must not own workspace plan parsing");
assertNotContains("src/components/ChatView.tsx", "setProjectedActivity", "ChatView must not own durable projected activity state");
assertNotContains("src/components/ChatView.tsx", "setProjectedPlan", "ChatView must not own durable projected plan state");
assertNotContains("src/components/ChatView.tsx", "setProjectedTurnStatus", "ChatView must not own durable projected turn status state");
assertNotContains("src/components/ChatView.tsx", "setProjectedSubagents", "ChatView must not own durable projected subagent state");
assertNotContains("src/components/ChatView.tsx", "setProjectedActiveTurn", "ChatView must not own durable projected active turn state");
assertNotContains("src/components/ChatView.tsx", "setProjectionLoaded", "ChatView must not own durable projection load state");
assertContains("src/components/useChatBranches.ts", "coreBridge.chatBranches", "chat branch state must have one focused owner");
assertContains("src/components/useChatBranches.ts", "coreBridge.setActiveLeaf", "chat branch switching must have one focused owner");
assertContains("src/components/useChatBranches.ts", "coreBridge.setBranchLabel", "chat branch naming must have one focused owner");
assertContains("src/components/ChatView.tsx", "useChatBranches({", "ChatView must consume the focused branch owner");
assertNotContains("src/components/ChatView.tsx", "coreBridge.chatBranches", "ChatView must not own branch loading");
assertNotContains("src/components/ChatView.tsx", "coreBridge.setActiveLeaf", "ChatView must not own branch switching");
assertNotContains("src/components/ChatView.tsx", "coreBridge.setBranchLabel", "ChatView must not own branch naming");
assertContains("src/components/useChatComputerSession.ts", "coreBridge.localComputerSession", "local computer read model polling must have one focused owner");
assertContains("src/components/useChatComputerSession.ts", "coreBridge.localComputerArtifactPreview", "local computer preview loading must have one focused owner");
assertContains("src/components/useChatComputerSession.ts", "coreBridge.pauseLocalComputerSession", "local computer pause control must have one focused owner");
assertContains("src/components/useChatComputerSession.ts", "coreBridge.resumeLocalComputerSession", "local computer resume control must have one focused owner");
assertContains("src/components/useChatComputerSession.ts", "coreBridge.requestLocalComputerTakeover", "local computer takeover control must have one focused owner");
assertContains("src/components/useChatComputerSession.ts", "applyComputerSessionSnapshot", "streamed turn computer snapshots must update through the focused owner");
assertContains("src/components/useChatBrowserActivityLifecycle.ts", "useChatComputerSession({", "browser activity lifecycle must consume the focused local computer session owner");
assertContains("src/components/useChatTurnSubmission.ts", "applyComputerSessionSnapshot(result.computer_session)", "streamed prompt results must refresh the local computer read model through the focused owner");
assertNotContains("src/components/ChatView.tsx", "createLoadingComputerSession", "ChatView must not own local computer loading state");
assertNotContains("src/components/ChatView.tsx", "createUnavailableComputerSession", "ChatView must not own local computer unavailable state");
assertNotContains("src/components/ChatView.tsx", "mapCoreComputerSession", "ChatView must not own local computer read-model mapping");
assertNotContains("src/components/ChatView.tsx", "coreBridge.localComputerSession", "ChatView must not own local computer polling");
assertNotContains("src/components/ChatView.tsx", "coreBridge.localComputerArtifactPreview", "ChatView must not own local computer preview loading");
assertNotContains("src/components/ChatView.tsx", "coreBridge.pauseLocalComputerSession", "ChatView must not own local computer pause control");
assertNotContains("src/components/ChatView.tsx", "coreBridge.resumeLocalComputerSession", "ChatView must not own local computer resume control");
assertNotContains("src/components/ChatView.tsx", "coreBridge.requestLocalComputerTakeover", "ChatView must not own local computer takeover control");
assertContains("src/components/useChatSteeringQueue.ts", "fetchThreadSteering", "steering queue refresh must have one focused owner");
assertContains("src/components/useChatSteeringQueue.ts", "updateSteering", "steering queue edit must have one focused owner");
assertContains("src/components/useChatSteeringQueue.ts", "deleteSteering", "steering queue delete must have one focused owner");
assertContains("src/components/useChatSteeringQueue.ts", "sendSteeringNow", "steering queue send-now must have one focused owner");
assertContains("src/components/useChatSteeringQueue.ts", "applySteeringChange", "steering queue change reconciliation must have one focused owner");
assertContains("src/components/useChatSteeringQueue.ts", "steeringPromptWithEdit", "steering edit prompt assembly must have one focused owner");
assertContains("src/components/useChatApprovalFlow.ts", "useChatSteeringQueue({", "approval flow must consume the focused steering queue owner");
assertContains("src/components/useChatTurnSubmission.ts", "applyPendingSteeringChange(returnedRecord)", "queued steering returned by submit must update through the focused owner");
assertNotContains("src/components/ChatView.tsx", "createSteeringQueueState", "ChatView must not own steering queue initialization");
assertNotContains("src/components/ChatView.tsx", "reconcileSteering", "ChatView must not own steering queue reconciliation");
assertNotContains("src/components/ChatView.tsx", "applySteeringChange", "ChatView must not own steering queue change application");
assertNotContains("src/components/ChatView.tsx", "fetchThreadSteering", "ChatView must not own steering queue refresh");
assertNotContains("src/components/ChatView.tsx", "updateSteering", "ChatView must not own steering queue edit");
assertNotContains("src/components/ChatView.tsx", "deleteSteering", "ChatView must not own steering queue delete");
assertNotContains("src/components/ChatView.tsx", "sendSteeringNow", "ChatView must not own steering queue send-now");
assertNotContains("src/components/ChatView.tsx", "steeringPromptWithEdit", "ChatView must not own steering edit prompt assembly");
assertNotContains("src/components/ChatView.tsx", "memoryArtifactsRevision", "artifact validation must not use an unconditional revision counter");
assertContains("src/components/ArtifactsPanel.tsx", "selectedResourceRevision", "artifact preview reloads must follow a semantic resource revision");
assertNotContains("src/components/ChatView.tsx", "setArtifactsOpen", "legacy open boolean must not compete with inspector state");
assertNotContains("src/components/ChatView.tsx", "setWorkbenchTab", "legacy active-tab state must be removed");
assertContains("src/components/useChatInspectorWorkspace.ts", "`file:${normalizedPath}`", "file tabs must dedupe by canonical path");
assertContains("src/components/useChatInspectorWorkspace.ts", "`artifact:${artifact.thread}:${artifact.name}`", "artifact tabs must dedupe by provenance and name");
assertContains("src/components/useChatProjectContext.ts", ".projectGoals(threadId)", "project chat context must have one focused owner");
assertContains("src/components/useChatProjectContext.ts", ".memoryGraph(threadId)", "project graph count must follow the focused project context owner");
assertContains("src/components/ChatView.tsx", "useChatProjectContext(thread.threadId)", "ChatView must consume the focused project context owner");
assertNotContains("src/components/ChatView.tsx", "coreBridge.projectGoals", "ChatView must not own project context loading");
assertNotContains("src/components/ChatView.tsx", "coreBridge.memoryGraph", "ChatView must not own project graph loading");
assertNotContains("src/styles.css", ".artifacts-panel.embedded .artifacts-panel-body {\n  grid-template-columns:", "artifact preview must not keep a permanent inner sidebar");
assertNotContains("src/components/ChatView.tsx", "detailsOpen && (", "computer detail must use the shared inspector");
assertNotContains("src/styles.css", ".computer-detail-panel {\n  position: absolute", "computer detail must not float separately");
assertContains("src/styles.css", "@container chat-workspace (max-width: 960px)", "narrow behavior must follow available chat width");
assertContains("src/components/InspectorView.tsx", "descriptor.kind === \"sources\"", "sources must have an inspector adapter");
assertContains("src/components/InspectorView.tsx", "onOpenArtifact(sourceArtifact)", "artifact sources must open their resource tab");
assertContains("src/components/InspectorView.tsx", "descriptor.kind === \"subagents\"", "subagents must have an inspector adapter");
assertContains("src/components/InspectorView.tsx", "subagent.updated_at", "subagent views must expose their latest timestamp");
assertContains("src/components/InspectorTabStrip.tsx", 't("chat.inspector.closeTab"', "inspector tabs must have a specific localized close label");
assertContains("src/components/InspectorWorkspace.tsx", 't("chat.inspector.resize"', "inspector separator must have a localized resize label");
assertContains("src/components/InspectorWorkspace.tsx", "aria-valuenow", "inspector separator must expose its current width to assistive technology");
assertContains("src/components/InspectorWorkspace.tsx", "aria-valuemin={minPercent}", "inspector separator must expose its reachable minimum");
assertContains("src/components/InspectorWorkspace.tsx", "aria-valuemax={maxPercent}", "inspector separator must expose its reachable maximum");
assertContains("src/components/InspectorView.tsx", "fileLoadGenerationRef", "file revalidation must ignore stale authorization responses");
assertContains("src/styles/composer.css", ".active-task-layout.inspector-focused > .composer-stack", "focused inspector must hide the current composer surface");
assertNotContains("src/styles.css", ".active-task-layout.inspector-focused > .composer-stack", "focused inspector composer ownership must not remain in legacy styles");
assertNotContains("src/components/ChatView.tsx", "panel-menu-wrap--corner", "chat topbar must not expose a second workbench launcher");
assertNotContains("src/styles.css", ".panel-menu-wrap--corner", "chat topbar workbench launcher must not compete with the workspace island");
assertNotContains("src/styles.css", "z-index: 220;", "chat header workspace/review menu must not overlay native window controls");
assertContains("src/components/InspectorView.tsx", "<ArtifactsPanel", "artifact review must use the rich preview/diff surface in the workbench");
assertContains("src/styles.css", ".artifacts-panel.embedded .artifacts-panel-body", "artifact review workbench must style the embedded artifacts panel directly");
assertContains("src/styles.css", ".artifacts-panel.embedded .artifacts-panel-body {\n  min-height: 0;\n  padding: 0;", "embedded artifacts must not add an outer content frame");
assertContains("src/styles.css", ".artifacts-panel.embedded .artifacts-preview {\n  min-width: 0;\n  overflow: hidden;\n  border: 0;", "artifact preview must use the inspector as its only frame");
assertContains("src/styles.css", ".artifacts-panel.embedded .artifact-preview-doc {\n  padding: 0;\n  border: 0;", "artifact documents must not render as nested cards");
assertContains("src/styles.css", ".workbench-artifacts-list .artifact-row-wrap {\n  overflow: hidden;\n  border: 0;", "artifact rows must avoid nested card borders");
assertContains("src/components/InspectorView.tsx", "fileStatus === \"missing\"", "missing files must expose a dedicated recoverable state");
assertNotContains("src/components/ChatView.tsx", "{planSteps.length > 0 && <PlanProgressCard steps={planSteps} />}", "operational plan markers must not render duplicate inline cards inside the assistant answer");
assertContains("src/components/AssistantMessageBody.tsx", "{readable && <RichMessage text={readable} streaming={streaming} />}", "assistant markdown must stay progressive while the message streams");
assertContains("src/components/RichMessage.tsx", "visibleMessageText(text)", "raw reasoning must be filtered before transcript rendering");
assertNotContains("src/components/RichMessage.tsx", "ReasoningBlock", "raw reasoning must never render as transcript content");
assertContains("src/components/AssistantMessageBody.tsx", "{planPropose && !streaming && onChoose && (", "actionable plan proposal cards must wait for a completed non-streaming message");
assertContains("src/components/useChatConversationScroll.ts", "streamingUserPinnedRef", "chat must keep new streaming responses visible");
assertContains("src/components/ChatView.tsx", "markStreamingPinnedFromCurrentPosition", "streaming must reuse the conversation scroll owner");
assertNotContains("src/components/ChatView.tsx", "streamingUserPinnedRef", "ChatView must not own conversation scroll pinning");
assertNotContains("src/components/ChatView.tsx", "STREAM_TYPEWRITER_INTERVAL_MS", "chat streaming must not use timer-based typewriter rendering");
assertNotContains("src/components/ChatView.tsx", "streamingTextRef", "chat streaming must not bypass React with a manual DOM text node");

assertContains("src/components/MessageActionFooter.tsx", "messageContentKind", "message actions must derive from response content type");
assertContains("src/components/MessageActionFooter.tsx", "onExplainCode", "code responses must expose code-specific contextual actions");
assertContains("src/components/MessageActionFooter.tsx", "onImproveCode", "code responses must expose code improvement action");
assertContains("src/components/ComposerShell.tsx", "reply-context-card", "composer must show the active reply context before submit");
assertContains("src/components/MessageActionBar.tsx", "message-action-menu", "secondary message actions must stay behind a compact menu");
assertContains("src/components/MessageActionBar.tsx", "runMessageMenuAction", "message overflow actions must close the menu before running");
assertContains("src/components/MessageActionBar.tsx", "message-latency-summary", "message metrics must be visible without dominating the answer");
assertContains("src/components/GoalsPanel.tsx", "normalizeGoalText", "goals manager must normalize goal text before comparing suggestions");
assertContains("src/components/GoalsPanel.tsx", "dedupeGoalDrafts", "goals manager must dedupe suggested goals against existing project goals");
assertContains("src/components/GoalsPanel.tsx", "decideMemory(g.reference, \"delete\")", "goals manager must allow deleting saved project goals");
assertContains("src/components/MemoryGraphPanel.tsx", "resizeFitTimer", "memory graph must refit after the workbench/canvas changes size");
assertContains("src/components/MemoryGraphPanel.tsx", "layoutSignal", "memory graph must receive an explicit workbench layout signal");
assertContains("src/components/ChatInspectorDock.tsx", "layoutSignal={`${state.activeTabId}:${ratio}`}", "inspector must refit Memory when the active tab or width changes");
assertContains("src/components/MemoryGraphPanel.tsx", "requestAnimationFrame", "memory graph resize refit must wait for the resized canvas to paint");
assertContains("src/components/MemoryGraphPanel.tsx", "d3ReheatSimulation", "memory graph resize refit must restart layout before fitting");
assertContains("src/styles.css", ".memory-graph-canvas canvas", "memory graph must size the ForceGraph canvas, not only an svg");
assertNotContains("src/components/ChatView.tsx", "canCreateteTask={assistantTextMessage}", "message action menu must not advertise unverified task creation for every assistant text");
assertNotContains("src/components/ChatView.tsx", "canCreateteAutomation={assistantTextMessage}", "message action menu must not advertise unverified automation creation for every assistant text");
assertNotContains("src/components/ComposerShell.tsx", "\"Use a skill\"", "composer add menu must expose user-facing capabilities, not implementation terms");
assertNotContains("src/components/ComposerShell.tsx", "t(\"chat.searchSkill\")", "composer capability picker must not expose skill terminology");
assertContains("src/components/ComposerShell.tsx", "t(\"chat.searchCapability\")", "composer capability picker must search capabilities");
assertContains("src/components/ComposerShell.tsx", "t(\"chat.noCapabilities\")", "composer capability picker must use capability empty state");
assertContains("src/components/ComposerShell.tsx", "t(\"chat.forcedCapabilityNextMessage\")", "forced capability chip must use user-facing capability terminology");
assertContains("src/components/ComposerShell.tsx", "<small>{option.description}</small>", "composer mode picker must explain what each mode does");
assertContains("src/components/ComposerContainer.tsx", "available: !option.projectOnly || linkedFolder != null", "composer must hide project-only modes without a linked project folder");
assertContains("src/i18n/locales/en.json", "\"searchCapability\"", "English chat locale must include capability search label");
assertContains("src/i18n/locales/it.json", "\"searchCapability\"", "Italian chat locale must include capability search label");
assertContains("src/components/ComposerShell.tsx", "props.value.trim() && matchesAdd", "composer improve prompt action must only render when there is prompt text to improve");
assertNotContains("src/components/ChatView.tsx", "/^fn\\s+", "code-specific message actions must not rely on fragile plain-text Rust heuristics");
assertNotContains("src/components/ChatView.tsx", "/^let\\s+", "code-specific message actions must not rely on fragile plain-text variable heuristics");
assertContains("src/components/useChatStreamLifecycle.ts", "cancelStreamingRequestRef", "chat stream lifecycle must allow users to stop a visible streaming response");
assertContains("src/components/ChatView.tsx", "useChatStreamLifecycle({", "ChatView must consume the focused stream lifecycle owner");
assertNotContains("src/components/ChatView.tsx", "cancelStreamingRequestRef", "ChatView must not own streaming cancel refs");
assertNotContains("src/components/ChatView.tsx", "cancelledStreamIdsRef", "ChatView must not own streaming cancellation ids");
assertNotContains("src/components/ChatView.tsx", "setStreamHasVisibleText", "ChatView must not own streaming visible-text state");
assertContains("src/components/ComposerContainer.tsx", "catalogsMissingModels", "chat must refresh an empty provider catalog even when an active model is already known");
assertContains("src/components/ComposerContainer.tsx", "RUNTIME_MODELS_CHANGED_EVENT", "chat model picker must react immediately to provider changes without a page refresh");
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
assertContains("src/lib/busyThreadProjection.mjs", "const ids = new Set(backgroundStreamIds)", "sidebar busy state must include durable background stream ids");
assertContains("src/lib/busyThreadProjection.mjs", "if (streamingThreadId) ids.add(streamingThreadId)", "sidebar busy state must include the active visible stream");
assertContains("src/lib/busyThreadProjection.mjs", "task.status === \"running\" || task.status === \"queued\"", "sidebar busy state must ignore completed or failed tasks");
assertContains("src/App.tsx", "pendingLocalMessageThreadIdsRef", "chat polling must know which threads have optimistic local messages");
assertContains("src/lib/useChatReadModelController.ts", "shouldPreserveLocalMessages", "backend refresh must not wipe visible local messages before gateway persistence");
assertContains("src/App.tsx", "setThreadMessagesFromBackend", "backend chat snapshots must pass through the stale-safe message updater");
assertContains("src/App.tsx", "pendingTemplateAutoSubmit", "template workflows must be handed to the visible chat renderer");
assertContains("src/App.tsx", "onAutoSubmitConsumed", "template auto-submit triggers must be consumed after entering the chat pipeline");
assertContains("src/components/ChatViewTypes.ts", "autoSubmit?: ChatAutoSubmit | null", "ChatView must accept external chat-start triggers without bypassing streaming UI");
assertContains("src/components/useChatTurnStateMachine.ts", "submitPrompt(\n      autoSubmit.prompt", "external chat-start triggers must reuse the normal visible submit pipeline");
assertNotContains("src/App.tsx", "template_workflow_", "template workflows must not start a parallel invisible stream from App");
// The dock now has ONE enlarge/contract control (right-aligned): fullscreen ⇄ back.
assertContains("src/components/ChatComputerPanel.tsx", "setView(fullscreen ? \"expanded\" : \"full\")", "Computer dock must expose a single enlarge/contract control (fullscreen ⇄ expanded)");
assertContains("src/components/ChatComputerPanel.tsx", "fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />", "Computer dock enlarge/contract control must use fullscreen/minimize icons");
assertContains("src/styles.css", ".cc-dock,\n.cc-scrim {\n  pointer-events: auto;", "Computer dock controls must be clickable inside the non-interactive status stack");
assertContains("src/styles.css", ".cc-dock.full {\n  position: fixed;", "Computer fullscreen dock must escape the status stack and anchor inside the chat viewport");
assertContains("src/styles.css", "left: calc(var(--drawer-island-gap) + var(--drawer-width, 268px) + 24px);", "Computer fullscreen dock must start to the right of the sidebar island");
assertContains("src/styles.css", "width: min(1040px, calc(100vw - var(--drawer-width, 268px) - 72px));", "Computer fullscreen must be large but bounded by the chat area");
assertContains("src/lib/chatVisibleContent.mjs", "STRAY_REASONING_MARKER", "streaming renderer must strip stray or malformed reasoning markers from the visible answer body");
assertContains("src/components/ChatMessageMarkerParser.ts", "VAULT_PROPOSE_RE", "chat renderer must parse vault proposal markers");
assertContains("src/components/AssistantMessageBody.tsx", "VaultProposeCard", "chat renderer must render sensitive-data vault proposal cards");
// The strip regex (COMPOSIO_MARKERS_RE, which lists VAULT_PROPOSE|…) was refactored out of
// ChatView into src/lib/markers.ts; ChatMessageMarkerParser imports and applies it.
assertContains("src/lib/markers.ts", "VAULT_PROPOSE|", "vault proposal markers must be stripped from visible prose");
assertContains("src/components/ChatMessageMarkerParser.ts", "COMPOSIO_MARKERS_RE", "chat renderer must apply the marker-strip regex to visible prose");
assertContains("src/components/ChatMessageMarkerParser.ts", "VAULT_REVEAL_RE", "chat renderer must parse vault reveal markers");
assertContains("src/components/AssistantMessageBody.tsx", "VaultRevealCard", "chat renderer must render PIN-gated vault reveal cards");
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
assertRepoContains("crates/desktop-gateway/src/gateway_prompt.rs", "build_prompt", "desktop gateway prompt build handler must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/api/chat/build_prompt", "desktop gateway must expose prompt build endpoint");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "gateway_prompt::build_prompt", "desktop gateway must route prompt build through the shared handler");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/api/chat/turns", "desktop gateway must expose the broker turn endpoint (the only chat path)");
assertRepoContains("apps/desktop/src/lib/coreBridge.ts", "export type CoreChatStreamEvent", "desktop renderer must expose structured chat stream events");
assertRepoContains("apps/desktop/src/lib/chatApi.ts", "listenChatStreamEvent", "chat API must expose structured chat stream subscription");
assertRepoContains("apps/desktop/src/components/useChatTurnSubmission.ts", "listenChatStreamEvent", "turn submission must consume structured chat stream events");
assertRepoContains("apps/desktop/src/components/useChatTurnSubmission.ts", "eventParts", "turn submission must pass structured event parts into assistant rendering");
assertRepoContains("apps/desktop/src/lib/coreBridge.ts", "event_parts", "core chat message must expose persisted structured event parts");
assertRepoContains("apps/desktop/src/lib/appCoreMappers.ts", "mapCoreChatEventParts", "desktop app must hydrate persisted structured event parts");
assertRepoContains("apps/desktop/src/lib/useChatReadModelController.ts", "mapCoreChatMessage", "desktop app must hydrate persisted messages through the core mapper owner");
assertRepoNotContains("apps/desktop/src/components/ChatView.tsx", "eventPartToLegacyMarker", "ChatView must not synthesize legacy markers from structured event parts");
assertRepoNotContains("apps/desktop/src/components/ChatView.tsx", "visibleStreamingText", "streaming messages must keep prose text separate from structured event parts");
assertRepoContains("apps/desktop/src/components/chatStreamEventProjection.ts", "shouldDropStructuredMarkerDelta", "stream event projection must drop legacy marker deltas after receiving structured event parts");
assertRepoContains("apps/desktop/src/components/chatStreamEventProjection.ts", "chatEventPartFromStream", "stream event projection must own structured stream event conversion");
assertRepoContains("apps/desktop/src/components/useChatTurnSubmission.ts", "projectChatStreamEvent(", "turn submission must consume the focused stream event projection owner");
assertRepoNotContains("apps/desktop/src/components/ChatView.tsx", "chatEventPartFromStream", "ChatView must not own structured stream event conversion");
assertRepoNotContains("apps/desktop/src/components/ChatView.tsx", "shouldDropStructuredMarkerDelta", "ChatView must not own structured marker delta filtering");
assertNotContains("src/App.tsx", "‹‹CHOICES››", "new proactivity choice prompts must use structured event parts, not marker text");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/api/tasks/queue", "desktop gateway must expose task queue read model endpoint");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/api/tasks/executor", "desktop gateway must expose task executor status endpoint");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/api/tasks/run_next", "desktop gateway must expose the first local task executor endpoint");
assertRepoContains("crates/desktop-gateway/src/gateway_task_executor.rs", "start_task_executor_worker", "desktop gateway must start a background task executor worker");
assertRepoContains("crates/desktop-gateway/src/gateway_task_executor.rs", "pub(crate) struct TaskQueueResponse", "task executor read model DTOs must stay in the task executor owner");
assertRepoContains("crates/desktop-gateway/src/gateway_task_executor.rs", "pub(crate) fn task_queue_response_for_state", "task executor queue read model mapping must stay in the task executor owner");
assertRepoContains("crates/desktop-gateway/src/gateway_task_executor.rs", "task_executor_owner_smoke", "task executor owner must keep a focused owner smoke test");
assertRepoNotContains("crates/desktop-gateway/src/main.rs", "struct TaskQueueResponse", "gateway main must not own task executor queue DTOs");
assertRepoNotContains("crates/desktop-gateway/src/main.rs", "fn task_queue_response_for_state", "gateway main must not own task executor queue mapping");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/api/local-computer/sessions/{session_id}", "desktop gateway must expose local computer session read model endpoint");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/api/local-computer/sessions/{session_id}/artifacts/{artifact_id}/preview", "desktop gateway must expose redacted local computer artifact previews");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/api/memory/dashboard", "desktop gateway must expose memory dashboard read model endpoint");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/api/capabilities/snapshot", "desktop gateway must expose capability registry snapshot endpoint");
assertRepoContains("crates/desktop-gateway/src/gateway_task_executor.rs", "TaskUiReadModel", "desktop gateway task executor owner must use the task runtime UI read model");
assertRepoContains("crates/desktop-gateway/src/main.rs", "LocalComputerReadModel", "desktop gateway must use the local computer UI read model");
assertRepoContains("crates/desktop-gateway/src/gateway_memory_ui_routes.rs", "MemoryUiReadModel", "desktop gateway must use the memory UI read model");
assertRepoContains("crates/desktop-gateway/src/main.rs", "CapabilityRegistryStore", "desktop gateway must use the capability registry store");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/api/chat/threads", "desktop gateway must expose persistent thread endpoints");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "/messages/{message_id}/create_task", "desktop gateway must create durable tasks from chat messages");
assertRepoContains("crates/desktop-gateway/src/main.rs", "link_brain_tasks_to_thread", "desktop gateway must link Brain-created operational tasks to the thread (and local computer read models)");
assertRepoContains("crates/desktop-gateway/src/main.rs", "LocalComputerSessionStore", "desktop gateway must persist computer sessions for operational tasks");
assertRepoContains("crates/desktop-gateway/src/main.rs", "HOMUN_BROWSER_HEADLESS", "desktop gateway must allow visible Playwright browser sessions");
assertRepoContains("crates/desktop-gateway/src/gateway_paths.rs", "gateway_data_dir", "desktop gateway data paths must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_paths.rs", "HOMUN_DESKTOP_GATEWAY_DB", "desktop gateway path owner must preserve DB override compatibility");
assertRepoContains("crates/desktop-gateway/src/gateway_paths.rs", "gateway_workspaces_path", "desktop gateway workspace paths must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_paths.rs", "HOMUN_MEMORY_WIKI_DIR", "desktop gateway path owner must preserve memory wiki override compatibility");
assertRepoContains("crates/desktop-gateway/src/main.rs", "gateway_paths::gateway_data_dir", "desktop gateway startup must use the shared path owner");
assertRepoContains("crates/desktop-gateway/src/gateway_file_security.rs", "write_private_file", "desktop gateway local file protection must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_file_security.rs", "harden_data_at_rest", "desktop gateway at-rest hardening must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/main.rs", "gateway_file_security::write_private_file", "desktop gateway startup must use the shared private file writer");
assertRepoContains("crates/desktop-gateway/src/gateway_vault_key.rs", "resolve_vault_wrap_key", "desktop gateway vault wrap key resolution must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_vault_key.rs", "HOMUN_VAULT_WRAP_KEY", "desktop gateway vault key owner must preserve env-key precedence");
assertRepoContains("crates/desktop-gateway/src/main.rs", "gateway_vault_key::resolve_vault_wrap_key", "desktop gateway startup must use the shared vault key resolver");
assertRepoContains("crates/desktop-gateway/src/gateway_identity.rs", "gateway_memory_workspace_id", "desktop gateway workspace identity scope must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_identity.rs", "PERSONAL_WORKSPACE", "desktop gateway identity owner must preserve personal memory canonicalization");
assertRepoContains("crates/desktop-gateway/src/main.rs", "gateway_identity::gateway_workspace_id", "desktop gateway root must re-export shared identity helpers");
assertRepoContains("crates/desktop-gateway/src/gateway_secrets.rs", "gateway_secret_key_seed", "desktop gateway encrypted secret seed must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_secrets.rs", "browser-checkpoint-secrets.json", "desktop gateway secret owner must preserve browser checkpoint secret path");
assertRepoContains("crates/desktop-gateway/src/main.rs", "gateway_secrets::open_gateway_secret_store", "desktop gateway startup must use the shared encrypted secret store owner");
assertRepoContains("crates/desktop-gateway/src/gateway_legacy_data.rs", "migrate_legacy_data_dir", "desktop gateway legacy data-dir migration must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_legacy_data.rs", "LegacyDirAction", "desktop gateway legacy data-dir decision must stay unit-testable outside the monolith");
assertRepoContains("crates/desktop-gateway/src/main.rs", "gateway_legacy_data::migrate_legacy_data_dir", "desktop gateway startup must use the shared legacy data-dir migrator");
assertRepoContains("crates/desktop-gateway/src/gateway_bind.rs", "gateway_bind_addr", "desktop gateway bind address must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_bind.rs", "HOMUN_DESKTOP_GATEWAY_PORT", "desktop gateway bind owner must preserve desktop port override compatibility");
assertRepoContains("crates/desktop-gateway/src/gateway_bind.rs", "HOMUN_DESKTOP_GATEWAY_HOST", "desktop gateway bind owner must preserve host override compatibility");
assertRepoContains("crates/desktop-gateway/src/main.rs", "gateway_bind::gateway_bind_addr", "desktop gateway startup must use the shared bind resolver");
assertRepoContains("crates/desktop-gateway/src/gateway_task_executor_config.rs", "task_executor_worker_enabled", "desktop gateway task executor worker config must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_task_executor_config.rs", "HOMUN_TASK_WORKER_COUNT", "desktop gateway task executor owner must preserve worker-count env compatibility");
assertRepoContains("crates/desktop-gateway/src/gateway_task_executor.rs", "gateway_task_executor_config::task_executor_worker_enabled", "desktop gateway task executor must use the shared task executor config");
assertRepoContains("crates/desktop-gateway/src/gateway_model_timeouts.rs", "model_request_timeout_secs", "desktop gateway model timeout config must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_model_timeouts.rs", "HOMUN_MODEL_FIRST_TOKEN_SECS", "desktop gateway model timeout owner must preserve first-token override compatibility");
assertRepoContains("crates/desktop-gateway/src/main.rs", "pub(crate) use gateway_model_timeouts", "desktop gateway root must re-export shared model timeout helpers");
assertRepoContains("crates/desktop-gateway/src/gateway_db_unify.rs", "unify_legacy_databases_at_startup", "desktop gateway legacy DB unification must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_db_unify.rs", "unify_databases_if_needed", "desktop gateway DB unification owner must delegate to the canonical migration engine");
assertRepoContains("crates/desktop-gateway/src/main.rs", "gateway_db_unify::unify_legacy_databases_at_startup", "desktop gateway startup must use the shared DB unification owner");
assertRepoContains("crates/desktop-gateway/src/gateway_http_client.rs", "build_gateway_http_client", "desktop gateway shared HTTP client must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_http_client.rs", "HOMUN_HTTP_CONNECT_TIMEOUT_SECS", "desktop gateway HTTP client owner must preserve connect-timeout override compatibility");
assertRepoContains("crates/desktop-gateway/src/main.rs", "gateway_http_client::build_gateway_http_client", "desktop gateway startup must use the shared HTTP client owner");
assertRepoContains("crates/desktop-gateway/src/gateway_store_integrity.rs", "ensure_gateway_store_integrity", "desktop gateway startup store-integrity sweep must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_store_integrity.rs", "capability-registry", "desktop gateway store-integrity owner must preserve health recovery store names");
assertRepoContains("crates/desktop-gateway/src/main.rs", "gateway_store_integrity::ensure_gateway_store_integrity", "desktop gateway startup must use the shared store-integrity owner");
assertRepoContains("crates/desktop-gateway/src/gateway_auth.rs", "require_gateway_token", "desktop gateway auth middleware must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_auth.rs", "resolve_gateway_auth_token", "desktop gateway auth token resolution must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "gateway_auth::require_gateway_token", "desktop gateway must protect chat endpoints with a local token");
assertRepoContains("crates/desktop-gateway/src/main.rs", "gateway_auth::resolve_gateway_auth_token", "desktop gateway startup must use the shared auth token resolver");
assertRepoContains("crates/desktop-gateway/src/gateway_cors.rs", "AllowOrigin::list", "desktop gateway CORS must use an explicit origin allowlist outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_cors.rs", "HeaderValue::from_static(\"null\")", "desktop gateway CORS must allow packaged file-origin renderer with bearer token");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "gateway_cors::cors_layer", "desktop gateway must apply the shared CORS layer");
assertRepoContains("crates/desktop-gateway/src/gateway_health.rs", "HealthResponse", "desktop gateway health response must be owned outside the monolith");
assertRepoContains("crates/desktop-gateway/src/gateway_routes.rs", "gateway_health::health", "desktop gateway must route liveness through the shared health handler");
assertRepoContains("crates/desktop-gateway/src/chat_store.rs", "create table if not exists chat_threads", "desktop gateway must persist chat threads in SQLite");
assertRepoContains("crates/desktop-gateway/src/chat_store.rs", "create table if not exists chat_messages", "desktop gateway must persist chat messages in SQLite");
assertRepoContains("crates/desktop-gateway/src/main.rs", "Body::from_stream", "desktop gateway must proxy runtime stream without buffering the full answer");

assertContains(
  "src/components/ChatMessageContent.tsx",
  "<MessageActivity",
  "per-turn activity must be rendered inline in each assistant message"
);
assertContains(
  "src/components/MessageActivity.tsx",
  "msg-activity-steps",
  "per-turn activity markup must be owned by MessageActivity"
);
assertContains(
  "src/components/AutomationsView.tsx",
  "projectAutomationRunState",
  "automation scheduled run status must be projected from the kernel-aware mapper"
);
assertContains(
  "src/components/AutomationsView.tsx",
  "fetchKernelThreadProjection",
  "automation scheduled runs must read their owning kernel projection"
);
assertNotContains(
  "src/components/AutomationsView.tsx",
  'task.status === "active"',
  "automation scheduled runs must not infer progress from UI-local task status aliases"
);

assertMissing(
  "src/components/ProjectContextPanel.tsx",
  "project context must not create a second persistent status owner"
);

console.log("UI contract checks passed");
