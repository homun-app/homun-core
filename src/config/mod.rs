pub mod dotpath;
mod schema;

pub use schema::*;

// ─── DB Settings Overlay ──────────────────────────────────────

/// Section keys for DB-backed config sections.
/// Only these sections are stored in the `settings` table.
pub const SECTION_SANDBOX: &str = "security.execution_sandbox";
pub const SECTION_EXFILTRATION: &str = "security.exfiltration";
pub const SECTION_PERMISSIONS: &str = "permissions";
pub const SECTION_AGENT: &str = "agent";
pub const SECTION_TELEGRAM: &str = "channels.telegram";
pub const SECTION_WHATSAPP: &str = "channels.whatsapp";
pub const SECTION_DISCORD: &str = "channels.discord";
pub const SECTION_SLACK: &str = "channels.slack";
pub const SECTION_EMAIL: &str = "channels.email";
pub const SECTION_WEB: &str = "channels.web";
pub const SECTION_EXEC: &str = "tools.exec";
pub const SECTION_BROWSER: &str = "browser";
pub const SECTION_MCP: &str = "mcp";
pub const SECTION_PROVIDERS: &str = "providers";
pub const SECTION_STORAGE: &str = "storage";
pub const SECTION_UI: &str = "ui";
pub const SECTION_AGENTS: &str = "agents";
pub const SECTION_ROUTING: &str = "routing";

/// Overlay DB-stored settings on top of the TOML-loaded config.
///
/// Called at startup between `Config::load()` and `Arc::new(RwLock::new(config))`.
/// For each section that exists in the DB, the JSON blob replaces the
/// TOML value. Missing or corrupt DB rows fall back to the TOML default
/// with a warning log — the system never crashes due to a bad DB row.
pub async fn overlay_db_settings(config: &mut Config, db: &crate::storage::Database) {
    let mut applied = Vec::new();

    // Macro to reduce boilerplate: try to deserialize a section from DB JSON.
    macro_rules! overlay_section {
        ($section:expr, $type:ty, $field:expr) => {
            if let Some(json) = load_section(db, $section).await {
                match serde_json::from_str::<$type>(&json) {
                    Ok(val) => {
                        $field = val;
                        applied.push($section);
                    }
                    Err(e) => tracing::warn!(
                        section = $section,
                        error = %e,
                        "DB settings overlay: corrupt JSON, using TOML default"
                    ),
                }
            }
        };
    }

    // Security
    overlay_section!(
        SECTION_SANDBOX,
        ExecutionSandboxConfig,
        config.security.execution_sandbox
    );
    overlay_section!(
        SECTION_EXFILTRATION,
        ExfiltrationConfig,
        config.security.exfiltration
    );
    // Permissions
    overlay_section!(SECTION_PERMISSIONS, PermissionsConfig, config.permissions);
    // Agent
    overlay_section!(SECTION_AGENT, AgentConfig, config.agent);
    // Channels
    overlay_section!(SECTION_TELEGRAM, TelegramConfig, config.channels.telegram);
    overlay_section!(SECTION_WHATSAPP, WhatsAppConfig, config.channels.whatsapp);
    overlay_section!(SECTION_DISCORD, DiscordConfig, config.channels.discord);
    overlay_section!(SECTION_SLACK, SlackConfig, config.channels.slack);
    overlay_section!(SECTION_EMAIL, std::collections::HashMap<String, EmailAccountConfig>, config.channels.emails);
    overlay_section!(SECTION_WEB, WebConfig, config.channels.web);
    // Tools
    overlay_section!(SECTION_EXEC, ExecConfig, config.tools.exec);
    // Browser
    overlay_section!(SECTION_BROWSER, BrowserConfig, config.browser);
    // MCP
    overlay_section!(SECTION_MCP, McpConfig, config.mcp);
    // Providers
    overlay_section!(SECTION_PROVIDERS, ProvidersConfig, config.providers);
    // Storage
    overlay_section!(SECTION_STORAGE, StorageConfig, config.storage);
    // UI
    overlay_section!(SECTION_UI, UiConfig, config.ui);
    // Agents (multi-agent definitions)
    overlay_section!(SECTION_AGENTS, std::collections::HashMap<String, AgentDefinitionConfig>, config.agents);
    // Routing
    overlay_section!(SECTION_ROUTING, RoutingConfig, config.routing);

    if applied.is_empty() {
        tracing::debug!("DB settings overlay: no sections found in DB, using TOML defaults");
    } else {
        tracing::info!(
            sections = ?applied,
            "DB settings overlay applied"
        );
    }
}

/// Persist a config section to the DB from CLI context (no AppState).
///
/// Opens the DB at the resolved storage path, serializes the section,
/// and writes it. Also saves the TOML as backup. Best-effort: errors
/// are printed to stderr but don't halt the CLI command.
pub async fn cli_save_section(config: &Config, section: &str) {
    // TOML backup first (always works, even without DB)
    if let Err(e) = config.save() {
        eprintln!("Warning: TOML backup write failed: {e}");
    }

    let value = match section {
        SECTION_SANDBOX => serde_json::to_string(&config.security.execution_sandbox),
        SECTION_EXFILTRATION => serde_json::to_string(&config.security.exfiltration),
        SECTION_PERMISSIONS => serde_json::to_string(&config.permissions),
        SECTION_AGENT => serde_json::to_string(&config.agent),
        SECTION_TELEGRAM => serde_json::to_string(&config.channels.telegram),
        SECTION_WHATSAPP => serde_json::to_string(&config.channels.whatsapp),
        SECTION_DISCORD => serde_json::to_string(&config.channels.discord),
        SECTION_SLACK => serde_json::to_string(&config.channels.slack),
        SECTION_EMAIL => serde_json::to_string(&config.channels.emails),
        SECTION_WEB => serde_json::to_string(&config.channels.web),
        SECTION_EXEC => serde_json::to_string(&config.tools.exec),
        SECTION_BROWSER => serde_json::to_string(&config.browser),
        SECTION_MCP => serde_json::to_string(&config.mcp),
        SECTION_PROVIDERS => serde_json::to_string(&config.providers),
        SECTION_STORAGE => serde_json::to_string(&config.storage),
        SECTION_UI => serde_json::to_string(&config.ui),
        SECTION_AGENTS => serde_json::to_string(&config.agents),
        SECTION_ROUTING => serde_json::to_string(&config.routing),
        _ => {
            eprintln!("Warning: unknown section '{section}', DB write skipped");
            return;
        }
    };

    let json = match value {
        Ok(j) => j,
        Err(e) => {
            eprintln!("Warning: failed to serialize section '{section}': {e}");
            return;
        }
    };

    match crate::storage::Database::open(&config.storage.resolved_path()).await {
        Ok(db) => {
            if let Err(e) = db.set_settings_section(section, &json).await {
                eprintln!("Warning: failed to write section '{section}' to DB: {e}");
            }
        }
        Err(e) => {
            eprintln!("Warning: could not open DB for section '{section}': {e}");
        }
    }
}

/// Map a dotpath config key to its DB section constant.
///
/// For example, `agent.model` → `SECTION_AGENT`, `channels.telegram.token` → `SECTION_TELEGRAM`.
/// Returns `None` for keys that don't map to a known section.
pub fn section_for_dotpath(key: &str) -> Option<&'static str> {
    // Most specific prefixes first (channels.X, security.X, tools.X)
    let prefixes: &[(&str, &str)] = &[
        ("security.execution_sandbox", SECTION_SANDBOX),
        ("security.exfiltration", SECTION_EXFILTRATION),
        ("channels.telegram", SECTION_TELEGRAM),
        ("channels.whatsapp", SECTION_WHATSAPP),
        ("channels.discord", SECTION_DISCORD),
        ("channels.slack", SECTION_SLACK),
        ("channels.email", SECTION_EMAIL),
        ("channels.web", SECTION_WEB),
        ("tools.exec", SECTION_EXEC),
        ("agent", SECTION_AGENT),
        ("browser", SECTION_BROWSER),
        ("mcp", SECTION_MCP),
        ("providers", SECTION_PROVIDERS),
        ("storage", SECTION_STORAGE),
        ("ui", SECTION_UI),
        ("agents", SECTION_AGENTS),
        ("routing", SECTION_ROUTING),
        ("permissions", SECTION_PERMISSIONS),
    ];

    for (prefix, section) in prefixes {
        if key == *prefix || key.starts_with(&format!("{prefix}.")) {
            return Some(section);
        }
    }
    None
}

/// Helper: fetch a section from DB, swallowing errors gracefully.
async fn load_section(db: &crate::storage::Database, section: &str) -> Option<String> {
    match db.get_settings_section(section).await {
        Ok(val) => val,
        Err(e) => {
            tracing::warn!(section, error = %e, "Failed to read DB settings section");
            None
        }
    }
}
