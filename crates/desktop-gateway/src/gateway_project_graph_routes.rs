//! Project graph and integrity HTTP routes.
//!
//! Owns project source fingerprinting, Graphify refresh entry points, graph
//! freshness projection, and integrity repair HTTP surfaces. Memory graph
//! storage semantics remain in the memory facade/graph owners.

use super::*;

/// Directories that are vendored deps / build output / caches — never the user's
/// source. Excluded from BOTH the staleness walk and the code-file count, and mirrored
/// by the container's rsync. `site-packages` catches any Python venv regardless of name.
fn is_noise_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "site-packages"
            | "target"
            | "vendor"
            | ".venv"
            | "venv"
            | ".tox"
            | ".mypy_cache"
            | ".pytest_cache"
            | ".ruff_cache"
            | ".next"
            | "coverage"
            | "dist"
            | "build"
            | "__pycache__"
            | "graphify-out"
    ) || name.ends_with(".egg-info")
}

/// Whether a filename is a source file Graphify can extract (so the size guard reflects
/// real code, not data dumps). Mirrors Graphify's tree-sitter language coverage.
fn is_code_file(name: &str) -> bool {
    let ext = match name.rsplit_once('.') {
        Some((_, e)) => e.to_lowercase(),
        None => return false,
    };
    matches!(
        ext.as_str(),
        "py" | "pyi"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "rs"
            | "go"
            | "java"
            | "rb"
            | "c"
            | "cc"
            | "cpp"
            | "cxx"
            | "h"
            | "hpp"
            | "cs"
            | "php"
            | "swift"
            | "kt"
            | "kts"
            | "scala"
            | "m"
            | "lua"
    )
}

fn project_fingerprint_update(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}

fn project_fingerprint_field(hash: &mut u64, bytes: &[u8]) {
    project_fingerprint_update(hash, &(bytes.len() as u64).to_le_bytes());
    project_fingerprint_update(hash, bytes);
}

#[cfg(unix)]
fn project_relative_path_bytes(path: &std::path::Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn project_relative_path_bytes(path: &std::path::Path) -> Vec<u8> {
    path.to_string_lossy().replace('\\', "/").into_bytes()
}

#[cfg(unix)]
fn project_path_from_git_bytes(bytes: &[u8]) -> std::path::PathBuf {
    use std::os::unix::ffi::OsStrExt;
    std::path::PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
}

#[cfg(not(unix))]
fn project_path_from_git_bytes(bytes: &[u8]) -> std::path::PathBuf {
    std::path::PathBuf::from(String::from_utf8_lossy(bytes).as_ref())
}

fn project_relative_path_is_source(bytes: &[u8]) -> bool {
    let path = project_path_from_git_bytes(bytes);
    let mut components = path.components().filter_map(|component| match component {
        std::path::Component::Normal(value) => Some(value.to_string_lossy()),
        _ => None,
    });
    let Some(first) = components.next() else {
        return false;
    };
    let mut last = first;
    if is_noise_dir(&last) {
        return false;
    }
    for component in components {
        if is_noise_dir(&component) {
            return false;
        }
        last = component;
    }
    is_code_file(&last)
}

fn project_fingerprint_file(hash: &mut u64, path: &std::path::Path) {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        project_fingerprint_field(hash, b"missing");
        return;
    };
    if metadata.file_type().is_symlink() {
        project_fingerprint_field(hash, b"symlink");
        let target = std::fs::read_link(path)
            .map(|value| project_relative_path_bytes(&value))
            .unwrap_or_default();
        project_fingerprint_field(hash, &target);
        return;
    }

    project_fingerprint_field(hash, b"file");
    project_fingerprint_update(hash, &metadata.len().to_le_bytes());
    let Ok(mut file) = std::fs::File::open(path) else {
        project_fingerprint_field(hash, b"unreadable");
        return;
    };
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => project_fingerprint_update(hash, &buffer[..read]),
            Err(_) => {
                project_fingerprint_field(hash, b"read-error");
                break;
            }
        }
    }
}

fn project_fingerprint_source_tree(
    root: &std::path::Path,
    tracked: Option<&HashSet<Vec<u8>>>,
    dirty: &HashSet<Vec<u8>>,
    hash: &mut u64,
) {
    fn walk(
        root: &std::path::Path,
        dir: &std::path::Path,
        tracked: Option<&HashSet<Vec<u8>>>,
        dirty: &HashSet<Vec<u8>>,
        hash: &mut u64,
    ) {
        let Ok(read_dir) = std::fs::read_dir(dir) else {
            project_fingerprint_field(hash, b"unreadable-directory");
            return;
        };
        let mut entries = read_dir.flatten().collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name();
            let name_text = name.to_string_lossy();
            if is_noise_dir(&name_text) {
                continue;
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                walk(root, &path, tracked, dirty, hash);
                continue;
            }
            if !is_code_file(&name_text) {
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let relative = project_relative_path_bytes(relative);
            let needs_content = tracked
                .map(|paths| !paths.contains(&relative) || dirty.contains(&relative))
                .unwrap_or(true);
            if needs_content {
                project_fingerprint_field(hash, &relative);
                project_fingerprint_file(hash, &path);
            }
        }
    }
    walk(root, root, tracked, dirty, hash);
}

/// Authoritative "has the analyzed code changed?" signal. For Git projects, HEAD
/// represents clean tracked sources while dirty tracked, untracked, and Git-ignored
/// source contents are hashed incrementally from disk. Non-Git projects hash the same
/// source tree in full. File contents are streamed, and vendored/build trees are pruned,
/// so the signal follows Graphify's actual input without materializing large files.
pub(crate) fn project_change_fingerprint(root: &std::path::Path) -> String {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| o.stdout)
    };
    if let Some(head) = git(&["rev-parse", "HEAD"]) {
        let mut h: u64 = 0xcbf29ce484222325;
        project_fingerprint_field(&mut h, &head);
        let tracked = git(&["ls-files", "--cached", "-z"])
            .unwrap_or_default()
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty() && project_relative_path_is_source(path))
            .map(Vec::from)
            .collect::<HashSet<_>>();
        let dirty = git(&["diff", "--relative", "--name-only", "-z", "HEAD", "--"])
            .unwrap_or_default()
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty() && project_relative_path_is_source(path))
            .map(Vec::from)
            .collect::<HashSet<_>>();
        let mut dirty_paths = dirty.iter().collect::<Vec<_>>();
        dirty_paths.sort();
        for path in dirty_paths {
            project_fingerprint_field(&mut h, path);
        }
        project_fingerprint_source_tree(root, Some(&tracked), &dirty, &mut h);
        return format!("git:{}:{:x}", String::from_utf8_lossy(&head).trim(), h);
    }
    let mut h: u64 = 0xcbf29ce484222325;
    project_fingerprint_source_tree(root, None, &HashSet::new(), &mut h);
    format!("tree:{h:x}")
}

/// Count CODE files under a project, stopping early at `cap` (cheap guard). Counts only
/// real source (excludes vendored deps + data files) so the size cap reflects how much
/// the user's project actually is — a 57k-file repo that's mostly venvs/data still
/// counts small. Drives the auto-map skip + the "map a subfolder" hint for huge repos.
fn project_code_file_count_capped(root: &std::path::Path, cap: usize) -> usize {
    fn walk(dir: &std::path::Path, n: &mut usize, cap: usize, depth: usize) {
        if *n >= cap || depth > 12 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if *n >= cap {
                return;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if is_noise_dir(&name) {
                continue;
            }
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => walk(&entry.path(), n, cap, depth + 1),
                Ok(_) if is_code_file(&name) => *n += 1,
                _ => {}
            }
        }
    }
    let mut n = 0;
    walk(root, &mut n, cap, 0);
    n
}

/// The gateway-managed output dir for a workspace's code graph (outside the user's repo).
pub(crate) fn graphify_out_dir(workspace_id: &str) -> std::path::PathBuf {
    let base = gateway_data_dir().unwrap_or_else(|_| std::env::temp_dir());
    base.join("graphify-out").join(workspace_id)
}

fn integrity_known_scopes() -> Vec<(MemoryUserId, MemoryWorkspaceId)> {
    let user = gateway_memory_user_id();
    let mut workspace_ids = BTreeSet::from([
        PERSONAL_WORKSPACE.to_string(),
        THREADS_WORKSPACE.to_string(),
    ]);
    for workspace in load_workspaces_file().workspaces {
        workspace_ids.insert(
            canonical_memory_workspace_id(&workspace.id)
                .as_str()
                .to_string(),
        );
    }
    workspace_ids
        .into_iter()
        .map(|workspace_id| (user.clone(), MemoryWorkspaceId::new(workspace_id)))
        .collect()
}

fn integrity_graph_statuses() -> Vec<GraphIntegrityStatus> {
    let user = gateway_memory_user_id();
    let mut workspaces = load_workspaces_file()
        .workspaces
        .into_iter()
        .filter_map(|workspace| {
            workspace
                .folder
                .filter(|folder| !folder.trim().is_empty())
                .map(|folder| (workspace.id, folder))
        })
        .collect::<Vec<_>>();
    workspaces.sort_by(|left, right| left.0.cmp(&right.0));
    workspaces
        .into_iter()
        .map(|(workspace_id, folder)| {
            let fingerprint = project_change_fingerprint(std::path::Path::new(&folder));
            inspect_registered_graph(
                &workspace_id,
                &graphify_out_dir(&workspace_id),
                &fingerprint,
                &user,
            )
        })
        .collect()
}

fn integrity_graph_status_for_workspace(
    workspace_id: &MemoryWorkspaceId,
) -> Result<GraphIntegrityStatus, GatewayError> {
    let workspace_id = workspace_id.as_str();
    let folder = load_workspaces_file()
        .workspaces
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .and_then(|workspace| workspace.folder)
        .filter(|folder| !folder.trim().is_empty())
        .ok_or_else(|| integrity_bad_request("integrity_refresh_workspace_invalid"))?;
    let fingerprint = project_change_fingerprint(std::path::Path::new(&folder));
    Ok(inspect_registered_graph(
        workspace_id,
        &graphify_out_dir(workspace_id),
        &fingerprint,
        &gateway_memory_user_id(),
    ))
}

fn integrity_bad_request(code: &'static str) -> GatewayError {
    GatewayError {
        status: StatusCode::BAD_REQUEST,
        code,
        message: "integrity request is invalid".to_string(),
    }
}

fn integrity_internal_error(code: &'static str, error: impl std::fmt::Display) -> GatewayError {
    eprintln!("integrity API error ({code}): {error}");
    GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code,
        message: "integrity operation failed".to_string(),
    }
}

fn integrity_preview_for_actions(
    state: &AppState,
    actions: Vec<IntegrityRepairAction>,
) -> Result<IntegrityRepairPreviewResponse, GatewayError> {
    let actions = canonical_integrity_actions(actions)
        .map_err(|_| integrity_bad_request("integrity_preview_invalid"))?;
    let known_scopes = integrity_known_scopes();
    let mut graph_statuses = Vec::new();
    let (memory_checksum, estimates) = if actions[0].is_graph_refresh() {
        let memory = memory_facade(state)
            .audit_integrity(&known_scopes)
            .map_err(|error| integrity_internal_error("integrity_audit_failed", error))?;
        let IntegrityRepairAction::RefreshProjectGraph { workspace_id } = &actions[0] else {
            unreachable!("canonical graph-only action must be a refresh")
        };
        let status = integrity_graph_status_for_workspace(workspace_id)?;
        let estimated_rows = status
            .report
            .as_ref()
            .map(|report| report.unique_nodes.saturating_add(report.unique_edges) as u64)
            .unwrap_or(0);
        graph_statuses.push(status);
        (
            memory.checksum,
            vec![IntegrityRepairEstimate {
                action: actions[0].clone(),
                estimated_rows,
            }],
        )
    } else {
        let memory_actions = actions
            .iter()
            .filter_map(IntegrityRepairAction::as_memory_action)
            .collect::<Vec<_>>();
        let preview = memory_facade(state)
            .preview_integrity_repair(&known_scopes, memory_actions)
            .map_err(|error| match error {
                MemoryError::Validation(_) | MemoryError::Policy(_) | MemoryError::NotFound(_) => {
                    integrity_bad_request("integrity_preview_invalid")
                }
                MemoryError::Store(_) => {
                    integrity_internal_error("integrity_preview_failed", error)
                }
            })?;
        (
            preview.audit_checksum,
            preview
                .estimates
                .into_iter()
                .map(IntegrityRepairEstimate::from)
                .collect(),
        )
    };
    let audit_checksum = gateway_audit_checksum(&memory_checksum, &actions, &graph_statuses)
        .map_err(|error| integrity_internal_error("integrity_preview_failed", error))?;
    let approval_token = gateway_approval_token(&audit_checksum, &actions)
        .map_err(|error| integrity_internal_error("integrity_preview_failed", error))?;
    Ok(IntegrityRepairPreviewResponse {
        audit_checksum,
        actions,
        estimates,
        approval_token,
    })
}

pub(crate) async fn integrity_audit(
    State(state): State<AppState>,
) -> Result<Json<IntegrityAuditResponse>, GatewayError> {
    let known_scopes = integrity_known_scopes();
    let memory = memory_facade(&state)
        .audit_integrity(&known_scopes)
        .map_err(|error| integrity_internal_error("integrity_audit_failed", error))?;
    let vault = lock_vault_store(&state)?
        .audit_integrity()
        .map_err(|error| integrity_internal_error("integrity_audit_failed", error))?;
    let runtime = lock_task_store(&state)?
        .audit_runtime_integrity()
        .map_err(|error| integrity_internal_error("integrity_audit_failed", error))?;
    Ok(Json(IntegrityAuditResponse {
        memory,
        vault,
        runtime,
        graphs: integrity_graph_statuses(),
    }))
}

pub(crate) async fn integrity_repair_preview(
    State(state): State<AppState>,
    Json(request): Json<IntegrityRepairPreviewRequest>,
) -> Result<Json<IntegrityRepairPreviewResponse>, GatewayError> {
    Ok(Json(integrity_preview_for_actions(
        &state,
        request.actions,
    )?))
}

fn linked_repair_gateway_error(error: LinkedRepairError) -> GatewayError {
    match error {
        LinkedRepairError::StalePreview | LinkedRepairError::ApprovalTokenMismatch => {
            GatewayError {
                status: StatusCode::CONFLICT,
                code: "linked_memory_repair_preview_stale",
                message: "linked-memory repair preview is stale".to_string(),
            }
        }
        LinkedRepairError::BackupPathInvalid => {
            integrity_bad_request("linked_memory_repair_backup_invalid")
        }
        LinkedRepairError::InjectedFailure
        | LinkedRepairError::Database(_)
        | LinkedRepairError::Io(_) => {
            integrity_internal_error("linked_memory_repair_failed", error)
        }
    }
}

pub(crate) async fn linked_memory_repair_preview(
    State(_state): State<AppState>,
) -> Result<Json<LinkedMemoryRepairPreview>, GatewayError> {
    let chat_path = gateway_database_path()
        .map_err(|error| integrity_internal_error("linked_memory_repair_failed", error))?;
    let memory_path = gateway_memory_database_path()
        .map_err(|error| integrity_internal_error("linked_memory_repair_failed", error))?;
    preview_linked_memory_repair(&chat_path, &memory_path)
        .map(Json)
        .map_err(linked_repair_gateway_error)
}

fn next_linked_memory_repair_backup_directory() -> Result<PathBuf, GatewayError> {
    let timestamp = OffsetDateTime::now_utc().unix_timestamp_nanos();
    let parent = gateway_data_dir()
        .map_err(|error| integrity_internal_error("linked_memory_repair_backup_failed", error))?
        .join("backups")
        .join("linked-memory");
    fs::create_dir_all(&parent)
        .map_err(|error| integrity_internal_error("linked_memory_repair_backup_failed", error))?;
    Ok(parent.join(format!("{timestamp}-{}", uuid::Uuid::new_v4().simple())))
}

pub(crate) async fn linked_memory_repair_apply(
    State(state): State<AppState>,
    Json(request): Json<LinkedMemoryRepairApplyRequest>,
) -> Result<Json<LinkedMemoryRepairApplyResponse>, GatewayError> {
    if !request.confirm {
        return Err(integrity_bad_request(
            "linked_memory_repair_confirmation_required",
        ));
    }
    let chat_path = gateway_database_path()
        .map_err(|error| integrity_internal_error("linked_memory_repair_failed", error))?;
    let memory_path = gateway_memory_database_path()
        .map_err(|error| integrity_internal_error("linked_memory_repair_failed", error))?;
    let backup_directory = next_linked_memory_repair_backup_directory()?;
    let chat_guard = state.chat_store.lock().map_err(|error| GatewayError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "chat_store_lock_error",
        message: error.to_string(),
    })?;
    let result = apply_linked_memory_repair(
        &chat_path,
        &memory_path,
        &backup_directory,
        &request.preview,
        LinkedRepairFailureInjection::None,
    )
    .map_err(linked_repair_gateway_error)?;
    drop(chat_guard);
    for workspace in &result.affected_workspaces {
        if workspace != PERSONAL_WORKSPACE && workspace != THREADS_WORKSPACE {
            rebuild_project_brief(
                &state.memory_facade,
                &gateway_memory_user_id(),
                &MemoryWorkspaceId::new(workspace),
            );
        }
    }
    Ok(Json(result))
}

fn next_integrity_backup_path() -> Result<PathBuf, GatewayError> {
    let timestamp = OffsetDateTime::now_utc().unix_timestamp_nanos();
    let directory = gateway_data_dir()
        .map_err(|error| integrity_internal_error("integrity_backup_failed", error))?
        .join("backups")
        .join("integrity")
        .join(format!("{timestamp}-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&directory)
        .map_err(|error| integrity_internal_error("integrity_backup_failed", error))?;
    Ok(directory.join("memory.sqlite"))
}

pub(crate) async fn integrity_repair_apply(
    State(state): State<AppState>,
    Json(request): Json<IntegrityRepairApplyRequest>,
) -> Result<Json<IntegrityRepairApplyResponse>, GatewayError> {
    if !request.confirm {
        return Err(integrity_bad_request("integrity_confirmation_required"));
    }
    let current = integrity_preview_for_actions(&state, request.actions.clone())?;
    if request.audit_checksum != current.audit_checksum
        || request.approval_token != current.approval_token
        || request.actions != current.actions
    {
        return Err(GatewayError {
            status: StatusCode::CONFLICT,
            code: "integrity_preview_stale",
            message: "integrity preview is stale".to_string(),
        });
    }

    let known_scopes = integrity_known_scopes();
    let backup_path = next_integrity_backup_path()?;
    if current.actions[0].is_graph_refresh() {
        let before = memory_facade(&state)
            .audit_integrity(&known_scopes)
            .map_err(|error| integrity_internal_error("integrity_audit_failed", error))?;
        let backup = memory_facade(&state)
            .backup_to(&backup_path)
            .map_err(|error| integrity_internal_error("integrity_backup_failed", error))?;
        let IntegrityRepairAction::RefreshProjectGraph { workspace_id } = &current.actions[0]
        else {
            unreachable!("canonical graph-only action must be a refresh")
        };
        let workspace_id = workspace_id.as_str().to_string();
        let folder = load_workspaces_file()
            .workspaces
            .into_iter()
            .find(|workspace| workspace.id == workspace_id)
            .and_then(|workspace| workspace.folder)
            .filter(|folder| !folder.trim().is_empty())
            .ok_or_else(|| integrity_bad_request("integrity_refresh_workspace_invalid"))?;
        let build_state = state.clone();
        let build_workspace = workspace_id.clone();
        tokio::task::spawn_blocking(move || {
            build_project_graph(&build_state, &build_workspace, &folder, None)
        })
        .await
        .map_err(|error| integrity_internal_error("integrity_graph_refresh_failed", error))?
        .map_err(|error| integrity_internal_error("integrity_graph_refresh_failed", error))?;
        let after = memory_facade(&state)
            .audit_integrity(&known_scopes)
            .map_err(|error| integrity_internal_error("integrity_audit_failed", error))?;
        let graph_status =
            integrity_graph_status_for_workspace(&MemoryWorkspaceId::new(workspace_id))?;
        return Ok(Json(IntegrityRepairApplyResponse {
            before,
            after,
            backup: IntegrityBackupSummary {
                created: true,
                bytes: backup.bytes_copied,
            },
            applied: current.estimates,
            refreshed_graphs: vec![graph_status],
        }));
    }

    let memory_actions = current
        .actions
        .iter()
        .filter_map(IntegrityRepairAction::as_memory_action)
        .collect::<Vec<_>>();
    let memory_preview = memory_facade(&state)
        .preview_integrity_repair(&known_scopes, memory_actions.clone())
        .map_err(|error| match error {
            MemoryError::Policy(_) | MemoryError::Validation(_) | MemoryError::NotFound(_) => {
                GatewayError {
                    status: StatusCode::CONFLICT,
                    code: "integrity_preview_stale",
                    message: "integrity preview is stale".to_string(),
                }
            }
            MemoryError::Store(_) => integrity_internal_error("integrity_preview_failed", error),
        })?;
    let latest_gateway_checksum =
        gateway_audit_checksum(&memory_preview.audit_checksum, &current.actions, &[])
            .map_err(|error| integrity_internal_error("integrity_preview_failed", error))?;
    let latest_gateway_token =
        gateway_approval_token(&latest_gateway_checksum, &current.actions)
            .map_err(|error| integrity_internal_error("integrity_preview_failed", error))?;
    if request.audit_checksum != latest_gateway_checksum
        || request.approval_token != latest_gateway_token
    {
        return Err(GatewayError {
            status: StatusCode::CONFLICT,
            code: "integrity_preview_stale",
            message: "integrity preview is stale".to_string(),
        });
    }
    let result = memory_facade(&state)
        .apply_integrity_repair(
            &known_scopes,
            MemoryIntegrityRepairRequest {
                audit_checksum: memory_preview.audit_checksum,
                actions: memory_actions,
                approval_token: memory_preview.approval_token,
                backup_path: Some(backup_path),
            },
        )
        .map_err(|error| match error {
            MemoryError::Policy(_) | MemoryError::Validation(_) => GatewayError {
                status: StatusCode::CONFLICT,
                code: "integrity_preview_stale",
                message: "integrity preview is stale".to_string(),
            },
            MemoryError::Store(_) | MemoryError::NotFound(_) => {
                integrity_internal_error("integrity_repair_failed", error)
            }
        })?;
    Ok(Json(IntegrityRepairApplyResponse {
        before: result.before,
        after: result.after,
        backup: IntegrityBackupSummary {
            created: true,
            bytes: result.backup.bytes_copied,
        },
        applied: result
            .applied
            .into_iter()
            .map(IntegrityRepairEstimate::from)
            .collect(),
        refreshed_graphs: Vec::new(),
    }))
}

/// Transparent "project map": (re)build a project's code graph via the isolated
/// Graphify container and import it. Skips the rebuild when the project is unchanged
/// since the last build (staleness via newest source mtime). Best-effort, blocking
/// (callers run it on a spawned task). Emits `project_graph.ready` on success.
/// Spawn an async, staleness-gated refresh of a project's code graph. Called after a
/// turn that MODIFIED code, so the "how" (structure) tracks the latest source — paired
/// with the per-turn decision capture (the "why"), the graph + wiki never go stale.
/// Cheap: build_project_graph skips when nothing changed, and the persistent mirror +
/// graphify cache make a real refresh incremental (seconds).
pub(crate) fn spawn_project_graph_refresh(state: &AppState, workspace_id: &str) {
    // Only REFRESH an already-mapped project — never auto-build one the user hasn't
    // opened (mapping happens on the graph view via `ensure`). Keeps "chat in a project"
    // from silently extracting every repo. The git-fingerprint check inside makes the
    // actual rebuild a no-op when nothing changed.
    if !graphify_out_dir(workspace_id).join("graph.json").is_file() {
        return;
    }
    let folder = load_workspaces_file()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .and_then(|w| w.folder)
        .filter(|f| !f.trim().is_empty());
    let Some(folder) = folder else { return };
    let st = state.clone();
    let ws = workspace_id.to_string();
    tokio::task::spawn_blocking(move || {
        publish_project_graph_result(&ws, &build_project_graph(&st, &ws, &folder, None));
    });
}

fn project_graph_error_code(error: &ProjectGraphCommitError) -> &'static str {
    match error {
        ProjectGraphCommitError::Stage(_) => "stage_failed",
        ProjectGraphCommitError::Build(_) => "extraction_failed",
        ProjectGraphCommitError::MissingGraph => "graph_missing",
        ProjectGraphCommitError::InvalidJson(_) => "graph_invalid",
        ProjectGraphCommitError::Import(_) => "import_failed",
        ProjectGraphCommitError::Publish(_) => "publish_failed",
        ProjectGraphCommitError::Fingerprint(_) => "fingerprint_failed",
    }
}

pub(crate) fn publish_project_graph_result(
    workspace_id: &str,
    result: &Result<Option<ProjectGraphImportReport>, ProjectGraphCommitError>,
) {
    match result {
        Ok(Some(report)) => {
            eprintln!(
                "project-graph: {workspace_id} → {} nodi, {} archi",
                report.unique_nodes, report.unique_edges
            );
            publish_app_event(serde_json::json!({
                "type": "project_graph.ready",
                "workspace": workspace_id,
                "checksum": report.checksum,
                "nodes": report.unique_nodes,
                "edges": report.unique_edges,
            }));
        }
        Ok(None) => {}
        Err(error) => {
            eprintln!(
                "project-graph: build failed for {workspace_id} at {}: {error}",
                project_graph_error_code(error)
            );
            publish_app_event(serde_json::json!({
                "type": "project_graph.failed",
                "workspace": workspace_id,
                "code": project_graph_error_code(error),
            }));
        }
    }
}

pub(crate) fn build_project_graph(
    state: &AppState,
    workspace_id: &str,
    folder: &str,
    subpath: Option<&str>,
) -> Result<Option<ProjectGraphImportReport>, ProjectGraphCommitError> {
    let mut root = std::path::PathBuf::from(folder);
    // Subfolder scoping: a huge repo (e.g. a scraper monorepo) maps just the subtree the
    // user points at. Sanitised (no absolute paths / `..`) so it stays under the project.
    if let Some(sub) = subpath.map(str::trim).filter(|s| !s.is_empty()) {
        let safe: std::path::PathBuf = std::path::Path::new(sub)
            .components()
            .filter(|c| matches!(c, std::path::Component::Normal(_)))
            .collect();
        root = root.join(safe);
    }
    if !root.is_dir() {
        return Err(ProjectGraphCommitError::Build(
            "project root is unavailable".to_string(),
        ));
    }
    // Map the WHOLE project: the code graph is extracted on the host (fast) and queried
    // via SQL traversal, where node count is irrelevant. We no longer cap by file count
    // (a huge repo like idra ~9.4k files → 53k nodes builds in ~2 min and is fully
    // queryable). The build is async + cached + incremental; `subpath` stays as an
    // optional focus filter, not a gate. Viz readability for big graphs = clustering.
    let out = graphify_out_dir(workspace_id);
    let graph_path = out.join("graph.json");
    let fp_path = out.join(".fingerprint");
    // Staleness driven by GIT (or mtime fallback): skip the rebuild when the project's
    // working-tree content hasn't changed since the last extraction. This catches edits
    // from ANY source (agent, the user's editor, git checkout/pull) — the authoritative
    // signal — so the graph stays in lock-step with the code.
    let current_fp = project_change_fingerprint(&root);
    if graph_path.is_file()
        && let Ok(prev) = std::fs::read_to_string(&fp_path)
        && prev == current_fp
    {
        return Ok(None); // unchanged since last extraction
    }
    let user = gateway_memory_user_id();
    let ws = MemoryWorkspaceId::new(workspace_id);
    let facade = memory_facade(state);
    let report = stage_project_graph_build(
        &out,
        &current_fp,
        |staging| crate::sandbox::run_graphify(&root, staging),
        |graph| {
            facade
                .import_graphify_value(&user, &ws, graph)
                .map_err(|error| ProjectGraphCommitError::Import(error.to_string()))
        },
    )?;
    Ok(Some(report))
}

#[derive(Deserialize)]
pub(crate) struct ProjectGraphEnsureRequest {
    workspace: String,
    /// Optional subtree to map (for huge repos: map just the part you care about).
    #[serde(default)]
    subpath: Option<String>,
}

/// Transparent entry point: ensure a project's code graph is fresh. Resolves the
/// workspace's folder; if it has one, kicks off an async (stale-gated) build and
/// returns immediately. The UI shows a neutral "mapping the project…" state and
/// reloads on the `project_graph.ready` event. The user never sees "Graphify".
/// An optional `subpath` scopes the map to one subtree (huge-repo escape hatch).
pub(crate) async fn project_graph_ensure(
    State(state): State<AppState>,
    Json(req): Json<ProjectGraphEnsureRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let folder = load_workspaces_file()
        .workspaces
        .into_iter()
        .find(|w| w.id == req.workspace)
        .and_then(|w| w.folder);
    let Some(folder) = folder.filter(|f| !f.trim().is_empty()) else {
        return Ok(Json(
            serde_json::json!({ "building": false, "reason": "no_folder" }),
        ));
    };
    let st = state.clone();
    let ws = req.workspace.clone();
    let subpath = req.subpath.clone();
    tokio::task::spawn_blocking(move || {
        // Ensure the project is under git (use an existing repo, else init with a
        // protective .gitignore + baseline commit): versioning, history-back and the
        // git change-signal then work uniformly. Then (re)build the code graph.
        crate::sandbox::ensure_project_git(std::path::Path::new(&folder));
        let graph_result = build_project_graph(&st, &ws, &folder, subpath.as_deref());
        publish_project_graph_result(&ws, &graph_result);
        // Refresh the project BRIEF (goals + recent state) from current memory, so the
        // always-on injected briefing is fresh whenever the project is opened.
        {
            let facade = memory_facade(&st);
            rebuild_project_brief(
                facade,
                &gateway_memory_user_id(),
                &MemoryWorkspaceId::new(&ws),
            );
        }
    });
    Ok(Json(serde_json::json!({ "building": true })))
}

/// Lists a project's immediate subfolders that contain code (with a rough code-file
/// count), so the UI can offer "map this part" on a huge repo. Cheap, non-recursive
/// beyond a shallow scan per child.
#[derive(Deserialize)]
pub(crate) struct ProjectSubdirsQuery {
    workspace: String,
}

pub(crate) async fn project_graph_subdirs(
    State(_state): State<AppState>,
    Query(q): Query<ProjectSubdirsQuery>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let folder = load_workspaces_file()
        .workspaces
        .into_iter()
        .find(|w| w.id == q.workspace)
        .and_then(|w| w.folder)
        .filter(|f| !f.trim().is_empty());
    let mut subdirs: Vec<serde_json::Value> = Vec::new();
    if let Some(folder) = folder
        && let Ok(entries) = std::fs::read_dir(&folder)
    {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_noise_dir(&name) || name.starts_with('.') {
                continue;
            }
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let count = project_code_file_count_capped(&entry.path(), 6000);
                if count > 0 {
                    subdirs.push(serde_json::json!({ "name": name, "code_files": count }));
                }
            }
        }
    }
    subdirs.sort_by(|a, b| {
        b["code_files"]
            .as_u64()
            .unwrap_or(0)
            .cmp(&a["code_files"].as_u64().unwrap_or(0))
    });
    Ok(Json(serde_json::json!({ "subdirs": subdirs })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_project_graph_routes_owner_smoke() {
        assert!(is_noise_dir("node_modules"));
        assert!(is_code_file("main.rs"));
        assert!(!is_code_file("README.md"));
    }
}
