//! Client for the OFFICIAL MCP Registry (registry.modelcontextprotocol.io).
//!
//! Fetches `server.json` listings and normalizes each into an install-ready
//! preset: a stdio launch command (`npx`/`uvx`/`docker`) plus the PARAMETERS the
//! user must supply (paths, API keys/secrets — declared by the server). The
//! registry attests PROVENANCE (publisher namespaces are ownership-verified at
//! publish time), NOT code safety: callers must still surface the publisher and
//! the exact command, and require explicit confirmation before launching.

use serde::{Deserialize, Serialize};

const REGISTRY_BASE: &str = "https://registry.modelcontextprotocol.io";

/// One parameter the user must provide to launch a server (an env var or an arg).
#[derive(Debug, Clone, Serialize)]
pub struct McpRegistryInput {
    /// Env var name, or a stable key for an argument.
    pub key: String,
    /// "env" → injected as an environment variable; "arg" → appended to args.
    pub target: String,
    pub label: String,
    pub secret: bool,
    pub required: bool,
    pub default: Option<String>,
}

/// A registry server normalized for one-click connect.
#[derive(Debug, Clone, Serialize)]
pub struct McpRegistryServer {
    /// Full namespaced name, e.g. `io.modelcontextprotocol/filesystem`.
    pub id: String,
    pub name: String,
    /// Publisher namespace (ownership-verified by the registry), e.g. `com.microsoft`.
    pub publisher: String,
    pub description: String,
    /// Reference server published under the canonical MCP namespace.
    pub official: bool,
    pub version: String,
    /// "stdio" (local process) | "http" (remote streamable-HTTP endpoint).
    pub transport: String,
    /// Remote endpoint URL — only for `transport == "http"`.
    pub url: Option<String>,
    /// "node" | "python" | "docker" | "remote" | "other".
    pub runtime: String,
    /// Launch command + base args (stdio only; placeholders for `arg` inputs appended at connect).
    pub command: String,
    pub args: Vec<String>,
    pub inputs: Vec<McpRegistryInput>,
    /// True when we can launch it over stdio with the current transport.
    pub installable: bool,
    /// Why it isn't installable (remote-only, etc.).
    pub note: Option<String>,
    pub homepage: Option<String>,
}

// ---- Raw registry response (camelCase, lenient) ----------------------------

#[derive(Debug, Deserialize)]
struct RawList {
    #[serde(default)]
    servers: Vec<RawEntry>,
}

#[derive(Debug, Deserialize)]
struct RawEntry {
    server: RawServer,
    #[serde(default, rename = "_meta")]
    meta: RawMeta,
}

impl RawEntry {
    /// Keep only the current version of each server (the registry returns one row
    /// per published version). Absent flag → keep (lenient).
    fn is_latest(&self) -> bool {
        self.meta.official.as_ref().and_then(|o| o.is_latest) != Some(false)
    }
}

#[derive(Debug, Default, Deserialize)]
struct RawMeta {
    #[serde(default, rename = "io.modelcontextprotocol.registry/official")]
    official: Option<RawOfficial>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawOfficial {
    #[serde(default)]
    is_latest: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawServer {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    website_url: Option<String>,
    #[serde(default)]
    packages: Vec<RawPackage>,
    #[serde(default)]
    remotes: Vec<RawRemote>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRemote {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    headers: Vec<RawHeader>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawHeader {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    is_required: bool,
    #[serde(default)]
    is_secret: bool,
    #[serde(default)]
    default: Option<String>,
    /// Fixed value (goes straight into the header, not a user input).
    #[serde(default)]
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPackage {
    #[serde(default)]
    registry_type: String,
    #[serde(default)]
    identifier: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    runtime_hint: Option<String>,
    #[serde(default)]
    transport: Option<RawTransport>,
    #[serde(default)]
    runtime_arguments: Vec<RawArg>,
    #[serde(default)]
    package_arguments: Vec<RawArg>,
    #[serde(default)]
    environment_variables: Vec<RawEnv>,
}

#[derive(Debug, Deserialize)]
struct RawTransport {
    #[serde(default, rename = "type")]
    kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawArg {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    value_hint: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    is_required: bool,
    #[serde(default)]
    default: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEnv {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    is_required: bool,
    #[serde(default)]
    is_secret: bool,
    #[serde(default)]
    default: Option<String>,
}

/// Maps an npm/pypi/oci package to (runtime, command). `None` for unknown types.
fn runtime_command(pkg: &RawPackage) -> Option<(&'static str, String)> {
    match pkg.registry_type.as_str() {
        "npm" => Some(("node", pkg.runtime_hint.clone().unwrap_or_else(|| "npx".to_string()))),
        "pypi" => Some(("python", pkg.runtime_hint.clone().unwrap_or_else(|| "uvx".to_string()))),
        "oci" => Some(("docker", "docker".to_string())),
        _ => None,
    }
}

/// Whether a package speaks stdio (explicit transport, or inferred for npm/pypi/oci).
fn is_stdio(pkg: &RawPackage) -> bool {
    match &pkg.transport {
        Some(t) => t.kind.eq_ignore_ascii_case("stdio"),
        None => matches!(pkg.registry_type.as_str(), "npm" | "pypi" | "oci"),
    }
}

fn normalize(entry: RawEntry) -> Option<McpRegistryServer> {
    let server = entry.server;
    let publisher = server.name.split('/').next().unwrap_or("").to_string();
    let display = server
        .title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| server.name.rsplit('/').next().unwrap_or(&server.name).to_string());
    let official = server.name.starts_with("io.modelcontextprotocol/");
    let version = server.version.clone().unwrap_or_default();

    let mut base = McpRegistryServer {
        id: server.name.clone(),
        name: display,
        publisher,
        description: server.description.chars().take(400).collect(),
        official,
        version: version.clone(),
        transport: "stdio".to_string(),
        url: None,
        runtime: "other".to_string(),
        command: String::new(),
        args: Vec::new(),
        inputs: Vec::new(),
        installable: false,
        note: None,
        homepage: server.website_url.clone(),
    };

    let pkg = server
        .packages
        .iter()
        .find(|p| is_stdio(p) && runtime_command(p).is_some());
    let Some(pkg) = pkg else {
        // No local stdio package — connect over a remote (streamable-HTTP) endpoint
        // if one exists. Auth headers become user inputs (target "header").
        let remote = server
            .remotes
            .iter()
            .find(|r| matches!(r.kind.as_str(), "streamable-http" | "http" | "sse") && !r.url.trim().is_empty());
        if let Some(remote) = remote {
            base.transport = "http".to_string();
            base.url = Some(remote.url.clone());
            base.runtime = "remote".to_string();
            base.command = remote.url.clone();
            for header in &remote.headers {
                if header.value.is_some() {
                    continue; // fixed header value, not something the user supplies
                }
                base.inputs.push(McpRegistryInput {
                    label: header.description.clone().unwrap_or_else(|| header.name.clone()),
                    key: header.name.clone(),
                    target: "header".to_string(),
                    secret: header.is_secret,
                    required: header.is_required,
                    default: header.default.clone(),
                });
            }
            base.installable = true;
        } else {
            base.note = Some("Nessun pacchetto stdio né endpoint remoto utilizzabile.".to_string());
        }
        return Some(base);
    };

    let (runtime, command) = runtime_command(pkg)?;
    base.runtime = runtime.to_string();
    base.command = command;

    let mut args: Vec<String> = Vec::new();
    let mut inputs: Vec<McpRegistryInput> = Vec::new();

    // 1) Runtime args (e.g. `-y` for npx) — always fixed values.
    for a in &pkg.runtime_arguments {
        if let Some(v) = &a.value {
            args.push(v.clone());
        }
    }

    // 2) The package/image reference itself.
    let pkg_ref = match (runtime, pkg.version.as_deref().filter(|v| !v.is_empty())) {
        // npm: pin the version from the registry for reproducibility.
        ("node", Some(v)) => format!("{}@{}", pkg.identifier, v),
        _ => pkg.identifier.clone(),
    };
    if runtime == "docker" {
        // `docker run -i --rm [-e NAME ...] <image>` — `-i` keeps stdin open for
        // stdio; `-e NAME` (no value) makes the container inherit NAME from the
        // process env we set at connect time.
        args.push("run".into());
        args.push("-i".into());
        args.push("--rm".into());
        for env in &pkg.environment_variables {
            args.push("-e".into());
            args.push(env.name.clone());
        }
        args.push(pkg_ref);
    } else {
        args.push(pkg_ref);
    }

    // 3) Package arguments: fixed values go into args; user-provided ones become
    //    `arg` inputs (appended to args at connect, in declared order).
    for a in &pkg.package_arguments {
        if let Some(v) = &a.value {
            args.push(v.clone());
        } else {
            let key = a
                .name
                .clone()
                .or_else(|| a.value_hint.clone())
                .unwrap_or_else(|| "arg".to_string());
            inputs.push(McpRegistryInput {
                label: a.description.clone().unwrap_or_else(|| key.clone()),
                key,
                target: "arg".to_string(),
                secret: false,
                required: a.is_required,
                default: a.default.clone(),
            });
        }
    }

    // 4) Environment variables → inputs (this is where API keys/secrets live).
    for env in &pkg.environment_variables {
        inputs.push(McpRegistryInput {
            label: env.description.clone().unwrap_or_else(|| env.name.clone()),
            key: env.name.clone(),
            target: "env".to_string(),
            secret: env.is_secret,
            required: env.is_required,
            default: env.default.clone(),
        });
    }

    base.args = args;
    base.inputs = inputs;
    base.installable = true;
    Some(base)
}

/// Fetches + normalizes registry servers, sorted official/installable-first.
/// `search` is a case-insensitive substring over name/description (registry-side).
pub async fn fetch_servers(
    http: &reqwest::Client,
    search: Option<&str>,
    limit: u32,
) -> Result<Vec<McpRegistryServer>, String> {
    let mut req = http
        .get(format!("{REGISTRY_BASE}/v0/servers"))
        .header(reqwest::header::USER_AGENT, "local-first-personal-assistant")
        .query(&[("limit", limit.clamp(1, 100).to_string())]);
    if let Some(q) = search.map(str::trim).filter(|s| !s.is_empty()) {
        req = req.query(&[("search", q)]);
    }
    let resp = req.send().await.map_err(|e| format!("registry non raggiungibile: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("registry HTTP {}", resp.status()));
    }
    let body: RawList = resp.json().await.map_err(|e| format!("parse registry: {e}"))?;
    let mut out: Vec<McpRegistryServer> = body
        .servers
        .into_iter()
        .filter(RawEntry::is_latest)
        .filter_map(normalize)
        .collect();
    out.sort_by(|a, b| {
        b.official
            .cmp(&a.official)
            .then(b.installable.cmp(&a.installable))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    // Safety net: one row per server id (keep the first after sorting).
    let mut seen = std::collections::HashSet::new();
    out.retain(|s| seen.insert(s.id.clone()));
    Ok(out)
}
