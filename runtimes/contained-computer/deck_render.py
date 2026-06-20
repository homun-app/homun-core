#!/usr/bin/env python3
"""Homun deck renderer — ONE structured deck model → TWO outputs.

The agent produces only the CONTENT as a JSON deck (theme + slides with a fixed set
of layout types); this renderer turns it into:

  * <prefix>.html  — a self-contained, on-brand, image-led deck for VIEWING / PDF
                     (logo + images inlined as data URLs, brand colours/fonts);
  * <prefix>.pptx  — a NATIVE, EDITABLE PowerPoint (real text boxes, logo, images)
                     built from scratch with python-pptx — NOT an HTML screenshot.

This separation (single source of truth → dual render) is what makes the deck both
beautiful AND editable in PowerPoint/Google Slides, instead of the lossy HTML→PPTX
trap. Layout types are deliberately CONSTRAINED so both renderers stay faithful.

Usage:
    python deck_render.py deck.json [--prefix deck] [--no-pptx]

deck.json schema (all fields optional unless noted):
{
  "title": "Deck title",            "subtitle": "...", "date": "...",
  "theme": {                         # falls back to brand-kit-ish defaults
    "primary": "#2b6cb0", "secondary": "#1a202c", "accent": "#ed8936",
    "heading_font": "Inter", "body_font": "Inter",
    "logo": "logo.png"               # path (rel to deck.json) or data: URL
  },
  "slides": [                        # REQUIRED
    {"layout": "cover",   "title": "...", "subtitle": "..."},
    {"layout": "bullets", "title": "...", "bullets": ["a","b"], "notes": "..."},
    {"layout": "image_right", "title": "...", "bullets": [...], "image": "s2.png"},
    {"layout": "kpi",     "title": "...", "kpi": "42%", "kpi_label": "growth"},
    {"layout": "two_column", "title": "...", "columns": [{"title":"L","bullets":[]},
                                                          {"title":"R","bullets":[]}]},
    {"layout": "quote",   "quote": "...", "author": "..."},
    {"layout": "section", "title": "..."},
    {"layout": "closing", "title": "Next steps", "bullets": [...]}
  ]
}
"""

import argparse
import base64
import html
import json
import mimetypes
import os
import sys

DEFAULT_THEME = {
    "primary": "#2b6cb0",
    "secondary": "#1a202c",
    "accent": "#ed8936",
    "heading_font": "Inter",
    "body_font": "Inter",
    "logo": "",
}


# --------------------------------------------------------------------------- utils
def hexrgb(value, fallback=(43, 108, 176)):
    """'#rrggbb' → (r,g,b) ints, tolerant of missing '#'/bad input."""
    try:
        v = value.lstrip("#")
        if len(v) == 3:
            v = "".join(c * 2 for c in v)
        return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))
    except Exception:
        return fallback


def data_url(path, base_dir):
    """Inline a file as a data: URL. Accepts an already-data: string. '' on miss."""
    if not path:
        return ""
    if path.startswith("data:"):
        return path
    full = path if os.path.isabs(path) else os.path.join(base_dir, path)
    if not os.path.isfile(full):
        return ""
    mime = mimetypes.guess_type(full)[0] or "image/png"
    with open(full, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def resolve_path(path, base_dir):
    if not path or path.startswith("data:"):
        return ""
    full = path if os.path.isabs(path) else os.path.join(base_dir, path)
    return full if os.path.isfile(full) else ""


# ----------------------------------------------------------------------- HTML side
def html_escape(s):
    return html.escape(str(s or ""))


def render_html(deck, base_dir):
    theme = {**DEFAULT_THEME, **(deck.get("theme") or {})}
    logo = data_url(theme.get("logo", ""), base_dir)
    slides_html = []
    for s in deck.get("slides", []):
        slides_html.append(_html_slide(s, base_dir, logo))
    css = _HTML_CSS.format(
        primary=theme["primary"],
        secondary=theme["secondary"],
        accent=theme["accent"],
        heading=theme["heading_font"],
        body=theme["body_font"],
    )
    title = html_escape(deck.get("title", "Presentation"))
    return _HTML_SHELL.format(title=title, css=css, body="\n".join(slides_html))


def _bullets_html(items):
    if not items:
        return ""
    lis = "".join(f"<li>{html_escape(b)}</li>" for b in items)
    return f'<ul class="body">{lis}</ul>'


def _logo_html(logo):
    return f'<img class="logo" src="{logo}">' if logo else ""


def _html_slide(s, base_dir, logo):
    layout = s.get("layout", "bullets")
    title = html_escape(s.get("title", ""))
    img = data_url(s.get("image", ""), base_dir)
    if layout == "cover":
        return (
            f'<section class="slide cover">{_logo_html(logo)}'
            f"<h1>{title}</h1>"
            f'<div class="sub">{html_escape(s.get("subtitle",""))}</div>'
            f'<div class="accent-bar"></div></section>'
        )
    if layout == "section":
        return (
            f'<section class="slide section">{_logo_html(logo)}'
            f"<h1>{title}</h1><div class=\"accent-bar\"></div></section>"
        )
    if layout == "kpi":
        return (
            f'<section class="slide kpi-slide">{_logo_html(logo)}'
            f"<h2>{title}</h2>"
            f'<div class="kpi">{html_escape(s.get("kpi",""))}</div>'
            f'<div class="sub">{html_escape(s.get("kpi_label",""))}</div>'
            f'<div class="accent-bar"></div></section>'
        )
    if layout == "quote":
        return (
            f'<section class="slide quote-slide">{_logo_html(logo)}'
            f'<blockquote>“{html_escape(s.get("quote",""))}”</blockquote>'
            f'<div class="sub">— {html_escape(s.get("author",""))}</div>'
            f'<div class="accent-bar"></div></section>'
        )
    if layout in ("image_left", "image_right"):
        img_tag = f'<img class="led" src="{img}">' if img else '<div class="led ph"></div>'
        text = f"<div><h2>{title}</h2>{_bullets_html(s.get('bullets'))}" + (
            f'<p class="body">{html_escape(s.get("body",""))}</p>' if s.get("body") else ""
        ) + "</div>"
        order = (img_tag + text) if layout == "image_left" else (text + img_tag)
        return (
            f'<section class="slide img-led">{_logo_html(logo)}{order}'
            f'<div class="accent-bar"></div></section>'
        )
    if layout == "two_column":
        cols = s.get("columns", [])[:2]
        cells = "".join(
            f'<div class="col"><h3>{html_escape(c.get("title",""))}</h3>'
            f"{_bullets_html(c.get('bullets'))}</div>"
            for c in cols
        )
        return (
            f'<section class="slide two-col">{_logo_html(logo)}'
            f"<h2>{title}</h2><div class=\"cols\">{cells}</div>"
            f'<div class="accent-bar"></div></section>'
        )
    # default: bullets (+ optional image, + optional body)
    body = f'<p class="body">{html_escape(s.get("body",""))}</p>' if s.get("body") else ""
    img_block = f'<img class="inline-img" src="{img}">' if img else ""
    return (
        f'<section class="slide bullets">{_logo_html(logo)}'
        f"<h2>{title}</h2>{_bullets_html(s.get('bullets'))}{body}{img_block}"
        f'<div class="accent-bar"></div></section>'
    )


_HTML_CSS = """
:root{{--brand:{primary};--brand2:{secondary};--accent:{accent};--ink:#1a202c;--muted:#4a5568;}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:'{heading}',-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink)}}
.slide{{width:100%;min-height:100vh;padding:7vh 8vw;display:flex;flex-direction:column;
  justify-content:center;position:relative;page-break-after:always;overflow:hidden}}
.slide h1{{font-size:3.2rem;line-height:1.05}}
.slide h2{{font-size:2.2rem;color:var(--brand);margin-bottom:.6em}}
.slide h3{{font-size:1.3rem;color:var(--brand)}}
.body{{font-family:'{body}',sans-serif}}
.slide li{{font-size:1.5rem;color:var(--muted);margin:.5rem 0;list-style:none;
  padding-left:1.4rem;position:relative}}
.slide li::before{{content:"▸";position:absolute;left:0;color:var(--accent)}}
.kpi{{font-size:6rem;font-weight:800;color:var(--brand);line-height:1}}
.accent-bar{{position:absolute;left:0;bottom:0;height:10px;width:100%;background:var(--accent)}}
.logo{{position:absolute;top:5vh;right:8vw;max-height:42px}}
.cover,.section{{background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff}}
.cover h1,.section h1{{color:#fff}} .cover .sub{{font-size:1.4rem;opacity:.92;margin-top:1rem}}
.img-led{{display:grid;grid-template-columns:1fr 1fr;gap:4vw;align-items:center}}
.img-led .led{{width:100%;border-radius:14px;object-fit:cover;max-height:62vh}}
.img-led .ph{{background:#edf2f7;min-height:40vh}}
.inline-img{{margin-top:1.2rem;max-height:42vh;border-radius:12px;object-fit:cover}}
.two-col .cols{{display:grid;grid-template-columns:1fr 1fr;gap:4vw;margin-top:1rem}}
.kpi-slide .sub{{font-size:1.5rem;color:var(--muted);margin-top:.4rem}}
.quote-slide blockquote{{font-size:2.4rem;font-weight:600;color:var(--brand);max-width:80%}}
.quote-slide .sub{{font-size:1.3rem;color:var(--muted);margin-top:1rem}}
@media print{{.slide{{min-height:auto;height:100vh}}}}
"""

_HTML_SHELL = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>{title}</title><style>{css}</style></head><body>
{body}
</body></html>"""


# ----------------------------------------------------------------------- PPTX side
def render_pptx(deck, base_dir, out_path):
    """Build a native, editable .pptx from the deck model. Returns True on success."""
    try:
        from pptx import Presentation
        from pptx.util import Inches, Pt, Emu
        from pptx.dml.color import RGBColor
        from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
    except Exception as exc:  # python-pptx not installed → caller falls back to HTML/PDF
        sys.stderr.write(f"deck_render: python-pptx unavailable ({exc}); skipping .pptx\n")
        return False

    theme = {**DEFAULT_THEME, **(deck.get("theme") or {})}
    brand = RGBColor(*hexrgb(theme["primary"]))
    brand2 = RGBColor(*hexrgb(theme["secondary"], (26, 32, 44)))
    accent = RGBColor(*hexrgb(theme["accent"], (237, 137, 54)))
    ink = RGBColor(0x1A, 0x20, 0x2C)
    muted = RGBColor(0x4A, 0x55, 0x68)
    white = RGBColor(0xFF, 0xFF, 0xFF)
    head_font = theme["heading_font"] or "Inter"
    body_font = theme["body_font"] or "Inter"

    # python-pptx needs real files; accept either a path or a data: URL (the brand-kit
    # logo arrives as a data URL). Materialised temp files are cleaned up after save.
    import tempfile

    _tmp_files = []

    def img_path(spec):
        if not spec:
            return ""
        if str(spec).startswith("data:"):
            try:
                header, b64 = spec.split(",", 1)
                ext = ".png"
                if "jpeg" in header or "jpg" in header:
                    ext = ".jpg"
                fd, path = tempfile.mkstemp(suffix=ext)
                with os.fdopen(fd, "wb") as fh:
                    fh.write(base64.b64decode(b64))
                _tmp_files.append(path)
                return path
            except Exception:
                return ""
        return resolve_path(spec, base_dir)

    logo_path = img_path(theme.get("logo", ""))

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    SW, SH = prs.slide_width, prs.slide_height
    blank = prs.slide_layouts[6]

    def add_slide():
        return prs.slides.add_slide(blank)

    def fill_bg(slide, color):
        shp = slide.shapes.add_shape(1, 0, 0, SW, SH)  # rectangle
        shp.fill.solid()
        shp.fill.fore_color.rgb = color
        shp.line.fill.background()
        shp.shadow.inherit = False
        slide.shapes._spTree.remove(shp._element)
        slide.shapes._spTree.insert(2, shp._element)  # send to back
        return shp

    def accent_bar(slide):
        bar = slide.shapes.add_shape(1, 0, SH - Inches(0.14), SW, Inches(0.14))
        bar.fill.solid()
        bar.fill.fore_color.rgb = accent
        bar.line.fill.background()
        bar.shadow.inherit = False

    def add_logo(slide):
        if logo_path:
            try:
                slide.shapes.add_picture(
                    logo_path, SW - Inches(1.9), Inches(0.4), height=Inches(0.5)
                )
            except Exception:
                pass

    def textbox(slide, left, top, width, height, runs, align=PP_ALIGN.LEFT,
                anchor=MSO_ANCHOR.TOP):
        tb = slide.shapes.add_textbox(left, top, width, height)
        tf = tb.text_frame
        tf.word_wrap = True
        tf.vertical_anchor = anchor
        first = True
        for (text, size, color, font, bold, bullet) in runs:
            p = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            p.alignment = align
            p.space_after = Pt(6)
            r = p.add_run()
            r.text = ("•  " + text) if bullet else text
            r.font.size = Pt(size)
            r.font.color.rgb = color
            r.font.name = font
            r.font.bold = bold
        return tb

    def notes(slide, text):
        if text:
            slide.notes_slide.notes_text_frame.text = str(text)

    for s in deck.get("slides", []):
        layout = s.get("layout", "bullets")
        slide = add_slide()
        title = s.get("title", "")

        if layout in ("cover", "section"):
            fill_bg(slide, brand)
            # subtle second-tone band
            band = slide.shapes.add_shape(1, 0, 0, SW, SH)
            band.fill.gradient() if False else band.fill.solid()
            band.fill.fore_color.rgb = brand2
            band.line.fill.background()
            band.shadow.inherit = False
            band.fill.transparency = 0  # solid; layered look kept simple
            slide.shapes._spTree.remove(band._element)
            slide.shapes._spTree.insert(2, band._element)
            fill_bg(slide, brand)  # brand on top of brand2 for a clean base
            runs = [(title, 40, white, head_font, True, False)]
            if s.get("subtitle"):
                runs.append((s["subtitle"], 20, white, body_font, False, False))
            textbox(slide, Inches(0.9), Inches(2.6), Inches(11.5), Inches(2.5), runs,
                    anchor=MSO_ANCHOR.MIDDLE)
            accent_bar(slide)
            add_logo(slide)
            notes(slide, s.get("notes"))
            continue

        # content slides: white bg, brand title
        fill_bg(slide, white)
        add_logo(slide)
        if title:
            textbox(slide, Inches(0.9), Inches(0.55), Inches(11.5), Inches(1.1),
                    [(title, 30, brand, head_font, True, False)])

        if layout == "kpi":
            textbox(slide, Inches(0.9), Inches(2.4), Inches(11.5), Inches(2.2),
                    [(s.get("kpi", ""), 80, brand, head_font, True, False)],
                    anchor=MSO_ANCHOR.MIDDLE)
            textbox(slide, Inches(0.9), Inches(4.6), Inches(11.5), Inches(1.0),
                    [(s.get("kpi_label", ""), 22, muted, body_font, False, False)])
        elif layout == "quote":
            textbox(slide, Inches(1.2), Inches(2.2), Inches(10.9), Inches(2.6),
                    [("“" + s.get("quote", "") + "”", 32, brand, head_font, True, False)],
                    anchor=MSO_ANCHOR.MIDDLE)
            textbox(slide, Inches(1.2), Inches(4.9), Inches(10.9), Inches(0.8),
                    [("— " + s.get("author", ""), 18, muted, body_font, False, False)])
        elif layout in ("image_left", "image_right"):
            img = img_path(s.get("image", ""))
            text_left = Inches(7.0) if layout == "image_left" else Inches(0.9)
            img_left = Inches(0.7) if layout == "image_left" else Inches(7.0)
            if img:
                try:
                    slide.shapes.add_picture(img, img_left, Inches(1.9),
                                             width=Inches(5.6))
                except Exception:
                    pass
            runs = [(b, 18, muted, body_font, False, True) for b in s.get("bullets", [])]
            if s.get("body"):
                runs.append((s["body"], 18, muted, body_font, False, False))
            if runs:
                textbox(slide, text_left, Inches(1.9), Inches(5.6), Inches(4.6), runs)
        elif layout == "two_column":
            cols = s.get("columns", [])[:2]
            for i, c in enumerate(cols):
                left = Inches(0.9) if i == 0 else Inches(7.0)
                runs = [(c.get("title", ""), 20, brand, head_font, True, False)]
                runs += [(b, 17, muted, body_font, False, True)
                         for b in c.get("bullets", [])]
                textbox(slide, left, Inches(1.9), Inches(5.6), Inches(4.6), runs)
        else:  # bullets
            runs = [(b, 20, muted, body_font, False, True) for b in s.get("bullets", [])]
            if s.get("body"):
                runs.append((s["body"], 18, muted, body_font, False, False))
            top = Inches(1.9)
            if runs:
                textbox(slide, Inches(0.9), top, Inches(11.5), Inches(4.6), runs)
            img = img_path(s.get("image", ""))
            if img:
                try:
                    slide.shapes.add_picture(img, Inches(8.6), Inches(1.9),
                                             width=Inches(3.8))
                except Exception:
                    pass

        accent_bar(slide)
        notes(slide, s.get("notes"))

    prs.save(out_path)
    for tmp in _tmp_files:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return True


# ---------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Render a Homun deck JSON to HTML + PPTX.")
    ap.add_argument("deck", help="path to deck.json")
    ap.add_argument("--prefix", default=None, help="output prefix (default: deck file stem)")
    ap.add_argument("--no-pptx", action="store_true", help="skip the .pptx output")
    args = ap.parse_args()

    with open(args.deck, "r", encoding="utf-8") as fh:
        deck = json.load(fh)
    if not deck.get("slides"):
        sys.exit("deck.json has no 'slides'.")

    base_dir = os.path.dirname(os.path.abspath(args.deck))
    prefix = args.prefix or os.path.splitext(os.path.basename(args.deck))[0]
    out_html = os.path.join(base_dir, f"{prefix}.html")
    out_pptx = os.path.join(base_dir, f"{prefix}.pptx")

    with open(out_html, "w", encoding="utf-8") as fh:
        fh.write(render_html(deck, base_dir))
    print(f"wrote {out_html}")

    if not args.no_pptx:
        if render_pptx(deck, base_dir, out_pptx):
            print(f"wrote {out_pptx}")
        else:
            print("pptx skipped (python-pptx unavailable)")


if __name__ == "__main__":
    main()
