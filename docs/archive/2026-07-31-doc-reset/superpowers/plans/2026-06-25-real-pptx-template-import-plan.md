# Real PPTX Template Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first WS7 slice for real PowerPoint templates: manual `.pptx`/`.potx` import into local template packs, catalog exposure, and real-template resolution metadata for `make_deck`.

**Architecture:** Keep the canonical template registry as the single source of truth. Imported template packs live under the Homun data directory, are read by a new local-pack provider, and appear through the existing `/api/templates/catalog` + `coreBridge.templateCatalog()` path. The first slice records and exposes real PPTX pack metadata and thumbnails; it does not yet replace the renderer with slide cloning.

**Tech Stack:** Rust desktop gateway, existing template catalog provider pattern, Electron bridge/React UI, contained-computer renderer later, focused Rust unit tests + desktop UI contract tests.

---

## File Structure

- `crates/desktop-gateway/src/main.rs`
  - Extend `TemplateCatalogEntry` and response metadata with real-pack fields.
  - Add `ImportedTemplatePackProvider`.
  - Add helpers for template storage paths, manifest parsing, source/attribution metadata, and safe thumbnail refs.
  - Add endpoint for manual import metadata registration in the first slice.
- `apps/desktop/src/lib/coreBridge.ts`
  - Extend `TemplateCatalogEntry` with source/pack/attribution fields.
  - Add an import bridge method for registering a selected local `.pptx`/`.potx`.
- `apps/desktop/src/components/BrandKitPanel.tsx`
  - Add the `Import PPTX` action.
  - Display real source badges and attribution state in gallery cards.
- `apps/desktop/scripts/check-ui-contract.mjs`
  - Guard that Presentations exposes import and attribution affordances.
- `docs/DEVELOPMENT.md`, `docs/plans/2026-06-22-batch-1042-artifacts-memory.md`, `docs/roadmap.md`
  - Update status after each closed slice.

---

## Task 1: Model Imported Template Pack Metadata

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing metadata tests**

Add tests near existing template catalog tests:

```rust
#[test]
fn imported_template_pack_manifest_loads_real_pptx_metadata() {
    let root = std::env::temp_dir().join(format!(
        "homun-imported-template-pack-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    let pack = root.join("slidescarnival_pitch");
    std::fs::create_dir_all(pack.join("thumbnails")).expect("pack dirs");
    std::fs::write(pack.join("source.pptx"), b"pptx bytes").expect("source pptx");
    std::fs::write(pack.join("thumbnails/slide-001.png"), b"png").expect("thumb");
    std::fs::write(
        pack.join("manifest.json"),
        serde_json::json!({
            "id": "slidescarnival/pitch-clean",
            "name": "Pitch Clean",
            "kind": "presentation",
            "description": "Imported SlidesCarnival pitch template.",
            "source_provider": "slidescarnival",
            "source_url": "https://www.slidescarnival.com/template/example/123",
            "license": "Creative Commons Attribution 4.0",
            "attribution_required": true,
            "attribution_text": "Template by SlidesCarnival",
            "redistribution_policy": "generated_decks_only",
            "design_template": "startup_pitch",
            "design_theme": "clean_corporate",
            "design_profile": "sales_pitch",
            "design_components": ["kpi_grid", "timeline"],
            "layout_archetypes": ["cover", "problem", "solution", "ask"],
            "tags": ["slidescarnival", "pitch"],
            "route_text": "slidescarnival pitch investor startup"
        })
        .to_string(),
    )
    .expect("manifest");

    let provider = super::ImportedTemplatePackProvider::from_root(&root).expect("provider");
    let entries = super::TemplateCatalogProvider::entries(&provider);
    let entry = entries
        .iter()
        .find(|entry| entry.id == "slidescarnival/pitch-clean")
        .expect("imported entry");

    assert_eq!(entry.provider, "local_template_pack");
    assert_eq!(entry.source_provider.as_deref(), Some("slidescarnival"));
    assert_eq!(entry.source_ref.as_deref(), Some("https://www.slidescarnival.com/template/example/123"));
    assert_eq!(entry.license.as_deref(), Some("Creative Commons Attribution 4.0"));
    assert_eq!(entry.attribution_text.as_deref(), Some("Template by SlidesCarnival"));
    assert_eq!(entry.redistribution_policy.as_deref(), Some("generated_decks_only"));
    assert!(entry.attribution_required);
    assert!(entry.preview_ref.as_deref().is_some_and(|value| value.starts_with("template-pack://slidescarnival/pitch-clean/")));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn imported_template_pack_rejects_missing_source_pptx() {
    let root = std::env::temp_dir().join(format!(
        "homun-imported-template-pack-missing-{}",
        std::process::id()
    ));
    let pack = root.join("bad_pack");
    std::fs::create_dir_all(&pack).expect("pack dir");
    std::fs::write(
        pack.join("manifest.json"),
        serde_json::json!({
            "id": "slidescarnival/missing-source",
            "name": "Missing Source",
            "kind": "presentation",
            "description": "Invalid imported pack.",
            "source_provider": "slidescarnival",
            "license": "Creative Commons Attribution 4.0",
            "attribution_required": true,
            "attribution_text": "Template by SlidesCarnival",
            "redistribution_policy": "generated_decks_only",
            "design_template": "startup_pitch",
            "route_text": "invalid"
        })
        .to_string(),
    )
    .expect("manifest");

    let provider = super::ImportedTemplatePackProvider::from_root(&root).expect("provider");
    assert!(super::TemplateCatalogProvider::entries(&provider).is_empty());

    let _ = std::fs::remove_dir_all(root);
}
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cargo test -p local-first-desktop-gateway imported_template_pack_ -- --nocapture
```

Expected: compile failure because `ImportedTemplatePackProvider` and the new metadata fields do not exist.

- [ ] **Step 3: Implement metadata types and provider**

Add fields to `TemplateCatalogEntry`:

```rust
source_provider: Option<String>,
source_path: Option<PathBuf>,
template_pack_root: Option<PathBuf>,
attribution_required: bool,
attribution_text: Option<String>,
redistribution_policy: Option<String>,
```

Update `template_catalog_entry()` to initialize them to `None`/`false`.

Create:

```rust
#[derive(Debug, Clone)]
struct ImportedTemplatePackProvider {
    root: PathBuf,
    entries: Vec<TemplateCatalogEntry>,
}

impl ImportedTemplatePackProvider {
    fn from_root(root: &std::path::Path) -> Result<Self, String> {
        let mut entries = Vec::new();
        if !root.exists() {
            return Ok(Self { root: root.to_path_buf(), entries });
        }
        for item in std::fs::read_dir(root).map_err(|error| {
            format!("could not read template pack root {}: {error}", root.display())
        })? {
            let path = item.map_err(|error| format!("could not read template pack entry: {error}"))?.path();
            if !path.is_dir() {
                continue;
            }
            if let Some(entry) = parse_imported_template_pack(&path) {
                entries.push(entry);
            }
        }
        Ok(Self { root: root.to_path_buf(), entries })
    }
}

impl TemplateCatalogProvider for ImportedTemplatePackProvider {
    fn provider_id(&self) -> &str {
        "local_template_pack"
    }

    fn entries(&self) -> Vec<TemplateCatalogEntry> {
        self.entries.clone()
    }
}
```

Implement `parse_imported_template_pack(path: &Path) -> Option<TemplateCatalogEntry>` by reading `manifest.json`, requiring `source.pptx` or `source.potx`, parsing the same design fields accepted by file catalogs, and setting `preview_ref` to `template-pack://<id>/thumbnails/slide-001.png` only when the thumbnail exists.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
cargo test -p local-first-desktop-gateway imported_template_pack_ -- --nocapture
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat: load imported pptx template packs"
```

---

## Task 2: Expose Imported Packs Through The Canonical Catalog API

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing catalog aggregation test**

Add:

```rust
#[test]
fn template_catalog_entries_include_imported_template_packs_after_seed_templates() {
    let root = std::env::temp_dir().join(format!(
        "homun-template-pack-aggregate-{}",
        std::process::id()
    ));
    let pack = root.join("imported_pitch");
    std::fs::create_dir_all(pack.join("thumbnails")).expect("pack dirs");
    std::fs::write(pack.join("source.pptx"), b"pptx").expect("source");
    std::fs::write(pack.join("thumbnails/slide-001.png"), b"png").expect("thumb");
    std::fs::write(
        pack.join("manifest.json"),
        serde_json::json!({
            "id": "slidescarnival/imported-pitch",
            "name": "Imported Pitch",
            "kind": "presentation",
            "description": "Imported real PPTX template.",
            "source_provider": "slidescarnival",
            "source_url": "https://www.slidescarnival.com/template/imported/123",
            "license": "Creative Commons Attribution 4.0",
            "attribution_required": true,
            "attribution_text": "Template by SlidesCarnival",
            "redistribution_policy": "generated_decks_only",
            "design_template": "startup_pitch",
            "route_text": "imported pitch"
        })
        .to_string(),
    )
    .expect("manifest");

    let imported = super::ImportedTemplatePackProvider::from_root(&root).expect("imported provider");
    let entries = super::collect_template_catalog_entries(&[
        &super::LocalTemplateCatalogProvider,
        &imported,
    ]);

    assert!(entries.iter().any(|entry| entry.id == "monet/startup-pitch-clean-01"));
    let imported_entry = entries
        .iter()
        .find(|entry| entry.id == "slidescarnival/imported-pitch")
        .expect("imported entry");
    assert_eq!(imported_entry.provider, "local_template_pack");
    assert_eq!(imported_entry.source_provider.as_deref(), Some("slidescarnival"));

    let _ = std::fs::remove_dir_all(root);
}
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
cargo test -p local-first-desktop-gateway template_catalog_entries_include_imported_template_packs_after_seed_templates -- --nocapture
```

Expected: fail until catalog entry collection includes imported pack provider.

- [ ] **Step 3: Add default imported template root**

Add:

```rust
fn imported_template_pack_root() -> Option<PathBuf> {
    std::env::var("HOMUN_TEMPLATE_PACK_ROOT")
        .ok()
        .map(PathBuf::from)
        .or_else(|| gateway_data_dir().ok().map(|dir| dir.join("templates")))
}

fn imported_template_pack_provider() -> Option<ImportedTemplatePackProvider> {
    let root = imported_template_pack_root()?;
    ImportedTemplatePackProvider::from_root(&root)
        .map_err(|error| {
            eprintln!("[template-pack] ignoring {}: {error}", root.display());
            error
        })
        .ok()
}
```

Update `template_catalog_entries()` to collect `[local, imported, file]` in that order, skipping missing providers.

- [ ] **Step 4: Extend response JSON fields**

Add fields to `TemplateCatalogEntryResponse`:

```rust
source_provider: Option<String>,
attribution_required: bool,
attribution_text: Option<String>,
redistribution_policy: Option<String>,
is_imported: bool,
```

Set them in `template_catalog_response_from_entries()`. Do not expose absolute local `source_path` or `template_pack_root` through the API.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
cargo test -p local-first-desktop-gateway template_catalog_entries_include_imported_template_packs_after_seed_templates template_catalog_response_exposes_read_only_gallery_metadata -- --nocapture
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat: expose imported template packs"
```

---

## Task 3: Add Manual Import Endpoint

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing helper tests**

Add tests for an import helper that can be unit-tested without HTTP:

```rust
#[test]
fn import_pptx_template_pack_copies_source_and_writes_manifest() {
    let root = std::env::temp_dir().join(format!("homun-import-root-{}", std::process::id()));
    let source = root.join("source-files/template.pptx");
    std::fs::create_dir_all(source.parent().unwrap()).expect("source dir");
    std::fs::write(&source, b"pptx").expect("source");
    let target_root = root.join("packs");

    let imported = super::import_pptx_template_pack(
        &target_root,
        super::ImportPptxTemplateRequest {
            source_path: source.to_string_lossy().to_string(),
            name: "Customer Pitch".to_string(),
            source_provider: Some("slidescarnival".to_string()),
            source_url: Some("https://www.slidescarnival.com/template/customer-pitch/123".to_string()),
            license: Some("Creative Commons Attribution 4.0".to_string()),
            attribution_required: Some(true),
            attribution_text: Some("Template by SlidesCarnival".to_string()),
            redistribution_policy: Some("generated_decks_only".to_string()),
            tags: Some(vec!["pitch".to_string(), "slidescarnival".to_string()]),
        },
    )
    .expect("imported");

    assert!(imported.source_path.as_ref().is_some_and(|path| path.ends_with("source.pptx")));
    assert!(target_root.join("customer-pitch/source.pptx").exists());
    assert!(target_root.join("customer-pitch/manifest.json").exists());
    assert_eq!(imported.id, "local/customer-pitch");
    assert_eq!(imported.source_provider.as_deref(), Some("slidescarnival"));
    assert!(imported.attribution_required);

    let _ = std::fs::remove_dir_all(root);
}
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
cargo test -p local-first-desktop-gateway import_pptx_template_pack_copies_source_and_writes_manifest -- --nocapture
```

Expected: compile failure because request/import helper does not exist.

- [ ] **Step 3: Implement import helper**

Add:

```rust
#[derive(Debug, Clone, serde::Deserialize)]
struct ImportPptxTemplateRequest {
    source_path: String,
    name: String,
    source_provider: Option<String>,
    source_url: Option<String>,
    license: Option<String>,
    attribution_required: Option<bool>,
    attribution_text: Option<String>,
    redistribution_policy: Option<String>,
    tags: Option<Vec<String>>,
}
```

Implement `import_pptx_template_pack(root, request)`:

- accept only `.pptx` or `.potx`;
- slugify `name` to a safe directory/id;
- copy source to `source.pptx` or `source.potx`;
- create `manifest.json` with conservative defaults:
  - `kind: presentation`;
  - `design_template: startup_pitch`;
  - `design_theme: clean_corporate`;
  - `design_profile: sales_pitch`;
  - `route_text`: name + tags + source provider;
  - source/license/attribution fields from request.
- return the parsed `TemplateCatalogEntry`.

- [ ] **Step 4: Add HTTP route**

Add a gateway route:

```rust
POST /api/templates/import-pptx
```

It receives `ImportPptxTemplateRequest`, uses `imported_template_pack_root()`, returns `TemplateCatalogEntryResponse`, and never exposes absolute filesystem paths.

- [ ] **Step 5: Run tests**

Run:

```bash
cargo test -p local-first-desktop-gateway import_pptx_template_pack_ -- --nocapture
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat: import local pptx templates"
```

---

## Task 4: Wire Desktop Bridge And Presentations UI

**Files:**
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Modify: `apps/desktop/src/components/BrandKitPanel.tsx`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing UI contract assertions**

Add to `apps/desktop/scripts/check-ui-contract.mjs`:

```js
assertContains("src/components/BrandKitPanel.tsx", "Import PPTX", "Presentations must expose manual PPTX template import");
assertContains("src/components/BrandKitPanel.tsx", "attribution_required", "Presentations must surface attribution state for imported/source templates");
assertContains("src/lib/coreBridge.ts", "importPptxTemplate", "Desktop bridge must expose PPTX template import");
```

- [ ] **Step 2: Run UI contract and verify failure**

Run:

```bash
npm run test:ui-contract
```

from `apps/desktop`.

Expected: fail on missing import bridge/UI strings.

- [ ] **Step 3: Extend bridge types**

In `TemplateCatalogEntry`, add:

```ts
source_provider: string | null;
attribution_required: boolean;
attribution_text: string | null;
redistribution_policy: string | null;
is_imported: boolean;
```

Add:

```ts
export interface ImportPptxTemplateRequest {
  source_path: string;
  name: string;
  source_provider?: string;
  source_url?: string;
  license?: string;
  attribution_required?: boolean;
  attribution_text?: string;
  redistribution_policy?: string;
  tags?: string[];
}

async function electronImportPptxTemplate(
  payload: ImportPptxTemplateRequest,
): Promise<TemplateCatalogEntry> {
  return gatewayPostJson<TemplateCatalogEntry>("/api/templates/import-pptx", payload);
}
```

Expose it in `coreBridge`.

- [ ] **Step 4: Add minimal UI**

In `BrandKitPanel.tsx`:

- add file input/button labelled `Import PPTX`;
- accept `.pptx,.potx`;
- on selection call `coreBridge.importPptxTemplate` with:
  - `source_path` from Electron file path if available;
  - `name` from filename without extension;
  - `source_provider: "user_upload"`;
  - `redistribution_policy: "owned_by_user"`;
  - `attribution_required: false`.
- reload `coreBridge.templateCatalog()`.
- show source/attribution badges on cards:
  - `Local` for `is_imported`;
  - `SlidesCarnival` for `source_provider === "slidescarnival"`;
  - `Attribution required` when `attribution_required`.

- [ ] **Step 5: Run frontend gates**

Run:

```bash
npm run test:ui-contract
npm run build
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/coreBridge.ts apps/desktop/src/components/BrandKitPanel.tsx apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat: add pptx template import ui"
```

---

## Task 5: Connect Imported Template Metadata To make_deck Provenance

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing provenance test**

Add a focused unit test around the metadata builder used for artifact registration:

```rust
#[test]
fn deck_artifact_metadata_includes_imported_template_attribution() {
    let template = super::TemplateCatalogEntry {
        provider: "local_template_pack".to_string(),
        id: "slidescarnival/pitch-clean".to_string(),
        name: "Pitch Clean".to_string(),
        kind: "presentation".to_string(),
        description: "Imported template.".to_string(),
        use_cases: vec!["pitch".to_string()],
        audience: vec!["clients".to_string()],
        design_template: "startup_pitch".to_string(),
        design_theme: Some("clean_corporate".to_string()),
        design_profile: Some("sales_pitch".to_string()),
        design_components: vec!["kpi_grid".to_string()],
        layout_archetypes: vec!["cover".to_string()],
        tags: vec!["slidescarnival".to_string()],
        preview_ref: Some("template-pack://slidescarnival/pitch-clean/thumbnails/slide-001.png".to_string()),
        source_ref: Some("https://www.slidescarnival.com/template/example/123".to_string()),
        license: Some("Creative Commons Attribution 4.0".to_string()),
        route_text: "pitch".to_string(),
        source_provider: Some("slidescarnival".to_string()),
        source_path: None,
        template_pack_root: None,
        attribution_required: true,
        attribution_text: Some("Template by SlidesCarnival".to_string()),
        redistribution_policy: Some("generated_decks_only".to_string()),
    };

    let metadata = super::deck_template_metadata(Some(&template));

    assert_eq!(metadata["template_ref"], "slidescarnival/pitch-clean");
    assert_eq!(metadata["template_source_provider"], "slidescarnival");
    assert_eq!(metadata["template_license"], "Creative Commons Attribution 4.0");
    assert_eq!(metadata["template_attribution_required"], true);
    assert_eq!(metadata["template_attribution_text"], "Template by SlidesCarnival");
}
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
cargo test -p local-first-desktop-gateway deck_artifact_metadata_includes_imported_template_attribution -- --nocapture
```

Expected: compile failure until helper exists.

- [ ] **Step 3: Implement metadata helper and attach to deck artifact registration**

Add:

```rust
fn deck_template_metadata(template: Option<&TemplateCatalogEntry>) -> serde_json::Value {
    let Some(template) = template else {
        return serde_json::json!({});
    };
    serde_json::json!({
        "template_ref": template.id,
        "template_provider": template.provider,
        "template_source_provider": template.source_provider,
        "template_source_ref": template.source_ref,
        "template_license": template.license,
        "template_attribution_required": template.attribution_required,
        "template_attribution_text": template.attribution_text,
        "template_redistribution_policy": template.redistribution_policy,
    })
}
```

Thread it into `make_deck` when calling artifact registration for produced deck files. If the existing artifact registration helper only accepts QA metadata, merge the JSON objects there rather than adding a parallel artifact store.

- [ ] **Step 4: Run targeted gateway tests**

Run:

```bash
cargo test -p local-first-desktop-gateway deck_artifact_metadata_includes_imported_template_attribution make_deck_and_document_accept_template_ref -- --nocapture
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat: record deck template attribution"
```

---

## Task 6: Documentation And Runtime Smoke

**Files:**
- Modify: `docs/DEVELOPMENT.md`
- Modify: `docs/plans/2026-06-22-batch-1042-artifacts-memory.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Update durable docs**

Record:

- manual PPTX import implemented;
- catalog API exposes imported template packs;
- UI can import and display source/attribution;
- `make_deck` records imported template attribution metadata;
- SlidesCarnival browser/direct import remains next slice.

- [ ] **Step 2: Run full focused gates**

Run:

```bash
cargo test -p local-first-desktop-gateway imported_template_pack_ import_pptx_template_pack_ template_catalog_entries_include_imported_template_packs_after_seed_templates deck_artifact_metadata_includes_imported_template_attribution -- --nocapture
npm run test:ui-contract
npm run build
git diff --check
```

Expected: all pass.

- [ ] **Step 3: Runtime smoke**

With Electron dev app running:

1. Open Presentations.
2. Click `Import PPTX`.
3. Select a local `.pptx`.
4. Verify the imported template appears with a source badge.
5. Verify `/api/templates/catalog` includes the new template.

If no user-provided PPTX is available, create a tiny synthetic `.pptx` using the existing document/presentation runtime only for the import path; do not treat that as visual QA for SlidesCarnival quality.

- [ ] **Step 4: Commit docs if changed**

```bash
git add docs/DEVELOPMENT.md docs/plans/2026-06-22-batch-1042-artifacts-memory.md docs/roadmap.md
git commit -m "docs: update pptx template import status"
```

---

## Out Of Scope For This Plan

- Full SlidesCarnival scraping/search automation.
- Direct download from SlidesCarnival pages.
- Full placeholder/slot matching for complex PPTX templates.
- Rendering HTML/PDF previews from the real PPTX output instead of the synthetic
  HTML renderer.
- Sophisticated placeholder detection and manual manifest editor.
- Generating real thumbnails through LibreOffice/PowerPoint in every environment.

Those follow once local packs are canonical and visible.

## Self-Review

- Spec coverage: this plan covers manual PPTX import, pack manifest, catalog exposure, UI import affordance, attribution metadata, runtime smoke, and the first real-PPTX renderer slice. It intentionally defers SlidesCarnival browsing/direct import, full placeholder matching, and real-PPTX-derived HTML/PDF previews to later slices.
- Placeholder scan: no marker placeholders or vague implementation placeholders remain.
- Type consistency: new metadata fields are defined once on `TemplateCatalogEntry`, mirrored in API response and TypeScript bridge, then reused by UI and artifact provenance.
