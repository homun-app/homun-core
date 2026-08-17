//! Write-tool allow-list owner.
//!
//! Persists the user's "always allow" choices for mutating connector/MCP tools.
//! The historical filename is kept for data compatibility, but the owner is
//! generic because MCP server-level allow markers use the same policy path.

use axum::{Json, extract::Path, http::StatusCode};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::PathBuf};

use crate::{GatewayError, gateway_paths::gateway_data_dir, humanize_composio_tool};

fn composio_tool_allow_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("composio-tool-allow.json"))
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ComposioToolAllow {
    /// Tool slugs the user approved to run WITHOUT per-call confirmation.
    #[serde(default)]
    always: Vec<String>,
}

/// Tool slugs the user has chosen to always allow (skip the confirmation card).
pub(crate) fn load_composio_tool_allow() -> BTreeSet<String> {
    let Some(path) = composio_tool_allow_path() else {
        return BTreeSet::new();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return BTreeSet::new();
    };
    serde_json::from_str::<ComposioToolAllow>(&raw)
        .map(|a| a.always.into_iter().collect())
        .unwrap_or_default()
}

fn tool_allowed_in_set(set: &BTreeSet<String>, slug: &str) -> bool {
    if set.contains(slug) {
        return true;
    }
    if let Some(rest) = slug.strip_prefix("mcp__")
        && let Some((server, _)) = rest.split_once("__")
    {
        return set.contains(&format!("mcp__{server}__*"));
    }
    false
}

pub(crate) fn composio_tool_allowed(slug: &str) -> bool {
    tool_allowed_in_set(&load_composio_tool_allow(), slug)
}

fn write_composio_tool_allow(set: BTreeSet<String>) -> Result<(), String> {
    let path = composio_tool_allow_path().ok_or_else(|| "data dir unavailable".to_string())?;
    let value = ComposioToolAllow {
        always: set.into_iter().collect(),
    };
    let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub(crate) fn add_composio_tool_allow(slug: &str) -> Result<(), String> {
    let mut set = load_composio_tool_allow();
    set.insert(slug.to_string());
    write_composio_tool_allow(set)
}

fn remove_composio_tool_allow(slug: &str) -> Result<(), String> {
    let mut set = load_composio_tool_allow();
    set.remove(slug);
    write_composio_tool_allow(set)
}

#[derive(Debug, Serialize)]
pub(crate) struct AllowedToolView {
    pub(crate) slug: String,
    /// Human-readable name.
    pub(crate) name: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct AllowedToolsResponse {
    pub(crate) tools: Vec<AllowedToolView>,
}

fn current_allowed_tools() -> AllowedToolsResponse {
    let tools = load_composio_tool_allow()
        .into_iter()
        .map(|slug| AllowedToolView {
            name: humanize_composio_tool(&slug),
            slug,
        })
        .collect();
    AllowedToolsResponse { tools }
}

/// Lists the write tools the user marked "always allow" (skip confirmation).
pub(crate) async fn composio_allowed_tools() -> Json<AllowedToolsResponse> {
    Json(current_allowed_tools())
}

/// Revokes a tool's always-allow rule so it will ask for confirmation again.
pub(crate) async fn composio_revoke_allowed_tool(
    Path(slug): Path<String>,
) -> Result<Json<AllowedToolsResponse>, GatewayError> {
    remove_composio_tool_allow(&slug).map_err(|message| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "composio_allow_write_failed",
        message,
    })?;
    Ok(Json(current_allowed_tools()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    #[test]
    fn write_tool_allowlist_accepts_exact_tool_slugs() {
        assert!(tool_allowed_in_set(
            &set(&["GMAIL_SEND_EMAIL"]),
            "GMAIL_SEND_EMAIL"
        ));
        assert!(!tool_allowed_in_set(
            &set(&["GMAIL_SEND_EMAIL"]),
            "GMAIL_DELETE_EMAIL"
        ));
    }

    #[test]
    fn write_tool_allowlist_accepts_mcp_server_level_markers() {
        let allowed = set(&["mcp__filesystem__*"]);
        assert!(tool_allowed_in_set(&allowed, "mcp__filesystem__write_file"));
        assert!(tool_allowed_in_set(
            &allowed,
            "mcp__filesystem__delete_file"
        ));
        assert!(!tool_allowed_in_set(&allowed, "mcp__github__create_issue"));
    }
}
