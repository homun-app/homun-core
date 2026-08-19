//! Composio tool execution and confirmation-card execute route.
//!
//! This owner contains the Composio execute dispatcher and the HTTP route used
//! by confirmed Composio cards. It deliberately delegates `send_message` to the
//! channel owner and leaves payment/browser/remote-approval policy with their
//! existing owners.

use super::*;

/// Executes a Composio tool for the current entity and returns its raw output.
/// Opt-in verbose diagnostics (set `HOMUN_DEBUG`). Off by default because these
/// logs can echo tool arguments, channel context, or Composio error bodies that
/// may include secrets/PII.
pub(crate) fn composio_execute_tool(
    state: &AppState,
    tool: &str,
    arguments: &serde_json::Value,
) -> Result<serde_json::Value, GatewayError> {
    // `send_message` is our own channel-send pseudo-tool (not Composio): route it before
    // touching the Composio transport, so it works even without Composio configured.
    if tool == "send_message" {
        return execute_send_message(state, arguments);
    }
    let transport = composio_transport_for(state)?;
    // Diagnostic (opt-in: HOMUN_DEBUG): surface exactly what we send so date/arg bugs are
    // visible in the log. Off by default — args can carry message bodies / PII.
    if verbose_debug() {
        eprintln!(
            "composio/execute tool={tool} args={}",
            arguments.to_string().chars().take(600).collect::<String>()
        );
    }
    transport
        .request(
            "POST",
            &format!("/tools/execute/{tool}"),
            Some(serde_json::json!({
                "user_id": composio_entity_id(),
                "arguments": arguments,
            })),
        )
        .map_err(GatewayError::capability)
}

#[derive(Debug, Deserialize)]
pub(crate) struct ComposioExecuteRequest {
    tool: String,
    #[serde(default)]
    arguments: serde_json::Value,
    /// "always" persists an allow-rule for this tool before executing.
    #[serde(default)]
    scope: Option<String>,
    /// When present, the originating chat message is rewritten on success so the
    /// confirmation card never reopens on reload (no risk of double-execution).
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    message_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ComposioExecuteResponse {
    ok: bool,
    /// Compact, human-readable outcome (the source of truth — not the model's word).
    summary: String,
}

/// Executes a Composio tool on explicit user confirmation (the chat
/// confirmation card calls this). `scope: "always"` also records an allow-rule
/// so future calls to this tool skip confirmation.
pub(crate) async fn composio_execute(
    State(state): State<AppState>,
    Json(request): Json<ComposioExecuteRequest>,
) -> Result<Json<ComposioExecuteResponse>, GatewayError> {
    let tool = request.tool.clone();
    let args = if request.arguments.is_null() {
        serde_json::json!({})
    } else {
        request.arguments.clone()
    };
    let args_for_resume = args.clone();
    let (Some(thread_id), Some(message_id)) =
        (request.thread_id.as_deref(), request.message_id.as_deref())
    else {
        return Err(actionable_claim_error(
            "Composio execution requires an exact persisted source card",
        ));
    };
    claim_actionable_source(&state, thread_id, message_id, |text| {
        composio_confirm_matches(text, &request.tool, &args)
    })
    .map_err(|_| GatewayError {
        status: StatusCode::FORBIDDEN,
        code: "composio_confirmation_required",
        message: "Execute Composio writes from their matching confirmation card.".to_string(),
    })?;
    if request.scope.as_deref() == Some("always") {
        let _ = add_composio_tool_allow(&request.tool);
    }
    let output = match tokio::task::spawn_blocking({
        let state = state.clone();
        move || composio_execute_tool(&state, &tool, &args)
    })
    .await
    {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return Err(terminal_actionable_execution_error(
                &state,
                request.thread_id.as_deref(),
                request.message_id.as_deref(),
                "composio_execute",
                error.message,
                "Action failed.",
            ));
        }
        Err(error) => {
            return Err(terminal_actionable_execution_error(
                &state,
                request.thread_id.as_deref(),
                request.message_id.as_deref(),
                "composio_execute_join",
                error.to_string(),
                "Action failed.",
            ));
        }
    };

    // Composio replies HTTP 200 even when the tool itself failed. Never mark the
    // action "done" nor claim success in that case — report the failure instead.
    if let Some(error) = composio_execution_error(&output) {
        if let (Some(thread_id), Some(message_id)) =
            (request.thread_id.as_deref(), request.message_id.as_deref())
        {
            let _ = terminal_actionable_execution_error(
                &state,
                Some(thread_id),
                Some(message_id),
                "composio_execute",
                error.to_string(),
                "Action failed.",
            );
        }
        return Ok(Json(ComposioExecuteResponse {
            ok: false,
            summary: format!("Action FAILED: {error}"),
        }));
    }

    let summary = output.to_string().chars().take(2000).collect::<String>();
    if let (Some(thread_id), Some(message_id)) =
        (request.thread_id.as_deref(), request.message_id.as_deref())
    {
        resolve_actionable_source(
            &state,
            thread_id,
            message_id,
            |text| rewrite_confirm_to_done(text, &request.tool),
            ActionableSourceResolution::Succeeded,
        )?;
        resume_thread_after_approval(
            &state,
            request.thread_id.clone(),
            &request.tool,
            &summary,
            Some(args_for_resume),
            request.message_id.clone(),
        );
    }
    Ok(Json(ComposioExecuteResponse { ok: true, summary }))
}
