use crate::{OrchestratorRequest, OrchestratorResult, ToolCard};
use local_first_capabilities::CapabilityTool;
use serde_json::json;

pub(crate) fn planner_prompt(
    request: &OrchestratorRequest,
    memory: &[crate::MemoryContextSnippet],
    loaded_cards: &[ToolCard],
    loaded_tools: &[CapabilityTool],
) -> OrchestratorResult<String> {
    Ok(format!(
        "You are the local-first assistant orchestrator brain.\n\
         Decide whether to answer directly, use memory, call capability tools, create subagent workflow tasks, enqueue durable tasks, or ask for clarification.\n\
         Return only valid JSON matching the schema. Never invent tools. Use only loaded tool details for executable steps.\n\
         For subagent_task steps include agent_id, goal, contract, allowed_actions, requires_user_approval, timeout_seconds and max_tokens.\n\
         User message: {}\n\
         Conversation summary: {}\n\
         Memory context: {}\n\
         Tool catalog compact cards: {}\n\
         Loaded tool details: {}",
        request.user_message,
        request.conversation_summary.as_deref().unwrap_or(""),
        serde_json::to_string(memory)?,
        serde_json::to_string(loaded_cards)?,
        serde_json::to_string(loaded_tools)?
    ))
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
                        "depends_on",
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
