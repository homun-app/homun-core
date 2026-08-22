//! Chat code-map prompt composition owner.
//!
//! Owns the runtime decision to append the code-map guidance to the chat core
//! prompt. Code-map presence and prompt wording stay in their existing owners.

use crate::AppState;
use crate::gateway_memory_prompt_context::project_has_code_map;
use crate::gateway_prompt_instructions::code_map_available_instruction;

pub(crate) struct ChatCodeMapPromptInput<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) system: String,
}

pub(crate) async fn append_chat_code_map_prompt_instruction(
    input: ChatCodeMapPromptInput<'_>,
) -> String {
    let st = input.state.clone();
    let has_code_map = tokio::task::spawn_blocking(move || project_has_code_map(&st))
        .await
        .unwrap_or(false);
    if has_code_map {
        format!("{}\n\n{}", input.system, code_map_available_instruction())
    } else {
        input.system
    }
}
