# Brand kit UX + font estesi (S4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migliorare il brand kit drawer (più largo, color-swatch visibile, font picker ricercabile con set esteso a ~36 famiglie bundled) e far riflettere la tipografia scelta nell'anteprima anche sui pack scuri — tutto offline, caposaldo WYSIWYG intatto.

**Architecture:** UI React/TS (BrandDrawer, nuovo FontSelect, presentationsShared) + il tooling font di S3 (`scripts/build_fonts.py` → `fonts_manifest.py` + `fontsManifest.ts`, ora con categorie). Nessun fetch a runtime: il set esteso è woff2 bundled come i 12 di S3. Il renderer/container non cambiano codice (solo più woff2 baked via `up.sh`).

**Tech Stack:** React 19 + TypeScript + Vite, Python (build_fonts), `@fontsource`, Docker (container rebuild).

## Global Constraints

- Branch **`presentations-s3-typography`** (merge a main a fine slice). **NIENTE `Co-Authored-By`**, **NIENTE push**. Commenti in inglese sul *perché*.
- ⚠️ **Verificare `git rev-parse --abbrev-ref HEAD` PRIMA di ogni commit** (Fabio lavora con più worktree/branch concorrenti; il branch del working dir può cambiare a metà sessione).
- **Set font ESTESO ~36, tutte OFL/Apache via `@fontsource`, woff2 latin 400+700, BUNDLED** (zero fetch a runtime). Superset dei 12 di S3.
- **Fail-open**: font fuori set → fallback stack; drawer/gallery mai rotti; `build_fonts.py` fallisce FORTE su un woff2 atteso mancante (mai `@font-face` vuoto).
- **Converge**: unica sorgente font = `build_fonts.py` → `fonts_manifest.py` (py) + `fontsManifest.ts` (ts); `FontSelect` legge da lì; `brandPreviewOverride` resta l'unico punto di recolor.
- **PPTX/DOCX**: invariati (solo nome). Nessuna rigenerazione preview (i pack usano i loro font già bundled).
- Gate: `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron`; `pre_release_gate.py`; **rebuild container** `runtimes/contained-computer/up.sh` (per bake dei nuovi woff2).

---

### Task 1: Drawer più largo + color-swatch prominente (CSS)

**Files:**
- Modify: `apps/desktop/src/styles.css` (`.brand-drawer`, `.brandkit-color input[type="color"]`, verifica `.brandkit-grid`)

**Interfaces:** nessuna (solo CSS).

- [ ] **Step 1: Allarga il drawer.** In `styles.css`, la regola `.brand-drawer` (grep `.brand-drawer {`): cambia `width: min(380px, 100vw);` → `width: min(560px, 100vw);`. Aggiungi un commento sul *perché* (la griglia 2-col a 380px andava in overflow orizzontale — feedback live).

- [ ] **Step 2: Swatch color prominente.** In `.brandkit-color input[type="color"]` (grep): porta a uno swatch evidente e cliccabile:

```css
.brandkit-color input[type="color"] {
  width: 44px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: none;
  cursor: pointer;
  flex: none;
}
```

- [ ] **Step 3: Anti-overflow di sicurezza.** In `.brand-drawer` assicura che l'overflow orizzontale non compaia mai: verifica che esista `overflow-y: auto;` e aggiungi `overflow-x: hidden;` sulla stessa regola. In `.brandkit-grid` lascia `repeat(2, minmax(0,1fr))` (il `minmax(0,…)` già permette lo shrink; con 560px c'è spazio).

- [ ] **Step 4: Gate (build).**

Run: `cd apps/desktop && npm run build`
Expected: PASS (CSS-only, tsc/vite verdi). Nota: cambiamento visivo → validazione a schermo di Fabio (non computer-verify qui).

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/styles.css
git commit -m "fix(presentations): widen brand kit drawer to 560px + prominent colour swatch (no h-scroll)"
```

---

### Task 2: Set font esteso ~36 (build_fonts.py + manifest con categorie)

**Files:**
- Modify: `scripts/build_fonts.py` (`CURATED` → `(slug, weights, category)`; genera `FONT_CATEGORIES` nel TS)
- Modify: `apps/desktop/package.json` (devDependencies: gli `@fontsource/*` mancanti)
- Modify (rigenerati + committati): `runtimes/contained-computer/fonts/*.woff2`, `runtimes/contained-computer/fonts_manifest.py`, `apps/desktop/src/components/fontsManifest.ts`

**Interfaces:**
- Produces: `fontsManifest.ts` guadagna `export const FONT_CATEGORIES: Record<string, string>` (family → "sans"|"serif"|"slab"|"mono"), oltre a `FONT_FAMILIES`/`FONT_FACES` esistenti.

- [ ] **Step 1: Estendi `CURATED` in `scripts/build_fonts.py`.** Cambia il dizionario da `family: (slug, [weights])` a `family: (slug, [weights], category)` e portalo a 36 famiglie (i 12 di S3 restano; aggiungi 24). Aggiorna il loop che lo consuma per spacchettare `(pkg, weights, category)`:

```python
# display name -> (@fontsource slug, [weights], category). Latin subset, 400+700.
CURATED = {
    # sans
    "Inter": ("inter", [400, 700], "sans"),
    "Roboto": ("roboto", [400, 700], "sans"),
    "Open Sans": ("open-sans", [400, 700], "sans"),
    "Lato": ("lato", [400, 700], "sans"),
    "Work Sans": ("work-sans", [400, 700], "sans"),
    "Montserrat": ("montserrat", [400, 700], "sans"),
    "Poppins": ("poppins", [400, 700], "sans"),
    "Source Sans 3": ("source-sans-3", [400, 700], "sans"),
    "Nunito Sans": ("nunito-sans", [400, 700], "sans"),
    "Mulish": ("mulish", [400, 700], "sans"),
    "Manrope": ("manrope", [400, 700], "sans"),
    "DM Sans": ("dm-sans", [400, 700], "sans"),
    "Figtree": ("figtree", [400, 700], "sans"),
    "Plus Jakarta Sans": ("plus-jakarta-sans", [400, 700], "sans"),
    "IBM Plex Sans": ("ibm-plex-sans", [400, 700], "sans"),
    "Archivo": ("archivo", [400, 700], "sans"),
    "Rubik": ("rubik", [400, 700], "sans"),
    "Karla": ("karla", [400, 700], "sans"),
    "Space Grotesk": ("space-grotesk", [400, 700], "sans"),
    "Sora": ("sora", [400, 700], "sans"),
    # serif
    "Source Serif 4": ("source-serif-4", [400, 700], "serif"),
    "Lora": ("lora", [400, 700], "serif"),
    "Merriweather": ("merriweather", [400, 700], "serif"),
    "Playfair Display": ("playfair-display", [400, 700], "serif"),
    "PT Serif": ("pt-serif", [400, 700], "serif"),
    "Libre Baskerville": ("libre-baskerville", [400, 700], "serif"),
    "EB Garamond": ("eb-garamond", [400, 700], "serif"),
    "Crimson Pro": ("crimson-pro", [400, 700], "serif"),
    "Spectral": ("spectral", [400, 700], "serif"),
    "Fraunces": ("fraunces", [400, 700], "serif"),
    # slab
    "Bitter": ("bitter", [400, 700], "slab"),
    "Roboto Slab": ("roboto-slab", [400, 700], "slab"),
    "Zilla Slab": ("zilla-slab", [400, 700], "slab"),
    # mono
    "JetBrains Mono": ("jetbrains-mono", [400, 700], "mono"),
    "IBM Plex Mono": ("ibm-plex-mono", [400, 700], "mono"),
    "Space Mono": ("space-mono", [400, 700], "mono"),
}
```

Nel `main()`, dove itera `for family, (pkg, weights) in CURATED.items():` → `for family, (pkg, weights, category) in CURATED.items():`; raccogli `categories[family] = category`. Aggiungi al blocco di scrittura del TS un terzo export:

```python
    ts = (
        "// GENERATED by scripts/build_fonts.py — do not edit by hand.\n"
        "export const FONT_FAMILIES: string[] = "
        f"{json.dumps(families, ensure_ascii=False)};\n\n"
        "export const FONT_CATEGORIES: Record<string, string> = "
        f"{json.dumps(categories, ensure_ascii=False)};\n\n"
        "export type FontFace = { weight: number; dataUri: string };\n"
        "export const FONT_FACES: Record<string, FontFace[]> = "
        f"{json.dumps(ts_faces, ensure_ascii=False)};\n"
    )
```

(dove `categories` è il dict family→category costruito nel loop.)

- [ ] **Step 2: Aggiungi gli `@fontsource` mancanti.** In `apps/desktop/package.json` devDependencies, aggiungi (i 12 di S3 ci sono già):

```
"@fontsource/source-sans-3","@fontsource/nunito-sans","@fontsource/mulish","@fontsource/manrope","@fontsource/dm-sans","@fontsource/figtree","@fontsource/plus-jakarta-sans","@fontsource/ibm-plex-sans","@fontsource/archivo","@fontsource/rubik","@fontsource/karla","@fontsource/space-grotesk","@fontsource/sora","@fontsource/pt-serif","@fontsource/libre-baskerville","@fontsource/eb-garamond","@fontsource/crimson-pro","@fontsource/spectral","@fontsource/fraunces","@fontsource/bitter","@fontsource/roboto-slab","@fontsource/zilla-slab","@fontsource/ibm-plex-mono","@fontsource/space-mono"
```

(tutti `^5`). Poi `cd apps/desktop && npm install`.

- [ ] **Step 3: Genera + verifica.** ⚠️ Alcuni slug/file `@fontsource` variano: se un woff2 atteso manca, `build_fonts.py` fallisce forte (`missing woff2: …`). Se fallisce, **verifica il nome reale** del file in `apps/desktop/node_modules/@fontsource/<slug>/files/` (es. un font potrebbe non avere `700` ma `600`, o lo slug differisce) e correggi `CURATED`.

```bash
cd /Users/fabio/Projects/Homun/app && python3 scripts/build_fonts.py
ls runtimes/contained-computer/fonts/ | wc -l    # expect 72 (36×2)
python3 -c "import importlib.util as u; s=u.spec_from_file_location('m','runtimes/contained-computer/fonts_manifest.py'); m=u.module_from_spec(s); s.loader.exec_module(m); assert len(m.FONTS)==36 and m.FONTS['Fraunces'][700]; print('py OK', len(m.FONTS))"
grep -c "FONT_CATEGORIES" apps/desktop/src/components/fontsManifest.ts    # expect >=1
node -e "const s=require('fs').readFileSync('apps/desktop/src/components/fontsManifest.ts','utf8'); const m=s.match(/FONT_FAMILIES[^\[]*\[(.*?)\]/s); console.log('families in ts:', (m[1].match(/,/g)||[]).length + 1)"   # expect 36
```
Expected: 72 woff2, `py OK 36`, FONT_CATEGORIES present, 36 families.

- [ ] **Step 4: Commit.**

```bash
git add scripts/build_fonts.py apps/desktop/package.json apps/desktop/package-lock.json \
  runtimes/contained-computer/fonts runtimes/contained-computer/fonts_manifest.py \
  apps/desktop/src/components/fontsManifest.ts
git commit -m "feat(presentations): expand bundled font set to 36 families + FONT_CATEGORIES"
```

---

### Task 3: Split del recolor guard — font sempre, colori solo non-dark

**Files:**
- Modify: `apps/desktop/src/components/presentationsShared.ts` (`brandPreviewOverride` gains `opts`)
- Modify: `apps/desktop/src/components/TemplateCard.tsx` (call-site passa `colorSafe`)
- Test: un test unità sulla fn pura (se il progetto ha un runner per presentationsShared; altrimenti via ui-contract assertion). Vedi Step 1.

**Interfaces:**
- Consumes: `DARK_SURFACE_THEMES`, `fontFaceStyle`, `safeColor`, `safeFont` (esistenti).
- Produces: `brandPreviewOverride(kit: BrandKit, opts?: { colorSafe?: boolean }): { style: string; logo: string } | null`.

- [ ] **Step 1: Test rosso (comportamento della fn pura).** Aggiungi un test dove il progetto tiene i test TS (grep `test:electron` copre `tests/*.test.mjs`; se esiste un test per presentationsShared riusalo, altrimenti crea `apps/desktop/tests/brand-preview-override.test.mjs`). Poiché `presentationsShared.ts` importa React types via `BrandKit`, il test importa la fn e verifica le stringhe:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
// NB: se l'import diretto del .ts non è supportato dal runner, spostare la logica
// di composizione dello <style> in una fn pura testabile o testare via ui-contract.
// Asserzioni attese sul risultato di brandPreviewOverride(kit, {colorSafe}):
//  - colorSafe:false → style NON contiene "--brand:" ma SÌ "@font-face" e "--head:'"
//  - colorSafe:true  → style contiene sia "--brand:" sia "--head:'"
//  - kit di default  → ritorna null
```

Se l'import del `.ts` non è praticabile nel runner electron, questo Task usa invece un **lock ui-contract** (Step 4) che asserisce la presenza del ramo `colorSafe` nel sorgente + la logica è verificata a schermo. Scegli la via testabile disponibile e dichiarala nel report.

- [ ] **Step 2: Estendi `brandPreviewOverride`.** In `presentationsShared.ts`, cambia la firma e separa font (sempre) da colori (condizionali). Struttura attuale: costruisce `headingFont`/`bodyFont`/`primary`/`secondary`/`accent` e uno `<style>` unico. Nuova forma:

```ts
export function brandPreviewOverride(
  kit: BrandKit,
  opts: { colorSafe?: boolean } = { colorSafe: true },
): { style: string; logo: string } | null {
  const isDefault = /* invariato: confronto con DEFAULT_KIT */;
  if (isDefault) return null;
  const headingFont = safeFont(kit.heading_font);
  const bodyFont = safeFont(kit.body_font);
  const faces = fontFaceStyle([headingFont, bodyFont]);
  // Font override is ALWAYS safe (it never touches --surface/--brand/--accent),
  // so it applies even on dark editorial packs. Colour override only when colorSafe.
  const colourVars = opts.colorSafe
    ? `--brand:${safeColor(kit.primary_color, DEFAULT_KIT.primary_color)} !important;` +
      `--brand2:${safeColor(kit.secondary_color, DEFAULT_KIT.secondary_color)} !important;` +
      `--accent:${safeColor(kit.accent_color, DEFAULT_KIT.accent_color)} !important;`
    : "";
  const style =
    `<style>${faces}:root{${colourVars}` +
    `--head:'${headingFont}' !important;` +
    `--body:'${bodyFont}' !important;}</style>`;
  const logo = /* invariato */;
  return { style, logo };
}
```

(mantieni la logica `logo` e `isDefault` esistenti — solo la composizione dello `<style>` e la firma cambiano.)

- [ ] **Step 3: Call-site in `TemplateCard.tsx`.** Oggi (grep `allowRecolor`):

```ts
const allowRecolor = !(entry.design_theme && DARK_SURFACE_THEMES.has(entry.design_theme));
const override = brandKit && allowRecolor ? brandPreviewOverride(brandKit) : null;
```

Cambia in: **applica sempre l'override** (così il font passa anche sui scuri), ma con `colorSafe` = non-scuro:

```ts
const colorSafe = !(entry.design_theme && DARK_SURFACE_THEMES.has(entry.design_theme));
const override = brandKit ? brandPreviewOverride(brandKit, { colorSafe }) : null;
```

- [ ] **Step 4: Gate.**

Run: `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron`
Expected: verdi (+ il nuovo test se aggiunto). Se hai usato il lock ui-contract, aggiorna `scripts/check-ui-contract.mjs` per lockare il ramo `colorSafe`.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/components/presentationsShared.ts apps/desktop/src/components/TemplateCard.tsx apps/desktop/scripts/check-ui-contract.mjs apps/desktop/tests/ 2>/dev/null
git commit -m "fix(presentations): apply font override on all packs (colours only on light packs)"
```

---

### Task 4: `FontSelect` ricercabile + categorie (sostituisce i 2 select)

**Files:**
- Create: `apps/desktop/src/components/FontSelect.tsx`
- Modify: `apps/desktop/src/components/BrandDrawer.tsx` (usa `FontSelect` al posto dei 2 `<select>`)
- Modify: `apps/desktop/src/styles.css` (stili `.font-select*`)

**Interfaces:**
- Consumes: `FONT_FAMILIES`, `FONT_CATEGORIES` da `./fontsManifest` (Task 2); l'`@font-face` è già iniettato in `document.head` da BrandDrawer (`useEffect`).
- Produces: `FontSelect({ value, onChange, label }: { value: string; onChange: (family: string) => void; label: string })`.

- [ ] **Step 1: Crea `FontSelect.tsx`.** Combobox: bottone (famiglia corrente nel suo font) → popover con ricerca + lista raggruppata per categoria, ogni voce nel proprio font.

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { FONT_FAMILIES, FONT_CATEGORIES } from "./fontsManifest";

const CATEGORY_ORDER = ["sans", "serif", "slab", "mono"];
const CATEGORY_LABEL: Record<string, string> = {
  sans: "Sans", serif: "Serif", slab: "Slab", mono: "Mono",
};

/** Searchable font picker over the bundled curated set (S4). Options render in
 *  their own family via the @font-face BrandDrawer injects once into <head>. A
 *  plain <select> can't search or show specimens — this can. Fail-open: a value
 *  outside the set still shows (legacy kits). */
export function FontSelect({
  value, onChange, label,
}: { value: string; onChange: (family: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = FONT_FAMILIES.filter((f) => f.toLowerCase().includes(q));
    return CATEGORY_ORDER.map((cat) => ({
      cat,
      fonts: match.filter((f) => (FONT_CATEGORIES[f] ?? "sans") === cat),
    })).filter((g) => g.fonts.length > 0);
  }, [query]);

  return (
    <div className="font-select" ref={rootRef}>
      <button
        type="button"
        className="font-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{ fontFamily: `'${value}', sans-serif` }}
        onClick={() => { setOpen((o) => !o); setQuery(""); }}
      >
        {value || label}
      </button>
      {open && (
        <div className="font-select-pop" role="listbox" aria-label={label}>
          <input
            className="font-select-search"
            autoFocus
            placeholder="Cerca font…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="font-select-list">
            {groups.map((g) => (
              <div key={g.cat} className="font-select-group">
                <div className="font-select-group-label">{CATEGORY_LABEL[g.cat]}</div>
                {g.fonts.map((f) => (
                  <button
                    type="button"
                    key={f}
                    role="option"
                    aria-selected={f === value}
                    className={`font-select-option${f === value ? " selected" : ""}`}
                    style={{ fontFamily: `'${f}', sans-serif` }}
                    onClick={() => { onChange(f); setOpen(false); }}
                  >
                    {f}
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 && <div className="font-select-empty">Nessun font</div>}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Usa `FontSelect` in `BrandDrawer.tsx`.** Importa `FontSelect` e sostituisci i due blocchi `<select>…</select>` (heading + body, grep `heading_font`/`body_font` select) con:

```tsx
<label className="brandkit-field">
  <span>{t("presentations:heading_font")}</span>
  <FontSelect
    value={kit.heading_font}
    onChange={(f) => onChange("heading_font", f)}
    label={t("presentations:heading_font")}
  />
</label>
<label className="brandkit-field">
  <span>{t("presentations:body_font")}</span>
  <FontSelect
    value={kit.body_font}
    onChange={(f) => onChange("body_font", f)}
    label={t("presentations:body_font")}
  />
</label>
```

(rimuovi i vecchi `<select>` + i `.font-specimen` div sotto — lo specimen è ora il bottone stesso, reso nel font. Mantieni l'`useEffect` che inietta `fontFaceStyle(FONT_FAMILIES)` in `<head>`: ora serve al popover.)

- [ ] **Step 3: CSS del combobox.** In `styles.css`, aggiungi (posizione: `.font-select{position:relative}` per ancorare il popover):

```css
.font-select { position: relative; }
.font-select-btn {
  width: 100%; text-align: left; padding: 8px 10px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface); color: var(--text); font-size: 15px; cursor: pointer;
}
.font-select-pop {
  position: absolute; z-index: 10; top: calc(100% + 4px); left: 0; right: 0;
  background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: 0 12px 40px rgba(15,23,42,.24); padding: 8px; max-height: 320px;
  display: flex; flex-direction: column; gap: 6px;
}
.font-select-search {
  font: inherit; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 8px; background: var(--surface); color: var(--text);
}
.font-select-list { overflow-y: auto; }
.font-select-group-label {
  font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--muted); padding: 8px 6px 4px;
}
.font-select-option {
  display: block; width: 100%; text-align: left; padding: 7px 10px;
  border: 0; border-radius: 6px; background: none; color: var(--text);
  font-size: 15px; cursor: pointer;
}
.font-select-option:hover, .font-select-option.selected { background: var(--surface-muted, rgba(127,127,127,.12)); }
.font-select-empty { padding: 10px; color: var(--muted); font-size: 13px; }
```

- [ ] **Step 4: Gate.**

Run: `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron`
Expected: verdi. Se `check-ui-contract.mjs` lockava il vecchio `<select>` dei font, aggiornalo al nuovo `FontSelect`.

- [ ] **Step 5: Commit.**

```bash
git add apps/desktop/src/components/FontSelect.tsx apps/desktop/src/components/BrandDrawer.tsx apps/desktop/src/styles.css apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(presentations): searchable, categorised font picker (FontSelect) with in-family specimens"
```

---

### Task 5: Rebuild container + gate completi + STATO

**Files:**
- Modify: `docs/STATO.md`

- [ ] **Step 1: Rebuild container (bake dei nuovi woff2).**

```bash
cd /Users/fabio/Projects/Homun/app && bash runtimes/contained-computer/up.sh
```
Poi valida che i 72 woff2 siano nell'immagine e che un font NUOVO renda:
```bash
docker exec homun-cc sh -c "ls /opt/deck/fonts/*.woff2 | wc -l"   # expect 72
docker exec -i homun-cc /opt/deck-venv/bin/python - <<'PY'
import sys; sys.path.insert(0,'/opt/deck')
import deck_render
h = deck_render.render_html({'theme':{'name':'clean_corporate','heading_font':'Fraunces','body_font':'Manrope'},'slides':[{'layout':'cover','title':'X'}]}, '/tmp')
assert "font-family:'Fraunces'" in h and "font-family:'Manrope'" in h and "base64," in h, "new fonts not embedded"
print("new fonts embed OK")
PY
```
Expected: `72`, `new fonts embed OK`.

- [ ] **Step 2: Gate completi.**

```bash
cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron && cd ..
cargo test -p local-first-desktop-gateway   # non toccato, ma conferma il workspace verde
python3 scripts/pre_release_gate.py
```
Expected: ALL GREEN. Se un gate fallisce, STOP → BLOCKED, non scrivere STATO.

- [ ] **Step 3: STATO checkpoint.** In `docs/STATO.md`, checkpoint IT (data 2026-07-19): *S4 — brand kit UX + font estesi*: drawer allargato a 560px (no scroll orizzontale) + color-swatch prominente; set font esteso 12→36 famiglie bundled (offline, @fontsource, latin 400+700) con categorie; `FontSelect` ricercabile con specimen in-family al posto dei select piatti; font override applicato nell'anteprima anche sui pack scuri (colori solo sui chiari). Offline/WYSIWYG intatto; PPTX/DOCX invariati. Cosa resta: (futuro) catalogo Google on-demand fetch+cache se mai servisse oltre le 36.

- [ ] **Step 4: Commit.**

```bash
git add docs/STATO.md && git commit -m "docs: STATO checkpoint — S4 (brand kit UX + expanded fonts) shipped"
```

---

## Note

- **Fail-open**: font fuori set → fallback; `FontSelect` mostra comunque un valore legacy; `build_fonts.py` fallisce forte su woff2 mancante.
- **Offline/WYSIWYG**: set esteso è bundled woff2, zero fetch a runtime; stesso `@font-face` alimenta anteprima + generato + container.
- **Converge**: un'unica sorgente (`build_fonts.py`), `FontSelect` + renderer leggono da lì.
- A fine slice: **merge di `presentations-s3-typography` → main** (porta i commit S4) + rebuild/dist per la validazione, su richiesta di Fabio.
