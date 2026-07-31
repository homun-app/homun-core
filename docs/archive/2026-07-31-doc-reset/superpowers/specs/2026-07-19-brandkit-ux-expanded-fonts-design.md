# Brand kit UX + font estesi (S4) — design

Data: 2026-07-19 · Stato: **Design approvato da Fabio** (font: set bundled esteso ~36, offline; no Google runtime fetch). Arco: Presentations, dopo S3 (tipografia reale). Feedback raccolto dall'app S3 live.

## Problema (feedback di Fabio a schermo)

Sul brand kit drawer (app S3 in esecuzione):
1. **Drawer troppo stretto** (`width: min(380px, 100vw)`): la griglia 2-colonne va in overflow → **scroll orizzontale**.
2. **Color picker "assente"**: in realtà `<input type="color">` **esiste** (BrandDrawer righe ~133), ma lo stretto lo schiaccia a una barretta → non si percepisce come picker.
3. **Solo 12 font + select non ricercabile**: la dozzina curata di S3 sta stretta; serve poter **cercare** il font e averne di più.
4. **Anteprima senza tipografia sui pack scuri**: il recolor (font incluso) è **saltato interamente** sui pack editoriali scuri (`allowRecolor = !DARK_SURFACE_THEMES`), per proteggerne la palette → cambiando font, le card scure non lo mostrano. (Sui pack chiari il font override RAGGIUNGE già l'anteprima: `TemplateCard` inietta `override.style` — con `@font-face` + `--head/--body` — nell'iframe, e `BrandKitPanel` passa il kit **live** a gallery+drawer.)

## Scope (deciso)

**Set bundled ESTESO (~36 famiglie), 100% offline, zero fetch a runtime** (il full-catalog Google via CDN
è escluso: romperebbe offline + il caposaldo WYSIWYG di S3 + manderebbe la scelta font a Google). L'on-demand
fetch+cache del catalogo completo è una slice futura separata, non ora (YAGNI per il caso business).

## Architettura

### 1. Drawer più largo + griglia (CSS)

`.brand-drawer` `width: min(380px, 100vw)` → **`min(560px, 100vw)`**. La `.brandkit-grid` resta
`repeat(2, minmax(0,1fr))` ma ora ha spazio; verificare che nessun campo forzi overflow (color+hex,
select+specimen). Niente scroll orizzontale (`.brand-drawer` resta `overflow-y:auto`, `overflow-x` non deve
mai attivarsi). Solo `styles.css`.

### 2. Color swatch prominente (CSS)

L'`<input type="color">` c'è già. Renderlo un **swatch evidente e cliccabile** accanto all'hex:
`.brandkit-color input[type="color"]` → dimensione comoda (es. 44×36, `border-radius:10px`, cursore
pointer, il chrome nativo del picker resta). Nessun cambio JS (l'onChange e lo state key già ci sono).

### 3. Set font esteso ~36 (build_fonts.py + manifest + container)

Estendere `CURATED` in `scripts/build_fonts.py` a **~36 famiglie** (tutte OFL/Apache su `@fontsource`,
woff2 **latin 400+700**), con una **categoria** per il picker raggruppato:

- **Sans:** Inter, Roboto, Open Sans, Lato, Work Sans, Montserrat, Poppins, Source Sans 3, Nunito Sans,
  Mulish, Manrope, DM Sans, Figtree, Plus Jakarta Sans, IBM Plex Sans, Archivo, Rubik, Karla, Space Grotesk, Sora
- **Serif:** Source Serif 4, Lora, Merriweather, Playfair Display, PT Serif, Libre Baskerville, EB Garamond,
  Crimson Pro, Spectral, Fraunces
- **Slab:** Bitter, Roboto Slab, Zilla Slab
- **Mono:** JetBrains Mono, IBM Plex Mono, Space Mono

`CURATED` diventa `family -> (slug, [weights], category)`. Aggiungere le `@fontsource/*` mancanti a
`apps/desktop/package.json` (devDependencies). Rigenerare:
- `runtimes/contained-computer/fonts_manifest.py` (`FONTS`, invariato di forma),
- `apps/desktop/src/components/fontsManifest.ts` — `FONT_FAMILIES` + `FONT_FACES` (base64) **+ nuovo
  `FONT_CATEGORIES: Record<string,string>`** (family→categoria) per la lista raggruppata.

Rebuild container (`up.sh`) così le nuove woff2 sono baked. **Nessuna rigenerazione preview** (i pack usano i
loro font, già bundled; l'espansione aggiunge solo famiglie disponibili). Costo: il manifest base64 UI cresce
(~36×2 pesi ≈ 2-3MB nel bundle app) — è il prezzo del WYSIWYG offline, accettabile.

### 4. `FontSelect` ricercabile (nuovo componente)

Nuovo `apps/desktop/src/components/FontSelect.tsx`: sostituisce i due `<select>` piatti in `BrandDrawer`.
- Bottone che mostra la famiglia corrente **resa nel suo font** (via l'`@font-face` già iniettato da
  BrandDrawer `useEffect`).
- Al click apre un **popover** con: campo di **ricerca** (filtra per nome, case-insensitive) + lista
  **raggruppata per categoria** (`FONT_CATEGORIES`), ogni voce resa nel proprio font.
- Navigazione da tastiera (↑/↓/Enter/Esc), click-outside per chiudere, `role="listbox"`/`option` a11y.
- Props: `value: string`, `onChange: (family: string) => void`, `label`. Consuma `FONT_FAMILIES` +
  `FONT_CATEGORIES` da `fontsManifest`.
- Fail-open: valore fuori dal set → mostrato com'è (legacy), la ricerca lo lascia selezionabile o ricade
  sull'elenco (nessun crash).

### 5. Tipografia nell'anteprima anche sui pack scuri (split del recolor guard)

Oggi `TemplateCard`: `allowRecolor = !dark; override = allowRecolor ? brandPreviewOverride(kit) : null` →
sui pack scuri salta TUTTO (font incluso). Spacchettare in `brandPreviewOverride` (o al call-site):
- **Font override (`@font-face` + `--head/--body`)**: applicato **SEMPRE** (sicuro sui scuri — non tocca
  `--surface`/`--brand`/`--accent`).
- **Color override (`--brand/--brand2/--accent`)**: applicato **solo sui pack NON scuri** (come oggi).

Concretamente: `brandPreviewOverride(kit, { colorSafe: boolean })` costruisce lo `<style>` con le
`@font-face`+font-vars sempre, e le color-vars solo se `colorSafe`. Il call-site passa
`colorSafe = !DARK_SURFACE_THEMES.has(entry.design_theme)`. Così cambiare font si riflette su **tutte** le
card (il kit è già live via `BrandKitPanel`). `isDefault` early-return invariato (kit di default → nessun
override).

### 6. Test + gate + rebuild + STATO

- `FontSelect`: la ricerca filtra; selezione chiama `onChange`; render in-family (ui-contract/electron).
- `brandPreviewOverride(kit,{colorSafe})`: `colorSafe:false` → NIENTE color-vars ma SÌ font `@font-face`+
  `--head/--body`; `colorSafe:true` → entrambi; default kit → null.
- `build_fonts.py`: 36 famiglie × 400/700 woff2 + `FONT_CATEGORIES` nel manifest TS; fail-loud su woff2
  mancante; idempotente.
- Gate: `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron`;
  `cargo test -p local-first-desktop-gateway` (se toccato Rust — non previsto); `pre_release_gate.py`;
  **rebuild container** `up.sh`.

## Invarianti / coerenza

- **Offline + WYSIWYG**: tutti i font bundled woff2, zero fetch a runtime; il font scelto rende identico in
  anteprima e generato (stesso `@font-face` da un'unica sorgente).
- **Converge, non duplica**: unico manifest sorgente (`build_fonts.py` → py + ts); `FontSelect` legge da lì;
  `brandPreviewOverride` resta l'unico punto di recolor.
- **Fail-open**: font fuori set → fallback stack; drawer/gallery mai rotti.
- **Caposaldo intatto**: nessun regresso su local-first (niente rete per i font).

## Esclusioni (YAGNI)

- Catalogo Google completo / on-demand fetch+cache (slice futura separata, se mai servirà oltre le ~36).
- Embedding font in PPTX/DOCX (resta solo nome, come S3).
- Pesi oltre 400/700 (uniforme, bounded); subset non-latin.
- Upload font utente arbitrari.

## Rischi

- **Bundle app +2-3MB** (base64 di 36 famiglie): accettabile e necessario al recolor offline nell'iframe
  (CSP: data-URI è l'unica via). Se troppo, si potrà lazy-caricare il manifest, ma non ora.
- **Immagine container più grande** (36×2 woff2 ≈ +1-1.5MB): trascurabile.
- **Slug `@fontsource`**: variano (es. `source-sans-3`, `plus-jakarta-sans`, `ibm-plex-sans`); il build
  script deve risolvere i file reali e **fallire forte** se un woff2 atteso manca (mai emettere un
  `@font-face` vuoto).
- **`<input type=color>` su alcune piattaforme**: il chrome nativo varia; lo swatch resta funzionale
  (fallback: l'hex text input accanto).
