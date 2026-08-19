//! Execution path for already-confirmed remote approvals.
//!
//! The remote approval state owner creates, dispatches, cancels, and resumes
//! approvals. This owner consumes a confirmed approval code and runs the exact
//! approved MCP or Composio/channel action, then resolves the source card.

use super::*;

/// Execute a confirmed pending approval (by code) -> user-facing reply text. Routes MCP vs
/// Composio/send_message. Shared by the inbound-text path AND the Telegram inline-button callback.
/// 6.1b: after a confirm-gated action is approved AND executed, re-enter the agent loop on the
/// ORIGIN thread (if known) so a multi-step task CONTINUES instead of dead-stopping at the
/// `pending_confirm` break. Spawned so the caller (an HTTP handler / channel callback) returns at
/// once; the continuation streams onto the thread (the UI reattaches via `active_streams`).
pub(crate) async fn execute_pending_approval(state: &AppState, code: &str) -> String {
    let pending = match lock_store(state)
        .ok()
        .and_then(|store| store.pending_remote_approval(code).ok().flatten())
    {
        Some(row) => row,
        None => return format!("Code {code} not valid or expired."),
    };
    if let (Some(thread_id), Some(approved_revision)) =
        (pending.thread_id.as_deref(), pending.objective_revision)
    {
        let current_revision = objective_contract_for_execution(state, Some(thread_id))
            .map(|objective| objective.revision);
        if current_revision != Some(approved_revision) {
            return format!(
                "Approval {code} belongs to objective revision {approved_revision}, but the task objective has changed. Review and approve the current plan instead."
            );
        }
    }
    match lock_store(state).ok().and_then(|store| {
        store
            .claim_remote_approval(&pending.approval_id)
            .ok()
            .flatten()
    }) {
        Some(claimed) => {
            if claimed.requires_source {
                let (Some(thread_id), Some(message_id)) = (
                    claimed.thread_id.as_deref(),
                    claimed.source_message_id.as_deref(),
                ) else {
                    if let Ok(store) = lock_store(state) {
                        let _ = store.complete_remote_approval(&claimed.approval_id, "failed");
                    }
                    return format!(
                        "Approval {code} is missing its exact source card; no action was executed."
                    );
                };
                let source_claim = claim_actionable_source(state, thread_id, message_id, |text| {
                    if claimed.tool.starts_with("mcp__") {
                        mcp_confirm_matches_approval(
                            text,
                            &claimed.approval_id,
                            &claimed.tool,
                            &claimed.arguments,
                        )
                    } else {
                        confirm_marker_matches_approval(
                            text,
                            COMPOSIO_CONFIRM_OPEN,
                            COMPOSIO_CONFIRM_CLOSE,
                            &claimed.approval_id,
                            &claimed.tool,
                            &claimed.arguments,
                        )
                    }
                });
                if let Err(error) = source_claim {
                    if let Ok(store) = lock_store(state) {
                        let _ = store.complete_remote_approval(&claimed.approval_id, "failed");
                    }
                    append_remote_approval_thread_status(
                        state,
                        &claimed,
                        "failed",
                        Some("Source card was stale, cancelled, or already claimed."),
                    );
                    return format!(
                        "Approval {code} rejected before execution: {}",
                        error.message
                    );
                }
            }
            append_remote_approval_thread_status(state, &claimed, "running", None);
            let tool = claimed.tool.clone();
            let args = claimed.arguments.clone();
            let args_for_resume = claimed.arguments.clone();
            let thread_id = claimed.thread_id.clone();
            let source_message_id = claimed.source_message_id.clone();
            let st = state.clone();
            let tool_for_run = tool.clone();
            let result: Result<serde_json::Value, String> =
                tokio::task::spawn_blocking(move || {
                    if let Some((prov, mtool)) = parse_mcp_chat_name(&tool_for_run) {
                        run_mcp_chat_tool(&st, &prov, &mtool, args.clone())
                            .map_err(|e| e.to_string())
                    } else {
                        composio_execute_tool(&st, &tool_for_run, &args).map_err(|e| e.message)
                    }
                })
                .await
                .unwrap_or_else(|_| Err("execution interrupted".to_string()));
            match result {
                Ok(value) => match composio_execution_error(&value) {
                    None => {
                        let source_resolved = match (
                            claimed.thread_id.as_deref(),
                            claimed.source_message_id.as_deref(),
                        ) {
                            (Some(thread_id), Some(message_id)) => resolve_actionable_source(
                                state,
                                thread_id,
                                message_id,
                                |text| {
                                    if claimed.tool.starts_with("mcp__") {
                                        rewrite_mcp_confirm_to_done(text, &claimed.tool)
                                    } else {
                                        rewrite_confirm_to_done(text, &claimed.tool)
                                    }
                                },
                                ActionableSourceResolution::Succeeded,
                            ),
                            _ => Ok(()),
                        };
                        if let Ok(store) = lock_store(state) {
                            let _ =
                                store.complete_remote_approval(&claimed.approval_id, "executed");
                        }
                        if let Err(error) = source_resolved {
                            append_remote_approval_thread_status(
                                state,
                                &claimed,
                                "executed",
                                Some("Tool completed, but its source turn could not be resolved."),
                            );
                            return format!(
                                "⚠️ Done ({code}), but the source turn needs recovery: {}",
                                error.message
                            );
                        }
                        append_remote_approval_thread_status(
                            state,
                            &claimed,
                            "executed",
                            Some("Tool completato; sto riaprendo il contesto del thread."),
                        );
                        // The action ran out-of-band after the turn died at `pending_confirm`;
                        // resume the origin thread so the multi-step task keeps going.
                        resume_thread_after_approval(
                            state,
                            thread_id,
                            &tool,
                            &value.to_string(),
                            Some(args_for_resume),
                            source_message_id,
                        );
                        format!("✅ Done ({code}).")
                    }
                    Some(err) => {
                        if let (Some(thread_id), Some(message_id)) = (
                            claimed.thread_id.as_deref(),
                            claimed.source_message_id.as_deref(),
                        ) {
                            let _ = resolve_actionable_source(
                                state,
                                thread_id,
                                message_id,
                                |text| actionable_source_terminal_text(text, "Action failed."),
                                ActionableSourceResolution::Failed,
                            );
                        }
                        if let Ok(store) = lock_store(state) {
                            let _ = store.complete_remote_approval(&claimed.approval_id, "failed");
                        }
                        append_remote_approval_thread_status(state, &claimed, "failed", Some(&err));
                        format!("⚠️ Failed ({code}): {err}")
                    }
                },
                Err(e) => {
                    if let (Some(thread_id), Some(message_id)) = (
                        claimed.thread_id.as_deref(),
                        claimed.source_message_id.as_deref(),
                    ) {
                        let _ = resolve_actionable_source(
                            state,
                            thread_id,
                            message_id,
                            |text| actionable_source_terminal_text(text, "Action failed."),
                            ActionableSourceResolution::Failed,
                        );
                    }
                    if let Ok(store) = lock_store(state) {
                        let _ = store.complete_remote_approval(&claimed.approval_id, "failed");
                    }
                    append_remote_approval_thread_status(state, &claimed, "failed", Some(&e));
                    format!("⚠️ Error ({code}): {e}")
                }
            }
        }
        None => format!("Code {code} not valid or expired."),
    }
}
