# Editorial cover al generato (Fase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portare il chrome editoriale — `eyebrow` (raffinabile, default dal pack) + `hero_art` (deterministico) — dal `example.json` del pack al deliverable GENERATO da `make_deck`/`make_document`, chiudendo l'invariante "preview = verità" sull'output reale.

**Architecture:** Documenti (slot-filling strict): `assemble_doc_json` parte dal blocco curato dello scheletro e sovrappone lo slot del modello (model-wins) → hero_art solo-scheletro sopravvive; eyebrow raffinabile con default garantito. Deck (generazione libera): una pura `apply_deck_template_chrome` sovrappone il chrome della cover/section del pack dopo `apply_deck_design_theme`. Export nativi: eyebrow (testo) in DOCX/PPTX; hero_art resta HTML/PDF-only. I renderer HTML/PDF NON cambiano (già leggono i campi); nessuna rigenerazione preview.

**Tech Stack:** Rust (`crates/desktop-gateway`), Python (`runtimes/contained-computer/deck_render.py`), serde_json.

## Global Constraints

- Commit su `main`, **NIENTE `Co-Authored-By`**, **NIENTE push** (Fabio spinge lui). Commenti in inglese sul *perché*.
- **Caposaldo**: hero_art e struttura = stato-in-codice (il modello non li tocca mai); il modello riempie solo slot vincolati (contenuto + eyebrow raffinato, con default garantito).
- **Converge, non duplica**: unica sorgente del chrome = `example.json` del pack (stessa dell'anteprima); riusa `document_content::load_pack_example` per i deck (NON duplicare la lettura). Nessun chrome hardcoded per-tema nel renderer.
- **Fail-open**: nessun pack root / pack importato / cover senza chrome nell'`example.json` → comportamento IDENTICO a oggi, nessun errore.
- **Renderer HTML/PDF invariati**, nessuna rigenerazione preview (già corretti da S1a).
- Gate a chiusura: `cargo test -p local-first-desktop-gateway`, `python3 scripts/pre_release_gate.py`. Se si toccano gli script Python: rebuild immagine contained-computer via `runtimes/contained-computer/up.sh` + validazione in-container.
- ⚠️ `main.rs` è un monolite ~62k righe: i numeri di riga qui **invecchiano a ogni edit** — ri-grep il simbolo, non fidarti del numero.

---

### Task 1: Documenti — `assemble_doc_json` porta il chrome dello scheletro

**Files:**
- Modify: `crates/desktop-gateway/src/document_content.rs` (`DocBlockSlot`, `document_block_skeleton`, `assemble_doc_json`)
- Test: `crates/desktop-gateway/src/document_content.rs` (modulo `#[cfg(test)]` in coda al file)

**Interfaces:**
- Consumes: `TemplateCatalogEntry`, `serde_json::{Value, Map, json}` (già importati).
- Produces:
  - `pub(crate) struct DocBlockSlot { pub(crate) block_type: String, pub(crate) slot_key: String, pub(crate) template_block: serde_json::Map<String, serde_json::Value> }`
  - `document_block_skeleton(example: &Value) -> Vec<DocBlockSlot>` (invariata come firma; ora popola `template_block`)
  - `assemble_doc_json(title_fallback: &str, skeleton: &[DocBlockSlot], model_output: &Value) -> Result<Value, String>` (firma invariata; nuova semantica merge)

- [ ] **Step 1: Test rosso — hero_art (solo-scheletro) sopravvive e il contenuto del modello vince.**

Aggiungi nel modulo test in coda a `document_content.rs`:

```rust
#[test]
fn assemble_carries_skeleton_chrome_and_lets_model_content_win() {
    // Skeleton cover block carries curated chrome (hero_art) the model never sees,
    // plus example content (name) the model overwrites.
    let example = json!({"blocks": [
        {"type": "contact_header", "name": "Jane Example", "headline": "Example",
         "eyebrow": "CURRICULUM VITAE", "contact_items": ["a@b.c"]},
        {"type": "section_cover", "title": "Example", "subtitle": "x",
         "eyebrow": "CASE STUDY", "hero_art": "gradient"}
    ]});
    let skeleton = document_block_skeleton(&example);
    let model_output = json!({"title": "Real CV", "slots": {
        "slot_0_contact_header": {"name": "Marco Rossi", "headline": "Ops Lead",
            "contact_items": ["marco@x.it"]},
        "slot_1_section_cover": {"title": "Acme × Us", "subtitle": "How we did it"}
    }});
    let doc = assemble_doc_json("fallback", &skeleton, &model_output).unwrap();
    let b = doc["blocks"].as_array().unwrap();
    // model content wins
    assert_eq!(b[0]["name"], "Marco Rossi");
    assert_eq!(b[1]["title"], "Acme × Us");
    // curated chrome carried from the skeleton (model never emitted these)
    assert_eq!(b[0]["eyebrow"], "CURRICULUM VITAE");
    assert_eq!(b[1]["eyebrow"], "CASE STUDY");
    assert_eq!(b[1]["hero_art"], "gradient");
    // contact_header has NO hero_art in the skeleton → stays absent
    assert!(b[0].get("hero_art").is_none());
    // type preserved
    assert_eq!(b[0]["type"], "contact_header");
}
```

- [ ] **Step 2: Verifica rosso.**

Run: `cargo test -p local-first-desktop-gateway assemble_carries_skeleton_chrome -- --nocapture`
Expected: FAIL — oggi `assemble_doc_json` parte da `filled.clone()` (niente eyebrow/hero_art) e `DocBlockSlot` non ha `template_block` (errore di compilazione o assert falliti).

- [ ] **Step 3: Aggiungi `template_block` a `DocBlockSlot` e popolalo.**

In `document_content.rs`, estendi la struct (commento sul *perché*):

```rust
/// One fixed slot in a document's block skeleton: which block type occupies it,
/// the key the model-facing schema uses to address it, and the CURATED example
/// block itself. We keep the whole curated block so `assemble_doc_json` can carry
/// editorial chrome the model never fills (eyebrow/hero_art) onto the output —
/// making the generated doc match the preview (both sourced from example.json).
pub(crate) struct DocBlockSlot {
    pub(crate) block_type: String,
    pub(crate) slot_key: String,
    pub(crate) template_block: Map<String, Value>,
}
```

In `document_block_skeleton`, popola `template_block` col blocco curato (senza `type`, che `assemble` re-inserisce):

```rust
.filter_map(|(i, block)| {
    let block_type = block.get("type")?.as_str()?.to_string();
    let slot_key = format!("slot_{i}_{block_type}");
    let mut template_block = block.as_object().cloned().unwrap_or_default();
    template_block.remove("type");
    Some(DocBlockSlot { block_type, slot_key, template_block })
})
```

- [ ] **Step 4: Riscrivi il merge in `assemble_doc_json`.**

Sostituisci il corpo del loop `for slot in skeleton` (parti dal blocco curato, sovrapponi lo slot del modello — model-wins sulle chiavi condivise):

```rust
for slot in skeleton {
    let filled = slots
        .and_then(|s| s.get(&slot.slot_key))
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("document content missing slot `{}`", slot.slot_key))?;
    // Start from the curated skeleton block so non-slot chrome (eyebrow/hero_art)
    // survives; overlay the model's content (it wins on shared keys like name/title).
    let mut block = slot.template_block.clone();
    for (k, v) in filled {
        block.insert(k.clone(), v.clone());
    }
    block.insert("type".to_string(), Value::String(slot.block_type.clone()));
    blocks.push(Value::Object(block));
}
```

- [ ] **Step 5: Verifica verde + regressioni.**

Run: `cargo test -p local-first-desktop-gateway assemble -- --nocapture`
Expected: PASS (il nuovo test + i pre-esistenti `assemble_doc_json`). Se un test pre-esistente costruiva `DocBlockSlot` a mano, aggiorna la costruzione col nuovo campo `template_block: Default::default()`.

- [ ] **Step 6: Commit.**

```bash
git add crates/desktop-gateway/src/document_content.rs
git commit -m "feat(presentations): carry curated skeleton chrome (eyebrow/hero_art) into generated documents"
```

---

### Task 2: Documenti — eyebrow raffinabile dal modello (default garantito)

**Files:**
- Modify: `crates/desktop-gateway/src/document_content.rs` (`document_content_schema`, `assemble_doc_json` guardia post-merge)
- Test: stesso modulo `#[cfg(test)]`

**Interfaces:**
- Consumes: `DocBlockSlot { template_block }` (Task 1), `document_block_schema`, `s()` helper.
- Produces: `document_content_schema(skeleton: &[DocBlockSlot]) -> Result<Value, String>` (firma invariata; ora inietta uno slot `eyebrow` dove lo scheletro ne ha uno) + guardia nel merge di `assemble_doc_json`.

- [ ] **Step 1: Test rosso — schema inietta eyebrow solo dove serve; refinatura + default garantito.**

```rust
#[test]
fn schema_injects_eyebrow_slot_only_where_skeleton_has_one() {
    let example = json!({"blocks": [
        {"type": "section_cover", "title": "X", "subtitle": "y", "eyebrow": "CASE STUDY"},
        {"type": "text_section", "title": "Z", "paragraphs": [], "bullets": []}
    ]});
    let skeleton = document_block_skeleton(&example);
    let schema = document_content_schema(&skeleton).unwrap();
    let props = &schema["properties"]["slots"]["properties"];
    // cover slot gained an eyebrow property whose description carries the default
    let cover = &props["slot_0_section_cover"];
    assert!(cover["properties"].get("eyebrow").is_some());
    assert!(cover["required"].as_array().unwrap().iter().any(|v| v == "eyebrow"));
    assert!(cover["properties"]["eyebrow"]["description"].as_str().unwrap().contains("CASE STUDY"));
    // text_section has no skeleton eyebrow → no eyebrow slot
    assert!(props["slot_1_text_section"]["properties"].get("eyebrow").is_none());
}

#[test]
fn assemble_keeps_model_eyebrow_but_restores_default_when_blank() {
    let example = json!({"blocks": [
        {"type": "section_cover", "title": "X", "subtitle": "y", "eyebrow": "CASE STUDY"},
        {"type": "section_cover", "title": "X2", "subtitle": "y2", "eyebrow": "CASE STUDY"}
    ]});
    let skeleton = document_block_skeleton(&example);
    let model_output = json!({"title": "t", "slots": {
        "slot_0_section_cover": {"title": "A", "subtitle": "b", "eyebrow": "SERIES A · 2026"},
        "slot_1_section_cover": {"title": "A2", "subtitle": "b2", "eyebrow": "  "}
    }});
    let doc = assemble_doc_json("f", &skeleton, &model_output).unwrap();
    let b = doc["blocks"].as_array().unwrap();
    assert_eq!(b[0]["eyebrow"], "SERIES A · 2026");  // model refinement kept
    assert_eq!(b[1]["eyebrow"], "CASE STUDY");        // blank → skeleton default restored
}
```

- [ ] **Step 2: Verifica rosso.**

Run: `cargo test -p local-first-desktop-gateway eyebrow -- --nocapture`
Expected: FAIL — oggi `document_content_schema` non inietta eyebrow; il merge non ha la guardia (blank del modello resterebbe blank).

- [ ] **Step 3: Inietta lo slot eyebrow in `document_content_schema`.**

Dopo aver ottenuto `schema` da `document_block_schema(&slot.block_type)?`, se lo scheletro ha un eyebrow non vuoto, aggiungi la proprietà (required, `""` ammesso) con descrizione che porta il default:

```rust
let mut schema = document_block_schema(&slot.block_type).ok_or_else(|| {
    format!(
        "unregistered document block type `{}` in pack skeleton (slot `{}`)",
        slot.block_type, slot.slot_key
    )
})?;
// Editorial eyebrow: a REFINABLE slot, pre-seeded with the pack default so the
// model can adapt it to the brief (e.g. "SEED ROUND" -> "SERIES A · 2026") while a
// blank answer falls back to the curated default (assemble_doc_json's guard).
if let Some(default) = slot.template_block.get("eyebrow").and_then(|v| v.as_str()) {
    if !default.trim().is_empty() {
        if let Some(obj) = schema.get_mut("properties").and_then(|p| p.as_object_mut()) {
            obj.insert(
                "eyebrow".to_string(),
                s(&format!(
                    "Small-caps kicker above the title. Default: «{default}». Keep it unless the \
brief clearly implies a more specific label; use \"\" to keep the default."
                )),
            );
        }
        if let Some(req) = schema.get_mut("required").and_then(|r| r.as_array_mut()) {
            req.push(Value::String("eyebrow".to_string()));
        }
    }
}
slot_properties.insert(slot.slot_key.clone(), schema);
```

- [ ] **Step 4: Guardia post-merge in `assemble_doc_json`.**

Dentro il loop di `assemble_doc_json`, DOPO l'overlay del modello e PRIMA di inserire `type`, ripristina il default se il modello ha lasciato l'eyebrow vuoto:

```rust
// A blank model eyebrow must not erase the curated default (the schema invites
// refinement, not deletion). Restore the skeleton's eyebrow when blank.
let model_eyebrow_blank = block
    .get("eyebrow")
    .and_then(|v| v.as_str())
    .map(|v| v.trim().is_empty())
    .unwrap_or(false);
if model_eyebrow_blank {
    if let Some(default) = slot.template_block.get("eyebrow") {
        block.insert("eyebrow".to_string(), default.clone());
    }
}
```

- [ ] **Step 5: Verifica verde.**

Run: `cargo test -p local-first-desktop-gateway -- --nocapture eyebrow schema_injects`
Expected: PASS (entrambi i nuovi test + Task 1).

- [ ] **Step 6: Commit.**

```bash
git add crates/desktop-gateway/src/document_content.rs
git commit -m "feat(presentations): refinable document eyebrow (pack default, model may adapt)"
```

---

### Task 3: Deck — `apply_deck_template_chrome` sovrappone il chrome del pack

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (nuove fn `deck_template_pack` + `apply_deck_template_chrome`; wiring nella branch `Ok(mut deck)` di `make_deck`, subito dopo `apply_deck_design_theme`)
- Test: modulo test di `main.rs` (`#[cfg(test)]`, accanto ai test `apply_deck_design_theme` — ri-grep `fn apply_deck_design_theme` per la posizione attuale)

**Interfaces:**
- Consumes: `TemplateCatalogEntry`, `document_content::load_pack_example(entry) -> Result<Value, String>` (riuso — legge `<root>/example.json`), `catalog_template: Option<TemplateCatalogEntry>` già in scope nella branch make_deck (ri-grep `let catalog_template = template_catalog_by_id`).
- Produces:
  - `fn deck_template_pack(entry: Option<&TemplateCatalogEntry>) -> Option<&TemplateCatalogEntry>`
  - `fn apply_deck_template_chrome(deck: &mut serde_json::Value, example: &serde_json::Value)`

- [ ] **Step 1: Test rosso — overlay porta hero_art (deterministico) e default eyebrow, tenendo l'eyebrow del modello.**

Aggiungi nel modulo test di `main.rs`:

```rust
#[test]
fn deck_template_chrome_overlays_cover_and_section() {
    // Pack example: cover has eyebrow+hero_art, section has hero_art.
    let example = serde_json::json!({"slides": [
        {"layout": "cover", "title": "Kite", "eyebrow": "SEED ROUND", "hero_art": "rings"},
        {"layout": "section", "title": "Market", "hero_art": "grid"}
    ]});
    // Generated deck: model gave a cover (no chrome) + a refined eyebrow on cover,
    // a section (no chrome), and a bullets slide.
    let mut deck = serde_json::json!({"slides": [
        {"layout": "cover", "title": "Real Co", "eyebrow": "SERIES A · 2026"},
        {"layout": "section", "title": "Traction"},
        {"layout": "bullets", "title": "Ask", "bullets": ["x"]}
    ]});
    super::apply_deck_template_chrome(&mut deck, &example);
    let s = deck["slides"].as_array().unwrap();
    // cover: model eyebrow kept (refinement), hero_art carried deterministically
    assert_eq!(s[0]["eyebrow"], "SERIES A · 2026");
    assert_eq!(s[0]["hero_art"], "rings");
    // section: hero_art carried from the pack's section
    assert_eq!(s[1]["hero_art"], "grid");
    // bullets slide untouched
    assert!(s[2].get("hero_art").is_none());
}

#[test]
fn deck_template_chrome_uses_pack_eyebrow_when_model_blank_and_is_failopen() {
    let example = serde_json::json!({"slides": [
        {"layout": "cover", "title": "Kite", "eyebrow": "PITCH", "hero_art": "rings"}]});
    let mut deck = serde_json::json!({"slides": [{"layout": "cover", "title": "Real"}]});
    super::apply_deck_template_chrome(&mut deck, &example);
    assert_eq!(deck["slides"][0]["eyebrow"], "PITCH");   // pack default when model blank
    // fail-open: example with no slides / no cover chrome does nothing, no panic
    let mut deck2 = serde_json::json!({"slides": [{"layout": "cover", "title": "R"}]});
    super::apply_deck_template_chrome(&mut deck2, &serde_json::json!({}));
    assert!(deck2["slides"][0].get("hero_art").is_none());
}
```

- [ ] **Step 2: Verifica rosso.**

Run: `cargo test -p local-first-desktop-gateway deck_template_chrome -- --nocapture`
Expected: FAIL — `apply_deck_template_chrome` non esiste.

- [ ] **Step 3: Implementa `deck_template_pack` + `apply_deck_template_chrome`.**

Accanto a `document_template_pack` (ri-grep `fn document_template_pack`):

```rust
/// Deck analogue of `document_template_pack`: a template_ref qualifies for chrome
/// overlay only when it resolves to a BUNDLED presentation pack with a pack root
/// on disk (so `load_pack_example` can read example.json). Imported/non-bundled or
/// no template → no overlay (fail-open, identical to today).
fn deck_template_pack(entry: Option<&TemplateCatalogEntry>) -> Option<&TemplateCatalogEntry> {
    let entry = entry?;
    (entry.kind == "presentation" && entry.bundled && entry.template_pack_root.is_some())
        .then_some(entry)
}

/// Carry the pack's curated editorial chrome onto the model-generated deck:
/// hero_art is DETERMINISTIC (the model never produces it) and taken from the
/// pack's cover/section slides; eyebrow is REFINABLE — a non-empty model eyebrow
/// wins (adapts to the brief), otherwise the pack default is used. This makes the
/// generated deck match the preview (both sourced from example.json). Fail-open:
/// a missing slides array or absent chrome leaves the deck untouched.
fn apply_deck_template_chrome(deck: &mut serde_json::Value, example: &serde_json::Value) {
    let pack_slides = example.get("slides").and_then(|s| s.as_array());
    let Some(pack_slides) = pack_slides else { return };
    let pack_for = |layout: &str| -> Option<&serde_json::Value> {
        pack_slides.iter().find(|s| s.get("layout").and_then(|l| l.as_str()) == Some(layout))
    };
    let pack_cover = pack_for("cover");
    let pack_section = pack_for("section");
    let Some(slides) = deck.get_mut("slides").and_then(|s| s.as_array_mut()) else { return };
    for slide in slides.iter_mut() {
        let layout = slide.get("layout").and_then(|l| l.as_str()).unwrap_or("");
        let pack = match layout {
            "cover" => pack_cover,
            "section" => pack_section,
            _ => None,
        };
        let Some(pack) = pack else { continue };
        // hero_art: deterministic — always from the pack.
        if let Some(art) = pack.get("hero_art").cloned() {
            slide["hero_art"] = art;
        }
        // eyebrow: keep a non-empty model value (refinement), else the pack default.
        let model_eyebrow_blank = slide
            .get("eyebrow")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().is_empty())
            .unwrap_or(true);
        if model_eyebrow_blank {
            if let Some(eyebrow) = pack.get("eyebrow").cloned() {
                slide["eyebrow"] = eyebrow;
            }
        }
    }
}
```

- [ ] **Step 4: Wiring nella branch make_deck.**

Ri-grep `apply_deck_design_theme(` per la call-site nella branch `Ok(mut deck)` di make_deck. Subito DOPO quella chiamata, aggiungi (usa il `catalog_template` già risolto lì):

```rust
apply_deck_design_theme(&mut deck, design_theme.as_deref(), &brand);
// Carry the pack's curated editorial chrome (hero_art deterministic, eyebrow
// refinable) so the generated deck matches the preview. Fail-open when the
// template is not a bundled presentation pack or its example.json is unreadable.
if let Some(pack) = deck_template_pack(catalog_template.as_ref()) {
    if let Ok(example) = document_content::load_pack_example(pack) {
        apply_deck_template_chrome(&mut deck, &example);
    }
}
```

- [ ] **Step 5: Verifica verde + build.**

Run: `cargo test -p local-first-desktop-gateway deck_template_chrome -- --nocapture`
Expected: PASS. Poi `cargo build -p local-first-desktop-gateway` verde (wiring compila; `catalog_template` è in scope — se il nome reale differisce, ri-grep e adegua).

- [ ] **Step 6: Commit.**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(presentations): overlay pack editorial chrome (hero_art/eyebrow) onto generated decks"
```

---

### Task 4: Deck — slot eyebrow raffinabile nello schema + seeding del default nel prompt

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`deck_content_schema` aggiunge `eyebrow` all'item-slide; `generate_deck_content` semina il default della cover del pack nel system-prompt)
- Test: modulo test di `main.rs`

**Interfaces:**
- Consumes: `deck_content_schema() -> Value`, `generate_deck_content(...)` (aggiunge un parametro `cover_eyebrow_default: Option<&str>`), `apply_deck_template_chrome` (Task 3).
- Produces: `deck_content_schema()` con proprietà `eyebrow` opzionale sull'item-slide; `generate_deck_content(..., cover_eyebrow_default: Option<&str>)`.

- [ ] **Step 1: Test rosso — lo schema espone eyebrow sull'item-slide.**

```rust
#[test]
fn deck_content_schema_exposes_refinable_eyebrow() {
    let schema = super::deck_content_schema();
    let item = &schema["properties"]["slides"]["items"]["properties"];
    assert!(item.get("eyebrow").is_some());
    // eyebrow is NOT required (blank/omitted is fine; overlay supplies the default)
    let req = schema["properties"]["slides"]["items"]["required"].as_array().unwrap();
    assert!(!req.iter().any(|v| v == "eyebrow"));
}
```

- [ ] **Step 2: Verifica rosso.**

Run: `cargo test -p local-first-desktop-gateway deck_content_schema_exposes -- --nocapture`
Expected: FAIL — `eyebrow` non è nello schema.

- [ ] **Step 3: Aggiungi `eyebrow` all'item-slide di `deck_content_schema`.**

In `deck_content_schema`, dentro `"properties"` dell'item-slide (accanto a `title`/`bullets`/…), aggiungi (NON in `required` — le slide non-cover la lasciano vuota):

```rust
"eyebrow": { "type": "string", "description": "Optional small-caps kicker above the COVER title only; refine the pack default to fit the brief (e.g. \"SERIES A · 2026\"). Leave \"\" on non-cover slides." },
```

- [ ] **Step 4: Semina il default della cover nel prompt di `generate_deck_content`.**

Aggiungi il parametro `cover_eyebrow_default: Option<&str>` alla firma di `generate_deck_content` e, quando presente, appendi una riga al `system` prompt (dopo le regole layout):

```rust
let eyebrow_directive = match cover_eyebrow_default {
    Some(d) if !d.trim().is_empty() => format!(
        " The cover slide's `eyebrow` defaults to «{}»; keep it unless the brief clearly implies a more specific label.",
        d.trim()
    ),
    _ => String::new(),
};
```

Interpola `{eyebrow_directive}` nella stringa `system` (subito dopo le regole su cover/closing). Al call-site in make_deck (ri-grep `generate_deck_content(`), passa il default estratto dal pack:

```rust
let cover_eyebrow_default = deck_template_pack(catalog_template.as_ref())
    .and_then(|pack| document_content::load_pack_example(pack).ok())
    .and_then(|ex| ex["slides"].as_array().and_then(|sl| {
        sl.iter()
            .find(|s| s.get("layout").and_then(|l| l.as_str()) == Some("cover"))
            .and_then(|c| c.get("eyebrow").and_then(|e| e.as_str()).map(String::from))
    }));
```

e passa `cover_eyebrow_default.as_deref()` come nuovo ultimo argomento a `generate_deck_content(...)`. **Nota:** `generate_deck_content` ha **una sola** call-site (la branch make_deck qui) — verificato con `grep -rn "generate_deck_content(" crates/desktop-gateway/src/*.rs`; non ce ne sono altre da aggiornare.

- [ ] **Step 5: Verifica verde + build.**

Run: `cargo test -p local-first-desktop-gateway deck_content_schema_exposes -- --nocapture && cargo build -p local-first-desktop-gateway`
Expected: PASS + build verde (tutte le call-site di `generate_deck_content` aggiornate).

- [ ] **Step 6: Commit.**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(presentations): refinable cover eyebrow slot for decks (pack default seeded in prompt)"
```

---

### Task 5: Export nativi — eyebrow in DOCX (`doc_json_to_docx`) e PPTX (`render_pptx`)

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`doc_block_to_docx_xml` blocchi cover; nuovo helper `docx_eyebrow_paragraph`)
- Modify: `runtimes/contained-computer/deck_render.py` (`render_pptx`, ramo `layout in ("cover","section")`)
- Test: modulo test di `main.rs` (DOCX); validazione in-container per PPTX

**Interfaces:**
- Consumes: `doc_block_field(block, key)`, `docx_paragraph_xml(style, runs_xml)`, `docx_text_run(text, bold, italic)` (ri-grep firme esatte), `render_pptx`'s `_eyebrow`-equivalente inline.
- Produces: `fn docx_eyebrow_paragraph(text: &str) -> String`.

- [ ] **Step 1: Test rosso — DOCX emette l'eyebrow prima del titolo cover.**

```rust
#[test]
fn docx_cover_blocks_render_eyebrow_before_title() {
    let sc = serde_json::json!({"type": "section_cover", "title": "Acme", "subtitle": "s",
        "eyebrow": "CASE STUDY"});
    let xml = super::doc_block_to_docx_xml(&sc);
    assert!(xml.contains("CASE STUDY"));
    // eyebrow appears BEFORE the title text in the XML stream
    assert!(xml.find("CASE STUDY").unwrap() < xml.find("Acme").unwrap());
    // a cover block WITHOUT eyebrow renders no eyebrow paragraph (fail-open)
    let sc2 = serde_json::json!({"type": "section_cover", "title": "Acme", "subtitle": "s"});
    let xml2 = super::doc_block_to_docx_xml(&sc2);
    assert!(!xml2.contains("CASE STUDY"));
}
```

- [ ] **Step 2: Verifica rosso.**

Run: `cargo test -p local-first-desktop-gateway docx_cover_blocks_render_eyebrow -- --nocapture`
Expected: FAIL — l'eyebrow non è renderizzato in DOCX.

- [ ] **Step 3: Helper + iniezione nei 3 blocchi cover.**

Aggiungi l'helper accanto a `docx_heading1_paragraph` (ri-grep):

```rust
/// A small-caps editorial kicker paragraph above a cover heading (DOCX). Mirrors
/// the HTML `.eyebrow` styling intent (uppercase, spaced) as far as flat DOCX runs
/// allow: bold + uppercased text. Empty input renders nothing (fail-open).
fn docx_eyebrow_paragraph(text: &str) -> String {
    if text.trim().is_empty() {
        return String::new();
    }
    docx_paragraph_xml(None, &docx_text_run(&text.to_uppercase(), true, false))
}
```

Nei rami `"section_cover"`, `"contact_header"`, `"letterhead"` di `doc_block_to_docx_xml`, PREPENDI l'eyebrow al titolo. Es. per `section_cover`:

```rust
"section_cover" => {
    let mut out = docx_eyebrow_paragraph(&doc_block_field(block, "eyebrow"));
    out.push_str(&docx_heading1_paragraph(&doc_block_field(block, "title")));
    out.push_str(&docx_normal_paragraph(&doc_block_field(block, "subtitle")));
    out
}
```

Applica lo stesso pattern (prima riga `let mut out = docx_eyebrow_paragraph(&doc_block_field(block, "eyebrow"));` + `out.push_str(...heading...)`) a `contact_header` e `letterhead`. Verifica la firma esatta di `docx_text_run` con un grep prima (bold/italic order).

- [ ] **Step 4: Verifica verde DOCX.**

Run: `cargo test -p local-first-desktop-gateway docx_cover -- --nocapture`
Expected: PASS. Anche `doc_json_to_docx_renders_blocks_structurally` resta verde.

- [ ] **Step 5: PPTX — eyebrow sopra il titolo cover/section in `render_pptx`.**

In `runtimes/contained-computer/deck_render.py`, nel ramo `if layout in ("cover", "section"):` (ri-grep), PRIMA del `textbox(...)` del titolo, aggiungi un textbox eyebrow quando presente:

```python
        if layout in ("cover", "section"):
            cover_fill = brand2 if is_editorial_theme else brand
            cover_text = ink if is_editorial_theme else white
            fill_bg(slide, cover_fill)
            eyebrow = s.get("eyebrow", "")
            if eyebrow:
                # small-caps editorial kicker above the title (matches HTML .eyebrow)
                textbox(slide, Inches(0.95), Inches(1.9), Inches(11.5), Inches(0.5),
                        [(eyebrow.upper(), 14, accent, head_font, True, False)])
            runs = [(title, 46 if layout == "cover" else 40, cover_text, head_font, True, False)]
            ...
```

(mantieni il resto del ramo invariato.)

- [ ] **Step 6: Validazione PPTX in-container.**

Rebuild immagine + verifica che il .pptx contenga l'eyebrow:

```bash
bash runtimes/contained-computer/up.sh   # rebuild image with the edited deck_render.py
```

Poi in-container (o via lo stesso harness usato per deck-qa), renderizza un deck con `eyebrow` sulla cover e verifica con python-pptx che il testo compaia in una shape della prima slide (documenta l'esito nel commit). Fail-open: cover senza eyebrow → nessuna shape aggiunta.

- [ ] **Step 7: Commit.**

```bash
git add crates/desktop-gateway/src/main.rs runtimes/contained-computer/deck_render.py
git commit -m "feat(presentations): render eyebrow in native DOCX/PPTX exports (hero_art stays HTML/PDF)"
```

---

### Task 6: Gate completi + STATO

**Files:**
- Modify: `docs/STATO.md`

- [ ] **Step 1: Gate completi.**

```bash
cargo test -p local-first-desktop-gateway
python3 scripts/pre_release_gate.py
```
Expected: ALL GREEN. (Se toccati gli script Python in Task 5, l'immagine è già ricostruita.)

- [ ] **Step 2: STATO checkpoint.**

In `docs/STATO.md`, aggiungi un checkpoint (IT, conciso, data 2026-07-18): *Fase 2 — editorial cover al generato*: eyebrow (raffinabile, default pack, guardia default garantito) + hero_art (deterministico) portati dall'`example.json` del pack al deliverable generato (documenti via `assemble_doc_json`/`DocBlockSlot.template_block`; deck via `apply_deck_template_chrome` dopo il tema); eyebrow negli export nativi DOCX/PPTX (hero_art resta HTML/PDF-only); renderer HTML/PDF invariati, nessuna rigenerazione preview; fail-open. Cosa resta: S3 font picker.

- [ ] **Step 3: Commit.**

```bash
git add docs/STATO.md
git commit -m "docs: STATO checkpoint — Fase 2 (editorial cover at generation) shipped"
```

---

## Note

- **Fail-open ovunque**: nessun pack / pack importato / example.json illeggibile / cover senza chrome → comportamento identico a oggi.
- **Caposaldo**: hero_art è stato-in-codice (deterministico); l'eyebrow è uno slot vincolato col default garantito. Nessun chrome inventato dal nulla.
- **WYSIWYG**: l'anteprima HTML e il generato HTML/PDF combaciano per costruzione (stessa sorgente `example.json`). Il caveat nativo (hero_art assente in DOCX/PPTX) è documentato.
- S3 (font picker) resta fuori scope.
