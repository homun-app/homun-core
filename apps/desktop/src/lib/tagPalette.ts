// Curated tag color palette. A fixed, tasteful set (not a free color picker) keeps the sidebar
// minimal and the colors legible on both the light and dark surfaces — the design principle is
// "essential, not cluttered". The brand teal leads; the rest are muted, evenly-spaced hues.
export const TAG_PALETTE: readonly string[] = [
  "#157a6e", // brand teal
  "#4b7bd6", // blue
  "#8b5cf6", // violet
  "#d1567f", // pink
  "#d1544f", // red
  "#d99b3d", // amber
  "#3f9e6f", // green
  "#64748b", // slate
] as const;

export const DEFAULT_TAG_COLOR = TAG_PALETTE[0];
