//! Generated artifact file and brand-kit owner.
//!
//! Owns generated artifact routes, authorized destination management, brand kit
//! persistence/materialization, ZIP export, cleanup, and the managed artifact
//! write/detect helpers consumed by tool execution.

use super::*;
use base64::Engine as _;

#[test]
fn artifacts_owner_smoke() {
    assert_eq!(
        artifact_thread_slug(Some("Thread: Demo / 01")),
        "Thread--Demo---01"
    );
    assert_eq!(artifact_mime("report.pdf"), "application/pdf");
}

#[derive(Debug, Deserialize)]
pub(crate) struct ArtifactRef {
    thread: String,
    name: String,
    /// Optional archived version index; absent → the current (latest) file.
    #[serde(default)]
    version: Option<usize>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ArtifactVersionsResponse {
    /// Number of ARCHIVED previous versions; the current file is the latest on top.
    versions: usize,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SaveArtifactContentRequest {
    thread: String,
    name: String,
    content: String,
}

/// Saves edited artifact content (in-app editor): writes a NEW version via the
/// same path as create_artifact (archives the previous, mirrors to project).
pub(crate) async fn save_artifact_content(
    Json(request): Json<SaveArtifactContentRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    if request.thread.contains('/') || request.thread.contains("..") {
        return Err(GatewayError {
            status: StatusCode::FORBIDDEN,
            code: "bad_artifact_path",
            message: "Invalid path.".to_string(),
        });
    }
    match write_text_artifact(&request.thread, &request.name, &request.content) {
        Ok(_) => Ok(ok_json()),
        Err(error) => Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "artifact_write",
            message: error,
        }),
    }
}

/// Reports how many archived versions an artifact has (for the panel switcher).
pub(crate) async fn artifact_versions(
    Query(reference): Query<ArtifactRef>,
) -> Json<ArtifactVersionsResponse> {
    if reference.name.contains('/')
        || reference.name.contains("..")
        || reference.thread.contains('/')
    {
        return Json(ArtifactVersionsResponse { versions: 0 });
    }
    let versions_dir = sandbox::artifacts_dir()
        .join(&reference.thread)
        .join(".versions")
        .join(&reference.name);
    let count = std::fs::read_dir(&versions_dir)
        .map(|dir| dir.flatten().filter(|e| e.path().is_file()).count())
        .unwrap_or(0);
    Json(ArtifactVersionsResponse { versions: count })
}

pub(crate) fn artifact_mime(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" => "application/vnd.ms-excel",
        "csv" => "text/csv",
        "pdf" => "application/pdf",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "txt" | "md" => "text/plain",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Streams a generated artifact for download, scoped to the per-thread output dir
/// (anti path-traversal: simple filename within the thread folder only).
pub(crate) async fn download_artifact(
    Query(reference): Query<ArtifactRef>,
) -> Result<Response, GatewayError> {
    let forbidden = reference.name.contains('/')
        || reference.name.contains('\\')
        || reference.name.contains("..")
        || reference.thread.contains('/')
        || reference.thread.contains("..");
    if forbidden {
        return Err(GatewayError {
            status: StatusCode::FORBIDDEN,
            code: "bad_artifact_path",
            message: "Invalid path.".to_string(),
        });
    }
    let dir = sandbox::artifacts_dir().join(&reference.thread);
    let path = match reference.version {
        Some(version) => dir
            .join(".versions")
            .join(&reference.name)
            .join(version.to_string()),
        None => dir.join(&reference.name),
    };
    if !path_within(&dir, &path) {
        return Err(GatewayError {
            status: StatusCode::FORBIDDEN,
            code: "artifact_outside_dir",
            message: "Path outside the artifact folder.".to_string(),
        });
    }
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "artifact_read",
            message: e.to_string(),
        })?
        .map_err(|e| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "artifact_read",
            message: e.to_string(),
        })?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", artifact_mime(&reference.name))
        .header(
            "content-disposition",
            format!(
                "attachment; filename=\"{}\"",
                reference.name.replace('"', "")
            ),
        )
        .body(Body::from(bytes))
        .expect("valid artifact response"))
}

#[derive(serde::Serialize)]
pub(crate) struct PdfPagesResponse {
    pages: Vec<String>,
}

/// Renders a PDF artifact's pages to images for a clean, document-style preview
/// (white pages, no dark native-viewer chrome). Falls back is the caller's job (the
/// UI uses the iframe viewer if this errors, e.g. pdfium unavailable).
pub(crate) async fn artifact_pdf_pages(
    Query(reference): Query<ArtifactRef>,
) -> Result<Json<PdfPagesResponse>, GatewayError> {
    let forbidden = reference.name.contains('/')
        || reference.name.contains('\\')
        || reference.name.contains("..")
        || reference.thread.contains('/')
        || reference.thread.contains("..");
    if forbidden {
        return Err(GatewayError {
            status: StatusCode::FORBIDDEN,
            code: "bad_artifact_path",
            message: "Invalid path.".to_string(),
        });
    }
    let dir = sandbox::artifacts_dir().join(&reference.thread);
    let path = match reference.version {
        Some(version) => dir
            .join(".versions")
            .join(&reference.name)
            .join(version.to_string()),
        None => dir.join(&reference.name),
    };
    if !path_within(&dir, &path) {
        return Err(GatewayError {
            status: StatusCode::FORBIDDEN,
            code: "artifact_outside_dir",
            message: "Path outside the artifact folder.".to_string(),
        });
    }
    let pages = tokio::task::spawn_blocking(move || attachments::render_pdf_to_images(&path))
        .await
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "pdf_render",
            message: e.to_string(),
        })?
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "pdf_render",
            message: e,
        })?;
    Ok(Json(PdfPagesResponse { pages }))
}

// ---- authorized write destinations (file-ops boundary) ----------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ArtifactDestination {
    pub(crate) label: String,
    pub(crate) path: String,
}

/// The user's BRAND KIT — the persistent identity the Presentations plugin (and the
/// future on-brand deck generator) apply to every deliverable: colours, fonts, logo,
/// organization name. Stored as one JSON in the data dir.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct BrandKit {
    #[serde(default)]
    pub(crate) organization: String,
    #[serde(default)]
    pub(crate) primary_color: String,
    #[serde(default)]
    pub(crate) secondary_color: String,
    #[serde(default)]
    pub(crate) accent_color: String,
    #[serde(default)]
    pub(crate) heading_font: String,
    #[serde(default)]
    pub(crate) body_font: String,
    /// Logo as a data URL (base64) so it's self-contained in the JSON; empty if none.
    #[serde(default)]
    pub(crate) logo_data_url: String,
}

impl Default for BrandKit {
    fn default() -> Self {
        Self {
            organization: String::new(),
            primary_color: "#2b6cb0".to_string(),
            secondary_color: "#1a202c".to_string(),
            accent_color: "#ed8936".to_string(),
            heading_font: "Inter".to_string(),
            body_font: "Inter".to_string(),
            logo_data_url: String::new(),
        }
    }
}

pub(crate) fn brand_kit_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("brand-kit.json"))
}

pub(crate) fn load_brand_kit() -> BrandKit {
    brand_kit_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<BrandKit>(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn save_brand_kit(kit: &BrandKit) -> Result<(), String> {
    let path = brand_kit_path().ok_or_else(|| "no data dir".to_string())?;
    let json = serde_json::to_string_pretty(kit).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub(crate) async fn brand_kit_get() -> Json<BrandKit> {
    Json(load_brand_kit())
}

pub(crate) async fn brand_kit_put(
    Json(kit): Json<BrandKit>,
) -> Result<Json<BrandKit>, GatewayError> {
    save_brand_kit(&kit).map_err(|message| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "brand_kit_save",
        message,
    })?;
    Ok(Json(kit))
}

pub(crate) fn artifact_destinations_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("artifact-destinations.json"))
}

pub(crate) fn load_artifact_destinations() -> Vec<ArtifactDestination> {
    artifact_destinations_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn prepare_chat_artifact_destinations() -> Vec<ArtifactDestination> {
    load_artifact_destinations()
}

pub(crate) fn write_artifact_destinations(list: &[ArtifactDestination]) -> Result<(), String> {
    let path = artifact_destinations_path().ok_or_else(|| "data dir unavailable".to_string())?;
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Resolves a destination (by label or exact path) among the AUTHORIZED ones.
/// The agent can only write where the user explicitly granted.
pub(crate) fn resolve_destination(name: &str) -> Option<ArtifactDestination> {
    let needle = name.trim();
    load_artifact_destinations()
        .into_iter()
        .find(|d| d.label.eq_ignore_ascii_case(needle) || d.path == needle)
}

#[derive(Debug, Serialize)]
pub(crate) struct ArtifactDestinationsResponse {
    destinations: Vec<ArtifactDestination>,
}

pub(crate) async fn list_artifact_destinations() -> Json<ArtifactDestinationsResponse> {
    Json(ArtifactDestinationsResponse {
        destinations: load_artifact_destinations(),
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct AddDestinationRequest {
    label: String,
    path: String,
}

pub(crate) async fn add_artifact_destination(
    Json(request): Json<AddDestinationRequest>,
) -> Result<Json<ArtifactDestinationsResponse>, GatewayError> {
    let path = request.path.trim().to_string();
    let label = request.label.trim().to_string();
    if path.is_empty() || !PathBuf::from(&path).is_dir() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "dest_not_found",
            message: "The specified folder does not exist.".to_string(),
        });
    }
    let mut list = load_artifact_destinations();
    if !list.iter().any(|d| d.path == path) {
        list.push(ArtifactDestination {
            label: if label.is_empty() {
                PathBuf::from(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.clone())
            } else {
                label
            },
            path,
        });
        write_artifact_destinations(&list).map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "dest_store",
            message: e,
        })?;
    }
    Ok(Json(ArtifactDestinationsResponse { destinations: list }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct RemoveDestinationQuery {
    path: String,
}

pub(crate) async fn remove_artifact_destination(
    Query(query): Query<RemoveDestinationQuery>,
) -> Result<Json<ArtifactDestinationsResponse>, GatewayError> {
    let mut list = load_artifact_destinations();
    list.retain(|d| d.path != query.path);
    write_artifact_destinations(&list).map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "dest_store",
        message: e,
    })?;
    Ok(Json(ArtifactDestinationsResponse { destinations: list }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct ArtifactFolderQuery {
    #[serde(default)]
    thread: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ArtifactFolderResponse {
    path: String,
}

/// Host filesystem path of the artifacts folder (optionally a thread subfolder),
/// so the desktop shell can reveal it in the Finder.
pub(crate) async fn artifact_folder_path(
    Query(query): Query<ArtifactFolderQuery>,
) -> Json<ArtifactFolderResponse> {
    let mut path = sandbox::artifacts_dir();
    if let Some(thread) = query.thread.as_ref().filter(|t| !t.trim().is_empty()) {
        path = path.join(artifact_thread_slug(Some(thread)));
    }
    Json(ArtifactFolderResponse {
        path: path.to_string_lossy().to_string(),
    })
}

#[derive(Debug, Serialize)]
pub(crate) struct ArtifactFileView {
    name: String,
    size: u64,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    reference: Option<String>,
    #[serde(default)]
    project_path: Option<String>,
    #[serde(default)]
    project_relative_path: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ArtifactThreadView {
    thread: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    workspace_name: Option<String>,
    #[serde(default)]
    chat_missing: bool,
    bytes: u64,
    files: Vec<ArtifactFileView>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ArtifactsUsage {
    base_path: String,
    total_bytes: u64,
    threads: Vec<ArtifactThreadView>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ExportArtifactsRequest {
    #[serde(default)]
    files: Vec<ExportArtifactFileRequest>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ExportArtifactFileRequest {
    pub(crate) thread: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) source: Option<String>,
    #[serde(default)]
    pub(crate) reference: Option<String>,
}

#[derive(Debug)]
pub(crate) struct ExportArtifactFile {
    group: String,
    name: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MemoryArtifactsQuery {
    #[serde(default)]
    thread: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct DeleteMemoryArtifactQuery {
    reference: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct MemoryArtifactView {
    reference: String,
    name: String,
    title: String,
    artifact_type: String,
    source: String,
    storage: String,
    project_relative_path: Option<String>,
    project_path: Option<String>,
    managed_path: Option<String>,
    size: u64,
    updated: bool,
    thread: String,
}

pub(crate) fn workspace_root_for_memory_workspace(
    workspace: &MemoryWorkspaceId,
) -> Option<PathBuf> {
    load_workspaces_file()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace.as_str())
        .and_then(|w| w.folder)
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

pub(crate) fn artifact_memory_delete_path_allowed(
    workspace_root: Option<&std::path::Path>,
    managed_root: &std::path::Path,
    path: &std::path::Path,
) -> bool {
    workspace_root.is_some_and(|root| path_within(root, path)) || path_within(managed_root, path)
}

pub(crate) fn artifact_file_name_for_zip(name: &str) -> String {
    let candidate = std::path::Path::new(name)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "artifact".to_string());
    let cleaned: String = candidate
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ' ') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['.', ' ', '-']).trim();
    if trimmed.is_empty() {
        "artifact".to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn workspace_name_for_artifact_scope(workspace_id: &str) -> Option<String> {
    match workspace_id {
        PERSONAL_WORKSPACE => Some("Personal".to_string()),
        THREADS_WORKSPACE => Some("Conversations".to_string()),
        other => load_workspaces_file()
            .workspaces
            .into_iter()
            .find(|workspace| workspace.id == other)
            .map(|workspace| workspace.name),
    }
}

pub(crate) fn artifact_thread_metadata(
    state: &AppState,
    thread_id: &str,
) -> (Option<String>, Option<String>, Option<String>, bool) {
    let Ok(store) = lock_store(state) else {
        return (None, None, None, true);
    };
    let thread = store.thread(thread_id).ok().flatten();
    let chat_missing = thread.is_none();
    let workspace_id = thread
        .as_ref()
        .and_then(|_| store.workspace_for_thread(thread_id).ok());
    drop(store);
    let workspace_name = workspace_id
        .as_deref()
        .and_then(workspace_name_for_artifact_scope);
    (
        thread.map(|thread| thread.title),
        workspace_id,
        workspace_name,
        chat_missing,
    )
}

pub(crate) fn artifact_bundle_title(dir: &std::path::Path) -> Option<String> {
    for name in [
        "deck.json",
        "document.json",
        "manifest.json",
        "artifact.json",
    ] {
        let path = dir.join(name);
        let Ok(raw) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        for key in ["title", "name", "subject"] {
            if let Some(title) = value
                .get(key)
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Some(title.to_string());
            }
        }
    }
    None
}

pub(crate) fn artifact_zip_segment(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['.', '-']).trim();
    if trimmed.is_empty() {
        "artifacts".to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn artifact_zip_entry_name(group: &str, name: &str) -> String {
    format!(
        "{}/{}",
        artifact_zip_segment(group),
        artifact_file_name_for_zip(name)
    )
}

pub(crate) fn artifact_unique_zip_entry_name(
    used: &mut std::collections::HashSet<String>,
    group: &str,
    name: &str,
) -> String {
    let base = artifact_zip_entry_name(group, name);
    if used.insert(base.clone()) {
        return base;
    }
    let safe_name = artifact_file_name_for_zip(name);
    let (stem, ext) = safe_name
        .rsplit_once('.')
        .map(|(left, right)| (left.to_string(), format!(".{right}")))
        .unwrap_or_else(|| (safe_name.clone(), String::new()));
    for suffix in 2.. {
        let candidate = artifact_zip_entry_name(group, &format!("{stem}-{suffix}{ext}"));
        if used.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!("unbounded suffix loop must return");
}

pub(crate) fn validate_managed_artifact_request(
    file: &ExportArtifactFileRequest,
) -> Result<(), GatewayError> {
    let forbidden = file.name.contains('/')
        || file.name.contains('\\')
        || file.name.contains("..")
        || file.thread.contains('/')
        || file.thread.contains('\\')
        || file.thread.contains("..");
    if forbidden {
        return Err(GatewayError {
            status: StatusCode::FORBIDDEN,
            code: "bad_artifact_path",
            message: "Invalid artifact path.".to_string(),
        });
    }
    Ok(())
}

pub(crate) fn read_managed_artifact_for_export(
    file: &ExportArtifactFileRequest,
) -> Result<ExportArtifactFile, GatewayError> {
    validate_managed_artifact_request(file)?;
    let group = artifact_thread_slug(Some(&file.thread));
    let dir = sandbox::artifacts_dir().join(&group);
    let path = dir.join(&file.name);
    if !path_within(&dir, &path) {
        return Err(GatewayError {
            status: StatusCode::FORBIDDEN,
            code: "artifact_outside_dir",
            message: "Path outside the artifact folder.".to_string(),
        });
    }
    let bytes = fs::read(&path).map_err(|error| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "artifact_read",
        message: error.to_string(),
    })?;
    Ok(ExportArtifactFile {
        group,
        name: file.name.clone(),
        bytes,
    })
}

pub(crate) fn read_memory_artifact_for_export(
    state: &AppState,
    file: &ExportArtifactFileRequest,
) -> Result<ExportArtifactFile, GatewayError> {
    let reference = file
        .reference
        .as_deref()
        .ok_or_else(|| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "artifact_missing_ref",
            message: "memory artifact export requires a reference".to_string(),
        })?
        .parse::<MemoryRef>()
        .map_err(|error| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "artifact_bad_ref",
            message: error,
        })?;
    let facade = memory_facade(state);
    let memory = facade
        .list_memories_for_ui(&reference.user_id, &reference.workspace_id)
        .unwrap_or_default()
        .into_iter()
        .find(|memory| memory.reference == reference)
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "artifact_not_found",
            message: "artifact memory not found".to_string(),
        })?;
    if memory.memory_type != "artifact"
        || !matches!(
            memory.status,
            MemoryStatus::Confirmed | MemoryStatus::Candidate
        )
    {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "artifact_bad_type",
            message: "memory reference is not an active artifact".to_string(),
        });
    }
    let metadata = memory.metadata;
    let path = metadata
        .get("project_path")
        .and_then(|value| value.as_str())
        .or_else(|| {
            metadata
                .get("managed_path")
                .and_then(|value| value.as_str())
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "artifact_missing_path",
            message: "artifact memory has no readable path".to_string(),
        })?;
    let workspace_root = workspace_root_for_memory_workspace(&reference.workspace_id);
    let managed_root = sandbox::artifacts_dir();
    if !artifact_memory_delete_path_allowed(workspace_root.as_deref(), &managed_root, &path) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "artifact_path_outside_scope",
            message: "artifact path is outside the authorized project/artifact roots".to_string(),
        });
    }
    let bytes = fs::read(&path).map_err(|error| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "artifact_read",
        message: error.to_string(),
    })?;
    let name = metadata
        .get("project_relative_path")
        .and_then(|value| value.as_str())
        .or_else(|| metadata.get("name").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&file.name)
        .to_string();
    Ok(ExportArtifactFile {
        group: format!("memory-{}", reference.workspace_id.as_str()),
        name,
        bytes,
    })
}

pub(crate) async fn export_artifacts_zip(
    State(state): State<AppState>,
    Json(request): Json<ExportArtifactsRequest>,
) -> Result<Response, GatewayError> {
    if request.files.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "artifact_export_empty",
            message: "No artifacts selected for export.".to_string(),
        });
    }
    let mut files = Vec::with_capacity(request.files.len());
    for file in &request.files {
        let exported = if file.source.as_deref() == Some("memory") {
            read_memory_artifact_for_export(&state, file)?
        } else {
            read_managed_artifact_for_export(file)?
        };
        files.push(exported);
    }
    let bytes = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut used = std::collections::HashSet::new();
        for file in files {
            let entry = artifact_unique_zip_entry_name(&mut used, &file.group, &file.name);
            writer
                .start_file(entry, options)
                .map_err(|error| error.to_string())?;
            writer
                .write_all(&file.bytes)
                .map_err(|error| error.to_string())?;
        }
        writer
            .finish()
            .map(|cursor| cursor.into_inner())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "artifact_export_join",
        message: error.to_string(),
    })?
    .map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "artifact_export_zip",
        message: error,
    })?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/zip")
        .header(
            "content-disposition",
            "attachment; filename=\"homun-artifacts.zip\"",
        )
        .body(Body::from(bytes))
        .expect("valid artifact export response"))
}

/// Disk usage of generated artifacts, grouped per conversation — drives the
/// management/cleanup view so the folder can't silently fill the disk.
pub(crate) async fn artifacts_usage(State(state): State<AppState>) -> Json<ArtifactsUsage> {
    let base = sandbox::artifacts_dir();
    let mut threads: Vec<ArtifactThreadView> = Vec::new();
    let mut total: u64 = 0;
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let thread = entry.file_name().to_string_lossy().to_string();
            let mut files: Vec<ArtifactFileView> = Vec::new();
            let mut bytes: u64 = 0;
            if let Ok(inner) = std::fs::read_dir(entry.path()) {
                for file in inner.flatten() {
                    if !file.path().is_file() {
                        continue;
                    }
                    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
                    bytes += size;
                    files.push(ArtifactFileView {
                        name: file.file_name().to_string_lossy().to_string(),
                        size,
                        source: Some("managed".to_string()),
                        reference: None,
                        project_path: None,
                        project_relative_path: None,
                        title: None,
                    });
                }
            }
            if files.is_empty() {
                continue;
            }
            files.sort_by(|a, b| a.name.cmp(&b.name));
            total += bytes;
            let (title, workspace_id, workspace_name, chat_missing) =
                artifact_thread_metadata(&state, &thread);
            let title = title.or_else(|| artifact_bundle_title(&entry.path()));
            threads.push(ArtifactThreadView {
                thread,
                title,
                workspace_id,
                workspace_name,
                chat_missing,
                bytes,
                files,
            });
        }
    }
    let user = gateway_memory_user_id();
    let workspace = gateway_memory_workspace_id();
    {
        let facade = memory_facade(&state);
        let mut files: Vec<ArtifactFileView> = facade
            .list_memories_for_ui(&user, &workspace)
            .unwrap_or_default()
            .into_iter()
            .filter(|memory| {
                memory.memory_type == "artifact"
                    && matches!(
                        memory.status,
                        MemoryStatus::Confirmed | MemoryStatus::Candidate
                    )
            })
            .filter_map(|memory| {
                let metadata = &memory.metadata;
                let name = metadata
                    .get("name")
                    .and_then(|value| value.as_str())
                    .or_else(|| {
                        metadata
                            .get("project_relative_path")
                            .and_then(|value| value.as_str())
                    })
                    .map(str::trim)
                    .filter(|value| !value.is_empty())?
                    .to_string();
                let project_path = metadata
                    .get("project_path")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                let managed_path = metadata
                    .get("managed_path")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                let path = project_path.as_deref().or(managed_path.as_deref());
                let path_exists = path
                    .map(|path| std::path::Path::new(path).is_file())
                    .unwrap_or(true);
                if !path_exists {
                    return None;
                }
                let size = path
                    .and_then(|path| std::fs::metadata(path).ok())
                    .map(|metadata| metadata.len())
                    .or_else(|| metadata.get("size_bytes").and_then(|value| value.as_u64()))
                    .unwrap_or_default();
                Some(ArtifactFileView {
                    name,
                    size,
                    source: Some("memory".to_string()),
                    reference: Some(memory.reference.to_string()),
                    project_path,
                    project_relative_path: metadata
                        .get("project_relative_path")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    title: metadata
                        .get("title")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                })
            })
            .collect();
        if !files.is_empty() {
            files.sort_by(|a, b| a.name.cmp(&b.name));
            let bytes = files.iter().map(|file| file.size).sum();
            total += bytes;
            let workspace_id = workspace.as_str().to_string();
            let workspace_name = workspace_name_for_artifact_scope(&workspace_id);
            threads.push(ArtifactThreadView {
                thread: format!("memory:{}", workspace_id),
                title: Some("Memory artifacts".to_string()),
                workspace_id: Some(workspace_id),
                workspace_name,
                chat_missing: false,
                bytes,
                files,
            });
        }
    }
    threads.sort_by_key(|thread| std::cmp::Reverse(thread.bytes));
    Json(ArtifactsUsage {
        base_path: base.to_string_lossy().to_string(),
        total_bytes: total,
        threads,
    })
}

/// Project artifact catalog backed by memory. Complements the older marker-driven
/// chat panel: files written in-place via `write_file` or Filesystem MCP do not
/// emit a managed `‹‹ARTIFACT››` card, but WS2-3.1 records them as
/// `memory_type="artifact"` with a project path.
pub(crate) async fn memory_artifacts(
    State(state): State<AppState>,
    Query(query): Query<MemoryArtifactsQuery>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let user = gateway_memory_user_id();
    let requested_thread = query
        .thread
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let workspace = if let Some(thread_id) = requested_thread.as_deref() {
        lock_store(&state)
            .ok()
            .and_then(|store| store.workspace_for_thread(thread_id).ok())
            .filter(|value| !value.trim().is_empty())
            .map(MemoryWorkspaceId::new)
            .unwrap_or_else(gateway_memory_workspace_id)
    } else if let Some(workspace) = query.workspace.filter(|value| !value.trim().is_empty()) {
        MemoryWorkspaceId::new(workspace)
    } else {
        gateway_memory_workspace_id()
    };
    let facade = memory_facade(&state);
    let mut artifacts: Vec<MemoryArtifactView> = facade
        .list_memories_for_ui(&user, &workspace)
        .unwrap_or_default()
        .into_iter()
        .filter(|memory| {
            memory.memory_type == "artifact"
                && matches!(
                    memory.status,
                    MemoryStatus::Confirmed | MemoryStatus::Candidate
                )
        })
        .filter(|memory| {
            artifact_memory_matches_thread(&memory.metadata, requested_thread.as_deref())
        })
        .filter_map(|memory| {
            let metadata = &memory.metadata;
            let name = metadata
                .get("name")
                .and_then(|value| value.as_str())
                .or_else(|| {
                    metadata
                        .get("project_relative_path")
                        .and_then(|value| value.as_str())
                })
                .map(str::trim)
                .filter(|value| !value.is_empty())?
                .to_string();
            let project_path = metadata
                .get("project_path")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let managed_path = metadata
                .get("managed_path")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let selected =
                existing_artifact_storage(project_path.as_deref(), managed_path.as_deref());
            if (project_path.is_some() || managed_path.is_some()) && selected.is_none() {
                return None;
            }
            let fs_size = selected
                .map(|(path, _)| path)
                .and_then(|path| std::fs::metadata(path).ok())
                .map(|metadata| metadata.len());
            let size = fs_size
                .or_else(|| metadata.get("size_bytes").and_then(|value| value.as_u64()))
                .unwrap_or_default();
            Some(MemoryArtifactView {
                reference: memory.reference.to_string(),
                title: metadata
                    .get("title")
                    .and_then(|value| value.as_str())
                    .unwrap_or(&name)
                    .to_string(),
                artifact_type: metadata
                    .get("artifact_type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("file")
                    .to_string(),
                source: metadata
                    .get("producer")
                    .and_then(|value| value.as_str())
                    .unwrap_or("memory")
                    .to_string(),
                storage: selected
                    .map(|(_, storage)| storage)
                    .unwrap_or("project")
                    .to_string(),
                project_relative_path: metadata
                    .get("project_relative_path")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                project_path,
                managed_path,
                size,
                updated: metadata
                    .get("updated")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false),
                thread: metadata
                    .get("thread_slug")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .to_string(),
                name,
            })
        })
        .collect();
    artifacts.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(serde_json::json!({
        "workspace": workspace.as_str(),
        "artifacts": artifacts,
    })))
}

pub(crate) fn artifact_memory_matches_thread(
    metadata: &serde_json::Value,
    requested_thread: Option<&str>,
) -> bool {
    let Some(requested_thread) = requested_thread else {
        return true;
    };
    ["thread_id", "thread_slug"].iter().any(|key| {
        metadata
            .get(key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| value == requested_thread)
    })
}

pub(crate) fn existing_artifact_storage<'a>(
    project_path: Option<&'a str>,
    managed_path: Option<&'a str>,
) -> Option<(&'a str, &'static str)> {
    managed_path
        .filter(|path| std::path::Path::new(path).is_file())
        .map(|path| (path, "managed"))
        .or_else(|| {
            project_path
                .filter(|path| std::path::Path::new(path).is_file())
                .map(|path| (path, "project"))
        })
}

pub(crate) async fn delete_memory_artifact(
    State(state): State<AppState>,
    Query(query): Query<DeleteMemoryArtifactQuery>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let reference = query
        .reference
        .parse::<MemoryRef>()
        .map_err(|error| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "artifact_bad_ref",
            message: error,
        })?;
    let user = reference.user_id.clone();
    let workspace = reference.workspace_id.clone();
    let facade = memory_facade(&state);
    let memory = facade
        .list_memories_for_ui(&user, &workspace)
        .unwrap_or_default()
        .into_iter()
        .find(|memory| memory.reference == reference)
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "artifact_not_found",
            message: "artifact memory not found".to_string(),
        })?;
    if memory.memory_type != "artifact" {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "artifact_bad_type",
            message: "memory reference is not an artifact".to_string(),
        });
    }

    let metadata = memory.metadata.clone();
    let path = metadata
        .get("project_path")
        .and_then(|value| value.as_str())
        .or_else(|| {
            metadata
                .get("managed_path")
                .and_then(|value| value.as_str())
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if let Some(path) = path.as_deref() {
        let workspace_root = workspace_root_for_memory_workspace(&workspace);
        let managed_root = sandbox::artifacts_dir();
        if !artifact_memory_delete_path_allowed(workspace_root.as_deref(), &managed_root, path) {
            return Err(GatewayError {
                status: StatusCode::BAD_REQUEST,
                code: "artifact_path_outside_scope",
                message: "artifact path is outside the authorized project/artifact roots"
                    .to_string(),
            });
        }
        if path.is_file() {
            std::fs::remove_file(path).map_err(|error| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "artifact_delete_file",
                message: error.to_string(),
            })?;
        }
    }

    let lifecycle = MemoryLifecycleRequest {
        actor_id: "artifact-ui".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "artifact_delete".to_string(),
    };
    facade
        .delete_memory(&lifecycle, &reference, "artifact deleted by user")
        .map_err(|error| GatewayError::memory(error.to_string()))?;
    if let (Some(thread_slug), Some(name)) = (
        metadata.get("thread_slug").and_then(|value| value.as_str()),
        metadata.get("name").and_then(|value| value.as_str()),
    ) {
        let entity_ref = MemoryRef::new(
            MemoryRefKind::Entity,
            user.clone(),
            workspace.clone(),
            format!("artifact:{thread_slug}:{name}"),
        );
        let _ = facade.tombstone_entity(&entity_ref, &user, &workspace, "artifact deleted by user");
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) fn ok_json() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

/// Deletes a single artifact file (anti path-traversal, scoped to its thread).
pub(crate) async fn delete_artifact_file(
    Query(reference): Query<ArtifactRef>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    if reference.name.contains('/')
        || reference.name.contains("..")
        || reference.thread.contains('/')
    {
        return Err(GatewayError {
            status: StatusCode::FORBIDDEN,
            code: "bad_artifact_path",
            message: "Invalid path.".to_string(),
        });
    }
    let dir = sandbox::artifacts_dir().join(&reference.thread);
    let path = dir.join(&reference.name);
    if path_within(&dir, &path) {
        let _ = std::fs::remove_file(&path);
    }
    Ok(ok_json())
}

/// Deletes all artifacts of one conversation.
pub(crate) async fn delete_artifact_thread(
    Query(query): Query<ArtifactFolderQuery>,
) -> Json<serde_json::Value> {
    if let Some(thread) = query.thread.as_ref().filter(|t| !t.trim().is_empty()) {
        let dir = sandbox::artifacts_dir().join(artifact_thread_slug(Some(thread)));
        let _ = std::fs::remove_dir_all(&dir);
    }
    ok_json()
}

/// Clears all generated artifacts (every conversation subfolder).
pub(crate) async fn clear_artifacts() -> Json<serde_json::Value> {
    let base = sandbox::artifacts_dir();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    ok_json()
}

/// Writes a model-authored text artifact to the conversation's managed output
/// dir (so it stays downloadable/previewable) and, if a project is active, also
/// to the project folder. Returns the byte size on success.
pub(crate) fn write_text_artifact(
    thread_slug: &str,
    name: &str,
    content: &str,
) -> Result<(u64, bool), String> {
    write_artifact_bytes(thread_slug, name, content.as_bytes())
}

/// Writes an artifact from raw BYTES (same versioning + project mirror as the text
/// path). Used for binary artifacts like rendered PDFs.
pub(crate) fn write_artifact_bytes(
    thread_slug: &str,
    name: &str,
    bytes: &[u8],
) -> Result<(u64, bool), String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Invalid file name.".to_string());
    }
    let managed_dir = sandbox::artifacts_dir().join(thread_slug);
    if let Err(error) = fs::create_dir_all(&managed_dir) {
        return Err(format!("Could not create the artifact folder: {error}"));
    }
    let managed_path = managed_dir.join(name);
    // Versioning: archive the previous content before overwriting, so the panel
    // can navigate ‹ n/m › through the artifact's history. `updated` = it existed.
    let updated = managed_path.exists();
    if updated {
        let versions_dir = managed_dir.join(".versions").join(name);
        let _ = fs::create_dir_all(&versions_dir);
        let index = fs::read_dir(&versions_dir)
            .map(|dir| dir.flatten().filter(|e| e.path().is_file()).count())
            .unwrap_or(0);
        let _ = fs::copy(&managed_path, versions_dir.join(index.to_string()));
    }
    if let Err(error) = fs::write(&managed_path, bytes) {
        return Err(format!("Artifact write failed: {error}"));
    }
    if let Some(folder) = active_workspace_folder() {
        let _ = fs::copy(&managed_path, std::path::Path::new(&folder).join(name));
    }
    Ok((bytes.len() as u64, updated))
}

/// Write the brand kit into a thread's output dir as files the deck renderer reads:
/// `brand.json` (theme: colours/fonts/org, logo→"logo.png") + `logo.png` (decoded). This
/// lets the model OMIT the large logo data URL from deck.json — which it can't reliably
/// emit through a shell — and have `deck-render` apply the brand itself. Best-effort.
/// True when `kit` has any field customized away from `BrandKit::default()`.
/// Pure predicate (no fs/thread-dir side effects) so it is unit-testable in
/// isolation from `materialize_brand_kit`'s artifact-writing plumbing.
///
/// The UNCONFIGURED default kit (#2b6cb0/#1a202c/#ed8936, Inter/Inter, no
/// logo) must never be materialized to brand.json: deck_render/doc_render's
/// `{**brand, **theme}` merge treats every present brand.json field as an
/// explicit, truthy override, so even the unconfigured default clobbers a
/// pack's curated editorial theme tokens (surface/ink/colours) at REAL
/// generation time — while the preview (built straight from the pack's
/// example.json, no brand.json in the loop) shows the correct curated look.
/// Mirrors the UI's own guard (`brandPreviewOverride` in BrandKitPanel.tsx
/// returns null for the default kit) so generation and preview agree.
pub(crate) fn should_materialize_brand_kit(kit: &BrandKit) -> bool {
    *kit != BrandKit::default()
}

pub(crate) fn materialize_brand_kit(thread_slug: &str) {
    let kit = load_brand_kit();
    let has_logo = !kit.logo_data_url.trim().is_empty();
    if should_materialize_brand_kit(&kit) {
        let theme = serde_json::json!({
            "organization": kit.organization,
            "primary": kit.primary_color,
            "secondary": kit.secondary_color,
            "accent": kit.accent_color,
            "heading_font": kit.heading_font,
            "body_font": kit.body_font,
            "logo": if has_logo { "logo.png" } else { "" },
        });
        if let Ok(bytes) = serde_json::to_vec_pretty(&theme) {
            let _ = write_artifact_bytes(thread_slug, "brand.json", &bytes);
        }
    }
    if has_logo
        && let Some(comma) = kit.logo_data_url.find(',')
        && let Ok(bytes) = base64::engine::general_purpose::STANDARD
            .decode(&kit.logo_data_url.as_bytes()[comma + 1..])
    {
        let _ = write_artifact_bytes(thread_slug, "logo.png", &bytes);
    }
}

pub(crate) fn materialize_deck_template_source(
    thread_slug: &str,
    template: Option<&TemplateCatalogEntry>,
) -> Result<Option<String>, String> {
    let Some(source_path) = template
        .and_then(|entry| entry.source_path.as_ref())
        .filter(|path| path.is_file())
    else {
        return Ok(None);
    };
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "pptx" | "potx"))
        .ok_or_else(|| "Template source must be a .pptx or .potx file.".to_string())?;
    let filename = format!("template-source.{extension}");
    let relative_path = format!(".internal/{filename}");
    let bytes = fs::read(source_path).map_err(|error| {
        format!(
            "Could not read template source {}: {error}",
            source_path.display()
        )
    })?;
    let internal_dir = sandbox::artifacts_dir().join(thread_slug).join(".internal");
    fs::create_dir_all(&internal_dir)
        .map_err(|error| format!("Could not create template staging dir: {error}"))?;
    fs::write(internal_dir.join(&filename), &bytes)
        .map_err(|error| format!("Could not stage template source: {error}"))?;
    Ok(Some(relative_path))
}

/// Copies an artifact to an AUTHORIZED destination folder (host-side). Enforces:
/// the file is a plain name within the thread's output dir, and the destination
/// is one the user granted. Returns a user-facing result line for the model.
pub(crate) fn save_artifact_to_destination(
    thread_slug: &str,
    file: &str,
    dest_name: &str,
) -> String {
    if file.is_empty() || file.contains('/') || file.contains('\\') || file.contains("..") {
        return "Invalid file name.".to_string();
    }
    let Some(dest) = resolve_destination(dest_name) else {
        let available = load_artifact_destinations()
            .iter()
            .map(|d| d.label.clone())
            .collect::<Vec<_>>()
            .join(", ");
        return format!(
            "Destination «{dest_name}» not authorized. Available: {}.",
            if available.is_empty() {
                "none".to_string()
            } else {
                available
            }
        );
    };
    let src_dir = sandbox::artifacts_dir().join(thread_slug);
    let src = src_dir.join(file);
    if !path_within(&src_dir, &src) || !src.is_file() {
        return format!("File «{file}» not found among the artifacts.");
    }
    let dest_dir = PathBuf::from(&dest.path);
    if !dest_dir.is_dir() {
        return format!("The destination folder «{}» no longer exists.", dest.label);
    }
    let target = dest_dir.join(file);
    match fs::copy(&src, &target) {
        Ok(_) => format!("✅ Saved to {}", target.display()),
        Err(error) => format!("Save failed: {error}"),
    }
}

/// Filesystem-safe per-conversation slug for the artifacts subfolder.
pub(crate) fn artifact_thread_slug(thread: Option<&str>) -> String {
    let raw = thread.unwrap_or("default").trim();
    let slug: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if slug.is_empty() {
        "default".to_string()
    } else {
        slug
    }
}

/// Lists files created/modified in the output dir since a run started — the
/// generated artifacts to surface as downloadable cards.
pub(crate) fn detect_new_artifacts(
    dir: &std::path::Path,
    since: std::time::SystemTime,
) -> Vec<(String, u64)> {
    let mut out: Vec<(String, u64)> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    let cutoff = since
        .checked_sub(std::time::Duration::from_secs(2))
        .unwrap_or(since);
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let recent = meta.modified().map(|m| m >= cutoff).unwrap_or(true);
        if !recent {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        out.push((name, meta.len()));
    }
    out.sort();
    out
}
