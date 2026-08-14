//! MCP chat tool catalogue owner.
//!
//! Owns the OpenAI-visible MCP tool naming contract and the cached schema
//! projection used by chat turns and automation event sources. Execution stays
//! in the gateway MCP execution path.

use crate::gateway_identity::{gateway_capability_user_id, gateway_capability_workspace_id};
use crate::{AppState, lock_capability_registry};
use local_first_capabilities::{
    ActionClass, CapabilityProviderKind, ProviderId as CapabilityProviderId,
};

/// OpenAI tool name for an MCP tool, namespaced by provider so multiple MCP
/// servers and connector slugs never collide: `mcp__{slug}__{tool}`.
pub(crate) fn mcp_chat_tool_name(provider_id: &CapabilityProviderId, tool: &str) -> String {
    let id = provider_id.as_str();
    let slug = id.strip_prefix("mcp:").unwrap_or(id);
    format!("mcp__{slug}__{tool}")
}

/// Inverse of [`mcp_chat_tool_name`].
///
/// Returns `None` for any non-MCP name, so dispatchers can route MCP and
/// connector tools through one tool namespace without guessing.
pub(crate) fn parse_mcp_chat_name(name: &str) -> Option<(CapabilityProviderId, String)> {
    let rest = name.strip_prefix("mcp__")?;
    let (slug, tool) = rest.split_once("__")?;
    if slug.is_empty() || tool.is_empty() {
        return None;
    }
    Some((
        CapabilityProviderId::new(format!("mcp:{slug}")),
        tool.to_string(),
    ))
}

/// MCP function tools to expose to the chat model, plus the subset that are
/// writes and need confirmation before running.
#[derive(Debug, Default)]
pub(crate) struct McpChatTools {
    pub(crate) schemas: Vec<serde_json::Value>,
    pub(crate) writes: std::collections::BTreeSet<String>,
}

/// Builds OpenAI function schemas for every cached tool of every connected MCP
/// server. Reads from the local registry cache only; registry errors yield an
/// empty catalogue so chat remains available.
pub(crate) fn mcp_chat_tools(state: &AppState, cap: usize) -> McpChatTools {
    let mut out = McpChatTools::default();
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();
    let Ok(registry) = lock_capability_registry(state) else {
        return out;
    };
    let Ok(connections) = registry.connection_configs(&user, &workspace) else {
        return out;
    };
    for conn in connections {
        let is_mcp = registry
            .provider_config(&conn.provider_id)
            .ok()
            .flatten()
            .map(|config| config.provider_kind == CapabilityProviderKind::Mcp)
            .unwrap_or(false);
        if !is_mcp {
            continue;
        }
        let Ok(tools) = registry.cached_tools(&conn.provider_id) else {
            continue;
        };
        for cached in tools {
            if out.schemas.len() >= cap {
                return out;
            }
            let name = mcp_chat_tool_name(&conn.provider_id, &cached.tool.name);
            // A read-looking name is never gated, even if the tool was cached under
            // the old "absent readOnlyHint -> write" default.
            if cached.tool.action != ActionClass::Read
                && !local_first_capabilities::name_is_read_only(&cached.tool.name)
            {
                out.writes.insert(name.clone());
            }
            let description = cached
                .tool
                .description
                .chars()
                .take(300)
                .collect::<String>();
            let parameters = if cached.tool.input_schema.is_null() {
                serde_json::json!({ "type": "object", "properties": {} })
            } else {
                cached.tool.input_schema.clone()
            };
            out.schemas.push(serde_json::json!({
                "type": "function",
                "function": { "name": name, "description": description, "parameters": parameters },
            }));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use local_first_capabilities::ProviderId as CapabilityProviderId;

    #[test]
    fn mcp_chat_name_strips_provider_prefix_and_round_trips() {
        let provider_id = CapabilityProviderId::new("mcp:filesystem");
        let name = mcp_chat_tool_name(&provider_id, "read_file");

        assert_eq!(name, "mcp__filesystem__read_file");
        let (parsed_provider, parsed_tool) = parse_mcp_chat_name(&name).unwrap();
        assert_eq!(parsed_provider.as_str(), "mcp:filesystem");
        assert_eq!(parsed_tool, "read_file");
    }

    #[test]
    fn parse_mcp_chat_name_rejects_non_mcp_or_incomplete_names() {
        assert!(parse_mcp_chat_name("GMAIL_FETCH_EMAILS").is_none());
        assert!(parse_mcp_chat_name("mcp__filesystem").is_none());
        assert!(parse_mcp_chat_name("mcp____read_file").is_none());
        assert!(parse_mcp_chat_name("mcp__filesystem__").is_none());
    }

    #[test]
    fn mcp_chat_tool_name_preserves_non_prefixed_provider_ids() {
        let provider_id = CapabilityProviderId::new("custom");

        assert_eq!(
            mcp_chat_tool_name(&provider_id, "call"),
            "mcp__custom__call"
        );
    }
}
