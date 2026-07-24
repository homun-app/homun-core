import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const chatView = readFileSync(join(here, "..", "src", "components", "ChatView.tsx"), "utf8");
const styles = readFileSync(join(here, "..", "src", "styles.css"), "utf8");

test("the streaming auto-scroll is instant, never animated", () => {
  // `behavior: "auto"` RESOLVES to the element's computed scroll-behavior. With
  // `smooth` on .thread-scroll, every rAF flush restarted a scroll animation the
  // next frame cancelled — the viewport permanently trailed the text.
  assert.match(
    chatView,
    /function afterStreamingFramePaint\(\)\s*\{\s*scrollConversationToBottomIfPinned\("instant"\);/,
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
  assert.match(chatView, /scrollConversationToBottom\("smooth"\)/, "the manual jump stays animated");
});
