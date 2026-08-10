import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const scrollHook = readFileSync(join(here, "..", "src", "components", "useChatConversationScroll.ts"), "utf8");
const styles = readFileSync(join(here, "..", "src", "styles.css"), "utf8");
const chatStyles = readFileSync(join(here, "..", "src", "styles", "chat.css"), "utf8");

test("the streaming auto-scroll is instant, never animated", () => {
  // `behavior: "auto"` RESOLVES to the element's computed scroll-behavior. With
  // `smooth` on .thread-scroll, every rAF flush restarted a scroll animation the
  // next frame cancelled — the viewport permanently trailed the text.
  assert.match(
    scrollHook,
    /afterStreamingFramePaint\s*=\s*useCallback\(\(\)\s*=>\s*\{[\s\S]*?scrollConversationToBottomIfPinned\("instant"\);/,
    "afterStreamingFramePaint must scroll with instant",
  );
});

test("the thread scroller does not declare smooth scroll-behavior", () => {
  // Anchored at line start: a plain `.thread-scroll {` lookup would land on the
  // compound `... > .thread-scroll {` layout rule that appears earlier in the
  // sheet and the assertion would pass vacuously.
  const rule = /^\.thread-scroll \{([^}]*)\}/m.exec(styles);
  assert.ok(rule, "the .thread-scroll rule must exist");
  assert.doesNotMatch(rule[1], /scroll-behavior:\s*smooth/, ".thread-scroll must not be smooth");
});

test("the explicit jump-to-bottom button stays smooth", () => {
  assert.match(scrollHook, /scrollConversationToBottom\("smooth"\)/, "the manual jump stays animated");
});

/**
 * Body of the rule whose selector list is EXACTLY `selector`, anchored at a line
 * start. Matching the whole selector list (not a substring) keeps these
 * assertions from passing vacuously against some other rule in a 17k-line sheet.
 */
function ruleBody(css, selector) {
  const marker = `\n${selector} {`;
  const start = css.indexOf(marker);
  if (start < 0) return null;
  const open = start + marker.length;
  const end = css.indexOf("}", open);
  return end < 0 ? null : css.slice(open, end);
}

const visibleTranscriptRows =
  ".thread-message-list > .thread-message-row:last-child,\n" +
  ".thread-message-list > .thread-message-row:has(.message-action-menu),\n" +
  ".thread-message-list > .thread-message-row:has(.memory-usage-popover)";

test("off-screen transcript rows are skipped by the renderer", () => {
  // content-visibility lets the compositor skip layout/paint/style for rows
  // outside the viewport; contain-intrinsic-size keeps the scrollbar honest.
  // The selector must be the REAL row element: `.message` is an <article>
  // nested inside `.thread-message-row`, so `.thread-message-list > .message`
  // would match nothing at all and the win would be silently zero.
  const body = ruleBody(chatStyles, ".thread-message-list > .thread-message-row");
  assert.ok(body, "the transcript row must declare skippable content");
  assert.match(body, /content-visibility:\s*auto/);
  // `auto <size>`: the placeholder height is only the first guess — the browser
  // remembers each row's real rendered height, so the scrollbar stops lying
  // after the row has been on screen once.
  assert.match(body, /contain-intrinsic-size:\s*auto\s+280px/);
});

test("the streaming row is never skipped", () => {
  // The last row is the one being written into: a placeholder height fighting
  // its real, growing height would make the bottom-pinned scroll oscillate.
  const body = ruleBody(chatStyles, visibleTranscriptRows);
  assert.ok(body, "the last row must opt out of skipping");
  assert.match(body, /content-visibility:\s*visible/);
  assert.match(body, /contain-intrinsic-size:\s*none/);
});

test("a row with an open overlay is not paint-contained", () => {
  // content-visibility: auto applies layout/style/PAINT containment at all
  // times, not only while the row is skipped — and paint containment clips to
  // the row's own box. `.message-action-menu` (drops up to 360px below the
  // action bar) and `.memory-usage-popover` (opens 320px above the footer
  // badge) are absolutely positioned descendants that deliberately overflow the
  // row, so containment would shear them off. Both are rendered only while
  // open, which is exactly what `:has()` keys on: the exemption costs one row,
  // and only while it actually has an overlay up.
  const body = ruleBody(chatStyles, visibleTranscriptRows);
  assert.ok(body, "a row with an open menu or popover must drop the containment");
  assert.match(body, /content-visibility:\s*visible/);
});
