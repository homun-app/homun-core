# Presentations S1c — Polish minimal (card senza box, header fisso, solo griglia scrolla): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans. Steps use checkbox syntax.

**Goal:** Rendere la gallery più pulita/minimal: togliere il contenitore-box intorno alle card (anteprima incorniciata + titolo come caption sotto, niente scrim scuro pesante), e fissare header+filtri lasciando scrollare **solo** la griglia dei template.

**Architecture:** UI-only (React/TS/CSS). Feedback diretto di Fabio a schermo. Nessun backend/renderer.

## Global Constraints
- Feedback Fabio (verbatim): "toglierei il contenitore intorno alle schede, lascerei tutto più pulito e minimal, con fixed la parte di scelta del brandkit + i filtri e poi facciamo scrollare solo i temi".
- **Behavior-preserving** su use/import/delete/preview/recolor/hover-cycling: cambia SOLO l'estetica (chrome card) e il layout di scroll. Il click sull'anteprima apre il modal; hover rivela "Use template"; recolor F3 + dark-guard invariati; il guard concorrenza `anyBusy` resta.
- Commit su `main`, NIENTE Co-Authored-By, NIENTE push. Commenti in inglese.
- ⚠️ ui-contract lock su `brandPreviewOverride`/`DARK_SURFACE_THEMES`/`entry.category`/`TemplateLivePreview` in TemplateCard/TemplateGallery/presentationsShared: se sposti stringhe, mantieni i lock validi.
- Gate: `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron`; a chiusura `cargo test -p local-first-desktop-gateway` + `pre_release_gate.py` (nessun file Rust/Python toccato → verdi).

---

### Task 1: Card minimal (no box) + header fisso / scroll-solo-griglia

**Files:**
- Modify: `apps/desktop/src/components/TemplateCard.tsx` (struttura card: anteprima + caption sotto, azioni in hover)
- Modify: `apps/desktop/src/components/TemplateGallery.tsx` (wrapper scrollabile attorno alla grid)
- Modify: `apps/desktop/src/styles.css` (`.tcard*`, `.template-gallery*`, `.presentation-studio-v2`)

**Interfaces:** consuma tutto l'esistente; nessuna nuova prop dati.

- [ ] **Step 1: Card — da box+scrim a preview-incorniciata + caption sotto.** In `TemplateCard.tsx`:
  - `<article className="tcard">` NON è più il box (niente border/bg/shadow): è un contenitore flex-column trasparente.
  - `<button className="tcard-preview">` mantiene l'anteprima (`TemplateCardPreview`) ma diventa lui il riquadro incorniciato (aspect-ratio per kind, `border-radius`, hairline sottile o ombra leggera, `overflow:hidden`). Click → apre il modal (invariato).
  - **Rimuovi `.tcard-scrim`** (il gradiente scuro pesante + titolo bianco). Sostituisci con:
    - un overlay hover leggero sull'anteprima con SOLO le azioni: `<div className="tcard-hover-actions">` (Use / Remove) che appare in hover/focus-within (translucido, non un gradiente pieno).
    - una **caption sotto l'anteprima**: `<div className="tcard-caption">` con `<h4>{templateDisplayName}</h4>` (testo ink, non bianco) + `<span className="tcard-badge">{kind==='presentation'?'PPTX':'DOCX'}</span>`, sempre visibile, minimale.
  - Il `TemplateImportingCard` (pending) va adeguato alla stessa struttura (preview shimmer + caption sotto), niente scrim.
  - ⚠️ Le azioni Use/Remove mantengono `disabled={disabled || starting || deleting}` (guard globale `anyBusy` — invariato) e le stesse callback.

- [ ] **Step 2: CSS card minimal.** In styles.css:
  - `.tcard`: rimuovi `border`/`background`/`box-shadow`/`aspect-ratio`; diventa `display:flex; flex-direction:column; gap:8px; background:transparent`. Sposta l'`aspect-ratio` (16/9 deck, 3/2 doc) su `.tcard-preview`.
  - `.tcard-preview`: `position:relative` (non più `absolute inset:0`), `aspect-ratio` per kind (via `.tcard.doc .tcard-preview{aspect-ratio:3/2}`), `border-radius:12px`, `overflow:hidden`, una cornice leggera (`box-shadow:0 1px 2px rgba(15,23,42,.06), 0 8px 24px rgba(15,23,42,.06)` + `1px solid var(--line)`), hover: leggero lift/ombra. Il contenuto preview resta `width/height:100%`.
  - Rimuovi le regole `.tcard-scrim`, `.tcard-title-row` (spostate in caption). Aggiungi:
    - `.tcard-caption{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 2px}` con `h4{font-size:13px;color:var(--text)?;margin:0;font-weight:600}` e `.tcard-badge` ridisegnato **chiaro/minimal** (non più bianco-su-scuro): `border:1px solid var(--line);background:var(--surface-muted);color:var(--text-dim);border-radius:6px;padding:2px 6px;font-size:9px`.
    - `.tcard-hover-actions{position:absolute;left:0;right:0;bottom:0;display:flex;gap:6px;padding:10px;opacity:0;transition:opacity 140ms;background:linear-gradient(to top,rgba(9,11,15,.55),transparent);pointer-events:none}` e `.tcard-preview:hover .tcard-hover-actions,.tcard-preview:focus-within .tcard-hover-actions{opacity:1;pointer-events:auto}` (overlay leggero SOLO in hover — non permanente). Le action button restano leggibili (testo bianco su questo overlay leggero). ⚠️ le azioni sono dentro `.tcard-preview` ma NON devono attivare il click "apri modal" del button preview: rendi `.tcard-preview` un `<div>` con un inner `<button className="tcard-open">` che copre l'anteprima per il click-apri, e le azioni sopra (z-index) — OPPURE tieni il button preview e metti le azioni come sibling assoluto fuori dal button ma dentro un wrapper `.tcard-frame` relativo. Scegli la struttura che evita il nesting di `<button>` dentro `<button>` (invalido). Suggerito: `.tcard-frame` (relative) contiene `<button className="tcard-open">`(preview) + `<div className="tcard-hover-actions">`(azioni, sibling). La caption resta fuori dal frame, sotto.
  - Bit-check: nessun `<button>` dentro `<button>` (React/HTML invalido).

- [ ] **Step 3: Header fisso + scroll-solo-griglia.** In styles.css + TemplateGallery.tsx:
  - `.presentations-panel.presentation-studio-v2`: `display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden` (il pannello riempie l'area contenuto — verifica la catena altezza col genitore che monta il plugin; se il genitore non dà altezza, usa `height:100%` fino alla radice del pannello plugin).
  - `.presentation-template-workspace.template-gallery`: `display:flex; flex-direction:column; min-height:0; flex:1`.
  - Header (`.template-gallery-header`) + toolbar (`.template-gallery-toolbar`) + eventuale source directory: `flex:none` (restano fissi in cima).
  - Avvolgi la griglia in un contenitore scrollabile: in TemplateGallery.tsx, metti `<div className="template-gallery-scroll">` attorno all'empty-state + `.template-gallery-grid`; CSS: `.template-gallery-scroll{flex:1;min-height:0;overflow-y:auto;padding-right:4px}`. Solo questo scrolla.
  - Il drawer brand (fixed overlay) e il modal (fixed) restano invariati.

- [ ] **Step 4: gate** — `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron` verdi. Aggiorna i lock ui-contract se una stringa lockata è cambiata di file/nome.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/TemplateCard.tsx apps/desktop/src/components/TemplateGallery.tsx apps/desktop/src/styles.css apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(presentations): minimal cards (no container, caption below), fixed header, scroll-only grid"
```

---

### Task 2: gate completi + STATO

**Files:** Modify `docs/STATO.md`

- [ ] **Step 1: gate** — build + ui-contract + electron · `cargo test -p local-first-desktop-gateway` · `pre_release_gate.py` → ALL GREEN.
- [ ] **Step 2: STATO** — checkpoint S1c (IT, conciso, data): polish minimal (card senza box-contenitore → anteprima incorniciata + caption sotto, scrim scuro rimosso, azioni in hover leggero; header/filtri fissi, solo griglia scrolla). Cosa resta invariato = S2 brief, S3 font.
- [ ] **Step 3: Commit** — `docs: STATO checkpoint — Presentations S1c (minimal polish) shipped`

## Note
- **Behavior-preserving** su tutta la logica; solo estetica card + scroll layout.
- S2/S3 fuori scope.
