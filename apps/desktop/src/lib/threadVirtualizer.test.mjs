import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ESTIMATED_HEIGHT_PX,
  buildLayout,
  visibleRange,
} from "./threadVirtualizer.mjs";

const entries = [
  { turnKey: "t1" },
  { turnKey: "t2", estimatedHeightPx: 100 },
  { turnKey: "t3" },
];

test("layout stacks heights with gaps and exposes bottom-anchored offsets", () => {
  const layout = buildLayout({ entries, gapPx: 10, measuredHeightsByKey: { t3: 50 } });
  assert.deepEqual(layout.heightsPx, [DEFAULT_ESTIMATED_HEIGHT_PX, 100, 50]);
  // 280 + 10 + 100 + 10 + 50
  assert.equal(layout.totalHeightPx, 450);
  assert.deepEqual(layout.topOffsetsPx, [0, 290, 400]);
  // Distance from the BOTTOM of the content to the bottom of each entry: this is
  // the coordinate stick-to-bottom is expressed in, so growth at the tail does
  // not shift the anchor of everything above it.
  assert.deepEqual(layout.bottomOffsetsPx, [170, 60, 0]);
  assert.equal(layout.turnIndexByKey.get("t2"), 1);
});

test("a measured height wins over the estimate", () => {
  const layout = buildLayout({ entries, gapPx: 0, measuredHeightsByKey: { t1: 7 } });
  assert.equal(layout.heightsPx[0], 7);
});

test("at the bottom only the tail entries are visible, plus overscan", () => {
  const layout = buildLayout({ entries, gapPx: 0, measuredHeightsByKey: {} });
  const range = visibleRange({
    distanceFromBottomPx: 0,
    layout,
    overscanCount: 0,
    viewportHeightPx: 280,
  });
  assert.equal(range.endIndex, 3);
  assert.equal(range.startIndex, 2);
});

test("overscan widens the range without escaping the bounds", () => {
  const layout = buildLayout({ entries, gapPx: 0, measuredHeightsByKey: {} });
  const range = visibleRange({
    distanceFromBottomPx: 0,
    layout,
    overscanCount: 5,
    viewportHeightPx: 280,
  });
  assert.equal(range.startIndex, 0);
  assert.equal(range.endIndex, 3);
});

test("an empty transcript yields an empty range instead of throwing", () => {
  const layout = buildLayout({ entries: [], gapPx: 10, measuredHeightsByKey: {} });
  assert.equal(layout.totalHeightPx, 0);
  assert.deepEqual(visibleRange({
    distanceFromBottomPx: 0,
    layout,
    overscanCount: 3,
    viewportHeightPx: 500,
  }), { startIndex: 0, endIndex: 0 });
});

// Scrolled back into the middle of the transcript: the window must be an
// interior slice, excluding BOTH the head and the tail. This is the case that
// distinguishes real virtualization from "always render the last N".
//
// Five 100px entries, no gap => totalHeightPx 500, bottomOffsetsPx
// [400, 300, 200, 100, 0]. Each entry i covers the distance-from-bottom band
// [bottom_i, bottom_i + 100]. With distanceFromBottomPx 150 and a 100px
// viewport the visible band is [150, 250], which overlaps only:
//   e2 -> [200, 300]  (overlap 200..250)
//   e3 -> [100, 200]  (overlap 150..200)
// e0 [400,500], e1 [300,400] and the tail e4 [0,100] are all outside.
test("mid-scroll returns an interior window, not the tail", () => {
  const midEntries = [
    { turnKey: "m0" },
    { turnKey: "m1" },
    { turnKey: "m2" },
    { turnKey: "m3" },
    { turnKey: "m4" },
  ];
  const layout = buildLayout({
    entries: midEntries,
    gapPx: 0,
    measuredHeightsByKey: { m0: 100, m1: 100, m2: 100, m3: 100, m4: 100 },
  });
  assert.equal(layout.totalHeightPx, 500);
  assert.deepEqual(layout.bottomOffsetsPx, [400, 300, 200, 100, 0]);

  const range = visibleRange({
    distanceFromBottomPx: 150,
    layout,
    overscanCount: 0,
    viewportHeightPx: 100,
  });
  assert.deepEqual(range, { startIndex: 2, endIndex: 4 });
});
