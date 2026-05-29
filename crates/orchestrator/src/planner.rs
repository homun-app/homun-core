use crate::{ContextBudgetUsage, OrchestratorRequest, OrchestratorResult, ToolCard};
use local_first_capabilities::CapabilityTool;
use local_first_context_compression::{
    CompressionPolicy, CompressionResult, ContextCompressor, ContextItem, ContextKind,
};
use serde_json::json;

pub(crate) struct PlannerPrompt {
    pub prompt: String,
    pub context_budget: Vec<ContextBudgetUsage>,
}

pub(crate) fn planner_prompt(
    request: &OrchestratorRequest,
    memory: &[crate::MemoryContextSnippet],
    loaded_cards: &[ToolCard],
    loaded_tools: &[CapabilityTool],
) -> OrchestratorResult<PlannerPrompt> {
    let conversation_summary = compress_chat_context(
        "conversation_summary",
        request.conversation_summary.as_deref().unwrap_or(""),
        request.budgets.max_conversation_summary_chars,
    );
    let memory_context = compress_json_context(
        "memory_context",
        memory,
        request.budgets.max_memory_context_chars,
    )?;
    let tool_cards = compress_json_context(
        "tool_catalog_cards",
        loaded_cards,
        request.budgets.max_tool_cards_context_chars,
    )?;
    let loaded_tool_details = compress_json_context(
        "loaded_tool_details",
        loaded_tools,
        request.budgets.max_loaded_tool_context_chars,
    )?;
    let prompt = format!(
        "You are the local-first assistant orchestrator brain.\n\
         Decide whether to answer directly, use memory, call capability tools, create subagent workflow tasks, enqueue durable tasks, or ask for clarification.\n\
         Never invent tools. Use only loaded tool details for executable steps.\n\
         \n\
         OUTPUT FORMAT — return ONLY one JSON object with EXACTLY these top-level keys:\n\
         - \"route\": one of [direct_answer, memory_lookup, capability_call, subagent_workflow, mixed_workflow, ask_clarification, refuse, needs_more_tools]\n\
         - \"steps\": array of step objects (use [] for direct_answer/ask_clarification/refuse). Each step object MUST have: \"step_id\" (string), \"kind\" (capability_call|memory_lookup|subagent_task|direct_answer), \"depends_on\" (array of step_id), \"execution_policy\" (immediate|durable_task|ask_approval), \"risk_level\" (string), \"expected_duration_seconds\" (integer). A capability_call step adds \"provider_id\",\"tool_name\",\"arguments\". A subagent_task step adds \"agent_id\",\"goal\",\"contract\",\"allowed_actions\",\"requires_user_approval\",\"timeout_seconds\",\"max_tokens\".\n\
         - optional \"direct_answer\": {{\"answer\",\"reason\",\"confidence\"}} only when route=direct_answer.\n\
         - optional \"needs_more_tools\": {{\"query\"}} only when you need tools not yet loaded.\n\
         Do NOT put step fields at the top level; steps always go inside the \"steps\" array.\n\
         Example: {{\"route\":\"capability_call\",\"steps\":[{{\"step_id\":\"s1\",\"kind\":\"capability_call\",\"depends_on\":[],\"provider_id\":\"browser\",\"tool_name\":\"browser.snapshot\",\"arguments\":{{}},\"execution_policy\":\"durable_task\",\"risk_level\":\"low\",\"expected_duration_seconds\":10}}]}}\n\
         \n\
         User message: {}\n\
         Conversation summary: {}\n\
         Memory context: {}\n\
         Tool catalog compact cards: {}\n\
         Loaded tool details: {}",
        request.user_message,
        conversation_summary.0,
        memory_context.0,
        tool_cards.0,
        loaded_tool_details.0
    );
    Ok(PlannerPrompt {
        prompt,
        context_budget: vec![
            conversation_summary.1,
            memory_context.1,
            tool_cards.1,
            loaded_tool_details.1,
        ],
    })
}

fn compress_json_context<T: serde::Serialize + ?Sized>(
    label: &str,
    value: &T,
    max_chars: usize,
) -> OrchestratorResult<(String, ContextBudgetUsage)> {
    let raw = serde_json::to_string(value)?;
    let result = ContextCompressor::default().compress(
        &ContextItem::new(ContextKind::ToolJson, raw),
        &CompressionPolicy::for_kind(ContextKind::ToolJson).with_max_chars(max_chars),
    );
    Ok((result.text.clone(), context_budget_usage(label, &result)))
}

fn compress_chat_context(
    label: &str,
    value: &str,
    max_chars: usize,
) -> (String, ContextBudgetUsage) {
    let result = ContextCompressor::default().compress(
        &ContextItem::new(ContextKind::ChatHistory, value),
        &CompressionPolicy::for_kind(ContextKind::ChatHistory).with_max_chars(max_chars),
    );
    (result.text.clone(), context_budget_usage(label, &result))
}

fn context_budget_usage(label: &str, result: &CompressionResult) -> ContextBudgetUsage {
    ContextBudgetUsage {
        label: label.to_string(),
        kind: serde_json::to_value(result.kind)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".to_string()),
        compressed: result.compressed,
        redacted: result.redacted,
        input_chars: result.metrics.input_chars,
        output_chars: result.metrics.output_chars,
        estimated_input_tokens: result.metrics.estimated_input_tokens,
        estimated_output_tokens: result.metrics.estimated_output_tokens,
        compression_ratio: result.metrics.compression_ratio,
        redaction_count: result.metrics.redaction_count,
    }
}

pub(crate) fn planner_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "required": ["route", "steps"],
        "properties": {
            "route": {
                "type": "string",
                "enum": [
                    "direct_answer",
                    "memory_lookup",
                    "capability_call",
                    "subagent_workflow",
                    "mixed_workflow",
                    "ask_clarification",
                    "refuse",
                    "needs_more_tools"
                ]
            },
            "direct_answer": {"type": ["object", "null"]},
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": [
                        "step_id",
                        "kind",
                        "execution_policy",
                        "risk_level",
                        "expected_duration_seconds"
                    ],
                    "properties": {
                        "step_id": {"type": "string"},
                        "kind": {
                            "type": "string",
                            "enum": [
                                "capability_call",
                                "memory_lookup",
                                "subagent_task",
                                "direct_answer"
                            ]
                        },
                        "depends_on": {
                            "type": "array",
                            "items": {"type": "string"}
                        },
                        "provider_id": {"type": ["string", "null"]},
                        "tool_name": {"type": ["string", "null"]},
                        "arguments": {"type": "object"},
                        "execution_policy": {
                            "type": "string",
                            "enum": ["immediate", "durable_task", "ask_approval"]
                        },
                        "risk_level": {"type": "string"},
                        "expected_duration_seconds": {"type": "integer", "minimum": 0},
                        "agent_id": {
                            "type": ["string", "null"],
                            "enum": [
                                "PlannerAgent",
                                "MemoryAgent",
                                "ToolAgent",
                                "VisionAgent",
                                "RiskAgent",
                                "AutomationAgent",
                                "ReviewAgent",
                                null
                            ]
                        },
                        "goal": {"type": ["string", "null"]},
                        "contract": {"type": ["string", "null"]},
                        "allowed_actions": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": [
                                    "read",
                                    "draft",
                                    "write_with_confirmation",
                                    "approved_automation"
                                ]
                            }
                        },
                        "requires_user_approval": {"type": ["boolean", "null"]},
                        "timeout_seconds": {"type": ["integer", "null"], "minimum": 1},
                        "max_tokens": {"type": ["integer", "null"], "minimum": 1}
                    }
                }
            },
            "needs_more_tools": {"type": ["object", "null"]}
        }
    })
}
