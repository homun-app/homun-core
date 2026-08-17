//! Workspace registry HTTP routes and persistence.
//!
//! Owns `workspaces.json`, workspace CRUD/policy routes, active workspace boot
//! selection, and retry-safe workspace deletion purging. Identity helpers,
//! memory storage semantics, and generic store maintenance remain separate.

use std::{collections::BTreeSet, env, fs, path::PathBuf};

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};

use local_first_desktop_gateway::workspace_delete::{
    GatewayWorkspacePurgeReport, WorkspaceDeleteError, coordinate_workspace_delete,
};
use local_first_memory::{
    DataSensitivity as MemoryDataSensitivity, MemoryEntity, MemoryFacade, MemoryRef, MemoryRefKind,
    PERSONAL_WORKSPACE, PrivacyDomain, WorkspaceId as MemoryWorkspaceId,
};
use local_first_task_runtime::{UserId, WorkspaceId};

use crate::{
    AppState, GatewayError, THREADS_WORKSPACE, active_workspace_id, base_workspace_id,
    canonical_memory_workspace_id, gateway_memory_user_id, gateway_paths::gateway_workspaces_path,
    gateway_user_id, graphify_out_dir, lock_task_store, memory_facade, reconcile_memory_scope,
    set_active_workspace,
};

// ---- P4.1 Projects = Workspaces ----------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct WorkspaceRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    /// Project root folder: drives @ file search and generated-file output for
    /// every conversation in this project. None for the legacy default project.
    #[serde(default)]
    pub(crate) folder: Option<String>,
    /// ADR 0023 — per-workspace policy overrides. `None` = inherit the global default
    /// (`runtime-settings.json`). Absent in legacy workspaces.json → None → behavior-preserving.
    #[serde(default)]
    pub(crate) sandbox_mode: Option<String>,
    #[serde(default)]
    pub(crate) approval_policy: Option<String>,
    /// Phase 2 — per-project extra writable folders for the exec fence. `None` = inherit the
    /// global `RuntimeSettings.writable_roots`; `Some(list)` REPLACES it (the project owns its
    /// list). The project root is ALWAYS writable regardless; this only ADDS folders.
    #[serde(default)]
    pub(crate) writable_roots: Option<Vec<String>>,
    /// Phase 3 — per-project sensitive categories that must ALWAYS force a confirmation.
    /// `None` = inherit the global `RuntimeSettings.skill_confirmations`; `Some(list)` REPLACES
    /// it. Tokens: `delete|financial|medical|sensitive-data` (unknown dropped at resolve time).
    #[serde(default)]
    pub(crate) skill_confirmations: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct WorkspacesFile {
    pub(crate) active: String,
    pub(crate) workspaces: Vec<WorkspaceRecord>,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspacesResponse {
    active_workspace_id: String,
    workspaces: Vec<WorkspaceRecord>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CreateWorkspaceRequest {
    pub(crate) name: String,
    /// Project folder (required): becomes the @ search root + output dir.
    #[serde(default)]
    pub(crate) folder: Option<String>,
}

/// Loads the persisted workspaces, seeding a default ("project") from the
/// env/default id on first run so there is always at least one.
pub(crate) fn load_workspaces_file() -> WorkspacesFile {
    let default_id = env::var("HOMUN_WORKSPACE_ID")
        .unwrap_or_else(|_| "local-workspace".to_string())
        .trim()
        .to_string();
    gateway_workspaces_path()
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<WorkspacesFile>(&raw).ok())
        .filter(|file| !file.workspaces.is_empty())
        .unwrap_or_else(|| WorkspacesFile {
            active: default_id.clone(),
            workspaces: vec![WorkspaceRecord {
                id: default_id,
                name: "Predefinito".to_string(),
                folder: None,
                sandbox_mode: None,
                approval_policy: None,
                writable_roots: None,
                skill_confirmations: None,
            }],
        })
}

/// The active project's root folder, if one is set.
pub(crate) fn active_workspace_folder() -> Option<String> {
    let active = active_workspace_id();
    load_workspaces_file()
        .workspaces
        .into_iter()
        .find(|w| w.id == active)
        .and_then(|w| w.folder)
        .filter(|f| !f.trim().is_empty())
}

pub(crate) fn save_workspaces_file(file: &WorkspacesFile) -> Result<(), std::io::Error> {
    let path = gateway_workspaces_path()?;
    let body = serde_json::to_string_pretty(file).unwrap_or_else(|_| "{}".to_string());
    fs::write(path, body)
}

/// Canonicalize a per-workspace `sandbox_mode` override token: `Some(canonical)` only for a
/// RECOGNIZED alias, else `None`. `SandboxMode::parse` is forgiving (unknown → the
/// workspace-write default), so it cannot itself distinguish a garbage token from a real
/// one — hence the explicit alias gate. `None` (unknown/blank) means "no override" =
/// inherit the global default, never a spurious explicit override.
pub(crate) fn normalize_sandbox_override(raw: &str) -> Option<String> {
    let token = raw.trim().to_ascii_lowercase();
    matches!(
        token.as_str(),
        "read-only"
            | "readonly"
            | "workspace-write"
            | "danger"
            | "danger-full-access"
            | "full-access"
    )
    .then(|| {
        crate::tool_safety::SandboxMode::parse(&token)
            .as_str()
            .to_string()
    })
}

/// Canonicalize a per-workspace `approval_policy` override token (mirrors
/// [`normalize_sandbox_override`]): `Some(canonical)` for a recognized alias, else `None`.
pub(crate) fn normalize_approval_override(raw: &str) -> Option<String> {
    let token = raw.trim().to_ascii_lowercase();
    matches!(
        token.as_str(),
        "untrusted" | "unless-trusted" | "on-failure" | "on-request" | "never"
    )
    .then(|| {
        crate::tool_safety::AskForApproval::parse(&token)
            .as_str()
            .to_string()
    })
}

/// Read one policy axis out of a JSON patch: `null` → clear to `None`; a recognized string
/// token → `Some(canonical)`; an unknown token or non-string → `None`. Used only when the
/// key is PRESENT in the patch (an absent key leaves the field untouched — partial merge).
pub(crate) fn policy_override_from_json(
    value: &serde_json::Value,
    normalize: impl Fn(&str) -> Option<String>,
) -> Option<String> {
    value.as_str().and_then(normalize)
}

/// Read a string-LIST override axis (Phase 2 `writable_roots` / Phase 3 `skill_confirmations`)
/// out of a JSON patch, mirroring [`policy_override_from_json`] for lists: an ARRAY →
/// `Some(list)` of trimmed non-empty strings (an empty array is a valid explicit "replace with
/// nothing" override); `null` or any non-array → `None` (clear back to inherit the global
/// default). Only called when the key is PRESENT in the patch (absent key → field untouched).
pub(crate) fn string_list_override_from_json(value: &serde_json::Value) -> Option<Vec<String>> {
    match value {
        serde_json::Value::Array(items) => Some(
            items
                .iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
        ),
        _ => None,
    }
}

/// Overlay a PARTIAL policy patch onto a `WorkspaceRecord` (mirrors `merge_runtime_settings`
/// for the two per-workspace axes). Only keys PRESENT in `patch` are touched, so a control
/// posting one axis never resets the sibling; `null` clears an override back to inherit;
/// unknown tokens are dropped to `None`. Pure so the merge is unit-testable.
pub(crate) fn merge_workspace_policy(
    current: &WorkspaceRecord,
    patch: &serde_json::Value,
) -> WorkspaceRecord {
    let mut merged = current.clone();
    if let Some(obj) = patch.as_object() {
        if let Some(value) = obj.get("sandbox_mode") {
            merged.sandbox_mode = policy_override_from_json(value, normalize_sandbox_override);
        }
        if let Some(value) = obj.get("approval_policy") {
            merged.approval_policy = policy_override_from_json(value, normalize_approval_override);
        }
        // Phase 2: per-project extra writable folders (array sets, null clears to inherit).
        if let Some(value) = obj.get("writable_roots") {
            merged.writable_roots = string_list_override_from_json(value);
        }
        // Phase 3: per-project skill-confirmation categories (array sets, null clears).
        if let Some(value) = obj.get("skill_confirmations") {
            merged.skill_confirmations = string_list_override_from_json(value);
        }
    }
    merged
}

/// `POST /api/workspaces/{id}/policy` — persist the per-workspace sandbox/approval override
/// (Fase 1). Body `{ sandbox_mode?, approval_policy? }`, each optional; a `null` value clears
/// that axis back to inheriting the global default (partial-merge, see
/// [`merge_workspace_policy`]). 404 if the workspace id is unknown. Returns the updated
/// record. Reconciliation invariant untouched: this only changes WHERE the mode/approval
/// come from, never disables the OS kernel fence.
pub(crate) async fn set_workspace_policy(
    Path(workspace_id): Path<String>,
    Json(patch): Json<serde_json::Value>,
) -> Result<Json<WorkspaceRecord>, GatewayError> {
    let mut file = load_workspaces_file();
    let Some(workspace) = file.workspaces.iter_mut().find(|w| w.id == workspace_id) else {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "workspace_not_found",
            message: format!("workspace not found: {workspace_id}"),
        });
    };
    let merged = merge_workspace_policy(workspace, &patch);
    *workspace = merged.clone();
    save_workspaces_file(&file).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "workspaces_write_failed",
        message: error.to_string(),
    })?;
    Ok(Json(merged))
}

pub(crate) fn workspace_memory_error(error: String) -> GatewayError {
    GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "workspace_memory_sync_failed",
        message: error,
    }
}

pub(crate) fn upsert_workspace_root_memory_entity(
    facade: &MemoryFacade,
    workspace: &WorkspaceRecord,
) -> Result<(), String> {
    let user = gateway_memory_user_id();
    let memory_workspace = canonical_memory_workspace_id(&workspace.id);
    if memory_workspace.as_str() == PERSONAL_WORKSPACE
        || memory_workspace.as_str() == THREADS_WORKSPACE
    {
        return Ok(());
    }
    let canonical_key = format!("workspace:{}", workspace.id);
    let existing = facade
        .list_entities_for_ui(&user, &memory_workspace)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|entity| entity.canonical_key == canonical_key);

    let mut aliases = BTreeSet::<String>::new();
    if let Some(entity) = existing.as_ref() {
        for alias in &entity.aliases {
            if !alias.trim().is_empty() {
                aliases.insert(alias.trim().to_string());
            }
        }
        if !entity.name.trim().is_empty() {
            aliases.insert(entity.name.trim().to_string());
        }
    }
    if !workspace.name.trim().is_empty() {
        aliases.insert(workspace.name.trim().to_string());
    }
    let folder = workspace
        .folder
        .as_ref()
        .map(|value| value.trim().to_string());
    if let Some(folder) = folder.as_ref().filter(|value| !value.is_empty()) {
        aliases.insert(folder.clone());
        if let Some(name) = std::path::Path::new(folder)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.trim().is_empty())
        {
            aliases.insert(name.trim().to_string());
        }
    }

    let previous_names: Vec<String> = aliases
        .iter()
        .filter(|alias| alias.as_str() != workspace.name.trim())
        .cloned()
        .collect();
    let entity = MemoryEntity {
        reference: MemoryRef::new(
            MemoryRefKind::Entity,
            user.clone(),
            memory_workspace.clone(),
            canonical_key.as_str(),
        ),
        user_id: user,
        workspace_id: memory_workspace,
        entity_type: "project".to_string(),
        name: workspace.name.trim().to_string(),
        canonical_key,
        aliases: aliases.into_iter().collect(),
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: MemoryDataSensitivity::Private,
        metadata: serde_json::json!({
            "source": "workspace_registry",
            "project_root": true,
            "workspace_id": workspace.id,
            "folder": folder.clone(),
            "folder_basename": folder
                .as_ref()
                .and_then(|value| std::path::Path::new(value).file_name())
                .and_then(|name| name.to_str())
                .unwrap_or(""),
            "previous_names": previous_names,
        }),
    };
    facade
        .upsert_entity(&entity)
        .map_err(|error| error.to_string())
}

/// Sets the in-process active workspace from the persisted selection at startup.
pub(crate) fn init_active_workspace_from_disk() {
    set_active_workspace(&load_workspaces_file().active);
}

pub(crate) async fn workspaces_list() -> Json<WorkspacesResponse> {
    let file = load_workspaces_file();
    Json(WorkspacesResponse {
        active_workspace_id: file.active,
        workspaces: file.workspaces,
    })
}

pub(crate) async fn create_workspace(
    State(state): State<AppState>,
    Json(request): Json<CreateWorkspaceRequest>,
) -> Result<Json<WorkspacesResponse>, GatewayError> {
    let name = request.name.trim().to_string();
    if name.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "workspace_name_required",
            message: "workspace name must not be empty".to_string(),
        });
    }
    // A project IS a folder: working inside a folder is its defining purpose
    // (drives @ search + where generated files land). The folder is REQUIRED and
    // must exist. (Only the base "Predefinito"/personal space is folderless.)
    let folder = request
        .folder
        .as_ref()
        .map(|f| f.trim())
        .filter(|f| !f.is_empty());
    let Some(folder) = folder else {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "workspace_folder_required",
            message: "Choose a folder for the project.".to_string(),
        });
    };
    if !PathBuf::from(folder).is_dir() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "workspace_folder_not_found",
            message: "The project folder does not exist.".to_string(),
        });
    }
    let mut file = load_workspaces_file();
    let id = format!("workspace_{}", uuid::Uuid::new_v4().simple());
    let workspace = WorkspaceRecord {
        id,
        name,
        folder: Some(folder.to_string()),
        sandbox_mode: None,
        approval_policy: None,
        writable_roots: None,
        skill_confirmations: None,
    };
    {
        let facade = memory_facade(&state);
        upsert_workspace_root_memory_entity(facade, &workspace).map_err(workspace_memory_error)?;
    }
    reconcile_memory_scope(&state, &MemoryWorkspaceId::new(workspace.id.clone()));
    file.workspaces.push(workspace);
    save_workspaces_file(&file).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "workspaces_write_failed",
        message: error.to_string(),
    })?;
    Ok(Json(WorkspacesResponse {
        active_workspace_id: file.active.clone(),
        workspaces: file.workspaces,
    }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetWorkspaceFolderRequest {
    pub(crate) folder: String,
}

/// Sets (or changes) a project's folder — also for the legacy default project.
pub(crate) async fn set_workspace_folder(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    Json(request): Json<SetWorkspaceFolderRequest>,
) -> Result<Json<WorkspacesResponse>, GatewayError> {
    let folder = request.folder.trim().to_string();
    if !folder.is_empty() && !PathBuf::from(&folder).is_dir() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "workspace_folder_not_found",
            message: "The folder does not exist.".to_string(),
        });
    }
    let mut file = load_workspaces_file();
    let Some(workspace) = file.workspaces.iter_mut().find(|w| w.id == workspace_id) else {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "workspace_not_found",
            message: format!("workspace not found: {workspace_id}"),
        });
    };
    workspace.folder = if folder.is_empty() {
        None
    } else {
        Some(folder)
    };
    let updated_workspace = workspace.clone();
    {
        let facade = memory_facade(&state);
        upsert_workspace_root_memory_entity(facade, &updated_workspace)
            .map_err(workspace_memory_error)?;
    }
    reconcile_memory_scope(
        &state,
        &MemoryWorkspaceId::new(updated_workspace.id.clone()),
    );
    save_workspaces_file(&file).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "workspaces_write_failed",
        message: error.to_string(),
    })?;
    Ok(Json(WorkspacesResponse {
        active_workspace_id: file.active.clone(),
        workspaces: file.workspaces,
    }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct RenameWorkspaceRequest {
    pub(crate) name: String,
}

/// Renames a project.
pub(crate) async fn rename_workspace(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
    Json(request): Json<RenameWorkspaceRequest>,
) -> Result<Json<WorkspacesResponse>, GatewayError> {
    let name = request.name.trim().to_string();
    if name.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "workspace_name_required",
            message: "The name cannot be empty.".to_string(),
        });
    }
    let mut file = load_workspaces_file();
    let Some(workspace) = file.workspaces.iter_mut().find(|w| w.id == workspace_id) else {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "workspace_not_found",
            message: format!("workspace not found: {workspace_id}"),
        });
    };
    workspace.name = name;
    let updated_workspace = workspace.clone();
    {
        let facade = memory_facade(&state);
        upsert_workspace_root_memory_entity(facade, &updated_workspace)
            .map_err(workspace_memory_error)?;
    }
    reconcile_memory_scope(
        &state,
        &MemoryWorkspaceId::new(updated_workspace.id.clone()),
    );
    save_workspaces_file(&file).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "workspaces_write_failed",
        message: error.to_string(),
    })?;
    Ok(Json(WorkspacesResponse {
        active_workspace_id: file.active.clone(),
        workspaces: file.workspaces,
    }))
}

/// Deletes a project. The base personal workspace ("Predefinito") is protected.
/// If the active project is deleted, the active falls back to the base workspace.
pub(crate) async fn delete_workspace(
    State(state): State<AppState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<WorkspacesResponse>, GatewayError> {
    if workspace_id == base_workspace_id() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "workspace_base_protected",
            message: "The default space cannot be deleted.".to_string(),
        });
    }
    let mut file = load_workspaces_file();
    let before = file.workspaces.len();
    file.workspaces.retain(|w| w.id != workspace_id);
    if file.workspaces.len() == before {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "workspace_not_found",
            message: format!("workspace not found: {workspace_id}"),
        });
    }
    let active_changed = file.active == workspace_id;
    if active_changed {
        file.active = base_workspace_id();
    }

    let report = purge_workspace_data(&state, &workspace_id, || {
        save_workspaces_file(&file)
            .map_err(|error| WorkspaceDeleteError::Registry(error.to_string()))
    })
    .map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "workspace_purge_failed",
        message: error.to_string(),
    })?;
    if active_changed {
        set_active_workspace(&file.active);
    }
    eprintln!(
        "purge_workspace: completed {workspace_id} (chat={}, tasks={}, memory={}, graph_cache={})",
        report.chat_threads, report.tasks, report.memory_rows, report.graph_cache_removed
    );
    Ok(Json(WorkspacesResponse {
        active_workspace_id: file.active.clone(),
        workspaces: file.workspaces,
    }))
}

#[derive(Deserialize)]
pub(crate) struct ReorderWorkspacesRequest {
    ordered_ids: Vec<String>,
}

/// Persist a manual drag-and-drop order for projects: rewrite the workspaces list to the given
/// id order. Any workspace not named in the request (defensive — the client sends the full list)
/// keeps its original relative position at the end.
pub(crate) async fn reorder_workspaces(
    Json(request): Json<ReorderWorkspacesRequest>,
) -> Result<Json<WorkspacesResponse>, GatewayError> {
    let mut file = load_workspaces_file();
    let original = std::mem::take(&mut file.workspaces);
    for id in &request.ordered_ids {
        if let Some(workspace) = original.iter().find(|w| &w.id == id) {
            file.workspaces.push(workspace.clone());
        }
    }
    for workspace in &original {
        if !request.ordered_ids.contains(&workspace.id) {
            file.workspaces.push(workspace.clone());
        }
    }
    save_workspaces_file(&file).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "workspaces_write_failed",
        message: error.to_string(),
    })?;
    Ok(Json(WorkspacesResponse {
        active_workspace_id: file.active.clone(),
        workspaces: file.workspaces,
    }))
}

/// Purges all workspace-owned data before removing the workspace registry entry.
/// Every step is retry-safe: if one fails, `workspaces.json` still contains the
/// workspace and the user can retry the deletion.
fn purge_workspace_data<SaveRegistry>(
    state: &AppState,
    workspace_id: &str,
    save_registry: SaveRegistry,
) -> Result<GatewayWorkspacePurgeReport, WorkspaceDeleteError>
where
    SaveRegistry: FnOnce() -> Result<(), WorkspaceDeleteError>,
{
    coordinate_workspace_delete(
        || {
            let store = state.chat_store.lock().map_err(|error| {
                WorkspaceDeleteError::Chat(format!("chat store lock poisoned: {error}"))
            })?;
            store
                .purge_workspace(workspace_id)
                .map_err(|error| WorkspaceDeleteError::Chat(error.to_string()))
        },
        || {
            let task_user = UserId::new("local".to_string());
            let task_workspace = WorkspaceId::new(workspace_id.to_string());
            let store = lock_task_store(state)
                .map_err(|error| WorkspaceDeleteError::Task(error.message))?;
            let secret_refs = store
                .delete_browser_checkpoints_for_workspace(
                    task_user.as_str(),
                    task_workspace.as_str(),
                )
                .map_err(|error| WorkspaceDeleteError::Task(error.to_string()))?;
            let cleared_secret_count = secret_refs.len();
            for reference in secret_refs {
                let _ = state.browser_checkpoint_secret_store.delete(&reference);
            }
            tracing::info!(
                target: "browser::checkpoint",
                event = "browser_checkpoint_cleared",
                reason = "workspace_deleted",
                cleared_secret_count,
                "browser checkpoint lifecycle cleanup"
            );
            store
                .purge_workspace(&task_user, &task_workspace)
                .map_err(|error| WorkspaceDeleteError::Task(error.to_string()))
        },
        || {
            let memory_user = gateway_memory_user_id();
            let memory_workspace = MemoryWorkspaceId::new(workspace_id.to_string());
            let facade = memory_facade(state);
            facade
                .purge_workspace(&memory_user, &memory_workspace)
                .map(|report| report.total_deleted)
                .map_err(|error| WorkspaceDeleteError::Memory(error.to_string()))
        },
        || {
            let store = state.usage_store.lock().map_err(|error| {
                WorkspaceDeleteError::Usage(format!("usage store lock poisoned: {error}"))
            })?;
            store
                .purge_workspace(gateway_user_id().as_str(), workspace_id)
                .map_err(|error| WorkspaceDeleteError::Usage(error.to_string()))
        },
        || {
            let graph_cache = graphify_out_dir(workspace_id);
            if !graph_cache.exists() {
                return Ok(false);
            }
            std::fs::remove_dir_all(&graph_cache).map_err(|error| {
                WorkspaceDeleteError::GraphCache(format!("{}: {error}", graph_cache.display()))
            })?;
            Ok(true)
        },
        save_registry,
    )
}

pub(crate) async fn select_workspace(
    Path(workspace_id): Path<String>,
) -> Result<Json<WorkspacesResponse>, GatewayError> {
    let mut file = load_workspaces_file();
    if !file
        .workspaces
        .iter()
        .any(|workspace| workspace.id == workspace_id)
    {
        return Err(GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "workspace_not_found",
            message: format!("workspace not found: {workspace_id}"),
        });
    }
    file.active = workspace_id.clone();
    save_workspaces_file(&file).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "workspaces_write_failed",
        message: error.to_string(),
    })?;
    set_active_workspace(&workspace_id);
    Ok(Json(WorkspacesResponse {
        active_workspace_id: file.active.clone(),
        workspaces: file.workspaces,
    }))
}
