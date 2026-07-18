"""Base64-embed @font-face for a deck/doc's fonts so the rendered HTML is
self-contained — it renders identically in the container's chromium (→PDF), in the
desktop preview iframe (CSP-safe data-URI), and anywhere the user opens the file.
The curated woff2 + the manifest come from scripts/build_fonts.py. Shared by
deck_render and doc_render (converge: one embed path). Fail-open: an unknown family
or an unreadable file emits nothing (the CSS font-family stack falls back)."""
import base64, os
from fonts_manifest import FONTS

_FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")


def font_face_css(families):
    seen, out = set(), []
    for fam in families:
        if not fam or fam in seen:
            continue
        seen.add(fam)
        for weight, fname in FONTS.get(fam, {}).items():
            path = os.path.join(_FONTS_DIR, fname)
            try:
                b64 = base64.b64encode(open(path, "rb").read()).decode()
            except OSError:
                continue  # fail-open: never emit an @font-face with an empty src
            out.append(
                f"@font-face{{font-family:'{fam}';font-weight:{weight};font-style:normal;"
                f"font-display:swap;src:url(data:font/woff2;base64,{b64}) format('woff2')}}"
            )
    return "".join(out)


def _selftest():
    css = font_face_css(["Inter"])
    assert "@font-face" in css and "font-family:'Inter'" in css and "base64," in css, "Inter faces missing"
    assert "Roboto" not in css, "only requested families must be emitted"
    assert font_face_css(["Totally Unknown Family"]) == "", "unknown family must be empty (fail-open)"
    assert font_face_css(["", None]) == "", "blank/None families produce nothing"
    # de-dup: passing a family twice emits its faces once
    assert font_face_css(["Inter", "Inter"]).count("font-family:'Inter';font-weight:400") == 1
    print("fonts_embed selftest OK")


if __name__ == "__main__":
    _selftest()
