import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INITIAL_SCROLL_ANCHOR,
  nextScrollAnchor,
  type ScrollAnchorState,
} from "../apps/web/src/lib/chat-autoscroll-policy.ts";

const content = (pinned: boolean, lastIsOwn = false) =>
  ({ kind: "content", pinned, lastIsOwn }) as const;

function from(over: Partial<ScrollAnchorState>): ScrollAnchorState {
  return { ...INITIAL_SCROLL_ANCHOR, ...over };
}

test("switching work lands on the newest message with one instant jump", () => {
  const result = nextScrollAnchor(from({ pinned: false }), { kind: "work" });
  assert.deepEqual(result, {
    state: { pinned: true, awaitingContent: true },
    action: "jump",
  });
});

test("the first content of a work lands instantly, even mid-read on the previous one", () => {
  const afterSwitch = nextScrollAnchor(INITIAL_SCROLL_ANCHOR, { kind: "work" });
  const result = nextScrollAnchor(afterSwitch.state, content(false));
  assert.deepEqual(result, {
    state: { pinned: true, awaitingContent: false },
    action: "jump",
  });
});

test("new content follows only while the reader is anchored to the bottom", () => {
  const anchored = nextScrollAnchor(from({}), content(true));
  assert.equal(anchored.action, "follow");

  const reading = nextScrollAnchor(from({ pinned: false }), content(false));
  assert.equal(reading.action, "none");
  assert.equal(reading.state.pinned, false);
});

test("uploads and refreshes never yank a reader who scrolled above", () => {
  // Simulate: reader anchored, scrolls up (pinned=false), then a refresh
  // replaces the transcript with a longer one.
  let state = from({});
  state = nextScrollAnchor(state, { kind: "work" }).state;
  state = nextScrollAnchor(state, content(false)).state;
  const scrolledUp = nextScrollAnchor(state, content(false));
  assert.equal(scrolledUp.action, "none");
  const refreshed = nextScrollAnchor(scrolledUp.state, content(false, false));
  assert.equal(refreshed.action, "none");
});

test("the reader's own outgoing message always follows", () => {
  const result = nextScrollAnchor(from({ pinned: false }), content(false, true));
  assert.equal(result.action, "follow");
  assert.equal(result.state.pinned, true);
});

test("scrolling back to the bottom re-anchors following", () => {
  let state = from({ pinned: false });
  state = nextScrollAnchor(state, content(false)).state;
  assert.equal(state.pinned, false);
  state = nextScrollAnchor(state, content(true)).state;
  assert.equal(state.pinned, true);
  assert.equal(nextScrollAnchor(state, content(true)).action, "follow");
});
