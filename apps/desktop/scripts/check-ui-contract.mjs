import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function read(path) {
  return readFileSync(join(root, path), "utf8");
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

function assertOccurrenceCount(file, text, count, description) {
  const source = read(file);
  const actual = source.split(text).length - 1;
  if (actual !== count) {
    throw new Error(`${description}: expected ${file} to contain ${text} ${count} time(s), found ${actual}`);
  }
}

assertContains("src/components/Sidebar.tsx", "navigation-rail", "primary navigation must be rail-first");
assertContains("src/components/Sidebar.tsx", "nav-drawer", "expanded navigation must be a drawer");
assertContains("src/components/Shell.tsx", "{!drawerOpen && (", "rail must only render when the drawer is closed");
assertContains("src/components/Shell.tsx", "{drawerOpen && !isSettings && (", "main drawer must render when open");
assertContains("src/components/Sidebar.tsx", "drawer-persistent-actions", "open drawer must retain persistent actions");
assertContains("src/components/Sidebar.tsx", "drawer-settings-action", "open drawer must retain settings access");
assertContains("src/components/Sidebar.tsx", "aria-label=\"Notifiche\"", "drawer notifications must remain accessible by icon");
assertContains("src/components/Sidebar.tsx", "aria-label=\"Impostazioni\"", "drawer settings must remain accessible by icon");
assertNotContains("src/components/Sidebar.tsx", "<span>Notifiche</span>", "drawer persistent actions must be icon-only");
assertNotContains("src/components/Sidebar.tsx", "<span>Impostazioni</span>", "drawer persistent actions must be icon-only");
assertNotContains("src/components/Sidebar.tsx", "Local Computer", "local computer must not live in the sidebar");
assertContains("src/styles.css", "justify-content: flex-start;", "drawer footer icons must align left");
assertNotContains("src/styles.css", ".drawer-footer {\n  border-top", "drawer footer must not have a divider line");
assertContains("src/components/ChatView.tsx", "local-computer-card", "active task must expose a local computer activity card");
assertContains("src/components/ChatView.tsx", "computer-detail-panel", "computer details must be progressive disclosure");
assertContains("src/components/ChatView.tsx", "timeline-step", "assistant progress must be inline timeline");
assertOccurrenceCount("src/components/ChatView.tsx", "<InlineTimeline session={computerSession} />", 1, "timeline must render once per thread, not under every assistant message");
assertContains("src/components/ChatView.tsx", "composer-surface", "prompt composer must have a stable anchored surface");
assertContains("src/components/ChatView.tsx", "coreBridge.localComputerSession", "chat local computer card must load the Tauri read model");
assertContains("src/components/ChatView.tsx", "coreBridge.submitUserPrompt", "composer must submit prompts to the Tauri core");
assertContains("src/components/ChatView.tsx", "coreBridge.runLocalComputerSmokeTest", "chat must expose a real local computer smoke test action");
assertContains("src/components/ChatView.tsx", "mapCoreComputerSession", "chat local computer card must map the core snapshot before rendering");
assertContains("src/lib/localComputerViewModel.ts", "payload_redacted", "local computer UI mapping must preserve redaction contract");
assertNotContains("src/App.tsx", "computerSession,", "app must not pass mock local computer session into chat");
assertContains("src/types.ts", "\"learning\"", "auto-learning must be a first-class view");
assertContains("src/data/mockData.ts", "learningInsights", "auto-learning insights must live in separated mock data");
assertContains("src/components/LearningView.tsx", "learning-view", "auto-learning must have a dedicated page");
assertContains("src/components/LearningView.tsx", "habit-card", "learning page must expose learned habits");
assertContains("src/components/LearningView.tsx", "automation-proposal", "learning page must expose possible automations");
assertContains("src/components/LearningView.tsx", "evidence-list", "learning page must show why something was learned");
assertContains("src/components/LearningView.tsx", "privacy-control", "learning page must expose correction/privacy controls");
assertContains("src/styles.css", ".active-task-layout", "active task view must use a dedicated layout");
assertContains("src/styles.css", ".learning-view", "learning page must have dedicated layout styles");
assertContains("src/styles.css", "@media (max-width: 860px)", "responsive shell must define tablet/mobile behavior");
assertNotContains("src/App.tsx", "Inspector", "inspector must not be part of default app shell");
assertNotContains("src/App.tsx", "isInspectorCollapsed", "inspector state must not drive layout");

console.log("UI contract checks passed");
