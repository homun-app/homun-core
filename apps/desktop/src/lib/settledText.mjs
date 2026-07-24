/**
 * Pure decision behind `useSettledCode`: what the settled value becomes given the
 * current text, the previously settled text, and how long the current text has
 * been quiet. Kept pure so the timing policy is testable without a DOM, and so
 * the hook and the test exercise the SAME rule rather than two copies of it.
 *
 * WHY it exists: a code fence that is still streaming grows on every rAF flush,
 * and syntax-highlighting re-tokenizes the whole (growing) block each time —
 * O(len) per frame, O(len²) per fence. Only a block that has stopped growing is
 * worth highlighting.
 *
 * `settled === undefined` means "nothing settled yet" — the first value is
 * accepted immediately so a finished message never waits to render.
 */
export function nextSettledValue({ current, settled, elapsedMs, quietMs }) {
  if (settled === undefined) return current;
  if (current === settled) return settled;
  return elapsedMs >= quietMs ? current : settled;
}
