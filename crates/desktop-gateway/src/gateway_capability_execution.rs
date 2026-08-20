//! Autonomous non-browser capability execution owner.
//!
//! Keeps capability task dispatch, managed-tool authorization, and shared
//! ExecutorResult presentation mapping out of the gateway root and away from
//! task-queue and browser owners.

use super::*;
use crate::gateway_shell_tasks::redact_json_for_task_output;

/// Executes a non-browser `capability.*` task by building a live provider from
/// the registry and dispatching through `CapabilityFacade::call_tool`.
pub(crate) fn execute_capability_generic(
    state: &AppState,
    task: &TaskRecord,
    _contract: &local_first_execution_protocol::ValidatedExecutionContract,
) -> Result<local_first_execution_protocol::ExecutionOutcome, LocalTaskExecutionError> {
    let payload: CapabilityTaskPayload =
        serde_json::from_value(task.input_json.clone()).map_err(|error| {
            LocalTaskExecutionError {
                message: format!("Invalid capability payload: {error}"),
            }
        })?;
    let call = payload.call;
    let provider_id = call.provider_id.clone();
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();

    let (kind, connection, tool_policies, policy_context) = {
        let registry = lock_capability_registry(state).map_err(local_task_gateway_error)?;
        let kind = registry
            .provider_config(&provider_id)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("provider config: {error}"),
            })?
            .map(|config| config.provider_kind)
            .ok_or_else(|| LocalTaskExecutionError {
                message: format!("provider not configured: {}", provider_id.as_str()),
            })?;
        let connection = registry
            .connection_configs(&user, &workspace)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("connection configs: {error}"),
            })?
            .into_iter()
            .find(|config| config.provider_id == provider_id);
        let tool_policies = registry
            .cached_tools(&provider_id)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("cached tools: {error}"),
            })?
            .into_iter()
            .map(|cached| McpToolPolicy {
                tool_name: cached.tool.name,
                action: cached.tool.action,
                privacy_domains: cached.tool.privacy_domains,
                sensitivity: cached.tool.sensitivity,
            })
            .collect::<Vec<_>>();
        let policy_context = registry
            .policy_context(&user, &workspace)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("policy context: {error}"),
            })?;
        (kind, connection, tool_policies, policy_context)
    };

    let result = match kind {
        CapabilityProviderKind::Mcp => {
            let connection = connection.ok_or_else(|| LocalTaskExecutionError {
                message: format!("no connection for provider {}", provider_id.as_str()),
            })?;
            let transport = build_mcp_transport(state, &connection)
                .map_err(|message| LocalTaskExecutionError { message })?;
            let mut facade =
                CapabilityFacade::new(CapabilityPolicy, InMemoryCapabilityAudit::default());
            facade.register_provider(McpCapabilityProvider::new(
                provider_id.clone(),
                true,
                transport,
                tool_policies,
            ));
            facade.call_tool(&policy_context, call)
        }
        CapabilityProviderKind::Managed => {
            if let Err(reason) = authorize_managed_capability_tool(
                &tool_policies,
                &policy_context,
                &provider_id,
                call.tool_name.as_str(),
            ) {
                return execution_runtime::fail_task_execution(
                    state,
                    task,
                    local_first_execution_protocol::ExecutionFailure::policy_denied(
                        "capability_policy_denied",
                        &reason,
                    ),
                    capability_call_failed_outcome(task, &reason),
                );
            }
            composio_execute_tool(state, call.tool_name.as_str(), &call.arguments)
                .map(|output| local_first_capabilities::CapabilityCallResult {
                    provider_id: provider_id.clone(),
                    tool_name: call.tool_name.clone(),
                    output,
                })
                .map_err(|error| CapabilityError::ToolExecutionFailed(error.message))
        }
        other => {
            let presentation = capability_kind_not_wired_outcome(task, other);
            return execution_runtime::fail_task_execution(
                state,
                task,
                local_first_execution_protocol::ExecutionFailure::permanent(
                    "capability_provider_not_wired",
                    &presentation.summary,
                ),
                presentation,
            );
        }
    };

    match result {
        Ok(call_result) => execution_runtime::complete_task_execution(
            state,
            task,
            capability_call_completed_outcome(task, &call_result),
        ),
        Err(error) => {
            let reason = error.to_string();
            execution_runtime::fail_task_execution(
                state,
                task,
                local_first_execution_protocol::ExecutionFailure::transient(
                    "capability_call_failed",
                    &reason,
                ),
                capability_call_failed_outcome(task, &reason),
            )
        }
    }
}

/// Re-checks the deny-by-default policy for an autonomous Managed tool before
/// routing it through the canonical Composio v3 execution path.
pub(crate) fn authorize_managed_capability_tool(
    tool_policies: &[McpToolPolicy],
    policy_context: &PolicyContext,
    provider_id: &CapabilityProviderId,
    tool_name: &str,
) -> Result<(), String> {
    let Some(policy) = tool_policies.iter().find(|p| p.tool_name == tool_name) else {
        return Err(format!(
            "Composio tool `{tool_name}` is not in the catalog cache - cannot authorize it \
             for autonomous execution; open the chat once to refresh the connected toolkit."
        ));
    };
    let tool = CapabilityTool {
        name: policy.tool_name.clone(),
        provider_id: provider_id.clone(),
        provider_kind: CapabilityProviderKind::Managed,
        action: policy.action,
        description: String::new(),
        privacy_domains: policy.privacy_domains.clone(),
        sensitivity: policy.sensitivity.clone(),
        input_schema: serde_json::json!({ "type": "object" }),
    };
    let decision = CapabilityPolicy.tool_access(policy_context, &tool);
    if decision.executable {
        Ok(())
    } else {
        Err(format!("denied: {}", decision.reasons.join("; ")))
    }
}

pub(crate) fn capability_call_completed_outcome(
    _task: &TaskRecord,
    result: &local_first_capabilities::CapabilityCallResult,
) -> TaskExecutionPresentation {
    let summary = format!("Tool `{}` eseguito.", result.tool_name);
    TaskExecutionPresentation {
        pending_approval: None,
        summary: summary.clone(),
        checkpoint_payload: serde_json::json!({
            "kind": "capability_tool_completed",
            "provider": result.provider_id.as_str(),
            "tool": result.tool_name,
            "output": result.output,
        }),
        checkpoint_redacted: serde_json::json!({
            "kind": "capability_tool_completed",
            "provider": result.provider_id.as_str(),
            "tool": result.tool_name,
        }),
        chat_message: format!(
            "Ran `{}` via `{}`.",
            result.tool_name,
            result.provider_id.as_str()
        ),
        result_surfacing: TaskResultSurfacing::AppendToChat,
        surface: SurfaceKind::Logs,
        event_kind: "capability_tool_completed".to_string(),
        event_title: "Tool executed".to_string(),
        event_subtitle: summary,
        event_payload: serde_json::json!({
            "provider": result.provider_id.as_str(),
            "tool": result.tool_name,
        }),
        artifacts: vec![],
    }
}

pub(crate) fn capability_call_failed_outcome(
    task: &TaskRecord,
    reason: &str,
) -> TaskExecutionPresentation {
    TaskExecutionPresentation {
        pending_approval: None,
        summary: reason.to_string(),
        checkpoint_payload: serde_json::json!({
            "kind": "capability_tool_failed",
            "task_kind": task.kind,
            "reason": reason,
        }),
        checkpoint_redacted: serde_json::json!({
            "kind": "capability_tool_failed",
            "task_kind": task.kind,
            "reason": reason,
        }),
        chat_message: format!("The capability tool failed: {reason}"),
        result_surfacing: TaskResultSurfacing::AppendToChat,
        surface: SurfaceKind::Logs,
        event_kind: "capability_tool_failed".to_string(),
        event_title: "Tool failed".to_string(),
        event_subtitle: reason.to_string(),
        event_payload: serde_json::json!({ "task_kind": task.kind }),
        artifacts: vec![],
    }
}

pub(crate) fn capability_kind_not_wired_outcome(
    task: &TaskRecord,
    kind: CapabilityProviderKind,
) -> TaskExecutionPresentation {
    let reason = format!(
        "Capability execution for provider kind {kind:?} not yet wired (MCP and Composio active)."
    );
    capability_call_failed_outcome(task, &reason)
}

pub(crate) fn task_execution_outcome_from_executor_result(
    state: &AppState,
    task: &TaskRecord,
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
    executor_id: &str,
    tool_name: &str,
    result: ExecutorResult,
) -> Result<local_first_execution_protocol::ExecutionOutcome, LocalTaskExecutionError> {
    match result {
        ExecutorResult::Completed { output } => execution_runtime::complete_task_execution(
            state,
            task,
            completed_executor_outcome(task, executor_id, tool_name, output),
        ),
        ExecutorResult::Checkpoint {
            payload,
            redacted_payload,
        } => {
            let output = payload.clone();
            let mut presentation = completed_executor_outcome(task, executor_id, tool_name, output);
            presentation.checkpoint_payload = serde_json::json!({
                "kind": "executor_completed",
                "executor_id": executor_id,
                "tool": tool_name,
                "output": payload,
            });
            presentation.checkpoint_redacted = serde_json::json!({
                "kind": "executor_completed",
                "executor_id": executor_id,
                "tool": tool_name,
                "output": redacted_payload,
            });
            execution_runtime::complete_task_execution(state, task, presentation)
        }
        ExecutorResult::NeedsApproval {
            action,
            risk_level,
            data_boundary,
            explanation,
        } => {
            let presentation = TaskExecutionPresentation {
                pending_approval: Some(PendingExecutorApproval {
                    action: action.clone(),
                    risk_level: risk_level.clone(),
                    data_boundary: data_boundary.clone(),
                    explanation: explanation.clone(),
                    inline_action_card: false,
                }),
                summary: "Task in attesa di approval.".to_string(),
                checkpoint_payload: serde_json::json!({
                    "kind": "executor_needs_approval",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "approval": {
                        "action": action,
                        "risk_level": risk_level,
                        "data_boundary": data_boundary,
                        "explanation": explanation,
                    },
                }),
                checkpoint_redacted: serde_json::json!({
                    "kind": "executor_needs_approval",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "approval": {
                        "action": action,
                        "risk_level": risk_level,
                        "data_boundary": data_boundary,
                        "explanation": explanation,
                    },
                }),
                chat_message: format!(
                    "The task `{}` requires a new approval before continuing: {}",
                    task.kind, explanation
                ),
                result_surfacing: TaskResultSurfacing::AppendToChat,
                surface: SurfaceKind::Logs,
                event_kind: "computer_executor_waiting_approval".to_string(),
                event_title: "Approval required".to_string(),
                event_subtitle: explanation,
                event_payload: serde_json::json!({
                    "executor_id": executor_id,
                    "tool": tool_name,
                }),
                artifacts: vec![],
            };
            execution_runtime::suspend_task_execution(
                state,
                task,
                contract,
                local_first_execution_protocol::WakeCondition::Approval {
                    approval_ref: format!(
                        "{}:{}:approval:{}",
                        contract.as_ref().execution_id,
                        contract.as_ref().revision,
                        action
                    ),
                },
                presentation,
            )
        }
        ExecutorResult::WaitUntil { not_before, reason } => {
            let presentation = TaskExecutionPresentation {
                pending_approval: None,
                summary: reason.clone(),
                checkpoint_payload: serde_json::json!({
                    "kind": "executor_waiting_time",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "output": {
                        "blocked_reason": reason,
                        "not_before": not_before.unix_timestamp(),
                    },
                }),
                checkpoint_redacted: serde_json::json!({
                    "kind": "executor_waiting_time",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "output": {
                        "blocked_reason": reason,
                        "not_before": not_before.unix_timestamp(),
                    },
                }),
                chat_message: format!(
                    "The task `{}` is waiting until {}: {}",
                    task.kind, not_before, reason
                ),
                result_surfacing: TaskResultSurfacing::AppendToChat,
                surface: SurfaceKind::Logs,
                event_kind: "computer_executor_waiting_time".to_string(),
                event_title: "Task waiting".to_string(),
                event_subtitle: reason.clone(),
                event_payload: serde_json::json!({
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "not_before": not_before.unix_timestamp(),
                }),
                artifacts: vec![],
            };
            execution_runtime::suspend_task_execution(
                state,
                task,
                contract,
                local_first_execution_protocol::WakeCondition::At {
                    unix_seconds: not_before.unix_timestamp(),
                },
                presentation,
            )
        }
        ExecutorResult::RetryableFailure { reason } => {
            let presentation = TaskExecutionPresentation {
                pending_approval: None,
                summary: reason.clone(),
                checkpoint_payload: serde_json::json!({
                    "kind": "executor_blocked",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "output": {
                        "blocked_reason": reason,
                    },
                }),
                checkpoint_redacted: serde_json::json!({
                    "kind": "executor_blocked",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "output": {
                        "blocked_reason": reason,
                    },
                }),
                chat_message: format!("The task `{}` is blocked: {}", task.kind, reason),
                result_surfacing: TaskResultSurfacing::AppendToChat,
                surface: SurfaceKind::Logs,
                event_kind: "computer_executor_blocked".to_string(),
                event_title: "Task blocked".to_string(),
                event_subtitle: reason.clone(),
                event_payload: serde_json::json!({
                    "executor_id": executor_id,
                    "tool": tool_name,
                }),
                artifacts: vec![],
            };
            execution_runtime::fail_task_execution(
                state,
                task,
                local_first_execution_protocol::ExecutionFailure::transient(
                    "executor_retryable_failure",
                    &reason,
                ),
                presentation,
            )
        }
    }
}

pub(crate) fn completed_executor_outcome(
    task: &TaskRecord,
    executor_id: &str,
    tool_name: &str,
    output: Value,
) -> TaskExecutionPresentation {
    TaskExecutionPresentation {
        pending_approval: None,
        summary: format!("Executor `{executor_id}` completed."),
        checkpoint_payload: serde_json::json!({
            "kind": "executor_completed",
            "executor_id": executor_id,
            "tool": tool_name,
            "output": output,
        }),
        checkpoint_redacted: serde_json::json!({
            "kind": "executor_completed",
            "executor_id": executor_id,
            "tool": tool_name,
            "output": redact_json_for_task_output(&output),
        }),
        chat_message: format!("Task `{}` completed via `{tool_name}`.", task.kind),
        result_surfacing: TaskResultSurfacing::AppendToChat,
        surface: SurfaceKind::Browser,
        event_kind: "computer_executor_completed".to_string(),
        event_title: "Executor completed".to_string(),
        event_subtitle: format!("{} produced structured output.", tool_name),
        event_payload: serde_json::json!({
            "executor_id": executor_id,
            "tool": tool_name,
        }),
        artifacts: vec![],
    }
}
