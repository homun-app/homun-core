//! MCP execution route owner.
//!
//! Owns the HTTP-facing confirm-card execution endpoint. Runtime transport,
//! timeout policy, confirmation matching and terminal rewrite remain delegated
//! to their dedicated owners.

use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};

use crate::{
    ActionableSourceResolution, AppState, GatewayError, actionable_claim_error,
    add_composio_tool_allow, claim_actionable_source, mcp_call_timeout, mcp_confirm_matches,
    parse_mcp_chat_name, resolve_actionable_source, resume_thread_after_approval,
    rewrite_mcp_confirm_to_done, run_mcp_chat_tool, terminal_actionable_execution_error,
};

#[derive(Debug, Deserialize)]
pub(crate) struct McpExecuteRequest {
    /// Namespaced tool name `mcp__{slug}__{tool}`.
    tool: String,
    #[serde(default)]
    arguments: serde_json::Value,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    message_id: Option<String>,
    /// Policy B: "always allow this server" - record a server-level allow so this
    /// server's writes stop asking for confirmation.
    #[serde(default)]
    allow_server: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct McpExecuteResponse {
    ok: bool,
    summary: String,
}

fn mcp_server_allow_marker(tool: &str) -> Option<String> {
    let (server, _) = tool.strip_prefix("mcp__")?.split_once("__")?;
    (!server.is_empty()).then(|| format!("mcp__{server}__*"))
}

/// Executes an MCP tool on explicit user confirmation (the chat MCP confirm card
/// calls this). Mirrors `composio_execute`: bounded by the same call timeout, and
/// on success rewrites the originating message so the card can't reopen.
pub(crate) async fn mcp_execute(
    State(state): State<AppState>,
    Json(request): Json<McpExecuteRequest>,
) -> Result<Json<McpExecuteResponse>, GatewayError> {
    let Some((provider_id, tool_name)) = parse_mcp_chat_name(&request.tool) else {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "mcp_bad_tool",
            message: format!("Invalid MCP tool name: {}", request.tool),
        });
    };
    let args = if request.arguments.is_null() {
        serde_json::json!({})
    } else {
        request.arguments.clone()
    };
    let args_for_run = args.clone();
    let args_for_resume = args.clone();
    let (Some(thread_id), Some(message_id)) =
        (request.thread_id.as_deref(), request.message_id.as_deref())
    else {
        return Err(actionable_claim_error(
            "MCP execution requires an exact persisted source card",
        ));
    };
    claim_actionable_source(&state, thread_id, message_id, |text| {
        mcp_confirm_matches(text, &request.tool, &args)
    })
    .map_err(|_| GatewayError {
        status: StatusCode::FORBIDDEN,
        code: "mcp_confirmation_required",
        message: "Execute MCP writes from their matching confirmation card.".to_string(),
    })?;
    if request.allow_server
        && let Some(marker) = mcp_server_allow_marker(&request.tool)
    {
        let _ = add_composio_tool_allow(&marker);
    }
    let handle = tokio::task::spawn_blocking({
        let state = state.clone();
        move || run_mcp_chat_tool(&state, &provider_id, &tool_name, args_for_run)
    });
    let outcome = match tokio::time::timeout(mcp_call_timeout(), handle).await {
        Ok(Ok(result)) => result,
        Ok(Err(join)) => {
            return Err(terminal_actionable_execution_error(
                &state,
                request.thread_id.as_deref(),
                request.message_id.as_deref(),
                "mcp_execute_join",
                join.to_string(),
                "Action failed.",
            ));
        }
        Err(_elapsed) => {
            let _ = terminal_actionable_execution_error(
                &state,
                request.thread_id.as_deref(),
                request.message_id.as_deref(),
                "mcp_execute_timeout",
                "MCP tool timed out",
                "Action timed out.",
            );
            return Ok(Json(McpExecuteResponse {
                ok: false,
                summary: format!(
                    "Timeout: the MCP tool didn't respond within {}s.",
                    mcp_call_timeout().as_secs()
                ),
            }));
        }
    };
    match outcome {
        Ok(output) => {
            let summary = output.to_string().chars().take(2000).collect::<String>();
            if let (Some(thread_id), Some(message_id)) =
                (request.thread_id.as_deref(), request.message_id.as_deref())
            {
                resolve_actionable_source(
                    &state,
                    thread_id,
                    message_id,
                    |text| rewrite_mcp_confirm_to_done(text, &request.tool),
                    ActionableSourceResolution::Succeeded,
                )?;
                // The source is terminal before this enqueue, so it cannot make
                // the continuation fail with ThreadBusy.
                resume_thread_after_approval(
                    &state,
                    request.thread_id.clone(),
                    &request.tool,
                    &summary,
                    Some(args_for_resume),
                    request.message_id.clone(),
                );
            }
            Ok(Json(McpExecuteResponse { ok: true, summary }))
        }
        Err(error) => {
            let _ = terminal_actionable_execution_error(
                &state,
                request.thread_id.as_deref(),
                request.message_id.as_deref(),
                "mcp_execute",
                error.to_string(),
                "Action failed.",
            );
            Ok(Json(McpExecuteResponse {
                ok: false,
                summary: format!("Action FAILED: {error}"),
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_server_allow_marker_scopes_to_the_server_namespace() {
        assert_eq!(
            mcp_server_allow_marker("mcp__filesystem__write_file").as_deref(),
            Some("mcp__filesystem__*")
        );
        assert_eq!(
            mcp_server_allow_marker("mcp__github__create_issue").as_deref(),
            Some("mcp__github__*")
        );
    }

    #[test]
    fn mcp_server_allow_marker_rejects_non_mcp_or_incomplete_names() {
        assert_eq!(mcp_server_allow_marker("GMAIL_SEND_EMAIL"), None);
        assert_eq!(mcp_server_allow_marker("mcp__filesystem"), None);
        assert_eq!(mcp_server_allow_marker("mcp____write_file"), None);
    }
}
