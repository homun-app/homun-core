/**
 * Pure policy for chat auto-scroll (Fonte=motore + simulazione).
 *
 * Guarantees encoded here and asserted by tests:
 * - Switching work lands on the newest message with one instant jump (never a
 *   chained smooth scroll across a content swap).
 * - Content that arrives or reloads while the work is open only follows when
 *   the reader is anchored to the bottom: uploads, refreshes and completions
 *   never yank someone who is reading above.
 * - The reader's own outgoing message always follows (they just acted).
 */
export type ScrollAnchorState = {
  /** Reader is within the pin threshold of the bottom. */
  pinned: boolean;
  /** Waiting for the first content of the current work. */
  awaitingContent: boolean;
};

export type ScrollAnchorEvent =
  | { kind: "work" }
  | { kind: "content"; pinned: boolean; lastIsOwn: boolean };

export type ScrollAction = "none" | "jump" | "follow";

export const INITIAL_SCROLL_ANCHOR: ScrollAnchorState = {
  pinned: true,
  awaitingContent: false,
};

/** Distance from the bottom (px) that still counts as anchored. */
export const SCROLL_PIN_THRESHOLD_PX = 96;

export function nextScrollAnchor(
  state: ScrollAnchorState,
  event: ScrollAnchorEvent,
): { state: ScrollAnchorState; action: ScrollAction } {
  if (event.kind === "work") {
    return {
      state: { pinned: true, awaitingContent: true },
      // The container is switching content: land at the bottom instantly.
      action: "jump",
    };
  }
  if (state.awaitingContent) {
    return {
      state: { pinned: true, awaitingContent: false },
      action: "jump",
    };
  }
  if (event.pinned || event.lastIsOwn) {
    return {
      state: { pinned: true, awaitingContent: false },
      action: "follow",
    };
  }
  return {
    state: { pinned: false, awaitingContent: false },
    action: "none",
  };
}

/** Anchored-to-bottom check for a scrollable element (thin DOM wrapper). */
export function isPinnedToBottom(element: HTMLElement): boolean {
  const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
  return distance <= SCROLL_PIN_THRESHOLD_PX;
}
