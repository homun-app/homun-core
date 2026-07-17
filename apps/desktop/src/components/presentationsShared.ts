import type { BrandKit, TemplateCatalogEntry } from "../lib/coreBridge";

// Shared, side-effect-free helpers for the Presentations studio surface.
// Extracted so BrandChip / BrandDrawer / TemplateGallery / TemplateCard can
// each stay focused without a circular import through BrandKitPanel.

export const TEMPLATE_CATEGORY_ORDER = [
  "pitch_sales",
  "cv_career",
  "report_update",
  "catalog_marketing",
  "other",
] as const;

export function categoryLabelKey(category: string): string {
  const known = (TEMPLATE_CATEGORY_ORDER as readonly string[]).includes(category);
  return `presentations:category_${known ? category : "other"}`;
}

// Editorial themes whose SURFACE is dark. The live brand recolor only overrides
// --brand/--accent (not --surface), so a dark user brand on a dark surface makes
// accents/eyebrows/KPI vanish — skip recolor for these packs (see brandPreviewOverride caller).
export const DARK_SURFACE_THEMES = new Set(["editorial_noir", "editorial_bold"]);

export const DEFAULT_KIT: BrandKit = {
  organization: "",
  primary_color: "#2b6cb0",
  secondary_color: "#1a202c",
  accent_color: "#ed8936",
  heading_font: "Inter",
  body_font: "Inter",
  logo_data_url: "",
};

/** EN-canonical catalog + flat Italian override: the reply-language contract for
 *  the catalog surface (Settings language only picks which string to show). */
export function templateDisplayName(entry: TemplateCatalogEntry, language: string): string {
  return language.startsWith("it") && entry.name_it ? entry.name_it : entry.name;
}

export function templateDisplayDescription(entry: TemplateCatalogEntry, language: string): string {
  return language.startsWith("it") && entry.description_it
    ? entry.description_it
    : entry.description;
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;

/** Free-text colour inputs share the same state key as the <input type="color">
 *  picker (BrandDrawer's COLOR_KEYS wires both to one `onChange(key, value)`),
 *  so a hand-typed value never gets the picker's implicit #hex coercion. A malformed value
 *  (e.g. `red}</style><img src=x onerror=...>`) must not reach the injected
 *  <style> block below — validate against the grammar the CSS var expects and
 *  fall back to the shipped default rather than passing free text through raw. */
export function safeColor(value: string, fallback: string): string {
  return HEX_COLOR_PATTERN.test(value) ? value : fallback;
}

/** Fonts have no picker — they're always free text. Strip everything but the
 *  charset a font-family token legitimately needs, which also closes off the
 *  tag/quote/comment breakout the single-quote-only strip used to miss. */
export function safeFont(value: string): string {
  return value.replace(/[^A-Za-z0-9 _-]/g, "");
}

/** Live brand recolor for catalog previews. The renderer HTML is parametric
 *  by design (:root{--brand;--brand2;--accent;--head;--body}) — injecting an
 *  override style into the sandboxed srcDoc recolors every card instantly as
 *  the user edits the brand kit. Returns null when the kit still equals the
 *  defaults: an unconfigured user must see each pack's curated theme, not a
 *  uniformly-recolored catalog. String injection only — the iframe stays
 *  sandbox="" (no scripts, opaque origin), so no postMessage/DOM path exists. */
export function brandPreviewOverride(kit: BrandKit): { style: string; logo: string } | null {
  const isDefault =
    kit.primary_color === DEFAULT_KIT.primary_color &&
    kit.secondary_color === DEFAULT_KIT.secondary_color &&
    kit.accent_color === DEFAULT_KIT.accent_color &&
    kit.heading_font === DEFAULT_KIT.heading_font &&
    kit.body_font === DEFAULT_KIT.body_font &&
    !kit.logo_data_url;
  if (isDefault) return null;
  const primary = safeColor(kit.primary_color, DEFAULT_KIT.primary_color);
  const secondary = safeColor(kit.secondary_color, DEFAULT_KIT.secondary_color);
  const accent = safeColor(kit.accent_color, DEFAULT_KIT.accent_color);
  const headingFont = safeFont(kit.heading_font);
  const bodyFont = safeFont(kit.body_font);
  const style =
    `<style>:root{--brand:${primary} !important;` +
    `--brand2:${secondary} !important;` +
    `--accent:${accent} !important;` +
    `--head:'${headingFont}' !important;` +
    `--body:'${bodyFont}' !important;}</style>`;
  // data: URL from our own canvas rasterizer — safe to inline; absolute over
  // the first page only (body-anchored), matching where renderers put logos.
  const logo = kit.logo_data_url
    ? `<img src="${kit.logo_data_url}" style="position:absolute;top:26px;right:38px;` +
      `max-height:42px;max-width:170px;z-index:99" alt="">`
    : "";
  return { style, logo };
}
