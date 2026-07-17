# Presentations S1a — Design system editoriale + preview audaci: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** I renderer (deck+doc) guadagnano un modello surface/ink + temi editoriali audaci (noir/warm/bold) + cover drammatiche con eyebrow e art procedurale, gli 8 pack adottano default editoriali + una `category` d'uso, e le preview committate si rigenerano — il catalogo smette di sembrare grigio.

**Architecture:** Oggi entrambi i renderer derivano tutto da primary/secondary/accent e cablano il fondo bianco + testo scuro. Introduco token **surface/ink/muted/hairline/on-brand** guidati dal tema: i 5 temi esistenti li ricevono ai valori attuali (invarianza visiva), 3 temi editoriali nuovi li spingono (fondo near-black/crema). Le cover diventano campi surface con display type + eyebrow spaziato + regola d'accento + `hero_art` SVG procedurale (zero immagini esterne). Un campo `category` sul catalogo prepara le tab per scopo (S1b).

**Tech Stack:** Python stdlib (deck_render/doc_render/design_tokens), Rust (gateway: campo category), nessuna dipendenza nuova.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-presentations-studio-editorial-redesign-design.md` (direzione approvata).
- **Preview = verità**: i temi audaci sono temi che il pack spedisce davvero; nessuna anteprima diverge dal generato. Test: il tema mostrato == `design_theme` del manifest.
- **Editorial ≠ illeggibile**: impatto = tipografia+colore+whitespace, non decorazione che nuoce alla leggibilità; un CV generato dev'essere spedibile.
- ⚠️ `deck_render._HTML_CSS` è un `.format()` template → **graffe CSS letterali DOPPIE** `{{ }}`. `doc_render._CSS_BODY` è RAW → **graffe singole**. Non confonderli (è il gotcha ricorrente F1/F2).
- ⚠️ **Brand recolor live (F3)** inietta solo `--brand/--brand2/--accent/--head/--body` nel srcDoc: NON tocca surface/ink → l'editorial surface resta del tema (coerente: il brand ricolora gli accenti, il tema possiede il fondo). Non aggiungere surface/ink all'iniezione.
- ⚠️ Probe di test MAI substring di un titolo di blocco/slide (titolo renderizza per ogni layout). `python3 -B` nelle injection-test (staleness `__pycache__`).
- ⚠️ QA contrasto (`deck_qa`): validare che i temi scuri (crema-su-near-black = alto contrasto) non triggerino `low_contrast`; il render finale è nel container (rebuild `up.sh`) ma i test host + ispezione preview bastano per questa slice.
- Commenti in inglese (il perché); commit su `main`, NIENTE Co-Authored-By, NIENTE push.
- Gate: `cargo test -p local-first-desktop-gateway`, unittest `test_deck_render`/`test_doc_render`, `npm run build`+`test:ui-contract`+`test:electron`, `pre_release_gate.py`.
- Le 4 categorie (valori `category` fissati): `pitch_sales`, `cv_career`, `report_update`, `catalog_marketing` (fallback `other`).
- I 3 temi editoriali (valori `design_theme` fissati): `editorial_noir`, `editorial_warm`, `editorial_bold`.

## Assegnazione tema/categoria per pack (fissata)

| Pack | category | design_theme (nuovo default) |
| --- | --- | --- |
| homun/startup-pitch-clean-01 | pitch_sales | editorial_bold |
| homun/executive-update-board-01 | report_update | editorial_noir |
| homun/cv-professional-01 | cv_career | editorial_noir |
| homun/cover-letter-01 | cv_career | editorial_warm |
| homun/product-catalog-01 | catalog_marketing | editorial_warm |
| homun/sales-proposal-01 | pitch_sales | editorial_bold |
| homun/company-one-pager-01 | pitch_sales | editorial_bold |
| homun/customer-case-study-01 | report_update | editorial_warm |

---

### Task 1: `design_tokens` — modello surface/ink + 3 temi editoriali

**Files:**
- Modify: `runtimes/contained-computer/design_tokens.py`
- Test: `runtimes/contained-computer/test_doc_render.py` (già importa design_tokens via doc_render)

**Interfaces:**
- Produces: ogni tema in `THEMES` guadagna `surface`, `ink`, `muted`, `hairline`, `on_brand` (testo su campo brand/accent). `theme_values(name, overrides)` invariata (già fa merge dei truthy). Nuovi temi `editorial_noir`/`editorial_warm`/`editorial_bold`.

- [ ] **Step 1: Test fallente** — in `test_doc_render.py`, nuova classe:

```python
class DesignTokens(unittest.TestCase):
    def test_every_theme_has_surface_and_ink(self):
        from design_tokens import THEMES
        for name, t in THEMES.items():
            for key in ("primary", "accent", "surface", "ink", "muted", "hairline", "on_brand"):
                self.assertIn(key, t, f"{name} missing {key}")

    def test_editorial_themes_present(self):
        from design_tokens import THEMES
        for name in ("editorial_noir", "editorial_warm", "editorial_bold"):
            self.assertIn(name, THEMES)
        self.assertEqual(THEMES["editorial_noir"]["surface"], "#0b0b0d")
```

- [ ] **Step 2: Run — FAIL** (`python3 -m unittest discover -s runtimes/contained-computer -p 'test_doc_render.py' -k DesignTokens -v`)

- [ ] **Step 3: Implementazione** — riscrivi `THEMES` aggiungendo i 5 campi ai 5 esistenti (valori che preservano l'aspetto attuale: fondo bianco/testo scuro) e i 3 editoriali:

```python
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
```

Aggiorna il docstring del modulo (menziona surface/ink/muted/hairline/on_brand come contratto dei token).

- [ ] **Step 4: Run — verde** (il filtro `-k DesignTokens` + suite intera doc_render)
- [ ] **Step 5: Commit**

```bash
git add runtimes/contained-computer/design_tokens.py runtimes/contained-computer/test_doc_render.py
git commit -m "feat(design-tokens): surface/ink model + editorial noir/warm/bold themes"
```

---

### Task 2: `deck_render` — cover editoriale + eyebrow + hero_art + surface/ink

**Files:**
- Modify: `runtimes/contained-computer/deck_render.py` (`_html_slide` cover/section ~l.132, `render_html` ~l.103, `_HTML_CSS` ~l.246, docstring schema)
- Test: `runtimes/contained-computer/test_deck_render.py`

**Interfaces:**
- Consumes: Task 1 (i token surface/ink/muted/hairline/on_brand esistono su ogni tema).
- Produces: helper `_hero_art(kind: str) -> str` (SVG inline per `gradient|grid|rings`, `""` per `none`/ignoto), helper `_eyebrow(text) -> str`. Cover/section leggono `s.get("eyebrow")` e `s.get("hero_art")`. `render_html` passa surface/ink/muted/hairline/on_brand al `_HTML_CSS.format(...)`.

- [ ] **Step 1: Test fallente**

```python
class EditorialCover(unittest.TestCase):
    def test_cover_renders_eyebrow_and_hero_art(self):
        html = deck_render.render_html(
            {"title": "T", "theme": {"name": "editorial_bold"},
             "slides": [{"layout": "cover", "title": "Kite", "subtitle": "S",
                         "eyebrow": "EyebrowProbe", "hero_art": "rings"}]}, HERE)
        self.assertIn("EyebrowProbe", html)
        self.assertIn("hero-art", html)          # procedural svg wrapper class
        self.assertIn("--surface:#0f3d3e", html)  # theme surface reaches :root

    def test_surface_ink_reach_root_for_all_themes(self):
        html = deck_render.render_html(
            {"title": "T", "theme": {"name": "editorial_noir"},
             "slides": [{"layout": "cover", "title": "X"}]}, HERE)
        self.assertIn("--surface:#0b0b0d", html)
        self.assertIn("--ink:#f4f1ea", html)
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implementazione.** In `render_html`, il `theme` dict ora ha surface/ink/muted/hairline/on_brand (via design_tokens): estendi la `.format(...)` (grep `_HTML_CSS.format`):

```python
    css = _HTML_CSS.format(
        primary=theme["primary"], secondary=theme["secondary"], accent=theme["accent"],
        heading=theme["heading_font"], body=theme["body_font"],
        surface=theme.get("surface", "#ffffff"), ink=theme.get("ink", "#16202b"),
        muted=theme.get("muted", "#5a6675"), hairline=theme.get("hairline", "#e4e9ef"),
        on_brand=theme.get("on_brand", "#ffffff"),
    )
```
⚠️ `render_html` compone `theme` da `deck.get("theme")`. Verifica che il merge col brand/design_tokens produca i token: se deck_render NON passa da `theme_values`, aggiungi `from design_tokens import theme_values` e risolvi `theme = theme_values(raw.get("name"), raw)` con fallback ai DEFAULT (specchia doc_render — RILEGGI `render_html` reale e adatta; l'importante è che surface/ink arrivino).

Helper (accanto a `_logo_html`):

```python
def _eyebrow(text):
    return f'<div class="eyebrow">{html_escape(text)}</div>' if text else ""


def _hero_art(kind):
    # Procedural editorial art — inline SVG, zero external images (license-clean,
    # local). Uses currentColor so it inherits the accent set on the cover.
    if kind == "rings":
        return ('<svg class="hero-art" viewBox="0 0 400 400" aria-hidden><g fill="none" '
                'stroke="currentColor" stroke-width="1.5" opacity=".5">'
                + "".join(f'<circle cx="300" cy="90" r="{r}"/>' for r in (40, 80, 120, 170))
                + "</g></svg>")
    if kind == "grid":
        return ('<svg class="hero-art" viewBox="0 0 400 400" aria-hidden>'
                '<defs><pattern id="g" width="26" height="26" patternUnits="userSpaceOnUse">'
                '<path d="M26 0H0V26" fill="none" stroke="currentColor" stroke-width="1" '
                'opacity=".35"/></pattern></defs><rect width="400" height="400" fill="url(#g)"/></svg>')
    if kind == "gradient":
        return '<div class="hero-art hero-grad" aria-hidden></div>'
    return ""
```

Cover/section branch (sostituisce il ramo `cover` esistente; `section` analogo senza subtitle):

```python
    if layout == "cover":
        return (
            f'<section class="slide cover">{_logo_html(logo)}'
            f'{_hero_art(s.get("hero_art", ""))}'
            f'{_eyebrow(s.get("eyebrow", ""))}'
            f"<h1>{title}</h1>"
            f'<div class="sub">{html_escape(s.get("subtitle",""))}</div>'
            f'<div class="rule"></div></section>'
        )
```

`_HTML_CSS` (⚠️ graffe DOPPIE): (a) nel `:root` sostituisci i tre valori cablati con i placeholder — `--ink:{ink};--muted:{muted};--paper:{surface};--hairline:{hairline};--on-brand:{on_brand};`; (b) `.slide` usa già `background:var(--paper)` → ora è surface, ok; (c) sostituisci i grigi cablati con var: `.tl-item::after` e `table.cmp td border` e `.img-led .ph` → `var(--hairline)`, `table.cmp tr:nth-child(even) td background` → una tinta hairline (`background:color-mix(in srgb,var(--hairline) 40%,transparent)`), `.cover,.section color:#fff` → `color:var(--ink)` con `background:var(--surface)` (via un campo accento, non più gradient brand→brand2 obbligato); `table.cmp th color:#fff`/`.member .avatar color:#fff` → `var(--on-brand)`. (d) Aggiungi le regole editoriali:

```css
.eyebrow{{text-transform:uppercase;letter-spacing:.28em;font-size:.95rem;font-weight:700;
  color:var(--accent);margin-bottom:1.1rem;position:relative}}
.cover,.section{{background:var(--surface);color:var(--ink)}}
.cover h1,.section h1{{color:var(--ink);font-size:5rem;max-width:88%;position:relative}}
.cover .sub{{color:var(--muted)}}
.hero-art{{position:absolute;right:-4vw;top:-4vw;width:44vw;height:44vw;color:var(--accent);
  opacity:.9;pointer-events:none}}
.hero-art.hero-grad{{background:radial-gradient(120% 120% at 80% 0%,
  color-mix(in srgb,var(--accent) 40%,transparent),transparent 60%)}}
```
(⚠️ rimuovi la vecchia `.cover::after` cerchio-bianco cablato o rendila `var(--on-brand)`/opacity bassa; il `.cover h1 color:#fff` sopra è sostituito.) Aggiorna il docstring dello schema deck.json coi campi `eyebrow`/`hero_art` sulla cover/section.

⚠️ `--self-test` di deck_render controlla `overflow-wrap:anywhere`/`hyphens:auto` in `_HTML_CSS` → restano; NON rompere quel contratto.

- [ ] **Step 4: Run — verde** (suite deck_render intera + `python3 runtimes/contained-computer/deck_render.py --self-test` → ok:true)
- [ ] **Step 5: Commit**

```bash
git add runtimes/contained-computer/deck_render.py runtimes/contained-computer/test_deck_render.py
git commit -m "feat(deck-render): editorial cover with eyebrow, procedural hero art and surface/ink theming"
```

---

### Task 3: `doc_render` — section_cover editoriale + eyebrow + hero_art + surface/ink

**Files:**
- Modify: `runtimes/contained-computer/doc_render.py` (`render_block` section_cover ~l.70, `render_html`/`_css_tokens` ~l.181-208, `_CSS_BODY` ~l.210)
- Test: `runtimes/contained-computer/test_doc_render.py`

**Interfaces:**
- Consumes: Task 1. Produces: `section_cover` legge `eyebrow`/`hero_art`; `_css_tokens` emette surface/ink/muted/hairline/on-brand; helper `_hero_art`/`_eyebrow` (specchiano deck_render, ma `_CSS_BODY` è RAW → graffe singole).

- [ ] **Step 1: Test fallente**

```python
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
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implementazione.** In `_css_tokens(theme)` aggiungi al blocco `:root` (⚠️ è la SOLA parte formattata — f-string, non `_CSS_BODY`):

```python
    return (f":root{{--brand:{theme['primary']};--brand2:{theme['secondary']};"
            f"--accent:{theme['accent']};--head:'{theme['heading_font']}';"
            f"--body:'{theme['body_font']}';--doc-width:794px;"
            f"--surface:{theme.get('surface', '#ffffff')};--ink:{theme.get('ink', '#16202b')};"
            f"--muted:{theme.get('muted', '#5a6675')};--hairline:{theme.get('hairline', '#e4e9ef')};"
            f"--on-brand:{theme.get('on_brand', '#ffffff')};}}")
```
(⚠️ `render_html` costruisce `theme` — verifica che passi da `theme_values`/DEFAULT così surface/ink ci sono; adatta se serve, come F2-T1.)

Helper `_eyebrow`/`_hero_art` identici a deck_render (usa `esc` invece di `html_escape` — il nome nel file doc_render). section_cover branch:

```python
    if kind == "section_cover":
        return (f'<section class="block cover">{_logo(logo)}'
                f'{_hero_art(block.get("hero_art", ""))}'
                f'{_eyebrow(block.get("eyebrow", ""))}'
                f'<h1>{title}</h1><div class="sub">{esc(block.get("subtitle", ""))}</div>'
                f'<div class="rule"></div></section>')
```

`_CSS_BODY` (⚠️ RAW, graffe SINGOLE): (a) `body` usa `background:var(--surface);color:var(--ink)` (grep il `body{` reale); (b) `.cover` da `linear-gradient(brand,brand2);color:#fff` → `background:var(--surface);color:var(--ink)`; (c) sostituisci i grigi cablati (`#e4e9ef`, `#f6f8fa`, `#eef1f5`, `border-bottom:...#…`) con `var(--hairline)`; th `color:#fff`/avatar `#fff` → `var(--on-brand)`; (d) aggiungi:

```css
.eyebrow{text-transform:uppercase;letter-spacing:.26em;font-size:.8rem;font-weight:700;
  color:var(--accent);margin-bottom:.7rem}
.cover h1{font-size:3.2rem;letter-spacing:-.02em}
.cover .sub{color:var(--muted)}
.hero-art{position:absolute;right:0;top:0;width:38%;height:100%;color:var(--accent);
  opacity:.85;pointer-events:none}
.hero-art.hero-grad{background:radial-gradient(120% 120% at 90% 0%,
  color-mix(in srgb,var(--accent) 38%,transparent),transparent 62%)}
.cover{position:relative;overflow:hidden}
```
⚠️ `--self-test` doc_render controlla `overflow-wrap:anywhere`/`@page` in `_CSS_BODY` → restano.

- [ ] **Step 4: Run — verde** (suite doc_render + `--self-test` ok:true)
- [ ] **Step 5: Commit**

```bash
git add runtimes/contained-computer/doc_render.py runtimes/contained-computer/test_doc_render.py
git commit -m "feat(doc-render): editorial section cover with eyebrow, hero art and surface/ink theming"
```

---

### Task 4: backend — campo `category` sul catalogo

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`TemplateCatalogEntry`, `TemplateCatalogEntryResponse`, `parse_file_template_catalog_entry`, `template_catalog_response_from_entries`, i costruttori — compiler-driven)
- Test: `mod tests` di main.rs

**Interfaces:**
- Produces: `TemplateCatalogEntry.category: String` + campo identico su Response, parsato da `value.get("category")` con whitelist `["pitch_sales","cv_career","report_update","catalog_marketing"]` fallback `"other"`. (Specchia esattamente il pattern di `intake_questions` di F2-T5 per costruttori/response.)

- [ ] **Step 1: Test fallente**

```rust
#[test]
fn file_template_catalog_entry_parses_category_with_fallback() {
    let manifest = serde_json::json!({"provider_id": "acme", "templates": [
        {"id": "acme/a", "kind": "document", "name": "A", "description": "d",
         "design_template": "sales_proposal", "route_text": "r", "category": "cv_career"},
        {"id": "acme/b", "kind": "document", "name": "B", "description": "d",
         "design_template": "sales_proposal", "route_text": "r", "category": "bogus"},
        {"id": "acme/c", "kind": "document", "name": "C", "description": "d",
         "design_template": "sales_proposal", "route_text": "r"}]});
    let p = super::FileTemplateCatalogProvider::from_json_str(manifest.to_string().as_str()).unwrap();
    assert_eq!(p.entries[0].category, "cv_career");
    assert_eq!(p.entries[1].category, "other");  // bogus → fallback
    assert_eq!(p.entries[2].category, "other");  // absent → fallback
}
```

- [ ] **Step 2: Run — FAIL** (`cargo test -p local-first-desktop-gateway file_template_catalog_entry_parses_category -- --nocapture`)

- [ ] **Step 3: Implementazione.** Aggiungi `category: String` a `TemplateCatalogEntry` (dopo `kind`) e a `TemplateCatalogEntryResponse`; in `parse_file_template_catalog_entry`:

```rust
        category: value
            .get("category")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|c| matches!(*c,
                "pitch_sales" | "cv_career" | "report_update" | "catalog_marketing"))
            .unwrap_or("other")
            .to_string(),
```
Nel mapping response: `category: entry.category`. Il compilatore elenca i costruttori struct-literal (fixture `template_catalog_entry(` `#[cfg(test)]` + i test): valorizza `category: "other".to_string()` dove neutro.

- [ ] **Step 4: Run — verde** (filtro + full crate)
- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(templates): use-case category field on catalog entries"
```

---

### Task 5: pack — default editoriali + category + eyebrow/hero_art + preview rigenerate

**Files:**
- Modify: gli 8 `templates/*/manifest.json` (+ `category`, + `design_theme` editoriale per tabella) e `templates/*/example.json` (theme = i token del nuovo `design_theme` VERBATIM da design_tokens; `eyebrow`/`hero_art` sulle cover/section_cover)
- Modify: `crates/desktop-gateway/src/template_packs.rs` (test 8-id già presente — nessun cambio se gli id restano)
- Generated (committare): `templates/*/preview.html` + `thumbnails/`

**Interfaces:** consuma Task 1-3 (temi+cover) e Task 4 (category). Gli id NON cambiano.

- [ ] **Step 1: per OGNI pack** — nel manifest: aggiungi `"category": "<da tabella>"`, cambia `design_theme` al valore editoriale della tabella. Nell'example.json: cambia `theme` (se nominato per nome usa `{"name": "<design_theme>"}`, altrimenti i 5 token colore VERBATIM da `design_tokens.THEMES[design_theme]`), e sulla cover/section_cover aggiungi un `eyebrow` (maiuscoletto, es. pitch → `"SEED ROUND · 2026"`, case study → `"CUSTOMER STORY"`, CV → `"CURRICULUM VITAE"`) + `hero_art` coerente (`rings`/`grid`/`gradient`). ⚠️ Il tema mostrato DEVE == `design_theme` del manifest (preview=verità).

- [ ] **Step 2: rigenera** — `python3 scripts/build_template_previews.py` → 8 pack ok.

- [ ] **Step 3: ISPEZIONE VISIVA OBBLIGATORIA** — Read (come immagini) `thumbnails/slide-001.png` di OGNI pack + la pagina griglia (catalogo) + la pagina tabella (proposta). Criteri: cover drammatica leggibile (eyebrow visibile, titolo grande, contrasto alto), nessun testo grigio-chiaro su fondo chiaro o viceversa illeggibile, hero_art non copre il testo, tabelle/liste leggibili sul nuovo surface. Rotto/brutto → sistema CSS (Task 2/3) o i token (Task 1) e RIGENERA prima di committare. **Non committare preview non guardate.**

- [ ] **Step 4: test repo** — `cargo test -p local-first-desktop-gateway template_packs -- --nocapture` → verde (gli id sono invariati; il test 8-id passa). Aggiungi in `template_packs.rs::tests` un test che ogni pack bundled ha una `category` ≠ `"other"`:

```rust
    #[test]
    fn every_bundled_pack_declares_a_category() {
        let root = bundled_template_pack_root().expect("repo templates dir");
        let provider = BundledTemplatePackProvider::from_root(&root).expect("provider");
        for entry in crate::TemplateCatalogProvider::entries(&provider) {
            assert_ne!(entry.category, "other", "{} has no category", entry.id);
        }
    }
```

- [ ] **Step 5: Commit**

```bash
git add templates/ crates/desktop-gateway/src/template_packs.rs
git commit -m "feat(templates): editorial default themes, use-case categories and regenerated bold previews"
```

---

### Task 6: gate completi + STATO

**Files:** Modify `docs/STATO.md`

- [ ] **Step 1: gate in ordine** — `cargo test -p local-first-desktop-gateway` · unittest `test_deck_render` · `test_doc_render` · `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron` · `python3 scripts/pre_release_gate.py` → ALL GREEN. Rosso → STOP, diagnostica.
- [ ] **Step 2: STATO** — checkpoint S1a (conciso, IT, data): design system editoriale (surface/ink + noir/warm/bold + cover drammatiche + hero_art procedurale), category field, 8 preview rigenerate audaci; cosa resta = **S1b relayout gallery** (chip+drawer, tab per scopo, card full-bleed, split BrandKitPanel), poi S2 brief, S3 font; live validation in-app (Fabio) + rebuild container per il generato.
- [ ] **Step 3: Commit** — `docs: STATO checkpoint — Presentations S1a (editorial renderer) shipped`

## Note di coerenza

- **Convergenza**: un solo modello surface/ink condiviso dai due renderer via design_tokens; nessun terzo meccanismo di theming.
- **Preview = verità preservata**: default audaci = temi reali dei pack; test che category≠other e (in ispezione) che il tema == design_theme.
- **S1b/S2/S3 fuori scope** (piani separati): relayout UI, brief ottimizzato, font picker.
