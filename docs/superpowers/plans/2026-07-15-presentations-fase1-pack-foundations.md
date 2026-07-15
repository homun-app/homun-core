# Presentations Fase 1 — Template pack reali + catalogo con anteprime vere: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** I template built-in diventano pack veri spediti con l'app (manifest + esempio curato + anteprima renderizzata dalla pipeline reale), il seed hardcoded muore, e il catalogo UI mostra anteprime HTML vive al posto dei blocchetti CSS finti.

**Architecture:** Convergenza sul formato pack già usato dagli import (`manifest.json` + `thumbnails/slide-00N.png`), esteso con `example.json` + `preview.html`. Un nuovo modulo `template_packs.rs` ospita il `BundledTemplatePackProvider` (env `HOMUN_BUNDLED_TEMPLATES_DIR`, fallback dev = `templates/` in repo). Le anteprime si generano offline con `scripts/build_template_previews.py` (deck_render → HTML; Chromium+pdftoppm → PNG) e si COMMITTANO. La UI embedda `preview.html` in iframe sandboxed scalato.

**Tech Stack:** Rust (axum, gateway monolite `main.rs` — NON crescerlo: nuovo codice nel modulo `template_packs.rs`), Python stdlib (deck_render, script previews), React 19 + TS (BrandKitPanel), Electron (env pass-through).

## Global Constraints

- Spec di riferimento: `docs/superpowers/specs/2026-07-15-presentations-professional-templates-design.md` (approvata).
- Commenti in inglese (il *perché*), docs in italiano. Niente trailer `Co-Authored-By`. Commit su `main`, **niente push** salvo richiesta.
- ⚠️ I numeri di riga in questo piano invecchiano ad ogni edit: **ri-greppa il simbolo**, mai fidarti del numero.
- `main.rs` non deve crescere: il delta netto Rust deve restare ~0 (nuovo codice in `template_packs.rs`; il seed cancellato compensa le aggiunte).
- Gate obbligatori a fine lavoro: `cargo test -p local-first-desktop-gateway`, `npm run build`, `npm run test:ui-contract`, `npm run test:electron`, `python3 scripts/pre_release_gate.py`.
- ID pack v1 (fissati): `homun/startup-pitch-clean-01`, `homun/executive-update-board-01`. Provider string: `"homun"`.
- I 6 template documento arrivano in Fase 2: dopo questa fase il catalogo built-in mostra SOLO i 2 deck reali (onesto: meglio 2 veri che 11 finti). Il filtro "Documents" resta e mostra empty-state finché F2 non atterra.

---

### Task 1: Campi nuovi sul modello TemplateCatalogEntry (name_it, description_it, preview_html_ref, bundled)

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` — struct `TemplateCatalogEntry` (grep `struct TemplateCatalogEntry`, ~l.6740), struct `TemplateCatalogEntryResponse` (~l.523), `parse_file_template_catalog_entry` (~l.7441), `template_catalog_response_from_entries` (~l.7907), helper `template_catalog_entry(` (~l.6900, il costruttore usato dal seed)
- Test: `crates/desktop-gateway/src/main.rs` (mod tests in fondo, vicino ai test `FileTemplateCatalogProvider` — grep `from_json_str(manifest`)

**Interfaces:**
- Produces: `TemplateCatalogEntry { name_it: Option<String>, description_it: Option<String>, preview_html_ref: Option<String>, bundled: bool, … }`; `TemplateCatalogEntryResponse` con gli stessi 3 campi opzionali serializzati e `is_imported = template_pack_root.is_some() && !bundled`. Il manifest JSON accetta le chiavi piatte `name_it`, `description_it`.

- [ ] **Step 1: Test fallente — il manifest localizzato viene parsato**

Nel `mod tests` di main.rs, accanto ai test esistenti di `FileTemplateCatalogProvider::from_json_str`:

```rust
#[test]
fn file_template_catalog_entry_parses_localized_names() {
    let manifest = serde_json::json!({
        "provider_id": "acme",
        "templates": [{
            "id": "acme/localized-01",
            "kind": "presentation",
            "name": "Localized Pitch",
            "name_it": "Pitch localizzato",
            "description": "A pitch template.",
            "description_it": "Un template per pitch.",
            "design_template": "startup_pitch",
            "route_text": "pitch localized"
        }]
    });
    let provider =
        super::FileTemplateCatalogProvider::from_json_str(manifest.to_string().as_str())
            .expect("provider");
    let entry = &provider.entries()[0];
    assert_eq!(entry.name_it.as_deref(), Some("Pitch localizzato"));
    assert_eq!(entry.description_it.as_deref(), Some("Un template per pitch."));
    assert!(!entry.bundled);
    assert!(entry.preview_html_ref.is_none());
}
```

- [ ] **Step 2: Run — verifica che fallisca**

Run: `cargo test -p local-first-desktop-gateway file_template_catalog_entry_parses_localized_names -- --nocapture`
Expected: FAIL di compilazione (`no field name_it`).

- [ ] **Step 3: Implementazione minima**

1. In `struct TemplateCatalogEntry` aggiungi dopo `description`:
```rust
    // Flat locale overrides (name_it/description_it in the manifest): the catalog is
    // EN-canonical, Italian is the one extra locale the product ships today. A map
    // would be speculative — add locales when a third one actually exists.
    name_it: Option<String>,
    description_it: Option<String>,
```
   dopo `preview_ref`:
```rust
    // Live HTML preview (bundled packs): "template-pack://<id>/preview.html".
    preview_html_ref: Option<String>,
```
   dopo `template_pack_root`:
```rust
    // Bundled (shipped-with-the-app) packs share the pack-dir shape with imported
    // ones but must NOT look imported (no delete button, source filter "Homun").
    bundled: bool,
```
2. Il compilatore ora elenca TUTTI i costruttori da aggiornare (`template_catalog_entry(...)` del seed, `parse_file_template_catalog_entry`): valorizza `name_it: None, description_it: None, preview_html_ref: None, bundled: false` ovunque, TRANNE in `parse_file_template_catalog_entry` dove:
```rust
        name_it: clean_template_catalog_text(value.get("name_it"), 80),
        description_it: clean_template_catalog_text(value.get("description_it"), 240),
```
3. In `TemplateCatalogEntryResponse` aggiungi `name_it: Option<String>`, `description_it: Option<String>`, `preview_html_ref: Option<String>`; in `template_catalog_response_from_entries` mappa:
```rust
                    name_it: entry.name_it,
                    description_it: entry.description_it,
                    preview_html_ref: template_catalog_preview_response_ref(entry.preview_html_ref),
                    is_imported: entry.template_pack_root.is_some() && !entry.bundled,
```
   (attenzione all'ordine dei move: `entry.preview_html_ref` va letto prima che `entry` venga smembrata dove serve — segui il pattern del campo `preview_ref` esistente).

- [ ] **Step 4: Run — verde**

Run: `cargo test -p local-first-desktop-gateway file_template_catalog_entry_parses_localized_names -- --nocapture`
Expected: PASS. Poi `cargo test -p local-first-desktop-gateway` per confermare zero regressioni.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(templates): localized names, preview_html_ref and bundled flag on catalog entries"
```

---

### Task 2: Modulo `template_packs.rs` — BundledTemplatePackProvider

**Files:**
- Create: `crates/desktop-gateway/src/template_packs.rs`
- Modify: `crates/desktop-gateway/src/main.rs` — aggiungi `mod template_packs;` accanto agli altri `mod` (grep `^mod `), e `template_catalog_entries()` (~l.7881)

**Interfaces:**
- Consumes: `crate::{TemplateCatalogEntry, TemplateCatalogProvider, parse_file_template_catalog_entry, imported_template_preview_ref, clean_template_catalog_ref}` (item privati del root: visibili dai moduli figli via `crate::`).
- Produces: `template_packs::BundledTemplatePackProvider::from_root(&Path) -> Result<Self, String>` (con `entries()` via trait), `template_packs::bundled_template_pack_root() -> Option<PathBuf>`, `template_packs::bundled_template_pack_provider() -> Option<BundledTemplatePackProvider>`.

- [ ] **Step 1: Test fallente — un pack su disco viene scoperto con i ref giusti**

In `template_packs.rs` (il file nasce col test + scheletro vuoto che non compila ancora):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // Same isolation pattern as main.rs's `isolated_gateway_test_dir` (that helper
    // is private to main's tests mod): unique temp dir per test, no tempfile crate.
    fn isolated_pack_root() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "homun-template-packs-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_pack(root: &std::path::Path, slug: &str) {
        let pack = root.join(slug);
        std::fs::create_dir_all(pack.join("thumbnails")).unwrap();
        std::fs::write(
            pack.join("manifest.json"),
            serde_json::json!({
                "id": format!("homun/{slug}"),
                "kind": "presentation",
                "name": "Fixture Pack",
                "name_it": "Pack di prova",
                "description": "A fixture template pack.",
                "design_template": "startup_pitch",
                "design_theme": "clean_corporate",
                "route_text": "fixture pack"
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(pack.join("thumbnails/slide-001.png"), b"png").unwrap();
        std::fs::write(pack.join("preview.html"), "<html></html>").unwrap();
        std::fs::write(pack.join("example.json"), "{\"slides\":[]}").unwrap();
    }

    #[test]
    fn bundled_provider_discovers_packs_with_live_preview_refs() {
        let dir = isolated_pack_root();
        write_pack(&dir, "fixture-01");
        let provider = BundledTemplatePackProvider::from_root(&dir).expect("provider");
        let entries = crate::TemplateCatalogProvider::entries(&provider);
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.provider, "homun");
        assert!(entry.bundled);
        assert_eq!(
            entry.preview_ref.as_deref(),
            Some("template-pack://homun/fixture-01/thumbnails/slide-001.png")
        );
        assert_eq!(
            entry.preview_html_ref.as_deref(),
            Some("template-pack://homun/fixture-01/preview.html")
        );
        assert_eq!(entry.name_it.as_deref(), Some("Pack di prova"));
        // Bundled packs must not look imported (no delete, "Homun" source in the UI).
        assert!(entry.template_pack_root.is_some());
    }

    #[test]
    fn bundled_pack_without_manifest_is_skipped() {
        let dir = isolated_pack_root();
        std::fs::create_dir_all(dir.join("broken")).unwrap();
        let provider = BundledTemplatePackProvider::from_root(&dir).expect("provider");
        assert!(crate::TemplateCatalogProvider::entries(&provider).is_empty());
    }
}
```

- [ ] **Step 2: Run — verifica che fallisca**

Run: `cargo test -p local-first-desktop-gateway bundled_provider -- --nocapture`
Expected: FAIL di compilazione (modulo/tipi inesistenti).

- [ ] **Step 3: Implementazione**

Contenuto di `template_packs.rs` (sopra il mod tests):

```rust
//! Bundled deliverable template packs — the "Homun" source of the catalog.
//!
//! Same on-disk shape as user-imported packs (manifest.json + thumbnails/) so the
//! two sources CONVERGE on one format, extended with the assets only bundled packs
//! have today: `example.json` (curated content) and `preview.html` (the real
//! renderer output, embedded live by the catalog UI). Preview PNG/HTML are
//! COMMITTED to the repo (scripts/build_template_previews.py regenerates them):
//! the app never needs Chromium/poppler at runtime to show the catalog.

use std::path::{Path, PathBuf};

use crate::{
    clean_template_catalog_ref, imported_template_preview_ref,
    parse_file_template_catalog_entry, TemplateCatalogEntry, TemplateCatalogProvider,
};

/// Packaged: Electron sets HOMUN_BUNDLED_TEMPLATES_DIR to <resources>/templates.
/// Dev/tests: fall back to the in-repo templates/ directory so the catalog (and
/// every test that resolves template_ref) works without any env.
pub(crate) fn bundled_template_pack_root() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("HOMUN_BUNDLED_TEMPLATES_DIR") {
        return Some(PathBuf::from(path));
    }
    let dev: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../templates")
        .components()
        .collect();
    dev.is_dir().then_some(dev)
}

#[derive(Debug, Clone)]
pub(crate) struct BundledTemplatePackProvider {
    entries: Vec<TemplateCatalogEntry>,
}

impl BundledTemplatePackProvider {
    pub(crate) fn from_root(root: &Path) -> Result<Self, String> {
        let mut entries = Vec::new();
        if !root.exists() {
            return Ok(Self { entries });
        }
        for item in std::fs::read_dir(root).map_err(|error| {
            format!("could not read bundled template root {}: {error}", root.display())
        })? {
            let path = item
                .map_err(|error| format!("could not read bundled template entry: {error}"))?
                .path();
            if !path.is_dir() {
                continue;
            }
            if let Some(entry) = parse_bundled_template_pack(&path) {
                entries.push(entry);
            }
        }
        // Deterministic catalog order regardless of filesystem iteration order.
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(Self { entries })
    }
}

impl TemplateCatalogProvider for BundledTemplatePackProvider {
    fn provider_id(&self) -> &str {
        "homun"
    }

    fn entries(&self) -> Vec<TemplateCatalogEntry> {
        self.entries.clone()
    }
}

fn bundled_template_preview_html_ref(id: &str, pack_root: &Path) -> Option<String> {
    if !pack_root.join("preview.html").is_file() {
        return None;
    }
    clean_template_catalog_ref(Some(&serde_json::Value::String(format!(
        "template-pack://{id}/preview.html"
    ))))
}

fn parse_bundled_template_pack(pack_root: &Path) -> Option<TemplateCatalogEntry> {
    let raw = std::fs::read_to_string(pack_root.join("manifest.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let mut entry = parse_file_template_catalog_entry("homun", &value).ok()?;
    entry.bundled = true;
    entry.template_pack_root = Some(pack_root.to_path_buf());
    entry.preview_ref = imported_template_preview_ref(&entry.id, pack_root);
    entry.preview_html_ref = bundled_template_preview_html_ref(&entry.id, pack_root);
    Some(entry)
}

pub(crate) fn bundled_template_pack_provider() -> Option<BundledTemplatePackProvider> {
    let root = bundled_template_pack_root()?;
    match BundledTemplatePackProvider::from_root(&root) {
        Ok(provider) => Some(provider),
        Err(error) => {
            eprintln!(
                "[template-catalog] ignoring bundled packs under {}: {error}",
                root.display()
            );
            None
        }
    }
}
```

In `main.rs`: aggiungi `mod template_packs;` e in `template_catalog_entries()` metti il provider bundled PRIMA degli altri (vince il dedup per id). Versione TRANSITORIA di questo task (il seed resta vivo fino al Task 7; gli id `homun/*` non collidono coi `monet/*`, quindi il seed non cambia comportamento):

```rust
fn template_catalog_entries() -> Vec<TemplateCatalogEntry> {
    let bundled_provider = template_packs::bundled_template_pack_provider();
    let local = LocalTemplateCatalogProvider;
    let file_provider = file_template_catalog_provider();
    let imported_provider = imported_template_pack_provider();
    let mut providers: Vec<&dyn TemplateCatalogProvider> = Vec::new();
    if let Some(provider) = bundled_provider.as_ref() {
        providers.push(provider);
    }
    providers.push(&local);
    if let Some(provider) = file_provider.as_ref() {
        providers.push(provider);
    }
    if let Some(provider) = imported_provider.as_ref() {
        providers.push(provider);
    }
    collect_template_catalog_entries(&providers)
}
```

(Il Task 7 rimuove le due righe di `local`.)

- [ ] **Step 4: Run — verde**

Run: `cargo test -p local-first-desktop-gateway template_packs -- --nocapture && cargo test -p local-first-desktop-gateway bundled_provider -- --nocapture`
Expected: PASS entrambi; poi `cargo check -p local-first-desktop-gateway` pulito.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/template_packs.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(templates): bundled template pack provider (the Homun catalog source)"
```

---

### Task 3: `template_preview` serve anche `preview.html`

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` — `async fn template_preview` (grep, ~l.46719)
- Test: `mod tests` di main.rs

**Interfaces:**
- Produces: `GET /api/templates/preview?ref=template-pack://<id>/preview.html` → 200 `text/html; charset=utf-8`. Le PNG restano jailed a `thumbnails/*.png`. Ogni altro path → 400.

- [ ] **Step 1: Test fallente**

Serve un test a livello di funzioni pure: la logica di match/jail oggi è inline nell'handler. Estrai la decisione in una funzione testabile e testala:

```rust
#[test]
fn template_preview_relative_paths_are_jailed_to_known_assets() {
    assert_eq!(
        super::template_preview_content_type("thumbnails/slide-001.png"),
        Some("image/png")
    );
    assert_eq!(
        super::template_preview_content_type("preview.html"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(super::template_preview_content_type("thumbnails/evil.svg"), None);
    assert_eq!(super::template_preview_content_type("source.pptx"), None);
    assert_eq!(super::template_preview_content_type("nested/preview.html"), None);
}
```

- [ ] **Step 2: Run — FAIL di compilazione** (`template_preview_content_type` non esiste)

Run: `cargo test -p local-first-desktop-gateway template_preview_relative_paths -- --nocapture`

- [ ] **Step 3: Implementazione**

Sopra `template_preview` in main.rs:

```rust
/// Whitelist of pack-relative assets the preview endpoint may serve. Anything
/// else (source.pptx, nested paths, other extensions) must stay unreachable —
/// this endpoint is outside the bearer layer like /api/ws (an <img>/iframe
/// cannot send the Authorization header).
fn template_preview_content_type(relative_path: &str) -> Option<&'static str> {
    if relative_path == "preview.html" {
        return Some("text/html; charset=utf-8");
    }
    if relative_path.starts_with("thumbnails/")
        && relative_path.ends_with(".png")
        && relative_path.matches('/').count() == 1
    {
        return Some("image/png");
    }
    None
}
```

Nell'handler `template_preview`:
1. il match dell'entry diventa:
```rust
        let matches_entry = entry.preview_ref.as_deref() == Some(reference)
            || entry.preview_html_ref.as_deref() == Some(reference);
        if !matches_entry {
            continue;
        }
```
   (sostituisce il blocco `let Some(internal_preview) = … / if internal_preview != reference`).
2. il blocco `if !relative_path.starts_with("thumbnails/") || !relative_path.ends_with(".png") { … }` diventa:
```rust
        let Some(content_type) = template_preview_content_type(relative_path) else {
            return Err(GatewayError {
                status: StatusCode::BAD_REQUEST,
                code: "template_preview_path_invalid",
                message: "Template preview path is invalid.".to_string(),
            });
        };
```
3. `.header(CONTENT_TYPE, "image/png")` → `.header(CONTENT_TYPE, content_type)`.

⚠️ Verifica com'è autenticato oggi l'endpoint: la UI lo chiama con `gatewayHeaders()` (fetch autenticata) — non cambiare il layer auth, solo il content-type e il match.

- [ ] **Step 4: Run — verde**

Run: `cargo test -p local-first-desktop-gateway template_preview -- --nocapture`
Expected: PASS (nuovo test + i test preview esistenti).

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(templates): preview endpoint serves the pack's live preview.html"
```

---

### Task 4: deck_render.py — layout `timeline`, `comparison`, `team_grid`

**Files:**
- Modify: `runtimes/contained-computer/deck_render.py` — `_html_slide` (~l.128), `_HTML_CSS` (~l.192), il dispatch layout di `render_pptx` (~l.628-665), docstring schema (~l.20-39)
- Create: `runtimes/contained-computer/test_deck_render.py`
- Modify: `scripts/pre_release_gate.py` — la lista Step con `-m unittest` (grep `test_eval_suite`, ~l.62)

**Interfaces:**
- Produces: tre layout nuovi nello schema deck.json: `{"layout":"timeline","title","items":[{"label","title","text"}]}`, `{"layout":"comparison","title","headers":[…],"rows":[[…]]}`, `{"layout":"team_grid","title","members":[{"name","role"}]}` — resi sia in HTML sia in PPTX. Helper `_initials(name)`.

- [ ] **Step 1: Test fallente**

`runtimes/contained-computer/test_deck_render.py` (stdlib-only per l'HTML; i test PPTX si auto-skippano se python-pptx manca sull'host — nel container c'è sempre):

```python
"""Renderer contract tests. HTML tests are stdlib-only so they run on any host;
PPTX tests skip when python-pptx is absent (it lives in the contained computer)."""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("deck_render", os.path.join(HERE, "deck_render.py"))
deck_render = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(deck_render)

ALL_LAYOUTS_DECK = {
    "title": "T",
    "slides": [
        {"layout": "cover", "title": "T", "subtitle": "S"},
        {"layout": "timeline", "title": "Roadmap", "items": [
            {"label": "Q3", "title": "Ship", "text": "Self-serve"},
            {"label": "Q4", "title": "Scale", "text": "EU launch"},
        ]},
        {"layout": "comparison", "title": "Risks", "headers": ["Risk", "Impact"],
         "rows": [["Fuel", "High"], ["Churn", "Low"]]},
        {"layout": "team_grid", "title": "Team", "members": [
            {"name": "Elena Ricci", "role": "CEO"},
            {"name": "Marco Chen", "role": "CTO"},
        ]},
        {"layout": "closing", "title": "Next", "bullets": ["a"]},
    ],
}


class RenderHtmlLayouts(unittest.TestCase):
    def test_new_layouts_render_and_css_formats(self):
        # Also guards the _HTML_CSS .format() contract: an unescaped { in new CSS
        # raises KeyError/IndexError here.
        html = deck_render.render_html(ALL_LAYOUTS_DECK, HERE)
        self.assertIn('class="tl-item"', html)
        self.assertIn("Q3", html)
        self.assertIn('<table class="cmp">', html)
        self.assertIn("<th>Risk</th>", html)
        self.assertIn('class="member"', html)
        self.assertIn(">ER<", html)  # initials avatar for Elena Ricci

    def test_initials(self):
        self.assertEqual(deck_render._initials("Elena Ricci"), "ER")
        self.assertEqual(deck_render._initials("Cher"), "C")
        self.assertEqual(deck_render._initials(""), "")


@unittest.skipUnless(
    importlib.util.find_spec("pptx"), "python-pptx not installed on this host"
)
class RenderPptxLayouts(unittest.TestCase):
    def test_new_layouts_produce_slides(self):
        import tempfile
        from pptx import Presentation
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "deck.pptx")
            stats = deck_render.render_pptx(ALL_LAYOUTS_DECK, tmp, out)
            self.assertIsNotNone(stats)
            prs = Presentation(out)
            self.assertEqual(len(prs.slides), len(ALL_LAYOUTS_DECK["slides"]))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run — verifica che fallisca**

Run: `python3 -m unittest discover -s runtimes/contained-computer -p 'test_deck_render.py' -v`
Expected: FAIL (`class="tl-item"` assente, `_initials` inesistente).

- [ ] **Step 3: Implementazione HTML**

In deck_render.py, helper accanto a `_bullets_html`:

```python
def _initials(name):
    parts = [p for p in str(name or "").split() if p]
    return "".join(p[0].upper() for p in parts[:2])
```

In `_html_slide`, PRIMA del ramo default `bullets`:

```python
    if layout == "timeline":
        items = s.get("items", [])[:6]
        rows = "".join(
            f'<div class="tl-item"><div class="tl-label">{html_escape(i.get("label", ""))}</div>'
            f'<div class="tl-dot"></div>'
            f'<div class="tl-text"><strong>{html_escape(i.get("title", ""))}</strong>'
            f'<span>{html_escape(i.get("text", ""))}</span></div></div>'
            for i in items
        )
        return (
            f'<section class="slide timeline">{_logo_html(logo)}'
            f'<h2>{title}</h2><div class="tl">{rows}</div>'
            f'<div class="accent-bar"></div></section>'
        )
    if layout == "comparison":
        headers = s.get("headers", [])[:4]
        rows = s.get("rows", [])[:8]
        head = "".join(f"<th>{html_escape(h)}</th>" for h in headers)
        body_rows = "".join(
            "<tr>" + "".join(f"<td>{html_escape(c)}</td>" for c in row[: len(headers) or 4]) + "</tr>"
            for row in rows
        )
        return (
            f'<section class="slide comparison">{_logo_html(logo)}'
            f'<h2>{title}</h2><table class="cmp"><thead><tr>{head}</tr></thead>'
            f"<tbody>{body_rows}</tbody></table>"
            f'<div class="accent-bar"></div></section>'
        )
    if layout == "team_grid":
        members = s.get("members", [])[:8]
        cells = "".join(
            f'<div class="member"><div class="avatar">{html_escape(_initials(m.get("name", "")))}</div>'
            f'<strong>{html_escape(m.get("name", ""))}</strong>'
            f'<span>{html_escape(m.get("role", ""))}</span></div>'
            for m in members
        )
        return (
            f'<section class="slide team">{_logo_html(logo)}'
            f'<h2>{title}</h2><div class="team-grid">{cells}</div>'
            f'<div class="accent-bar"></div></section>'
        )
```

In `_HTML_CSS` (⚠️ è un template `.format()`: OGNI graffa CSS letterale va RADDOPPIATA `{{ }}` come nelle regole esistenti):

```css
.tl{{display:flex;flex-direction:column;gap:1.15rem;margin-top:1.3rem}}
.tl-item{{display:grid;grid-template-columns:92px 18px 1fr;align-items:start;gap:1.1rem}}
.tl-label{{font-weight:800;color:var(--brand);font-size:1.15rem;text-align:right}}
.tl-dot{{width:14px;height:14px;border-radius:50%;background:var(--accent);margin-top:.28rem;position:relative}}
.tl-item:not(:last-child) .tl-dot::after{{content:"";position:absolute;left:6px;top:17px;width:2px;height:2.6rem;background:#dfe5ec}}
.tl-text strong{{font-size:1.25rem}}
.tl-text span{{display:block;color:var(--muted);font-size:1.05rem;margin-top:.18rem}}
table.cmp{{width:100%;border-collapse:collapse;margin-top:1.3rem;font-size:1.15rem}}
table.cmp th{{text-align:left;background:var(--brand);color:#fff;padding:.7rem .95rem;font-weight:700}}
table.cmp td{{padding:.68rem .95rem;color:var(--muted);border-bottom:1px solid #e4e9ef}}
table.cmp tr:nth-child(even) td{{background:#f6f8fa}}
.team-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1.7rem;margin-top:1.5rem}}
.member{{display:flex;flex-direction:column;align-items:flex-start;gap:.4rem}}
.member .avatar{{width:64px;height:64px;border-radius:50%;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.3rem}}
.member strong{{font-size:1.2rem}}
.member span{{color:var(--muted);font-size:1rem}}
```

Aggiorna la docstring dello schema (righe ~29-38) con i tre layout nuovi.

- [ ] **Step 4: Implementazione PPTX**

Nel dispatch di `render_pptx`, prima del ramo `else:  # bullets` (usa SOLO i nomi già in scope: `brand`, `accent`, `muted`, `white`, `head_font`, `body_font`, `textbox`, `Inches`, `Pt`, `slide`):

```python
        elif layout == "timeline":
            top = 2.0
            for it in s.get("items", [])[:6]:
                textbox(slide, Inches(0.9), Inches(top), Inches(1.5), Inches(0.8),
                        [(it.get("label", ""), 18, brand, head_font, True, False)])
                dot = slide.shapes.add_shape(9, Inches(2.55), Inches(top + 0.08),
                                             Pt(11), Pt(11))  # 9 = MSO oval
                dot.fill.solid()
                dot.fill.fore_color.rgb = accent
                dot.line.fill.background()
                dot.shadow.inherit = False
                runs = [(it.get("title", ""), 17, brand, head_font, True, False)]
                if it.get("text"):
                    runs.append((it.get("text", ""), 14, muted, body_font, False, False))
                textbox(slide, Inches(3.0), Inches(top), Inches(9.3), Inches(0.95), runs)
                top += 0.95
        elif layout == "comparison":
            headers = s.get("headers", [])[:4]
            rows = s.get("rows", [])[:8]
            if headers and rows:
                shape = slide.shapes.add_table(
                    len(rows) + 1, len(headers),
                    Inches(0.9), Inches(1.9), Inches(11.5),
                    Inches(min(4.6, 0.55 + 0.5 * len(rows))))
                table = shape.table
                for c, h in enumerate(headers):
                    table.cell(0, c).text = str(h)
                for r, row in enumerate(rows, start=1):
                    for c, cell_text in enumerate(row[: len(headers)]):
                        table.cell(r, c).text = str(cell_text)
                for row_cells in table.rows:
                    for cell in row_cells.cells:
                        for paragraph in cell.text_frame.paragraphs:
                            for run in paragraph.runs:
                                run.font.size = Pt(13)
                                run.font.name = body_font
        elif layout == "team_grid":
            members = s.get("members", [])[:8]
            per_row = 4 if len(members) > 4 else max(len(members), 1)
            col_w = 11.5 / per_row
            for i, m in enumerate(members):
                row_i, col_i = divmod(i, per_row)
                left = 0.9 + col_i * col_w
                top = 2.1 + row_i * 2.3
                avatar = slide.shapes.add_shape(9, Inches(left), Inches(top),
                                                Inches(0.85), Inches(0.85))
                avatar.fill.solid()
                avatar.fill.fore_color.rgb = brand
                avatar.line.fill.background()
                avatar.shadow.inherit = False
                avatar.text_frame.text = _initials(m.get("name", ""))
                textbox(slide, Inches(left), Inches(top + 0.95),
                        Inches(col_w - 0.3), Inches(1.1),
                        [(m.get("name", ""), 16, brand, head_font, True, False),
                         (m.get("role", ""), 13, muted, body_font, False, False)])
```

⚠️ Prima di scrivere i rami, RILEGGI le firme reali di `textbox`/`add_slide`/i nomi colore in `render_pptx` (grep `def textbox`, `white =`, `muted =`): se differiscono da quanto sopra, adatta i rami — la struttura resta.

- [ ] **Step 5: Run — verde**

Run: `python3 -m unittest discover -s runtimes/contained-computer -p 'test_deck_render.py' -v`
Expected: PASS (HTML sempre; PPTX PASS o SKIP se python-pptx assente sull'host).

- [ ] **Step 6: Cabla i test nel gate**

In `scripts/pre_release_gate.py`, accanto allo Step unittest esistente aggiungi:

```python
        Step(
            "deck renderer tests",
            [PYTHON, "-m", "unittest", "discover", "-s",
             "runtimes/contained-computer", "-p", "test_deck_render.py"],
        ),
```

Run: `python3 -m py_compile scripts/pre_release_gate.py && python3 -m unittest scripts.test_pre_release_gate` per verificare che lo script resti valido; il gate completo gira nel Task 10.

- [ ] **Step 7: Commit**

```bash
git add runtimes/contained-computer/deck_render.py runtimes/contained-computer/test_deck_render.py scripts/pre_release_gate.py
git commit -m "feat(deck-render): timeline, comparison and team_grid layouts (html+pptx) with contract tests"
```

---

### Task 5: `scripts/build_template_previews.py`

**Files:**
- Create: `scripts/build_template_previews.py`

**Interfaces:**
- Consumes: `deck_render.render_html` (import per path), i pack in `templates/<slug>/{manifest.json,example.json}`.
- Produces: per ogni pack, `preview.html` + `thumbnails/slide-00N.png` (max 6). CLI: `python3 scripts/build_template_previews.py [--only <slug>] [--skip-thumbnails]`.

- [ ] **Step 1: Scrivi lo script**

```python
#!/usr/bin/env python3
"""Regenerate the committed preview assets of the bundled template packs.

Preview = TRUTH: every pack's preview.html/thumbnails are produced by the REAL
renderer (deck_render.render_html) on the pack's curated example.json, so the
catalog card shows exactly what make_deck will produce. Assets are committed —
the app and CI never need Chromium/poppler; this script is a dev-time tool run
only when a pack's design or example changes.

Usage:
    python3 scripts/build_template_previews.py [--only <slug>] [--skip-thumbnails]

Thumbnails need a Chromium binary (HOMUN_CHROMIUM_BIN overrides discovery) and
pdftoppm (poppler). Without them, run with --skip-thumbnails and regenerate the
PNGs on a machine that has both.
"""
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES_DIR = os.path.join(REPO_ROOT, "templates")
RENDERER = os.path.join(REPO_ROOT, "runtimes", "contained-computer", "deck_render.py")
MAX_THUMBNAILS = 6

CHROME_CANDIDATES = [
    os.environ.get("HOMUN_CHROMIUM_BIN"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "chromium",
    "chromium-browser",
]


def load_renderer():
    spec = importlib.util.spec_from_file_location("deck_render", RENDERER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def find_chromium():
    for candidate in CHROME_CANDIDATES:
        if not candidate:
            continue
        path = candidate if os.path.isabs(candidate) else shutil.which(candidate)
        if path and os.path.exists(path):
            return path
    return None


def build_thumbnails(pack_dir, html_path):
    chromium = find_chromium()
    if not chromium or not shutil.which("pdftoppm"):
        sys.exit(
            "thumbnails need Chromium (set HOMUN_CHROMIUM_BIN) and pdftoppm (poppler); "
            "re-run with --skip-thumbnails to only rebuild preview.html"
        )
    thumbs = os.path.join(pack_dir, "thumbnails")
    shutil.rmtree(thumbs, ignore_errors=True)
    os.makedirs(thumbs)
    with tempfile.TemporaryDirectory() as tmp:
        pdf = os.path.join(tmp, "preview.pdf")
        subprocess.run(
            [chromium, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
             f"--print-to-pdf={pdf}", f"file://{os.path.abspath(html_path)}"],
            check=True, capture_output=True)
        subprocess.run(
            ["pdftoppm", "-png", "-r", "96", "-f", "1", "-l", str(MAX_THUMBNAILS),
             pdf, os.path.join(tmp, "slide")],
            check=True, capture_output=True)
        pages = sorted(p for p in os.listdir(tmp) if p.startswith("slide") and p.endswith(".png"))
        for index, page in enumerate(pages, start=1):
            shutil.copyfile(os.path.join(tmp, page),
                            os.path.join(thumbs, f"slide-{index:03d}.png"))
    return len(pages)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", help="rebuild a single pack slug")
    ap.add_argument("--skip-thumbnails", action="store_true")
    args = ap.parse_args()

    renderer = load_renderer()
    slugs = sorted(
        slug for slug in os.listdir(TEMPLATES_DIR)
        if os.path.isfile(os.path.join(TEMPLATES_DIR, slug, "example.json"))
    ) if os.path.isdir(TEMPLATES_DIR) else []
    if args.only:
        slugs = [slug for slug in slugs if slug == args.only]
    if not slugs:
        sys.exit(f"no template packs with example.json under {TEMPLATES_DIR}")

    for slug in slugs:
        pack_dir = os.path.join(TEMPLATES_DIR, slug)
        with open(os.path.join(pack_dir, "example.json"), "r", encoding="utf-8") as fh:
            deck = json.load(fh)
        html = renderer.render_html(deck, pack_dir)
        html_path = os.path.join(pack_dir, "preview.html")
        with open(html_path, "w", encoding="utf-8") as fh:
            fh.write(html)
        pages = 0 if args.skip_thumbnails else build_thumbnails(pack_dir, html_path)
        print(f"{slug}: preview.html ok, {pages} thumbnail(s)")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verifica sintassi**

Run: `python3 -m py_compile scripts/build_template_previews.py && python3 scripts/build_template_previews.py --skip-thumbnails; echo "exit=$?"`
Expected: compila; il run esce con errore "no template packs…" (i pack arrivano nel Task 6) — è il comportamento atteso ORA.

- [ ] **Step 3: Commit**

```bash
git add scripts/build_template_previews.py
git commit -m "feat(templates): build_template_previews script — committed previews from the real renderer"
```

---

### Task 6: I due pack presentazione (manifest + example.json + preview committate)

**Files:**
- Create: `templates/startup-pitch-clean-01/manifest.json`, `templates/startup-pitch-clean-01/example.json`
- Create: `templates/executive-update-board-01/manifest.json`, `templates/executive-update-board-01/example.json`
- Generated (da committare): `templates/*/preview.html`, `templates/*/thumbnails/slide-00N.png`

**Interfaces:**
- Produces: id catalogo `homun/startup-pitch-clean-01` (theme clean_corporate) e `homun/executive-update-board-01` (theme high_contrast) — gli id che Task 7 usa nei test e nelle description dei tool.

- [ ] **Step 1: Pack pitch — manifest**

`templates/startup-pitch-clean-01/manifest.json`:

```json
{
  "id": "homun/startup-pitch-clean-01",
  "kind": "presentation",
  "name": "Startup Pitch Clean",
  "name_it": "Pitch startup essenziale",
  "description": "Clean startup pitch deck for product intro, fundraising or customer pitch.",
  "description_it": "Pitch deck pulito per presentare prodotto, raccolta fondi o clienti.",
  "design_template": "startup_pitch",
  "design_theme": "clean_corporate",
  "design_profile": "sales_pitch",
  "design_components": ["kpi_grid", "timeline", "comparison_table"],
  "layout_archetypes": ["cover", "bullets", "two_column", "kpi", "comparison", "team_grid", "timeline", "closing"],
  "tags": ["clean corporate", "sales pitch", "kpi grid", "timeline"],
  "use_cases": ["pitch", "fundraising", "product intro"],
  "audience": ["investors", "executives", "customers"],
  "intake_questions": [
    "What is the company or product, in one line?",
    "Who is the audience (investors, customer, internal) and what is the ask?",
    "Which 2-3 numbers prove traction today?"
  ],
  "route_text": "startup pitch deck fundraising investor presentazione prodotto traction team roadmap ask seed round"
}
```

Nota: `layout_archetypes` ora elenca SOLO layout fisici reali del renderer (l'allineamento di vocabolario della spec). `intake_questions` è forward-compat (la cabla F2): il parser la ignora.

- [ ] **Step 2: Pack pitch — example.json (contenuto curato, fittizio ma credibile)**

`templates/startup-pitch-clean-01/example.json`:

```json
{
  "title": "Kite Analytics",
  "subtitle": "Operational intelligence for mid-size manufacturers",
  "theme": {
    "primary": "#16436b",
    "secondary": "#0c2233",
    "accent": "#14b8a6",
    "heading_font": "Inter",
    "body_font": "Inter"
  },
  "slides": [
    { "layout": "cover", "title": "Kite Analytics", "subtitle": "Operational intelligence for mid-size manufacturers" },
    { "layout": "bullets", "title": "The problem", "bullets": [
      "Production data lives in six disconnected tools",
      "Plant managers decide on week-old spreadsheets",
      "Downtime costs surface only when the quarter closes"
    ] },
    { "layout": "two_column", "title": "Our solution", "columns": [
      { "title": "Connect", "bullets": ["Plug-and-play adapters for PLCs and MES", "No new hardware on the line"] },
      { "title": "Decide", "bullets": ["Live cost-of-downtime dashboard", "Alerts routed to the right shift lead"] }
    ] },
    { "layout": "kpi", "title": "Traction", "kpi": "38%", "kpi_label": "average downtime reduction across 24 pilot plants" },
    { "layout": "comparison", "title": "Why we win", "headers": ["", "Spreadsheets", "Legacy MES", "Kite"], "rows": [
      ["Setup time", "weeks", "months", "2 days"],
      ["Live data", "no", "partial", "yes"],
      ["Cost per plant", "hidden", "high", "low"]
    ] },
    { "layout": "team_grid", "title": "Team", "members": [
      { "name": "Elena Ricci", "role": "CEO — former plant director" },
      { "name": "Marco Chen", "role": "CTO — industrial IoT" },
      { "name": "Sara Novak", "role": "Head of Sales — B2B SaaS" },
      { "name": "Luca Ferri", "role": "Lead Engineer — data platforms" }
    ] },
    { "layout": "timeline", "title": "Roadmap", "items": [
      { "label": "Q3", "title": "Self-serve onboarding", "text": "From pilot to paid in one week" },
      { "label": "Q4", "title": "Predictive alerts", "text": "Failure-risk scoring on live signals" },
      { "label": "Q1", "title": "EU expansion", "text": "DACH go-to-market with two partners" }
    ] },
    { "layout": "closing", "title": "The ask", "bullets": [
      "€1.5M seed to reach 100 plants",
      "Introductions to manufacturing operators",
      "Pilot slots open for Q4"
    ] }
  ]
}
```

- [ ] **Step 3: Pack executive update — manifest**

`templates/executive-update-board-01/manifest.json`:

```json
{
  "id": "homun/executive-update-board-01",
  "kind": "presentation",
  "name": "Executive Update Board",
  "name_it": "Aggiornamento executive per il board",
  "description": "Board-ready executive update with metrics, risks, decisions and next steps.",
  "description_it": "Aggiornamento executive pronto per il board: metriche, rischi, decisioni e prossimi passi.",
  "design_template": "executive_update",
  "design_theme": "high_contrast",
  "design_profile": "executive",
  "design_components": ["kpi_grid", "risks_table"],
  "layout_archetypes": ["cover", "kpi", "bullets", "comparison", "two_column", "closing"],
  "tags": ["high contrast", "executive", "kpi grid", "risks table"],
  "use_cases": ["board update", "status update", "management review"],
  "audience": ["board", "executives", "leadership"],
  "intake_questions": [
    "Which period and company/unit is this update about?",
    "What are the 2-3 headline numbers and how do they compare to target?",
    "Which risks and pending decisions must the board see?"
  ],
  "route_text": "executive update board review status report metriche rischi decisioni next steps trimestre CDA"
}
```

- [ ] **Step 4: Pack executive update — example.json**

`templates/executive-update-board-01/example.json`:

```json
{
  "title": "Q3 Executive Update",
  "subtitle": "Aurora Logistics — Board review, October",
  "theme": {
    "primary": "#101828",
    "secondary": "#1d2939",
    "accent": "#fbbf24",
    "heading_font": "Inter",
    "body_font": "Inter"
  },
  "slides": [
    { "layout": "cover", "title": "Q3 Executive Update", "subtitle": "Aurora Logistics — Board review, October" },
    { "layout": "kpi", "title": "Status", "kpi": "+12.4%", "kpi_label": "revenue vs Q2 — at 94% of the Q3 target" },
    { "layout": "bullets", "title": "Highlights", "bullets": [
      "Two enterprise renewals closed early (€480k ARR)",
      "New Milan hub operational three weeks ahead of plan",
      "Churn down to 1.1% after the support restructure"
    ] },
    { "layout": "comparison", "title": "Risks", "headers": ["Risk", "Impact", "Owner", "Mitigation"], "rows": [
      ["Fuel cost volatility", "High", "COO", "Hedging contract signed for H1"],
      ["Driver shortage in DACH", "Medium", "HR", "Partner agency plus retention bonus"],
      ["Customs API migration", "Medium", "CTO", "Dual-run until January"]
    ] },
    { "layout": "two_column", "title": "Decisions needed", "columns": [
      { "title": "Approve", "bullets": ["Budget for two senior ops hires", "Milan hub phase-2 automation"] },
      { "title": "Discuss", "bullets": ["Pricing review for the SMB tier", "2027 fleet electrification pace"] }
    ] },
    { "layout": "closing", "title": "Next steps", "bullets": [
      "Q4 target locked at +9% with current pipeline",
      "Hiring plan review at the November board call",
      "Fleet RFP results circulated by end of month"
    ] }
  ]
}
```

- [ ] **Step 5: Genera le preview e verifica a occhio**

Run: `python3 scripts/build_template_previews.py`
Expected: `startup-pitch-clean-01: preview.html ok, 6 thumbnail(s)` e `executive-update-board-01: preview.html ok, 6 thumbnail(s)`.
Apri i due `preview.html` nel browser e le PNG: se un layout è visivamente rotto (overflow, spaziature), sistemare il CSS del Task 4 PRIMA di committare (le preview committate sono la vetrina del prodotto).

- [ ] **Step 6: Verifica che il gateway li veda (fallback dev)**

Run: `cargo test -p local-first-desktop-gateway bundled -- --nocapture`
Expected: PASS. Aggiungi in `template_packs.rs::tests` il test d'integrazione col repo:

```rust
    #[test]
    fn repo_templates_dir_ships_the_v1_presentation_packs() {
        let root = bundled_template_pack_root().expect("repo templates dir");
        let provider = BundledTemplatePackProvider::from_root(&root).expect("provider");
        let ids: Vec<String> = crate::TemplateCatalogProvider::entries(&provider)
            .into_iter()
            .map(|entry| entry.id)
            .collect();
        assert!(ids.contains(&"homun/startup-pitch-clean-01".to_string()));
        assert!(ids.contains(&"homun/executive-update-board-01".to_string()));
    }
```

Run di nuovo il filtro `bundled`: PASS.

- [ ] **Step 7: Commit (inclusi gli asset generati)**

```bash
git add templates/ crates/desktop-gateway/src/template_packs.rs
git commit -m "feat(templates): ship the two v1 presentation packs with real rendered previews"
```

---

### Task 7: Morte del seed hardcoded + migrazione riferimenti `monet/*`

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` — cancella `local_template_catalog_seed` (grep, ~l.6976-7198), `LocalTemplateCatalogProvider` (~l.6775 + impl ~l.7200), `template_catalog_builtin_preview_ref` + `with_builtin_template_preview` (~l.6964-6974), e il costruttore `template_catalog_entry(` se resta orfano (il compilatore lo dice); togli `local` da `template_catalog_entries()`; aggiorna le description dei tool schema (grep `monet/startup-pitch-clean-01` e `monet/sales-proposal-warm-01`, ~l.16771/16797) e TUTTI i test `monet` (grep -n "monet" per l'elenco completo)

**Interfaces:**
- Consumes: i pack del Task 6 (i test girano sul fallback dev `templates/` in repo).
- Produces: catalogo built-in = SOLO pack bundled; `template_ref` d'esempio nei tool schema = `homun/startup-pitch-clean-01`.

- [ ] **Step 1: Cancella il seed e i suoi helper**

Rimuovi le funzioni elencate sopra; in `template_catalog_entries()` togli `LocalTemplateCatalogProvider`. Poi:

Run: `cargo check -p local-first-desktop-gateway 2>&1 | head -40`
Expected: errori SOLO nei test che referenziano i simboli morti — è l'elenco di lavoro dello Step 2. Se un errore tocca codice di produzione fuori dal perimetro previsto, FERMATI e rivaluta (non cancellare altro a cascata senza capire).

- [ ] **Step 2: Migra i test uno a uno** (`grep -n "monet\|local_seed\|LocalTemplateCatalogProvider" crates/desktop-gateway/src/main.rs`)

1. `template_catalog_entries_are_searchable_but_not_callable` (~l.54169): l'assert sull'entry key diventa `assert_eq!(entry.key, "homun/startup-pitch-clean-01");` (l'entry va cercata per id, non per posizione, se il test indicizzava).
2. Il test del provider seed (~l.54764-54783, quello che asserisce gli id `monet/*` e `provider == "local_seed"`): CANCELLALO — è sostituito da `repo_templates_dir_ships_the_v1_presentation_packs` (Task 6) e dai test del Task 2.
3. `template_catalog_entries_include_imported_template_packs_after_seed_templates` (~l.54910): sostituisci `&super::LocalTemplateCatalogProvider` con un `BundledTemplatePackProvider` costruito da `bundled_template_pack_root()` e rinomina in `…_after_bundled_templates`; le asserzioni d'ordinamento/dedup restano.
4. Il test analogo a ~l.55278: stessa sostituzione.
5. Il test a ~l.55433 (usa `entries(&LocalTemplateCatalogProvider)`): riscrivilo sul provider bundled; se asseriva contenuti specifici del seed (es. selection_notes di un template morto), punta a `homun/startup-pitch-clean-01` con i valori del manifest reale.
6. Il test make_deck template_ref (~l.53865/53898): `"template_ref": "monet/executive-update-board-01"` → `"homun/executive-update-board-01"`; gli expected `design_*` diventano quelli del manifest reale: `design_template == "executive_update"`, `design_theme == Some("high_contrast")`, `design_profile == Some("executive")`.
7. Tool schema descriptions (~l.16771 make_deck, ~l.16797 make_document): sostituisci gli esempi `monet/startup-pitch-clean-01` → `homun/startup-pitch-clean-01` e `monet/sales-proposal-warm-01` → `homun/executive-update-board-01` (finché F2 non spedisce un pack document).

- [ ] **Step 3: Run — tutto verde**

Run: `cargo test -p local-first-desktop-gateway`
Expected: PASS totale, ZERO riferimenti residui: `grep -c "monet" crates/desktop-gateway/src/main.rs` → `0`.

- [ ] **Step 4: Verifica il delta dimensione**

Run: `wc -l crates/desktop-gateway/src/main.rs` prima/dopo il task (annota nel commit): il file DEVE essersi ridotto (~-250 righe di seed contro ~+40 di edit).

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "refactor(templates): delete the hardcoded monet seed — bundled packs are the only built-in source"
```

---

### Task 8: Electron env + packaging dei pack

**Files:**
- Modify: `apps/desktop/electron/main.cjs` — `spawnGateway()` (grep `HOMUN_DEFAULT_SKILLS_DIR`, ~l.305)
- Modify: `apps/desktop/scripts/prepare-package.mjs` — accanto alla copia `default-skills` (grep `skillsTarget`, ~l.72)

**Interfaces:**
- Produces: app pacchettizzata con `<resources>/templates/` e gateway avviato con `HOMUN_BUNDLED_TEMPLATES_DIR` puntato lì. In dev nessun env (fallback repo del Task 2).

- [ ] **Step 1: main.cjs**

Dopo il blocco `HOMUN_DEFAULT_SKILLS_DIR` in `spawnGateway()`:

```js
  // Point the gateway at the bundled deliverable template packs (the "Homun"
  // source of the Presentations catalog). Same dev/packaged story as above; in
  // dev the gateway falls back to the repo-relative templates/ dir on its own.
  if (!env.HOMUN_BUNDLED_TEMPLATES_DIR) {
    const templatesDir = path.join(RESOURCES_ROOT, "templates");
    if (fs.existsSync(templatesDir)) env.HOMUN_BUNDLED_TEMPLATES_DIR = templatesDir;
  }
```

- [ ] **Step 2: prepare-package.mjs**

Dopo il blocco di copia dei default-skills (stesse utility `join`/`existsSync`/`cpSync` già importate lì):

```js
// Stage the bundled deliverable template packs (the "Homun" source of the
// Presentations catalog). The gateway is pointed here via
// HOMUN_BUNDLED_TEMPLATES_DIR (see main.cjs). Committed previews included —
// no Chromium/poppler needed at package time.
const templatesSource = join(repoRoot, "templates");
const templatesTarget = join(resourcesDir, "templates");
if (!existsSync(templatesSource)) {
  throw new Error(`Bundled template packs not found: ${templatesSource}`);
}
cpSync(templatesSource, templatesTarget, { recursive: true });
```

(Hard throw come per contained-computer, non il soft-if degli skills: dopo il Task 6 i pack sono un asset di prodotto obbligatorio.)

- [ ] **Step 3: Verifica**

Run: `cd apps/desktop && npm run test:electron`
Expected: PASS (il test checkJs `electron-main-names` copre il nuovo codice di main.cjs — un nome sbagliato fallisce qui).
Run: `node scripts/prepare-package.mjs --skip-build && ls .package/resources/templates`
Expected: le due directory pack. (Se `--skip-build` non salta il build del gateway, usa l'invocazione più economica che lo script supporta — leggi l'header dello script.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron/main.cjs apps/desktop/scripts/prepare-package.mjs
git commit -m "feat(desktop): bundle template packs into resources and point the gateway at them"
```

---

### Task 9: UI — anteprime HTML vive, nomi localizzati, morte delle card sintetiche

**Files:**
- Modify: `apps/desktop/src/lib/coreBridge.ts` — interfaccia `TemplateCatalogEntry` (~l.2635), nuova `templatePreviewHtml` accanto a `electronTemplatePreviewBlobUrl` (~l.2728) e registrazione nel bridge (~l.2979)
- Modify: `apps/desktop/src/components/BrandKitPanel.tsx` — `TemplateCardPreview` (~l.675), `TemplateDetailModal` (~l.581), rimozione ramo builtin + `templateThemeClass` (~l.766-817)
- Modify: `apps/desktop/src/styles.css` — nuove classi `.template-live-preview`

**Interfaces:**
- Consumes: `preview_html_ref`/`name_it`/`description_it` dalla response (Task 1), endpoint HTML (Task 3).
- Produces: `coreBridge.templatePreviewHtml(previewRef: string): Promise<string>`; componente `TemplateLivePreview({ entry, interactive? })`; helper `templateDisplayName(entry, language)` / `templateDisplayDescription(entry, language)`.

- [ ] **Step 1: coreBridge**

In `TemplateCatalogEntry` aggiungi:

```ts
  name_it: string | null;
  description_it: string | null;
  preview_html_ref: string | null;
```

Nuova funzione accanto a `electronTemplatePreviewBlobUrl`:

```ts
async function electronTemplatePreviewHtml(previewRef: string): Promise<string> {
  const url = electronTemplatePreviewUrl(previewRef);
  const response = await fetch(url, { headers: gatewayHeaders() });
  if (!response.ok) {
    throw new Error(`Template preview unavailable: HTTP ${response.status}`);
  }
  return response.text();
}
```

Registrala nell'oggetto bridge accanto a `templatePreviewBlobUrl`:

```ts
  templatePreviewHtml: (previewRef: string) => electronTemplatePreviewHtml(previewRef),
```

(se esiste una seconda impl del bridge — web/self-hosted — il compilatore TS elenca dove aggiungerla; replica lo stesso pattern della sibling function).

- [ ] **Step 2: TemplateLivePreview + localizzazione in BrandKitPanel.tsx**

Helper in cima al file (dopo `TEMPLATE_SOURCE_LINKS`):

```tsx
/** EN-canonical catalog + flat Italian override: the reply-language contract for
 *  the catalog surface (Settings language only picks which string to show). */
function templateDisplayName(entry: TemplateCatalogEntry, language: string): string {
  return language.startsWith("it") && entry.name_it ? entry.name_it : entry.name;
}

function templateDisplayDescription(entry: TemplateCatalogEntry, language: string): string {
  return language.startsWith("it") && entry.description_it
    ? entry.description_it
    : entry.description;
}
```

Nuovo componente (sostituisce il ramo builtin, che va CANCELLATO insieme a `templateThemeClass` e al blocco `canRenderBuiltin`):

```tsx
/** Embeds the pack's REAL renderer output (preview.html) scaled into the card.
 *  sandbox="" = no scripts, no same-origin: the HTML is trusted (we build it)
 *  but the cheapest posture wins. Card mode is inert (pointer-events none);
 *  interactive mode (detail modal) lets the user scroll through the pages. */
function TemplateLivePreview({
  entry,
  interactive = false,
}: {
  entry: TemplateCatalogEntry;
  interactive?: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [scale, setScale] = useState(0.2);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    setHtml(null);
    setFailed(false);
    if (!entry.preview_html_ref) {
      setFailed(true);
      return undefined;
    }
    void coreBridge
      .templatePreviewHtml(entry.preview_html_ref)
      .then((text) => {
        if (active) setHtml(text);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [entry.preview_html_ref]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0) setScale(el.clientWidth / 1280);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [html]);

  if (failed) return <TemplateRasterOrContractPreview entry={entry} />;
  if (!html) {
    return (
      <div className="template-card-preview template-preview-loading">
        <div className="template-preview-shimmer" />
        <div className="template-preview-loading-lines">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }
  return (
    <div
      ref={wrapRef}
      className={`template-card-preview template-live-preview${interactive ? " interactive" : ""}`}
    >
      <iframe
        sandbox=""
        srcDoc={html}
        title=""
        tabIndex={-1}
        aria-hidden
        style={{
          transform: `scale(${scale})`,
          height: interactive ? `${Math.round(560 / scale)}px` : "720px",
        }}
      />
    </div>
  );
}
```

Ristruttura `TemplateCardPreview` così (la logica raster/blob esistente resta identica, si sposta solo nel fallback):

```tsx
function TemplateCardPreview({ entry }: { entry: TemplateCatalogEntry }) {
  if (entry.preview_html_ref) return <TemplateLivePreview entry={entry} />;
  return <TemplateRasterOrContractPreview entry={entry} />;
}
```

dove `TemplateRasterOrContractPreview` = il corpo ATTUALE di `TemplateCardPreview` senza il ramo `canRenderBuiltin` (che muore: blob-fetch raster per gli importati + card "contract" testuale come ultimo fallback). Aggiorna gli import React (`useRef`) e rimuovi gli import rimasti orfani.

Uso dei nomi localizzati: nei punti dove si renderizza `entry.name`/`entry.description` (card body, modal, aria-label) usa `templateDisplayName(entry, i18n.language)` / `templateDisplayDescription(entry, i18n.language)` — ottieni `i18n` da `useTranslation()` già presente. ⚠️ NON toccare `handleStartTemplateWorkflow` in App.tsx: il prompt operativo resta sull'`entry.name` EN canonico.

Nel `TemplateDetailModal`: `template-detail-preview` usa `<TemplateLivePreview entry={entry} interactive />` quando `entry.preview_html_ref` esiste (altrimenti il raster attuale); CANCELLA il blocco `template-detail-strip` (sfogliava le card sintetiche morte — la preview interattiva scrolla tutte le pagine).

- [ ] **Step 3: CSS**

In `styles.css`, vicino alle regole `.template-card-preview` esistenti:

```css
.template-live-preview {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: #fff;
}
.template-live-preview iframe {
  width: 1280px;
  height: 720px;
  border: 0;
  transform-origin: top left;
  pointer-events: none;
}
.template-live-preview.interactive {
  aspect-ratio: auto;
  height: 560px;
}
.template-live-preview.interactive iframe {
  pointer-events: auto;
}
```

- [ ] **Step 4: Verifica**

Run: `cd apps/desktop && npm run build && npm run test:ui-contract`
Expected: build verde (tsc trova ogni uso dimenticato dei campi nuovi); ui-contract verde — se segnala chiavi i18n orfane del ramo sintetico rimosso, rimuovile da `src/plugins/presentations/locales/{en,it}.json`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/coreBridge.ts apps/desktop/src/components/BrandKitPanel.tsx apps/desktop/src/styles.css apps/desktop/src/plugins/presentations/locales
git commit -m "feat(presentations): live renderer previews in the catalog, localized names, synthetic cards retired"
```

---

### Task 10: Gate completi + STATO.md

**Files:**
- Modify: `docs/STATO.md` (nuovo checkpoint in testa)

- [ ] **Step 1: Gate completo**

Run, in ordine:
```bash
cargo test -p local-first-desktop-gateway
python3 -m unittest discover -s runtimes/contained-computer -p 'test_deck_render.py'
cd apps/desktop && npm run build && npm run test:ui-contract && npm run test:electron && cd ../..
python3 scripts/pre_release_gate.py
```
Expected: TUTTO verde. Qualunque rosso si sistema PRIMA di procedere (e si annota nel checkpoint cosa era).

- [ ] **Step 2: Checkpoint STATO.md**

Aggiungi in testa a `docs/STATO.md` un checkpoint conciso: spec+piano approvati (link), F1 SHIPPED (pack bundled + provider + seed morto + 2 pack presentazione con preview reali + UI live-preview), cosa resta (F2 documenti = doc_render + 6 pack + make_document.template_ref; F3 wow = brand-live recolor, hover page-cycling, demozione source cards), e il reminder che la validazione visiva in-app la fa Fabio a schermo (niente computer-use).

- [ ] **Step 3: Commit finale**

```bash
git add docs/STATO.md
git commit -m "docs: STATO checkpoint — Presentations F1 (real template packs) shipped"
```

---

## Note di coerenza col progetto

- **Convergenza**: bundled e importati condividono formato pack, parser (`parse_file_template_catalog_entry`), endpoint preview e thumbnails. NESSUN terzo formato.
- **Niente verifica computer-use**: la validazione visiva del catalogo la fa Fabio a schermo; il piano si ferma a gate verdi + preview.html ispezionabili nel browser.
- **F2/F3 fuori scope** (piani separati): doc_render.py + 6 pack documento + `make_document.template_ref` + `intake_questions` cablate (F2); brand-kit live recolor via CSS var sull'iframe (`--brand/--brand2/--accent` già presenti nell'HTML del renderer), hover page-cycling, demozione delle card sorgenti (F3).
- **Rischio noto**: `add_table`/oval in python-pptx sui layout nuovi = fedeltà "strutturale", non pixel-perfect (il PDF è il formato di fedeltà; QA deck-qa invariata in F1).
