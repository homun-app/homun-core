"""Document renderer contract tests (stdlib-only).

GOTCHA (from F1): test probes must NEVER be substrings of a block/section
title — titles render for every block, so a title-substring probe is vacuous.
Probe strings below exist ONLY inside block-specific content."""
import importlib.util
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("doc_render", os.path.join(HERE, "doc_render.py"))
doc_render = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(doc_render)

STRUCTURAL_DOC = {
    "title": "T",
    "theme": {"primary": "#101828", "accent": "#fbbf24"},
    "blocks": [
        {"type": "section_cover", "title": "Proposal", "subtitle": "For Acme"},
        {"type": "text_section", "title": "Context", "paragraphs": ["ParagraphProbe."],
         "bullets": ["BulletProbe"]},
        {"type": "letterhead", "organization": "OrgProbe Srl",
         "contact_line": "via Roma 1 — probe@example.com", "date_line": "16 July 2026",
         "recipient_lines": ["Dear RecipientProbe"]},
        {"type": "letter_body", "salutation": "Dear Ms Rossi,",
         "paragraphs": ["LetterParagraphProbe."]},
        {"type": "signature_block", "closing": "Kind regards,", "name": "SignerProbe",
         "role": "CEO"},
        {"type": "cta_footer", "heading": "Contact", "lines": ["CtaLineProbe"]},
    ],
}


class RenderHtmlStructuralBlocks(unittest.TestCase):
    def test_blocks_render_with_content_probes(self):
        html = doc_render.render_html(STRUCTURAL_DOC, HERE)
        for probe in ["ParagraphProbe", "BulletProbe", "OrgProbe", "RecipientProbe",
                      "LetterParagraphProbe", "SignerProbe", "CtaLineProbe"]:
            self.assertIn(probe, html)
        self.assertIn('class="doc"', html)
        self.assertIn("@page", html)          # A4 print pagination
        self.assertIn("--brand:#101828", html)  # theme reaches CSS tokens

    def test_unknown_block_type_falls_back_to_text(self):
        html = doc_render.render_html(
            {"title": "T", "blocks": [{"type": "mystery", "title": "X",
                                       "paragraphs": ["FallbackProbe"]}]}, HERE)
        self.assertIn("FallbackProbe", html)

    def test_theme_defaults_applied(self):
        html = doc_render.render_html({"title": "T", "blocks": []}, HERE)
        self.assertIn("--brand:#2b6cb0", html)  # DEFAULT_THEME primary

    def test_partial_theme_without_name_keeps_default_base(self):
        html = doc_render.render_html(
            {"title": "T", "theme": {"primary": "#101828"}, "blocks": []}, HERE)
        self.assertIn("--brand:#101828", html)      # explicit field wins
        self.assertIn("--brand2:#1a202c", html)     # DEFAULT_THEME base, not clean_corporate

    def test_named_theme_resolves_and_explicit_fields_win(self):
        html = doc_render.render_html(
            {"title": "T", "theme": {"name": "warm_editorial", "accent": "#000000"},
             "blocks": []}, HERE)
        self.assertIn("--brand:#7c2d12", html)      # THEMES[warm_editorial] primary
        self.assertIn("--head:'Georgia'", html)     # THEMES[warm_editorial] heading font
        self.assertIn("--accent:#000000", html)     # explicit override beats the theme


CV_DOC = {
    "title": "CV",
    "blocks": [
        {"type": "contact_header", "name": "Elena Ricci", "headline": "Operations Director",
         "contact_items": ["elena@example.com", "+39 333 000000", "Milano"]},
        {"type": "profile_summary", "title": "Profile", "text": "ProfileTextProbe."},
        {"type": "timeline", "title": "Experience", "entries": [
            {"label": "2022—now", "heading": "Ops Director", "subheading": "Aurora Logistics",
             "points": ["TimelinePointProbe"]}]},
        {"type": "education_list", "title": "Education", "entries": [
            {"label": "2010", "heading": "MSc EduProbe", "subheading": "Politecnico"}]},
        {"type": "skill_tags", "title": "Skills", "groups": [
            {"label": "Ops", "tags": ["SkillTagProbe", "Lean"]}]},
    ],
}


class RenderHtmlCvBlocks(unittest.TestCase):
    def test_cv_blocks_render_with_content_probes(self):
        html = doc_render.render_html(CV_DOC, HERE)
        self.assertIn(">ER<", html)  # initials avatar, content-only probe
        for probe in ["ProfileTextProbe", "TimelinePointProbe", "EduProbe", "SkillTagProbe"]:
            self.assertIn(probe, html)
        self.assertIn('class="tag"', html)
        self.assertIn('class="tl-entry"', html)

    def test_contact_header_and_letterhead_accept_optional_eyebrow(self):
        # CV/cover-letter have no section_cover — contact_header/letterhead ARE
        # their "cover", so they get the same eyebrow kicker (no hero_art: these
        # are compact header blocks, not full-bleed covers).
        html = doc_render.render_html(
            {"title": "T", "blocks": [
                {"type": "contact_header", "name": "N", "eyebrow": "EyebrowContactProbe"},
                {"type": "letterhead", "organization": "O", "eyebrow": "EyebrowLetterheadProbe"},
            ]}, HERE)
        self.assertIn("EyebrowContactProbe", html)
        self.assertIn("EyebrowLetterheadProbe", html)

    def test_tag_label_uses_muted_not_secondary(self):
        # Regression: .tag-label used to paint `secondary` (--brand2) as text
        # on `surface` — editorial themes use `secondary` as a near-surface
        # FILL tone (contrast ~1.1:1, effectively invisible), not caption ink.
        # `muted` is the token contract's actual "caption/metadata on surface"
        # colour and is what every theme's skill_tags group label should use.
        html = doc_render.render_html(CV_DOC, HERE)
        self.assertIn(".tag-label{font-weight:700;margin-right:.6rem;color:var(--muted)}", html)


COMMERCE_DOC = {
    "title": "Catalog",
    "blocks": [
        {"type": "product_grid", "title": "Products", "products": [
            {"name": "ProductNameProbe", "description": "Small widget.",
             "price": "€ 49", "badge": "NEW"}]},
        {"type": "pricing_table", "title": "Pricing", "headers": ["Plan", "Price"],
         "rows": [["PlanCellProbe", "€ 99/mo"]], "note": "PricingNoteProbe"},
        {"type": "spec_table", "title": "Specs", "headers": ["Key", "Value"],
         "rows": [["SpecKeyProbe", "10 kg"]]},
        {"type": "kpi_band", "title": "Results", "items": [
            {"value": "+38%", "label": "KpiLabelProbe"}]},
        {"type": "testimonial_quote", "quote": "QuoteTextProbe",
         "author": "Anna Bianchi", "role": "COO"},
    ],
}


class RenderHtmlCommerceBlocks(unittest.TestCase):
    def test_commerce_blocks_render_with_content_probes(self):
        html = doc_render.render_html(COMMERCE_DOC, HERE)
        for probe in ["ProductNameProbe", "PlanCellProbe", "PricingNoteProbe",
                      "SpecKeyProbe", "KpiLabelProbe", "QuoteTextProbe"]:
            self.assertIn(probe, html)
        self.assertIn('<table class="tbl">', html)
        self.assertIn('class="product"', html)
        self.assertIn('class="kpi-item"', html)


class DocEditorialCover(unittest.TestCase):
    def test_section_cover_eyebrow_and_hero_and_surface(self):
        html = doc_render.render_html(
            {"title": "T", "theme": {"name": "editorial_warm"},
             "blocks": [{"type": "section_cover", "title": "Case", "subtitle": "S",
                         "eyebrow": "EyebrowDocProbe", "hero_art": "grid"}]}, HERE)
        self.assertIn("EyebrowDocProbe", html)
        self.assertIn("hero-art", html)
        self.assertIn("--surface:#f4f1ea", html)
        self.assertIn("--ink:#241c15", html)

    def test_hero_art_grid_ids_are_unique_across_blocks(self):
        # F1a-T2 review gotcha: _hero_art("grid") used a FIXED pattern id — two
        # grid blocks in one document produced duplicate DOM ids (invalid
        # markup, and the second <rect fill="url(#g)"> could resolve to either
        # <pattern>). Each call must mint its own id.
        html = doc_render.render_html(
            {"title": "T", "blocks": [
                {"type": "section_cover", "title": "A", "hero_art": "grid"},
                {"type": "section_cover", "title": "B", "hero_art": "grid"},
            ]}, HERE)
        pattern_ids = re.findall(r'<pattern id="(g[^"]*)"', html)
        self.assertEqual(len(pattern_ids), 2)
        self.assertEqual(len(pattern_ids), len(set(pattern_ids)))
        for pid in pattern_ids:
            self.assertIn(f'url(#{pid})', html)


def _contrast_ratio(hex_a, hex_b):
    """WCAG relative-luminance contrast ratio between two '#rrggbb' colours.

    Mirrors the JS contrastRatio()/luminance() in deck_qa.py so host-side
    tests catch the same class of bug that QA_JS flags at render time."""
    def channel(value):
        c = value / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    def luminance(hex_color):
        h = hex_color.lstrip("#")
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)

    l1, l2 = luminance(hex_a) + 0.05, luminance(hex_b) + 0.05
    return max(l1, l2) / min(l1, l2)


class DesignTokens(unittest.TestCase):
    def test_every_theme_has_surface_and_ink(self):
        from design_tokens import THEMES
        for name, t in THEMES.items():
            for key in ("primary", "accent", "surface", "ink", "muted", "hairline", "on_brand"):
                self.assertIn(key, t, f"{name} missing {key}")

    def test_primary_is_readable_on_surface_for_every_theme(self):
        # Regression: deck_render/doc_render both paint `primary` as INK
        # directly on `surface` in several places (kpi numbers, h3, tl-label,
        # quote .sub) — this is a DIFFERENT role from the "primary as a FILL
        # behind on_brand text" role. editorial_bold originally set
        # primary == surface (#0f3d3e both), making that ink invisible; found
        # rendering the S1a QA preview, not caught by the on_brand fix alone.
        # 3.0 matches deck_qa.py's own large/bold-text WCAG threshold, which
        # is what these particular selectors are (7rem/1.4rem/1.15rem bold).
        from design_tokens import THEMES
        for name, t in THEMES.items():
            ratio = _contrast_ratio(t["primary"], t["surface"])
            self.assertGreaterEqual(
                ratio, 3.0, f"{name}: primary vs surface contrast {ratio:.2f} < 3.0"
            )

    def test_editorial_themes_present(self):
        from design_tokens import THEMES
        for name in ("editorial_noir", "editorial_warm", "editorial_bold"):
            self.assertIn(name, THEMES)
        self.assertEqual(THEMES["editorial_noir"]["surface"], "#0b0b0d")

    def test_editorial_light_themes_present_for_documents(self):
        # Decks get the dramatic dark surfaces; documents need light editorial
        # themes (dark-on-dark body text is unreadable/unprintable — S1a QA).
        from design_tokens import THEMES
        for name in ("editorial_ivory", "editorial_slate"):
            self.assertIn(name, THEMES)
        self.assertEqual(THEMES["editorial_ivory"]["surface"], "#f6f3ec")
        self.assertEqual(THEMES["editorial_slate"]["surface"], "#f4f5f7")

    def test_editorial_bold_on_brand_is_readable(self):
        # Regression: on_brand used to equal primary (text invisible on
        # brand-filled avatars/table headers).
        from design_tokens import THEMES
        self.assertNotEqual(
            THEMES["editorial_bold"]["on_brand"], THEMES["editorial_bold"]["primary"]
        )


if __name__ == "__main__":
    unittest.main()
