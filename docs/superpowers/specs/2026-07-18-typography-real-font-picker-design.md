# Tipografia reale + font picker (S3) — design

Data: 2026-07-18 · Stato: **Design approvato da Fabio** (scope: tipografia reale + picker completo; select curato sostituisce il testo-libero; @font-face data-URI). Arco: Presentations, dopo Fase 2 (editorial cover al generato).

## Problema (l'anteprima mente anche sulla tipografia)

I renderer dichiarano solo il **nome** del font in uno stack (`font-family: var(--head), -apple-system, …`):
**nessun `@font-face`, nessun file font**. Il container ha **solo `fonts-liberation`** (Liberation/Nimbus)
— niente Inter, niente Georgia. Conseguenza verificata:

- Il deck/doc **generato** (HTML/PDF resi da chromium nel container) usa **Liberation/Nimbus di ripiego**,
  non la famiglia scelta. La tipografia è di fatto **ignorata al generato**.
- L'**anteprima live** (iframe Electron, su macOS ha SF + Georgia) mostra font di sistema → **anteprima ≠
  generato** sulla tipografia. Stessa classe di bug della Fase 2 (l'anteprima mostra una verità che
  l'output non riproduce, per *alimentazione* mancante — là il chrome, qui i file font).

Un "picker" da solo sarebbe rossetto: farebbe scegliere un font che poi non rende. La cura è **rendere la
tipografia reale e identica ovunque** bundlando woff2 veri e iniettandoli via `@font-face`.

## Principio (caposaldo)

Una sola sorgente del font (woff2 bundled, license-clean) alimenta anteprima **e** generato → *preview =
verità per costruzione*. Il font scelto è uno **slot vincolato** a un set curato garantito-di-rendere: il
codice possiede la consegna (i file + l'`@font-face`), il modello/utente riempie solo la scelta dalla lista.

## Architettura

### 1. Set curato (~12 famiglie, OFL/Apache, subset latin)

Acquisite via **`@fontsource`** (già in uso nell'app per hanken-grotesk/jetbrains-mono/instrument-serif —
niente download manuale, versionate, OFL). Pesi **400 + 700** (+ **600** dove un tema lo usa):

- **Sans:** Inter, Roboto, Open Sans, Lato, Work Sans, Montserrat, Poppins
- **Serif:** Source Serif 4, Lora, Merriweather, Playfair Display
- **Mono:** JetBrains Mono (già presente)

Il set è **dato** in un unico manifest condiviso (famiglia → {peso → file woff2}); la UI, il renderer e lo
script di bundle leggono da lì (converge, non duplica).

### 2. Bundle woff2 + build script

`scripts/build_fonts.py` copia i woff2 necessari da `node_modules/@fontsource/<family>/files/*latin*.woff2`
in `runtimes/contained-computer/fonts/` (nomi normalizzati `<family>-<weight>.woff2`) e **genera**:
- il manifest Python del renderer (famiglia → percorsi woff2), e
- un manifest **TS con data-URI base64** per la UI (`apps/desktop/src/…/fontsManifest.ts`), per il recolor
  live (l'iframe di anteprima è un documento a sé: non eredita gli `@font-face` del parent, gli servono i
  propri, CSP-safe come data-URI).

I woff2 sorgente sono committati (self-hosting/offline). Il `Dockerfile` `COPY`a `fonts/` nell'immagine. Lo
`up.sh` `HASH_FILES` oggi elenca **file singoli** (Dockerfile, entrypoint.sh, i .py, …) e NON include i font
→ va esteso per includere i woff2 di `fonts/` (freschezza: un cambio font deve rigenerare l'immagine, altrimenti
il container tiene i vecchi font). L'`HASH_FILES` deve restare in sync con `contained_computer_def_hash()` lato
gateway (Rust): entrambi devono hashare anche i font, o il gateway non rileverebbe lo staleness.

### 3. Renderer: `@font-face` self-contained

In `deck_render.py` e `doc_render.py`, una pura `_font_face_css(families) -> str` che, per le sole famiglie
**usate** nel deck/doc, legge i woff2 dal fonts-dir locale e emette regole `@font-face` con
`src: url(data:font/woff2;base64,…)`. L'HTML diventa **self-contained** (rende identico in container,
anteprima e ovunque l'utente lo apra, offline). Iniezione:
- `deck_render`: `_HTML_CSS` è un `.format()` a **doppia-graffa** → l'`@font-face` va in uno slot dedicato
  `{font_faces}` dello `_HTML_SHELL` (stringa pre-costruita, **non** passata a `.format`, così le graffe del
  CSS non vanno escapate).
- `doc_render`: `_CSS_BODY` è raw (single-brace) → iniezione diretta prima del corpo CSS.

Le famiglie usate = quelle del tema risolto (`heading_font` + `body_font`) — sempre nel set curato.

### 4. Temi editoriali: via da "Georgia"

`"Georgia"` (non-OFL, non-bundlabile, già in fallback) → serif **reale bundled** in `design_tokens.py`:
- deck **editorial_noir/bold** heading → **Playfair Display** (display drammatico, coerente con "massimo
  impatto editoriale");
- doc **editorial_warm/ivory/slate** heading → **Source Serif 4** (serif da stampa leggibile).
Body resta **Inter** (ora reale). Ogni altra occorrenza di Georgia nei temi → serif bundled equivalente.

### 5. Picker UI (BrandDrawer)

I due `<input>` testo-libero `heading_font`/`body_font` → **`<select>`** del set curato, ciascuna opzione
resa **nel proprio font** (specimen live; l'app importa gli `@fontsource` CSS così le opzioni si vedono). Il
kit salva la **famiglia esatta** dalla lista. Nessun escape-hatch testo-libero: oggi non renderebbe comunque,
e un font non-bundled reintrodurrebbe l'anteprima≠generato. i18n per le label esistenti invariato.

### 6. Recolor live anteprima

`presentationsShared.ts` `brandPreviewOverride`: oltre a `--head`/`--body`, **prepende** l'`@font-face`
(data-URI dal `fontsManifest.ts`) delle famiglie scelte, così l'iframe di anteprima mostra il font vero.
`safeFont` resta la guardia sul token famiglia. Fail-open: famiglia fuori dal manifest → nessun @font-face
iniettato (stack di fallback attuale).

### 7. Preview committate rigenerate

`scripts/build_template_previews.py` rende dal renderer vero → le preview committate ora **cambiano**
(mostrano la tipografia reale con `@font-face`). Rigenerare e committare (diverso dalla Fase 2, dove le
preview non cambiavano).

### 8. Export nativi PPTX/DOCX

Impostano il **nome** del font (già oggi). **Embedding font in Office = fuori scope** (complesso, slice a
sé): se la macchina dell'utente non ha la famiglia, Office ripiega. Caveat onesto e documentato, come
l'hero_art in Fase 2 (l'anteprima on-screen HTML/PDF è la verità che deve combaciare, e combacia).

## Invarianti / coerenza

- **Caposaldo**: la consegna del font (file + @font-face) è stato-in-codice; la scelta è uno slot vincolato
  al set curato. Niente font inventati/non-renderizzabili.
- **Converge, non duplica**: un unico set/manifest sorgente → renderer, UI e build script leggono da lì;
  woff2 sourcati da `@fontsource` (stesso meccanismo già in uso). Nessun secondo elenco font.
- **Fail-open**: famiglia sconosciuta → stack di fallback attuale, nessun crash.
- **WYSIWYG**: stesso woff2 + stesso `@font-face` alimentano anteprima e generato HTML/PDF.
- **Local-first / license**: tutto OFL/Apache, bundled, zero fetch a runtime, offline.

## Test

- `_font_face_css`: emette `@font-face` **solo** per le famiglie passate, base64 valido, subset latin; deck/doc
  senza famiglie note → stringa vuota (fail-open).
- Renderer: l'HTML generato contiene l'`@font-face` per la famiglia del tema + il `font-family` corretto.
- Build script: `build_fonts.py` produce i woff2 attesi + i due manifest (Python + TS base64) idempotente.
- UI: il select mostra il set curato e salva la famiglia; `brandPreviewOverride` inietta l'@font-face della
  famiglia scelta (ui-contract lock su `fontsManifest`/select).
- Gate: `cargo test -p local-first-desktop-gateway` (se toccato Rust), `npm run build`/`test:ui-contract`/
  `test:electron`, `pre_release_gate.py`; **rebuild container** (`up.sh`) + **regen preview** + validazione
  in-container che il PDF incorpora il font (font presente nel PDF, non fallback).

## Esclusioni (YAGNI)

- Embedding font in PPTX/DOCX nativi (solo nome).
- Font utente arbitrari/non-bundled, upload font custom, variabili-font, subset non-latin (latin-ext solo se
  serve a una famiglia del set).
- Auto-abbinamento font↔tema oltre al remap Georgia→serif bundled.

## Rischi

- **Peso HTML**: 12 famiglie × pesi in base64 gonfierebbero l'HTML → mitigato embeddando **solo le famiglie
  usate** dal deck/doc (2-3), subset latin. Il manifest TS per la UI porta tutte le famiglie in base64 (~1MB
  nel bundle app) — accettabile, alternativa (asset URL) non è CSP-safe nell'iframe srcDoc.
- **Nomi @fontsource**: i pacchetti/nomi file variano per famiglia (es. `source-serif-4`, subset in nome
  file) → il build script deve risolvere i path realmente presenti, non assumerli; fallire forte se un woff2
  atteso manca (pack-authoring bug), mai emettere un @font-face vuoto.
- **Container hash**: se `fonts/` non entra nell'hash di freschezza, un cambio font non rigenererebbe
  l'immagine → aggiungere `fonts/` all'`HASH_FILES`.
