# Presentations Fase 3 — Wow layer: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Il brand kit ricolora LIVE tutte le anteprime del catalogo (colori+font+logo), le card sfogliano le pagine in hover, e le card sorgenti esterne vengono demote sotto il catalogo.

**Architecture:** Tutto UI-only in `BrandKitPanel.tsx` + `styles.css`. Il recolor sfrutta il fatto che l'HTML dei renderer è già parametrico (`:root{--brand;--brand2;--accent;--head;--body}`): la UI inietta nel `srcDoc` un blocco `<style>` override + (se c'è) il logo del brand kit come `<img>` assoluto sulla prima pagina. Lo stato `kit` (già live nel form) si passa come prop da `BrandKitPanel` a `TemplateCatalogGallery` → `TemplateLivePreview`. L'hover-cycling è CSS-only: iframe reso più alto (multiple viewport) + keyframes `translateY` sul contenitore in hover — niente script nell'iframe sandboxed (impossibile: `sandbox=""`).

**Tech Stack:** React 19 + TS, CSS. Zero backend.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-presentations-professional-templates-design.md` Sezione 3 (brand live = l'effetto wow principale).
- Commit su `main`, NIENTE Co-Authored-By, NIENTE push. Commenti in inglese (il perché).
- L'iframe resta `sandbox=""` (nessuno script, origine opaca): il recolor è SOLO string-injection nel srcDoc, mai postMessage/DOM access.
- L'override si inietta SOLO quando il brand kit differisce dai default (`DEFAULT_KIT`): un utente senza brand configurato vede i temi curati dei pack, non un catalogo tutto uguale. Il confronto usa i campi colore+font+logo.
- Fallback intatti: pack importati (raster) e contract-preview NON cambiano.
- Gate: `npm run build`, `test:ui-contract`, `test:electron`, e a chiusura `cargo test -p local-first-desktop-gateway` + `pre_release_gate.py` (nessun file Rust/Python toccato → devono restare verdi per definizione; il run finale lo prova).

---

### Task 1: Brand-kit live recolor + hover page-cycling + demozione source cards

**Files:**
- Modify: `apps/desktop/src/components/BrandKitPanel.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs` (un lock)

**Interfaces:**
- Consumes: stato `kit: BrandKit` (BrandKitPanel:74), `TemplateCatalogGallery` (:259), `TemplateLivePreview` (srcDoc a :768, fetch html a :725), `TemplateSourceDirectory` (:440/:539), `DEFAULT_KIT` (:19).
- Produces: `brandPreviewOverride(kit: BrandKit): string | null` (pure, esportabile per test futuri) — ritorna il blocco `<style>` + `<img>` logo da iniettare, o `null` se il kit è ai default; `TemplateLivePreview` accetta prop opzionale `brandKit?: BrandKit`.

- [ ] **Step 1: Prop-drilling dello stato kit**

`BrandKitPanel`: `<TemplateCatalogGallery host={host} brandKit={kit} />`. `TemplateCatalogGallery({ host, brandKit }: { host: PluginHost; brandKit: BrandKit })` la passa a ogni `TemplateCardPreview`/`TemplateLivePreview`/`TemplateDetailModal` (che la inoltra alla sua preview interattiva). `TemplateCardPreview({ entry, brandKit })` → `<TemplateLivePreview entry={entry} brandKit={brandKit} />`. Le firme raster/contract ignorano la prop.

- [ ] **Step 2: `brandPreviewOverride` (pure) + iniezione nel srcDoc**

In BrandKitPanel.tsx, sopra `TemplateLivePreview`:

```tsx
/** Live brand recolor for catalog previews. The renderer HTML is parametric
 *  by design (:root{--brand;--brand2;--accent;--head;--body}) — injecting an
 *  override style into the sandboxed srcDoc recolors every card instantly as
 *  the user edits the brand kit. Returns null when the kit still equals the
 *  defaults: an unconfigured user must see each pack's curated theme, not a
 *  uniformly-recolored catalog. String injection only — the iframe stays
 *  sandbox="" (no scripts, opaque origin), so no postMessage/DOM path exists. */
function brandPreviewOverride(kit: BrandKit): string | null {
  const isDefault =
    kit.primary_color === DEFAULT_KIT.primary_color &&
    kit.secondary_color === DEFAULT_KIT.secondary_color &&
    kit.accent_color === DEFAULT_KIT.accent_color &&
    kit.heading_font === DEFAULT_KIT.heading_font &&
    kit.body_font === DEFAULT_KIT.body_font &&
    !kit.logo_data_url;
  if (isDefault) return null;
  const style =
    `<style>:root{--brand:${kit.primary_color} !important;` +
    `--brand2:${kit.secondary_color} !important;` +
    `--accent:${kit.accent_color} !important;` +
    `--head:'${kit.heading_font.replaceAll("'", "")}' !important;` +
    `--body:'${kit.body_font.replaceAll("'", "")}' !important;}</style>`;
  // data: URL from our own canvas rasterizer — safe to inline; absolute over
  // the first page only (body-anchored), matching where renderers put logos.
  const logo = kit.logo_data_url
    ? `<img src="${kit.logo_data_url}" style="position:absolute;top:26px;right:38px;` +
      `max-height:42px;max-width:170px;z-index:99" alt="">`
    : "";
  return `${style}${logo}`;
}
```

In `TemplateLivePreview` (che ora riceve `brandKit`): il srcDoc diventa

```tsx
  const override = brandKit ? brandPreviewOverride(brandKit) : null;
  const doc = override ? html.replace("</head>", `${override.startsWith("<style>") ? override.split("</style>")[0] + "</style>" : ""}</head>`).replace(/<body([^>]*)>/, (m) => m + (override.includes("<img") ? override.slice(override.indexOf("<img")) : "")) : html;
```

NO — troppo contorto: semplifica. `brandPreviewOverride` ritorni `{ style: string; logo: string } | null` e l'iniezione sia due replace lineari:

```tsx
  const override = brandKit ? brandPreviewOverride(brandKit) : null;
  const srcDoc = override
    ? html
        .replace("</head>", `${override.style}</head>`)
        .replace(/<body([^>]*)>/, `<body$1>${override.logo}`)
    : html;
```

(entrambi i renderer emettono `</head>` e `<body>` letterali — deck_render `_HTML_SHELL`, doc_render `render_html`; se il replace non trova l'anchor l'HTML resta intatto = fail-open). L'iframe usa `srcDoc={srcDoc}`. Deps: il memo/effect NON rifetcha l'HTML al cambio kit (fetch keyed su `preview_html_ref` come oggi) — solo la stringa derivata cambia → recolor istantaneo senza rete.

- [ ] **Step 3: Hover page-cycling (CSS-only)**

`TemplateLivePreview` card-mode: l'iframe è già più alto del viewport visibile (720px finestra su contenuto multi-pagina). Portalo a `height: 2880px` (deck: 4 slide) / `3369px` (doc: 3 pagine A4) — costante `previewHeight = entry.kind === "document" ? 1123 * 3 : 720 * 4`. In CSS:

```css
.template-live-preview:not(.interactive):hover iframe {
  animation: template-preview-cycle 9s ease-in-out infinite;
}
@keyframes template-preview-cycle {
  0%, 14% { }
  22%, 36% { translate: 0 var(--cycle-1); }
  44%, 58% { translate: 0 var(--cycle-2); }
  66%, 80% { translate: 0 var(--cycle-3); }
  88%, 100% { translate: 0 0; }
}
```

⚠️ `translate` compone con il `transform: scale(...)` inline già presente sull'iframe (proprietà CSS separate: `transform` inline + `translate` da animazione NON si sovrascrivono — è il motivo della scelta). Le variabili `--cycle-N` le setta il JSX sul wrapper: per deck `--cycle-1: calc(-720px * var(--pv-scale))` … in pratica più semplice: il wrapper ha `style={{ "--cycle-1": `-${Math.round(720 * scale)}px`, … } as CSSProperties}` con i moltiplicatori per kind (720 o 1123). Pagine oltre la fine (deck con <4 slide) mostrano bianco → accettabile per un'anim di anteprima; niente misura del contenuto (sandbox opaca non lo consente).

- [ ] **Step 4: Demozione source cards**

In `TemplateCatalogGallery`: sposta `<TemplateSourceDirectory />` DOPO il blocco griglia/empty-state (resta prima del modal). In `TemplateSourceDirectory` aggiungi `className="template-source-directory demoted"`; in styles.css:

```css
.template-source-directory.demoted {
  margin-top: 28px;
  opacity: 0.85;
}
.template-source-directory.demoted h4 { font-size: 13px; }
.template-source-directory.demoted .template-source-link { padding: 8px 10px; }
```

(adatta i selettori reali leggendo le regole esistenti di `.template-source-directory`).

- [ ] **Step 5: Lock ui-contract**

In `check-ui-contract.mjs`, accanto ai lock template: `assertContains("src/components/BrandKitPanel.tsx", "brandPreviewOverride", "the brand kit must recolor catalog previews live")`.

- [ ] **Step 6: Gate + verifica**

`cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron` → verdi.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/components/BrandKitPanel.tsx apps/desktop/src/styles.css apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(presentations): live brand recolor on previews, hover page-cycling, source cards demoted"
```

---

### Task 2: Gate completi + STATO + chiusura arco

**Files:**
- Modify: `docs/STATO.md`

- [ ] **Step 1: Gate completi** — `cargo test -p local-first-desktop-gateway` · unittest deck/doc renderer · `npm run build`+`test:ui-contract`+`test:electron` · `pre_release_gate.py` → ALL GREEN.
- [ ] **Step 2: STATO** — checkpoint F3 (conciso: F3 = ultima fase dell'arco Presentations; cosa resta = SOLO validazione live con rebuild immagine `up.sh` + backlog minori già elencati nel checkpoint F2).
- [ ] **Step 3: Commit** — `docs: STATO checkpoint — Presentations F3 (wow layer) shipped, arc complete`
