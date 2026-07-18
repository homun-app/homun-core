# Tipografia reale + font picker (S3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere la tipografia REALE e identica ovunque — bundlare un set curato di ~12 Google Font (woff2 latin, OFL) e iniettarli via `@font-face` data-URI nei renderer, con un picker curato nel brand kit — chiudendo l'invariante "preview = verità" sulla tipografia.

**Architecture:** Una sola sorgente (woff2 sourcati da `@fontsource`) → `scripts/build_fonts.py` bundla i woff2 in `runtimes/contained-computer/fonts/` e genera due manifest (Python per il renderer, TS base64 per la UI). `fonts_embed.py` (condiviso da deck_render+doc_render) base64-embeda `@font-face` per le sole famiglie usate → HTML self-contained. Il picker sostituisce gli input testo-libero; il recolor live inietta l'@font-face. I temi editoriali passano da "Georgia" (non renderizzabile) a un serif bundled, sincronizzato py+rust.

**Tech Stack:** Python (renderer + build script), TypeScript/React (UI), Rust (theme tuples + container hash), Docker.

## Global Constraints

- Commit su `main`, **NIENTE `Co-Authored-By`**, **NIENTE push**. Commenti in inglese sul *perché*.
- **Set curato (12 famiglie), tutte OFL/Apache via `@fontsource`, subset latin, pesi 400+700:** Inter, Roboto, Open Sans, Lato, Work Sans, Montserrat, Poppins (sans); Source Serif 4, Lora, Merriweather, Playfair Display (serif); JetBrains Mono (mono).
- **Remap Georgia** (non-OFL, già in fallback): `editorial_noir`/`editorial_bold` → **Playfair Display**; ogni altro tema editoriale (`editorial_warm`/`editorial_ivory`/`editorial_slate`/`warm_editorial`) → **Source Serif 4**. Da applicare in `design_tokens.py` E in `main.rs` `design_theme_tokens` (le tuple Rust sono override che VINCONO).
- **Caposaldo**: la consegna del font (file + @font-face) è stato-in-codice; la scelta è uno slot vincolato al set curato. **Fail-open**: famiglia fuori dal set → stack di fallback attuale, nessun crash, mai emettere un `@font-face` con `src` vuoto.
- **Converge, non duplica**: un unico manifest sorgente; `@fontsource` è il meccanismo già in uso (hanken-grotesk/jetbrains-mono). `_font_face_css` condiviso da entrambi i renderer.
- **PPTX/DOCX**: solo il NOME del font (embedding fuori scope, caveat onesto).
- ⚠️ `main.rs` ~62k righe, numeri di riga invecchiano → ri-grep i simboli.
- Gate: `cargo test -p local-first-desktop-gateway`, `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron`, `python3 scripts/pre_release_gate.py`; **rebuild container** (`runtimes/contained-computer/up.sh`) + **regen preview** dove indicato.

---

### Task 1: Set curato — @fontsource deps + `build_fonts.py` + woff2 + manifest (py + ts)

**Files:**
- Modify: `apps/desktop/package.json` (devDependencies: gli @fontsource mancanti)
- Create: `scripts/build_fonts.py`
- Create (generati + committati): `runtimes/contained-computer/fonts/*.woff2`, `runtimes/contained-computer/fonts_manifest.py`, `apps/desktop/src/components/fontsManifest.ts`
- Test: `scripts/build_fonts.py` self-check (esegui e verifica gli output)

**Interfaces:**
- Produces:
  - `runtimes/contained-computer/fonts_manifest.py`: `FONTS: dict[str, dict[int, str]]` (famiglia → {peso → filename woff2 relativo a `fonts/`}).
  - `apps/desktop/src/components/fontsManifest.ts`: `export const FONT_FAMILIES: string[]` + `export const FONT_FACES: Record<string, {weight:number; dataUri:string}[]>` (data-URI base64 woff2).

- [ ] **Step 1: Aggiungi gli @fontsource mancanti come devDependencies.**

In `apps/desktop/package.json`, nella sezione `devDependencies`, aggiungi (jetbrains-mono/hanken-grotesk già presenti):

```json
"@fontsource/inter": "^5",
"@fontsource/roboto": "^5",
"@fontsource/open-sans": "^5",
"@fontsource/lato": "^5",
"@fontsource/work-sans": "^5",
"@fontsource/montserrat": "^5",
"@fontsource/poppins": "^5",
"@fontsource/source-serif-4": "^5",
"@fontsource/lora": "^5",
"@fontsource/merriweather": "^5",
"@fontsource/playfair-display": "^5"
```

Poi: `cd apps/desktop && npm install`. Verifica che esistano i file, es.: `ls node_modules/@fontsource/playfair-display/files/playfair-display-latin-400-normal.woff2`.

- [ ] **Step 2: Scrivi `scripts/build_fonts.py`.**

```python
#!/usr/bin/env python3
"""Bundle the curated Google-Font set (latin woff2, OFL) from @fontsource into the
contained-computer renderer AND generate the two manifests the renderer (Python)
and the desktop UI (TS, base64) read. ONE source of truth for typography — run it
whenever the curated set changes. Idempotent."""
import base64, json, shutil
from pathlib import Path

# display name -> (@fontsource package slug, [weights]). Latin subset, 400+700.
CURATED = {
    "Inter": ("inter", [400, 700]),
    "Roboto": ("roboto", [400, 700]),
    "Open Sans": ("open-sans", [400, 700]),
    "Lato": ("lato", [400, 700]),
    "Work Sans": ("work-sans", [400, 700]),
    "Montserrat": ("montserrat", [400, 700]),
    "Poppins": ("poppins", [400, 700]),
    "Source Serif 4": ("source-serif-4", [400, 700]),
    "Lora": ("lora", [400, 700]),
    "Merriweather": ("merriweather", [400, 700]),
    "Playfair Display": ("playfair-display", [400, 700]),
    "JetBrains Mono": ("jetbrains-mono", [400, 700]),
}

ROOT = Path(__file__).resolve().parent.parent
NODE = ROOT / "apps/desktop/node_modules/@fontsource"
FONTS_DIR = ROOT / "runtimes/contained-computer/fonts"
PY_MANIFEST = ROOT / "runtimes/contained-computer/fonts_manifest.py"
TS_MANIFEST = ROOT / "apps/desktop/src/components/fontsManifest.ts"

def slug(name): return name.lower().replace(" ", "-")

def main():
    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    py = {}       # family -> {weight: filename}
    ts_faces = {} # family -> [{weight, dataUri}]
    for family, (pkg, weights) in CURATED.items():
        py[family] = {}
        ts_faces[family] = []
        for w in weights:
            src = NODE / pkg / "files" / f"{pkg}-latin-{w}-normal.woff2"
            if not src.exists():
                # Fail LOUD: a missing source woff2 is a setup bug — never ship a
                # family that won't render (that reintroduces the very mismatch S3 fixes).
                raise SystemExit(f"missing woff2: {src} (did `npm install` run?)")
            fname = f"{slug(family)}-{w}.woff2"
            shutil.copyfile(src, FONTS_DIR / fname)
            py[family][w] = fname
            b64 = base64.b64encode((FONTS_DIR / fname).read_bytes()).decode()
            ts_faces[family].append({"weight": w, "dataUri": f"data:font/woff2;base64,{b64}"})

    PY_MANIFEST.write_text(
        "# GENERATED by scripts/build_fonts.py — do not edit by hand.\n"
        "# family -> {weight: woff2 filename (relative to fonts/)}\n"
        f"FONTS = {json.dumps(py, indent=4, ensure_ascii=False)}\n"
    )
    families = list(CURATED.keys())
    ts = (
        "// GENERATED by scripts/build_fonts.py — do not edit by hand.\n"
        "export const FONT_FAMILIES: string[] = "
        f"{json.dumps(families, ensure_ascii=False)};\n\n"
        "export type FontFace = { weight: number; dataUri: string };\n"
        "export const FONT_FACES: Record<string, FontFace[]> = "
        f"{json.dumps(ts_faces, ensure_ascii=False)};\n"
    )
    TS_MANIFEST.write_text(ts)
    print(f"bundled {sum(len(v) for v in py.values())} woff2 for {len(py)} families")

if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Esegui e verifica (il "test" di questo task-tooling).**

```bash
cd /Users/fabio/Projects/Homun/app && python3 scripts/build_fonts.py
ls runtimes/contained-computer/fonts/ | wc -l          # expect 24
python3 -c "import importlib.util as u; s=u.spec_from_file_location('m','runtimes/contained-computer/fonts_manifest.py'); m=u.module_from_spec(s); s.loader.exec_module(m); assert m.FONTS['Inter'][400] and m.FONTS['Playfair Display'][700]; print('py manifest OK', len(m.FONTS))"
node -e "const m=require('./apps/desktop/src/components/fontsManifest.ts'.replace('.ts',''))" 2>/dev/null || grep -q 'data:font/woff2;base64,' apps/desktop/src/components/fontsManifest.ts && echo "ts manifest OK"
```
Expected: 24 woff2, `py manifest OK 12`, `ts manifest OK`. Re-running the script leaves the same output (idempotent).

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/package.json apps/desktop/package-lock.json scripts/build_fonts.py \
  runtimes/contained-computer/fonts runtimes/contained-computer/fonts_manifest.py \
  apps/desktop/src/components/fontsManifest.ts
git commit -m "feat(presentations): bundle curated font set (woff2 + py/ts manifests) via build_fonts.py"
```

---

### Task 2: Renderer — `fonts_embed.py` + `@font-face` self-contained in deck_render/doc_render

**Files:**
- Create: `runtimes/contained-computer/fonts_embed.py`
- Modify: `runtimes/contained-computer/deck_render.py` (`_HTML_SHELL`, `render_html`)
- Modify: `runtimes/contained-computer/doc_render.py` (CSS assembly)
- Test: `runtimes/contained-computer/fonts_embed.py` `__main__` self-check (run with `python3 -B`)

**Interfaces:**
- Consumes: `fonts_manifest.FONTS` (Task 1).
- Produces: `fonts_embed.font_face_css(families: list[str]) -> str`.

- [ ] **Step 1: Scrivi il test (self-check in coda a `fonts_embed.py`, eseguito da `__main__`).**

Nota: il test legge i woff2 reali di Task 1, quindi gira solo dopo Task 1 (ordine garantito).

```python
def _selftest():
    css = font_face_css(["Inter"])
    assert "@font-face" in css and "font-family:'Inter'" in css and "base64," in css, "Inter faces missing"
    assert "Roboto" not in css, "only requested families must be emitted"
    assert font_face_css(["Totally Unknown Family"]) == "", "unknown family must be empty (fail-open)"
    assert font_face_css(["", None]) == "", "blank/None families produce nothing"
    # de-dup: passing a family twice emits its faces once
    assert font_face_css(["Inter", "Inter"]).count("font-family:'Inter';font-weight:400") == 1
    print("fonts_embed selftest OK")
```

- [ ] **Step 2: Verifica rosso.**

Run: `cd /Users/fabio/Projects/Homun/app/runtimes/contained-computer && python3 -B -c "import fonts_embed; fonts_embed._selftest()"`
Expected: FAIL — `font_face_css` non esiste ancora.

- [ ] **Step 3: Implementa `fonts_embed.py`.**

```python
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
    ...  # from Step 1

if __name__ == "__main__":
    _selftest()
```

- [ ] **Step 4: Verifica verde.**

Run: `cd /Users/fabio/Projects/Homun/app/runtimes/contained-computer && python3 -B -c "import fonts_embed; fonts_embed._selftest()"`
Expected: `fonts_embed selftest OK`.

- [ ] **Step 5: Inietta in `deck_render.py`.**

Aggiungi in cima `from fonts_embed import font_face_css`. Cambia `_HTML_SHELL` per avere lo slot font-faces PRIMA del css (le graffe dell'@font-face non sono toccate: è un arg di `.format`, non il template CSS):

```python
_HTML_SHELL = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>{title}</title><style>{font_faces}{css}</style></head><body>
{body}
</body></html>"""
```

In `render_html`, prima del `return`, calcola le famiglie del tema e passa `font_faces`:

```python
    font_faces = font_face_css([theme.get("heading_font", ""), theme.get("body_font", "")])
    return _HTML_SHELL.format(
        title=title, css=css, body="\n".join(slides_html), font_faces=font_faces
    )
```

(La variabile risolta in `render_html` si chiama esattamente `theme` — è quella da cui il codice già legge `theme["heading_font"]`/`theme["body_font"]` per il `.format` del CSS. Aggiungi le 2 righe sopra subito prima del `return`.)

- [ ] **Step 6: Inietta in `doc_render.py`.**

Aggiungi `from fonts_embed import font_face_css`. In `render_html` (var `theme`, `tokens = _css_tokens(theme)`, e il `return` costruisce `…<style>{tokens}{_CSS_BODY}</style>…`), calcola `faces` e **prependilo** nello `<style>`:

```python
    tokens = _css_tokens(theme)
    faces = font_face_css([theme["heading_font"], theme["body_font"]])  # @font-face before use
    title = esc(doc.get("title", "Document"))
    return ("<!doctype html><html><head><meta charset='utf-8'>"
            f"<title>{title}</title><style>{faces}{tokens}{_CSS_BODY}</style></head>"
            f"<body><div class=\"doc\">{body}</div></body></html>")
```

- [ ] **Step 7: Verifica render end-to-end (host, senza container).**

```bash
cd /Users/fabio/Projects/Homun/app/runtimes/contained-computer && python3 -B -c "
import deck_render
html = deck_render.render_html({'theme':{'name':'editorial_bold','heading_font':'Playfair Display','body_font':'Inter'},'slides':[{'layout':'cover','title':'X'}]}, '/tmp')
assert \"font-family:'Playfair Display'\" in html and 'base64,' in html, 'deck @font-face missing'
print('deck embed OK')
"
```
Expected: `deck embed OK`. (Il tema `editorial_bold` avrà `heading_font` Playfair dopo Task 3; qui lo passiamo esplicito per testare l'embed in isolamento.)

- [ ] **Step 8: Commit.**

```bash
git add runtimes/contained-computer/fonts_embed.py runtimes/contained-computer/deck_render.py runtimes/contained-computer/doc_render.py
git commit -m "feat(presentations): self-contained @font-face embedding in deck/doc renderers"
```

---

### Task 3: Temi editoriali — Georgia → serif bundled (design_tokens.py + main.rs sync)

**Files:**
- Modify: `runtimes/contained-computer/design_tokens.py` (6 righe `"heading_font": "Georgia"`)
- Modify: `crates/desktop-gateway/src/main.rs` (`design_theme_tokens` tuple con `"Georgia"`)
- Test: `crates/desktop-gateway/src/main.rs` test unità sul tema risolto

**Interfaces:**
- Consumes: le famiglie del set curato (Task 1) — "Playfair Display", "Source Serif 4".

- [ ] **Step 1: Test rosso (Rust) — nessun tema editoriale risolve a "Georgia".**

Nel modulo test di `main.rs`, accanto ai test `apply_deck_design_theme` (ri-grep):

```rust
#[test]
fn editorial_themes_use_bundled_serif_not_georgia() {
    let brand = super::BrandKit::default();
    for theme in ["editorial_noir", "editorial_bold", "editorial_warm", "editorial_ivory", "editorial_slate"] {
        let tokens = super::design_theme_tokens(Some(theme), &brand);
        let head = tokens["heading_font"].as_str().unwrap_or("");
        assert_ne!(head, "Georgia", "{theme} still uses non-bundled Georgia");
        assert!(
            head == "Playfair Display" || head == "Source Serif 4",
            "{theme} heading_font `{head}` is not a bundled serif"
        );
    }
}
```

- [ ] **Step 2: Verifica rosso.**

Run: `cargo test -p local-first-desktop-gateway editorial_themes_use_bundled_serif -- --nocapture`
Expected: FAIL — le tuple Rust hanno ancora "Georgia".

- [ ] **Step 3: Remap in `main.rs`.**

Ri-grep `"Georgia"` in `crates/desktop-gateway/src/main.rs` (le tuple di `design_theme_tokens`, forma `(primary, secondary, accent, heading_font, body_font)`). Sostituisci il 4° campo:
- `editorial_noir`, `editorial_bold` → `"Playfair Display"`
- `editorial_warm`, `editorial_ivory`, `editorial_slate` (e `warm_editorial` se presente) → `"Source Serif 4"`

Lascia `body_font` `"Inter"`.

- [ ] **Step 4: Remap in `design_tokens.py`.**

In `runtimes/contained-computer/design_tokens.py`, per ognuna delle 6 righe `"heading_font": "Georgia"`, guarda il nome del tema di quel blocco e applica lo stesso mapping (noir/bold → `"Playfair Display"`; warm/ivory/slate/warm_editorial → `"Source Serif 4"`).

- [ ] **Step 5: Verifica verde + coerenza py.**

```bash
cargo test -p local-first-desktop-gateway editorial_themes_use_bundled_serif -- --nocapture   # PASS
grep -c "Georgia" runtimes/contained-computer/design_tokens.py    # expect 0
grep -c "Georgia" crates/desktop-gateway/src/main.rs              # expect 0
```

- [ ] **Step 6: Commit.**

```bash
git add crates/desktop-gateway/src/main.rs runtimes/contained-computer/design_tokens.py
git commit -m "feat(presentations): editorial themes use bundled serif (Playfair/Source Serif 4), retire Georgia"
```

---

### Task 4: UI — picker curato nel BrandDrawer + recolor con @font-face

**Files:**
- Modify: `apps/desktop/src/components/presentationsShared.ts` (import manifest; `brandPreviewOverride` inietta @font-face; export helper specimen)
- Modify: `apps/desktop/src/components/BrandDrawer.tsx` (input → `<select>` + specimen + font-face injection)
- Modify: `apps/desktop/scripts/check-ui-contract.mjs` (lock su `fontsManifest`/select se necessario)
- Test: `npm run test:ui-contract` + `npm run test:electron`

**Interfaces:**
- Consumes: `FONT_FAMILIES`, `FONT_FACES` da `./fontsManifest` (Task 1).

- [ ] **Step 1: `presentationsShared.ts` — inietta @font-face nel recolor.**

Aggiungi in cima: `import { FONT_FAMILIES, FONT_FACES } from "./fontsManifest";` e **ri-esporta** `FONT_FAMILIES` così il BrandDrawer lo importa da `presentationsShared` insieme a `fontFaceStyle` (un solo punto d'ingresso UI): aggiungi `export { FONT_FAMILIES } from "./fontsManifest";`.

Aggiungi un helper puro e usalo in `brandPreviewOverride`:

```ts
/** @font-face CSS (data-URI) for the given families, from the bundled manifest.
 *  The preview iframe is a separate document — it needs its own @font-face, and a
 *  data-URI is the only CSP-safe source under sandbox="". Unknown family → nothing. */
export function fontFaceStyle(families: string[]): string {
  const seen = new Set<string>();
  let css = "";
  for (const fam of families) {
    if (!fam || seen.has(fam)) continue;
    seen.add(fam);
    for (const f of FONT_FACES[fam] ?? []) {
      css += `@font-face{font-family:'${fam}';font-weight:${f.weight};font-style:normal;font-display:swap;src:url(${f.dataUri}) format('woff2')}`;
    }
  }
  return css;
}
```

Nel `brandPreviewOverride`, cambia la costruzione di `style` per PREPENDERE le @font-face:

```ts
  const faces = fontFaceStyle([headingFont, bodyFont]);
  const style =
    `<style>${faces}:root{--brand:${primary} !important;` +
    `--brand2:${secondary} !important;` +
    `--accent:${accent} !important;` +
    `--head:'${headingFont}' !important;` +
    `--body:'${bodyFont}' !important;}</style>`;
```

- [ ] **Step 2: `BrandDrawer.tsx` — input → select + specimen.**

Sostituisci i due `<input>` `heading_font`/`body_font` con `<select>` del set curato, e aggiungi uno specimen live sotto ciascuno. Inietta le @font-face del manifest una volta (così gli specimen si vedono nell'app, che NON importa i CSS @fontsource):

```tsx
// once, so the specimen text renders in the picked family inside the app UI too:
import { FONT_FAMILIES, fontFaceStyle } from "./presentationsShared";
// ...inside the component, mount-once:
useEffect(() => {
  const id = "homun-font-specimens";
  if (document.getElementById(id)) return;
  const el = document.createElement("style");
  el.id = id;
  el.textContent = fontFaceStyle(FONT_FAMILIES);
  document.head.appendChild(el);
}, []);
```

Il controllo (per heading; identico per body con `body_font`):

```tsx
<label>
  <span>{t("presentations:heading_font")}</span>
  <select value={kit.heading_font} onChange={(e) => onChange("heading_font", e.target.value)}>
    {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
  </select>
</label>
<div className="font-specimen" style={{ fontFamily: `'${kit.heading_font}', sans-serif` }}>
  Ag — The quick brown fox 123
</div>
```

(⚠️ se `kit.heading_font` salvato è un vecchio valore libero non nel set — es. "Inter" c'è, "Georgia" no — il `<select>` mostra l'opzione vuota; va bene, l'utente ri-sceglie. Il default kit resta "Inter", che è nel set.)

- [ ] **Step 3: Gate UI.**

```bash
cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron
```
Expected: verdi. Se un lock ui-contract riferisce le stringhe cambiate (input→select), aggiornalo in `scripts/check-ui-contract.mjs` mantenendo il lock su `fontsManifest`/`brandPreviewOverride`.

- [ ] **Step 4: Commit.**

```bash
git add apps/desktop/src/components/presentationsShared.ts apps/desktop/src/components/BrandDrawer.tsx apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(presentations): curated font picker (select + specimen) and @font-face in live recolor"
```

---

### Task 5: Container plumbing — Dockerfile COPY + hash sync (up.sh + sandbox.rs) + PDF-embed validation

**Files:**
- Modify: `runtimes/contained-computer/Dockerfile` (COPY fonts + moduli)
- Modify: `runtimes/contained-computer/up.sh` (`HASH_FILES` + cat)
- Modify: `crates/desktop-gateway/src/sandbox.rs` (`contained_computer_def_hash` cat list)

**Interfaces:** consuma `fonts/`, `fonts_embed.py`, `fonts_manifest.py` (Task 1/2).

- [ ] **Step 1: Dockerfile — COPY i font e i moduli in `/opt/deck`.**

Vicino alle COPY esistenti (`COPY deck_render.py /opt/deck/...`, ri-grep), aggiungi PRIMA che i renderer siano invocati:

```dockerfile
COPY fonts_embed.py    /opt/deck/fonts_embed.py
COPY fonts_manifest.py /opt/deck/fonts_manifest.py
COPY fonts/            /opt/deck/fonts/
```

(così `import fonts_embed`/`import fonts_manifest` funzionano e `fonts_embed` trova `/opt/deck/fonts`.)

- [ ] **Step 2: `up.sh` — includi i font nell'hash di freschezza.**

In `runtimes/contained-computer/up.sh`, `HASH_FILES` aggiungi `fonts_embed.py fonts_manifest.py`; e nel comando che concatena, includi i woff2 (l'hash deve cambiare se un font cambia). Cambia la riga `HASH_FILES="…"` e assicura che il `cat ${HASH_PATHS}` copra anche `${HERE}/fonts/`*`.woff2`. Il modo più semplice e stabile: appendere `"$(cat ${HERE}/fonts/*.woff2 2>/dev/null | shasum -a256)"` — MA per non divergere da sandbox.rs, usa lo stesso identico elenco in entrambi. Concretamente in `up.sh`, estendi `HASH_FILES` con i due .py e aggiungi i woff2 al set di path hashati:

```bash
HASH_FILES="Dockerfile entrypoint.sh deck_render.py deck_qa.py doc_render.py design_tokens.py fonts_embed.py fonts_manifest.py whisper_server.py novnc-view.html"
# ...dopo aver costruito HASH_PATHS dai HASH_FILES, includi anche i woff2:
for f in "${HERE}"/fonts/*.woff2; do HASH_PATHS="${HASH_PATHS} ${f}"; done
```

- [ ] **Step 3: `sandbox.rs` — stessa lista nel cat del def-hash.**

In `crates/desktop-gateway/src/sandbox.rs` (`contained_computer_def_hash`, ri-grep la riga `cat Dockerfile entrypoint.sh …`), aggiungi `fonts_embed.py fonts_manifest.py` e i woff2 dei font allo stesso `cat`, per restare in sync con up.sh:

```rust
"cat Dockerfile entrypoint.sh deck_render.py deck_qa.py doc_render.py design_tokens.py fonts_embed.py fonts_manifest.py whisper_server.py novnc-view.html fonts/*.woff2 2>/dev/null | \
```

(mantieni il resto del comando/hash invariato; il glob `fonts/*.woff2` è espanso dalla shell del comando, come gli altri file).

- [ ] **Step 4: Build + PDF-embed validation (il gate reale di questo task).**

```bash
cd /Users/fabio/Projects/Homun/app
cargo test -p local-first-desktop-gateway contained_computer_def_hash -- --nocapture 2>/dev/null || true   # if a test exists
bash runtimes/contained-computer/up.sh    # rebuild image with fonts baked in
```

Poi valida in-container che il font è **incorporato** nel PDF (non fallback). Renderizza un deck editorial e cerca il nome famiglia nel PDF/HTML:

```bash
docker exec -i homun-cc /opt/deck-venv/bin/python - <<'PY'
import sys; sys.path.insert(0,'/opt/deck')
import deck_render
html = deck_render.render_html({'theme':{'name':'editorial_bold','heading_font':'Playfair Display','body_font':'Inter'},'slides':[{'layout':'cover','title':'X'}]}, '/tmp')
open('/tmp/o.html','w').write(html)
assert "font-family:'Playfair Display'" in html and "base64," in html, "no @font-face in HTML"
print("HTML @font-face OK")
PY
docker exec homun-cc sh -c "chromium --headless --no-sandbox --disable-gpu --print-to-pdf=/tmp/o.pdf /tmp/o.html >/dev/null 2>&1; strings /tmp/o.pdf | grep -i -m1 'Playfair' && echo 'PDF embeds Playfair' || echo 'PDF FALLBACK (font missing)'"
```
Expected: `HTML @font-face OK` + `PDF embeds Playfair`. (Se `homun-cc` non è ripartito con l'immagine nuova dopo `up.sh`, il container fresco lo è; in caso, `docker cp` dei file aggiornati come fallback di verifica.)

- [ ] **Step 5: Commit.**

```bash
git add runtimes/contained-computer/Dockerfile runtimes/contained-computer/up.sh crates/desktop-gateway/src/sandbox.rs
git commit -m "feat(presentations): bake fonts into container image + keep freshness hash in sync (up.sh + sandbox.rs)"
```

---

### Task 6: Regen preview committate + gate completi + STATO

**Files:**
- Modify (rigenerati): le `preview.html`/thumbnail dei pack sotto `runtimes/`/`templates/` prodotte da `scripts/build_template_previews.py`
- Modify: `docs/STATO.md`

- [ ] **Step 1: Rigenera le preview committate.**

Le preview ora incorporano l'@font-face reale → cambiano. Rigenerale col renderer vero (richiede il container su):

```bash
cd /Users/fabio/Projects/Homun/app && python3 scripts/build_template_previews.py
git status --porcelain | grep -i preview   # vedi le preview cambiate
```
Verifica a campione che una preview editoriale contenga `@font-face` e la famiglia bundled attesa (`grep -l "font-family:'Playfair Display'" ...preview.html`).

- [ ] **Step 2: Gate completi.**

```bash
cargo test -p local-first-desktop-gateway
cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron && cd ..
python3 scripts/pre_release_gate.py
```
Expected: ALL GREEN. Se un gate fallisce, fermati e risolvi prima di STATO/commit.

- [ ] **Step 3: STATO checkpoint.**

In `docs/STATO.md`, checkpoint IT (data 2026-07-18): *S3 — tipografia reale + font picker*: set curato 12 Google Font woff2 bundled (@fontsource, latin, OFL) + `@font-face` data-URI self-contained nei renderer (`fonts_embed.py`), picker curato nel BrandDrawer (select + specimen) che sostituisce il testo-libero, recolor live con @font-face, temi editoriali Georgia→Playfair Display/Source Serif 4 (py+rust sync), font nel container + hash freschezza in sync (up.sh + sandbox.rs), preview rigenerate. PPTX/DOCX solo nome (caveat). Chiude preview=verità sulla tipografia. Arco Presentations completo.

- [ ] **Step 4: Commit.**

```bash
git add -A && git commit -m "docs: STATO checkpoint — S3 (real typography + font picker) shipped; regen previews"
```

---

## Note

- **Fail-open ovunque**: famiglia fuori dal set / woff2 mancante → stack di fallback, nessun crash, mai `@font-face` con src vuoto.
- **Caposaldo**: consegna del font = stato-in-codice; scelta = slot vincolato al set curato.
- **Converge**: un solo manifest sorgente (build_fonts.py) → renderer + UI; `_font_face_css` condiviso; @fontsource è il meccanismo già in uso.
- **WYSIWYG**: stesso woff2 + @font-face alimentano anteprima e generato HTML/PDF. PPTX/DOCX = solo nome (caveat documentato).
- Embedding font in Office e font utente arbitrari = fuori scope (YAGNI).
