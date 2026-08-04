import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const componentPath = new URL(
  "../src/components/AdaptiveWorkspaceIsland.tsx",
  import.meta.url,
);
const stylesPath = new URL("../src/styles/workspace-island.css", import.meta.url);
const chatViewPath = new URL("../src/components/ChatView.tsx", import.meta.url);
const legacyStylesPath = new URL("../src/styles.css", import.meta.url);
const mainPath = new URL("../src/main.tsx", import.meta.url);

test("adaptive workspace island is collapsed by default and resets per thread", async () => {
  const source = await readFile(componentPath, "utf8");
  assert.match(source, /useState<WorkspaceSectionId\s*\|\s*null>\(null\)/);
  assert.match(source, /setActiveSection\(null\)[\s\S]*?\[threadId\]/);
  assert.match(source, /nextWorkspaceSection\(activeSection,\s*section\.id\)/);
  assert.match(source, /openSectionRequest\?\.nonce/);
  assert.match(source, /setActiveSection\(openSectionRequest\.section\)/);
  assert.match(source, /closest\("\.active-task-layout"\)/);
  assert.match(source, /dataset\.workspaceIslandOpen/);
  assert.match(source, /--workspace-island-panel-width/);
});

test("adaptive workspace island exposes only factual section controls", async () => {
  const source = await readFile(componentPath, "utf8");
  assert.match(source, /className="workspace-island-rail"/);
  assert.match(source, /aria-label=\{t\(section\.labelKey\)\}/);
  assert.match(source, /aria-pressed=\{activeSection === section\.id\}/);
  assert.match(source, /role="region"/);
  assert.doesNotMatch(source, /terminal/i);
});

test("workspace island geometry keeps a fixed rail and bounded resizable panel", async () => {
  const styles = await readFile(stylesPath, "utf8");
  assert.match(styles, /--workspace-island-panel-width:\s*340px/);
  assert.match(styles, /grid-template-columns:\s*minmax\(280px,\s*var\(--workspace-island-panel-width\)\)\s*40px/);
  assert.match(styles, /\.workspace-island-rail-button\s*\{[\s\S]*?width:\s*30px[\s\S]*?height:\s*30px/);
  assert.match(styles, /@media\s*\(max-width:\s*900px\)/);
});

test("workspace island and live computer dock are mutually exclusive overlays", async () => {
  const [styles, chatView] = await Promise.all([
    readFile(stylesPath, "utf8"),
    readFile(chatViewPath, "utf8"),
  ]);
  assert.match(styles, /\.active-task-layout\[data-workspace-island-open="true"\]\s+\.chat-computer-runtime\s*\{[\s\S]*?display:\s*none;/);
  assert.doesNotMatch(
    styles,
    /\.active-task-layout\[data-workspace-island-open="true"\]\s+\.chat-computer-runtime\s*\{[\s\S]*?right:\s*calc/,
  );
  assert.match(chatView, /openSectionRequest=\{\{ section: "activity", nonce: activityNonce \}\}/);
});

test("adaptive island is the only workspace status owner", async () => {
  const [chatView, legacyStyles, main] = await Promise.all([
    readFile(chatViewPath, "utf8"),
    readFile(legacyStylesPath, "utf8"),
    readFile(mainPath, "utf8"),
  ]);
  assert.match(chatView, /<AdaptiveWorkspaceIsland/);
  assert.doesNotMatch(
    chatView,
    /from "\.\/WorkspaceIsland"|<WorkspaceIsland\b|chat-status-stack|islandOpen/,
  );
  assert.doesNotMatch(
    legacyStyles,
    /\.chat-status-stack|\.unified-status-panel|\.workspace-island-pill|\.workspace-island-panel|--island-reserve/,
  );
  assert.match(main, /styles\/workspace-island\.css/);
});
