# Presentations professionale — template pack reali, renderer documenti, catalogo Z.ai-style

Data: 2026-07-15 · Stato: **Approvata da Fabio** (approccio B + set PMI da 8, sezioni 1–4 approvate)

## Contesto e diagnosi

La pagina Presentations oggi "sembra un gioco" per una causa radice sola: **il catalogo
promette design che la pipeline non rende**.

- Gli 11 template built-in (`local_template_catalog_seed`, `main.rs`) sono metadati hardcoded
  in Rust **senza asset**: le card disegnano blocchetti CSS sintetici, non un'anteprima reale.
- "Usare un template" built-in cambia solo i default `design_*` di `make_deck`: l'output è
  sempre il layout sintetico di Homun, qualunque card si scelga.
- I 6 template `kind:"document"` non hanno alcun percorso di design: `make_document` produce
  markdown → DOCX/PDF senza layout.
- Anche per i PPTX importati, l'HTML/PDF mostrato è il render sintetico, non il template vero.

Riferimento (Z.ai): ogni card mostra un render reale di ciò che ottieni. La cura non è "card
più belle" ma **preview = verità**: le anteprime si generano dal renderer stesso (WYSIWYG per
costruzione). Coerente col caposaldo "un solo design system dichiarativo per i deliverable".

## Obiettivo e criteri di successo

Estensione **professionale per aziende (PMI)** con effetto wow onesto:

1. Il catalogo mostra **8 template reali** con anteprime renderizzate dalla pipeline vera.
2. Cambiare il brand kit **ricolora live tutte le card** (colori + logo).
3. Generare un deliverable da template produce un output **che corrisponde all'anteprima**
   (PDF di design + PPTX/DOCX editabile).
4. CV, lettera di presentazione e catalogo prodotti sono tipi di prima classe.
5. Gate verdi: `cargo test`, `ui-contract`, `build`, `pre_release_gate.py`.

## Decisioni prese

- **Approccio B** (fix radice) — scartati A "solo restyle" (le preview continuerebbero a
  mentire) e C "template HTML puri" (degrada il PPTX editabile, secondo design system).
- **Set PMI da 8**: Pitch deck · Executive update · CV professionale · Lettera di
  presentazione · Catalogo prodotti · Proposta commerciale · One-pager aziendale ·
  Case study cliente. (2 presentation + 6 document.)
- L'import PPTX resta invariato (utile, non è il focus).

## Sezione 1 — Architettura: template pack bundled

**Convergenza sul formato pack** già usato dagli import: gli 8 template v1 diventano
directory spedite con l'app (`app/templates/<slug>/`), lette da un
`BundledTemplatePackProvider` che riusa la shape di `ImportedTemplatePackProvider`.
Il seed hardcoded `local_template_catalog_seed` (11 entry) **si cancella** — converge,
don't duplicate: restano pack-dir (bundled + importati) e il JSON opzionale.

Contenuto di ogni pack:

```
templates/<slug>/
  manifest.json      # vedi schema sotto
  example.json       # contenuto d'esempio curato a mano (fittizio ma credibile)
  preview/
    example.html     # HTML self-contained renderizzato dalla pipeline (brand-parametrico)
    page-00N.png     # raster per fallback/velocità, committate nel repo
  fonts/*.woff2      # se il tema usa font non di sistema (inlined nell'HTML)
```

`manifest.json` (campi chiave):

```json
{
  "id": "homun/cv-professional-01",
  "kind": "document",
  "name":        { "en": "…", "it": "…" },
  "description": { "en": "…", "it": "…" },
  "tags": ["…"], "use_cases": ["…"], "audience": ["…"],
  "design_template": "…", "design_theme": "…", "design_profile": "…",
  "layouts": ["contact_header", "experience_timeline", "skill_tags"],
  "intake_questions": { "en": ["…"], "it": ["…"] },
  "content_schema": { "…": "JSON Schema degli slot che il modello riempie" },
  "preview": { "html": "preview/example.html", "pages": ["preview/page-001.png"] }
}
```

- **Sorgente "Homun"**: i pack bundled hanno prefisso id `homun/` e popolano il filtro
  sorgente "Homun" già presente in UI (gli importati restano "Local").
- **Percorso a runtime**: il gateway riceve la directory dei pack bundled via env
  (`HOMUN_BUNDLED_TEMPLATES_DIR`) impostata da Electron (resources dir); in dev punta a
  `app/templates/`.
- **Preview generate dalla pipeline**: `scripts/build_template_previews.py` renderizza
  `example.json` di ogni pack col renderer reale (deck-render / doc-render) → HTML +
  screenshot PNG via Chromium headless. Le PNG si committano (build app veloce e
  deterministica); lo script si rilancia quando un design cambia.
- I nomi/descrizioni localizzati (IT+EN) viaggiano nel manifest; la risposta catalogo
  espone la lingua richiesta con fallback EN.

## Sezione 2 — Renderer: documenti di prima classe

**Deck** (Pitch, Executive update): resta `deck_render.py`; si aggiungono i layout fisici
mancanti (`timeline`, `comparison`, `team_grid`) e si **allinea il vocabolario**: le
`layout_archetypes` del catalogo diventano i nomi dei layout reali del renderer (oggi sono
stringhe decorative — mismatch rilevato in audit). PPTX nativo editabile invariato
(python-pptx), PDF via Chromium invariato.

**Documenti**: nasce `doc_render.py` accanto a `deck_render.py`, con modulo condiviso di
token/temi (`design_tokens.py`: gli stessi 5 `design_theme`, palette/spaziature/coppie
tipografiche curate). Input `doc.json` a blocchi tipizzati; output:

- **HTML self-contained** (anteprima + base di stampa, brand via CSS var);
- **PDF via Chromium print** (pipeline già esistente per i deck) — formato di fedeltà;
- **DOCX editabile**: si estende il writer OOXML Rust esistente (`markdown_to_docx`) con
  un ingresso strutturale `doc_json_to_docx` (heading, paragrafi, tabelle, colori) —
  best-effort dichiarato: la fedeltà visiva è del PDF, il DOCX è per l'editing.

Blocchi documento v1 (dettati dagli 8 template, non speculativi): `contact_header`,
`profile_summary`, `experience_timeline`, `education_list`, `skill_tags`, `letterhead`,
`letter_body`, `signature_block`, `product_grid` (immagine/nome/descrizione/prezzo),
`pricing_table`, `spec_table`, `kpi_band`, `testimonial_quote`, `section_cover`,
`cta_footer`.

**Contenuto schema-enforced**: ogni pack dichiara il suo `content_schema`; il modello
riempie gli slot con la stessa meccanica di `deck_content_schema` (caposaldo: "il modello
riempie slot vincolati, il controllo sta nel codice").

**QA**: `deck-qa` si estende ai documenti (overflow, contrasto, immagini caricate, numero
pagine atteso); soglie bloccanti come per i deck.

## Sezione 3 — UI catalogo: Z.ai-style con brand kit live

`BrandKitPanel.tsx` (817 righe) si **splitta per responsabilità** (BrandKitRail,
TemplateCatalog, TemplateCard, TemplateDetailModal) e si ridisegna:

- **Card grandi con anteprima reale**: l'`example.html` del pack embeddato in iframe
  sandboxed scalato (lazy via IntersectionObserver). Niente più blocchetti CSS sintetici.
- **Brand kit live**: l'HTML di preview usa `--brand-primary/--brand-secondary/--brand-accent`
  + slot logo; la UI inietta le variabili e il logo (srcdoc con blocco `:root{…}`) → al
  salvataggio (e alla modifica) del brand kit **tutte le card si ricolorano all'istante**.
  È l'effetto wow principale e costa poco perché l'HTML è parametrico by-design.
- **Hover = pagine che scorrono**: in hover la card cicla le pagine dell'esempio.
- **Modal dettaglio**: sfoglia le pagine a grandezza piena col brand applicato, mostra le
  `intake_questions` e CTA "Crea con i tuoi contenuti" (→ flusso chat esistente).
- Pack importati: restano su thumbnail raster statiche. Le card "Template sources"
  restano ma ridimensionate (non più protagoniste).

## Sezione 4 — Integrazione agente, QA, test

- **`make_document` guadagna `template_ref`** (parità con `make_deck`): risolve il pack,
  vincola la generazione al `content_schema`, instrada al renderer giusto.
- **"Use template"** resta il seed-prompt in chat (pattern valido), ma le domande operative
  vengono dalle `intake_questions` del manifest — specifiche per tipo (CV: "per chi?
  ruolo target?").
- **Test gated bottom-up** (ogni fase porta i suoi):
  - renderer: golden test per layout/blocco (HTML strutturale) + QA thresholds;
  - Rust: discovery/parse dei pack bundled, catalogo senza seed (8 entry `homun/`),
    risoluzione `template_ref` per `make_document`, `doc_json_to_docx`;
  - UI: `test:ui-contract` aggiornato al nuovo catalogo;
  - gate finale: `pre_release_gate.py` ALL GREEN.

## Il set v1 (8 pack)

La colonna "Struttura" elenca le **sezioni dell'esempio/content_schema**; i layout fisici
che le rendono sono quelli di Sezione 2 (una sezione "problem" usa p.es. il layout fisico
`bullets` o `two_column` — la corrispondenza sezione→layout vive nel pack, non nel renderer).

| Pack | Kind | Struttura (sezioni esempio) | Tema |
| --- | --- | --- | --- |
| Pitch deck | presentation | cover, problem, solution, kpi, market, team (team_grid), roadmap (timeline), ask, closing | clean_corporate |
| Executive update | presentation | cover, kpi, highlights, risks (comparison), decisions, next steps | high_contrast |
| CV professionale | document (1–2 pag.) | contact_header, profile_summary, experience_timeline, education_list, skill_tags | minimal_mono |
| Lettera di presentazione | document (1 pag.) | letterhead, letter_body, signature_block | minimal_mono (coppia col CV) |
| Catalogo prodotti | document (N pag.) | section_cover, product_grid, spec_table, cta_footer | warm_editorial |
| Proposta commerciale | document | section_cover, testo, pricing_table, timeline, signature_block | clean_corporate |
| One-pager aziendale | document (1 pag.) | hero/letterhead, kpi_band, servizi, cta_footer | soft_gradient |
| Case study cliente | document | section_cover, sfida/soluzione, kpi_band, testimonial_quote, cta_footer | warm_editorial |

CV + Lettera condividono il tema di proposito: coppia coordinata, credibile in contesto
candidatura/gara.

## Fasi (per il piano di implementazione)

1. **F1 — Fondamenta pack + deck**: formato pack, `BundledTemplatePackProvider`,
   cancellazione seed, `build_template_previews.py`, i 2 pack presentazione con esempi
   curati, catalogo UI con anteprime HTML reali (statiche).
2. **F2 — Documenti**: `doc_render.py` + `design_tokens.py`, i 6 pack documento,
   `make_document.template_ref` + content schema, `doc_json_to_docx`, QA documenti.
3. **F3 — Wow layer**: brand kit live sulle card, hover page-cycling, modal dettaglio,
   demozione card sorgenti, rifinitura.

## Esclusioni (YAGNI)

Niente marketplace/download remoto di pack; niente integrazione API delle sorgenti esterne;
niente cloning `.dotx` per documenti; import PPTX invariato; nessun editor visuale di
template; `network_access`/deploy fuori scope.

## Rischi e mitigazioni

- **Font nel sandbox Chromium**: woff2 inline nell'HTML (nessuna installazione host).
- **Fedeltà python-pptx sui layout nuovi**: parità "strutturale" non pixel-perfect; il
  PDF è il formato di fedeltà, QA blocca i casi degeneri.
- **Performance iframe (8 card)**: lazy render + scala ridotta + `srcdoc` statico.
- **Aspettative DOCX**: dichiarato best-effort in UI/descrizione tool (editing, non fedeltà).
