#!/usr/bin/env python3
"""Homun document renderer — ONE structured doc model → on-brand HTML.

The agent produces only CONTENT as doc.json (title + typed blocks); this
renderer projects it into a self-contained A4-paginated HTML used for BOTH
the catalog live preview and the printed PDF (Chromium --print-to-pdf).
The editable DOCX is produced gateway-side from the SAME doc.json — single
source of truth, dual projection, like deck_render's html/pptx split.

doc.json schema:
{
  "title": "...",
  "theme": {"name": "clean_corporate", "primary": "#..", "secondary": "#..",
             "accent": "#..", "heading_font": "..", "body_font": "..",
             "logo": "logo.png|data:..."},
  "blocks": [ {"type": "<one of the 16 registered block types>", ...fields} ]
}

Usage: python doc_render.py doc.json [--prefix out] [--self-test]
"""
import argparse
import base64
import html as html_lib
import json
import mimetypes
import os
import sys

from design_tokens import theme_values

DEFAULT_THEME = {"primary": "#2b6cb0", "secondary": "#1a202c", "accent": "#ed8936",
                 "heading_font": "Inter", "body_font": "Inter", "logo": ""}


def esc(value):
    return html_lib.escape(str(value or ""))


def data_url(path, base_dir):
    if not path:
        return ""
    if path.startswith("data:"):
        return path
    full = path if os.path.isabs(path) else os.path.join(base_dir, path)
    if not os.path.isfile(full):
        return ""
    mime = mimetypes.guess_type(full)[0] or "image/png"
    with open(full, "rb") as fh:
        return f"data:{mime};base64,{base64.b64encode(fh.read()).decode('ascii')}"


def _initials(name):
    parts = [p for p in str(name or "").split() if p]
    return "".join(p[0].upper() for p in parts[:2])


def _paras(items, cls="para"):
    return "".join(f'<p class="{cls}">{esc(p)}</p>' for p in (items or []))


def _bullets(items):
    if not items:
        return ""
    return '<ul class="bullets">' + "".join(f"<li>{esc(b)}</li>" for b in items) + "</ul>"


def render_block(block, base_dir, logo):
    kind = block.get("type", "text_section")
    title = esc(block.get("title", ""))
    if kind == "section_cover":
        return (f'<section class="block cover">{_logo(logo)}'
                f'<h1>{title}</h1><div class="sub">{esc(block.get("subtitle", ""))}</div>'
                f'<div class="rule"></div></section>')
    if kind == "letterhead":
        recipients = "".join(f"<div>{esc(r)}</div>" for r in block.get("recipient_lines", [])[:5])
        return (f'<section class="block letterhead">{_logo(logo)}'
                f'<strong>{esc(block.get("organization", ""))}</strong>'
                f'<span class="muted">{esc(block.get("contact_line", ""))}</span>'
                f'<span class="date">{esc(block.get("date_line", ""))}</span>'
                f'<div class="recipient">{recipients}</div></section>')
    if kind == "letter_body":
        return (f'<section class="block letter-body">'
                f'<p class="salutation">{esc(block.get("salutation", ""))}</p>'
                f'{_paras(block.get("paragraphs", [])[:8])}</section>')
    if kind == "signature_block":
        return (f'<section class="block signature">'
                f'<p>{esc(block.get("closing", ""))}</p>'
                f'<strong>{esc(block.get("name", ""))}</strong>'
                f'<span class="muted">{esc(block.get("role", ""))}</span></section>')
    if kind == "cta_footer":
        lines = "".join(f"<span>{esc(l)}</span>" for l in block.get("lines", [])[:3])
        return (f'<section class="block cta"><strong>{esc(block.get("heading", ""))}</strong>'
                f'<div class="cta-lines">{lines}</div></section>')
    # text_section is ALSO the fallback for unknown types: content survives,
    # never a hard failure on model drift (the schema layer prevents drift
    # upstream; this is the render-side safety net).
    return (f'<section class="block text">'
            + (f"<h2>{title}</h2>" if title else "")
            + _paras(block.get("paragraphs", [])[:6])
            + _bullets(block.get("bullets", [])[:8])
            + "</section>")


def _logo(logo):
    return f'<img class="logo" src="{logo}">' if logo else ""


def render_html(doc, base_dir):
    raw_theme = doc.get("theme") or {}
    # GOTCHA: theme_values() with no name still resolves to clean_corporate
    # (its own catalog fallback) — correct when the caller passed a partial
    # theme dict without a name, but wrong when NO theme info was given at
    # all: that case must keep DEFAULT_THEME (the brand-neutral blue shared
    # with deck_render), not silently become clean_corporate.
    theme = (dict(DEFAULT_THEME) if not raw_theme
             else {**DEFAULT_THEME, **theme_values(raw_theme.get("name"), raw_theme)})
    logo = data_url(theme.get("logo", ""), base_dir)
    body = "".join(render_block(b, base_dir, logo) for b in doc.get("blocks", []))
    tokens = _css_tokens(theme)
    title = esc(doc.get("title", "Document"))
    return ("<!doctype html><html><head><meta charset='utf-8'>"
            f"<title>{title}</title><style>{tokens}{_CSS_BODY}</style></head>"
            f"<body><div class=\"doc\">{body}</div></body></html>")


def _css_tokens(theme):
    # The ONLY formatted CSS chunk (F1 gotcha: .format over a whole stylesheet
    # forces double-brace escaping and breaks silently) — everything else is
    # the raw _CSS_BODY constant below.
    return (f":root{{--brand:{theme['primary']};--brand2:{theme['secondary']};"
            f"--accent:{theme['accent']};--head:'{theme['heading_font']}';"
            f"--body:'{theme['body_font']}';--doc-width:794px;}}")


_CSS_BODY = """
@page{size:A4;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--body),-apple-system,'Segoe UI',sans-serif;color:#16202b;background:#fff}
.doc{width:var(--doc-width);margin:0 auto}
.block{padding:28px 44px;overflow-wrap:anywhere}
h1,h2,h3,strong{font-family:var(--head),sans-serif}
.muted{color:#5a6675}
.cover{background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;
  padding:96px 44px 72px;page-break-after:always;min-height:280px}
.cover h1{font-size:2.6rem;letter-spacing:-.02em}
.cover .sub{margin-top:.6rem;opacity:.92;font-size:1.1rem}
.cover .rule{width:84px;height:5px;background:var(--accent);margin-top:1.6rem}
.text h2{font-size:1.35rem;color:var(--brand);border-bottom:3px solid var(--accent);
  display:inline-block;padding-bottom:.25rem;margin-bottom:.8rem}
.para{margin:.45rem 0;line-height:1.55;color:#2a3542}
.bullets{margin:.5rem 0 .2rem 1.2rem}
.bullets li{margin:.35rem 0;line-height:1.5;color:#2a3542}
.letterhead{border-bottom:3px solid var(--brand);display:flex;flex-direction:column;gap:.2rem}
.letterhead .date{color:#5a6675;margin-top:.5rem}
.letterhead .recipient{margin-top:1.1rem;line-height:1.5}
.letter-body .salutation{margin-bottom:.7rem;font-weight:600}
.signature strong{display:block;margin-top:1.6rem;font-size:1.05rem}
.cta{background:var(--brand);color:#fff;display:flex;justify-content:space-between;
  align-items:center;gap:1rem;margin-top:12px}
.cta .cta-lines{display:flex;gap:1.2rem;flex-wrap:wrap;opacity:.95}
.logo{float:right;max-height:40px;max-width:160px}
"""


def main():
    ap = argparse.ArgumentParser(description="Render a Homun doc JSON to HTML.")
    ap.add_argument("doc", nargs="?")
    ap.add_argument("--prefix", default=None)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        required = ["overflow-wrap:anywhere", "@page"]
        missing = [item for item in required if item not in _CSS_BODY]
        print(json.dumps({"ok": not missing, "missing": missing}))
        return 0 if not missing else 2
    if not args.doc:
        ap.error("the following arguments are required: doc")
    with open(args.doc, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    base_dir = os.path.dirname(os.path.abspath(args.doc))
    brand_file = os.path.join(base_dir, "brand.json")
    if os.path.isfile(brand_file):
        try:
            with open(brand_file, "r", encoding="utf-8") as fh:
                brand = json.load(fh)
            doc["theme"] = {**brand, **(doc.get("theme") or {})}
        except Exception:
            pass
    theme = doc.get("theme") or {}
    if not theme.get("logo") and os.path.isfile(os.path.join(base_dir, "logo.png")):
        theme["logo"] = "logo.png"
        doc["theme"] = theme
    prefix = args.prefix or os.path.splitext(os.path.basename(args.doc))[0]
    out_html = os.path.join(base_dir, f"{prefix}.html")
    with open(out_html, "w", encoding="utf-8") as fh:
        fh.write(render_html(doc, base_dir))
    print(f"wrote {out_html}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
