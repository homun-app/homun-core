//! MCP connection/catalog route owner.
//!
//! Owns HTTP-facing connect, connected-list, disconnect and registry-search
//! contracts. The execution endpoint stays separate because it depends on
//! confirmation, timeout and terminal-message rewrite owners.

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use local_first_capabilities::{
    ActionClass, CapabilityConnectionConfig, CapabilityProviderConfig, CapabilityProviderGrant,
    CapabilityProviderKind, McpStdioConfig, ProviderId as CapabilityProviderId,
};
use local_first_secrets::{SecretMaterial, SecretRef, SecretStore};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::{
    AppState, GatewayError, gateway_capability_user_id, gateway_capability_workspace_id,
    lock_capability_registry, mcp_discover_and_cache_tools, mcp_http_config_to_metadata,
    mcp_http_headers_to_secret, mcp_provider_slug, mcp_registry, mcp_stdio_config_to_metadata,
};

#[derive(Debug, Deserialize)]
pub(crate) struct ConnectMcpRequest {
    pub(crate) name: String,
    /// Local stdio command. Empty when connecting a remote server (see `url`).
    #[serde(default)]
    pub(crate) command: String,
    #[serde(default)]
    pub(crate) args: Vec<String>,
    #[serde(default)]
    pub(crate) env: HashMap<String, String>,
    /// Remote (streamable-HTTP) endpoint. When set, connects over HTTP not stdio.
    #[serde(default)]
    pub(crate) url: Option<String>,
    /// Extra request headers (auth) for the remote endpoint.
    #[serde(default)]
    pub(crate) headers: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ConnectMcpResponse {
    pub(crate) provider_id: String,
    pub(crate) connection_id: String,
    pub(crate) tools_cached: usize,
    /// `Some` when the server was registered but tool discovery (spawn +
    /// initialize + tools/list) failed — surfaced, never swallowed, so the UI can
    /// say "registered, but couldn't reach the server" instead of faking success.
    pub(crate) discovery_error: Option<String>,
}

fn normalized_connect_target(
    request: &ConnectMcpRequest,
) -> Result<(String, String, Option<String>), GatewayError> {
    let name = request.name.trim().to_string();
    let command = request.command.trim().to_string();
    let url = request
        .url
        .as_ref()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    if name.is_empty() || (url.is_none() && command.is_empty()) {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "mcp_connect_invalid",
            message: "MCP connect requires a name and a command (stdio) or a url (remote)."
                .to_string(),
        });
    }
    Ok((name, command, url))
}

/// Registers a local stdio MCP server as a capability provider (per ADR 0009 it
/// is filesystem-confined to the workspace at execution time). The connection
/// metadata is written via [`mcp_stdio_config_to_metadata`] so the already-wired
/// executor reads back the identical stdio config. Tool discovery is
/// best-effort: we try to spawn + initialize + list so the Brain can plan with
/// the server's tools, but a server that can't start here still registers (with
/// `discovery_error` set) rather than failing the whole connect.
pub(crate) fn connect_mcp_blocking(
    state: &AppState,
    request: ConnectMcpRequest,
) -> Result<ConnectMcpResponse, GatewayError> {
    let (name, command, url) = normalized_connect_target(&request)?;

    let slug = mcp_provider_slug(&name);
    let provider_id = CapabilityProviderId::new(format!("mcp:{slug}"));
    let connection_id = format!("mcp-{slug}");
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();
    let previous_connection_secret_ref = lock_capability_registry(state)?
        .connection_configs(&user, &workspace)
        .map_err(GatewayError::capability)?
        .into_iter()
        .find(|connection| connection.connection_id == connection_id)
        .and_then(|connection| {
            connection
                .secret_ref
                .starts_with("secret://")
                .then(|| connection.secret_ref.parse::<SecretRef>().ok())
                .flatten()
        });
    let mut stored_secret_ref: Option<SecretRef> = None;
    let mut previous_secret: Option<SecretMaterial> = None;
    // Remote (http) when a url is given, else local stdio.
    let (metadata, secret_label) = match &url {
        Some(url) => {
            let secret_label = if request.headers.is_empty() {
                format!("http:{slug}")
            } else {
                let secret_ref = SecretRef::new(
                    user.as_str(),
                    workspace.as_str(),
                    provider_id.as_str(),
                    connection_id.as_str(),
                )
                .map_err(|error| GatewayError {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    code: "mcp_secret_ref_invalid",
                    message: error.to_string(),
                })?;
                let material = mcp_http_headers_to_secret(&request.headers).map_err(|message| {
                    GatewayError {
                        status: StatusCode::BAD_REQUEST,
                        code: "mcp_headers_invalid",
                        message,
                    }
                })?;
                previous_secret =
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
                stored_secret_ref = Some(secret_ref.clone());
                secret_ref.as_str().to_string()
            };
            (mcp_http_config_to_metadata(url), secret_label)
        }
        None => {
            let config = McpStdioConfig {
                command,
                args: request.args,
                env: request.env.into_iter().collect(),
            };
            (
                mcp_stdio_config_to_metadata(&config),
                format!("stdio:{slug}"),
            )
        }
    };

    let connection_config = CapabilityConnectionConfig::new(
        connection_id.as_str(),
        provider_id.clone(),
        user.clone(),
        workspace.clone(),
        name.clone(),
        secret_label,
    )
    .with_privacy_domains(vec!["local".to_string()])
    .with_metadata(metadata);

    let persist_result = (|| -> Result<(), GatewayError> {
        let registry = lock_capability_registry(state)?;
        registry
            .upsert_provider_config(&CapabilityProviderConfig::new(
                provider_id.clone(),
                CapabilityProviderKind::Mcp,
                name.clone(),
                true,
            ))
            .map_err(GatewayError::capability)?;
        registry
            .upsert_provider_grant(
                &CapabilityProviderGrant::new(provider_id.clone(), user.clone(), workspace.clone())
                    .with_privacy_domains(vec!["local".to_string()])
                    .with_allowed_actions(vec![
                        ActionClass::Read,
                        ActionClass::WriteWithConfirmation,
                    ])
                    .with_max_autonomy_level(3),
            )
            .map_err(GatewayError::capability)?;
        registry
            .upsert_connection_config(&connection_config)
            .map_err(GatewayError::capability)?;
        Ok(())
    })();
    if let Err(error) = persist_result {
        if let Some(secret_ref) = stored_secret_ref.as_ref() {
            if let Some(material) = previous_secret {
                let _ = state.secret_store.put(secret_ref.clone(), material);
            } else {
                let _ = state.secret_store.delete(secret_ref);
            }
        }
        return Err(error);
    }
    if let Some(previous_ref) = previous_connection_secret_ref.filter(|previous_ref| {
        stored_secret_ref.as_ref().map(SecretRef::as_str) != Some(previous_ref.as_str())
    }) {
        state
            .secret_store
            .delete(&previous_ref)
            .map_err(|error| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "mcp_secret_delete_failed",
                message: error.to_string(),
            })?;
    }

    // Best-effort discovery: connect (spawn/HTTP), MCP-initialize, list tools,
    // cache them. Any failure is reported (not swallowed) and leaves the registration.
    let (tools_cached, discovery_error) =
        match mcp_discover_and_cache_tools(state, &provider_id, &connection_config) {
            Ok(count) => (count, None),
            Err(message) => (0, Some(message)),
        };

    Ok(ConnectMcpResponse {
        provider_id: provider_id.as_str().to_string(),
        connection_id,
        tools_cached,
        discovery_error,
    })
}

pub(crate) async fn connect_mcp(
    State(state): State<AppState>,
    Json(request): Json<ConnectMcpRequest>,
) -> Result<Json<ConnectMcpResponse>, GatewayError> {
    tokio::task::spawn_blocking(move || connect_mcp_blocking(&state, request))
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "mcp_connect_join",
            message: error.to_string(),
        })?
        .map(Json)
}

#[derive(Debug, Deserialize)]
pub(crate) struct McpRegistryQuery {
    #[serde(default)]
    pub(crate) q: String,
    #[serde(default)]
    pub(crate) limit: Option<u32>,
}

/// Searches the official MCP registry for installable servers (normalized into
/// presets with their required parameters/secrets). Read-only; the actual
/// launch still goes through `/mcp/connect` with user confirmation.
pub(crate) async fn mcp_registry_search(
    State(state): State<AppState>,
    Query(query): Query<McpRegistryQuery>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let search = Some(query.q.trim()).filter(|s| !s.is_empty());
    let limit = query.limit.unwrap_or(30);
    let servers = mcp_registry::fetch_servers(&state.http, search, limit)
        .await
        .map_err(|message| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "mcp_registry_fetch",
            message,
        })?;
    Ok(Json(serde_json::json!({ "servers": servers })))
}

#[derive(Debug, Serialize)]
pub(crate) struct McpConnectedServer {
    pub(crate) provider_id: String,
    pub(crate) name: String,
    pub(crate) tools: usize,
}

pub(crate) fn mcp_connected_list(
    state: &AppState,
) -> Result<Vec<McpConnectedServer>, GatewayError> {
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();
    let registry = lock_capability_registry(state)?;
    let mut out: Vec<McpConnectedServer> = Vec::new();
    let mut seen = HashSet::new();
    for conn in registry
        .connection_configs(&user, &workspace)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "mcp_connected",
            message: e.to_string(),
        })?
    {
        let kind_is_mcp = registry
            .provider_config(&conn.provider_id)
            .ok()
            .flatten()
            .map(|c| c.provider_kind == CapabilityProviderKind::Mcp)
            .unwrap_or(false);
        if !kind_is_mcp || !seen.insert(conn.provider_id.as_str().to_string()) {
            continue;
        }
        let name = registry
            .provider_config(&conn.provider_id)
            .ok()
            .flatten()
            .map(|c| c.display_name)
            .unwrap_or_else(|| conn.provider_id.as_str().to_string());
        let tools = registry
            .cached_tools(&conn.provider_id)
            .map(|t| t.len())
            .unwrap_or(0);
        out.push(McpConnectedServer {
            provider_id: conn.provider_id.as_str().to_string(),
            name,
            tools,
        });
    }
    Ok(out)
}

/// Lists the connected MCP servers (for the catalog's "installed" section).
pub(crate) async fn mcp_connected(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let servers = tokio::task::spawn_blocking(move || mcp_connected_list(&state))
        .await
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "mcp_connected_join",
            message: e.to_string(),
        })??;
    Ok(Json(serde_json::json!({ "servers": servers })))
}

#[derive(Debug, Deserialize)]
pub(crate) struct McpDisconnectRequest {
    pub(crate) provider_id: String,
}

pub(crate) fn mcp_disconnect_blocking(
    state: &AppState,
    provider_id: &str,
) -> Result<usize, GatewayError> {
    let pid = provider_id.trim().to_string();
    if !pid.starts_with("mcp:") {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "mcp_bad_provider",
            message: "Qui si possono disconnettere solo i provider MCP.".to_string(),
        });
    }
    let (removed, secret_ref) = {
        let registry = lock_capability_registry(state)?;
        let provider = CapabilityProviderId::new(pid);
        match registry
            .provider_config(&provider)
            .map_err(|e| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "mcp_disconnect",
                message: e.to_string(),
            })? {
            Some(cfg) if cfg.provider_kind == CapabilityProviderKind::Mcp => {}
            Some(_) => {
                return Err(GatewayError {
                    status: StatusCode::BAD_REQUEST,
                    code: "mcp_not_mcp",
                    message: "The indicated provider is not an MCP server.".to_string(),
                });
            }
            None => return Ok(0),
        }
        let secret_ref = registry
            .connection_configs(
                &gateway_capability_user_id(),
                &gateway_capability_workspace_id(),
            )
            .map_err(|error| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "mcp_disconnect",
                message: error.to_string(),
            })?
            .into_iter()
            .find(|connection| connection.provider_id == provider)
            .and_then(|connection| {
                connection
                    .secret_ref
                    .starts_with("secret://")
                    .then(|| connection.secret_ref.parse::<SecretRef>().ok())
                    .flatten()
            });
        let removed = registry
            .remove_provider(&provider)
            .map_err(|e| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "mcp_disconnect",
                message: e.to_string(),
            })?;
        (removed, secret_ref)
    };
    if let Some(secret_ref) = secret_ref {
        state
            .secret_store
            .delete(&secret_ref)
            .map_err(|error| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "mcp_secret_delete_failed",
                message: error.to_string(),
            })?;
    }
    Ok(removed)
}

/// Disconnects an MCP server: removes its provider config, grant, connection,
/// cached tools and any encrypted HTTP credential. Guarded to MCP providers so
/// it can't remove Composio/browser.
pub(crate) async fn mcp_disconnect(
    State(state): State<AppState>,
    Json(request): Json<McpDisconnectRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let removed =
        tokio::task::spawn_blocking(move || mcp_disconnect_blocking(&state, &request.provider_id))
            .await
            .map_err(|e| GatewayError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "mcp_disconnect_join",
                message: e.to_string(),
            })??;
    Ok(Json(serde_json::json!({ "removed": removed > 0 })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(name: &str, command: &str, url: Option<&str>) -> ConnectMcpRequest {
        ConnectMcpRequest {
            name: name.to_string(),
            command: command.to_string(),
            args: Vec::new(),
            env: HashMap::new(),
            url: url.map(str::to_string),
            headers: HashMap::new(),
        }
    }

    #[test]
    fn gateway_mcp_connections_rejects_missing_transport() {
        let error = normalized_connect_target(&request("Filesystem", " ", None))
            .expect_err("missing command/url rejected");

        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error.code, "mcp_connect_invalid");
    }

    #[test]
    fn gateway_mcp_connections_trims_stdio_and_http_targets() {
        let (name, command, url) =
            normalized_connect_target(&request(" Filesystem ", " npx ", None)).unwrap();
        assert_eq!(name, "Filesystem");
        assert_eq!(command, "npx");
        assert_eq!(url, None);

        let (name, command, url) = normalized_connect_target(&request(
            " Remote ",
            " ignored ",
            Some(" https://example.com/mcp "),
        ))
        .unwrap();
        assert_eq!(name, "Remote");
        assert_eq!(command, "ignored");
        assert_eq!(url.as_deref(), Some("https://example.com/mcp"));
    }
}
