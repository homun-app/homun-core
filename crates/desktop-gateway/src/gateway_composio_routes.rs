//! Composio provider connection, catalog, and route surface.
//!
//! Owns Composio connect/link/catalog/auth/logo routes plus the shared
//! connector catalog helpers consumed by planning, automation, and tool
//! execution. Actual Composio tool execution remains with the tool execution
//! path.

use super::*;

// ---- P4.3 Composio connect -------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct ConnectComposioRequest {
    api_key: String,
    base_url: Option<String>,
    display_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ConnectComposioResponse {
    provider_id: String,
    tools_cached: usize,
}

pub(crate) fn composio_base_url(explicit: Option<String>) -> String {
    explicit
        .filter(|url| !url.trim().is_empty())
        .or_else(|| {
            env::var("HOMUN_COMPOSIO_BASE_URL")
                .ok()
                .filter(|url| !url.is_empty())
        })
        .unwrap_or_else(|| "https://backend.composio.dev/api/v3".to_string())
}

/// Registers a Composio managed provider: stores the API key as an encrypted
/// secret (only the ref lands in the registry), records provider/grant/
/// connection config, then lists the available tools through the live HTTP
/// transport and caches them so the Brain can plan with them. Composio runs in
/// the cloud, so per ADR 0009 it needs no local sandbox; approval gates govern
/// its writes.
pub(crate) fn connect_composio_blocking(
    state: &AppState,
    request: ConnectComposioRequest,
) -> Result<ConnectComposioResponse, GatewayError> {
    let api_key = request.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "composio_api_key_required",
            message: "Composio API key must not be empty".to_string(),
        });
    }
    let base_url = composio_base_url(request.base_url);
    let display_name = request
        .display_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Composio".to_string());
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();
    let provider_id = CapabilityProviderId::new("composio");

    // Verify the key against the v3 API FIRST and count available toolkits (apps),
    // before persisting anything. A bad key must not leave a phantom "active"
    // connection behind. We go transport-direct here (v3 `{items}` shape). We cache
    // TOOLKITS (apps) for the connectors UI, not the 1000s of individual tools;
    // those are fetched per toolkit on demand.
    let transport = GatewayComposioTransport::new(base_url.clone(), api_key.clone());
    let toolkits = transport
        .request("GET", "/toolkits", None)
        .map_err(GatewayError::capability)?;
    let tools_cached = toolkits
        .get("items")
        .and_then(serde_json::Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);

    // Key verified; now persist the secret (only the ref lands in the registry)
    // and the provider/grant/connection config.
    let secret_ref = SecretRef::new(user.as_str(), workspace.as_str(), "composio", "default")
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "secret_ref_invalid",
            message: error.to_string(),
        })?;
    state
        .secret_store
        .put(secret_ref.clone(), SecretMaterial::from_string(api_key))
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "secret_store_failed",
            message: error.to_string(),
        })?;

    {
        let registry = lock_capability_registry(state)?;
        registry
            .upsert_provider_config(&CapabilityProviderConfig::new(
                provider_id.clone(),
                CapabilityProviderKind::Managed,
                display_name.clone(),
                true,
            ))
            .map_err(GatewayError::capability)?;
        registry
            .upsert_provider_grant(
                &CapabilityProviderGrant::new(provider_id.clone(), user.clone(), workspace.clone())
                    .with_allow_managed_cloud(true)
                    .with_privacy_domains(vec!["managed-cloud".to_string()])
                    .with_allowed_actions(vec![
                        ActionClass::Read,
                        ActionClass::WriteWithConfirmation,
                    ])
                    .with_max_autonomy_level(3),
            )
            .map_err(GatewayError::capability)?;
        registry
            .upsert_connection_config(
                &CapabilityConnectionConfig::new(
                    "composio-default",
                    provider_id.clone(),
                    user.clone(),
                    workspace.clone(),
                    display_name.clone(),
                    secret_ref.as_str(),
                )
                .with_privacy_domains(vec!["managed-cloud".to_string()])
                .with_metadata(serde_json::json!({ "base_url": base_url })),
            )
            .map_err(GatewayError::capability)?;
    }

    composio_catalog_invalidate(); // new account means next turn sees its toolkits
    Ok(ConnectComposioResponse {
        provider_id: provider_id.as_str().to_string(),
        tools_cached,
    })
}

#[derive(Debug, Serialize)]
pub(crate) struct ComposioToolkit {
    slug: String,
    name: String,
    managed_oauth: bool,
    no_auth: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    logo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    categories: Vec<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ComposioToolkitsResponse {
    toolkits: Vec<ComposioToolkit>,
    total: u64,
}

/// Builds a live Composio v3 transport from the stored connection: base URL from
/// the connection metadata, API key from the encrypted secret store. Errors if
/// Composio is not connected for the active workspace.
pub(crate) fn composio_transport_for(
    state: &AppState,
) -> Result<GatewayComposioTransport, GatewayError> {
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();
    let connection = {
        let registry = lock_capability_registry(state)?;
        registry
            .connection_configs(&user, &workspace)
            .map_err(GatewayError::capability)?
            .into_iter()
            .find(|config| config.provider_id.as_str() == "composio")
    }
    .ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "composio_not_connected",
        message: "Composio is not connected for this workspace".to_string(),
    })?;
    let base_url = connection
        .metadata
        .get("base_url")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| composio_base_url(None));
    let secret_ref = SecretRef::new(user.as_str(), workspace.as_str(), "composio", "default")
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "secret_ref_invalid",
            message: error.to_string(),
        })?;
    let api_key = state
        .secret_store
        .get(&secret_ref)
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "secret_get_failed",
            message: error.to_string(),
        })?
        .ok_or_else(|| GatewayError {
            status: StatusCode::NOT_FOUND,
            code: "composio_secret_missing",
            message: "Composio API key not found".to_string(),
        })?
        .expose_utf8()
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "secret_decode_failed",
            message: error.to_string(),
        })?;
    Ok(GatewayComposioTransport::new(base_url, api_key))
}

pub(crate) fn composio_toolkits_blocking(
    state: &AppState,
) -> Result<ComposioToolkitsResponse, GatewayError> {
    let transport = composio_transport_for(state)?;
    let response = transport
        .request("GET", "/toolkits", None)
        .map_err(GatewayError::capability)?;
    let items = response
        .get("items")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total = response
        .get("total_items")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(items.len() as u64);
    let toolkits = items
        .iter()
        .filter(|item| {
            !item
                .get("deprecated")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|item| {
            let slug = item
                .get("slug")
                .and_then(serde_json::Value::as_str)?
                .to_string();
            let name = item
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&slug)
                .to_string();
            let managed_oauth = item
                .get("composio_managed_auth_schemes")
                .and_then(serde_json::Value::as_array)
                .map(|schemes| {
                    schemes
                        .iter()
                        .any(|s| s.as_str().is_some_and(|s| s.eq_ignore_ascii_case("OAUTH2")))
                })
                .unwrap_or(false);
            let no_auth = item
                .get("no_auth")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            // Composio v3 exposes display metadata under `meta`: logo URL, a short
            // description, and category tags (objects with a `name`, or bare strings).
            let meta = item.get("meta");
            let logo = meta
                .and_then(|m| m.get("logo"))
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let description = meta
                .and_then(|m| m.get("description"))
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let categories = meta
                .and_then(|m| m.get("categories"))
                .and_then(serde_json::Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|c| {
                            c.as_str()
                                .or_else(|| c.get("name").and_then(serde_json::Value::as_str))
                                .map(str::to_string)
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(ComposioToolkit {
                slug,
                name,
                managed_oauth,
                no_auth,
                logo,
                description,
                categories,
            })
        })
        .collect::<Vec<_>>();
    // Remember slug to logo URL so the logo PROXY has something to resolve against. The renderer never
    // sees these URLs as image sources (its CSP forbids remote images); it asks the gateway by slug.
    if let Ok(mut urls) = composio_logo_urls().lock() {
        for toolkit in &toolkits {
            if let Some(logo) = toolkit.logo.as_deref() {
                urls.insert(toolkit.slug.clone(), logo.to_string());
            }
        }
    }
    Ok(ComposioToolkitsResponse { toolkits, total })
}

#[derive(Debug, Deserialize)]
pub(crate) struct ComposioLinkRequest {
    toolkit_slug: String,
    /// Legacy: when present, run the custom API-key flow instead of managed OAuth.
    #[serde(default)]
    api_key: Option<String>,
    /// Schema-driven path: the chosen auth scheme (OAUTH2 | API_KEY | etc.) from the toolkit's
    /// real auth_config_details. When set, supersedes `api_key`.
    #[serde(default)]
    scheme: Option<String>,
    /// Use Composio's managed credentials for this scheme (no custom client_id/secret).
    #[serde(default)]
    managed: Option<bool>,
    /// Fields for auth_config CREATION (e.g. OAuth client_id/client_secret).
    #[serde(default)]
    credentials: Option<serde_json::Value>,
    /// Fields for connection INITIATION (e.g. an API key value).
    #[serde(default)]
    initiation: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ComposioLinkResponse {
    redirect_url: String,
    connected_account_id: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ComposioConnection {
    id: String,
    toolkit_slug: String,
    status: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ComposioConnectionsResponse {
    connections: Vec<ComposioConnection>,
}

/// The Composio "user" (entity) for connected accounts. We scope it to the
/// active workspace so a project's connected accounts are isolated per project.
pub(crate) fn composio_entity_id() -> String {
    // The Composio platform entity the accounts are linked under: global (base
    // workspace), matching where the connection config lives, so it resolves in any
    // project. (Was the active workspace, causing "non connesso" inside a project.)
    base_workspace_id()
}

/// Composio function tools to expose to the chat model, plus the subset that are
/// writes (need confirmation before running).
#[derive(Debug, Default, Clone)]
pub(crate) struct ComposioChatTools {
    /// OpenAI-style function tool schemas (name = tool slug).
    pub(crate) schemas: Vec<serde_json::Value>,
    /// Slugs classified as write/destructive actions.
    pub(crate) writes: std::collections::BTreeSet<String>,
    /// Toolkits CONNECTED but not ACTIVE (e.g. EXPIRED OAuth): drive a
    /// "reconnect" hint so the agent doesn't claim it has no integration.
    pub(crate) inactive: Vec<String>,
}

/// Read-vs-write classification from the tool slug. Composio puts the verb
/// anywhere in the action (e.g. GMAIL_FETCH_EMAILS but also
/// GOOGLECALENDAR_EVENTS_LIST), so we tokenize and call it read only when a read
/// verb is present AND no write verb is. Conservative: anything ambiguous is a
/// write that must be confirmed.
pub(crate) fn composio_tool_is_read(slug: &str) -> bool {
    const READ_VERBS: &[&str] = &[
        "FETCH", "GET", "LIST", "SEARCH", "READ", "FIND", "RETRIEVE", "VIEW", "DOWNLOAD", "CHECK",
        "COUNT", "QUERY", "LOOKUP", "DESCRIBE", "EXPORT",
    ];
    const WRITE_VERBS: &[&str] = &[
        "SEND",
        "CREATE",
        "DELETE",
        "UPDATE",
        "REMOVE",
        "ADD",
        "INSERT",
        "MODIFY",
        "EDIT",
        "ARCHIVE",
        "MOVE",
        "PATCH",
        "PUT",
        "POST",
        "REPLY",
        "FORWARD",
        "DRAFT",
        "TRASH",
        "MARK",
        "SET",
        "CLEAR",
        "WRITE",
        "UPLOAD",
        "IMPORT",
        "ENABLE",
        "DISABLE",
        "REVOKE",
        "GRANT",
        "CANCEL",
        "DUPLICATE",
        "RENAME",
        "PUBLISH",
    ];
    let upper = slug.to_ascii_uppercase();
    // Drop the toolkit prefix (first token), classify the action tokens.
    let action = upper.split_once('_').map(|x| x.1).unwrap_or(&upper);
    let tokens: Vec<&str> = action.split('_').collect();
    let has_write = tokens.iter().any(|t| WRITE_VERBS.contains(t));
    let has_read = tokens.iter().any(|t| READ_VERBS.contains(t));
    has_read && !has_write
}

/// Does this connector tool touch the user's CALENDAR? Used to enforce the
/// `can_see_calendar` perimeter axis at dispatch. Matches Composio toolkits
/// (GOOGLECALENDAR_*, OUTLOOK_CALENDAR_*, etc.) and any MCP tool whose name carries
/// "calendar". Heuristic by design: builtins are matched by exact name earlier,
/// so only connector tools ever reach this classifier.
pub(crate) fn tool_touches_calendar(name: &str) -> bool {
    name.to_ascii_uppercase().contains("CALENDAR")
}

/// Does this connector tool touch the user's ADDRESS BOOK / contacts? Used to
/// enforce the `can_see_contacts` perimeter axis at dispatch (Google Contacts,
/// the People API, Outlook contacts, etc.).
pub(crate) fn tool_touches_contacts(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.contains("CONTACT") || upper.contains("PEOPLE_API") || upper.contains("GOOGLE_PEOPLE")
}

/// Human-readable tool name from a Composio slug, e.g. GMAIL_SEND_EMAIL to
/// "Send email · Gmail". Used wherever a tool is shown to the user.
pub(crate) fn humanize_composio_tool(slug: &str) -> String {
    let parts: Vec<&str> = slug.split('_').filter(|s| !s.is_empty()).collect();
    let Some((toolkit_raw, action_parts)) = parts.split_first() else {
        return slug.to_string();
    };
    let capitalize = |w: &str| {
        let mut chars = w.chars();
        match chars.next() {
            Some(first) => {
                first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
            }
            None => String::new(),
        }
    };
    let toolkit = capitalize(toolkit_raw);
    if action_parts.is_empty() {
        return toolkit;
    }
    let action = capitalize(
        &action_parts
            .iter()
            .map(|w| w.to_lowercase())
            .collect::<Vec<_>>()
            .join(" "),
    );
    format!("{action} · {toolkit}")
}

/// Connected toolkits for the current entity as `(slug, is_active)`. A toolkit is
/// active if ANY of its connected accounts has status ACTIVE; connected-but-not-
/// active (e.g. EXPIRED OAuth) shows as `false` so the caller can prompt a reconnect.
pub(crate) fn composio_connected_toolkits(
    transport: &GatewayComposioTransport,
) -> Vec<(String, bool)> {
    let resp = transport
        .request(
            "GET",
            &format!("/connected_accounts?user_ids={}", composio_entity_id()),
            None,
        )
        .ok();
    let mut by_slug: std::collections::BTreeMap<String, bool> = std::collections::BTreeMap::new();
    if let Some(items) = resp
        .as_ref()
        .and_then(|r| r.get("items"))
        .and_then(|v| v.as_array())
    {
        for item in items {
            let active = item
                .get("status")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|s| s.eq_ignore_ascii_case("ACTIVE"));
            if let Some(slug) = item
                .get("toolkit")
                .and_then(|t| t.get("slug"))
                .or_else(|| item.get("toolkit_slug"))
                .and_then(serde_json::Value::as_str)
            {
                let entry = by_slug.entry(slug.to_string()).or_insert(false);
                *entry = *entry || active;
            }
        }
    }
    by_slug.into_iter().collect()
}

pub(crate) type ComposioCatalogCache = std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<usize, (std::time::Instant, ComposioChatTools)>>,
>;

pub(crate) fn composio_catalog_cache() -> &'static std::sync::Mutex<
    std::collections::HashMap<usize, (std::time::Instant, ComposioChatTools)>,
> {
    static CELL: ComposioCatalogCache = std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub(crate) fn composio_catalog_ttl() -> std::time::Duration {
    let secs = std::env::var("HOMUN_COMPOSIO_CACHE_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(60);
    std::time::Duration::from_secs(secs)
}

/// Drop the cached connector catalog; call after any change to connected accounts so a
/// freshly connected/disconnected service is reflected on the next turn (no TTL wait).
pub(crate) fn composio_catalog_invalidate() {
    if let Ok(mut cache) = composio_catalog_cache().lock() {
        cache.clear();
    }
}

/// Cached wrapper over `composio_chat_tools`: that call is an N-toolkit `/tools` HTTP fan-out
/// rebuilt every chat turn. Cache per `cap` with a short TTL (HOMUN_COMPOSIO_CACHE_SECS, default
/// 60s); `composio_catalog_invalidate()` clears it on connect/link/disconnect for immediacy.
pub(crate) fn composio_chat_tools_cached(state: &AppState, cap: usize) -> ComposioChatTools {
    let now = std::time::Instant::now();
    if let Ok(cache) = composio_catalog_cache().lock()
        && let Some((stamped, tools)) = cache.get(&cap)
        && now.duration_since(*stamped) < composio_catalog_ttl()
    {
        return tools.clone();
    }
    let fresh = composio_chat_tools(state, cap);
    if let Ok(mut cache) = composio_catalog_cache().lock() {
        cache.insert(cap, (now, fresh.clone()));
    }
    fresh
}

/// Fetches the executable tools (with input schemas) for the connected toolkits
/// and turns them into OpenAI function schemas, capped to avoid prompt bloat.
/// Best-effort: any failure yields an empty set so chat still works.
pub(crate) fn composio_chat_tools(state: &AppState, cap: usize) -> ComposioChatTools {
    let mut out = ComposioChatTools::default();
    let Ok(transport) = composio_transport_for(state) else {
        return out;
    };
    let connected = composio_connected_toolkits(&transport);
    out.inactive = connected
        .iter()
        .filter(|(_, active)| !*active)
        .map(|(slug, _)| slug.clone())
        .collect();
    let slugs: Vec<String> = connected
        .into_iter()
        .filter(|(_, active)| *active)
        .map(|(slug, _)| slug)
        .collect();
    if slugs.is_empty() {
        // No ACTIVE tools, but `out.inactive` still drives the reconnect hint below.
        return out;
    }
    // Composio v3 /tools filters by the SINGULAR `toolkit_slug=` param, one
    // toolkit per request; verified empirically: `toolkits=`/`toolkit_slugs=`
    // are silently ignored (return the whole catalogue). So we query per
    // connected toolkit and merge, capping the total to avoid prompt bloat.
    let per_toolkit = cap.max(1);
    'outer: for slug in &slugs {
        let resp = match transport.request(
            "GET",
            &format!("/tools?toolkit_slug={slug}&limit={per_toolkit}"),
            None,
        ) {
            Ok(resp) => resp,
            Err(_) => continue,
        };
        let items = resp
            .get("items")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        for item in items {
            if out.schemas.len() >= cap {
                break 'outer;
            }
            let Some(tool_slug) = item.get("slug").and_then(serde_json::Value::as_str) else {
                continue;
            };
            if item
                .get("is_deprecated")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            let description = item
                .get("description")
                .or_else(|| item.get("human_description"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .chars()
                .take(300)
                .collect::<String>();
            let parameters = item
                .get("input_parameters")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} }));
            if !composio_tool_is_read(tool_slug) {
                out.writes.insert(tool_slug.to_string());
            }
            out.schemas.push(serde_json::json!({
                "type": "function",
                "function": { "name": tool_slug, "description": description, "parameters": parameters },
            }));
        }
    }
    out
}

/// Result of a capability search: the human-readable text returned to the MODEL
/// as the tool result, plus an optional structured `card` payload that the chat
/// UI renders as clickable connect-cards (install skill / connect MCP / link
/// Composio in-chat, no Settings trip).
pub(crate) struct CapabilitySuggestions {
    /// Text for the model/log (used when no card is shown).
    pub(crate) model_text: String,
    /// `{ need, items: [...] }` for the in-chat card, or None when nothing found.
    pub(crate) card: Option<serde_json::Value>,
}

/// Searches MCP registry + Skill marketplace + Composio toolkits for a need and
/// returns a unified, human-readable suggestion list AND a structured card payload
/// (with everything each in-chat connect button needs to act).
pub(crate) async fn suggest_capabilities(state: &AppState, need: &str) -> CapabilitySuggestions {
    let need = need.trim();
    if need.is_empty() {
        return CapabilitySuggestions {
            model_text: "Specify what you want to do, so I can search for the right connectors."
                .to_string(),
            card: None,
        };
    }
    // MCP registry (async network).
    let mcp = mcp_registry::fetch_servers(&state.http, Some(need), 4)
        .await
        .unwrap_or_default();
    // Refresh the skills catalog if stale, so the search below has data.
    if let Some(path) = skills_catalog_path()
        && !skills_catalog::load_cache(&path).is_some_and(|c| skills_catalog::cache_is_fresh(&c))
    {
        let _ = skills_catalog::refresh_cache(&state.http, &path).await;
    }
    // Skills catalog + Composio toolkits (blocking work off the runtime).
    let need_owned = need.to_string();
    let st = state.clone();
    let (skills, composio): (Vec<skills_catalog::CatalogEntry>, Vec<ComposioToolkit>) =
        tokio::task::spawn_blocking(move || {
            let skills = skills_catalog_path()
                .and_then(|p| skills_catalog::load_cache(&p))
                .map(|cache| skills_catalog::search(&cache, &need_owned, None, 4))
                .unwrap_or_default();
            let terms: Vec<String> = need_owned
                .to_lowercase()
                .split_whitespace()
                .map(str::to_string)
                .collect();
            let composio = composio_toolkits_blocking(&st)
                .map(|resp| {
                    resp.toolkits
                        .into_iter()
                        .filter(|t| {
                            let hay = format!(
                                "{} {} {}",
                                t.slug,
                                t.name,
                                t.description.clone().unwrap_or_default()
                            )
                            .to_lowercase();
                            terms.iter().any(|term| hay.contains(term.as_str()))
                        })
                        .take(5)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (skills, composio)
        })
        .await
        .unwrap_or_default();

    let mut out = format!("Suggested connectors for: \"{need}\"\n");
    // Structured items for the clickable in-chat card (parallel to the text below).
    let mut items: Vec<serde_json::Value> = Vec::new();
    let installable: Vec<_> = mcp.iter().filter(|s| s.installable).take(4).collect();
    if !installable.is_empty() {
        out.push_str("\nMCP SERVERS (Settings → MCP Catalog):\n");
        for s in installable {
            let badge = if s.official { " [official]" } else { "" };
            out.push_str(&format!(
                "- {}{} — {} (publisher: {})\n",
                s.name,
                badge,
                s.description.chars().take(120).collect::<String>(),
                s.publisher
            ));
            // The full normalized server travels with the card so the connect
            // button can call mcpConnect (params/secrets, stdio vs http) directly.
            if let Ok(server) = serde_json::to_value(s) {
                items.push(serde_json::json!({
                    "kind": "mcp",
                    "name": s.name,
                    "description": s.description.chars().take(160).collect::<String>(),
                    "official": s.official,
                    "server": server,
                }));
            }
        }
    }
    if !skills.is_empty() {
        out.push_str("\nSKILLS (Settings → Skills → marketplace):\n");
        for s in &skills {
            out.push_str(&format!(
                "- {} — {}\n",
                s.name,
                s.description.chars().take(120).collect::<String>()
            ));
            items.push(serde_json::json!({
                "kind": "skill",
                "name": s.name,
                "description": s.description.chars().take(160).collect::<String>(),
                "slug": s.slug,
            }));
        }
    }
    if !composio.is_empty() {
        out.push_str("\nCLOUD SERVICES via Composio (Settings → Connectors → Composio):\n");
        for t in &composio {
            out.push_str(&format!("- {} ({})\n", t.name, t.slug));
            items.push(serde_json::json!({
                "kind": "composio",
                "name": t.name,
                "description": t.description.clone().unwrap_or_default().chars().take(160).collect::<String>(),
                "slug": t.slug,
            }));
        }
    }
    if items.is_empty() {
        out.push_str(
            "\nNo connectors found. Try different keywords, or add an MCP server manually.",
        );
        return CapabilitySuggestions {
            model_text: out,
            card: None,
        };
    }
    out.push_str(
        "\nPresent these options to the user, briefly explaining what each one does and how \
to connect it (the paths in parentheses). Do NOT claim you have already connected them.",
    );
    let card = serde_json::json!({ "need": need, "items": items });
    CapabilitySuggestions {
        model_text: out,
        card: Some(card),
    }
}

/// Parse one field-set (`auth_config_creation` or `connected_account_initiation`) of a
/// Composio scheme into UI field descriptors. Handles both snake_case and camelCase keys.
pub(crate) fn parse_composio_fields(
    fields: Option<&serde_json::Value>,
    section: &str,
) -> Vec<serde_json::Value> {
    let Some(sect) = fields.and_then(|f| f.get(section)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (req_key, required) in [("required", true), ("optional", false)] {
        let Some(arr) = sect.get(req_key).and_then(serde_json::Value::as_array) else {
            continue;
        };
        for f in arr {
            let Some(name) = f.get("name").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let label = f
                .get("displayName")
                .or_else(|| f.get("display_name"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or(name)
                .to_string();
            let ftype = f
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("string")
                .to_ascii_lowercase();
            let lname = name.to_ascii_lowercase();
            let secret = ftype.contains("secret")
                || ftype.contains("password")
                || lname.contains("secret")
                || lname.contains("password")
                || lname.ends_with("_key")
                || lname == "api_key";
            out.push(serde_json::json!({
                "name": name,
                "label": label,
                "required": required,
                "secret": secret,
            }));
        }
    }
    out
}

/// GET /api/capabilities/composio/toolkits/{slug}/auth: the REAL auth schemes Composio
/// declares for a toolkit, with the fields the user must provide. Replaces the old guess
/// (everything non-managed as "API key"): now Spotify correctly surfaces OAUTH2 + client_id
/// + client_secret, and any toolkit gets the form Composio actually requires.
pub(crate) async fn composio_toolkit_auth(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let s = slug.clone();
    let detail = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, GatewayError> {
        let transport = composio_transport_for(&state)?;
        transport
            .request("GET", &format!("/toolkits/{s}"), None)
            .map_err(GatewayError::capability)
    })
    .await
    .map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "composio_toolkit_auth_join",
        message: error.to_string(),
    })??;

    let managed: Vec<String> = detail
        .get("composio_managed_auth_schemes")
        .and_then(serde_json::Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_ascii_uppercase()))
                .collect()
        })
        .unwrap_or_default();

    let mut schemes = Vec::new();
    if let Some(details) = detail
        .get("auth_config_details")
        .and_then(serde_json::Value::as_array)
    {
        for d in details {
            let mode = d
                .get("mode")
                .or_else(|| d.get("name"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_ascii_uppercase();
            if mode.is_empty() || mode == "NO_AUTH" {
                continue;
            }
            let fields = d.get("fields");
            schemes.push(serde_json::json!({
                "mode": mode,
                "managed": managed.contains(&mode),
                "creation_fields": parse_composio_fields(fields, "auth_config_creation"),
                "initiation_fields": parse_composio_fields(fields, "connected_account_initiation"),
            }));
        }
    }
    let no_auth = detail
        .get("no_auth")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
        || detail
            .get("auth_config_details")
            .and_then(serde_json::Value::as_array)
            .map(|a| {
                a.iter().any(|d| {
                    d.get("mode")
                        .or_else(|| d.get("name"))
                        .and_then(serde_json::Value::as_str)
                        == Some("NO_AUTH")
                })
            })
            .unwrap_or(false);

    Ok(Json(serde_json::json!({
        "slug": slug,
        "no_auth": no_auth,
        "schemes": schemes,
    })))
}

/// Resolves (reusing, else creating) an auth_config for an EXPLICIT scheme: the
/// schema-driven path. Managed maps to `use_composio_managed_auth`; custom maps to `use_custom_auth`
/// with the chosen `auth_scheme` and the user's creation `credentials` (e.g. OAuth
/// client_id/client_secret). Reuse matches on the scheme so we don't proliferate configs.
pub(crate) fn composio_auth_config_resolve(
    transport: &GatewayComposioTransport,
    toolkit_slug: &str,
    scheme: &str,
    managed: bool,
    credentials: &serde_json::Value,
) -> Result<String, GatewayError> {
    let extract_id = |item: &serde_json::Value| {
        item.get("id")
            .or_else(|| item.get("auth_config").and_then(|ac| ac.get("id")))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let existing = transport
        .request(
            "GET",
            &format!("/auth_configs?toolkit_slug={toolkit_slug}"),
            None,
        )
        .map_err(GatewayError::capability)?;
    let reusable = existing
        .get("items")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                let item_scheme = item
                    .get("auth_scheme")
                    .or_else(|| item.get("authScheme"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_ascii_uppercase();
                let item_managed = item
                    .get("is_composio_managed")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                item_scheme == scheme && item_managed == managed
            })
        })
        .and_then(extract_id);
    if let Some(id) = reusable {
        return Ok(id);
    }
    let auth_config = if managed {
        serde_json::json!({
            "name": format!("{toolkit_slug} (Homun)"),
            "type": "use_composio_managed_auth",
            "authScheme": scheme,
        })
    } else {
        // Composio's create-auth-config validates a `name` and, for OAuth2, a redirect URI in
        // the credentials. Both were missing, causing 400 "Validation error". Default the redirect URI
        // to Composio's own callback when the user didn't supply one.
        let mut creds = credentials.clone();
        if scheme == "OAUTH2"
            && let Some(obj) = creds.as_object_mut()
            && !obj.contains_key("oauth_redirect_uri")
        {
            obj.insert(
                "oauth_redirect_uri".to_string(),
                serde_json::json!("https://backend.composio.dev/api/v3.1/toolkits/auth/callback"),
            );
        }
        serde_json::json!({
            "name": format!("{toolkit_slug} (Homun)"),
            "type": "use_custom_auth",
            "authScheme": scheme,
            "credentials": creds,
        })
    };
    let created = transport
        .request(
            "POST",
            "/auth_configs",
            Some(serde_json::json!({ "toolkit": { "slug": toolkit_slug }, "auth_config": auth_config })),
        )
        .map_err(GatewayError::capability)?;
    created
        .get("auth_config")
        .and_then(|ac| ac.get("id"))
        .or_else(|| created.get("id"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "composio_auth_config_failed",
            message: "Composio auth_config response missing id".to_string(),
        })
}

/// Links a toolkit. Schema-driven path (a `scheme` is given): create/reuse the auth_config for
/// that scheme (custom credentials for OAuth2 client_id/secret, or managed), then initiate.
/// OAuth flows return a `redirect_url`; key/secret flows pass `initiation` in `config.val` and
/// connect immediately. Legacy path (only `api_key`, or nothing) preserved for back-compat.
pub(crate) fn composio_link_blocking(
    state: &AppState,
    toolkit_slug: &str,
    req: ComposioLinkRequest,
) -> Result<ComposioLinkResponse, GatewayError> {
    let transport = composio_transport_for(state)?;

    let (auth_config_id, init_config) = if let Some(scheme) = req
        .scheme
        .as_deref()
        .map(str::to_ascii_uppercase)
        .filter(|s| !s.is_empty())
    {
        // Schema-driven.
        let managed = req.managed.unwrap_or(false);
        let credentials = req
            .credentials
            .clone()
            .unwrap_or_else(|| serde_json::json!({}));
        let id =
            composio_auth_config_resolve(&transport, toolkit_slug, &scheme, managed, &credentials)?;
        let init = req
            .initiation
            .clone()
            .unwrap_or_else(|| serde_json::json!({}));
        let has_init = init.as_object().map(|o| !o.is_empty()).unwrap_or(false);
        let cfg = has_init.then(|| serde_json::json!({ "auth_scheme": scheme, "val": init }));
        (id, cfg)
    } else {
        // Legacy (no explicit scheme): an `api_key` selects custom API_KEY config, else managed OAuth.
        // Expressed via the same resolver as the schema-driven path; one builder to maintain.
        let use_api_key = req.api_key.as_ref().is_some_and(|k| !k.trim().is_empty());
        let (scheme, managed) = if use_api_key {
            ("API_KEY", false)
        } else {
            ("OAUTH2", true)
        };
        let id = composio_auth_config_resolve(
            &transport,
            toolkit_slug,
            scheme,
            managed,
            &serde_json::json!({}),
        )?;
        let cfg = req.api_key.as_ref().filter(|k| !k.trim().is_empty()).map(
            |key| serde_json::json!({ "auth_scheme": "API_KEY", "val": { "api_key": key.trim() } }),
        );
        (id, cfg)
    };

    let mut body = serde_json::json!({
        "auth_config_id": auth_config_id,
        "user_id": composio_entity_id(),
    });
    if let Some(cfg) = init_config {
        body["config"] = cfg;
    }

    let link = transport
        .request("POST", "/connected_accounts/link", Some(body))
        .map_err(GatewayError::capability)?;
    // Managed OAuth returns a redirect_url; API-key connections do not.
    let redirect_url = link
        .get("redirect_url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let connected_account_id = link
        .get("connected_account_id")
        .or_else(|| link.get("id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    composio_catalog_invalidate(); // newly linked toolkit means next turn sees its tools
    Ok(ComposioLinkResponse {
        redirect_url,
        connected_account_id,
    })
}

pub(crate) async fn composio_link(
    State(state): State<AppState>,
    Json(request): Json<ComposioLinkRequest>,
) -> Result<Json<ComposioLinkResponse>, GatewayError> {
    tokio::task::spawn_blocking(move || {
        let slug = request.toolkit_slug.clone();
        composio_link_blocking(&state, &slug, request)
    })
    .await
    .map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "composio_link_join",
        message: error.to_string(),
    })?
    .map(Json)
}

pub(crate) fn composio_connections_blocking(
    state: &AppState,
) -> Result<ComposioConnectionsResponse, GatewayError> {
    let transport = composio_transport_for(state)?;
    let response = transport
        .request(
            "GET",
            &format!("/connected_accounts?user_ids={}", composio_entity_id()),
            None,
        )
        .map_err(GatewayError::capability)?;
    let connections = response
        .get("items")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item
                        .get("id")
                        .and_then(serde_json::Value::as_str)?
                        .to_string();
                    let status = item
                        .get("status")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("UNKNOWN")
                        .to_string();
                    let toolkit_slug = item
                        .get("toolkit")
                        .and_then(|t| t.get("slug"))
                        .or_else(|| item.get("toolkit_slug"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    Some(ComposioConnection {
                        id,
                        toolkit_slug,
                        status,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(ComposioConnectionsResponse { connections })
}

pub(crate) async fn composio_connections(
    State(state): State<AppState>,
) -> Result<Json<ComposioConnectionsResponse>, GatewayError> {
    tokio::task::spawn_blocking(move || composio_connections_blocking(&state))
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "composio_connections_join",
            message: error.to_string(),
        })?
        .map(Json)
}

pub(crate) fn composio_disconnect_blocking(state: &AppState, id: &str) -> Result<(), GatewayError> {
    let transport = composio_transport_for(state)?;
    transport
        .request("DELETE", &format!("/connected_accounts/{id}"), None)
        .map_err(GatewayError::capability)?;
    composio_catalog_invalidate(); // removed account means drop its tools from the catalog
    Ok(())
}

/// Revoke/remove a Composio connected account (e.g. prune an EXPIRED one).
pub(crate) async fn composio_disconnect(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    tokio::task::spawn_blocking(move || composio_disconnect_blocking(&state, &id))
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "composio_disconnect_join",
            message: error.to_string(),
        })??;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn composio_toolkits(
    State(state): State<AppState>,
) -> Result<Json<ComposioToolkitsResponse>, GatewayError> {
    tokio::task::spawn_blocking(move || composio_toolkits_blocking(&state))
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "composio_toolkits_join",
            message: error.to_string(),
        })?
        .map(Json)
}

/// Toolkit slug to the logo URL Composio published for it, learned from the last `composio_toolkits`
/// call. The logo PROXY resolves through this map instead of taking a URL from the caller: an endpoint
/// that fetches whatever URL it is handed is an open proxy (SSRF) sitting inside the user's network.
/// Here the only reachable URLs are the ones Composio itself gave us.
pub(crate) fn composio_logo_urls()
-> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static CELL: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Fetched logo bytes, kept in memory so a re-render of the ~250-card grid doesn't hit the network
/// again (and so the icons keep working offline once seen).
pub(crate) fn composio_logo_cache()
-> &'static std::sync::Mutex<std::collections::HashMap<String, (String, Vec<u8>)>> {
    type LogoCache = std::sync::Mutex<std::collections::HashMap<String, (String, Vec<u8>)>>;
    static CELL: std::sync::OnceLock<LogoCache> = std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// A logo is at most this big; anything larger is not a brand icon and we won't hold it in memory.
pub(crate) const COMPOSIO_LOGO_MAX_BYTES: usize = 512 * 1024;

/// GET /api/capabilities/composio/toolkits/{slug}/logo: serve a toolkit's brand icon THROUGH the
/// gateway.
///
/// Why proxy at all: the renderer's CSP allows no remote image origin, deliberately. The app renders
/// model-generated markdown, so an attacker-controlled image URL would be a ready-made
/// exfiltration channel; widening `img-src` to fix some icons would trade that defence for cosmetics.
/// Proxying keeps the gateway as the single network egress (the local-first posture) and leaves the CSP
/// free of any remote origin.
///
/// Deliberately OUTSIDE the bearer layer, like `/api/ws` and the noVNC assets above it: an `<img>` tag
/// cannot send an Authorization header, and the token has no business in a URL. What it exposes is a
/// public brand logo keyed by a slug: no user data, on a loopback-only listener.
pub(crate) async fn composio_toolkit_logo(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Response, GatewayError> {
    let not_found = || GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "composio_logo_unknown",
        message: format!("no logo known for toolkit {slug}"),
    };

    if let Some((content_type, bytes)) = composio_logo_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&slug).cloned())
    {
        return Ok(composio_logo_response(content_type, bytes));
    }

    let url = composio_logo_urls()
        .lock()
        .ok()
        .and_then(|urls| urls.get(&slug).cloned())
        .ok_or_else(not_found)?;
    // The map is only ever filled from Composio's own payload, but re-assert the scheme: a `file://`
    // or a link-local metadata URL slipping in here would turn the proxy into a local-network reader.
    if !url.starts_with("https://") {
        return Err(not_found());
    }

    let response = state
        .http
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "composio_logo_unreachable",
            message: error.to_string(),
        })?;
    if !response.status().is_success() {
        return Err(not_found());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.starts_with("image/"))
        .unwrap_or("image/png")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "composio_logo_read_failed",
            message: error.to_string(),
        })?
        .to_vec();
    if bytes.is_empty() || bytes.len() > COMPOSIO_LOGO_MAX_BYTES {
        return Err(not_found());
    }

    if let Ok(mut cache) = composio_logo_cache().lock() {
        cache.insert(slug, (content_type.clone(), bytes.clone()));
    }
    Ok(composio_logo_response(content_type, bytes))
}

pub(crate) fn composio_logo_response(content_type: String, bytes: Vec<u8>) -> Response {
    (
        [
            (axum::http::header::CONTENT_TYPE, content_type),
            // Brand logos don't change; let the renderer stop asking.
            (
                axum::http::header::CACHE_CONTROL,
                "public, max-age=86400".to_string(),
            ),
        ],
        bytes,
    )
        .into_response()
}

pub(crate) async fn connect_composio(
    State(state): State<AppState>,
    Json(request): Json<ConnectComposioRequest>,
) -> Result<Json<ConnectComposioResponse>, GatewayError> {
    tokio::task::spawn_blocking(move || connect_composio_blocking(&state, request))
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "composio_connect_join",
            message: error.to_string(),
        })?
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_composio_routes_owner_smoke() {
        assert_eq!(
            composio_base_url(Some("https://example.test".to_string())),
            "https://example.test"
        );

        assert!(composio_tool_is_read("GMAIL_FETCH_EMAILS"));
        assert!(!composio_tool_is_read("GMAIL_SEND_EMAIL"));
        assert!(tool_touches_calendar("GOOGLECALENDAR_EVENTS_LIST"));
        assert!(tool_touches_contacts("GOOGLE_PEOPLE_LIST"));
        assert_eq!(
            humanize_composio_tool("GMAIL_SEND_EMAIL"),
            "Send email · Gmail"
        );

        let fields = serde_json::json!({
            "auth_config_creation": {
                "required": [
                    { "name": "client_id", "displayName": "Client ID", "type": "string" }
                ],
                "optional": [
                    { "name": "client_secret", "display_name": "Client Secret", "type": "secret" }
                ]
            }
        });
        let parsed = parse_composio_fields(Some(&fields), "auth_config_creation");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["name"], "client_id");
        assert_eq!(parsed[0]["required"], true);
        assert_eq!(parsed[1]["secret"], true);
    }
}
