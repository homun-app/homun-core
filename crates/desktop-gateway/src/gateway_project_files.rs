//! Project filesystem and host-command owner.
//!
//! Owns project file tool schemas, path authorization/jailing, UI file browsing
//! helpers, project read/write/edit/patch operations, and bounded host command
//! execution. This keeps filesystem and command policy in one place while `main.rs`
//! wires tools and routes.

use super::{
    AppState, ArtifactDestination, CapabilityProviderId, FsPath, GatewayError, Json, PathBuf,
    Query, State, StatusCode, active_workspace_id, load_artifact_destinations,
    load_workspaces_file, lock_store, read_only_write_blocked_msg, resolved_sandbox_mode,
    resolved_writable_roots, security_scan_block_reasons, skill_security,
    write_artifact_destinations,
};
use serde::{Deserialize, Serialize};

#[test]
fn project_files_owner_smoke() {
    assert!(jail_in_root(std::path::Path::new("/"), "tmp").is_ok());
}

pub(crate) fn read_file_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file from the PROJECT FOLDER (your real files, in-place — not the sandbox). Path RELATIVE to the project root. Use it to inspect code before modifying it.",
            "parameters": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Relative path to the project root, e.g. \"src/main.rs\"" } },
                "required": ["path"]
            }
        }
    })
}

pub(crate) fn write_file_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create or OVERWRITE a file in the project folder (in-place, real file). Relative path; creates missing folders. For targeted edits to an existing file prefer edit_file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the project root" },
                    "content": { "type": "string", "description": "COMPLETE content of the file" }
                },
                "required": ["path", "content"]
            }
        }
    })
}

pub(crate) fn edit_file_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Edit a project file by replacing an EXACT string with another (in-place on the real file). 'old_string' must appear ONLY ONCE in the file: if it's ambiguous add context lines. Read it first with read_file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the project root" },
                    "old_string": { "type": "string", "description": "Exact text to replace (unique in the file)" },
                    "new_string": { "type": "string", "description": "Replacement text" }
                },
                "required": ["path", "old_string", "new_string"]
            }
        }
    })
}

pub(crate) fn apply_patch_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "apply_patch",
            "description": "Apply a patch to files in the project. `input` is a patch in the format: `*** Begin Patch` … `*** End Patch`, containing `*** Add File: <path>` (body lines start with `+`), `*** Update File: <path>` (optional `*** Move to: <path>`, then `@@` context hunks with `+`/`-`/space line prefixes — NO line numbers; locate edits by context), and `*** Delete File: <path>`. Prefer apply_patch over write_file/edit_file for multi-file or precise edits.",
            "parameters": {
                "type": "object",
                "properties": {
                    "input": { "type": "string", "description": "The full patch text, from '*** Begin Patch' to '*** End Patch'." }
                },
                "required": ["input"]
            }
        }
    })
}

pub(crate) fn list_files_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List the files in the project folder (skips .git/node_modules/target/…). Use it to find your way around the project structure.",
            "parameters": { "type": "object", "properties": {} }
        }
    })
}

pub(crate) fn list_directory_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": "List files and folders of an ABSOLUTE directory on the user's computer (e.g. /Users/your/Projects or ~/Documents). USE IT when the user asks to see/list folders or files of their computer. Works in AUTHORIZED folders (Destinations + project folder). Do NOT confuse it with list_files (which lists only the project folder).",
            "parameters": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "ABSOLUTE path of the folder (e.g. /Users/your/Projects)" } },
                "required": ["path"]
            }
        }
    })
}

pub(crate) fn read_text_file_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "read_text_file",
            "description": "Read a text file from an ABSOLUTE path on the user's computer, if in an authorized folder. For project-folder files use read_file instead (relative path).",
            "parameters": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "ABSOLUTE path of the file" } },
                "required": ["path"]
            }
        }
    })
}

pub(crate) fn run_in_project_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "run_in_project",
            "description": "Run a shell command IN THE PROJECT FOLDER (on your system, on the real files). Use it for build/test/lint on the real code (VERIFY-BY-EXECUTION: read the real output and iterate until green) and for git. For isolated throwaway work use run_in_sandbox instead. Destructive commands are blocked by a security scan.",
            "parameters": {
                "type": "object",
                "properties": { "command": { "type": "string", "description": "Shell command, e.g. \"cargo test\", \"npm run build\", \"git status\"" } },
                "required": ["command"]
            }
        }
    })
}

/// Addons (process-skills, ADR 0011) are a post-release direction. The foundation
/// stays wired but the agent-facing tools are gated off by default, so the first
/// release ships as a focused personal assistant. Enable with HOMUN_ADDONS=1.
pub(crate) fn addons_enabled() -> bool {
    std::env::var("HOMUN_ADDONS")
        .map(|value| matches!(value.trim(), "1" | "true" | "on" | "yes"))
        .unwrap_or(false)
}

pub(crate) fn list_addons_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "list_addons",
            "description": "List the installed addons (process-skill): configurable vertical automations (e.g. invoicing). Use it when the user asks what you can do for their work or wants to adapt a process.",
            "parameters": { "type": "object", "properties": {} }
        }
    })
}

pub(crate) fn show_addon_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "show_addon",
            "description": "Show the configurable fields of an addon and which are OPEN (adaptable) or LOCKED (invariants — e.g. fiscal/legal). Use it BEFORE customizing, to know the keys and current values.",
            "parameters": {
                "type": "object",
                "properties": { "addon_id": { "type": "string", "description": "id of the addon (from list_addons)" } },
                "required": ["addon_id"]
            }
        }
    })
}

pub(crate) fn customize_addon_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "customize_addon",
            "description": "Customize an addon in words: applies changes to OPEN fields ONLY (e.g. document title, logo, defaults). Changes to LOCKED fields (fiscal/legal invariants) are rejected and explained. 'changes' is an object {key: new_value} with the keys seen in show_addon.",
            "parameters": {
                "type": "object",
                "properties": {
                    "addon_id": { "type": "string", "description": "id of the addon (from list_addons)" },
                    "changes": { "type": "object", "description": "Map key→new value, only for open fields" }
                },
                "required": ["addon_id", "changes"]
            }
        }
    })
}

pub(crate) fn create_skill_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "create_skill",
            "description": "Create a NEW custom skill when the user asks for it (e.g. \"make me a skill that…\"). A skill is a REUSABLE set of instructions you will follow when needed. Provide: name (short), description (WHEN to use it — triggers the skill), instructions (the STEPS/rules in markdown). For skills that run commands, write the commands to launch in the instructions using run_in_sandbox/run_in_project.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Short name, e.g. \"Expense summary\"" },
                    "description": { "type": "string", "description": "WHEN to use it (activation conditions)" },
                    "instructions": { "type": "string", "description": "The steps/rules to follow (markdown)" }
                },
                "required": ["name", "description", "instructions"]
            }
        }
    })
}

// ─── Project files: in-place coding on the conversation's project folder ───
// A "project" (workspace) maps to a real host folder. Unlike the isolated sandbox
// (browser + throwaway scripts), these tools let the agent read/write/edit the
// user's REAL files in place — the Claude-Code model — but **path-jailed** to the
// authorized project root. No project folder → the tools refuse with a clear note.

const PROJECT_READ_MAX_CHARS: usize = 50_000;
const PROJECT_LIST_MAX_ENTRIES: usize = 300;
const PROJECT_LIST_MAX_DEPTH: usize = 4;

pub(crate) struct WorkspaceScopedMcpManifest {
    provider: &'static str,
    tool: &'static str,
    paths: &'static [&'static str],
}

const WORKSPACE_FILESYSTEM_WRITES: &[WorkspaceScopedMcpManifest] = &[
    WorkspaceScopedMcpManifest {
        provider: "mcp:filesystem",
        tool: "create",
        paths: &["/path"],
    },
    WorkspaceScopedMcpManifest {
        provider: "mcp:filesystem",
        tool: "insert",
        paths: &["/path"],
    },
    WorkspaceScopedMcpManifest {
        provider: "mcp:filesystem",
        tool: "str_replace",
        paths: &["/path"],
    },
];

pub(crate) fn workspace_filesystem_manifest(
    provider: &str,
    tool: &str,
) -> Option<&'static WorkspaceScopedMcpManifest> {
    WORKSPACE_FILESYSTEM_WRITES
        .iter()
        .find(|entry| entry.provider == provider && entry.tool == tool)
}

pub(crate) fn workspace_scoped_mcp_write_for_root(
    root: Option<&std::path::Path>,
    provider: &str,
    tool: &str,
    arguments: &serde_json::Value,
) -> bool {
    let (Some(root), Some(manifest)) = (root, workspace_filesystem_manifest(provider, tool)) else {
        return false;
    };
    manifest.paths.iter().all(|pointer| {
        arguments
            .pointer(pointer)
            .and_then(serde_json::Value::as_str)
            .map(std::path::Path::new)
            .and_then(|path| jail_absolute_in_root(root, path).ok())
            .is_some()
    })
}

pub(crate) fn workspace_scoped_mcp_write(
    state: &AppState,
    thread_id: Option<&str>,
    provider: &CapabilityProviderId,
    tool: &str,
    arguments: &serde_json::Value,
) -> bool {
    workspace_scoped_mcp_write_for_root(
        project_root_for_thread(state, thread_id).as_deref(),
        provider.as_str(),
        tool,
        arguments,
    )
}

/// Gives the model the only filesystem context the MCP contract cannot infer:
/// the project root of this particular conversation. The MCP connection itself
/// stays global; the root is a per-thread authorization boundary.
pub(crate) fn project_filesystem_mcp_instruction(
    root: Option<&FsPath>,
    filesystem_mcp_connected: bool,
) -> Option<String> {
    let root = root.filter(|_| filesystem_mcp_connected)?;
    let root = root.display();
    Some(format!(
        "PROJECT FILESYSTEM MCP: this conversation is linked to the project folder \
`{root}`. The Filesystem MCP is already connected globally and its tools are \
available in THIS turn; do NOT say it is unavailable, ask the user to reconnect it, \
or ask where inside this project to write.\n\
When the user explicitly asks for the Filesystem MCP, call \
`mcp__filesystem__create`, `mcp__filesystem__insert`, \
`mcp__filesystem__str_replace`, or `mcp__filesystem__view` as appropriate. Those \
tools require an ABSOLUTE `path`: resolve a relative request such as \
`path-b-gate/note.md` as `{root}/path-b-gate/note.md` automatically. Routine \
Filesystem MCP writes inside this root are authorized for this thread and do not \
need a confirmation card. For a requested path outside this root, call the MCP \
write tool anyway with its complete absolute path: the runtime will show the \
user a confirmation card and will not execute it until the user approves."
    ))
}

/// Resolves the host project root for the conversation's workspace, if one is set
/// and exists on disk. Falls back to the active workspace when the thread is unknown.
pub(crate) fn project_root_for_thread(
    state: &AppState,
    thread_id: Option<&str>,
) -> Option<PathBuf> {
    let workspace_id = thread_id
        .and_then(|tid| {
            lock_store(state)
                .ok()
                .and_then(|s| s.workspace_for_thread(tid).ok())
        })
        .unwrap_or_else(active_workspace_id);
    let folder = load_workspaces_file()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .and_then(|w| w.folder)
        .filter(|f| !f.trim().is_empty())?;
    let path = PathBuf::from(folder);
    path.is_dir().then_some(path)
}

/// Path-jail: resolves `rel` under `root`, rejecting absolute paths and `..`
/// escapes, then (via canonicalizing the deepest existing ancestor) symlink
/// escapes. Returns the joined path (which may not exist yet, for writes).
pub(crate) fn jail_in_root(root: &std::path::Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err("empty path".to_string());
    }
    let candidate = std::path::Path::new(rel);
    for component in candidate.components() {
        match component {
            std::path::Component::ParentDir => {
                return Err("'..' not allowed (outside the project)".to_string());
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err("use a path RELATIVE to the project folder".to_string());
            }
            _ => {}
        }
    }
    let joined = root.join(candidate);
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("project folder not accessible: {e}"))?;
    // Symlink-escape guard: canonicalize the deepest ancestor that exists.
    let mut ancestor = joined.clone();
    loop {
        if ancestor.exists() {
            if let Ok(canon) = ancestor.canonicalize()
                && !canon.starts_with(&root_canon)
            {
                return Err("path outside the project folder".to_string());
            }
            break;
        }
        match ancestor.parent() {
            Some(parent) => ancestor = parent.to_path_buf(),
            None => break,
        }
    }
    Ok(joined)
}

pub(crate) fn jail_absolute_in_root(
    root: &std::path::Path,
    candidate: &std::path::Path,
) -> Result<PathBuf, String> {
    if !candidate.is_absolute() {
        return Err("use an absolute path".to_string());
    }
    let relative = candidate
        .strip_prefix(root)
        .map_err(|_| "path outside the project folder".to_string())?;
    jail_in_root(root, &relative.to_string_lossy())
}

fn no_project_folder_msg() -> String {
    "This project has no folder associated with it: open/create one with a folder \
(the authorized destinations), or use run_in_sandbox for throwaway work."
        .to_string()
}

const FS_LIST_CAP: usize = 400;

/// Folders the assistant may read/list natively: the user-authorized
/// "destinations" + the conversation's project folder. (Reading OUTSIDE these
/// will require explicit per-read confirmation — a follow-up; for now it's
/// refused with guidance to authorize the folder.)
fn fs_authorized_roots(state: &AppState, thread_id: Option<&str>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = load_artifact_destinations()
        .into_iter()
        .map(|d| PathBuf::from(d.path))
        .collect();
    if let Some(root) = project_root_for_thread(state, thread_id) {
        roots.push(root);
    }
    roots
}

/// Expands a leading `~` and returns the path only if absolute.
pub(crate) fn fs_expand_abs(path: &str) -> Option<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let expanded = match trimmed.strip_prefix('~') {
        Some(rest) => format!("{}{rest}", std::env::var("HOME").ok()?),
        None => trimmed.to_string(),
    };
    let path = PathBuf::from(expanded);
    path.is_absolute().then_some(path)
}

/// True when `path` resolves inside one of the authorized roots (symlink-safe).
pub(crate) fn fs_path_authorized(path: &std::path::Path, roots: &[PathBuf]) -> bool {
    let Ok(canon) = path.canonicalize() else {
        return false;
    };
    roots.iter().any(|root| {
        root.canonicalize()
            .map(|r| canon.starts_with(&r))
            .unwrap_or(false)
    })
}

/// Why a native filesystem op can't proceed immediately.
pub(crate) enum FsAuthIssue {
    /// Path is valid but outside the authorized roots → offer an in-chat
    /// "authorize folder" card instead of a dead-end "go to Settings" message.
    NeedsAuth(PathBuf),
    /// Bad input (empty / not absolute).
    Invalid(String),
}

/// Resolves an absolute path and checks it's inside an authorized root.
pub(crate) fn fs_resolve_authorized(
    state: &AppState,
    thread_id: Option<&str>,
    path_str: &str,
) -> Result<PathBuf, FsAuthIssue> {
    let Some(path) = fs_expand_abs(path_str) else {
        return Err(FsAuthIssue::Invalid(
            "Provide an ABSOLUTE path (e.g. /Users/you/Projects).".to_string(),
        ));
    };
    let roots = fs_authorized_roots(state, thread_id);
    if fs_path_authorized(&path, &roots) {
        Ok(path)
    } else {
        Err(FsAuthIssue::NeedsAuth(path))
    }
}

/// Lists a directory's entries (folders first), capped. Authorization is the
/// caller's responsibility (via `fs_resolve_authorized` or post-authorize).
pub(crate) fn fs_list_dir_contents(path: &std::path::Path) -> String {
    let read = match std::fs::read_dir(path) {
        Ok(read) => read,
        Err(error) => return format!("Could not list «{}»: {error}", path.display()),
    };
    let (mut dirs, mut files): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            dirs.push(name);
        } else {
            files.push(name);
        }
    }
    dirs.sort();
    files.sort();
    let total = dirs.len() + files.len();
    let mut out = format!("Contents of {}:\n", path.display());
    let mut shown = 0usize;
    for d in dirs.iter().take(FS_LIST_CAP) {
        out.push_str(&format!("📁 {d}/\n"));
        shown += 1;
    }
    for f in files.iter().take(FS_LIST_CAP.saturating_sub(shown)) {
        out.push_str(&format!("📄 {f}\n"));
        shown += 1;
    }
    if total == 0 {
        out.push_str("(empty folder)\n");
    } else if total > shown {
        out.push_str(&format!("[…and {} more items]\n", total - shown));
    }
    out
}

/// A directory entry for the Workbench File tab (structured, unlike the
/// text-formatted `fs_list_dir_contents` the chat tool uses).
#[derive(Debug, Serialize)]
pub(crate) struct FsEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) size: u64,
}

/// Lists a directory as structured entries (folders first, then alpha), hiding
/// dotfiles, capped. Authorization is the caller's responsibility.
fn fs_list_entries(path: &std::path::Path) -> Vec<FsEntry> {
    let Ok(read) = std::fs::read_dir(path) else {
        return Vec::new();
    };
    let mut entries: Vec<FsEntry> = read
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let meta = entry.metadata().ok();
            Some(FsEntry {
                is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                path: entry.path().display().to_string(),
                name,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries.truncate(FS_LIST_CAP);
    entries
}

#[derive(Debug, Deserialize)]
pub(crate) struct FsListQuery {
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default)]
    pub(crate) thread_id: Option<String>,
}

/// Structured directory listing for the Workbench "File" tab. Defaults to the
/// thread's project folder; the path must resolve inside an authorized root (same
/// jail as the chat `list_directory` tool). Unauthorized paths return
/// `authorized: false` so the UI can offer to authorize instead of dead-ending.
pub(crate) async fn fs_list(
    State(state): State<AppState>,
    Query(query): Query<FsListQuery>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let thread_id = query.thread_id.clone();
    let target = match query
        .path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        Some(path) => path.to_string(),
        None => match project_root_for_thread(&state, thread_id.as_deref()) {
            Some(root) => root.display().to_string(),
            None => {
                return Ok(Json(serde_json::json!({
                    "path": null, "entries": [], "authorized": true, "root": null
                })));
            }
        },
    };
    let root =
        project_root_for_thread(&state, thread_id.as_deref()).map(|p| p.display().to_string());
    match fs_resolve_authorized(&state, thread_id.as_deref(), &target) {
        Ok(path) => {
            let listed = path.clone();
            let entries = tokio::task::spawn_blocking(move || fs_list_entries(&listed))
                .await
                .unwrap_or_default();
            Ok(Json(serde_json::json!({
                "path": path.display().to_string(),
                "entries": entries,
                "authorized": true,
                "root": root,
            })))
        }
        Err(FsAuthIssue::Invalid(message)) => Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "fs_bad_path",
            message,
        }),
        Err(FsAuthIssue::NeedsAuth(path)) => Ok(Json(serde_json::json!({
            "path": path.display().to_string(),
            "entries": [],
            "authorized": false,
            "root": root,
        }))),
    }
}

/// File content + git diff payload for the Workbench File tab viewer.
#[derive(Debug, Default, Serialize)]
pub(crate) struct FsFilePayload {
    pub(crate) authorized: bool,
    pub(crate) path: String,
    /// Current working-tree text (capped; empty for binary).
    pub(crate) text: String,
    /// Text at git HEAD (empty if untracked/new or not in git).
    pub(crate) old_text: String,
    pub(crate) in_git: bool,
    /// Working tree differs from HEAD (→ the UI offers a diff view).
    pub(crate) modified: bool,
    pub(crate) binary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

/// Resolves a file's HEAD version via git (for the diff view). Returns
/// `(in_git, head_text)`; head_text is empty for an untracked/new file.
fn git_head_version(path: &std::path::Path) -> (bool, String) {
    let Some(parent) = path.parent() else {
        return (false, String::new());
    };
    let root = std::process::Command::new("git")
        .arg("-C")
        .arg(parent)
        .args(["rev-parse", "--show-toplevel"])
        .output();
    let root = match root {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => return (false, String::new()),
    };
    // Canonicalize both sides before strip_prefix: git's --show-toplevel returns
    // the real path (e.g. /private/var/… on macOS), while the incoming path may be
    // the symlinked form (/var/…) — a mismatch would drop the HEAD version.
    let canon_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let canon_root = std::path::Path::new(&root)
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(&root));
    let Ok(rel) = canon_path.strip_prefix(&canon_root) else {
        return (true, String::new());
    };
    let spec = format!("HEAD:{}", rel.to_string_lossy());
    match std::process::Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["show", &spec])
        .output()
    {
        Ok(out) if out.status.success() => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            if text.chars().count() > PROJECT_READ_MAX_CHARS {
                text = text.chars().take(PROJECT_READ_MAX_CHARS).collect();
            }
            (true, text)
        }
        // In a repo but the file is untracked/new (no HEAD version) → empty old.
        _ => (true, String::new()),
    }
}

/// Reads a file's text + its git HEAD version (for the File-tab viewer/diff).
fn fs_read_file_with_git(path: &std::path::Path) -> FsFilePayload {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return FsFilePayload {
                authorized: true,
                path: path.display().to_string(),
                error: Some(error.to_string()),
                ..Default::default()
            };
        }
    };
    // Binary heuristic: a NUL byte in the head → don't try to render as text.
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return FsFilePayload {
            authorized: true,
            path: path.display().to_string(),
            binary: true,
            ..Default::default()
        };
    }
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if text.chars().count() > PROJECT_READ_MAX_CHARS {
        text = text.chars().take(PROJECT_READ_MAX_CHARS).collect();
    }
    let (in_git, old_text) = git_head_version(path);
    let modified = in_git && old_text != text;
    FsFilePayload {
        authorized: true,
        path: path.display().to_string(),
        text,
        old_text,
        in_git,
        modified,
        binary: false,
        error: None,
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct FsFileQuery {
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) thread_id: Option<String>,
}

/// File content + git diff for the Workbench File tab. Same jail as fs_list.
pub(crate) async fn fs_file(
    State(state): State<AppState>,
    Query(query): Query<FsFileQuery>,
) -> Result<Json<FsFilePayload>, GatewayError> {
    match fs_resolve_authorized(&state, query.thread_id.as_deref(), &query.path) {
        Ok(path) => {
            let payload = tokio::task::spawn_blocking(move || fs_read_file_with_git(&path))
                .await
                .unwrap_or_else(|_| FsFilePayload {
                    authorized: true,
                    error: Some("internal error".to_string()),
                    ..Default::default()
                });
            Ok(Json(payload))
        }
        Err(FsAuthIssue::Invalid(message)) => Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "fs_bad_path",
            message,
        }),
        Err(FsAuthIssue::NeedsAuth(path)) => Ok(Json(FsFilePayload {
            authorized: false,
            path: path.display().to_string(),
            ..Default::default()
        })),
    }
}

/// Reads a text file, capped. Authorization is the caller's responsibility.
pub(crate) fn fs_read_text(path: &std::path::Path) -> String {
    match std::fs::read_to_string(path) {
        Ok(content) if content.len() > PROJECT_READ_MAX_CHARS => {
            let head: String = content.chars().take(PROJECT_READ_MAX_CHARS).collect();
            format!("{head}\n[…truncated to {PROJECT_READ_MAX_CHARS} characters]")
        }
        Ok(content) => content,
        Err(error) => format!("Could not read «{}»: {error}", path.display()),
    }
}

/// Authorizes a folder for native filesystem access by adding it to the shared
/// "authorized folders" set (the destinations). Idempotent. Used by the in-chat
/// authorize card so the user grants access WITHOUT leaving the conversation.
pub(crate) fn fs_authorize_folder(path: &std::path::Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("«{}» is not an existing folder.", path.display()));
    }
    let path_str = path.display().to_string();
    let label = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path_str.clone());
    let mut list = load_artifact_destinations();
    if list.iter().any(|d| d.path == path_str) {
        return Ok(());
    }
    list.push(ArtifactDestination {
        label,
        path: path_str,
    });
    write_artifact_destinations(&list)
}

pub(crate) fn read_project_file(state: &AppState, thread_id: Option<&str>, rel: &str) -> String {
    let Some(root) = project_root_for_thread(state, thread_id) else {
        return no_project_folder_msg();
    };
    let path = match jail_in_root(&root, rel) {
        Ok(path) => path,
        Err(error) => return format!("Invalid path: {error}"),
    };
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            if content.len() > PROJECT_READ_MAX_CHARS {
                let head: String = content.chars().take(PROJECT_READ_MAX_CHARS).collect();
                format!(
                    "{head}\n[…truncated: file longer than {PROJECT_READ_MAX_CHARS} characters]"
                )
            } else {
                content
            }
        }
        Err(error) => format!("Could not read '{rel}': {error}"),
    }
}

pub(crate) fn write_project_file(
    state: &AppState,
    thread_id: Option<&str>,
    rel: &str,
    content: &str,
) -> String {
    // ADR 0023 chokepoint: under the resolved `read-only` sandbox mode the in-process
    // file tools must NOT mutate the workspace. Refuse BEFORE touching bytes (defense in
    // depth — the true single chokepoint is the write executor itself). Keyed on the MODE
    // (not the degraded policy) so default `workspace-write` with no project root still
    // reports "no project folder", never a spurious read-only block.
    if resolved_sandbox_mode(state, thread_id) == crate::tool_safety::SandboxMode::ReadOnly {
        return read_only_write_blocked_msg(rel);
    }
    let Some(root) = project_root_for_thread(state, thread_id) else {
        return no_project_folder_msg();
    };
    let path = match jail_in_root(&root, rel) {
        Ok(path) => path,
        Err(error) => return format!("Invalid path: {error}"),
    };
    if let Some(parent) = path.parent()
        && let Err(error) = std::fs::create_dir_all(parent)
    {
        return format!("Could not create the folders for '{rel}': {error}");
    }
    match std::fs::write(&path, content) {
        Ok(()) => format!("✅ Wrote '{rel}' ({} bytes).", content.len()),
        Err(error) => format!("Could not write '{rel}': {error}"),
    }
}

pub(crate) fn edit_project_file(
    state: &AppState,
    thread_id: Option<&str>,
    rel: &str,
    old: &str,
    new: &str,
) -> String {
    // ADR 0023 chokepoint: refuse workspace mutation under the resolved `read-only` mode,
    // before reading/writing bytes (see `write_project_file`).
    if resolved_sandbox_mode(state, thread_id) == crate::tool_safety::SandboxMode::ReadOnly {
        return read_only_write_blocked_msg(rel);
    }
    if old.is_empty() {
        return "Editing requires a non-empty 'old_string' (use write_file to create).".to_string();
    }
    let Some(root) = project_root_for_thread(state, thread_id) else {
        return no_project_folder_msg();
    };
    let path = match jail_in_root(&root, rel) {
        Ok(path) => path,
        Err(error) => return format!("Invalid path: {error}"),
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => return format!("Could not read '{rel}': {error}"),
    };
    let occurrences = content.matches(old).count();
    match occurrences {
        0 => format!("Text to replace not found in '{rel}'. Copy the current content exactly."),
        1 => {
            let updated = content.replacen(old, new, 1);
            match std::fs::write(&path, &updated) {
                Ok(()) => format!("✅ Edited '{rel}'."),
                Err(error) => format!("Could not write '{rel}': {error}"),
            }
        }
        n => format!(
            "'old_string' appears {n} times in '{rel}': it's ambiguous. Add surrounding context to make it unique."
        ),
    }
}

/// One file touched by an applied patch, carrying enough to render a diff card and to
/// register artifact memory. `old` is the pre-image (None for a newly-created file); a
/// deletion is `deleted = true` with `new` empty.
pub(crate) struct AppliedPatchFile {
    pub(crate) path: String,
    pub(crate) old: Option<String>,
    pub(crate) new: String,
    pub(crate) deleted: bool,
}

/// Apply a Codex-format patch to the thread's project folder, ON THE REAL FILESYSTEM.
///
/// This is the sync bridge the `apply_patch` tool dispatch runs inside `spawn_blocking`:
/// it owns `root` + `input`, routes EVERY touched path through `jail_in_root` (via the
/// `resolve` closure handed to [`crate::apply_patch::apply_patch_under_root`]), and
/// creates parent dirs on write (mirroring `write_project_file`). Confinement lives
/// entirely in `jail_in_root`; this function does not re-implement it. Returns the list
/// of applied files (for diff + memory) or a model-facing error (nothing written).
pub(crate) fn apply_patch_in_project(
    state: &AppState,
    thread_id: Option<&str>,
    input: &str,
) -> Result<Vec<AppliedPatchFile>, String> {
    // ADR 0023 chokepoint: refuse the whole patch under the resolved `read-only` mode,
    // before any file is touched (the applier writes N paths; blocking here keeps it
    // atomic — nothing is written). Keyed on the MODE (see `write_project_file`).
    if resolved_sandbox_mode(state, thread_id) == crate::tool_safety::SandboxMode::ReadOnly {
        return Err(read_only_write_blocked_msg("apply_patch"));
    }
    let Some(root) = project_root_for_thread(state, thread_id) else {
        return Err(no_project_folder_msg());
    };

    // Capture per-file pre-images so the caller can emit before/after diffs. The applier
    // reads a file before it (or a later hunk) rewrites it, so snapshotting inside the
    // read closure records the ORIGINAL content. `RefCell` keeps the closure a plain
    // `Fn` (the applier wants `&dyn Fn` for reads) while still mutating the map.
    let pre_images: std::cell::RefCell<std::collections::HashMap<String, Option<String>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());

    let resolve = |rel: &str| jail_in_root(&root, rel);
    // Snapshot the old content of each path the moment the applier reads it, keyed by
    // its resolved-relative form, so we can pair it with the change (diff pre-image).
    let read_snapshot = |p: &std::path::Path| -> Option<String> {
        let content = std::fs::read_to_string(p).ok();
        if let Ok(rel) = p.strip_prefix(&root) {
            pre_images
                .borrow_mut()
                .entry(rel.to_string_lossy().replace('\\', "/"))
                .or_insert_with(|| content.clone());
        }
        content
    };

    // `write` and `remove` both record into `applied`; a `RefCell` lets both `FnMut`
    // closures borrow it without conflicting (they run sequentially inside the applier).
    let applied: std::cell::RefCell<Vec<(String, String, bool)>> =
        std::cell::RefCell::new(Vec::new());
    let mut write = |p: &std::path::Path, c: &str| -> Result<(), String> {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create folders for the patch target: {e}"))?;
        }
        std::fs::write(p, c).map_err(|e| format!("could not write a patched file: {e}"))?;
        if let Ok(rel) = p.strip_prefix(&root) {
            applied.borrow_mut().push((
                rel.to_string_lossy().replace('\\', "/"),
                c.to_string(),
                false,
            ));
        }
        Ok(())
    };
    let mut remove = |p: &std::path::Path| -> Result<(), String> {
        std::fs::remove_file(p).map_err(|e| format!("could not delete a patched file: {e}"))?;
        if let Ok(rel) = p.strip_prefix(&root) {
            applied.borrow_mut().push((
                rel.to_string_lossy().replace('\\', "/"),
                String::new(),
                true,
            ));
        }
        Ok(())
    };

    crate::apply_patch::apply_patch_under_root(
        input,
        &resolve,
        &read_snapshot,
        &mut write,
        &mut remove,
    )?;

    // Pair each write/remove with its captured pre-image. A Rename shows up as a write
    // to `to` (pre-image None, it's new) + a remove of `from`; we surface both, and the
    // remove of `from` is treated like a deletion for the diff.
    let pre_images = pre_images.into_inner();
    let files = applied
        .into_inner()
        .into_iter()
        .map(|(path, new, deleted)| {
            let old = pre_images.get(&path).cloned().flatten();
            AppliedPatchFile {
                path,
                old,
                new,
                deleted,
            }
        })
        .collect();
    Ok(files)
}

pub(crate) fn list_project_files(state: &AppState, thread_id: Option<&str>) -> String {
    let Some(root) = project_root_for_thread(state, thread_id) else {
        return no_project_folder_msg();
    };
    const SKIP: [&str; 9] = [
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        "venv",
        ".venv",
        "__pycache__",
    ];
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.clone(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= PROJECT_LIST_MAX_ENTRIES || depth > PROJECT_LIST_MAX_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name != ".env.example" || SKIP.contains(&name.as_str()) {
                continue;
            }
            let rel = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            if path.is_dir() {
                out.push(format!("{rel}/"));
                stack.push((path, depth + 1));
            } else {
                out.push(rel);
            }
            if out.len() >= PROJECT_LIST_MAX_ENTRIES {
                break;
            }
        }
    }
    if out.is_empty() {
        "Empty project folder (or only hidden/ignored files).".to_string()
    } else {
        out.sort();
        let mut text = format!("Project files (root: {}):\n", root.display());
        text.push_str(&out.join("\n"));
        if out.len() >= PROJECT_LIST_MAX_ENTRIES {
            text.push_str(&format!(
                "\n[…list truncated to {PROJECT_LIST_MAX_ENTRIES} entries]"
            ));
        }
        text
    }
}

const PROJECT_CMD_TIMEOUT_SECS: u64 = 300;
const PROJECT_CMD_MAX_OUTPUT_CHARS: usize = 16_000;

/// The directories a `workspace-write` sandbox lets a project command write to:
/// the project root, plus the standard tool-cache dirs under HOME (so npm/cargo/
/// pip/etc. keep working). Everything else — `/`, `/etc`, `/usr`, `~/.ssh`,
/// `~/.aws`, arbitrary HOME files — stays denied by the fence. `TMPDIR` is added
/// by the profile generator itself. Deliberate, documented deviation from
/// Codex-pure (project+tmp only): Codex relies on on-failure escalation to stay
/// usable; until we have that, we widen writable roots to keep build tooling working.
pub(crate) fn workspace_write_roots(
    project_root: &std::path::Path,
    home: Option<&str>,
) -> Vec<std::path::PathBuf> {
    let mut roots = vec![project_root.to_path_buf()];
    if let Some(home) = home {
        for cache in [".cache", ".config", ".local", ".npm", ".cargo"] {
            roots.push(std::path::Path::new(home).join(cache));
        }
    }
    roots
}

/// Renders a finished process's combined stdout+stderr (capped) prefixed with its
/// exit status, in the `[exit N]\n{body}` shape shared by every `run_in_project`
/// path. Factored out so the sandboxed branch and the unsandboxed helper produce a
/// byte-identical result string.
fn render_project_output(output: &std::process::Output) -> String {
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        combined.push_str("\n[stderr]\n");
        combined.push_str(&stderr);
    }
    let code = output
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "terminated by signal".to_string());
    let body: String = combined
        .chars()
        .take(PROJECT_CMD_MAX_OUTPUT_CHARS)
        .collect();
    let body = if body.trim().is_empty() {
        "(no output)"
    } else {
        body.as_str()
    };
    format!("[exit {code}]\n{body}")
}

#[cfg(unix)]
struct CommandProcessGroupGuard {
    process_group_id: Option<i32>,
}

#[cfg(unix)]
impl CommandProcessGroupGuard {
    fn prepare(command: &mut tokio::process::Command) {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }

    fn for_child(child: &tokio::process::Child) -> Self {
        Self {
            process_group_id: child.id().and_then(|pid| i32::try_from(pid).ok()),
        }
    }

    fn disarm(&mut self) {
        self.process_group_id = None;
    }
}

#[cfg(unix)]
impl Drop for CommandProcessGroupGuard {
    fn drop(&mut self) {
        if let Some(process_group_id) = self.process_group_id.take() {
            // Negative PID targets the complete process group. The command is
            // group leader because `prepare` sets process_group(0) before spawn.
            unsafe {
                libc::kill(-process_group_id, libc::SIGKILL);
            }
        }
    }
}

#[cfg(not(unix))]
struct CommandProcessGroupGuard;

#[cfg(not(unix))]
impl CommandProcessGroupGuard {
    fn prepare(_command: &mut tokio::process::Command) {}

    fn for_child(_child: &tokio::process::Child) -> Self {
        Self
    }

    fn disarm(&mut self) {}
}

pub(crate) enum CommandOutputError {
    Io(std::io::Error),
    TimedOut,
}

pub(crate) async fn command_output_with_timeout(
    mut command: tokio::process::Command,
    timeout: std::time::Duration,
) -> Result<std::process::Output, CommandOutputError> {
    use tokio::io::AsyncReadExt;

    command
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    CommandProcessGroupGuard::prepare(&mut command);
    let mut child = command.spawn().map_err(CommandOutputError::Io)?;
    let mut process_group = CommandProcessGroupGuard::for_child(&child);
    let mut stdout = child.stdout.take().ok_or_else(|| {
        CommandOutputError::Io(std::io::Error::other("command stdout pipe missing"))
    })?;
    let mut stderr = child.stderr.take().ok_or_else(|| {
        CommandOutputError::Io(std::io::Error::other("command stderr pipe missing"))
    })?;
    let output = async {
        let read_stdout = async {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).await?;
            Ok::<_, std::io::Error>(bytes)
        };
        let read_stderr = async {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).await?;
            Ok::<_, std::io::Error>(bytes)
        };
        let (stdout, stderr) = tokio::try_join!(read_stdout, read_stderr)?;
        // Read pipes before wait so an exited leader remains an unreaped zombie.
        // Its PID therefore cannot be reused while the process-group guard is armed.
        let status = child.wait().await?;
        Ok::<_, std::io::Error>(std::process::Output {
            status,
            stdout,
            stderr,
        })
    };
    match tokio::time::timeout(timeout, output).await {
        Ok(Ok(output)) => {
            process_group.disarm();
            Ok(output)
        }
        Ok(Err(error)) => Err(CommandOutputError::Io(error)),
        Err(_) => Err(CommandOutputError::TimedOut),
    }
}

/// Run `command` as `bash -lc` in `root` (UNSANDBOXED), with the project timeout,
/// returning the rendered `[exit N]\n{output}` string (or a timeout/spawn error).
///
/// This is the single raw-exec code path: `run_in_project`'s non-sandboxed branch
/// AND the on-failure escalation endpoint (`run_escalate`) both call it, so the
/// unfenced execution + output rendering live in exactly one place.
pub(crate) async fn run_bash_unsandboxed_result(
    root: &std::path::Path,
    command: &str,
) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg("-lc").arg(command).current_dir(root);
    match command_output_with_timeout(
        cmd,
        std::time::Duration::from_secs(PROJECT_CMD_TIMEOUT_SECS),
    )
    .await
    {
        Ok(output) if output.status.success() => Ok(render_project_output(&output)),
        Ok(output) => Err(render_project_output(&output)),
        Err(CommandOutputError::Io(error)) => Err(format!("Could not run the command: {error}")),
        Err(CommandOutputError::TimedOut) => Err(format!(
            "Command interrupted: exceeded the {PROJECT_CMD_TIMEOUT_SECS}s timeout (process terminated)."
        )),
    }
}

async fn run_bash_unsandboxed(root: &std::path::Path, command: &str) -> String {
    match run_bash_unsandboxed_result(root, command).await {
        Ok(output) | Err(output) => output,
    }
}

/// Result of a `run_in_project` invocation: either the finished, rendered output, or
/// a signal that the sandboxed run hit a denial and the caller should offer an
/// on-failure escalation card (ADR 0023) to re-run the same command unsandboxed.
pub(crate) enum RunProjectOutcome {
    /// Normal: the rendered `[exit N]\n{output}` result (or an error string).
    Completed(String),
    /// The sandboxed run failed with a sandbox-denial signature → offer to re-run
    /// the exact command unsandboxed. `command`/`cwd` seed the escalation card.
    NeedsEscalation { command: String, cwd: String },
}

/// Build the OS-fenced command that runs `command` (as `bash -lc <command>`) with
/// writes confined to `writable_roots`. Returns the ready-to-run `tokio::process::
/// Command` (cwd/kill_on_drop are set by the caller). `Err` means the fence could NOT
/// be constructed and the caller must FAIL CLOSED (never run unsandboxed).
///
/// Only ever called on the enforced path (macOS/Linux), so
/// exactly one platform arm is compiled in per target — no `unused` warnings.
#[cfg(target_os = "macos")]
pub(crate) fn build_sandbox_command(
    writable_roots: &[std::path::PathBuf],
    command: &str,
) -> Result<tokio::process::Command, String> {
    // macOS: `sandbox-exec -p <seatbelt-profile> bash -lc <command>` — byte-identical
    // to the pre-Linux wiring.
    let policy = crate::tool_safety::SandboxPolicy::WorkspaceWrite {
        writable_roots: writable_roots.to_vec(),
        network_access: true,
    };
    match crate::seatbelt::seatbelt_profile(&policy) {
        Some(profile) => {
            let mut c = tokio::process::Command::new("sandbox-exec");
            c.arg("-p").arg(profile).arg("bash").arg("-lc").arg(command);
            Ok(c)
        }
        // DangerFullAccess → unreachable here (we build WorkspaceWrite). Fail closed
        // rather than silently run unsandboxed.
        None => Err("no seatbelt profile for the workspace policy".to_string()),
    }
}

/// Linux fence: spawn the `homun-linux-sandbox` helper, which applies a Landlock
/// filesystem fence to itself and then execs the command. Resolves the helper via
/// `HOMUN_LINUX_SANDBOX_BIN` (explicit override), else a sibling of the running
/// gateway executable (`current_exe()/../homun-linux-sandbox`). Fails CLOSED if the
/// helper can't be located or doesn't exist — the caller then refuses to run.
///
/// Follow-up (out of scope): the packaged Linux app must bundle `homun-linux-sandbox`
/// next to the gateway binary (electron-builder `package:prepare`) so the sibling-exe
/// resolution finds it in production; the CI test uses `CARGO_BIN_EXE_...` instead.
#[cfg(target_os = "linux")]
pub(crate) fn build_sandbox_command(
    writable_roots: &[std::path::PathBuf],
    command: &str,
) -> Result<tokio::process::Command, String> {
    let helper = match std::env::var_os("HOMUN_LINUX_SANDBOX_BIN") {
        Some(path) => std::path::PathBuf::from(path),
        None => {
            let exe = std::env::current_exe()
                .map_err(|e| format!("cannot resolve current executable: {e}"))?;
            let dir = exe
                .parent()
                .ok_or_else(|| "current executable has no parent directory".to_string())?;
            dir.join("homun-linux-sandbox")
        }
    };
    if !helper.is_file() {
        return Err(format!(
            "linux sandbox helper not found at {} (set HOMUN_LINUX_SANDBOX_BIN)",
            helper.display()
        ));
    }
    let mut c = tokio::process::Command::new(&helper);
    for root in writable_roots {
        c.arg("--allow-write").arg(root);
    }
    c.arg("--").arg("bash").arg("-lc").arg(command);
    Ok(c)
}

/// Fallback for platforms without a fence backend (Windows/other). Never actually
/// reached — `run_in_project` gates the sandboxed path on `cfg!(macos) || cfg!(linux)`
/// at runtime, so `sandboxed` is always false here and the caller returns before
/// calling this. It exists only so the call site compiles on every target. The
/// `_` bindings keep it warning-free.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn build_sandbox_command(
    _writable_roots: &[std::path::PathBuf],
    _command: &str,
) -> Result<tokio::process::Command, String> {
    Err("no sandbox backend on this platform".to_string())
}

/// Runs a shell command on the HOST with cwd = the project folder (build/test/lint
/// on the user's real code — verify-by-execution, plus git). Gated by the same
/// security scan as the sandbox + confined to a project that has a folder; killed
/// on timeout via `kill_on_drop`. Returns combined stdout+stderr (capped) prefixed
/// with the exit status. This is the host-execution counterpart to the isolated
/// `run_in_sandbox` (which stays for throwaway/untrusted work).
///
/// ADR 0023 step 3 — OS enforcement (unconditional on macOS/Linux as of 2026-07-09).
/// On a platform with a fence backend, the `bash` subprocess is fenced under a
/// workspace-write policy: writes are physically confined to the project root +
/// standard tool caches (see `workspace_write_roots`), everything else is read-only.
/// The wrapper is `sandbox-exec` + Seatbelt on macOS, `homun-linux-sandbox` +
/// Landlock on Linux (see `build_sandbox_command`). Windows/other platforms never
/// sandbox here yet.
///
/// ADR 0023 on-failure escalation: when a fenced run FAILS with a sandbox-denial
/// signature, this returns `NeedsEscalation` (instead of the old inline note) so the
/// caller can surface an approval card; approving re-runs the command unsandboxed via
/// `run_escalate`. The non-sandboxed and flag-off paths always return `Completed`.
///
/// ADR 0023 step 3 — Linux enforcement. On Linux the fence is **Landlock** (kernel
/// LSM) applied via the `homun-linux-sandbox` helper binary: instead of `sandbox-exec`
/// we spawn `homun-linux-sandbox --allow-write <root>... -- bash -lc <command>`, which
/// fences its own filesystem writes to the roots and then execs the command. Same
/// writable roots as macOS (`workspace_write_roots`), same `NeedsEscalation` detection
/// (a Landlock denial surfaces as `EACCES`/"Operation not permitted"). Helper-path
/// resolution fails CLOSED (see `linux_sandbox_command`).
/// TODO(ADR 0023): seccomp network-off (v1 fences filesystem writes only, allowing
/// network, at parity with the macOS v1 profile).
pub(crate) async fn run_in_project(
    state: &AppState,
    thread_id: Option<&str>,
    command: &str,
) -> RunProjectOutcome {
    let command = command.trim();
    if command.is_empty() {
        return RunProjectOutcome::Completed("Empty command.".to_string());
    }
    let Some(root) = project_root_for_thread(state, thread_id) else {
        return RunProjectOutcome::Completed(no_project_folder_msg());
    };
    let scan = skill_security::scan_blobs(&[("command".to_string(), command.to_string())]);
    if scan.blocked {
        let reasons = security_scan_block_reasons(&scan);
        tracing::warn!(target: "security::scan", risk = scan.risk_score, %reasons, "shell command blocked");
        return RunProjectOutcome::Completed(format!(
            "Command NOT executed: blocked by the security scan (risk {}/100). {reasons} \
Reformulate it without destructive operations.",
            scan.risk_score
        ));
    }
    // Enforce the OS fence on any platform with an enforcement backend (macOS Seatbelt or
    // Linux Landlock). On Windows/other we take the plain `bash -lc` path via
    // `run_bash_unsandboxed` — the sandboxed branch below only runs on the enforced path.
    let sandboxed = cfg!(target_os = "macos") || cfg!(target_os = "linux");
    if !sandboxed {
        return RunProjectOutcome::Completed(run_bash_unsandboxed(&root, command).await);
    }
    // Sandboxed path: build the OS fence command, run inline (we need the raw status +
    // combined output to decide whether to escalate). The writable roots are computed
    // the same way on every platform; only the command wrapper differs. Phase 2: the roots
    // are the behavior-preserving base (project root + home build caches) PLUS any per-project
    // extra folders (`resolved_writable_roots` — never removes the base; the OS fence stays on).
    let writable_roots = resolved_writable_roots(state, thread_id);
    // v1: fence filesystem writes, allow network (npm/git need it). Stricter
    // network-off is a follow-up on both platforms.
    let mut cmd = match build_sandbox_command(&writable_roots, command) {
        Ok(cmd) => cmd,
        // Fail-closed: the fence could not be constructed (e.g. the Linux helper
        // binary is missing). NEVER fall back to unsandboxed — surface the same
        // "sandbox could not start" error the failed-spawn path uses.
        Err(error) => {
            return RunProjectOutcome::Completed(format!(
                "Command NOT executed: the workspace sandbox could not start ({error}). \
The command was not run unsandboxed."
            ));
        }
    };
    cmd.current_dir(&root);
    match command_output_with_timeout(
        cmd,
        std::time::Duration::from_secs(PROJECT_CMD_TIMEOUT_SECS),
    )
    .await
    {
        Ok(output) => {
            let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.trim().is_empty() {
                combined.push_str("\n[stderr]\n");
                combined.push_str(&stderr);
            }
            // On-failure escalation: if the fenced command failed and the output carries
            // a sandbox-denial signature, the fence — not the command — is the likely
            // culprit. Signal the caller to offer an "approve → re-run unsandboxed" card
            // instead of just noting it (ADR 0023).
            if !output.status.success()
                && (combined.contains("Operation not permitted") || combined.contains("sandbox"))
            {
                return RunProjectOutcome::NeedsEscalation {
                    command: command.to_string(),
                    cwd: root.to_string_lossy().into_owned(),
                };
            }
            RunProjectOutcome::Completed(render_project_output(&output))
        }
        Err(CommandOutputError::Io(error)) => {
            // Fail-closed: if the SANDBOXED spawn could not start (e.g. `sandbox-exec`
            // missing), never silently fall back to unsandboxed — surface a clear error.
            RunProjectOutcome::Completed(format!(
                "Command NOT executed: the workspace sandbox could not start ({error}). \
The command was not run unsandboxed."
            ))
        }
        Err(CommandOutputError::TimedOut) => RunProjectOutcome::Completed(format!(
            "Command interrupted: exceeded the {PROJECT_CMD_TIMEOUT_SECS}s timeout (process terminated)."
        )),
    }
}
