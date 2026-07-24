/**
 * Pure geometry for a bottom-anchored virtualized transcript.
 *
 * Why bottom-anchored: a chat sticks to the BOTTOM while it streams, and the
 * entry that grows is the last one. Expressed in scrollTop, every measurement
 * that lands shifts the anchor and the viewport jumps; expressed as a distance
 * from the bottom, the tail can grow without moving anything the reader is
 * looking at. Kept as pure functions (no DOM) so the geometry is testable and
 * the control flow stays in code.
 */
export const DEFAULT_ESTIMATED_HEIGHT_PX = 280;

export function buildLayout({ entries, gapPx, measuredHeightsByKey }) {
  const heightsPx = [];
  const topOffsetsPx = [];
  const turnIndexByKey = new Map();
  const turnKeys = [];
  let cursor = 0;

  entries.forEach((entry, index) => {
    const key = entry.turnKey;
    const height =
      measuredHeightsByKey[key] ?? entry.estimatedHeightPx ?? DEFAULT_ESTIMATED_HEIGHT_PX;
    turnIndexByKey.set(key, index);
    turnKeys.push(key);
    topOffsetsPx.push(cursor);
    heightsPx.push(height);
    cursor += height;
    if (index < entries.length - 1) cursor += gapPx;
  });

  const totalHeightPx = cursor;
  const bottomOffsetsPx = topOffsetsPx.map(
    (top, index) => totalHeightPx - top - (heightsPx[index] ?? 0),
  );

  return { bottomOffsetsPx, heightsPx, topOffsetsPx, totalHeightPx, turnIndexByKey, turnKeys };
}

export function visibleRange({ distanceFromBottomPx, layout, overscanCount, viewportHeightPx }) {
  if (layout.turnKeys.length === 0) return { startIndex: 0, endIndex: 0 };
  const low = Math.min(Math.max(0, distanceFromBottomPx), layout.totalHeightPx);
  const high = Math.min(low + Math.max(0, viewportHeightPx), layout.totalHeightPx);
  const lastVisible = firstIndexBelow(layout.bottomOffsetsPx, high);
  const firstVisible = firstIndexFullyAbove(layout.bottomOffsetsPx, layout.heightsPx, low);
  return {
    startIndex: Math.max(0, lastVisible - overscanCount),
    endIndex: Math.min(layout.turnKeys.length, Math.max(firstVisible, lastVisible + 1) + overscanCount),
  };
}

/// Entries are ordered by DECREASING bottom offset, so a binary search finds the
/// first one whose bottom offset is under `value`.
function firstIndexBelow(bottomOffsetsPx, value) {
  let low = 0;
  let high = bottomOffsetsPx.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((bottomOffsetsPx[mid] ?? 0) < value) high = mid;
    else low = mid + 1;
  }
  return low;
}

function firstIndexFullyAbove(bottomOffsetsPx, heightsPx, value) {
  let low = 0;
  let high = bottomOffsetsPx.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((bottomOffsetsPx[mid] ?? 0) + (heightsPx[mid] ?? 0) <= value) high = mid;
    else low = mid + 1;
  }
  return low;
}
