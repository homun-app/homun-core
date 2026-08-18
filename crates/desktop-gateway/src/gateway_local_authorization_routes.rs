//! Local in-chat authorization routes and marker rewrites.
//!
//! Owns filesystem authorization, sandbox escalation approval, read-only
//! marker constants, and connect-suggestion card persistence. Tool execution
//! emits these markers; this module owns the HTTP actions that resolve them.

use super::*;

pub(crate) const FS_AUTHORIZE_OPEN: &str = "‹‹FS_AUTHORIZE››";
pub(crate) const FS_AUTHORIZE_CLOSE: &str = "‹‹/FS_AUTHORIZE››";

/// Provenance gate for filesystem authorization. A card authorizes exactly one
/// absolute path and one pending operation; a UI request must not be able to
/// substitute either value before native filesystem access begins.
pub(crate) fn fs_authorize_matches(text: &str, path: &str, op: &str) -> bool {
    let Some(marker) = confirm_marker_value(text, FS_AUTHORIZE_OPEN, FS_AUTHORIZE_CLOSE) else {
        return false;
    };
    marker.get("path").and_then(Value::as_str) == Some(path)
        && marker.get("op").and_then(Value::as_str) == Some(op)
}

// ADR 0023 on-failure sandbox escalation card markers. Same guillemet framing as the
// other confirm/authorize markers so the frontend renders it as an actionable card.
pub(crate) const SANDBOX_ESCALATE_OPEN: &str = "‹‹SANDBOX_ESCALATE››";
pub(crate) const SANDBOX_ESCALATE_CLOSE: &str = "‹‹/SANDBOX_ESCALATE››";

// ADR 0023 read-only informational card markers. Same guillemet framing as the escalation
// card so the frontend can parse the card out of the PERSISTED assistant text (not a
// transient tool_result event) — reloading the thread must still render the card.
pub(crate) const SANDBOX_READONLY_OPEN: &str = "‹‹SANDBOX_READONLY››";
pub(crate) const SANDBOX_READONLY_CLOSE: &str = "‹‹/SANDBOX_READONLY››";

/// Rewrites the authorize-card marker into a plain "granted" note so reopening
/// the chat doesn't re-show the actionable card (mirrors the Composio/MCP path).
pub(crate) fn rewrite_fs_authorize_to_done(text: &str, path: &str) -> String {
    let Some(open) = text.find(FS_AUTHORIZE_OPEN) else {
        return text.to_string();
    };
    let Some(close_rel) = text[open..].find(FS_AUTHORIZE_CLOSE) else {
        return text.to_string();
    };
    let close = open + close_rel + FS_AUTHORIZE_CLOSE.len();
    let head_end = text[..open].rfind("To access this folder").unwrap_or(open);
    let mut out = text[..head_end].trim_end().to_string();
    let tail = text[close..].trim();
    if !tail.is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(tail);
    }
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&format!("✓ Access granted to {path}"));
    out
}

#[derive(Debug, Deserialize)]
pub(crate) struct FsAuthorizeRequest {
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) op: String,
    #[serde(default)]
    pub(crate) thread_id: Option<String>,
    #[serde(default)]
    pub(crate) message_id: Option<String>,
}

/// In-chat folder authorization: grants native filesystem access to a folder
/// (adds it to the authorized set) and runs the pending op (list/read), so the
/// user authorizes AND sees the result without leaving the conversation. On
/// success rewrites the originating message so the card can't reopen.
pub(crate) async fn fs_authorize(
    State(state): State<AppState>,
    Json(request): Json<FsAuthorizeRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let Some(path) = fs_expand_abs(&request.path) else {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "fs_bad_path",
            message: "Invalid path.".to_string(),
        });
    };
    let op = request.op.clone();
    let (Some(thread_id), Some(message_id)) =
        (request.thread_id.as_deref(), request.message_id.as_deref())
    else {
        return Err(actionable_claim_error(
            "filesystem authorization requires an exact persisted source card",
        ));
    };
    claim_actionable_source(&state, thread_id, message_id, |text| {
        fs_authorize_matches(text, &request.path, &op)
    })
    .map_err(|_| GatewayError {
        status: StatusCode::FORBIDDEN,
        code: "fs_authorize_confirmation_required",
        message: "Authorize filesystem access only from its matching confirmation card."
            .to_string(),
    })?;
    let task_path = path.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        fs_authorize_folder(&task_path)?;
        Ok(if op == "read" {
            fs_read_text(&task_path)
        } else {
            fs_list_dir_contents(&task_path)
        })
    })
    .await
    .map_err(|error| {
        terminal_actionable_execution_error(
            &state,
            request.thread_id.as_deref(),
            request.message_id.as_deref(),
            "fs_authorize_join",
            error.to_string(),
            "Authorization failed.",
        )
    })?;
    match result {
        Ok(output) => {
            if let (Some(thread_id), Some(message_id)) =
                (request.thread_id.as_deref(), request.message_id.as_deref())
            {
                let path_for_card = path.display().to_string();
                resolve_actionable_source(
                    &state,
                    thread_id,
                    message_id,
                    |text| rewrite_fs_authorize_to_done(text, &path_for_card),
                    ActionableSourceResolution::Succeeded,
                )?;
                resume_thread_after_approval(
                    &state,
                    request.thread_id.clone(),
                    "filesystem_authorize",
                    &output,
                    Some(serde_json::json!({
                        "path": path.display().to_string(),
                        "op": request.op,
                    })),
                    request.message_id.clone(),
                );
            }
            Ok(Json(serde_json::json!({
                "ok": true,
                "output": output.chars().take(6000).collect::<String>()
            })))
        }
        Err(message) => {
            let _ = terminal_actionable_execution_error(
                &state,
                request.thread_id.as_deref(),
                request.message_id.as_deref(),
                "fs_authorize",
                &message,
                "Authorization failed.",
            );
            Ok(Json(serde_json::json!({ "ok": false, "summary": message })))
        }
    }
}

/// Provenance gate for the on-failure escalation endpoint: true iff the stored
/// message carries a SANDBOX_ESCALATE card whose `arguments.command` equals the
/// requested `command`. Mirrors `mcp_confirm_matches`: the endpoint must only ever
/// re-run the exact command that was proposed — never an arbitrary one.
pub(crate) fn sandbox_escalate_matches(text: &str, command: &str, cwd: Option<&str>) -> bool {
    let Some(marker) = confirm_marker_value(text, SANDBOX_ESCALATE_OPEN, SANDBOX_ESCALATE_CLOSE)
    else {
        return false;
    };
    let arguments = marker.get("arguments");
    let command_matches = arguments
        .and_then(|a| a.get("command"))
        .and_then(serde_json::Value::as_str)
        == Some(command);
    let approved_cwd = arguments
        .and_then(|a| a.get("cwd"))
        .and_then(serde_json::Value::as_str);
    let cwd_matches = match (approved_cwd, cwd) {
        (None, None) => true,
        (Some(approved), Some(requested)) => {
            let approved = PathBuf::from(approved);
            let requested = PathBuf::from(requested);
            approved.canonicalize().unwrap_or(approved)
                == requested.canonicalize().unwrap_or(requested)
        }
        _ => false,
    };
    command_matches && cwd_matches
}

/// Rewrites the escalation-card marker into a plain "ran unsandboxed" note so
/// reopening the chat doesn't re-show the actionable card (mirrors
/// `rewrite_fs_authorize_to_done` / `rewrite_mcp_confirm_to_done`).
pub(crate) fn rewrite_sandbox_escalate_to_done(text: &str, command: &str) -> String {
    let Some(open) = text.find(SANDBOX_ESCALATE_OPEN) else {
        return text.to_string();
    };
    let Some(close_rel) = text[open..].find(SANDBOX_ESCALATE_CLOSE) else {
        return text.to_string();
    };
    let close = open + close_rel + SANDBOX_ESCALATE_CLOSE.len();
    let head_end = text[..open]
        .rfind("I need your confirmation")
        .unwrap_or(open);
    let mut out = text[..head_end].trim_end().to_string();
    let tail = text[close..].trim();
    if !tail.is_empty() {
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(tail);
    }
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&format!("✓ Ran unsandboxed: {command}"));
    out
}

#[derive(Debug, Deserialize)]
pub(crate) struct RunEscalateRequest {
    pub(crate) command: String,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(default)]
    pub(crate) thread_id: Option<String>,
    #[serde(default)]
    pub(crate) message_id: Option<String>,
}

/// ADR 0023 on-failure sandbox escalation: re-runs a `run_in_project` command
/// UNSANDBOXED after explicit user approval (the SANDBOX_ESCALATE card calls this).
/// Endpoint-based like `fs_authorize` — there is no `run_in_project` MCP tool, this
/// is a local shell exec. Security gate: the stored message must carry a matching
/// SANDBOX_ESCALATE card, so only the exact proposed command can run. On success
/// rewrites the originating message so the card can't reopen.
pub(crate) async fn run_escalate(
    State(state): State<AppState>,
    Json(request): Json<RunEscalateRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    // Provenance gate (REQUIRED): the command must match the card in the stored
    // message. Without a matching marker, refuse — never run an arbitrary command.
    let (Some(thread_id), Some(message_id)) =
        (request.thread_id.as_deref(), request.message_id.as_deref())
    else {
        return Err(actionable_claim_error(
            "sandbox escalation requires an exact persisted source card",
        ));
    };
    claim_actionable_source(&state, thread_id, message_id, |text| {
        sandbox_escalate_matches(text, &request.command, request.cwd.as_deref())
    })
    .map_err(|_| GatewayError {
        status: StatusCode::FORBIDDEN,
        code: "sandbox_escalate_required",
        message: "Re-run unsandboxed only from its matching escalation card.".to_string(),
    })?;
    // Resolve the cwd: the card's cwd, else the thread's project root.
    let root = request
        .cwd
        .as_ref()
        .map(PathBuf::from)
        .or_else(|| project_root_for_thread(&state, request.thread_id.as_deref()));
    let Some(root) = root else {
        if let (Some(thread_id), Some(message_id)) =
            (request.thread_id.as_deref(), request.message_id.as_deref())
        {
            let _ = resolve_actionable_source(
                &state,
                thread_id,
                message_id,
                |text| actionable_source_terminal_text(text, "Escalation failed."),
                ActionableSourceResolution::Failed,
            );
        }
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "sandbox_escalate_no_root",
            message: "No project folder to run in.".to_string(),
        });
    };
    // Execute UNSANDBOXED via the shared raw-exec helper.
    let output = match run_bash_unsandboxed_result(&root, &request.command).await {
        Ok(output) => output,
        Err(error) => {
            let _ = terminal_actionable_execution_error(
                &state,
                request.thread_id.as_deref(),
                request.message_id.as_deref(),
                "sandbox_escalate_execution",
                &error,
                "Escalation failed.",
            );
            return Ok(Json(serde_json::json!({ "ok": false, "output": error })));
        }
    };
    if let (Some(thread_id), Some(message_id)) =
        (request.thread_id.as_deref(), request.message_id.as_deref())
    {
        resolve_actionable_source(
            &state,
            thread_id,
            message_id,
            |text| rewrite_sandbox_escalate_to_done(text, &request.command),
            ActionableSourceResolution::Succeeded,
        )?;
        resume_thread_after_approval(
            &state,
            request.thread_id.clone(),
            "run_in_project",
            &output,
            Some(serde_json::json!({
                "command": request.command,
                "cwd": root.display().to_string(),
            })),
            request.message_id.clone(),
        );
    }
    Ok(Json(serde_json::json!({ "ok": true, "output": output })))
}

pub(crate) const CONNECT_SUGGEST_OPEN: &str = "‹‹CONNECT_SUGGEST››";
pub(crate) const CONNECT_SUGGEST_CLOSE: &str = "‹‹/CONNECT_SUGGEST››";

/// Marks one suggestion in a CONNECT_SUGGEST card as connected, so reopening the
/// chat renders it as "Collegato ✓" instead of an actionable button (the other
/// items stay actionable). Returns the text unchanged when the marker is
/// missing/malformed. This is the "representation" half of the two-memories
/// pattern: the data grant lives in the capability registry, this fixes the
/// persisted message so the card doesn't offer to reconnect something already on.
pub(crate) fn rewrite_connect_suggest_mark(text: &str, kind: &str, item_ref: &str) -> String {
    let Some(open) = text.find(CONNECT_SUGGEST_OPEN) else {
        return text.to_string();
    };
    let json_start = open + CONNECT_SUGGEST_OPEN.len();
    let Some(close_rel) = text[json_start..].find(CONNECT_SUGGEST_CLOSE) else {
        return text.to_string();
    };
    let json_end = json_start + close_rel;
    let Ok(mut card) = serde_json::from_str::<serde_json::Value>(&text[json_start..json_end])
    else {
        return text.to_string();
    };
    if let Some(items) = card.get_mut("items").and_then(|v| v.as_array_mut()) {
        for item in items.iter_mut() {
            if item.get("kind").and_then(|v| v.as_str()) != Some(kind) {
                continue;
            }
            // MCP items are keyed by the registry server id; skill/Composio by slug.
            let matches = if kind == "mcp" {
                item.get("server")
                    .and_then(|s| s.get("id"))
                    .and_then(|v| v.as_str())
                    == Some(item_ref)
            } else {
                item.get("slug").and_then(|v| v.as_str()) == Some(item_ref)
            };
            if matches && let Some(obj) = item.as_object_mut() {
                obj.insert("connected".to_string(), serde_json::Value::Bool(true));
            }
        }
    }
    format!("{}{}{}", &text[..json_start], card, &text[json_end..])
}

#[derive(Debug, Deserialize)]
pub(crate) struct ConnectMarkRequest {
    pub(crate) kind: String,
    #[serde(default, rename = "ref")]
    pub(crate) item_ref: String,
    #[serde(default)]
    pub(crate) thread_id: Option<String>,
    #[serde(default)]
    pub(crate) message_id: Option<String>,
}

/// Persists that the user connected one suggestion from a CONNECT_SUGGEST card:
/// the actual connect/install/link already happened client-side (mcpConnect /
/// catalogInstall / composioLink); this rewrites the originating message so the
/// item shows "Collegato" on reload instead of re-offering the action.
pub(crate) async fn connect_mark(
    State(state): State<AppState>,
    Json(request): Json<ConnectMarkRequest>,
) -> Json<serde_json::Value> {
    if let (Some(thread_id), Some(message_id)) = (&request.thread_id, &request.message_id) {
        let rewritten = lock_store(&state)
            .ok()
            .and_then(|store| store.message(thread_id, message_id).ok().flatten())
            .map(|message| {
                rewrite_connect_suggest_mark(&message.text, &request.kind, &request.item_ref)
            });
        let Some(rewritten) = rewritten else {
            return Json(serde_json::json!({ "ok": false }));
        };
        if resolve_actionable_source(
            &state,
            thread_id,
            message_id,
            |_| rewritten,
            ActionableSourceResolution::Cancelled,
        )
        .is_err()
        {
            return Json(serde_json::json!({ "ok": false }));
        }
    }
    Json(serde_json::json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_local_authorization_routes_owner_smoke() {
        let fs_card = "‹‹FS_AUTHORIZE››{\"path\":\"/tmp/demo\",\"op\":\"read\"}‹‹/FS_AUTHORIZE››";
        assert!(fs_authorize_matches(fs_card, "/tmp/demo", "read"));
        assert!(!fs_authorize_matches(fs_card, "/tmp/demo", "list"));

        let sandbox_card =
            "‹‹SANDBOX_ESCALATE››{\"arguments\":{\"command\":\"pwd\"}}‹‹/SANDBOX_ESCALATE››";
        assert!(sandbox_escalate_matches(sandbox_card, "pwd", None));
        assert!(!sandbox_escalate_matches(sandbox_card, "rm -rf /", None));

        let connect_card = "‹‹CONNECT_SUGGEST››{\"items\":[{\"kind\":\"skill\",\"slug\":\"docs\"}]}‹‹/CONNECT_SUGGEST››";
        let rewritten = rewrite_connect_suggest_mark(connect_card, "skill", "docs");
        assert!(rewritten.contains("\"connected\":true"));
    }
}
