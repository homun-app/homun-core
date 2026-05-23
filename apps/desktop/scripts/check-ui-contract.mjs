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

assertContains("src/components/Sidebar.tsx", "navigation-rail", "primary navigation must be rail-first");
assertContains("src/components/Sidebar.tsx", "nav-drawer", "expanded navigation must be a drawer");
assertContains("src/components/Shell.tsx", "{!drawerOpen && (", "rail must only render when the drawer is closed");
assertContains("src/components/Shell.tsx", "{drawerOpen && !isSettings && (", "main drawer must render when open");
assertContains("src/components/ChatView.tsx", "local-computer-card", "active task must expose a local computer activity card");
assertContains("src/components/ChatView.tsx", "computer-detail-panel", "computer details must be progressive disclosure");
assertContains("src/components/ChatView.tsx", "timeline-step", "assistant progress must be inline timeline");
assertContains("src/components/ChatView.tsx", "composer-surface", "prompt composer must have a stable anchored surface");
assertContains("src/styles.css", ".active-task-layout", "active task view must use a dedicated layout");
assertContains("src/styles.css", "@media (max-width: 860px)", "responsive shell must define tablet/mobile behavior");
assertNotContains("src/App.tsx", "Inspector", "inspector must not be part of default app shell");
assertNotContains("src/App.tsx", "isInspectorCollapsed", "inspector state must not drive layout");

console.log("UI contract checks passed");
