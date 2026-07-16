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

    #[test]
    fn repo_templates_dir_ships_the_v1_packs() {
        let root = bundled_template_pack_root().expect("repo templates dir");
        let provider = BundledTemplatePackProvider::from_root(&root).expect("provider");
        let ids: Vec<String> = crate::TemplateCatalogProvider::entries(&provider)
            .into_iter()
            .map(|entry| entry.id)
            .collect();
        for id in ["homun/startup-pitch-clean-01", "homun/executive-update-board-01",
                   "homun/cv-professional-01", "homun/cover-letter-01",
                   "homun/product-catalog-01", "homun/sales-proposal-01",
                   "homun/company-one-pager-01", "homun/customer-case-study-01"] {
            assert!(ids.contains(&id.to_string()), "missing {id}");
        }
    }
}
