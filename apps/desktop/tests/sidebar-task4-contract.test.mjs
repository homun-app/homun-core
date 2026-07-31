import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const sidebar = await readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
const sidebarFilters = await readFile(
  new URL("../src/components/SidebarFilters.tsx", import.meta.url),
  "utf8",
);
const menuSurface = await readFile(
  new URL("../src/components/ui/MenuSurface.tsx", import.meta.url),
  "utf8",
);
const sidebarStyles = await readFile(new URL("../src/styles/sidebar.css", import.meta.url), "utf8");
const legacyStyles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const locales = await Promise.all(
  ["de", "en", "es", "fr", "it"].map(async (locale) => ({
    locale,
    messages: JSON.parse(await readFile(
      new URL(`../src/i18n/locales/${locale}.json`, import.meta.url),
      "utf8",
    )),
  })),
);

test("unarchive routes the owning workspace and isolates nonactive project snapshots", () => {
  assert.match(sidebar, /onUnarchiveChatThread\([^,]+,\s*workspaceId\)/);
  assert.match(sidebar, /mergeSidebarUnarchiveResult/);
  assert.match(app, /const ownerIsActive = sidebarWorkspaceIsActive\(/);
  assert.match(app, /if \(ownerIsActive\) \{\s*await applyThreadSnapshot/);
});

test("computed thread projections do not expose chat-row drag persistence", () => {
  assert.doesNotMatch(sidebar, /handlePersonalThreadsDragEnd/);
  assert.doesNotMatch(sidebar, /handleProjectThreadsDragEnd/);
  assert.doesNotMatch(sidebar, /reorderChatThreads/);
});

test("persisted channels and localized active-count labels feed SidebarFilters", () => {
  assert.match(sidebarFilters, /sidebarChannelOptions\(availableChannels, filter\.channels\)/);
  assert.match(sidebarFilters, /t\("filters\.activeCount", \{ count \}\)/);
  assert.doesNotMatch(sidebarFilters, /sidebarFilterBadgeModel\(count, t\("filters\.label"\)\)/);
  for (const { locale, messages } of locales) {
    assert.match(messages.filters.activeCount_one ?? "", /\{\{count\}\}/, `${locale} singular`);
    assert.match(messages.filters.activeCount_other ?? "", /\{\{count\}\}/, `${locale} plural`);
  }
});

test("sibling submenu cleanup uses the tested deepest-portal focus decision", () => {
  assert.match(menuSurface, /shouldRestoreMenuFocus\(parentId, portalIds\)/);
});

test("sidebar group labels use a theme token with at least 4.5 to 1 contrast", () => {
  const groupRule = sidebarStyles.match(/\.sidebar-thread-group__label\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(groupRule, /color:\s*var\(--muted\)/);
  assert.doesNotMatch(groupRule, /var\(--faint\)/);

  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((value) => Number.parseInt(value, 16) / 255);
    const linear = channels.map((value) => (
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    ));
    return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
  };
  const ratio = (left, right) => (
    (Math.max(luminance(left), luminance(right)) + 0.05)
    / (Math.min(luminance(left), luminance(right)) + 0.05)
  );
  const themeBlocks = [
    legacyStyles.match(/:root\s*\{[\s\S]*?\n\}/)?.[0],
    ...Array.from(legacyStyles.matchAll(/:root\[data-theme="[^"]+"\]\s*\{[\s\S]*?\n\}/g), (match) => match[0]),
  ].filter(Boolean);
  assert.equal(themeBlocks.length, 5);
  for (const block of themeBlocks) {
    const muted = block.match(/--muted:\s*(#[0-9a-f]{6})/i)?.[1];
    const panel = block.match(/--panel:\s*(#[0-9a-f]{6})/i)?.[1];
    assert.ok(muted && panel);
    assert.ok(ratio(muted, panel) >= 4.5, `${muted} on ${panel} must meet 4.5:1`);
  }
});
