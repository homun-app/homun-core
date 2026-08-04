# Presentations Studio — ridisegno editoriale gallery-first

Data: 2026-07-17 · Stato: **Approvata (direzione) da Fabio** (3 fork: categorie per scopo · brand chip+drawer · massimo impatto editoriale)

## Contesto e critica

L'arco F1+F2+F3 ha reso i template *reali* (8 pack, preview dal renderer, brand recolor live), ma
la pagina Presentations resta un'esperienza di livello basso rispetto al riferimento (Z.ai):

- **Il brand kit occupa la colonna sinistra in permanenza.** È configurazione *set-once*; una
  volta impostato non serve più, ma mangia ~30% del canvas per sempre.
- **I template sembrano grigi e tristi.** Non è il card design: gli *esempi* usano temi timidi
  (`minimal_mono`/`soft_gradient`), e la card scura + documento pallido = spento. Z.ai ha
  thumbnail full-bleed editoriali, sature, tipografiche.
- **Il prompt "Use template" è un compito in classe**: scarica in chat un muro "Template Analysis"
  + 4 domande numerate. Non premium.
- **Organizzazione piatta**: griglia 2-col + tab formato + tab sorgenti + card sorgenti esterne
  nel flusso = rumore.

## Principio guida (concilia wow e onestà)

**Preview = verità resta il caposaldo.** L'impatto editoriale NON viene da anteprime truccate:
viene dall'**alzare il soffitto di design del renderer stesso** (scala tipografica, cover
full-bleed, campi colore, art procedurale). Così anche il deliverable che l'utente genera davvero
esce editoriale — la vetrina è solo la dimostrazione. I temi di showcase sono temi che il pack
**spedisce realmente**, scelti audaci di default.

## Decisioni prese (fork)

1. **Categorie per scopo** (non per formato): `Pitch & Vendite · CV & Carriera · Report & Update ·
   Catalogo & Marketing`. Deck e documenti si mescolano per scopo (ogni pack dichiara una
   `category`). Le vecchie tab All/Presentations/Documents + source tabs spariscono.
2. **Brand chip nell'header + drawer laterale**: chip (org + 3 pallini + logo) → drawer da destra
   col form completo → "Salva" chiude. Canvas pulito, brand a un tap.
3. **Massimo impatto editoriale**: temi audaci type-driven (stile "SEVERIN HALBE" — tipografia
   forte + colore profondo, pulito, NON decorazione che nuoce alla leggibilità).

## Architettura (in slice)

Un arco in 3 slice indipendenti-ish, ciascuna con proprio piano; questa spec copre S1+S2, S3 in coda.

### Slice 1 — Editorial design system + gallery relayout (il wow)

**Renderer (`deck_render.py` + `doc_render.py` + `design_tokens.py`):**
- **Nuovi temi editoriali** in `THEMES`: `editorial_noir` (bg near-black `#0b0b0d`, testo crema
  `#f4f1ea`, un accento), `editorial_warm` (bg crema `#f4f1ea`, inchiostro `#1a1714`, accento
  terracotta), `editorial_bold` (campo colore saturo full-bleed). I temi esistenti restano.
- **Cover/hero drammatica** (entrambi i renderer): display type grande (4–5rem deck, 3–3.5rem doc),
  **eyebrow** maiuscoletto lettera-spaziato (nuovo campo opzionale `eyebrow` su cover/section_cover),
  regola d'accento, whitespace generoso, opzione **campo colore full-bleed** vs immagine.
- **Art procedurale** (nuovo blocco/opzione `hero_art`: `gradient|grid|rings|none`) — SVG inline
  generato dal codice (gradienti/pattern), **zero immagini esterne** → license-clean, local,
  nessun asset binario nei pack oltre le preview già committate.
- Scala tipografica e label uppercase-spaziate applicate ai blocchi esistenti dove serve
  (eyebrow su section headers, KPI label spaziate). Behavior-preserving sui campi esistenti.
- QA (`deck_qa --mode document`) invariata: i temi scuri devono passare il check contrasto → il
  contrasto crema-su-nero è alto, ok; validare che `editorial_noir` non triggeri `low_contrast`
  (e sistemare il pre-esistente falso-positivo su gradient se emerge — già in backlog).

**Pack (`templates/*/manifest.json` + `example.json`):** ogni pack dichiara `category` (una delle
4) e adotta un **default editoriale audace** coerente col suo uso; gli `example.json` ottengono
`eyebrow`/`hero_art` dove alzano l'impatto. **Preview rigenerate e ricommittate** (le PNG/HTML sono
la vetrina) — ispezione visiva umana obbligatoria per pack (come F1/F2).

**UI (`BrandKitPanel.tsx` — splittare; oltre 800 righe):**
- **Brand rail → chip + drawer**: nuovo `BrandChip` (header) + `BrandDrawer` (form estratto dal
  rail attuale, invariato nei campi/salvataggio). Il canvas diventa la sola gallery.
- **Catalogo full-width** con **tab per scopo** (4 categorie, guidate da `entry.category`; fallback
  "Altro" se un pack non la dichiara). Rimosse le tab formato + source tabs.
- **Card editoriali**: `TemplateLivePreview` full-bleed + scrim gradiente in basso + titolo/badge
  kind in overlay (meno chrome). Hover-cycling e brand-recolor-live invariati (già in F3).
- **Source directory** → voce compatta "Importa da…" accanto a Import PPTX (non più card nel
  flusso). Import PPTX invariato.
- Split file: `BrandChip.tsx`, `BrandDrawer.tsx`, `TemplateGallery.tsx`, `TemplateCard.tsx` da
  `BrandKitPanel.tsx` (che diventa il comporre-insieme). Riduce il file oltre-limite.

**Backend (`main.rs`):** `category: String` su `TemplateCatalogEntry` + response, parsato dal
manifest (`clean_template_catalog_id`, whitelist 4 valori + `other`). Nessun'altra logica.

### Slice 2 — Brief ottimizzato ("Use template" da compito a brief guidato)

- Il prompt operativo di `handleStartTemplateWorkflow` (App.tsx) si asciuga: via il preamble
  "Template Analysis" verboso; intake come **brief compatto** (le `intake_questions` presentate
  come campi/chip in un pannello inline leggero, non un elenco numerato in chat), poi piano →
  genera con anteprima. Prompt del modello ottimizzato: meno meta-narrazione, più "produci il
  deliverable + mostra l'anteprima".
- Dettaglio di UX (form vs primo turno) da definire nel piano S2; il contratto backend
  (`make_deck`/`make_document` con `template_ref`) resta invariato.

### Slice 3 — Font picker (Google Fonts self-hosted) — CODA

- Input font libero → picker curato di ~12 Google Fonts **bundled woff2 nel repo** (zero fetch a
  runtime = local-first/deny-by-default preservati). I woff2 inline nell'HTML del renderer (come i
  loghi). Slice a sé: richiede vendoring font + licenze (OFL) + UI picker.

## Esclusioni (YAGNI)

Niente immagini stock/esterne (art procedurale al loro posto); niente marketplace; import PPTX
invariato; nessun editor di template; S3 (font) esplicitamente in coda.

## Rischi e mitigazioni

- **Temi scuri vs QA contrasto**: crema-su-near-black è alto contrasto → ok; validare per tema.
- **Preview = verità**: i default audaci sono temi reali del pack; nessuna anteprima diverge dal
  generato. Test: il tema mostrato nella preview == `design_theme` del manifest.
- **File UI oltre-limite**: lo split è parte della slice, non rimandato.
- **Editorial ≠ illeggibile**: i temi editoriali restano usabili (un CV generato dev'essere
  spedibile) — impatto = tipografia+colore+whitespace, non decorazione.

## Fasi/slice per i piani

- **S1** (questa, il grosso): design system editoriale + relayout gallery + preview rigenerate.
- **S2**: brief ottimizzato.
- **S3**: font picker (coda).
