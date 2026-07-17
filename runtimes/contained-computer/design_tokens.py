"""Shared document design tokens — the deliverable themes as concrete values.

One place for palette/typography so doc_render (and future renderers) never
hard-code per-theme colours. Deck rendering keeps deriving colours from the
brand kit at generation time; these tokens are the DOCUMENT defaults when a
doc.json carries a theme name instead of explicit colours.

Token contract — every theme in THEMES MUST define all of:
  - primary, secondary, accent: brand colours (existing, pre-surface/ink model)
  - surface: the page/canvas background colour
  - ink: the default body/heading text colour on `surface`
  - muted: secondary text colour (captions, metadata) on `surface`
  - hairline: border/divider colour on `surface`
  - on_brand: text colour to use when painted ON `primary`/`accent` fields
    (not on `surface`) — e.g. text inside a coloured band or button
  - heading_font, body_font: typography family names

The 5 original themes keep today's look (white surface, dark ink) so
existing decks/docs render unchanged. The `editorial_*` themes are dramatic:
surface itself carries the brand colour, and ink/on_brand invert accordingly
— consumers must always paint text in `ink` on `surface` (never assume
"dark text" as a default), which is exactly why this contract exists."""

THEMES = {
    "clean_corporate": {"primary": "#16436b", "secondary": "#0c2233", "accent": "#14b8a6",
                        "surface": "#ffffff", "ink": "#16202b", "muted": "#5a6675",
                        "hairline": "#e4e9ef", "on_brand": "#ffffff",
                        "heading_font": "Inter", "body_font": "Inter"},
    "high_contrast":   {"primary": "#101828", "secondary": "#1d2939", "accent": "#fbbf24",
                        "surface": "#ffffff", "ink": "#16202b", "muted": "#5a6675",
                        "hairline": "#e4e9ef", "on_brand": "#101828",
                        "heading_font": "Inter", "body_font": "Inter"},
    "warm_editorial":  {"primary": "#7c2d12", "secondary": "#431407", "accent": "#f59e0b",
                        "surface": "#ffffff", "ink": "#1a1714", "muted": "#6b5d52",
                        "hairline": "#ece3da", "on_brand": "#ffffff",
                        "heading_font": "Georgia", "body_font": "Inter"},
    "minimal_mono":    {"primary": "#111827", "secondary": "#374151", "accent": "#111827",
                        "surface": "#ffffff", "ink": "#111827", "muted": "#6b7280",
                        "hairline": "#e5e7eb", "on_brand": "#ffffff",
                        "heading_font": "Inter", "body_font": "Inter"},
    "soft_gradient":   {"primary": "#312e81", "secondary": "#1e1b4b", "accent": "#8b5cf6",
                        "surface": "#ffffff", "ink": "#1e1b2e", "muted": "#6b7280",
                        "hairline": "#e7e5f0", "on_brand": "#ffffff",
                        "heading_font": "Inter", "body_font": "Inter"},
    # Editorial themes — dramatic surface owns the page; type + colour do the work.
    "editorial_noir":  {"primary": "#c9a54e", "secondary": "#1a1a1e", "accent": "#c9a54e",
                        "surface": "#0b0b0d", "ink": "#f4f1ea", "muted": "#9a948a",
                        "hairline": "#2a2a30", "on_brand": "#0b0b0d",
                        "heading_font": "Georgia", "body_font": "Inter"},
    "editorial_warm":  {"primary": "#8a3b1e", "secondary": "#e7ddcb", "accent": "#c46a3a",
                        "surface": "#f4f1ea", "ink": "#241c15", "muted": "#7a6a5a",
                        "hairline": "#ddd2c0", "on_brand": "#f4f1ea",
                        "heading_font": "Georgia", "body_font": "Inter"},
    "editorial_bold":  {"primary": "#0f3d3e", "secondary": "#0a2a2b", "accent": "#f2c14e",
                        "surface": "#0f3d3e", "ink": "#f3f6f4", "muted": "#a9c3c1",
                        "hairline": "#1c5153", "on_brand": "#0f3d3e",
                        "heading_font": "Georgia", "body_font": "Inter"},
}


def theme_values(name, overrides=None):
    """Resolve a theme name to concrete tokens; explicit overrides win."""
    base = dict(THEMES.get(name or "", THEMES["clean_corporate"]))
    for key, value in (overrides or {}).items():
        if value:
            base[key] = value
    return base
