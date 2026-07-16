"""Shared document design tokens — the 5 deliverable themes as concrete values.

One place for palette/typography so doc_render (and future renderers) never
hard-code per-theme colours. Deck rendering keeps deriving colours from the
brand kit at generation time; these tokens are the DOCUMENT defaults when a
doc.json carries a theme name instead of explicit colours."""

THEMES = {
    "clean_corporate": {"primary": "#16436b", "secondary": "#0c2233", "accent": "#14b8a6",
                        "heading_font": "Inter", "body_font": "Inter"},
    "high_contrast":   {"primary": "#101828", "secondary": "#1d2939", "accent": "#fbbf24",
                        "heading_font": "Inter", "body_font": "Inter"},
    "warm_editorial":  {"primary": "#7c2d12", "secondary": "#431407", "accent": "#f59e0b",
                        "heading_font": "Georgia", "body_font": "Inter"},
    "minimal_mono":    {"primary": "#111827", "secondary": "#374151", "accent": "#111827",
                        "heading_font": "Inter", "body_font": "Inter"},
    "soft_gradient":   {"primary": "#312e81", "secondary": "#1e1b4b", "accent": "#8b5cf6",
                        "heading_font": "Inter", "body_font": "Inter"},
}


def theme_values(name, overrides=None):
    """Resolve a theme name to concrete tokens; explicit overrides win."""
    base = dict(THEMES.get(name or "", THEMES["clean_corporate"]))
    for key, value in (overrides or {}).items():
        if value:
            base[key] = value
    return base
