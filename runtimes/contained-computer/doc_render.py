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
             "logo": "logo.png|data:...",
             # "name" also resolves surface/ink/muted/hairline/on_brand from
             # design_tokens.THEMES (e.g. "editorial_warm"); explicit fields win.
             },
  "blocks": [ {"type": "<one of the 16 registered block types>", ...fields},
              # section_cover accepts two optional editorial fields, mirroring
              # deck_render's cover layout:
              {"type": "section_cover", "title": "...", "subtitle": "...",
               "eyebrow": "CASE STUDY",       # small-caps kicker above the title
               "hero_art": "grid"},           # procedural SVG accent: grid|rings|gradient|none
              # contact_header/letterhead (the CV/cover-letter "cover") accept the
              # same small-caps "eyebrow" kicker — but NOT hero_art: they are compact
              # header blocks sharing the page with body content, not a full-bleed
              # cover, so a background SVG would crowd the text on a one-page CV.
              {"type": "contact_header", "eyebrow": "CURRICULUM VITAE", "...": "..."},
              {"type": "letterhead", "eyebrow": "COVER LETTER", "...": "..."},
            ]
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


def _eyebrow(text):
    return f'<div class="eyebrow">{esc(text)}</div>' if text else ""


def _hero_art(kind, seq):
    # Procedural editorial art — inline SVG, zero external images (license-clean,
    # local). Uses currentColor so it inherits the accent set on the cover.
    # `seq` makes the pattern id call-unique: a fixed "g" id collided when two
    # grid blocks landed in the same document (duplicate DOM ids, invalid
    # markup — mirrors the fix in deck_render._hero_art).
    if kind == "rings":
        return ('<svg class="hero-art" viewBox="0 0 400 400" aria-hidden="true"><g fill="none" '
                'stroke="currentColor" stroke-width="1.5" opacity=".5">'
                + "".join(f'<circle cx="300" cy="90" r="{r}"/>' for r in (40, 80, 120, 170))
                + "</g></svg>")
    if kind == "grid":
        gid = f"g{seq}"
        return (f'<svg class="hero-art" viewBox="0 0 400 400" aria-hidden="true">'
                f'<defs><pattern id="{gid}" width="26" height="26" patternUnits="userSpaceOnUse">'
                f'<path d="M26 0H0V26" fill="none" stroke="currentColor" stroke-width="1" '
                f'opacity=".35"/></pattern></defs><rect width="400" height="400" fill="url(#{gid})"/></svg>')
    if kind == "gradient":
        return '<div class="hero-art hero-grad" aria-hidden="true"></div>'
    return ""


def render_block(block, base_dir, logo, seq=0):
    kind = block.get("type", "text_section")
    title = esc(block.get("title", ""))
    if kind == "section_cover":
        return (f'<section class="block cover">{_logo(logo)}'
                f'{_hero_art(block.get("hero_art", ""), seq)}'
                f'{_eyebrow(block.get("eyebrow", ""))}'
                f'<h1>{title}</h1><div class="sub">{esc(block.get("subtitle", ""))}</div>'
                f'<div class="rule"></div></section>')
    if kind == "letterhead":
        recipients = "".join(f"<div>{esc(r)}</div>" for r in block.get("recipient_lines", [])[:5])
        return (f'<section class="block letterhead">{_logo(logo)}'
                f'{_eyebrow(block.get("eyebrow", ""))}'
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
    if kind == "contact_header":
        items = "".join(f"<span>{esc(i)}</span>" for i in block.get("contact_items", [])[:6])
        return (f'<section class="block contact-header">'
                f'<div class="avatar">{esc(_initials(block.get("name", "")))}</div>'
                f'<div>{_eyebrow(block.get("eyebrow", ""))}<h1>{esc(block.get("name", ""))}</h1>'
                f'<div class="headline">{esc(block.get("headline", ""))}</div>'
                f'<div class="contact-items">{items}</div></div></section>')
    if kind == "profile_summary":
        return (f'<section class="block text profile"><h2>{title}</h2>'
                f'<p class="para">{esc(block.get("text", ""))}</p></section>')
    if kind == "timeline":
        entries = "".join(
            f'<div class="tl-entry"><div class="tl-label">{esc(e.get("label", ""))}</div>'
            f'<div class="tl-body"><strong>{esc(e.get("heading", ""))}</strong>'
            f'<span class="muted">{esc(e.get("subheading", ""))}</span>'
            f'{_bullets(e.get("points", [])[:4])}</div></div>'
            for e in block.get("entries", [])[:8])
        return f'<section class="block text"><h2>{title}</h2><div class="tl">{entries}</div></section>'
    if kind == "education_list":
        entries = "".join(
            f'<div class="edu"><span class="tl-label">{esc(e.get("label", ""))}</span>'
            f'<strong>{esc(e.get("heading", ""))}</strong>'
            f'<span class="muted">{esc(e.get("subheading", ""))}</span></div>'
            for e in block.get("entries", [])[:6])
        return f'<section class="block text"><h2>{title}</h2>{entries}</section>'
    if kind == "skill_tags":
        groups = "".join(
            f'<div class="tag-group"><span class="tag-label">{esc(g.get("label", ""))}</span>'
            + "".join(f'<i class="tag">{esc(t)}</i>' for t in g.get("tags", [])[:10])
            + "</div>"
            for g in block.get("groups", [])[:4])
        return f'<section class="block text"><h2>{title}</h2>{groups}</section>'
    if kind in ("pricing_table", "spec_table"):
        # Shared table renderer for both kinds — same markup, different caps
        # (pricing decks stay short/wide; spec sheets can run longer/narrower).
        max_cols = 5 if kind == "pricing_table" else 4
        max_rows = 10 if kind == "pricing_table" else 12
        headers = block.get("headers", [])[:max_cols]
        rows = block.get("rows", [])[:max_rows]
        table = ""
        if headers and rows:
            head = "".join(f"<th>{esc(h)}</th>" for h in headers)
            body = "".join(
                "<tr>" + "".join(f"<td>{esc(c)}</td>" for c in row[: len(headers)]) + "</tr>"
                for row in rows)
            table = (f'<table class="tbl"><thead><tr>{head}</tr></thead>'
                     f"<tbody>{body}</tbody></table>")
        note = block.get("note", "")
        note_html = f'<p class="muted note">{esc(note)}</p>' if note else ""
        return f'<section class="block text"><h2>{title}</h2>{table}{note_html}</section>'
    if kind == "product_grid":
        cards = "".join(
            f'<div class="product"><div class="product-head">'
            + f'<strong>{esc(p.get("name", ""))}</strong>'
            + (f'<i class="badge">{esc(p.get("badge", ""))}</i>' if p.get("badge") else "")
            + '</div>'
            f'<p class="para">{esc(p.get("description", ""))}</p>'
            f'<span class="price">{esc(p.get("price", ""))}</span></div>'
            for p in block.get("products", [])[:9])
        return (f'<section class="block text"><h2>{title}</h2>'
                f'<div class="products">{cards}</div></section>')
    if kind == "kpi_band":
        items = "".join(
            f'<div class="kpi-item"><strong>{esc(i.get("value", ""))}</strong>'
            f'<span>{esc(i.get("label", ""))}</span></div>'
            for i in block.get("items", [])[:4])
        return (f'<section class="block kpis">'
                + (f"<h2>{title}</h2>" if title else "")
                + f'<div class="kpi-row">{items}</div></section>')
    if kind == "testimonial_quote":
        return (f'<section class="block quote"><blockquote>“{esc(block.get("quote", ""))}”'
                f"</blockquote><div class=\"muted\">— {esc(block.get('author', ''))}, "
                f"{esc(block.get('role', ''))}</div></section>")
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
    name = raw_theme.get("name")
    # Explicit fields win; a NAMED theme resolves via THEMES; with no name the
    # base is DEFAULT_THEME (never a silent clean_corporate fallback —
    # theme_values() defaults nameless lookups to that catalog entry, which
    # would leak its values into partial themes and no-theme docs alike).
    if name:
        theme = {**DEFAULT_THEME, **theme_values(name, raw_theme)}
    else:
        theme = {**DEFAULT_THEME, **{k: v for k, v in raw_theme.items() if v}}
    logo = data_url(theme.get("logo", ""), base_dir)
    # enumerate() gives _hero_art a call-unique seq per block (see _hero_art docstring).
    body = "".join(render_block(b, base_dir, logo, seq) for seq, b in enumerate(doc.get("blocks", [])))
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
            f"--body:'{theme['body_font']}';--doc-width:794px;"
            f"--surface:{theme.get('surface', '#ffffff')};--ink:{theme.get('ink', '#16202b')};"
            f"--muted:{theme.get('muted', '#5a6675')};--hairline:{theme.get('hairline', '#e4e9ef')};"
            f"--on-brand:{theme.get('on_brand', '#ffffff')};}}")


_CSS_BODY = """
@page{size:A4;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--body),-apple-system,'Segoe UI',sans-serif;background:var(--surface);color:var(--ink)}
.doc{width:var(--doc-width);margin:0 auto}
.block{padding:28px 44px;overflow-wrap:anywhere}
h1,h2,h3,strong{font-family:var(--head),sans-serif}
.muted{color:#5a6675}
.cover{background:var(--surface);color:var(--ink);
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
.contact-header{display:flex;gap:20px;align-items:center;border-bottom:4px solid var(--brand);
  padding-bottom:22px}
.contact-header .avatar{width:72px;height:72px;border-radius:50%;background:var(--brand);
  color:var(--on-brand);display:flex;align-items:center;justify-content:center;font-weight:800;
  font-size:1.5rem;flex:none}
.contact-header h1{font-size:1.7rem;letter-spacing:-.01em}
.contact-header .headline{color:var(--brand);font-weight:600;margin-top:.15rem}
.contact-header .contact-items{display:flex;gap:.9rem;flex-wrap:wrap;color:#5a6675;
  font-size:.9rem;margin-top:.45rem}
.tl{display:flex;flex-direction:column;gap:.9rem}
.tl-entry{display:grid;grid-template-columns:110px 1fr;gap:14px}
.tl-label{color:var(--brand);font-weight:700;font-size:.9rem}
.tl-body strong{display:block}
.tl-body .muted{display:block;font-size:.92rem;margin:.1rem 0 .2rem}
.edu{display:grid;grid-template-columns:110px 1fr auto;gap:14px;margin:.45rem 0;align-items:baseline}
.tag-group{margin:.4rem 0}
/* `muted`, not `secondary`/--brand2: the editorial themes use `secondary` as a
   near-surface FILL tone (a light chip-background hue on light surfaces, a
   near-black one on dark surfaces) — reading it as caption TEXT on `surface`
   gave ~1.1:1 contrast (invisible). `muted` is the token contract's actual
   "caption/metadata text on surface" colour and passes contrast on every theme. */
.tag-label{font-weight:700;margin-right:.6rem;color:var(--muted)}
.tag{display:inline-block;background:var(--hairline);border-radius:999px;padding:.18rem .7rem;
  margin:.15rem .25rem;font-style:normal;font-size:.88rem;color:#2a3542}
table.tbl{width:100%;border-collapse:collapse;margin-top:.6rem;font-size:.95rem}
table.tbl th{text-align:left;background:var(--brand);color:var(--on-brand);padding:.55rem .8rem}
table.tbl td{padding:.5rem .8rem;color:#2a3542;border-bottom:1px solid var(--hairline)}
table.tbl tr:nth-child(even) td{background:var(--hairline)}
.note{margin-top:.5rem;font-size:.88rem}
.products{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:.7rem}
.product{border:1px solid var(--hairline);border-radius:10px;padding:14px}
/* Badge sits in a flex header NEXT TO the name (not position:absolute over it):
   a long badge label (e.g. "BESTSELLER") used to overlap/clip a short product
   name — flex-wrap lets it drop to its own line instead of covering the text. */
.product-head{display:flex;align-items:flex-start;justify-content:space-between;
  gap:8px;flex-wrap:wrap}
.product .badge{background:var(--accent);color:#fff;flex:none;
  font-style:normal;font-size:.7rem;font-weight:800;border-radius:6px;padding:.15rem .45rem}
.product .price{color:var(--brand);font-weight:800;margin-top:.4rem;display:block}
.kpis{background:var(--hairline);border-top:3px solid var(--accent)}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;
  margin-top:.5rem}
.kpi-item strong{font-size:1.8rem;color:var(--brand);display:block;letter-spacing:-.02em}
.kpi-item span{color:#5a6675;font-size:.9rem}
.quote blockquote{font-size:1.3rem;font-weight:700;line-height:1.4;color:#16202b}
.quote blockquote::first-letter{color:var(--accent)}
.eyebrow{text-transform:uppercase;letter-spacing:.26em;font-size:.8rem;font-weight:700;
  color:var(--accent);margin-bottom:.7rem}
.cover h1{font-size:3.2rem;letter-spacing:-.02em}
.cover .sub{color:var(--muted)}
.hero-art{position:absolute;right:0;top:0;width:38%;height:100%;color:var(--accent);
  opacity:.85;pointer-events:none}
.hero-art.hero-grad{background:radial-gradient(120% 120% at 90% 0%,
  color-mix(in srgb,var(--accent) 38%,transparent),transparent 62%)}
.cover{position:relative;overflow:hidden}
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
