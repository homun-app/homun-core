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
assertContains("electron/main.cjs", "ensureGateway", "Electron shell must own desktop gateway lifecycle");
assertContains("electron/main.cjs", "HOMUN_DESKTOP_GATEWAY_TOKEN", "Electron shell must generate/pass the local gateway token");
assertContains("electron/main.cjs", "HOMUN_DESKTOP_RESOURCES_DIR", "Electron shell must support production-like local resource smoke tests");
assertContains("electron/main.cjs", "before-quit", "Electron shell must stop managed gateway process on app quit");
assertContains("electron/preload.cjs", "contextBridge.exposeInMainWorld", "Electron preload must expose only minimal runtime config");
assertContains("scripts/prepare-package.mjs", "local-first-desktop-gateway", "package preparation must copy the gateway binary");
assertContains("scripts/electron-dev.mjs", "waitForDevServer", "Electron dev shell must wait for Vite before launch");
assertContains("scripts/electron-dev.mjs", "stopGatewayOnPort", "Electron dev shell must clear stale gateway listeners before Electron owns lifecycle");
assertContains("src/styles.css", "--window-drag-height", "Electron shell must reserve native window control space");
assertContains("src/styles.css", "-webkit-app-region: drag", "Electron shell must expose a draggable titlebar region");
assertContains("src/styles.css", "-webkit-app-region: no-drag", "interactive controls must remain clickable inside Electron");

assertContains("src/components/Sidebar.tsx", "navigation-rail", "primary navigation must be rail-first");
assertContains("src/components/Sidebar.tsx", "nav-drawer", "expanded navigation must be a drawer");
assertContains("src/components/Shell.tsx", "{!drawerOpen && !isSettings && (", "rail must only render when the drawer is closed and not in settings");
assertContains("src/components/Shell.tsx", "{drawerOpen && !isSettings && (", "main drawer must render when open");
assertContains("src/components/Sidebar.tsx", "drawer-persistent-actions", "open drawer must retain persistent actions");
assertContains("src/components/ChatView.tsx", "composer-surface", "prompt composer must have a stable anchored surface");
assertContains("src/components/ChatView.tsx", "local-computer-card", "active task must expose a local computer activity card");
assertContains("src/components/ChatView.tsx", "timelineCollapsed", "computer timeline must keep collapsed state");
assertContains("src/components/ChatView.tsx", "computerCardCollapsed", "local computer card must be collapsible after answers");
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
assertContains("src/components/SettingsView.tsx", "https://api.z.ai/api/paas/v4", "Z.ai standard preset must keep the standard GLM endpoint");
assertContains("src/components/SettingsView.tsx", "https://api.z.ai/api/coding/paas/v4", "Z.ai coding preset must keep the coding GLM endpoint");
assertContains("src/components/SettingsView.tsx", "v.id === p.id || normUrl(v.base_url) === normUrl(p.baseUrl)", "provider preset cards must match by stable id before URL fallback");

assertContains("src/components/ChatView.tsx", "coreBridge.submitChatPromptStream", "composer must submit prompts through the local chat transport");
assertContains("src/lib/coreBridge.ts", "submitBrowserRuntimeChatPromptStream", "Electron bridge must stream from the local Gemma runtime through Electron-safe transport");
assertContains("src/lib/coreBridge.ts", "openChatStreamWithGateway", "Electron bridge must stream through the Rust desktop gateway");
assertContains("src/lib/coreBridge.ts", "/api/chat/generate_stream", "Electron bridge must call the local gateway streaming endpoint");
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
assertContains("src/App.tsx", "mapCoreMemoryDashboard", "desktop memory page must map the gateway memory dashboard read model");
assertContains("src/App.tsx", "mapCoreCapabilitySnapshot", "desktop connections page must map the gateway capability read model");
assertContains("src/lib/chatApi.ts", "/api/chat/threads", "chat threads must load from the local Rust gateway first");
assertContains("src/lib/chatApi.ts", "hydrateThreadSnapshot", "chat API must keep a local cache synchronized with gateway thread snapshots");
assertContains("src/lib/chatApi.ts", "localThreads", "chat threads must keep an Electron-safe fallback cache");
assertContains("src/lib/chatApi.ts", "commitChatPromptResult", "Electron chat fallback must persist completed streamed answers before read model refresh");
assertContains("src/lib/chatApi.ts", "commitChatContinuetionResult", "Electron chat fallback must persist automatic continuations before read model refresh");
assertContains("src/lib/coreBridge.ts", "await chatApi.commitChatPromptResult", "streamed chat answers must be committed before the UI refreshes the thread read model");
assertContains("src/lib/coreBridge.ts", "result.computer_session = await electronLocalComputerSession", "streamed prompt results must refresh the real local computer read model after commit");
assertContains("src/lib/coreBridge.ts", "await chatApi.commitChatContinuetionResult", "automatic continuations must be committed before the UI refreshes the thread read model");
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
assertContains("src/components/ChatView.tsx", "streamingUserPinnedRef", "chat must keep new streaming responses visible");
assertNotContains("src/components/ChatView.tsx", "STREAM_TYPEWRITER_INTERVAL_MS", "chat streaming must not use timer-based typewriter rendering");
assertNotContains("src/components/ChatView.tsx", "streamingTextRef", "chat streaming must not bypass React with a manual DOM text node");

assertContains("src/components/ChatView.tsx", "messageContentKind", "message actions must derive from response content type");
assertContains("src/components/ChatView.tsx", "onExplainCode", "code responses must expose code-specific contextual actions");
assertContains("src/components/ChatView.tsx", "onImproveCode", "code responses must expose code improvement action");
assertContains("src/components/ChatView.tsx", "reply-context-card", "composer must show the active reply context before submit");
assertContains("src/components/ChatView.tsx", "message-action-menu", "secondary message actions must stay behind a compact menu");
assertContains("src/components/ChatView.tsx", "message-latency-summary", "message metrics must be visible without dominating the answer");
assertContains("src/components/ChatView.tsx", "cancelStreamingRequestRef", "chat must allow users to stop a visible streaming response");

assertContains("src/types.ts", "\"learning\"", "auto-learning must be a first-class view");
assertContains("src/components/LearningView.tsx", "learning-view", "auto-learning must have a dedicated page");
assertContains("src/components/LearningView.tsx", "habit-card", "learning page must expose learned habits");
assertContains("src/components/LearningView.tsx", "automation-proposal", "learning page must expose possible automations");
assertContains("src/styles.css", "@media (max-width: 860px)", "responsive shell must define tablet/mobile behavior");

assertRepoContains("Cargo.toml", "\"crates/desktop-gateway\"", "workspace must include the desktop gateway crate");
assertRepoContains("crates/desktop-gateway/src/lib.rs", "build_chat_runtime_prompt", "desktop gateway must own chat runtime prompt construction");
assertRepoContains("crates/desktop-gateway/src/lib.rs", "ContextCompressor", "desktop gateway must use Rust context compression");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/chat/build_prompt", "desktop gateway must expose prompt build endpoint");
assertRepoContains("crates/desktop-gateway/src/main.rs", "/api/chat/generate_stream", "desktop gateway must expose chat stream endpoint");
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

console.log("UI contract checks passed");
