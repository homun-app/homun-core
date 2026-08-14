use axum::http::StatusCode;
use local_first_capabilities::{
    CachedCapabilityTool, CapabilityCall, CapabilityConnectionConfig, CapabilityFacade,
    CapabilityPolicy, CapabilityProvider, CapabilityProviderKind, CapabilityResult,
    InMemoryCapabilityAudit, McpCapabilityProvider, McpStdioConfig, McpStdioTransport,
    McpToolPolicy, McpTransport, ProviderId as CapabilityProviderId,
};
use local_first_secrets::{SecretMaterial, SecretRef, SecretStore};
use serde_json::Value;
use std::collections::HashMap;

use crate::{
    AppState, GatewayError, gateway_capability_user_id, gateway_capability_workspace_id,
    lock_capability_registry, mcp_http,
};

/// Parses an MCP stdio launch config (command/args/env) from a connection's
/// registry metadata blob.
pub(crate) fn mcp_stdio_config_from_metadata(metadata: &Value) -> Result<McpStdioConfig, String> {
    let command = metadata
        .get("command")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "MCP metadata without `command`".to_string())?
        .to_string();
    let args = metadata
        .get("args")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let env = metadata
        .get("env")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(McpStdioConfig { command, args, env })
}

/// Inverse of [`mcp_stdio_config_from_metadata`]: serializes a stdio config to
/// the connection metadata shape.
pub(crate) fn mcp_stdio_config_to_metadata(config: &McpStdioConfig) -> Value {
    let env: serde_json::Map<String, Value> = config
        .env
        .iter()
        .map(|(key, value)| (key.clone(), Value::String(value.clone())))
        .collect();
    serde_json::json!({
        "transport": "stdio",
        "command": config.command,
        "args": config.args,
        "env": Value::Object(env),
    })
}

/// Serializes the non-secret part of a remote (streamable-HTTP) MCP connection.
/// Request headers are stored separately in the encrypted Secret Store.
pub(crate) fn mcp_http_config_to_metadata(url: &str) -> Value {
    serde_json::json!({
        "transport": "http",
        "url": url,
    })
}

fn validate_mcp_http_headers(headers: &HashMap<String, String>) -> Result<(), String> {
    if headers
        .iter()
        .any(|(name, value)| name.trim().is_empty() || value.trim().is_empty())
    {
        return Err("MCP HTTP header names and values must not be blank".to_string());
    }
    Ok(())
}

pub(crate) fn mcp_http_headers_to_secret(
    headers: &HashMap<String, String>,
) -> Result<SecretMaterial, String> {
    validate_mcp_http_headers(headers)?;
    serde_json::to_vec(headers)
        .map(SecretMaterial::from_bytes)
        .map_err(|_| "MCP HTTP headers could not be encoded".to_string())
}

pub(crate) fn mcp_http_headers_from_secret(
    material: SecretMaterial,
) -> Result<HashMap<String, String>, String> {
    let encoded = material
        .expose_utf8()
        .map_err(|_| "MCP HTTP credential is not valid UTF-8".to_string())?;
    let headers = serde_json::from_str::<HashMap<String, String>>(&encoded)
        .map_err(|_| "MCP HTTP credential has an invalid format".to_string())?;
    validate_mcp_http_headers(&headers)?;
    Ok(headers)
}

fn legacy_mcp_http_headers(metadata: &Value) -> Result<Option<HashMap<String, String>>, String> {
    if metadata.get("transport").and_then(Value::as_str) != Some("http") {
        return Ok(None);
    }
    let Some(raw_headers) = metadata.get("headers") else {
        return Ok(None);
    };
    let object = raw_headers
        .as_object()
        .ok_or_else(|| "Legacy MCP HTTP headers have an invalid format".to_string())?;
    if object.is_empty() {
        return Ok(None);
    }
    let headers = object
        .iter()
        .map(|(name, value)| {
            value
                .as_str()
                .map(|value| (name.clone(), value.to_string()))
                .ok_or_else(|| "Legacy MCP HTTP headers have an invalid format".to_string())
        })
        .collect::<Result<HashMap<_, _>, _>>()?;
    validate_mcp_http_headers(&headers)?;
    Ok(Some(headers))
}

/// Moves credentials written by older Homun builds from connection metadata
/// into the encrypted Secret Store. The deterministic reference makes this
/// safe to retry after an interrupted startup.
pub(crate) fn migrate_legacy_mcp_http_header_secrets(
    state: &AppState,
) -> Result<usize, GatewayError> {
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();
    let connections = lock_capability_registry(state)?
        .connection_configs(&user, &workspace)
        .map_err(GatewayError::capability)?;
    let mut migrated = 0;

    for connection in connections {
        if !connection.provider_id.as_str().starts_with("mcp:") {
            continue;
        }
        let Some(headers) =
            legacy_mcp_http_headers(&connection.metadata).map_err(|message| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "mcp_legacy_headers_invalid",
                message,
            })?
        else {
            continue;
        };
        let secret_ref = SecretRef::new(
            connection.user_id.as_str(),
            connection.workspace_id.as_str(),
            connection.provider_id.as_str(),
            connection.connection_id.as_str(),
        )
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "mcp_secret_ref_invalid",
            message: error.to_string(),
        })?;
        let material = mcp_http_headers_to_secret(&headers).map_err(|message| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "mcp_legacy_headers_invalid",
            message,
        })?;
        let previous_secret =
            state
                .secret_store
                .get(&secret_ref)
                .map_err(|error| GatewayError {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    code: "mcp_secret_read_failed",
                    message: error.to_string(),
                })?;
        state
            .secret_store
            .put(secret_ref.clone(), material)
            .map_err(|error| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "mcp_secret_store_failed",
                message: error.to_string(),
            })?;

        let mut secured = connection;
        secured.secret_ref = secret_ref.as_str().to_string();
        if let Some(metadata) = secured.metadata.as_object_mut() {
            metadata.remove("headers");
        }
        let persist_result = lock_capability_registry(state)?
            .upsert_connection_config(&secured)
            .map_err(GatewayError::capability);
        if let Err(error) = persist_result {
            if let Some(material) = previous_secret {
                let _ = state.secret_store.put(secret_ref, material);
            } else {
                let _ = state.secret_store.delete(&secret_ref);
            }
            return Err(error);
        }
        migrated += 1;
    }

    Ok(migrated)
}

/// One transport type covering both MCP flavors, so a single
/// `McpCapabilityProvider<McpAnyTransport>` handles stdio AND remote servers.
pub(crate) enum McpAnyTransport {
    Stdio(McpStdioTransport),
    Http(mcp_http::McpHttpTransport),
}

impl McpTransport for McpAnyTransport {
    fn request(&self, method: &str, params: Option<Value>) -> CapabilityResult<Value> {
        match self {
            McpAnyTransport::Stdio(t) => t.request(method, params),
            McpAnyTransport::Http(t) => t.request(method, params),
        }
    }
    fn notify(&self, method: &str, params: Option<Value>) -> CapabilityResult<()> {
        match self {
            McpAnyTransport::Stdio(t) => t.notify(method, params),
            McpAnyTransport::Http(t) => t.notify(method, params),
        }
    }
}

/// Builds the right transport from a connection's metadata `transport` field:
/// `"http"` -> remote streamable-HTTP, anything else -> local stdio.
pub(crate) fn build_mcp_transport(
    state: &AppState,
    connection: &CapabilityConnectionConfig,
) -> Result<McpAnyTransport, String> {
    let metadata = &connection.metadata;
    let kind = metadata
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or("stdio");
    if kind == "http" {
        let config = mcp_http_config_from_connection(connection, state.secret_store.as_ref())?;
        let transport = mcp_http::McpHttpTransport::connect(config)
            .map_err(|e| format!("MCP http start failed: {e}"))?;
        Ok(McpAnyTransport::Http(transport))
    } else {
        let config = mcp_stdio_config_from_metadata(metadata)?;
        let transport =
            McpStdioTransport::spawn(config).map_err(|e| format!("MCP start failed: {e}"))?;
        Ok(McpAnyTransport::Stdio(transport))
    }
}

pub(crate) fn mcp_http_config_from_connection<S: SecretStore>(
    connection: &CapabilityConnectionConfig,
    secrets: &S,
) -> Result<mcp_http::McpHttpConfig, String> {
    let url = connection
        .metadata
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| "MCP http metadata without `url`".to_string())?
        .to_string();
    let headers = if connection.secret_ref.starts_with("secret://") {
        let reference = connection
            .secret_ref
            .parse::<SecretRef>()
            .map_err(|_| "MCP credential reference is invalid".to_string())?;
        let material = secrets
            .get(&reference)
            .map_err(|_| "MCP credential could not be read".to_string())?
            .ok_or_else(|| "MCP credential not found".to_string())?;
        let mut headers = mcp_http_headers_from_secret(material)?
            .into_iter()
            .collect::<Vec<_>>();
        headers.sort_by(|left, right| left.0.cmp(&right.0));
        headers
    } else {
        Vec::new()
    };
    Ok(mcp_http::McpHttpConfig { url, headers })
}

/// Slugifies a user-supplied MCP server name into a stable provider id segment:
/// lowercase, ASCII alphanumerics and dashes only, collapsed, never empty.
pub(crate) fn mcp_provider_slug(name: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in name.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    let trimmed = slug.trim_end_matches('-');
    if trimmed.is_empty() {
        "server".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Spawns the MCP server, performs the `initialize` handshake, enumerates its
/// tools, and caches them so the Brain can plan with them.
pub(crate) fn mcp_discover_and_cache_tools(
    state: &AppState,
    provider_id: &CapabilityProviderId,
    connection: &CapabilityConnectionConfig,
) -> Result<usize, String> {
    let transport = build_mcp_transport(state, connection)?;
    let provider = McpCapabilityProvider::new(provider_id.clone(), true, transport, Vec::new());
    provider
        .initialize("2024-11-05")
        .map_err(|error| format!("MCP handshake failed: {error}"))?;
    let tools = provider
        .list_tools()
        .map_err(|error| format!("tools/list failed: {error}"))?;
    let count = tools.len();
    let registry = lock_capability_registry(state).map_err(|error| error.message.to_string())?;
    for tool in tools {
        registry
            .upsert_cached_tool(&CachedCapabilityTool::new(
                provider_id.clone(),
                tool.name,
                CapabilityProviderKind::Mcp,
                tool.action,
                tool.description,
                tool.privacy_domains,
                tool.sensitivity,
                tool.input_schema,
            ))
            .map_err(|error| format!("cache tool fallita: {error}"))?;
    }
    Ok(count)
}

/// Executes a single MCP tool - shared by the chat dispatch and the confirm-card
/// endpoint, so there is ONE connect<->execute path.
pub(crate) fn run_mcp_chat_tool(
    state: &AppState,
    provider_id: &CapabilityProviderId,
    tool_name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();
    let (connection, tool_policies, policy_context) = {
        let registry = lock_capability_registry(state).map_err(|e| e.message)?;
        let connection = registry
            .connection_configs(&user, &workspace)
            .map_err(|e| format!("connection configs: {e}"))?
            .into_iter()
            .find(|config| &config.provider_id == provider_id)
            .ok_or_else(|| format!("no connection for provider {}", provider_id.as_str()))?;
        let tool_policies = registry
            .cached_tools(provider_id)
            .map_err(|e| format!("cached tools: {e}"))?
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
            .map_err(|e| format!("policy context: {e}"))?;
        (connection, tool_policies, policy_context)
    };
    let transport = build_mcp_transport(state, &connection)?;
    let provider = McpCapabilityProvider::new(provider_id.clone(), true, transport, tool_policies);
    provider
        .initialize("2024-11-05")
        .map_err(|error| format!("handshake MCP: {error}"))?;
    let mut facade = CapabilityFacade::new(CapabilityPolicy, InMemoryCapabilityAudit::default());
    facade.register_provider(provider);
    let call = CapabilityCall {
        provider_id: provider_id.clone(),
        tool_name: tool_name.to_string(),
        arguments,
    };
    facade
        .call_tool(&policy_context, call)
        .map(|result| result.output)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use local_first_capabilities::McpStdioConfig;

    #[test]
    fn stdio_metadata_round_trips_env_args_and_command() {
        let config = McpStdioConfig {
            command: "node".to_string(),
            args: vec!["server.js".to_string(), "--stdio".to_string()],
            env: vec![
                ("B_TOKEN".to_string(), "secret".to_string()),
                ("A_MODE".to_string(), "test".to_string()),
            ],
        };

        let metadata = mcp_stdio_config_to_metadata(&config);
        let restored = mcp_stdio_config_from_metadata(&metadata).expect("metadata parses");

        assert_eq!(restored.command, config.command);
        assert_eq!(restored.args, config.args);
        let mut restored_env = restored.env;
        let mut original_env = config.env;
        restored_env.sort();
        original_env.sort();
        assert_eq!(restored_env, original_env);
    }

    #[test]
    fn http_headers_reject_blank_names_and_values() {
        let invalid_name = HashMap::from([(" ".to_string(), "token".to_string())]);
        let invalid_value = HashMap::from([("Authorization".to_string(), " ".to_string())]);

        assert!(mcp_http_headers_to_secret(&invalid_name).is_err());
        assert!(mcp_http_headers_to_secret(&invalid_value).is_err());
    }

    #[test]
    fn provider_slug_is_ascii_stable_and_never_empty() {
        assert_eq!(mcp_provider_slug("GitHub MCP"), "github-mcp");
        assert_eq!(mcp_provider_slug("  Filesystem!! "), "filesystem");
        assert_eq!(mcp_provider_slug("a/b\\c"), "a-b-c");
        assert_eq!(mcp_provider_slug("***"), "server");
    }
}
