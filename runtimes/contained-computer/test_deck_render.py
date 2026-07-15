"""Renderer contract tests. HTML tests are stdlib-only so they run on any host;
PPTX tests skip when python-pptx is absent (it lives in the contained computer)."""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("deck_render", os.path.join(HERE, "deck_render.py"))
deck_render = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(deck_render)

ALL_LAYOUTS_DECK = {
    "title": "T",
    "slides": [
        {"layout": "cover", "title": "T", "subtitle": "S"},
        {"layout": "timeline", "title": "Roadmap", "items": [
            {"label": "Q3", "title": "Ship", "text": "Self-serve"},
            {"label": "Q4", "title": "Scale", "text": "EU launch"},
        ]},
        {"layout": "comparison", "title": "Risks", "headers": ["Risk", "Impact"],
         "rows": [["Fuel", "High"], ["Churn", "Low"]]},
        {"layout": "team_grid", "title": "Team", "members": [
            {"name": "Elena Ricci", "role": "CEO"},
            {"name": "Marco Chen", "role": "CTO"},
        ]},
        {"layout": "closing", "title": "Next", "bullets": ["a"]},
    ],
}


class RenderHtmlLayouts(unittest.TestCase):
    def test_new_layouts_render_and_css_formats(self):
        # Also guards the _HTML_CSS .format() contract: an unescaped { in new CSS
        # raises KeyError/IndexError here.
        html = deck_render.render_html(ALL_LAYOUTS_DECK, HERE)
        self.assertIn('class="tl-item"', html)
        self.assertIn("Q3", html)
        self.assertIn('<table class="cmp">', html)
        self.assertIn("<th>Risk</th>", html)
        self.assertIn('class="member"', html)
        self.assertIn(">ER<", html)  # initials avatar for Elena Ricci

    def test_initials(self):
        self.assertEqual(deck_render._initials("Elena Ricci"), "ER")
        self.assertEqual(deck_render._initials("Cher"), "C")
        self.assertEqual(deck_render._initials(""), "")


@unittest.skipUnless(
    importlib.util.find_spec("pptx"), "python-pptx not installed on this host"
)
class RenderPptxLayouts(unittest.TestCase):
    @staticmethod
    def _slide_texts(slide):
        texts = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                texts.append(shape.text_frame.text)
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    for cell in row.cells:
                        texts.append(cell.text)
        return " ".join(texts)

    def test_new_layouts_produce_slides(self):
        import tempfile
        from pptx import Presentation
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "deck.pptx")
            stats = deck_render.render_pptx(ALL_LAYOUTS_DECK, tmp, out)
            self.assertIsNotNone(stats)
            prs = Presentation(out)
            self.assertEqual(len(prs.slides), len(ALL_LAYOUTS_DECK["slides"]))

            # Per-layout content assertions: catch a dead/mistyped elif branch that
            # would otherwise silently fall through to the bullets fallback and
            # still pass a slide-count-only check. Order follows ALL_LAYOUTS_DECK:
            # cover, timeline, comparison, team_grid, closing.
            slides = list(prs.slides)
            self.assertIn("Q3", self._slide_texts(slides[1]))       # timeline label rendered
            self.assertIn("Risk", self._slide_texts(slides[2]))     # comparison header cell
            self.assertIn("ER", self._slide_texts(slides[3]))       # team_grid initials avatar


if __name__ == "__main__":
    unittest.main()
