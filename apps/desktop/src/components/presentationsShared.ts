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
