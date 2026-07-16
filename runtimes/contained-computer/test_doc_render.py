"""Document renderer contract tests (stdlib-only).

GOTCHA (from F1): test probes must NEVER be substrings of a block/section
title — titles render for every block, so a title-substring probe is vacuous.
Probe strings below exist ONLY inside block-specific content."""
import importlib.util
import os
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


if __name__ == "__main__":
    unittest.main()
