# Presentations S1b — Gallery relayout (brand chip+drawer, tab per scopo, card full-bleed): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La pagina Presentations diventa gallery-first: il brand kit passa da rail permanente a **chip nell'header + drawer** (set-once, non occupa più la colonna), il catalogo è full-width con **tab per scopo**, le card sono **full-bleed** con titolo in overlay, e `BrandKitPanel.tsx` (965 righe) si splitta per responsabilità.

**Architecture:** Tutto UI (React/TS/CSS), zero backend. La sola dipendenza dati è `entry.category` (già sul backend, S1a-T4). `BrandKitPanel` resta il compositore che tiene lo stato `kit` (lift-up già presente per il recolor F3) e orchestra: `<BrandChip>` + `<BrandDrawer>` (form estratto) + `<TemplateGallery>` (full-width, tab per scopo, `<TemplateCard>` full-bleed). Il recolor live (F3) e le preview live (TemplateLivePreview) restano invariati, spostati nei nuovi file.

**Tech Stack:** React 19 + TS + Vite + i18next + lucide-react; CSS in styles.css. Nessuna libreria nuova.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-presentations-studio-editorial-redesign-design.md` Sezione 3 (approvata).
- Commit su `main`, NIENTE Co-Authored-By, NIENTE push. Commenti in inglese (il perché).
- **Behavior-preserving sul brand kit**: stessi campi, stesso load/save (`coreBridge.brandKit()`/`saveBrandKit`), stesso rasterizzatore logo, stesso recolor `brandPreviewOverride`. Cambia SOLO la disposizione (rail → chip+drawer).
- **File split obbligatorio** (BrandKitPanel è 965 righe, oltre il soft-limit ~1500 ma il pezzo è già ingombrante e lo stiamo ristrutturando): nuovi file `BrandChip.tsx`, `BrandDrawer.tsx`, `TemplateGallery.tsx`, `TemplateCard.tsx`; `BrandKitPanel.tsx` resta il compositore magro. Sposta gli helper puri dove servono (`safeColor`/`safeFont`/`brandPreviewOverride`/`templateDisplayName`/`templateDisplayDescription` in un `presentationsShared.ts` o co-locati col consumatore).
- **Tab per scopo** (le 4 categorie da `entry.category` + fallback): `pitch_sales`→"Pitch & Vendite", `cv_career`→"CV & Carriera", `report_update`→"Report & Update", `catalog_marketing`→"Catalogo & Marketing", `other`→"Altro". Chiavi i18n in `src/plugins/presentations/locales/{en,it}.json`. Sostituiscono le tab formato (All/Presentations/Documents) e le source tabs.
- **Import PPTX + i pack importati** restano funzionanti (source filter Local/Homun può restare come sub-filtro o sparire — vedi T3).
- **Recolor su surface scuri (S1a deferral #5)**: il recolor NON deve iniettarsi sui pack a surface scuro (editorial_noir/bold) — un brand scuro renderebbe accenti invisibili. Guard in T4.
- ⚠️ `ui-contract` (`apps/desktop/scripts/check-ui-contract.mjs`) ha lock su stringhe in `BrandKitPanel.tsx` (`brandPreviewOverride`, `templateThemeClass`-absent, `make_document`, `builtin:template-preview`-absent). Quando sposti codice tra file, **aggiorna i path nei lock** così restano validi (il lock su `brandPreviewOverride` deve puntare al file dove finisce).
- Gate: `npm run build` (tsc), `npm run test:ui-contract`, `npm run test:electron`; a chiusura `cargo test -p local-first-desktop-gateway` + `pre_release_gate.py` (nessun file Rust/Python toccato → verdi per definizione, il run finale lo prova).

## Struttura file target

- `BrandKitPanel.tsx` — compositore: stato `kit` + `drawerOpen`; rende `<TemplateGallery brandKit chipSlot={<BrandChip .../>} onEditBrand=... />` e `<BrandDrawer open kit onChange onSave onClose />`.
- `BrandChip.tsx` — chip compatto (org + 3 pallini colore + logo mini) → `onClick` apre il drawer.
- `BrandDrawer.tsx` — il form brand (i campi/preview/save di oggi), in un pannello slide-in da destra + scrim.
- `TemplateGallery.tsx` — header (titolo + chip slot + Import PPTX), **tab per scopo**, search, griglia, empty-state, detail modal, import/delete/use logic.
- `TemplateCard.tsx` — la card full-bleed (preview + scrim + titolo/badge overlay + Use/Remove).
- `presentationsShared.ts` — helper puri condivisi (`brandPreviewOverride`, `safeColor`, `safeFont`, `templateDisplayName`, `templateDisplayDescription`, `DARK_SURFACE_THEMES`, `TEMPLATE_CATEGORY_ORDER`).

---

### Task 1: coreBridge category type + config categorie

**Files:**
- Modify: `apps/desktop/src/lib/coreBridge.ts` (interface `TemplateCatalogEntry`)
- Create: `apps/desktop/src/components/presentationsShared.ts`
- Modify: `apps/desktop/src/plugins/presentations/locales/en.json` + `it.json`

**Interfaces:**
- Produces: `TemplateCatalogEntry.category: string` (TS); `presentationsShared.ts` esporta `TEMPLATE_CATEGORY_ORDER: readonly string[]` = `["pitch_sales","cv_career","report_update","catalog_marketing","other"]`, `categoryLabelKey(category: string): string` (→ i18n key), e `DARK_SURFACE_THEMES = new Set(["editorial_noir","editorial_bold"])`.

- [ ] **Step 1: coreBridge type.** Verifica se `TemplateCatalogEntry` (in coreBridge.ts) ha già `category` (grep `interface TemplateCatalogEntry`). Se manca, aggiungi `category: string;` dopo `kind`. (S1a-T4 aggiunse il campo backend; il tipo TS potrebbe non rispecchiarlo.)

- [ ] **Step 2: presentationsShared.ts** — crea il file con gli export sopra:

```ts
// Shared, side-effect-free helpers for the Presentations studio surface.
// Extracted so BrandChip / BrandDrawer / TemplateGallery / TemplateCard can
// each stay focused without a circular import through BrandKitPanel.

export const TEMPLATE_CATEGORY_ORDER = [
  "pitch_sales",
  "cv_career",
  "report_update",
  "catalog_marketing",
  "other",
] as const;

export function categoryLabelKey(category: string): string {
  const known = (TEMPLATE_CATEGORY_ORDER as readonly string[]).includes(category);
  return `presentations:category_${known ? category : "other"}`;
}

// Editorial themes whose SURFACE is dark. The live brand recolor only overrides
// --brand/--accent (not --surface), so a dark user brand on a dark surface makes
// accents/eyebrows/KPI vanish — skip recolor for these packs (see brandPreviewOverride caller).
export const DARK_SURFACE_THEMES = new Set(["editorial_noir", "editorial_bold"]);
```

- [ ] **Step 3: i18n** — aggiungi in `en.json` e `it.json` le 5 chiavi `category_pitch_sales`/`category_cv_career`/`category_report_update`/`category_catalog_marketing`/`category_other`:
  - en: "Pitch & Sales" / "CV & Career" / "Reports & Updates" / "Catalog & Marketing" / "Other"
  - it: "Pitch & Vendite" / "CV & Carriera" / "Report & Update" / "Catalogo & Marketing" / "Altro"

- [ ] **Step 4: build** — `cd apps/desktop && npm run build` → tsc verde.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/coreBridge.ts apps/desktop/src/components/presentationsShared.ts apps/desktop/src/plugins/presentations/locales
git commit -m "feat(presentations): category type + shared config for the gallery relayout"
```

---

### Task 2: Brand chip + drawer (dismetti il rail permanente)

**Files:**
- Create: `apps/desktop/src/components/BrandChip.tsx`, `apps/desktop/src/components/BrandDrawer.tsx`
- Modify: `apps/desktop/src/components/BrandKitPanel.tsx` (compositore), `apps/desktop/src/styles.css`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs` (path lock se `brandPreviewOverride` si sposta)

**Interfaces:**
- Consumes: `coreBridge.brandKit()`/`saveBrandKit`, il rasterizzatore `onLogo` esistente, lo stato `kit`.
- Produces: `<BrandChip kit onEdit />` (org + 3 pallini + logo mini, `onEdit` apre); `<BrandDrawer open kit onChange onSave saving saved onClose />` (form estratto: gli stessi campi/preview/save di oggi, in un pannello slide-in da destra + scrim, `Esc`/scrim-click chiude). `BrandKitPanel` tiene `kit` + `drawerOpen`, non rende più il rail.

- [ ] **Step 1: Estrai il form in `BrandDrawer.tsx`.** Sposta il markup del form (BrandKitPanel righe ~169-251: `.brandkit-grid` + `.brandkit-preview` + `.brandkit-actions`) e l'handler `onLogo` dentro `BrandDrawer`. Firma:

```tsx
export function BrandDrawer({ open, kit, onChange, onSave, saving, saved, onClose }: {
  open: boolean;
  kit: BrandKit;
  onChange: <K extends keyof BrandKit>(key: K, value: BrandKit[K]) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  onClose: () => void;
}) { /* scrim + aside.brand-drawer with the form; Esc + scrim click → onClose */ }
```
Il pannello: `<div className="brand-drawer-scrim" onClick={onClose} />` + `<aside className="brand-drawer" role="dialog" aria-modal="true">` con header ("Brand kit" + × ) + il form + "Salva". Usa `useEffect` per l'Escape key.

- [ ] **Step 2: `BrandChip.tsx`**:

```tsx
export function BrandChip({ kit, onEdit }: { kit: BrandKit; onEdit: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="brand-chip" onClick={onEdit}
            title={t("presentations:editBrand")}>
      {kit.logo_data_url
        ? <img className="brand-chip-logo" src={kit.logo_data_url} alt="" />
        : <span className="brand-chip-mark" style={{ background: kit.primary_color }} />}
      <span className="brand-chip-name">{kit.organization || t("presentations:brandChipFallback")}</span>
      <span className="brand-chip-dots">
        {[kit.primary_color, kit.secondary_color, kit.accent_color].map((c, i) => (
          <i key={i} style={{ background: c }} />
        ))}
      </span>
    </button>
  );
}
```
i18n: `editBrand`="Edit brand kit"/"Modifica brand kit"; `brandChipFallback`="Brand kit".

- [ ] **Step 3: BrandKitPanel compositore.** Riscrivi il `return` di `BrandKitPanel`: niente più `.presentation-brand-rail`. Ora:

```tsx
  return (
    <div className="presentations-panel presentation-studio-v2">
      <TemplateCatalogGallery
        host={host}
        brandKit={kit}
        brandChip={<BrandChip kit={kit} onEdit={() => setDrawerOpen(true)} />}
      />
      <BrandDrawer open={drawerOpen} kit={kit} onChange={set} onSave={() => void save()}
        saving={saving} saved={saved} onClose={() => setDrawerOpen(false)} />
    </div>
  );
```
`TemplateCatalogGallery` guadagna una prop `brandChip: React.ReactNode` che rende nell'header (T3 la posiziona; per ora piazzala nell'header esistente accanto a Import PPTX). Aggiungi `const [drawerOpen, setDrawerOpen] = useState(false);`.

- [ ] **Step 4: CSS** — in styles.css: `.presentation-studio-v2` (blocco, non più flex-row rail+gallery); `.brand-chip` (pill compatta: logo/mark + nome + 3 dot, hover); `.brand-drawer-scrim` (fixed inset, backdrop) + `.brand-drawer` (fixed right, slide-in `transform: translateX`, width ~380px, scroll interno) con transizione open/close. Riusa le classi `.brandkit-*` esistenti dentro il drawer (il form è lo stesso). Rimuovi/deprecca `.presentation-brand-rail` se non più usata.

- [ ] **Step 5: ui-contract path.** Se `brandPreviewOverride` è ancora in BrandKitPanel/gallery, il lock regge; se lo sposti in `presentationsShared.ts` (consigliato in T3, non ora), aggiornerai il lock in T3. Per ora verifica `npm run test:ui-contract` verde; se rosso per un path, correggi il lock al file reale.

- [ ] **Step 6: gate + visual** — `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron` verdi. (Verifica visiva a schermo: il rail sparisce, chip nell'header apre il drawer, salvataggio funziona.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/components/BrandChip.tsx apps/desktop/src/components/BrandDrawer.tsx apps/desktop/src/components/BrandKitPanel.tsx apps/desktop/src/styles.css apps/desktop/scripts/check-ui-contract.mjs apps/desktop/src/plugins/presentations/locales
git commit -m "feat(presentations): brand kit is a header chip + slide-in drawer, gallery goes full-width"
```

---

### Task 3: Gallery full-width — tab per scopo + card full-bleed + split

**Files:**
- Create: `apps/desktop/src/components/TemplateCard.tsx`
- Modify: `apps/desktop/src/components/BrandKitPanel.tsx` (estrai `TemplateCatalogGallery` → `TemplateGallery.tsx`? oppure tieni la gallery in BrandKitPanel e estrai solo la card; scegli il taglio che riduce di più il file — se BrandKitPanel resta >600 righe, estrai la gallery in `TemplateGallery.tsx`)
- Modify: `apps/desktop/src/styles.css`, `apps/desktop/scripts/check-ui-contract.mjs`

**Interfaces:**
- Consumes: `TEMPLATE_CATEGORY_ORDER`, `categoryLabelKey` (Task 1), `brandChip` prop (Task 2), `TemplateLivePreview`/`TemplateRasterOrContractPreview` (esistenti, spostali con la card).
- Produces: filtro per **categoria** (`entry.category`) al posto di kind+source tabs; `<TemplateCard entry brandKit onOpen onUse onDelete busy .../>` full-bleed.

- [ ] **Step 1: Tab per scopo.** In `TemplateCatalogGallery`, sostituisci lo stato `filter` (all/presentation/document) e `sourceFilter` con `activeCategory: string | "all"`. Costruisci le tab da `TEMPLATE_CATEGORY_ORDER` MA mostra solo le categorie **presenti** nel catalogo (`const present = new Set(templates.map(t => t.category))`), più una tab "Tutti". `visible = templates.filter(e => (activeCategory === "all" || e.category === activeCategory) && matchesSearch)`. Rimuovi le vecchie tab formato + source tabs dal markup. La search resta.

- [ ] **Step 2: `TemplateCard.tsx`** — estrai la card (oggi `article.template-card` nel map, righe ~450-530 circa) in un componente full-bleed:

```tsx
export function TemplateCard({ entry, brandKit, starting, deleting, onOpen, onUse, onDelete }: {
  entry: TemplateCatalogEntry; brandKit: BrandKit;
  starting: boolean; deleting: boolean;
  onOpen: () => void; onUse: () => void; onDelete: () => void;
}) { /* full-bleed preview + bottom scrim + title/kind badge overlay + hover Use */ }
```
Struttura: `<article className="tcard">` con `<button className="tcard-preview" onClick={onOpen}>` che rende `<TemplateCardPreview entry brandKit />` a piena card, un `<div className="tcard-scrim">` con `<h4>{templateDisplayName(entry,lang)}</h4>` + badge kind (PPTX/DOCX) in overlay, e le azioni Use/Remove che appaiono in hover (o sempre visibili in una barra bassa). Sposta `TemplateCardPreview`/`TemplateLivePreview`/`TemplateRasterOrContractPreview` in TemplateCard.tsx (o in un `TemplatePreview.tsx` condiviso se preferisci). Il modal dettaglio (`TemplateDetailModal`) resta nella gallery.

- [ ] **Step 3: CSS full-bleed.** `.template-gallery-grid` → griglia full-width responsive (`repeat(auto-fill,minmax(320px,1fr))`); `.tcard` (aspect ratio per kind: deck 16/9, doc 3/2 — riusa la logica designWidth), overflow hidden, radius, ombra; `.tcard-preview` occupa tutta la card; `.tcard-scrim` gradiente dal basso + titolo bianco + badge; azioni in hover (`.tcard:hover .tcard-actions`). Il source directory ("Template sources") → rimpicciolito a una riga/voce "Importa da…" accanto a Import PPTX (o dietro un piccolo link), fuori dalla griglia.

- [ ] **Step 4: split file se serve.** Dopo l'estrazione, se `BrandKitPanel.tsx` è ancora >~500 righe, sposta `TemplateCatalogGallery` (+ `TemplateDetailModal`, `TemplateImportingCard`, `TemplateSourceDirectory`, `templateSourceBadges`) in `TemplateGallery.tsx`, e sposta gli helper puri in `presentationsShared.ts`. `BrandKitPanel.tsx` deve restare il compositore magro (<~150 righe). Aggiorna gli `import`.

- [ ] **Step 5: ui-contract.** Aggiorna `check-ui-contract.mjs`: i lock che puntavano a `BrandKitPanel.tsx` per `brandPreviewOverride`/`make_document`/`TemplateLivePreview`/le assenze `templateThemeClass`/`builtin:template-preview` devono puntare al FILE dove ora vive ciascuno (grep dove sono finiti). Aggiungi un lock nuovo: `assertContains` su TemplateGallery/Card per `entry.category` (le tab per scopo devono esistere). `npm run test:ui-contract` verde.

- [ ] **Step 6: gate + visual** — build + ui-contract + electron verdi. Verifica visiva a schermo: griglia full-width, tab per scopo filtrano, card full-bleed con titolo in overlay, hover mostra Use, source cards demote.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/components apps/desktop/src/styles.css apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(presentations): use-case category tabs, full-bleed editorial cards, BrandKitPanel split"
```

---

### Task 4: recolor guard su surface scuri + polish

**Files:**
- Modify: il file dove vive `brandPreviewOverride`/`TemplateLivePreview` (dopo T3, probabilmente `TemplateCard.tsx`/`presentationsShared.ts`), `apps/desktop/scripts/check-ui-contract.mjs`

**Interfaces:**
- Consumes: `DARK_SURFACE_THEMES` (Task 1).
- Produces: il recolor live NON si applica ai pack con `design_theme` in `DARK_SURFACE_THEMES` (accenti invisibili su surface scuro).

- [ ] **Step 1:** dove `TemplateLivePreview` calcola `const override = brandKit ? brandPreviewOverride(brandKit) : null;`, aggiungi il guard sul tema del pack:

```tsx
  // Dark editorial surfaces own their palette; the recolor only swaps --brand/--accent
  // (not --surface), so a dark user brand would make accents vanish. Skip recolor there.
  const allowRecolor = !DARK_SURFACE_THEMES.has(entry.design_theme);
  const override = brandKit && allowRecolor ? brandPreviewOverride(brandKit) : null;
```
(`entry.design_theme` è già sul tipo TS `TemplateCatalogEntry` — verifica; se assente, aggiungilo in coreBridge come Task 1.)

- [ ] **Step 2: test.** Aggiungi un lock ui-contract `assertContains` su `DARK_SURFACE_THEMES` nel file del preview (il guard deve esistere). `npm run build && npm run test:ui-contract && npm run test:electron` verdi.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src apps/desktop/scripts/check-ui-contract.mjs
git commit -m "fix(presentations): skip live brand recolor on dark editorial surfaces"
```

---

### Task 5: gate completi + STATO

**Files:** Modify `docs/STATO.md`

- [ ] **Step 1: gate in ordine** — `cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron && cd ../..` · `cargo test -p local-first-desktop-gateway` · `python3 scripts/pre_release_gate.py` → ALL GREEN.
- [ ] **Step 2: STATO** — checkpoint S1b (IT, conciso, data): gallery-first (brand chip+drawer set-once, catalogo full-width, tab per scopo da `entry.category`, card full-bleed con titolo overlay, source demote, BrandKitPanel splittato), recolor-dark-guard; cosa resta = **S2 brief ottimizzato** (+ eyebrow/hero_art al generato), **S3 font picker**; validazione live a schermo (Fabio).
- [ ] **Step 3: Commit** — `docs: STATO checkpoint — Presentations S1b (gallery relayout) shipped`

## Note di coerenza

- **Behavior-preserving** su brand kit e su preview/recolor: cambia la disposizione, non la logica.
- **Split per responsabilità**: BrandKitPanel da 965 righe → compositore magro + BrandChip/BrandDrawer/TemplateGallery/TemplateCard + shared.
- **S2/S3 fuori scope**: brief ottimizzato + eyebrow/hero_art al generato (S2); font picker (S3).
