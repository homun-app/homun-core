// User-customizable brand accent. The whole UI reads --brand / --blue (aliased), so
// overriding these CSS variables at runtime re-tints the entire app. The strong/soft
// variants are DERIVED from the chosen colour so a single hex drives a coherent set.

export const DEFAULT_ACCENT = "#157a6e"; // teal — Homun brand

export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: "Teal", hex: "#157a6e" },
  { name: "Indigo", hex: "#4f66e0" },
  { name: "Terracotta", hex: "#c2683c" },
  { name: "Amber", hex: "#c9881e" },
  { name: "Green", hex: "#25785a" },
  { name: "Blue", hex: "#2a7fb8" },
  { name: "Violet", hex: "#7c5cff" },
  { name: "Rose", hex: "#e93d82" },
  { name: "Graphite", hex: "#52525b" },
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

// ── Saved custom accents ──────────────────────────────────────────────────────
// The user's own colours, kept as pills next to the presets. Persisted as a JSON
// list of normalized hex strings.
const CUSTOM_KEY = "homun.accent.custom";

export function normalizeHex(hex: string): string {
  const h = (hex.startsWith("#") ? hex : `#${hex}`).toLowerCase();
  // Expand #abc → #aabbcc so equality checks against presets are consistent.
  if (/^#[0-9a-f]{3}$/.test(h)) {
    return "#" + h.slice(1).split("").map((c) => c + c).join("");
  }
  return h;
}

export function loadCustomAccents(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr
        .filter((x): x is string => typeof x === "string" && isValidHex(x))
        .map(normalizeHex);
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function saveCustomAccents(list: string[]): void {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

// ── Surface theme (neutral palette). Orthogonal to the accent: this only swaps the
// background/line/text neutrals, while the accent (brand) stays as chosen — exactly the
// two-axis model the design's palette board uses ("posso mixare … neutro + teal").
// Sets data-theme on <html>; the [data-theme="…"] blocks in styles.css do the rest.
export type ThemeName = "freddo" | "avorio" | "neutro" | "sabbia";

export const DEFAULT_THEME: ThemeName = "freddo";

export const THEME_PRESETS: { name: ThemeName; label: string; hint: string }[] = [
  { name: "freddo", label: "Cold", hint: "Cool gray" },
  { name: "avorio", label: "Ivory", hint: "Warm neutral" },
  { name: "neutro", label: "Neutral", hint: "True grays" },
  { name: "sabbia", label: "Sand", hint: "Warm sand" },
];

const THEME_KEY = "homun.theme";

function isThemeName(value: string): value is ThemeName {
  return value === "freddo" || value === "avorio" || value === "neutro" || value === "sabbia";
}

/** Set the surface theme by toggling <html data-theme>. */
export function applyTheme(name: ThemeName): void {
  document.documentElement.setAttribute("data-theme", name);
}

export function loadTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved && isThemeName(saved)) return saved;
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME;
}

export function saveTheme(name: ThemeName): void {
  try {
    localStorage.setItem(THEME_KEY, name);
  } catch {
    /* ignore */
  }
  applyTheme(name);
}

/** Apply the persisted surface theme at startup (before first paint, no flash). */
export function initTheme(): void {
  applyTheme(loadTheme());
}
