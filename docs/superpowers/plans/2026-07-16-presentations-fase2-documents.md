# Presentations Fase 2 — Documenti di prima classe: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** I 6 template documento (CV, lettera, catalogo prodotti, proposta, one-pager, case study) diventano pack reali con renderer di design (`doc_render.py` → HTML/PDF) + DOCX editabile dal writer Rust, generati via slot-filling schema-enforced.

**Architecture:** Un `doc.json` a blocchi tipizzati è l'unica fonte; `doc_render.py` (container, sibling di `deck_render.py`, stesso shim Dockerfile) lo proietta in HTML self-contained → PDF via Chromium; il gateway lo proietta in DOCX estendendo il writer OOXML esistente. Il contenuto lo riempie il modello con **slot-filling strict**: lo schema è un oggetto a proprietà fisse derivate dallo scheletro di `example.json` del pack (il modello non sceglie MAI i blocchi — caposaldo "slot vincolati"). `make_document` biforca: template documento bundled → path nuovo; altrimenti → path markdown esistente INVARIATO.

**Tech Stack:** Python stdlib (doc_render, QA via CDP esistente), Rust (gateway: schema, DOCX, dispatch), nessuna dipendenza nuova.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-presentations-professional-templates-design.md` (approvata; F1 shipped — pack format, provider bundled, preview committate esistono già).
- Commenti in inglese (il perché), docs in italiano. Commit su `main`, NIENTE `Co-Authored-By`, NIENTE push.
- ⚠️ Numeri di riga = anchor che invecchiano: **ri-greppa il simbolo**.
- `main.rs` non cresce oltre il necessario: la logica schema/blocchi documento va in un modulo nuovo `crates/desktop-gateway/src/document_content.rs`; in main.rs restano dispatch, DOCX writer (accanto a `markdown_to_docx`) e il branch di `make_document`.
- **Il path markdown esistente di `make_document` resta byte-identico** quando non c'è un template documento bundled: è il fallback provato, non si tocca.
- CSS del renderer documenti: NIENTE `.format()` su tutto il CSS (il gotcha delle graffe doppie di F1). Pattern: `_CSS_TOKENS` piccolo e formattato (solo `:root{--…}`) + `_CSS_BODY` costante RAW concatenata.
- Probe nei test del renderer: MAI substring del titolo di sezione (lezione F1: il titolo renderizza per ogni blocco → probe vacuo). Probe = stringhe che esistono SOLO nel contenuto del blocco.
- ⚠️ **La validazione live del path container richiede il REBUILD dell'immagine contained-computer** (`up.sh`): i test deterministici non ne dipendono; il piano si ferma a gate verdi + preview ispezionabili; la validazione in-app la fa Fabio a schermo (niente computer-use).
- Gate: `cargo test -p local-first-desktop-gateway`, unittest renderer, `npm run build`, `test:ui-contract`, `test:electron`, `pre_release_gate.py` ALL GREEN.
- ID pack v1 (fissati): `homun/cv-professional-01`, `homun/cover-letter-01`, `homun/product-catalog-01`, `homun/sales-proposal-01`, `homun/company-one-pager-01`, `homun/customer-case-study-01`.

## I 16 blocchi documento (registro unico, condiviso renderer↔schema↔DOCX)

| type | campi (tutti stringa salvo diversa nota) | note |
| --- | --- | --- |
| `section_cover` | title, subtitle | pagina/testata di sezione, brand bg |
| `text_section` | title, paragraphs[] (≤6), bullets[] (≤8) | corpo generico |
| `letterhead` | organization, contact_line, date_line, recipient_lines[] (≤5) | logo slot |
| `letter_body` | salutation, paragraphs[] (≤8) | |
| `signature_block` | closing, name, role | |
| `cta_footer` | heading, lines[] (≤3) | contatti/chiusura |
| `contact_header` | name, headline, contact_items[] (≤6) | CV header, avatar iniziali |
| `profile_summary` | title, text | |
| `timeline` | title, entries[] {label, heading, subheading, points[] (≤4)} (≤8) | esperienze/fasi |
| `education_list` | title, entries[] {label, heading, subheading} (≤6) | |
| `skill_tags` | title, groups[] {label, tags[] (≤10)} (≤4) | |
| `product_grid` | title, products[] {name, description, price, badge} (≤9) | |
| `pricing_table` | title, headers[] (≤5), rows[][] (≤10 righe, ≤5 celle per riga), note | celle per riga = cap degli headers |
| `spec_table` | title, headers[] (≤4), rows[][] (≤12 righe, ≤4 celle per riga) | celle per riga = cap degli headers |
| `kpi_band` | title, items[] {value, label} (≤4) | |
| `testimonial_quote` | quote, author, role | |

---

### Task 1: `doc_render.py` core + blocchi strutturali (section_cover, text_section, letterhead, letter_body, signature_block, cta_footer)

**Files:**
- Create: `runtimes/contained-computer/design_tokens.py`
- Create: `runtimes/contained-computer/doc_render.py`
- Create: `runtimes/contained-computer/test_doc_render.py`
- Modify: `scripts/pre_release_gate.py` (Step accanto a "deck renderer tests")

**Interfaces:**
- Produces: `doc_render.render_html(doc: dict, base_dir: str) -> str`; CLI `doc_render.py doc.json [--prefix out] [--self-test]` che scrive `<prefix>.html`; `design_tokens.THEMES: dict` (5 temi con palette/typography). doc.json: `{"title","theme":{come deck},"blocks":[{"type":...,...}]}`. Brand auto-apply identico a deck_render (`brand.json`+`logo.png` in cwd). HTML root: `<div class="doc">` con `--doc-width:794px` (A4 @96dpi), `@page{size:A4;margin:0}`.

- [ ] **Step 1: Test fallente**

`runtimes/contained-computer/test_doc_render.py`:

```python
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
```

- [ ] **Step 2: Run — FAIL** (`doc_render.py` inesistente)

Run: `python3 -m unittest discover -s runtimes/contained-computer -p 'test_doc_render.py' -v`

- [ ] **Step 3: `design_tokens.py`**

```python
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
```

- [ ] **Step 4: `doc_render.py`** — shell + i 6 blocchi

```python
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
```

Dispatch + i 6 blocchi strutturali (dopo gli helper):

```python
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
    theme = {**DEFAULT_THEME, **theme_values(raw_theme.get("name"), raw_theme)}
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
```

`_CSS_BODY` (costante raw, niente format — graffe singole legali):

```python
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
```

CLI `main()` — specchia deck_render (brand.json auto-apply, `--self-test` che verifica `overflow-wrap:anywhere` e `@page` in `_CSS_BODY`, scrive `<prefix>.html`):

```python
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
```

⚠️ `doc_render.py` importa `design_tokens` (stessa dir): il test loader importlib carica per path — aggiungi `sys.path.insert(0, HERE)` nel test PRIMA di exec_module se l'import fallisce.

- [ ] **Step 5: Run — verde** + gate step

Run: `python3 -m unittest discover -s runtimes/contained-computer -p 'test_doc_render.py' -v` → PASS.
In `scripts/pre_release_gate.py`, subito dopo lo Step "deck renderer tests":

```python
        Step(
            "doc renderer tests",
            [PYTHON, "-m", "unittest", "discover", "-s",
             "runtimes/contained-computer", "-p", "test_doc_render.py"],
        ),
```

Run: `python3 -m unittest scripts.test_pre_release_gate` → PASS. `python3 runtimes/contained-computer/doc_render.py --self-test` → ok:true.

- [ ] **Step 6: Commit**

```bash
git add runtimes/contained-computer/design_tokens.py runtimes/contained-computer/doc_render.py runtimes/contained-computer/test_doc_render.py scripts/pre_release_gate.py
git commit -m "feat(doc-render): document renderer core with structural blocks and shared design tokens"
```

---

### Task 2: blocchi profilo/CV (contact_header, profile_summary, timeline, education_list, skill_tags)

**Files:**
- Modify: `runtimes/contained-computer/doc_render.py` (rami in `render_block` + CSS in `_CSS_BODY`)
- Modify: `runtimes/contained-computer/test_doc_render.py`

**Interfaces:**
- Consumes: Task 1 (`render_block`, `_initials`, `esc`, `_CSS_BODY`).
- Produces: i 5 blocchi renderizzati; campi come da registro blocchi in testa al piano.

- [ ] **Step 1: Test fallente** (aggiungi alla classe esistente o nuova classe)

```python
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
```

- [ ] **Step 2: Run — FAIL**, poi implementa i rami in `render_block` (prima del fallback):

```python
    if kind == "contact_header":
        items = "".join(f"<span>{esc(i)}</span>" for i in block.get("contact_items", [])[:6])
        return (f'<section class="block contact-header">'
                f'<div class="avatar">{esc(_initials(block.get("name", "")))}</div>'
                f'<div><h1>{esc(block.get("name", ""))}</h1>'
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
```

CSS da appendere a `_CSS_BODY` (raw):

```css
.contact-header{display:flex;gap:20px;align-items:center;border-bottom:4px solid var(--brand);
  padding-bottom:22px}
.contact-header .avatar{width:72px;height:72px;border-radius:50%;background:var(--brand);
  color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;
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
.tag-label{font-weight:700;margin-right:.6rem;color:var(--brand2)}
.tag{display:inline-block;background:#eef1f5;border-radius:999px;padding:.18rem .7rem;
  margin:.15rem .25rem;font-style:normal;font-size:.88rem;color:#2a3542}
```

- [ ] **Step 3: Run — verde** (`python3 -m unittest discover -s runtimes/contained-computer -p 'test_doc_render.py' -v`; anche `--self-test` resta ok)

- [ ] **Step 4: Commit**

```bash
git add runtimes/contained-computer/doc_render.py runtimes/contained-computer/test_doc_render.py
git commit -m "feat(doc-render): cv/profile blocks — contact header, timeline, education, skill tags"
```

---

### Task 3: blocchi commerciali (product_grid, pricing_table, spec_table, kpi_band, testimonial_quote)

**Files:**
- Modify: `runtimes/contained-computer/doc_render.py`
- Modify: `runtimes/contained-computer/test_doc_render.py`

**Interfaces:** consumes Task 1-2; produces gli ultimi 5 blocchi del registro.

- [ ] **Step 1: Test fallente**

```python
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
```

- [ ] **Step 2: Run — FAIL**, poi i rami:

```python
    if kind in ("pricing_table", "spec_table"):
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
            f'<div class="product">'
            + (f'<i class="badge">{esc(p.get("badge", ""))}</i>' if p.get("badge") else "")
            + f'<strong>{esc(p.get("name", ""))}</strong>'
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
```

CSS da appendere (raw):

```css
table.tbl{width:100%;border-collapse:collapse;margin-top:.6rem;font-size:.95rem}
table.tbl th{text-align:left;background:var(--brand);color:#fff;padding:.55rem .8rem}
table.tbl td{padding:.5rem .8rem;color:#2a3542;border-bottom:1px solid #e4e9ef}
table.tbl tr:nth-child(even) td{background:#f6f8fa}
.note{margin-top:.5rem;font-size:.88rem}
.products{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:.7rem}
.product{border:1px solid #e4e9ef;border-radius:10px;padding:14px;position:relative}
.product .badge{position:absolute;top:10px;right:10px;background:var(--accent);color:#fff;
  font-style:normal;font-size:.7rem;font-weight:800;border-radius:6px;padding:.15rem .45rem}
.product .price{color:var(--brand);font-weight:800;margin-top:.4rem;display:block}
.kpis{background:#f6f8fa;border-top:3px solid var(--accent)}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;
  margin-top:.5rem}
.kpi-item strong{font-size:1.8rem;color:var(--brand);display:block;letter-spacing:-.02em}
.kpi-item span{color:#5a6675;font-size:.9rem}
.quote blockquote{font-size:1.3rem;font-weight:700;line-height:1.4;color:#16202b}
.quote blockquote::first-letter{color:var(--accent)}
```

- [ ] **Step 3: Run — verde**, **Step 4: Commit**

```bash
git add runtimes/contained-computer/doc_render.py runtimes/contained-computer/test_doc_render.py
git commit -m "feat(doc-render): commerce blocks — product grid, pricing/spec tables, kpi band, testimonial"
```

---

### Task 4: QA documenti (`deck_qa.py --mode document`) + shim container `doc-render`

**Files:**
- Modify: `runtimes/contained-computer/deck_qa.py` (CLI + QA_JS parametrizzato)
- Modify: `runtimes/contained-computer/Dockerfile` (COPY doc_render.py/design_tokens.py + shim `/usr/local/bin/doc-render`)
- Test: estendi il self-test di deck_qa o verifica CLI-level (sotto)

**Interfaces:**
- Produces: `deck-qa <html> --json --mode document` → stesso JSON shape (`ok`, `slide_count`, `issues[]`), ma container selector `.doc .block`, **senza** i check di overflow verticale (i documenti paginano in stampa: l'altezza scorre) — restano horizontal overflow, `image_not_loaded`, `text_too_small`, `low_contrast`. Shim container: `doc-render` esegue `/opt/deck-venv/bin/python /opt/deck/doc_render.py`.

- [ ] **Step 1: leggi `QA_JS` e il CLI di deck_qa.py** (grep `add_argument` e `.slide`): il piano richiede — (a) `--mode` con default `deck`; (b) in QA_JS il selector e i check condizionali iniettati come costanti JS in testa (`const MODE = "%s";` via sostituzione stringa semplice, NON .format sull'intero JS — stesso principio anti-graffe); (c) `slide_overflow`/`element_outside_slide` eseguiti solo quando `MODE === "deck"`; per `document` il container è `.doc` e si aggiunge SOLO `doc_horizontal_overflow` (scrollWidth > clientWidth + 1 sul `.doc`).

- [ ] **Step 2: verifica deterministica senza container** — crea due fixture HTML temporanee in un test shell manuale:

Run:
```bash
python3 - <<'EOF'
# Renders a doc via doc_render and checks deck_qa --mode document accepts the flag
# and self-test still passes. Full CDP QA needs Chromium: covered by --self-test paths.
import subprocess, sys
r = subprocess.run([sys.executable, "runtimes/contained-computer/deck_qa.py", "--self-test"],
                   capture_output=True, text=True)
print(r.stdout, r.stderr)
assert r.returncode == 0
EOF
```
Expected: self-test ok. Se `deck_qa.py --self-test` copre asserzioni sul JS, estendile con la presenza di `MODE` (leggi prima com'è fatto il self-test e specchialo).
Se Chromium è disponibile sull'host, verifica anche live: `python3 runtimes/contained-computer/deck_qa.py <un preview.html di un pack F1> --json` → ok e `--mode document` su un HTML doc di prova → ok.

- [ ] **Step 3: Dockerfile** — accanto ai COPY deck:

```dockerfile
COPY doc_render.py    /opt/deck/doc_render.py
COPY design_tokens.py /opt/deck/design_tokens.py
RUN printf '#!/bin/sh\nexec /opt/deck-venv/bin/python /opt/deck/doc_render.py "$@"\n' > /usr/local/bin/doc-render \
 && chmod +x /usr/local/bin/doc-render
```

(⚠️ `doc_render.py` importa `design_tokens` dalla stessa dir — il venv python la risolve perché lo script è eseguito per path da `/opt/deck/`.)

- [ ] **Step 4: Commit**

```bash
git add runtimes/contained-computer/deck_qa.py runtimes/contained-computer/Dockerfile
git commit -m "feat(deck-qa): document mode + doc-render container shim"
```

---

### Task 5: whitelist gateway per i template documento (cv, cover_letter, product_catalog)

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` — `DELIVERABLE_DESIGN_TEMPLATES` (grep), `deliverable_template_defaults` (grep), `deliverable_design_template_directive` (grep)
- Test: mod tests di main.rs

**Interfaces:**
- Produces: `DELIVERABLE_DESIGN_TEMPLATES` include anche `"cv"`, `"cover_letter"`, `"product_catalog"`; `deliverable_template_defaults` mappa: `cv` → (Some("minimal"), ["timeline"]) · `cover_letter` → (Some("minimal"), []) · `product_catalog` → (Some("editorial"), ["comparison_table"]). Directive arm per ciascuno (frase inglese in stile con le esistenti).
- Produces (spec Sezione 4 — le domande del template arrivano alla UI): `TemplateCatalogEntry.intake_questions: Vec<String>` parsato dal manifest via `clean_template_catalog_string_list(value.get("intake_questions"), 6, 200)` in `parse_file_template_catalog_entry`, esposto identico su `TemplateCatalogEntryResponse` (+ i costruttori esistenti valorizzano `Vec::new()` — il compilatore li elenca).

- [ ] **Step 1: Test fallente**

```rust
#[test]
fn document_template_families_are_whitelisted_with_defaults() {
    for template in ["cv", "cover_letter", "product_catalog"] {
        assert!(super::DELIVERABLE_DESIGN_TEMPLATES.contains(&template));
        let (profile, _components) = super::deliverable_template_defaults(Some(template));
        assert!(profile.is_some(), "{template} must have a default profile");
    }
}
```
(⚠️ prima di scriverlo, RILEGGI la firma reale di `deliverable_template_defaults` — se prende `&str`/`Option<&str>` o torna tuple diverse, adatta il test alla firma vera, senza indebolire le asserzioni.)

- [ ] **Step 1b: Test fallente per intake_questions**

```rust
#[test]
fn file_template_catalog_entry_parses_intake_questions() {
    let manifest = serde_json::json!({
        "provider_id": "acme",
        "templates": [{
            "id": "acme/q-01", "kind": "document", "name": "Q",
            "description": "Doc with questions.", "design_template": "sales_proposal",
            "route_text": "q",
            "intake_questions": ["Who is it for?", "Which numbers matter?"]
        }]
    });
    let provider = super::FileTemplateCatalogProvider::from_json_str(
        manifest.to_string().as_str()).expect("provider");
    assert_eq!(provider.entries[0].intake_questions,
               vec!["Who is it for?", "Which numbers matter?"]);
}
```

- [ ] **Step 2: Run — FAIL**, poi implementa: aggiungi le 3 stringhe alla const, i 3 arm ai defaults, i 3 arm alla directive fn (frasi tipo: `"cv" => "Structure it as a professional CV: profile first, reverse-chronological experience, tight factual bullets."`), e il campo `intake_questions` (entry+parse+response+costruttori compiler-driven, come da Interfaces).

- [ ] **Step 3: Run — verde** (`cargo test -p local-first-desktop-gateway document_template_families -- --nocapture` + full crate), **Step 4: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(templates): cv, cover_letter and product_catalog design template families"
```

---

### Task 6: modulo `document_content.rs` — skeleton, slot-schema strict, generazione

**Files:**
- Create: `crates/desktop-gateway/src/document_content.rs` (+ `mod document_content;` in main.rs)
- Test: dentro il modulo

**Interfaces:**
- Consumes: `crate::TemplateCatalogEntry` (per `template_pack_root`), `local_first_inference::openai_compat::structured_response_format` (verifica il path reale con grep `structured_response_format` — usa lo stesso import di `generate_deck_content`).
- Produces:
  - `pub(crate) struct DocBlockSlot { pub(crate) block_type: String, pub(crate) slot_key: String }`
  - `pub(crate) fn document_block_skeleton(example: &serde_json::Value) -> Vec<DocBlockSlot>` — legge `example["blocks"][*]["type"]`, slot_key = `format!("slot_{i}_{type}")`.
  - `pub(crate) fn document_block_schema(block_type: &str) -> Option<serde_json::Value>` — registro dei 16 blocchi (campi/limiti dalla tabella in testa al piano; ogni campo con `description` per il modello; `additionalProperties:false`, tutti i campi `required` in strict mode — usa `""`/`[]` come "vuoto").
  - `pub(crate) fn document_content_schema(skeleton: &[DocBlockSlot]) -> serde_json::Value` — oggetto `{title: string, slots: {<slot_key>: <block schema>…}}`, `additionalProperties:false`, tutto required. **Il modello non sceglie i blocchi: riempie slot fissi** (caposaldo).
  - `pub(crate) fn assemble_doc_json(title_fallback: &str, skeleton: &[DocBlockSlot], model_output: &serde_json::Value) -> Result<serde_json::Value, String>` — rimonta `{"title", "blocks":[{"type": ...campi dallo slot}]}` nell'ordine dello skeleton; slot mancante → `Err` con il nome dello slot (il chiamante ritenta o fallisce, MAI blocchi inventati).
  - `pub(crate) fn load_pack_example(entry: &TemplateCatalogEntry) -> Result<serde_json::Value, String>` — legge `template_pack_root/example.json`.

- [ ] **Step 1: Test fallenti** (nel modulo)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn example() -> serde_json::Value {
        serde_json::json!({"blocks": [
            {"type": "contact_header", "name": "X"},
            {"type": "timeline", "title": "Experience"}
        ]})
    }

    #[test]
    fn skeleton_extracts_ordered_slots() {
        let skeleton = document_block_skeleton(&example());
        assert_eq!(skeleton.len(), 2);
        assert_eq!(skeleton[0].block_type, "contact_header");
        assert_eq!(skeleton[0].slot_key, "slot_0_contact_header");
        assert_eq!(skeleton[1].slot_key, "slot_1_timeline");
    }

    #[test]
    fn content_schema_is_strict_slot_filling() {
        let skeleton = document_block_skeleton(&example());
        let schema = document_content_schema(&skeleton);
        let slots = &schema["properties"]["slots"];
        assert!(slots["properties"]["slot_0_contact_header"].is_object());
        assert_eq!(slots["additionalProperties"], serde_json::json!(false));
        let required: Vec<&str> = slots["required"].as_array().unwrap()
            .iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(required, vec!["slot_0_contact_header", "slot_1_timeline"]);
    }

    #[test]
    fn every_registered_block_type_has_a_schema() {
        for block_type in ["section_cover", "text_section", "letterhead", "letter_body",
                           "signature_block", "cta_footer", "contact_header",
                           "profile_summary", "timeline", "education_list", "skill_tags",
                           "product_grid", "pricing_table", "spec_table", "kpi_band",
                           "testimonial_quote"] {
            assert!(document_block_schema(block_type).is_some(), "{block_type}");
        }
        assert!(document_block_schema("mystery").is_none());
    }

    #[test]
    fn assemble_reorders_slots_and_fails_on_missing() {
        let skeleton = document_block_skeleton(&example());
        let output = serde_json::json!({"title": "Doc", "slots": {
            "slot_1_timeline": {"title": "Exp", "entries": []},
            "slot_0_contact_header": {"name": "Elena", "headline": "", "contact_items": []}
        }});
        let doc = assemble_doc_json("fallback", &skeleton, &output).unwrap();
        assert_eq!(doc["blocks"][0]["type"], "contact_header");
        assert_eq!(doc["blocks"][0]["name"], "Elena");
        assert_eq!(doc["blocks"][1]["type"], "timeline");
        let missing = serde_json::json!({"title": "Doc", "slots": {}});
        assert!(assemble_doc_json("f", &skeleton, &missing).is_err());
    }
}
```

- [ ] **Step 2: Run — FAIL di compilazione**, poi implementa il modulo. Nota di stile per `document_block_schema`: un helper interno `fn s(desc: &str) -> Value` per `{"type":"string","description":…}` e `fn arr(items: Value, max: usize) -> Value` tengono il registro leggibile (16 arm compatti). `assemble_doc_json`: per ogni slot, prendi l'oggetto, inserisci `"type"` e fai merge dei campi.

- [ ] **Step 3: `generate_document_content`** — nello stesso modulo:

```rust
/// Mirror of generate_deck_content for documents: strict slot-filling schema
/// first, json_object fallback on HTTP 400 (some providers reject json_schema).
/// The caller validates via assemble_doc_json — a malformed answer never
/// reaches the renderer.
pub(crate) async fn generate_document_content(
    http: &reqwest::Client, base_url: &str, model: &str, api_key: Option<&str>,
    brief: &str, language: &str, skeleton: &[DocBlockSlot],
    design_directives: &str,
) -> Result<serde_json::Value, String>
```
Corpo: specchia `generate_deck_content` (grep in main.rs: due tentativi, `structured_response_format("homun_document", Some(&schema))` poi fallback `None`; temperature 0.35; system prompt: "You are a senior business writer. Fill EVERY slot of this document template in {language}. Slots are fixed — do not add, remove or reorder sections. Return ONLY the JSON object." + design_directives; user = brief). Parse tolerante dell'output (json diretto; se wrappato, cerca il primo oggetto con `slots`).
⚠️ NON unit-testare la chiamata HTTP (nessun mock infra qui): la logica testabile è skeleton/schema/assemble (già coperta). La chiamata si valida nel LIVE.

- [ ] **Step 4: Run — verde** (`cargo test -p local-first-desktop-gateway document_content -- --nocapture` + crate), **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/document_content.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(documents): slot-filling content schema module (skeleton, strict schema, assemble)"
```

---

### Task 7: `doc_json_to_docx` + kind artifact `.docx`

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` — nuova fn accanto a `markdown_to_docx` (grep); `artifact_memory_kind` (grep)
- Test: mod tests di main.rs

**Interfaces:**
- Consumes: helper esistenti `docx_text_run`, `markdown_inline_to_docx_runs`, `markdown_table_to_docx`, `xml_escape_text` + il tail di packaging di `markdown_to_docx` (estrai il tail in `fn docx_package(document_body: String) -> Result<Vec<u8>, String>` se non già separato — refactor behavior-preserving: `markdown_to_docx` lo chiama).
- Produces: `fn doc_json_to_docx(doc: &serde_json::Value) -> Result<Vec<u8>, String>` — mappa i 16 blocchi in OOXML: titoli blocco → Heading2; `section_cover.title` → Heading1; paragraphs → Normal; bullets/points → ListParagraph; `pricing_table`/`spec_table` → `markdown_table_to_docx(rows_con_header)`; `product_grid` → tabella Name/Description/Price; `timeline`/`education_list` → paragrafo bold heading + riga muted (label — subheading) + bullets; `kpi_band` → tabella 1-riga value/label; `contact_header` → Heading1 nome + riga contatti; `letterhead/letter_body/signature/cta/testimonial/profile` → paragrafi. **Best-effort dichiarato: il PDF è la fedeltà, il DOCX è l'editabilità** (niente colori custom oltre gli stili esistenti — YAGNI).
- `artifact_memory_kind`: arm `"docx" => "document"`.

- [ ] **Step 1: Test fallenti**

```rust
#[test]
fn doc_json_to_docx_renders_blocks_structurally() {
    let doc = serde_json::json!({"title": "CV Elena", "blocks": [
        {"type": "contact_header", "name": "Elena Ricci", "headline": "Ops Director",
         "contact_items": ["elena@example.com"]},
        {"type": "timeline", "title": "Experience", "entries": [
            {"label": "2022", "heading": "Director", "subheading": "Aurora",
             "points": ["TimelinePointProbe"]}]},
        {"type": "pricing_table", "title": "Pricing", "headers": ["Plan", "Price"],
         "rows": [["Base", "PriceCellProbe"]], "note": ""}
    ]});
    let bytes = super::doc_json_to_docx(&doc).expect("docx");
    // The OOXML document.xml is STORED inside the zip; probe the raw bytes for
    // needle strings (same trick the markdown_to_docx tests use — check them
    // first with grep and mirror their probing approach exactly).
    let haystack = String::from_utf8_lossy(&bytes).into_owned();
    for probe in ["Elena Ricci", "TimelinePointProbe", "PriceCellProbe"] {
        assert!(haystack.contains(probe), "missing {probe}");
    }
}

#[test]
fn docx_artifacts_register_as_documents() {
    assert_eq!(super::artifact_memory_kind("cv.docx"), "document");
    assert_eq!(super::artifact_memory_kind("deck.pptx"), "presentation");
}
```
⚠️ Il probe-sui-bytes funziona solo se il zip usa STORED (no deflate) per document.xml — VERIFICA come i test esistenti di `markdown_to_docx` fanno le asserzioni (grep `markdown_to_docx` nel mod tests) e specchia ESATTAMENTE la loro tecnica (se unzippano, unzippa).

- [ ] **Step 2: Run — FAIL**, implementa (estrazione `docx_package` + `doc_json_to_docx` + arm kind), **Step 3: Run — verde** (full crate: la firma estratta non deve rompere `markdown_to_docx`), **Step 4: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(documents): structural doc.json→docx writer and docx artifact kind"
```

---

### Task 8: `make_document` — il path templated

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` — branch `make_document` (grep `"make_document"` nel dispatch, ~21405), `emit_rendered_deck_artifacts` (grep), nuova pure fn `build_document_render_command`
- Test: mod tests

**Interfaces:**
- Consumes: Task 6 (`document_content::*`), Task 7 (`doc_json_to_docx`), Task 4 (comando `doc-render`/`deck-qa --mode document`), esistenti: `materialize_brand_kit`, `write_artifact_bytes`, `sandbox::run_command`, `sandbox::container_output_dir`, `rendered_deck_qa_result`/`rendered_deck_qa_failure`/`deck_quality_metadata_from_qa_result`.
- Produces:
  - `fn build_document_render_command(container_out: &str, stem: &str) -> String`:
    ```rust
    format!(
        "cd '{container_out}' && doc-render {stem}.json --prefix {stem} && \\\n chromium --headless --no-sandbox --disable-gpu --print-to-pdf={stem}.pdf {stem}.html >/dev/null 2>&1 && \\\n qa=$(deck-qa {stem}.html --json --mode document 2>&1); qa_code=$?; \\\n echo \"DECK_QA_JSON:$qa\"; \\\n if [ \"$qa_code\" -ne 0 ]; then exit \"$qa_code\"; fi; \\\n ls -la {stem}.html {stem}.pdf 2>&1"
    )
    ```
    (stesso shape del comando deck — riusa il prefisso `DECK_QA_JSON:` così il parser esistente converge).
  - `emit_rendered_deck_artifacts` generalizzata: nuovo param `names: &[String]` al posto della lista fissa; il call-site deck passa `["deck.pptx","deck.html","deck.pdf"]` (behavior-preserving); il call-site document passa `["{stem}.html","{stem}.pdf","{stem}.docx"]`.
  - Branch in `make_document`: DOPO `document_generation_options` — se `options.template_ref` risolve a un catalog entry con `kind == "document"` && `bundled` && `template_pack_root.is_some()` → **path templated**:
    1. `materialize_brand_kit(&thread_slug)`;
    2. skeleton = `document_block_skeleton(&load_pack_example(&entry)?)`;
    3. `generate_document_content(...)` con le directives di design già costruite (`document_generation_directives(&options)`) → `assemble_doc_json` (1 retry con messaggio correttivo sul slot mancante, poi errore onesto);
    4. merge `theme.name = entry.design_theme` nel doc.json (il brand kit vince al render);
    5. `write_artifact_bytes(slug, "{stem}.json", doc_pretty)`; DOCX subito in-gateway: `doc_json_to_docx` → `write_artifact_bytes("{stem}.docx")`;
    6. `sandbox::run_command(build_document_render_command(...), None)`:
       - Ok → parse QA (`rendered_deck_qa_result`), emit artifacts (html, pdf, docx) con quality metadata, stringa di successo stile deck;
       - Err (container giù) → **degradazione onesta**: emit del SOLO docx + stringa "Document created (DOCX). Designed HTML/PDF need the local computer (start it and retry for the full render)." — MAI silent-fallback al path markdown (il template andrebbe perso in silenzio);
    7. il path markdown esistente resta l'else (nessun template documento bundled) — INVARIATO.
- Nota nel tool schema di `make_document` (description di `template_ref`): aggiorna l'esempio a `homun/cv-professional-01` e aggiungi una frase: templated document packs render designed HTML/PDF + editable DOCX.

- [ ] **Step 1: Test fallenti** (pure parts)

```rust
#[test]
fn document_render_command_is_container_relative_and_qa_gated() {
    let cmd = super::build_document_render_command("/home/agent/output/t1", "cv-elena");
    assert!(cmd.starts_with("cd '/home/agent/output/t1' && doc-render cv-elena.json"));
    assert!(cmd.contains("--prefix cv-elena"));
    assert!(cmd.contains("--print-to-pdf=cv-elena.pdf"));
    assert!(cmd.contains("deck-qa cv-elena.html --json --mode document"));
    assert!(cmd.contains("DECK_QA_JSON:"));
}
```
E un test che il discriminatore scelga il path giusto: estrai la condizione in `fn document_template_pack<'a>(entry: Option<&'a TemplateCatalogEntry>) -> Option<&'a TemplateCatalogEntry>` (torna Some solo per kind document + bundled + pack_root) e testala con entry fixture (riusa `template_catalog_entry(` fixture helper `#[cfg(test)]` esistente, aggiustando i campi).

- [ ] **Step 2: Run — FAIL**, implementa (pure fns + generalizzazione emit + branch). ⚠️ La generalizzazione di `emit_rendered_deck_artifacts` tocca il path deck PROVATO: cambia SOLO la provenienza della lista nomi, niente altro; il full crate suite è il guardrail.

- [ ] **Step 3: Run — verde** (full crate), **Step 4: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(make_document): templated path — slot-filled doc.json, container render, honest degradation"
```

---

### Task 9: i 6 pack documento + preview

**Files:**
- Create: `templates/<slug>/{manifest.json,example.json}` per i 6 slug (sotto)
- Modify: `scripts/build_template_previews.py` (dispatch per kind)
- Modify: `crates/desktop-gateway/src/template_packs.rs` (estendi il test repo agli 8 id)
- Generated (da committare): `templates/<slug>/preview.html` + `thumbnails/`

**Interfaces:**
- Consumes: doc_render (T1-3), whitelist (T5 — i manifest usano `cv`/`cover_letter`/`product_catalog`).
- Produces: id `homun/cv-professional-01`, `homun/cover-letter-01`, `homun/product-catalog-01`, `homun/sales-proposal-01`, `homun/company-one-pager-01`, `homun/customer-case-study-01`.

- [ ] **Step 1: dispatch nel preview script** — in `build_template_previews.py`, `load_renderer()` diventa `load_renderers()` che carica entrambi i moduli; per ogni pack leggi `manifest.json["kind"]`: `"document"` → `doc_render.render_html`, altrimenti `deck_render.render_html`.

- [ ] **Step 2-7: i 6 pack.** Per OGNI pack: manifest (stesso shape F1: name/name_it/description/description_it/design_*/layout_archetypes = i type dei blocchi dell'esempio in ordine/tags/use_cases/audience/intake_questions/route_text) + example.json curato. Contenuti (fittizi credibili, EN come F1):

  1. **cv-professional-01** (kind document, design_template `cv`, theme `minimal_mono`, profile `minimal`): blocks = contact_header (Elena Ricci, Operations Director, email/tel/Milano/linkedin), profile_summary (4 righe factual), timeline (3 esperienze con 2-3 points ciascuna), education_list (2), skill_tags (2 gruppi: Operations, Tools). intake: "Whose CV is this and for which target role?", "Which 3-5 experiences and results matter most?", "Any constraints (length, language, format)?".
  2. **cover-letter-01** (kind document, `cover_letter`, `minimal_mono`, `minimal` — coppia del CV): letterhead (Elena Ricci · contatti · data · destinatario Kite Analytics), letter_body (salutation + 4 paragrafi: hook, fit, proof, ask), signature_block. intake: "Who is applying, to which company/role?", "Which one achievement proves the fit?", "Formal or warm tone?".
  3. **product-catalog-01** (kind document, `product_catalog`, `warm_editorial`, `editorial`): section_cover ("Autumn Collection", "Bottega Nova — handmade leather goods"), text_section (brand intro breve), product_grid (6 prodotti: name/description/price/badge su 2), spec_table (materiali/misure 4 righe), cta_footer (ordini/contatti). intake: "Which products (name, price, one-line description)?", "Who is the catalog for (retail, wholesale)?", "Any sections beyond the product grid (specs, story)?".
  4. **sales-proposal-01** (kind document, `sales_proposal`, `clean_corporate`, `executive`): section_cover ("Logistics Optimization Proposal", "Prepared for Aurora Logistics"), text_section (context/needs), text_section (proposed solution, bullets), timeline (3 fasi progetto), pricing_table (3 piani + note validità), signature_block. intake: "Client and problem to solve?", "Scope, phases and pricing structure?", "Decision maker and deadline?".
  5. **company-one-pager-01** (kind document, `sales_proposal`, `soft_gradient`, `sales_pitch`): section_cover ("Kite Analytics", one-liner), text_section (what we do, 3 bullets), kpi_band (3 numeri), text_section (how it works, 3 bullets), cta_footer. intake: "Company one-liner and audience?", "Which 3 numbers prove it?", "Primary call to action?".
  6. **customer-case-study-01** (kind document, `sales_proposal`, `warm_editorial`, `editorial`): section_cover ("Case study — Aurora Logistics", "38% less downtime in 6 months"), text_section (challenge), text_section (solution), kpi_band (3 risultati), testimonial_quote, cta_footer. intake: "Which customer and what problem did they have?", "What did you deliver and in what timeframe?", "Which measurable results and quote can we use?".

  (Contenuto d'esempio: scrivilo TU, curato e denso quanto i pack F1 — l'implementer di questo task ha licenza editoriale sui testi fittizi, NON sulla struttura blocchi/campi, che è quella qui sopra. route_text: bilingue con i termini di dominio, come F1. **Theme di ogni example.json = i token del suo `design_theme` presi VERBATIM da `design_tokens.THEMES`** — la preview committata deve mostrare il tema vero del pack, non i default.)

- [ ] **Step 8: genera le preview** — `python3 scripts/build_template_previews.py` → 8 pack ok. **Ispezione visiva OBBLIGATORIA** (Read delle PNG): per ogni pack documento controlla slide-001 + la pagina con la griglia/tabella; overflow/clipping → sistema il CSS (T1-3) PRIMA di committare.

- [ ] **Step 9: estendi il test repo** in `template_packs.rs`:

```rust
        for id in ["homun/startup-pitch-clean-01", "homun/executive-update-board-01",
                   "homun/cv-professional-01", "homun/cover-letter-01",
                   "homun/product-catalog-01", "homun/sales-proposal-01",
                   "homun/company-one-pager-01", "homun/customer-case-study-01"] {
            assert!(ids.contains(&id.to_string()), "missing {id}");
        }
```
(sostituisce le 2 assert singole nel test esistente `repo_templates_dir_ships_the_v1_presentation_packs`; rinominalo `..._the_v1_packs`.)

- [ ] **Step 10: Run — verdi** (unittest doc_render, cargo bundled/template_packs, `py_compile` dello script), **Step 11: Commit**

```bash
git add templates/ scripts/build_template_previews.py crates/desktop-gateway/src/template_packs.rs
git commit -m "feat(templates): the six v1 document packs with real rendered previews"
```

---

### Task 10: UI width-per-kind + gate completi + STATO

**Files:**
- Modify: `apps/desktop/src/components/BrandKitPanel.tsx` (`TemplateLivePreview`)
- Modify: `apps/desktop/src/styles.css`
- Modify: `docs/STATO.md`

**Interfaces:**
- Consumes: `entry.kind` (già nel tipo TS).
- Produces: preview documento scalata sulla larghezza A4 (794px) invece di 1280; card documento con aspect verticale.

- [ ] **Step 1: UI** — in `TemplateLivePreview`: `const designWidth = entry.kind === "document" ? 794 : 1280;` usato nel ResizeObserver (`el.clientWidth / designWidth`) e nell'iframe (`width: designWidth`, height card `Math.round(designWidth * 9 / 16)`? NO: per i documenti l'altezza iframe resta 720 e la card mostra la parte alta della pagina — wrapper documento con `aspect-ratio: 3/2` per far vedere più pagina). CSS:

```css
.template-live-preview.doc-preview { aspect-ratio: 3 / 2; }
```
e in JSX: `className={...}${entry.kind === "document" ? " doc-preview" : ""}`; l'iframe prende `style={{ width: designWidth, transform: scale(...) }}`.

- [ ] **Step 1b: intake_questions nel prompt "Use template"** — in `apps/desktop/src/lib/coreBridge.ts` aggiungi `intake_questions: string[]` a `TemplateCatalogEntry`; in `apps/desktop/src/App.tsx`, `handleStartTemplateWorkflow` (grep): dove il prompt operativo dice di fare 2-4 domande, se `template.intake_questions.length > 0` inserisci: `Ask these template-specific questions first (one message): ${template.intake_questions.map((q, i) => `${i + 1}. ${q}`).join(" ")}` — il resto del prompt INVARIATO. Nel `TemplateDetailModal` (BrandKitPanel.tsx) mostra le domande come lista puntata sotto la descrizione quando presenti (spec Sezione 3).

- [ ] **Step 2: gate UI** — `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron` verdi.

- [ ] **Step 3: gate completi** (in ordine): `cargo test -p local-first-desktop-gateway` · `python3 -m unittest discover -s runtimes/contained-computer -p 'test_deck_render.py'` · idem `test_doc_render.py` · `python3 scripts/pre_release_gate.py` → ALL GREEN. Rossi → si sistemano PRIMA di procedere.

- [ ] **Step 4: STATO.md** — checkpoint F2 in testa (stile del checkpoint F1): cosa è cambiato, commit chiave, gate, **cosa resta**: F3 wow (brand live, hover cycling, demozione source cards), ⚠️ **validazione live del path templated richiede rebuild dell'immagine contained-computer (`up.sh`) — Fabio a schermo**, follow-up rimasti (portrait deck thumbnails, search `_it`, sweep monet chat_store).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src docs/STATO.md
git commit -m "feat(presentations): document preview aspect + F2 gates green + STATO checkpoint"
```

## Note di coerenza

- **Convergenza**: un solo doc.json (render HTML/PDF + DOCX), un solo prefisso QA (`DECK_QA_JSON:` → parser riusato), shim container identico ai deck, stesso formato pack, stesso script preview.
- **Il modello riempie slot, il codice decide**: schema strict per-pack derivato dallo skeleton dell'esempio; blocchi mai scelti dal modello; assemble fallisce esplicito.
- **Degradazione onesta**: container giù → DOCX subito + messaggio chiaro; mai fallback silente al markdown senza design.
- **F3 fuori scope** (piano successivo): brand-kit live recolor, hover page-cycling, demozione source cards.
