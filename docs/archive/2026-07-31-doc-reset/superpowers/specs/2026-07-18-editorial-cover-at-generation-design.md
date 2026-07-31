# Editorial cover al generato (Fase 2) — design

Data: 2026-07-18 · Stato: **Design approvato** (fork eyebrow: *default del pack, il modello può raffinarlo*) · Arco: Presentations, ortogonale al routing S2 (già chiuso).

## Problema (l'invariante "preview = verità" si rompe sull'output reale)

Il chrome editoriale — **eyebrow** (kicker maiuscoletto spaziato sopra il titolo) e **hero_art**
(accento SVG procedurale: `rings|grid|gradient|none`) — è **curato nell'`example.json` di ogni
pack** ed è esattamente ciò che l'anteprima della gallery rende. Ma il percorso di **generazione**
(`make_deck`/`make_document`) lo **perde**, in due modi diversi:

- **Documenti** (slot-filling STRICT): `document_content::assemble_doc_json` costruisce ogni blocco
  **solo** dall'output del modello (`filled.clone()`), poi ci innesta `type`. Eyebrow/hero_art dello
  scheletro **non sono slot del modello** (non compaiono in `document_block_schema` per
  `section_cover`/`contact_header`/`letterhead`) → vengono **droppati**. Il generato ha il blocco
  cover senza kicker né arte.
- **Deck** (generazione libera): `generate_deck_content` **non consulta affatto** l'`example.json`;
  il modello emette `{layout,title,bullets,notes,want_image}` (schema `deck_content_schema`), **zero**
  eyebrow/hero_art. La cover generata è nuda.

Verificato nei pack reali: `startup-pitch-clean-01` cover = `eyebrow:"SEED ROUND · 2026"`,
`hero_art:"rings"`; `cv-professional-01` `contact_header` = `eyebrow:"CURRICULUM VITAE"` (no
hero_art, header compatto — voluto); `customer-case-study-01` `section_cover` =
`eyebrow:"CUSTOMER STORY"`, `hero_art:"gradient"`. I **renderer** (`deck_render.py`,
`doc_render.py`) già renderizzano questi campi (costruiti in S1a): il gap è puramente che la
generazione non li **alimenta**.

## Principio (caposaldo)

Eyebrow e hero_art sono **"stato" (chrome curato dal pack), non "contenuto" (slot liberi del
modello)**. Oggi cadono nel vuoto: il modello non li produce, il codice non li porta. La cura non è
farli inventare al modello (decorazione incoerente, e l'anteprima — che usa il default del pack —
smetterebbe di essere verità), ma **portarli deterministicamente dallo stesso `example.json` che
alimenta l'anteprima** → *preview = verità per costruzione*.

Con l'unica eccezione decisa a valle del fork: l'**eyebrow** parte dal default del pack ma è
**raffinabile dal modello** (uno slot vincolato, pre-seminato col default) — così `SEED ROUND · 2026`
può diventare `SERIES A · 2026` quando il brief lo implica. L'**hero_art resta 100% deterministico**
(pura decorazione, il modello non lo tocca mai).

## Architettura

### 1. Documenti — `assemble_doc_json` porta il chrome dello scheletro

`DocBlockSlot` (`document_content.rs`) oggi porta solo `{block_type, slot_key}`. Guadagna il **blocco
scheletro originale** letto da `example.json`:

```rust
pub(crate) struct DocBlockSlot {
    pub(crate) block_type: String,
    pub(crate) slot_key: String,
    pub(crate) template_block: serde_json::Map<String, Value>, // curated example.json block
}
```

`document_block_skeleton` popola `template_block` con il blocco (clonato, senza `type`).
`assemble_doc_json` cambia da "parti dall'output del modello" a **"parti dal blocco curato, sovrapponi
lo slot del modello (model-wins sulle chiavi condivise)"**:

```rust
let mut block = slot.template_block.clone();     // curated chrome: eyebrow, hero_art, …
for (k, v) in filled { block.insert(k.clone(), v.clone()); } // model content wins on shared keys
block.insert("type".to_string(), Value::String(slot.block_type.clone()));
```

Conseguenze deterministiche e generali:
- `hero_art` (chiave **solo-scheletro**, mai nello schema del modello per `additionalProperties:false`)
  **sopravvive** automaticamente. Deterministico, il modello non lo vede.
- Qualsiasi altro campo curato non-slot (futuri) passa senza tocchi. DRY, a prova di futuro.

**Eyebrow raffinabile** (solo per i blocchi che ne hanno uno nello scheletro): `document_content_schema`
post-processa lo schema del blocco — se il `template_block` ha un `eyebrow` non vuoto, **inietta** una
proprietà `eyebrow` (required, `""` ammesso) con descrizione che porta il default:

> "Small-caps kicker sopra il titolo. Default: «CURRICULUM VITAE». Mantienilo, a meno che il brief non
> implichi chiaramente un'etichetta più specifica; usa «» per ometterlo."

Nel merge, il model-wins sovrascriverebbe con `""` se il modello svuota il campo → **guardia
post-merge**: se `eyebrow` risulta vuoto ma lo scheletro ne aveva uno, ripristina il default dello
scheletro. Così il default è garantito, la raffinatura è possibile.

### 2. Deck — `apply_deck_template_chrome` sovrappone il chrome del pack

Simmetrico a `document_template_pack`, un discriminatore `deck_template_pack(entry)` (pack **deck**
bundled con pack root). Nella branch `Ok(mut deck)` di `make_deck` — subito **dopo**
`apply_deck_design_theme` (`main.rs` ~22655) — una funzione **pura**:

```rust
fn apply_deck_template_chrome(deck: &mut Value, example: &Value)
```

Regole deterministiche di overlay (l'`example.json` del pack è la sorgente):
- **Cover** (slide `layout=="cover"`, cioè slide 0 — la prima è forzata a "cover" dal prompt):
  - `hero_art` ← quello della cover del pack (deterministico; il modello non lo produce).
  - `eyebrow`: se il modello ne ha emesso uno non vuoto → **tienilo** (raffinatura); altrimenti ←
    default della cover del pack.
- **Section** (slide `layout=="section"`): `hero_art` ← quello della section del pack (deterministico).
  L'eyebrow di section resta opzionale (default del pack se il pack ne ha uno e il modello non lo dà).

**Eyebrow raffinabile lato deck**: `deck_content_schema` aggiunge al singolo item-slide una proprietà
opzionale `eyebrow` (`""` ammesso; le slide non-cover la lasciano vuota — il renderer la usa solo su
cover/section). Il system-prompt di `generate_deck_content` semina il default della cover del pack:
"L'eyebrow della cover di default è «…»; raffinalo sul brief se un'etichetta più specifica calza."
Il default vive nel prompt/overlay, **non** hardcoded nel renderer.

### 3. Export nativi (PPTX / DOCX) — eyebrow sì, hero_art HTML/PDF-only

L'anteprima on-screen è l'HTML/PDF e combacia al 100% (renderer invariati). Gli export **nativi**
Office sono fedeltà secondaria:
- **Eyebrow (testo)**: portato anche su `render_pptx` (deck_render.py) e `doc_json_to_docx`
  (`main.rs`) — un paragrafo maiuscoletto sopra il titolo della cover.
- **hero_art (SVG procedurale)**: **resta HTML/PDF-only** — non porta al formato nativo Office (niente
  SVG procedurale in PPTX/DOCX). Scoping onesto: il .pptx/.docx nativo prende tema + eyebrow, non
  l'arte SVG. Documentato come caveat, non come regressione.

### 4. Nessuna rigenerazione preview, nessuna modifica ai renderer HTML/PDF

I renderer HTML/PDF già leggono `eyebrow`/`hero_art` e le preview committate (rese da `example.json`)
già li mostrano. Questa slice tocca **solo** il percorso di generazione (Rust + schema/prompt del
modello) + i due export nativi. Le preview non cambiano.

## Invarianti / coerenza

- **Caposaldo**: hero_art e struttura sono stato-in-codice; il modello riempie solo slot vincolati
  (contenuto + eyebrow raffinato con default garantito). Il chrome non è mai inventato dal nulla.
- **Converge, non duplica**: una sola sorgente del chrome (l'`example.json` del pack) per anteprima e
  generato; nessun chrome hardcoded per-tema nel renderer.
- **Fail-open**: nessun pack root / pack importato / cover senza chrome nell'`example.json` →
  comportamento identico a oggi (nessun eyebrow/hero_art aggiunto, nessun errore).
- **WYSIWYG**: l'anteprima HTML e il generato HTML/PDF combaciano per costruzione (stessa sorgente).

## Test

- `document_content.rs`: `assemble_doc_json` porta `hero_art` (chiave solo-scheletro) e `eyebrow`
  (default) sul blocco assemblato; il contenuto del modello vince sulle chiavi condivise
  (`name`/`title`); eyebrow vuoto dal modello → ripristina il default; un blocco senza chrome (cv
  `contact_header` senza hero_art) resta senza. `document_content_schema` inietta `eyebrow` solo dove
  lo scheletro ne ha uno.
- `main.rs`: `apply_deck_template_chrome` porta hero_art (deterministico) sulla cover generata,
  tiene l'eyebrow del modello se presente, altrimenti il default del pack; fail-open su example senza
  cover-chrome; `deck_template_pack` qualifica solo i pack deck bundled con root.
- Export nativi: `doc_json_to_docx` emette il paragrafo eyebrow quando presente; render_pptx idem
  (test Python in-container o unit sul builder se estraibile).
- Gate: `cargo test -p local-first-desktop-gateway`, `pre_release_gate.py`; container up.sh +
  doc-render/deck-qa document-mode se si toccano gli script Python.

## Esclusioni (YAGNI)

- Niente rigenerazione preview né modifiche ai renderer HTML/PDF (già corretti).
- Niente hero_art negli export nativi (SVG non porta al formato Office).
- Niente nuovi tipi di hero_art / eyebrow per-slide oltre alla cover/section (il renderer li usa solo lì).
- Niente UI: l'utente non configura il chrome (è curato dal pack).

## Rischi

- **Mapping cover deck**: il modello potrebbe non mettere la cover come slide 0 nonostante il prompt
  ("la PRIMA slide deve essere cover"). Overlay difensivo: individua la prima slide `layout=="cover"`;
  se assente, non forzare (fail-open, nessun crash).
- **Eyebrow raffinato fuori tono**: mitigato dal default garantito (post-merge guard) + descrizione che
  chiede di mantenere il default salvo brief esplicito.
- **Fedeltà nativa**: l'assenza di hero_art nel .pptx/.docx è un caveat noto e documentato, non un bug.
