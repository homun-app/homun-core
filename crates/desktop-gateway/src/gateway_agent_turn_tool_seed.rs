//! Agent turn tool seed owner.
//!
//! Owns the pre-loop consumption of the already assembled manager tool schemas
//! into `LoopState`. Toolset assembly, tool perimeter rules, execution, browser
//! and subagents stay in their existing owners.

use super::*;

pub(crate) fn seed_agent_turn_tool_schemas(
    loop_state: &mut local_first_engine::LoopState,
    base_tools: Vec<serde_json::Value>,
    mode: &str,
    contact: Option<&ContactTurnContext>,
) {
    loop_state.tool_schemas = base_tools;
    if mode == "ask" {
        loop_state.tool_schemas.clear();
    }
    apply_chat_tool_perimeter(ChatToolPerimeterInput {
        contact,
        tool_schemas: &mut loop_state.tool_schemas,
    });
}
