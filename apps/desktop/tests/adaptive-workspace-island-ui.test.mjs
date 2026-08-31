import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const componentPath = new URL(
  "../src/components/AdaptiveWorkspaceIsland.tsx",
  import.meta.url,
);
const stylesPath = new URL("../src/styles/workspace-island.css", import.meta.url);
const chatWorkspaceDockPath = new URL(
  "../src/components/ChatWorkspaceDock.tsx",
  import.meta.url,
);
const legacyStylesPath = new URL("../src/styles.css", import.meta.url);
const mainPath = new URL("../src/main.tsx", import.meta.url);

test("adaptive workspace island is collapsed by default and resets per thread", async () => {
  const source = await readFile(componentPath, "utf8");
  assert.match(source, /useState<WorkspaceSectionId\s*\|\s*null>\(null\)/);
  assert.match(source, /setActiveSection\(null\)[\s\S]*?\[threadId\]/);
  assert.match(source, /workspaceSectionSelection\(activeSection,\s*section\.id\)/);
  assert.match(source, /selection\.browserDockRequested[\s\S]*?onOpenBrowserDock\?\.\(\)/);
  assert.match(source, /openSectionRequest\?\.nonce/);
  assert.match(source, /setActiveSection\(openSectionRequest\.section\)/);
  assert.match(source, /closest\("\.active-task-layout"\)/);
  assert.match(source, /dataset\.workspaceIslandOpen/);
  assert.match(source, /--workspace-island-panel-width/);
});

// There is no DOM rendering harness in this package (tests are source contracts),
// so the two overlap/persistence bugs are pinned by asserting the exact
// mechanisms that guarantee the runtime behaviour.
test("open-section request is consumed once per nonce so closing persists across re-renders", async () => {
  const source = await readFile(componentPath, "utf8");
  // A ref tracks the last consumed nonce.
  assert.match(source, /lastConsumedNonceRef\s*=\s*useRef<number\s*\|\s*null>\(null\)/);
  // The requested section is applied only when the nonce is new...
  assert.match(source, /openSectionRequest\.nonce\s*!==\s*lastConsumedNonceRef\.current/);
  // ...and the nonce is recorded on apply so a changed `sections` identity on a
  // later render cannot re-open the section and override a manual close.
  assert.match(source, /lastConsumedNonceRef\.current\s*=\s*openSectionRequest\.nonce/);
  assert.match(source, /lastConsumedNonceRef\.current[\s\S]*?setActiveSection\(openSectionRequest\.section\)/);
});

test("mutual-exclusion flag is resolved at runtime so it is written even when sections load async", async () => {
  const source = await readFile(componentPath, "utf8");
  // The dataset-writing effect re-resolves the surrounding layout via closest()
  // (instead of a stale mount-time ref) and writes the flag, keyed on
  // activeSection/disabled. This ensures the flag is written when the island
  // opens even if it mounted with empty sections initially.
  assert.match(
    source,
    /shellRef\.current\?\.closest\("\.active-task-layout"\)[\s\S]*?layout\.dataset\.workspaceIslandOpen\s*=[\s\S]*?\}, \[activeSection, disabled\]\);/,
  );
  // Cleanup removes the flag from the resolved layout on unmount.
  assert.match(
    source,
    /return \(\) => \{[\s\S]*?const layout = layoutRef\.current;[\s\S]*?delete layout\.dataset\.workspaceIslandOpen;/,
  );
});

test("dataset effect falls back to the cached layout so the flag resets while the aside is unmounted", async () => {
  const source = await readFile(componentPath, "utf8");
  // When `disabled` flips to true or `sections` empties, the component returns
  // null and shellRef is detached. The dataset effect must fall back to the
  // cached layoutRef (populated on the first successful resolution) so
  // data-workspace-island-open is still reset to "false" and the computer dock
  // is not kept hidden by the CSS mutual-exclusion rule.
  assert.match(
    source,
    /\(shellRef\.current\?\.closest\("\.active-task-layout"\) as HTMLElement \| null\)\s*\?\?\s*layoutRef\.current/,
  );
  // The fallback feeds the same cached ref the write and the unmount cleanup use.
  assert.match(
    source,
    /\?\?\s*layoutRef\.current;[\s\S]*?layoutRef\.current = layout;[\s\S]*?layout\.dataset\.workspaceIslandOpen\s*=\s*!disabled && activeSection \? "true" : "false";[\s\S]*?\}, \[activeSection, disabled\]\);/,
  );
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
  assert.match(styles, /grid-template-columns:\s*minmax\(280px,\s*var\(--workspace-island-panel-width\)\)\s*24px/);
  assert.match(styles, /\.workspace-island-rail-button\s*\{[\s\S]*?width:\s*16px[\s\S]*?height:\s*16px/);
  assert.match(styles, /@media\s*\(max-width:\s*900px\)/);
});

test("workspace island and live computer dock are mutually exclusive overlays", async () => {
  const [styles, dock] = await Promise.all([
    readFile(stylesPath, "utf8"),
    readFile(chatWorkspaceDockPath, "utf8"),
  ]);
  assert.match(styles, /\.active-task-layout\[data-workspace-island-open="true"\]\s+\.chat-computer-runtime\s*\{[\s\S]*?display:\s*none;/);
  assert.doesNotMatch(
    styles,
    /\.active-task-layout\[data-workspace-island-open="true"\]\s+\.chat-computer-runtime\s*\{[\s\S]*?right:\s*calc/,
  );
  // The island moved into ChatWorkspaceDock during the dock refactor; it now
  // receives the activity open-section request via the openActivityNonce prop.
  assert.match(dock, /openSectionRequest=\{\{ section: "activity", nonce: openActivityNonce \}\}/);
});

test("adaptive island is the only workspace status owner", async () => {
  const [dock, legacyStyles, main] = await Promise.all([
    readFile(chatWorkspaceDockPath, "utf8"),
    readFile(legacyStylesPath, "utf8"),
    readFile(mainPath, "utf8"),
  ]);
  // The adaptive island is now rendered by ChatWorkspaceDock (ChatView delegates
  // to it). Assert the dock renders the island and carries no legacy status code.
  assert.match(dock, /<AdaptiveWorkspaceIsland/);
  assert.doesNotMatch(
    dock,
    /from "\.\/WorkspaceIsland"|<WorkspaceIsland\b|chat-status-stack|islandOpen/,
  );
  assert.doesNotMatch(
    legacyStyles,
    /\.chat-status-stack|\.unified-status-panel|\.workspace-island-pill|\.workspace-island-panel|--island-reserve/,
  );
  assert.match(main, /styles\/workspace-island\.css/);
});
