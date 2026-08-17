//! Per-thread linked folder and `@ file` context owner.
//!
//! A project workspace folder takes precedence over the per-thread linked
//! folder. The historical `thread-folders.json` file is kept unchanged.

use axum::{
    Json,
    extract::{Path, Query},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path as FsPath, PathBuf},
};

use crate::{GatewayError, active_workspace_folder, gateway_paths::gateway_data_dir, path_within};

fn thread_folders_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("thread-folders.json"))
}

fn load_thread_folders() -> BTreeMap<String, String> {
    thread_folders_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_thread_folders(map: &BTreeMap<String, String>) -> Result<(), String> {
    let path = thread_folders_path().ok_or_else(|| "data dir unavailable".to_string())?;
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn thread_folder(thread_id: &str) -> Option<String> {
    load_thread_folders().get(thread_id).cloned()
}

/// The folder @ should search for a thread: the active PROJECT folder takes
/// precedence, falling back to a per-conversation linked folder for projectless
/// chats.
pub(crate) fn effective_thread_folder(thread_id: &str) -> Option<String> {
    active_workspace_folder().or_else(|| thread_folder(thread_id))
}

fn is_ignored_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".next"
            | "dist"
            | "build"
            | "target"
            | ".cache"
            | ".idea"
            | ".DS_Store"
    )
}

fn looks_texty(name: &str) -> bool {
    let binary = [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".mp4",
        ".mov", ".mp3", ".wav", ".woff", ".woff2", ".ttf", ".otf", ".so", ".dylib", ".dll", ".exe",
        ".bin", ".class", ".o", ".a", ".lock",
    ];
    let lower = name.to_lowercase();
    !binary.iter().any(|ext| lower.ends_with(ext))
}

/// Walks `root` and returns up to `limit` relative file paths whose name
/// matches `query` (case-insensitive substring; empty query = first files found).
fn search_folder_files(root: &FsPath, query: &str, limit: usize) -> Vec<String> {
    let q = query.trim().to_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut walked = 0usize;
    while let Some(dir) = stack.pop() {
        if out.len() >= limit || walked > 20_000 {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            walked += 1;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name != "." {
                continue;
            }
            if path.is_dir() {
                if !is_ignored_dir(&name) {
                    stack.push(path);
                }
                continue;
            }
            if !looks_texty(&name) {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            if q.is_empty() || rel.to_lowercase().contains(&q) {
                out.push(rel);
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
    out.sort();
    out
}

#[derive(Debug, Serialize)]
pub(crate) struct ThreadFolderResponse {
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetThreadFolderRequest {
    /// Absolute folder path to link; null/empty unlinks.
    path: Option<String>,
}

pub(crate) async fn get_thread_folder(Path(thread_id): Path<String>) -> Json<ThreadFolderResponse> {
    Json(ThreadFolderResponse {
        path: effective_thread_folder(&thread_id),
    })
}

pub(crate) async fn set_thread_folder(
    Path(thread_id): Path<String>,
    Json(request): Json<SetThreadFolderRequest>,
) -> Result<Json<ThreadFolderResponse>, GatewayError> {
    let mut map = load_thread_folders();
    let cleaned = request
        .path
        .as_ref()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty());
    match cleaned {
        Some(path) => {
            let dir = PathBuf::from(path);
            if !dir.is_dir() {
                return Err(GatewayError {
                    status: StatusCode::BAD_REQUEST,
                    code: "folder_not_found",
                    message: "The specified folder does not exist.".to_string(),
                });
            }
            map.insert(thread_id.clone(), path.to_string());
        }
        None => {
            map.remove(&thread_id);
        }
    }
    write_thread_folders(&map).map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "folder_store",
        message: e,
    })?;
    Ok(Json(ThreadFolderResponse {
        path: thread_folder(&thread_id),
    }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct ThreadFilesQuery {
    #[serde(default)]
    q: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ThreadFilesResponse {
    files: Vec<String>,
}

pub(crate) async fn search_thread_files(
    Path(thread_id): Path<String>,
    Query(query): Query<ThreadFilesQuery>,
) -> Result<Json<ThreadFilesResponse>, GatewayError> {
    let Some(folder) = effective_thread_folder(&thread_id) else {
        return Ok(Json(ThreadFilesResponse { files: Vec::new() }));
    };
    let root = PathBuf::from(folder);
    let files = tokio::task::spawn_blocking(move || search_folder_files(&root, &query.q, 40))
        .await
        .unwrap_or_default();
    Ok(Json(ThreadFilesResponse { files }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct ThreadFileQuery {
    path: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ThreadFileResponse {
    path: String,
    content: String,
    truncated: bool,
}

const MAX_CONTEXT_FILE_BYTES: usize = 80_000;

pub(crate) async fn read_thread_file(
    Path(thread_id): Path<String>,
    Query(query): Query<ThreadFileQuery>,
) -> Result<Json<ThreadFileResponse>, GatewayError> {
    let folder = effective_thread_folder(&thread_id).ok_or_else(|| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "no_folder",
        message: "No folder linked.".to_string(),
    })?;
    let root = PathBuf::from(folder);
    let candidate = root.join(&query.path);
    if !path_within(&root, &candidate) {
        return Err(GatewayError {
            status: StatusCode::FORBIDDEN,
            code: "path_outside_folder",
            message: "Path outside the linked folder.".to_string(),
        });
    }
    let rel = query.path.clone();
    let result = tokio::task::spawn_blocking(move || fs::read(&candidate))
        .await
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "file_read",
            message: e.to_string(),
        })?;
    let bytes = result.map_err(|e| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "file_read",
        message: e.to_string(),
    })?;
    let truncated = bytes.len() > MAX_CONTEXT_FILE_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_CONTEXT_FILE_BYTES)];
    let content = String::from_utf8_lossy(slice).to_string();
    Ok(Json(ThreadFileResponse {
        path: rel,
        content,
        truncated,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "homun-thread-files-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn linked_folder_search_skips_hidden_ignored_and_binary_entries() {
        let root = temp_root("search");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("src").join("notes.md"), "ok").unwrap();
        fs::write(root.join("node_modules").join("notes.md"), "skip").unwrap();
        fs::write(root.join(".hidden.md"), "skip").unwrap();
        fs::write(root.join("image.png"), b"skip").unwrap();

        assert_eq!(
            search_folder_files(&root, "notes", 10),
            vec!["src/notes.md"]
        );

        let _ = fs::remove_dir_all(root);
    }
}
