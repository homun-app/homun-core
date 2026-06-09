// User-customizable brand accent. The whole UI reads --brand / --blue (aliased), so
// overriding these CSS variables at runtime re-tints the entire app. The strong/soft
// variants are DERIVED from the chosen colour so a single hex drives a coherent set.

export const DEFAULT_ACCENT = "#dd6b20"; // homün orange

export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: "Arancione", hex: "#dd6b20" },
  { name: "Ambra", hex: "#d97706" },
  { name: "Rosso", hex: "#e5484d" },
  { name: "Rosa", hex: "#e93d82" },
  { name: "Viola", hex: "#7c5cff" },
  { name: "Blu", hex: "#0a84ff" },
  { name: "Ciano", hex: "#0891b2" },
  { name: "Verde", hex: "#16a34a" },
  { name: "Grafite", hex: "#52525b" },
];

const STORAGE_KEY = "homun.accent";

function clamp(n: number): number {
  return Math.round(Math.max(0, Math.min(255, n)));
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((x) => clamp(x).toString(16).padStart(2, "0")).join("");
}

// f in [0,1]: darken toward black.
function darken([r, g, b]: [number, number, number], f: number): string {
  return rgbToHex(r * (1 - f), g * (1 - f), b * (1 - f));
}

// f in [0,1]: tint toward white (for soft backgrounds).
function tint([r, g, b]: [number, number, number], f: number): string {
  return rgbToHex(r + (255 - r) * f, g + (255 - g) * f, b + (255 - b) * f);
}

export function isValidHex(hex: string): boolean {
  return /^#?[0-9a-fA-F]{6}$/.test(hex.trim()) || /^#?[0-9a-fA-F]{3}$/.test(hex.trim());
}

/** Override the brand CSS variables on :root from a single base colour. */
export function applyAccent(hex: string): void {
  if (!isValidHex(hex)) return;
  const normalized = hex.startsWith("#") ? hex : `#${hex}`;
  const rgb = hexToRgb(normalized);
  const strong = darken(rgb, 0.14);
  const soft = tint(rgb, 0.88);
  const root = document.documentElement.style;
  root.setProperty("--brand", normalized);
  root.setProperty("--brand-strong", strong);
  root.setProperty("--brand-soft", soft);
  // The app still references --blue in many rules → keep it aliased to the accent.
  root.setProperty("--blue", normalized);
  root.setProperty("--blue-soft", soft);
}

export function loadAccent(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && isValidHex(saved)) return saved.startsWith("#") ? saved : `#${saved}`;
  } catch {
    /* ignore */
  }
  return DEFAULT_ACCENT;
}

export function saveAccent(hex: string): void {
  const normalized = hex.startsWith("#") ? hex : `#${hex}`;
  try {
    localStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    /* ignore */
  }
  applyAccent(normalized);
}

/** Apply the persisted accent at startup (before first paint, no flash). */
export function initAccent(): void {
  applyAccent(loadAccent());
}
