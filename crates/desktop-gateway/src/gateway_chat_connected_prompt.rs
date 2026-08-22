//! Chat connected-service prompt composition owner.
//!
//! Owns the runtime prompt additions derived from the connected tool catalog.
//! Tool catalog assembly and static prompt wording stay in their existing owners.

use crate::gateway_chat_toolset::ConnectedToolCatalog;
use crate::gateway_prompt_instructions::{
    connected_service_tools_instruction, expired_connected_services_instruction,
};

pub(crate) struct ChatConnectedPromptInput {
    pub(crate) system: String,
    pub(crate) catalog: ConnectedToolCatalog,
}

pub(crate) struct ChatConnectedPrompt {
    pub(crate) system: String,
    pub(crate) catalog_index: Vec<(String, String, serde_json::Value)>,
    pub(crate) composio_writes: std::collections::BTreeSet<String>,
    pub(crate) mcp_schemas: Vec<serde_json::Value>,
    pub(crate) has_composio: bool,
}

pub(crate) fn append_chat_connected_prompt_instructions(
    input: ChatConnectedPromptInput,
) -> ChatConnectedPrompt {
    let ConnectedToolCatalog {
        catalog_index,
        composio_writes,
        mcp_schemas,
        inactive_services,
        filesystem_mcp_instruction,
    } = input.catalog;
    let has_composio = !catalog_index.is_empty();
    let system = match filesystem_mcp_instruction {
        Some(instruction) => format!("{}\n\n{}", input.system, instruction),
        None => input.system,
    };
    let system = if has_composio {
        format!("{system}\n\n{}", connected_service_tools_instruction())
    } else {
        system
    };
    let system = if inactive_services.is_empty() {
        system
    } else {
        format!(
            "{system}\n\n{}",
            expired_connected_services_instruction(&inactive_services.join(", "))
        )
    };

    ChatConnectedPrompt {
        system,
        catalog_index,
        composio_writes,
        mcp_schemas,
        has_composio,
    }
}
