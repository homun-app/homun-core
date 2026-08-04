//! Template catalog owner for deliverable templates.
//!
//! Owns catalog DTOs, manifest providers, imported PowerPoint packs, preview/source
//! routes, and the capability entries used by routing. Keep parsing and path jail
//! policy here so `main.rs` only wires the owner.

use super::{
    Body, CONTENT_TYPE, CapabilityEntry, CapabilitySource, DELIVERABLE_DESIGN_COMPONENTS,
    DELIVERABLE_DESIGN_PROFILES, DELIVERABLE_DESIGN_TEMPLATES, DELIVERABLE_DESIGN_THEMES,
    GatewayError, Json, PathBuf, Query, Response, StatusCode, env, fs, fs_expand_abs,
    gateway_data_dir, jail_in_root, template_packs,
};
use serde::Serialize;
use std::process::Command;

#[test]
fn template_catalog_owner_smoke() {
    assert_eq!(
        template_preview_content_type("preview.html"),
        Some("text/html; charset=utf-8")
    );
}

#[derive(Debug, Serialize)]
pub(crate) struct TemplateCatalogEntryResponse {
    pub(crate) provider: String,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) category: String,
    pub(crate) description: String,
    pub(crate) name_it: Option<String>,
    pub(crate) description_it: Option<String>,
    pub(crate) use_cases: Vec<String>,
    pub(crate) audience: Vec<String>,
    pub(crate) design_template: String,
    pub(crate) design_theme: Option<String>,
    pub(crate) design_profile: Option<String>,
    pub(crate) design_components: Vec<String>,
    pub(crate) layout_archetypes: Vec<String>,
    pub(crate) tags: Vec<String>,
    pub(crate) intake_questions: Vec<String>,
    pub(crate) selection_notes: Vec<String>,
    pub(crate) preview_ref: Option<String>,
    pub(crate) preview_html_ref: Option<String>,
    pub(crate) source_ref: Option<String>,
    pub(crate) license: Option<String>,
    pub(crate) source_provider: Option<String>,
    pub(crate) attribution_required: bool,
    pub(crate) attribution_text: Option<String>,
    pub(crate) redistribution_policy: Option<String>,
    pub(crate) is_imported: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct TemplateCatalogResponse {
    pub(crate) templates: Vec<TemplateCatalogEntryResponse>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct ImportPptxTemplateRequest {
    pub(crate) source_path: String,
    pub(crate) name: String,
    pub(crate) source_provider: Option<String>,
    pub(crate) source_url: Option<String>,
    pub(crate) license: Option<String>,
    pub(crate) attribution_required: Option<bool>,
    pub(crate) attribution_text: Option<String>,
    pub(crate) redistribution_policy: Option<String>,
    pub(crate) tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct TemplateSourceAttachmentRequest {
    pub(crate) template_id: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct TemplateDeleteRequest {
    pub(crate) template_id: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct TemplatePreviewQuery {
    #[serde(rename = "ref")]
    pub(crate) reference: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct TemplateSourceAttachmentResponse {
    pub(crate) local_path: String,
    pub(crate) display_name: String,
    pub(crate) mime_type: String,
    pub(crate) size_bytes: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct TemplateCatalogEntry {
    pub(crate) provider: String,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    // Use-case bucket for gallery filtering (whitelist + "other" fallback, mirrors
    // the kind/design_template parsing pattern below — never trust manifest authors
    // to stick to the list).
    pub(crate) category: String,
    pub(crate) description: String,
    // Flat locale overrides (name_it/description_it in the manifest): the catalog is
    // EN-canonical, Italian is the one extra locale the product ships today. A map
    // would be speculative — add locales when a third one actually exists.
    pub(crate) name_it: Option<String>,
    pub(crate) description_it: Option<String>,
    pub(crate) use_cases: Vec<String>,
    pub(crate) audience: Vec<String>,
    pub(crate) design_template: String,
    pub(crate) design_theme: Option<String>,
    pub(crate) design_profile: Option<String>,
    pub(crate) design_components: Vec<String>,
    pub(crate) layout_archetypes: Vec<String>,
    pub(crate) tags: Vec<String>,
    // Questions the UI should ask the user before generating from this template
    // (e.g. a CV template asking for target role/seniority). Manifest-only content,
    // not a design token — no whitelist, just length/count capped like other lists.
    pub(crate) intake_questions: Vec<String>,
    pub(crate) preview_ref: Option<String>,
    // Live HTML preview (bundled packs): "template-pack://<id>/preview.html".
    pub(crate) preview_html_ref: Option<String>,
    pub(crate) source_ref: Option<String>,
    pub(crate) license: Option<String>,
    pub(crate) source_provider: Option<String>,
    pub(crate) source_path: Option<PathBuf>,
    pub(crate) template_pack_root: Option<PathBuf>,
    // Bundled (shipped-with-the-app) packs share the pack-dir shape with imported
    // ones but must NOT look imported (no delete button, source filter "Homun").
    pub(crate) bundled: bool,
    pub(crate) attribution_required: bool,
    pub(crate) attribution_text: Option<String>,
    pub(crate) redistribution_policy: Option<String>,
    pub(crate) route_text: String,
}

pub(crate) trait TemplateCatalogProvider {
    #[cfg_attr(not(test), allow(dead_code))]
    fn provider_id(&self) -> &str;
    fn entries(&self) -> Vec<TemplateCatalogEntry>;

    fn get(&self, id: &str) -> Option<TemplateCatalogEntry> {
        template_catalog_by_id_from_entries(&self.entries(), Some(id))
    }
}

#[derive(Debug, Clone)]
pub(crate) struct FileTemplateCatalogProvider {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) provider_id: String,
    pub(crate) entries: Vec<TemplateCatalogEntry>,
}

#[derive(Debug, Clone)]
pub(crate) struct ImportedTemplatePackProvider {
    pub(crate) entries: Vec<TemplateCatalogEntry>,
}

// Test-only fixture builder: its last production caller was the hardcoded
// built-in template seed (Task 7 deleted it). Gate it out of the shipped
// binary so it doesn't linger as dead_code there while it keeps serving test
// fixtures below.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn template_catalog_entry(
    provider: &str,
    id: &str,
    name: &str,
    kind: &str,
    description: &str,
    use_cases: &[&str],
    audience: &[&str],
    design_template: &str,
    design_theme: Option<&str>,
    design_profile: Option<&str>,
    design_components: &[&str],
    layout_archetypes: &[&str],
    route_text: &str,
) -> TemplateCatalogEntry {
    TemplateCatalogEntry {
        provider: provider.to_string(),
        id: id.to_string(),
        name: name.to_string(),
        kind: kind.to_string(),
        category: "other".to_string(),
        description: description.to_string(),
        name_it: None,
        description_it: None,
        use_cases: use_cases.iter().map(|value| value.to_string()).collect(),
        audience: audience.iter().map(|value| value.to_string()).collect(),
        design_template: design_template.to_string(),
        design_theme: design_theme.map(str::to_string),
        design_profile: design_profile.map(str::to_string),
        design_components: design_components
            .iter()
            .map(|value| value.to_string())
            .collect(),
        layout_archetypes: layout_archetypes
            .iter()
            .map(|value| value.to_string())
            .collect(),
        tags: Vec::new(),
        intake_questions: Vec::new(),
        preview_ref: None,
        preview_html_ref: None,
        source_ref: None,
        license: None,
        source_provider: None,
        source_path: None,
        template_pack_root: None,
        bundled: false,
        attribution_required: false,
        attribution_text: None,
        redistribution_policy: None,
        route_text: route_text.to_string(),
    }
}

impl FileTemplateCatalogProvider {
    pub(crate) fn from_json_str(raw: &str) -> Result<Self, String> {
        let value: serde_json::Value = serde_json::from_str(raw)
            .map_err(|error| format!("template catalog manifest is not valid JSON: {error}"))?;
        let provider_id = clean_template_catalog_id(
            value
                .get("provider_id")
                .and_then(|value| value.as_str())
                .ok_or_else(|| "template catalog manifest missing provider_id".to_string())?,
        )
        .ok_or_else(|| "template catalog manifest provider_id is invalid".to_string())?;
        let templates = value
            .get("templates")
            .and_then(|value| value.as_array())
            .ok_or_else(|| "template catalog manifest missing templates array".to_string())?;
        let entries = templates
            .iter()
            .filter_map(|template| parse_file_template_catalog_entry(&provider_id, template).ok())
            .collect::<Vec<_>>();

        Ok(Self {
            provider_id,
            entries,
        })
    }

    pub(crate) fn from_path(path: &std::path::Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(path).map_err(|error| {
            format!(
                "could not read template catalog {}: {error}",
                path.display()
            )
        })?;
        Self::from_json_str(&raw)
    }
}

impl TemplateCatalogProvider for FileTemplateCatalogProvider {
    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn entries(&self) -> Vec<TemplateCatalogEntry> {
        self.entries.clone()
    }
}

impl ImportedTemplatePackProvider {
    pub(crate) fn from_root(root: &std::path::Path) -> Result<Self, String> {
        let mut entries = Vec::new();
        if !root.exists() {
            return Ok(Self { entries });
        }
        for item in std::fs::read_dir(root).map_err(|error| {
            format!(
                "could not read template pack root {}: {error}",
                root.display()
            )
        })? {
            let path = item
                .map_err(|error| format!("could not read template pack entry: {error}"))?
                .path();
            if !path.is_dir() {
                continue;
            }
            if let Some(entry) = parse_imported_template_pack(&path) {
                entries.push(entry);
            }
        }
        Ok(Self { entries })
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

fn imported_template_source_path(pack_root: &std::path::Path) -> Option<PathBuf> {
    ["source.pptx", "source.potx"]
        .iter()
        .map(|name| pack_root.join(name))
        .find(|path| path.is_file())
}

pub(crate) fn imported_template_preview_ref(
    id: &str,
    pack_root: &std::path::Path,
) -> Option<String> {
    let thumb = pack_root.join("thumbnails").join("slide-001.png");
    if !thumb.is_file() {
        return None;
    }
    clean_template_catalog_ref(Some(&serde_json::Value::String(format!(
        "template-pack://{id}/thumbnails/slide-001.png"
    ))))
}

fn percent_encode_query(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char);
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

fn template_catalog_preview_response_ref(preview_ref: Option<String>) -> Option<String> {
    preview_ref.map(|preview| {
        if preview.starts_with("template-pack://") {
            format!(
                "/api/templates/preview?ref={}",
                percent_encode_query(&preview)
            )
        } else {
            preview
        }
    })
}

fn parse_imported_template_pack(pack_root: &std::path::Path) -> Option<TemplateCatalogEntry> {
    let source_path = imported_template_source_path(pack_root)?;
    let manifest_path = pack_root.join("manifest.json");
    let raw = std::fs::read_to_string(manifest_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let mut entry = parse_file_template_catalog_entry("local_template_pack", &value).ok()?;

    entry.source_provider = value
        .get("source_provider")
        .and_then(|value| value.as_str())
        .and_then(clean_template_catalog_id);
    entry.source_ref =
        clean_template_catalog_ref(value.get("source_url").or_else(|| value.get("source_ref")));
    entry.license = clean_template_catalog_text(value.get("license"), 120);
    entry.attribution_required = value
        .get("attribution_required")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    entry.attribution_text = clean_template_catalog_text(value.get("attribution_text"), 240);
    entry.redistribution_policy =
        clean_template_catalog_text(value.get("redistribution_policy"), 80);
    entry.source_path = Some(source_path);
    entry.template_pack_root = Some(pack_root.to_path_buf());
    entry.preview_ref = imported_template_preview_ref(&entry.id, pack_root);

    Some(entry)
}

fn clean_template_catalog_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 160
        || value.starts_with('/')
        || value.contains("..")
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '/' | '.'))
    {
        None
    } else {
        Some(value.to_string())
    }
}

fn clean_template_catalog_text(
    value: Option<&serde_json::Value>,
    max_len: usize,
) -> Option<String> {
    value
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(max_len).collect())
}

fn clean_template_catalog_string_list(
    value: Option<&serde_json::Value>,
    max_items: usize,
    max_len: usize,
) -> Vec<String> {
    value
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .filter_map(|value| {
                    let value = value.trim();
                    if value.is_empty() {
                        None
                    } else {
                        Some(value.chars().take(max_len).collect::<String>())
                    }
                })
                .fold(Vec::<String>::new(), |mut acc, value| {
                    if acc.len() < max_items && !acc.iter().any(|existing| existing == &value) {
                        acc.push(value);
                    }
                    acc
                })
        })
        .unwrap_or_default()
}

pub(crate) fn clean_template_catalog_ref(value: Option<&serde_json::Value>) -> Option<String> {
    let value = value.and_then(|value| value.as_str())?.trim();
    if value.is_empty() || value.len() > 240 || value.contains("..") {
        return None;
    }
    if value.starts_with("https://") || value.starts_with("http://") {
        return Some(value.to_string());
    }
    if value.starts_with('/') || value.starts_with("file:") {
        return None;
    }
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '/' | '.' | ':' | '#'))
    {
        Some(value.to_string())
    } else {
        None
    }
}

pub(crate) fn parse_file_template_catalog_entry(
    provider_id: &str,
    value: &serde_json::Value,
) -> Result<TemplateCatalogEntry, String> {
    let id = clean_template_catalog_id(
        value
            .get("id")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "template missing id".to_string())?,
    )
    .ok_or_else(|| "template id is invalid".to_string())?;
    let name = clean_template_catalog_text(value.get("name"), 80)
        .ok_or_else(|| "template missing name".to_string())?;
    let kind = value
        .get("kind")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|kind| matches!(*kind, "presentation" | "document"))
        .ok_or_else(|| "template kind is invalid".to_string())?
        .to_string();
    let category = value
        .get("category")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|c| {
            matches!(
                *c,
                "pitch_sales" | "cv_career" | "report_update" | "catalog_marketing"
            )
        })
        .unwrap_or("other")
        .to_string();
    let description = clean_template_catalog_text(value.get("description"), 240)
        .ok_or_else(|| "template missing description".to_string())?;
    let design_template = value
        .get("design_template")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| DELIVERABLE_DESIGN_TEMPLATES.contains(&value.as_str()))
        .ok_or_else(|| "template design_template is invalid".to_string())?;
    let design_theme = value
        .get("design_theme")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| DELIVERABLE_DESIGN_THEMES.contains(&value.as_str()));
    let design_profile = value
        .get("design_profile")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| DELIVERABLE_DESIGN_PROFILES.contains(&value.as_str()));
    let design_components =
        clean_template_catalog_string_list(value.get("design_components"), 6, 60)
            .into_iter()
            .map(|value| value.to_ascii_lowercase())
            .filter(|value| DELIVERABLE_DESIGN_COMPONENTS.contains(&value.as_str()))
            .collect::<Vec<_>>();
    let route_text = clean_template_catalog_text(value.get("route_text"), 500)
        .ok_or_else(|| "template missing route_text".to_string())?;

    Ok(TemplateCatalogEntry {
        provider: provider_id.to_string(),
        id,
        name,
        kind,
        category,
        description,
        name_it: clean_template_catalog_text(value.get("name_it"), 80),
        description_it: clean_template_catalog_text(value.get("description_it"), 240),
        use_cases: clean_template_catalog_string_list(value.get("use_cases"), 12, 80),
        audience: clean_template_catalog_string_list(value.get("audience"), 12, 80),
        design_template,
        design_theme,
        design_profile,
        design_components,
        layout_archetypes: clean_template_catalog_string_list(
            value.get("layout_archetypes"),
            16,
            80,
        ),
        tags: clean_template_catalog_string_list(value.get("tags"), 16, 40),
        intake_questions: clean_template_catalog_string_list(value.get("intake_questions"), 6, 200),
        preview_ref: clean_template_catalog_ref(value.get("preview_ref")),
        preview_html_ref: None,
        source_ref: clean_template_catalog_ref(value.get("source_ref")),
        license: clean_template_catalog_text(value.get("license"), 80),
        source_provider: None,
        source_path: None,
        template_pack_root: None,
        bundled: false,
        attribution_required: false,
        attribution_text: None,
        redistribution_policy: None,
        route_text,
    })
}

pub(crate) fn collect_template_catalog_entries(
    providers: &[&dyn TemplateCatalogProvider],
) -> Vec<TemplateCatalogEntry> {
    providers
        .iter()
        .flat_map(|provider| provider.entries())
        .fold(Vec::<TemplateCatalogEntry>::new(), |mut acc, entry| {
            if !acc.iter().any(|existing| existing.id == entry.id) {
                acc.push(entry);
            }
            acc
        })
}

fn template_catalog_file_path() -> Option<PathBuf> {
    std::env::var("HOMUN_TEMPLATE_CATALOG_PATH")
        .ok()
        .map(std::path::PathBuf::from)
        .or_else(|| {
            gateway_data_dir()
                .ok()
                .map(|dir| dir.join("template-catalog.json"))
        })
}

fn file_template_catalog_provider() -> Option<FileTemplateCatalogProvider> {
    let path = template_catalog_file_path()?;
    if !path.exists() {
        return None;
    }
    match FileTemplateCatalogProvider::from_path(&path) {
        Ok(provider) => Some(provider),
        Err(error) => {
            eprintln!("[template-catalog] ignoring {}: {error}", path.display());
            None
        }
    }
}

fn imported_template_pack_root() -> Option<PathBuf> {
    std::env::var("HOMUN_TEMPLATE_PACK_ROOT")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            gateway_data_dir()
                .ok()
                .map(|dir| dir.join("template-packs"))
        })
}

pub(crate) fn delete_imported_template_pack(
    root: &std::path::Path,
    template_id: &str,
) -> Result<(), String> {
    let template_id = template_id.trim();
    if template_id.is_empty() {
        return Err("template id is required".to_string());
    }
    let provider = ImportedTemplatePackProvider::from_root(root)?;
    let entry = TemplateCatalogProvider::get(&provider, template_id)
        .ok_or_else(|| "imported template not found".to_string())?;
    let pack_root = entry
        .template_pack_root
        .ok_or_else(|| "template is not an imported local pack".to_string())?;
    let root_canonical = root
        .canonicalize()
        .map_err(|error| format!("could not resolve template pack root: {error}"))?;
    let pack_canonical = pack_root
        .canonicalize()
        .map_err(|error| format!("could not resolve imported template pack: {error}"))?;
    if !pack_canonical.starts_with(&root_canonical) {
        return Err("imported template pack is outside the template root".to_string());
    }
    fs::remove_dir_all(&pack_canonical)
        .map_err(|error| format!("could not delete imported template pack: {error}"))
}

fn imported_template_pack_provider() -> Option<ImportedTemplatePackProvider> {
    let root = imported_template_pack_root()?;
    match ImportedTemplatePackProvider::from_root(&root) {
        Ok(provider) => Some(provider),
        Err(error) => {
            eprintln!(
                "[template-catalog] ignoring imported packs under {}: {error}",
                root.display()
            );
            None
        }
    }
}

pub(crate) fn slugify_template_pack_name(name: &str) -> Option<String> {
    let slug = name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() { None } else { Some(slug) }
}

fn next_template_pack_slug(root: &std::path::Path, base_slug: &str) -> Result<String, String> {
    for index in 1..1000 {
        let slug = if index == 1 {
            base_slug.to_string()
        } else {
            format!("{base_slug}-{index}")
        };
        if !root.join(&slug).exists() {
            return Ok(slug);
        }
    }
    Err("could not allocate a unique template pack name".to_string())
}

fn find_executable(candidates: &[String]) -> Option<PathBuf> {
    for candidate in candidates {
        let path = std::path::Path::new(candidate);
        if path.components().count() > 1 && path.is_file() {
            return Some(path.to_path_buf());
        }
        if path.components().count() == 1
            && let Some(paths) = env::var_os("PATH")
        {
            for dir in env::split_paths(&paths) {
                let executable = dir.join(candidate);
                if executable.is_file() {
                    return Some(executable);
                }
            }
        }
    }
    None
}

fn render_imported_template_thumbnails(
    source_path: &std::path::Path,
    pack_root: &std::path::Path,
) -> Result<usize, String> {
    let home = env::var("HOME").unwrap_or_default();
    let soffice_candidates = [
        env::var("HOMUN_SOFFICE_BIN").ok(),
        Some("soffice".to_string()),
        Some("libreoffice".to_string()),
        Some("/Applications/LibreOffice.app/Contents/MacOS/soffice".to_string()),
        Some("/opt/homebrew/bin/soffice".to_string()),
        Some("/usr/local/bin/soffice".to_string()),
        (!home.is_empty()).then(|| {
            format!("{home}/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/soffice")
        }),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    let pdftoppm_candidates = [
        env::var("HOMUN_PDFTOPPM_BIN").ok(),
        Some("pdftoppm".to_string()),
        Some("/opt/homebrew/bin/pdftoppm".to_string()),
        Some("/usr/local/bin/pdftoppm".to_string()),
        (!home.is_empty()).then(|| {
            format!("{home}/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pdftoppm")
        }),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    let soffice = find_executable(&soffice_candidates).ok_or_else(|| {
        "PowerPoint thumbnail generation requires LibreOffice/soffice".to_string()
    })?;
    let pdftoppm = find_executable(&pdftoppm_candidates)
        .ok_or_else(|| "PowerPoint thumbnail generation requires pdftoppm".to_string())?;

    let temp_root = env::temp_dir().join(format!(
        "homun-template-preview-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&temp_root)
        .map_err(|error| format!("could not create thumbnail temp dir: {error}"))?;
    let cleanup = |path: &std::path::Path| {
        let _ = fs::remove_dir_all(path);
    };

    // Give each soffice invocation its OWN throwaway user profile. Without this, concurrent
    // conversions (two doc/pptx renders overlapping, or the parallel test suite) contend on the
    // single default LibreOffice profile, whose lock makes the second instance abort with a
    // `com.sun.star.registry ... DeploymentException`. `-env:UserInstallation` wants a file:// URI;
    // the profile lives under the already-unique `temp_root` (pid+uuid) and is cleaned up with it.
    let profile_dir = temp_root.join("lo-profile");
    let profile_arg = format!("-env:UserInstallation=file://{}", profile_dir.display());

    let soffice_output = Command::new(&soffice)
        .arg(&profile_arg)
        .args(["--headless", "--convert-to", "pdf", "--outdir"])
        .arg(&temp_root)
        .arg(source_path)
        .output()
        .map_err(|error| {
            cleanup(&temp_root);
            format!("could not run soffice for template preview: {error}")
        })?;
    if !soffice_output.status.success() {
        let stderr = String::from_utf8_lossy(&soffice_output.stderr);
        let stdout = String::from_utf8_lossy(&soffice_output.stdout);
        cleanup(&temp_root);
        return Err(format!(
            "soffice failed while rendering template preview: {stderr}{stdout}"
        ));
    }
    let pdf_path = fs::read_dir(&temp_root)
        .map_err(|error| {
            cleanup(&temp_root);
            format!("could not inspect template preview temp dir: {error}")
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        })
        .ok_or_else(|| {
            cleanup(&temp_root);
            "soffice did not produce a PDF for template preview".to_string()
        })?;

    let prefix = temp_root.join("slide");
    let pdf_output = Command::new(&pdftoppm)
        .args(["-png", "-r", "120", "-f", "1", "-l", "8"])
        .arg(&pdf_path)
        .arg(&prefix)
        .output()
        .map_err(|error| {
            cleanup(&temp_root);
            format!("could not run pdftoppm for template preview: {error}")
        })?;
    if !pdf_output.status.success() {
        let stderr = String::from_utf8_lossy(&pdf_output.stderr);
        cleanup(&temp_root);
        return Err(format!(
            "pdftoppm failed while rendering template preview: {stderr}"
        ));
    }

    let thumbnails_dir = pack_root.join("thumbnails");
    fs::create_dir_all(&thumbnails_dir)
        .map_err(|error| format!("could not create template thumbnails dir: {error}"))?;
    let mut rendered = fs::read_dir(&temp_root)
        .map_err(|error| format!("could not read template preview temp dir: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with("slide-") && name.ends_with(".png"))
        })
        .collect::<Vec<_>>();
    rendered.sort();

    let mut count = 0usize;
    for (index, image) in rendered.into_iter().take(8).enumerate() {
        let target = thumbnails_dir.join(format!("slide-{:03}.png", index + 1));
        fs::copy(&image, &target)
            .map_err(|error| format!("could not copy template thumbnail: {error}"))?;
        count += 1;
    }
    cleanup(&temp_root);
    if count == 0 {
        return Err("template preview renderer produced no thumbnails".to_string());
    }
    Ok(count)
}

pub(crate) fn import_pptx_template_pack(
    root: &std::path::Path,
    request: ImportPptxTemplateRequest,
) -> Result<TemplateCatalogEntry, String> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err("template name is required".to_string());
    }
    let source_path = fs_expand_abs(&request.source_path)
        .ok_or_else(|| "source_path must be an absolute path".to_string())?;
    if !source_path.is_file() {
        return Err("source_path does not point to a file".to_string());
    }
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "template source must be a .pptx or .potx file".to_string())?;
    if !matches!(extension.as_str(), "pptx" | "potx") {
        return Err("template source must be a .pptx or .potx file".to_string());
    }

    fs::create_dir_all(root).map_err(|error| {
        format!(
            "could not create template pack root {}: {error}",
            root.display()
        )
    })?;
    let base_slug =
        slugify_template_pack_name(name).ok_or_else(|| "template name is invalid".to_string())?;
    let slug = next_template_pack_slug(root, &base_slug)?;
    let pack_root = root.join(&slug);
    fs::create_dir_all(&pack_root).map_err(|error| {
        format!(
            "could not create template pack {}: {error}",
            pack_root.display()
        )
    })?;
    let source_file_name = format!("source.{extension}");
    let target_source = pack_root.join(source_file_name);
    fs::copy(&source_path, &target_source).map_err(|error| {
        format!(
            "could not copy template source {}: {error}",
            source_path.display()
        )
    })?;
    render_imported_template_thumbnails(&target_source, &pack_root)?;

    let source_provider = request
        .source_provider
        .as_deref()
        .and_then(clean_template_catalog_id);
    let tags = request
        .tags
        .unwrap_or_default()
        .into_iter()
        .filter_map(|tag| clean_template_catalog_text(Some(&serde_json::Value::String(tag)), 40))
        .collect::<Vec<_>>();
    let route_text = std::iter::once(name.to_string())
        .chain(tags.iter().cloned())
        .chain(source_provider.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ");
    let manifest = serde_json::json!({
        "id": format!("local/{slug}"),
        "name": name,
        "kind": "presentation",
        "description": format!("Imported PowerPoint template: {name}."),
        "source_provider": source_provider,
        "source_url": request.source_url,
        "license": request.license,
        "attribution_required": request.attribution_required.unwrap_or(false),
        "attribution_text": request.attribution_text,
        "redistribution_policy": request.redistribution_policy,
        "design_template": "startup_pitch",
        "design_theme": "clean_corporate",
        "design_profile": "sales_pitch",
        "tags": tags,
        "route_text": route_text,
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    fs::write(pack_root.join("manifest.json"), manifest_bytes)
        .map_err(|error| format!("could not write template manifest: {error}"))?;

    parse_imported_template_pack(&pack_root)
        .ok_or_else(|| "imported template manifest could not be loaded".to_string())
}

fn template_catalog_entries() -> Vec<TemplateCatalogEntry> {
    let bundled_provider = template_packs::bundled_template_pack_provider();
    let file_provider = file_template_catalog_provider();
    let imported_provider = imported_template_pack_provider();
    let mut providers: Vec<&dyn TemplateCatalogProvider> = Vec::new();
    if let Some(provider) = bundled_provider.as_ref() {
        providers.push(provider);
    }
    if let Some(provider) = file_provider.as_ref() {
        providers.push(provider);
    }
    if let Some(provider) = imported_provider.as_ref() {
        providers.push(provider);
    }
    collect_template_catalog_entries(&providers)
}

pub(crate) fn template_catalog_by_id_from_entries(
    entries: &[TemplateCatalogEntry],
    id: Option<&str>,
) -> Option<TemplateCatalogEntry> {
    let id = id?.trim();
    entries.iter().find(|entry| entry.id == id).cloned()
}

pub(crate) fn template_catalog_by_id(id: Option<&str>) -> Option<TemplateCatalogEntry> {
    template_catalog_by_id_from_entries(&template_catalog_entries(), id)
}

pub(crate) fn template_catalog_response_from_entries(
    entries: Vec<TemplateCatalogEntry>,
) -> TemplateCatalogResponse {
    TemplateCatalogResponse {
        templates: entries
            .into_iter()
            .map(|entry| {
                let selection_notes = template_catalog_selection_notes(&entry);
                TemplateCatalogEntryResponse {
                    provider: entry.provider,
                    id: entry.id,
                    name: entry.name,
                    kind: entry.kind,
                    category: entry.category,
                    description: entry.description,
                    name_it: entry.name_it,
                    description_it: entry.description_it,
                    use_cases: entry.use_cases,
                    audience: entry.audience,
                    design_template: entry.design_template,
                    design_theme: entry.design_theme,
                    design_profile: entry.design_profile,
                    design_components: entry.design_components,
                    layout_archetypes: entry.layout_archetypes,
                    tags: entry.tags,
                    intake_questions: entry.intake_questions,
                    selection_notes,
                    preview_ref: template_catalog_preview_response_ref(entry.preview_ref),
                    preview_html_ref: template_catalog_preview_response_ref(entry.preview_html_ref),
                    source_ref: entry.source_ref,
                    license: entry.license,
                    source_provider: entry.source_provider,
                    attribution_required: entry.attribution_required,
                    attribution_text: entry.attribution_text,
                    redistribution_policy: entry.redistribution_policy,
                    is_imported: entry.template_pack_root.is_some() && !entry.bundled,
                }
            })
            .collect(),
    }
}

fn template_catalog_selection_notes(entry: &TemplateCatalogEntry) -> Vec<String> {
    let mut notes = Vec::new();
    if !entry.use_cases.is_empty() {
        notes.push(format!(
            "Best when the request asks for {}.",
            entry.use_cases.join(", ")
        ));
    }
    if !entry.audience.is_empty() {
        notes.push(format!("Designed for {}.", entry.audience.join(", ")));
    }
    let mut visual = Vec::new();
    visual.push(entry.design_template.replace('_', " "));
    if let Some(theme) = entry.design_theme.as_deref() {
        visual.push(theme.replace('_', " "));
    }
    if let Some(profile) = entry.design_profile.as_deref() {
        visual.push(profile.replace('_', " "));
    }
    if !entry.design_components.is_empty() {
        visual.push(format!(
            "components: {}",
            entry
                .design_components
                .iter()
                .take(3)
                .map(|component| component.replace('_', " "))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    notes.push(format!("Visual contract: {}.", visual.join(" / ")));
    if !entry.layout_archetypes.is_empty() {
        notes.push(format!(
            "Structure: {}.",
            entry
                .layout_archetypes
                .iter()
                .take(6)
                .map(|layout| layout.replace('_', " "))
                .collect::<Vec<_>>()
                .join(" -> ")
        ));
    }
    notes
}

pub(crate) fn template_catalog_capability_entries() -> Vec<CapabilityEntry> {
    template_catalog_entries()
        .into_iter()
        .map(|entry| {
            let selection_notes = template_catalog_selection_notes(&entry).join(" ");
            CapabilityEntry {
                key: entry.id.to_string(),
                desc: entry.description.to_string(),
                text: format!(
                    "template catalog {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} Selection notes: {}",
                    entry.provider,
                    entry.id,
                    entry.name,
                    entry.kind,
                    entry.description,
                    entry.use_cases.join(" "),
                    entry.audience.join(" "),
                    entry.layout_archetypes.join(" "),
                    entry.tags.join(" "),
                    entry.preview_ref.as_deref().unwrap_or(""),
                    entry.source_ref.as_deref().unwrap_or(""),
                    entry.license.as_deref().unwrap_or(""),
                    entry.design_template,
                    entry.design_theme.as_deref().unwrap_or(""),
                    entry.design_profile.as_deref().unwrap_or(""),
                    entry.route_text,
                    selection_notes
                ),
                schema: None,
                is_skill: false,
                source: CapabilitySource::TemplateCatalog,
            }
        })
        .collect()
}

pub(crate) async fn template_catalog() -> Json<TemplateCatalogResponse> {
    Json(template_catalog_response_from_entries(
        template_catalog_entries(),
    ))
}

/// Whitelist of pack-relative assets the preview endpoint may serve. The route
/// IS bearer-gated (registered on `chat_routes`, under `require_gateway_token`;
/// the UI fetches it with `gatewayHeaders()`). This whitelist is defense-in-depth
/// so that even an authenticated caller can only reach the two known asset
/// shapes (`thumbnails/*.png`, `preview.html`) and never `source.pptx` or other
/// pack files. `jail_in_root` is the second fence, against path traversal.
pub(crate) fn template_preview_content_type(relative_path: &str) -> Option<&'static str> {
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

pub(crate) async fn template_preview(
    Query(query): Query<TemplatePreviewQuery>,
) -> Result<Response, GatewayError> {
    let reference = query.reference.trim();
    let rest = reference
        .strip_prefix("template-pack://")
        .ok_or_else(|| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "template_preview_ref_invalid",
            message: "Template preview reference is invalid.".to_string(),
        })?;

    for entry in template_catalog_entries() {
        let Some(pack_root) = entry.template_pack_root.as_ref() else {
            continue;
        };
        let matches_entry = entry.preview_ref.as_deref() == Some(reference)
            || entry.preview_html_ref.as_deref() == Some(reference);
        if !matches_entry {
            continue;
        }
        let prefix = format!("{}/", entry.id);
        let Some(relative_path) = rest.strip_prefix(&prefix) else {
            continue;
        };
        let Some(content_type) = template_preview_content_type(relative_path) else {
            return Err(GatewayError {
                status: StatusCode::BAD_REQUEST,
                code: "template_preview_path_invalid",
                message: "Template preview path is invalid.".to_string(),
            });
        };
        let path = jail_in_root(pack_root, relative_path).map_err(|message| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "template_preview_path_invalid",
            message,
        })?;
        if !path.is_file() {
            return Err(GatewayError {
                status: StatusCode::NOT_FOUND,
                code: "template_preview_missing",
                message: "Template preview asset is missing.".to_string(),
            });
        }
        let bytes = fs::read(&path).map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "template_preview_read_failed",
            message: error.to_string(),
        })?;
        return Response::builder()
            .header(CONTENT_TYPE, content_type)
            .body(Body::from(bytes))
            .map_err(|error| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "template_preview_response_failed",
                message: error.to_string(),
            });
    }

    Err(GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "template_preview_not_found",
        message: "Template preview was not found.".to_string(),
    })
}

pub(crate) async fn import_pptx_template(
    Json(request): Json<ImportPptxTemplateRequest>,
) -> Result<Json<TemplateCatalogEntryResponse>, GatewayError> {
    let root = imported_template_pack_root().ok_or_else(|| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "template_pack_root_unavailable",
        message: "Template pack root is unavailable.".to_string(),
    })?;
    let entry = import_pptx_template_pack(&root, request).map_err(|message| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "template_import_failed",
        message,
    })?;
    let mut response = template_catalog_response_from_entries(vec![entry]);
    let entry = response.templates.pop().ok_or_else(|| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "template_import_empty_response",
        message: "Imported template response is empty.".to_string(),
    })?;
    Ok(Json(entry))
}

pub(crate) async fn delete_template(
    Json(request): Json<TemplateDeleteRequest>,
) -> Result<Json<TemplateCatalogResponse>, GatewayError> {
    let root = imported_template_pack_root().ok_or_else(|| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "template_pack_root_unavailable",
        message: "Template pack root is unavailable.".to_string(),
    })?;
    delete_imported_template_pack(&root, &request.template_id).map_err(|message| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "template_delete_failed",
        message,
    })?;
    Ok(Json(template_catalog_response_from_entries(
        template_catalog_entries(),
    )))
}

pub(crate) async fn template_source_attachment(
    Json(request): Json<TemplateSourceAttachmentRequest>,
) -> Result<Json<TemplateSourceAttachmentResponse>, GatewayError> {
    let entry = template_catalog_by_id(Some(&request.template_id)).ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "template_not_found",
        message: "Template was not found in the catalog.".to_string(),
    })?;
    let source_path = entry.source_path.ok_or_else(|| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "template_source_unavailable",
        message: "This template does not expose a local source file.".to_string(),
    })?;
    if !source_path.is_file() {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "template_source_missing",
            message: "The imported template source file is missing.".to_string(),
        });
    }
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("pptx")
        .to_ascii_lowercase();
    let mime_type = if extension == "potx" {
        "application/vnd.openxmlformats-officedocument.presentationml.template"
    } else {
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    };
    let size_bytes = source_path
        .metadata()
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let display_slug = slugify_template_pack_name(&entry.name).unwrap_or_else(|| "template".into());
    Ok(Json(TemplateSourceAttachmentResponse {
        local_path: source_path.to_string_lossy().to_string(),
        display_name: format!("{display_slug}.{extension}"),
        mime_type: mime_type.to_string(),
        size_bytes,
    }))
}
