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
         Decide whether to answer directly, use memory, call capability tools, enqueue durable tasks, or ask for clarification.\n\
         Return only valid JSON matching the schema. Never invent tools. Use only loaded tool details for executable steps.\n\
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
            "steps": {"type": "array"},
            "needs_more_tools": {"type": ["object", "null"]}
        }
    })
}
