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
         ROUTING: When the user needs LIVE or EXTERNAL information you cannot answer reliably from memory — current prices, schedules/timetables, availability, news, sports results, or the content of a specific website — DO NOT route to direct_answer. Plan a WEB BROWSE: a single subagent_task step (kind=subagent_task, agent_id=ToolAgent, depends_on=[], execution_policy=durable_task, risk_level=low, expected_duration_seconds=60, allowed_actions=[\"read\"], requires_user_approval=false) whose \"goal\" states what to find on the web and \"contract\" states what to return; the sub-agent will navigate, search and read with the browser tools. Use direct_answer ONLY for things answerable from your own knowledge or the provided memory.\n\
         Never invent tools. Use only loaded tool details for executable steps.\n\
         A capability_call step's \"tool_name\" MUST be EXACTLY one loaded tool name — never put arguments, URLs or values inside it. ALL tool inputs go in the \"arguments\" object.\n\
         \n\
         OUTPUT FORMAT — return ONLY one JSON object with EXACTLY these top-level keys:\n\
         - \"route\": one of [direct_answer, memory_lookup, capability_call, subagent_workflow, mixed_workflow, ask_clarification, refuse, needs_more_tools]\n\
         - \"steps\": array of step objects (use [] for direct_answer/ask_clarification/refuse). Each step object MUST have: \"step_id\" (string), \"kind\" (capability_call|memory_lookup|subagent_task|direct_answer), \"depends_on\" (array of step_id), \"execution_policy\" (immediate|durable_task|ask_approval), \"risk_level\" (string), \"expected_duration_seconds\" (integer). A capability_call step adds \"provider_id\",\"tool_name\",\"arguments\". A subagent_task step adds \"agent_id\" (one of [PlannerAgent, MemoryAgent, ToolAgent, VisionAgent, RiskAgent, AutomationAgent, ReviewAgent]), \"goal\",\"contract\",\"allowed_actions\",\"requires_user_approval\",\"timeout_seconds\",\"max_tokens\".\n\
         - optional \"plan_propose\": {{\"summary\",\"steps\"}} only when user approval of a plan is needed before execution.\n\
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

pub(crate) fn planner_schema(loaded_tool_names: &[&str]) -> serde_json::Value {
    // Constrain a step's tool_name to the LOADED tool names (caposaldo #6: the model fills a
    // CONSTRAINED slot, the harness owns the format). A free string let weak models cram the
    // arguments into the name field (observed on gemma4: `"browser_navigate.url: https://…"`);
    // an enum forces a real tool id wherever the backend enforces json_schema — and Ollama
    // does (the eval suite passes strict schemas on gemma4). `null` stays allowed for
    // non-capability_call steps. When no tools are loaded we keep a free string so the schema
    // never becomes unsatisfiable.
    let tool_name_schema = if loaded_tool_names.is_empty() {
        json!({"type": ["string", "null"]})
    } else {
        let mut allowed: Vec<serde_json::Value> =
            loaded_tool_names.iter().map(|name| json!(name)).collect();
        allowed.push(serde_json::Value::Null);
        json!({"type": ["string", "null"], "enum": allowed})
    };
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["route"],
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
            "plan_propose": {
                "type": ["object", "null"],
                "additionalProperties": false,
                "properties": {
                    "summary": {"type": "string"},
                    "steps": {
                        "type": "array",
                        "items": {"type": "string"}
                    }
                }
            },
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
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
                        "tool_name": tool_name_schema,
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
            "needs_more_tools": {
                "type": ["object", "null"],
                "additionalProperties": false,
                "properties": {
                    "query": {"type": "string"}
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn planner_schema_is_closed_for_constrained_orchestration() {
        let schema = super::planner_schema(&[]);
        assert_eq!(
            schema.pointer("/additionalProperties"),
            Some(&serde_json::Value::Bool(false))
        );
        assert_eq!(
            schema.pointer("/properties/plan_propose/additionalProperties"),
            Some(&serde_json::Value::Bool(false))
        );
        assert_eq!(
            schema.pointer("/properties/needs_more_tools/additionalProperties"),
            Some(&serde_json::Value::Bool(false))
        );
        assert_eq!(
            schema.pointer("/properties/steps/items/additionalProperties"),
            Some(&serde_json::Value::Bool(false))
        );
        // No tools loaded → tool_name stays a free string (schema must not be unsatisfiable).
        assert!(
            schema
                .pointer("/properties/steps/items/properties/tool_name/enum")
                .is_none()
        );
    }

    #[test]
    fn planner_schema_constrains_tool_name_to_loaded_tools() {
        let schema = super::planner_schema(&["browser_navigate", "browser_act"]);
        let enum_values = schema
            .pointer("/properties/steps/items/properties/tool_name/enum")
            .and_then(|value| value.as_array())
            .expect("tool_name enum present when tools are loaded");
        // The real tool names plus null (non-capability_call steps have no tool).
        assert!(enum_values.contains(&serde_json::json!("browser_navigate")));
        assert!(enum_values.contains(&serde_json::json!("browser_act")));
        assert!(enum_values.contains(&serde_json::Value::Null));
        // A crammed name is NOT in the allowed set → the backend rejects it at the source.
        assert!(!enum_values.contains(&serde_json::json!("browser_navigate.url: https://x")));
    }
}
