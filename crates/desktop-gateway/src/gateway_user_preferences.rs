//! User preference, setup, and prompt-locality owner.
//!
//! Owns the persisted `user-prefs.json` contract plus the HTTP routes for
//! timezone, language, onboarding setup status, local Ollama setup, and approval
//! routing. Also owns the timezone-aware `now` helpers consumed by prompt assembly
//! and runtime/browser setup so those contracts do not drift back into `main.rs`.

use super::*;

#[test]
fn user_preferences_owner_smoke() {
    assert!(is_supported_language("en"));
    assert!(is_supported_language("it"));
    assert_eq!(language_display_name("zz"), "zz");
}

/// Persisted IANA timezone chosen by the user (e.g. "Europe/Rome"). A tiny JSON
/// file like the other prefs; absent → fall back to the host's system timezone.
fn user_timezone_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("user-prefs.json"))
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct UserPrefs {
    /// IANA name (e.g. "Europe/Rome"). None/empty → system timezone.
    #[serde(default)]
    pub(crate) timezone: Option<String>,
    /// ISO-639-1 language code (e.g. "en", "it"). None/empty → "en" default.
    /// Drives the fallback language for prompts when the latest user message is
    /// ambiguous or language-neutral.
    #[serde(default)]
    pub(crate) language: Option<String>,
    /// Whether the onboarding wizard has been completed. False/absent → show wizard
    /// on next launch when no provider is configured.
    #[serde(default)]
    pub(crate) setup_complete: Option<bool>,
    /// Where confirmation requests are delivered so they can be authorized remotely:
    /// "in_app" (default) | "telegram" | "whatsapp". When a channel, also routes the
    /// approval to `approval_target` (the USER's own number/chat — only it can approve).
    #[serde(default)]
    pub(crate) approval_channel: Option<String>,
    /// The user's own number/chat id on `approval_channel`. SECURITY: only an inbound from
    /// this exact id may authorize a pending approval.
    #[serde(default)]
    pub(crate) approval_target: Option<String>,
}

pub(crate) fn channel_message_is_from_owner(
    prefs: &UserPrefs,
    channel: &str,
    sender: &str,
    chat: Option<&str>,
    sender_pn: Option<&str>,
) -> bool {
    let Some(configured_channel) = prefs.approval_channel.as_deref() else {
        return false;
    };
    if configured_channel != channel {
        return false;
    }
    let Some(target) = prefs
        .approval_target
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    [Some(sender), chat, sender_pn]
        .into_iter()
        .flatten()
        .any(|value| value.trim().eq_ignore_ascii_case(target))
}

/// Languages the assistant can reply in. The first element is the default.
/// Codes are ISO-639-1 (lowercase). The native name is what the UI picker shows.
const SUPPORTED_LANGUAGES: &[(&str, &str)] = &[
    ("en", "English"),
    ("it", "Italiano"),
    ("es", "Español"),
    ("fr", "Français"),
    ("de", "Deutsch"),
];

fn is_supported_language(code: &str) -> bool {
    SUPPORTED_LANGUAGES.iter().any(|(c, _)| *c == code)
}

pub(crate) fn load_user_prefs() -> UserPrefs {
    user_timezone_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn save_user_prefs(prefs: &UserPrefs) -> Result<(), String> {
    let path = user_timezone_path().ok_or_else(|| "data dir unavailable".to_string())?;
    let json = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// The IANA name we resolve "now" against everywhere (prompt injection AND the
/// container, via `HOMUN_TZ`). User preference wins; else the host's system zone;
/// else "UTC" as a last resort so the value is always concrete.
pub(crate) fn effective_user_tz_name() -> String {
    if let Some(name) = load_user_prefs().timezone.filter(|s| !s.trim().is_empty())
        && jiff::tz::TimeZone::get(&name).is_ok()
    {
        return name;
    }
    jiff::tz::TimeZone::system()
        .iana_name()
        .map(|s| s.to_string())
        .unwrap_or_else(|| "UTC".to_string())
}

/// The user's effective timezone as a jiff `TimeZone` (DST-aware, IANA-correct).
fn user_tz() -> jiff::tz::TimeZone {
    let name = effective_user_tz_name();
    jiff::tz::TimeZone::get(&name).unwrap_or_else(|_| jiff::tz::TimeZone::system())
}

/// The preferred fallback language (ISO-639-1). User preference wins, but must be
/// a supported code; else "en" (the app's default language). The runtime still
/// asks the assistant to match the latest user message language when it is clear.
pub(crate) fn effective_user_language() -> String {
    let code = load_user_prefs()
        .language
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    match code {
        Some(c) if is_supported_language(&c) => c,
        _ => "en".to_string(),
    }
}

pub(crate) fn response_language_instruction(fallback_language_code: &str) -> String {
    format!(
        "Reply in the same language as the user's latest message whenever that language is clear. If the latest message is ambiguous or language-neutral, reply in {}.",
        language_display_name(fallback_language_code)
    )
}

/// A human-readable name for a language code (for UI display).
fn language_display_name(code: &str) -> &str {
    SUPPORTED_LANGUAGES
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, name)| *name)
        .unwrap_or(code)
}

/// "Now" in the user's timezone — the single source of truth for date logic.
pub(crate) fn now_local() -> jiff::Zoned {
    jiff::Timestamp::now().to_zoned(user_tz())
}

/// Today's date (ISO `YYYY-MM-DD`) in the USER's timezone — never UTC, so it is
/// correct across the day boundary (the old UTC version returned "yesterday"
/// between local midnight and the UTC offset).
/// Advisory guardrail: if `typed` contains a calendar date (ISO `YYYY-MM-DD` or
/// `DD/MM/YYYY`/`DD-MM-YYYY`) that is strictly before today (user tz), return a
/// hint nudging the model to re-resolve via resolve_datetime. Returns None when
/// no date is found or it's today/future — so legitimate past dates aren't blocked,
/// only flagged.
pub(crate) fn past_date_hint(typed: &str) -> Option<String> {
    let today = now_local().date();
    // Scan whitespace/comma-separated tokens for a date-like substring.
    for raw in typed.split(|c: char| c.is_whitespace() || c == ',' || c == ';') {
        let tok = raw.trim();
        if tok.len() < 8 {
            continue;
        }
        let parsed: Option<jiff::civil::Date> = if tok.contains('-')
            && tok.starts_with(|c: char| c.is_ascii_digit())
            && tok.split('-').next().map(|y| y.len() == 4).unwrap_or(false)
        {
            tok.parse().ok() // ISO YYYY-MM-DD
        } else {
            // DD/MM/YYYY or DD-MM-YYYY (European order — the app's locale).
            let parts: Vec<&str> = tok.split(['/', '-']).collect();
            if parts.len() == 3 {
                match (
                    parts[0].parse::<i8>(),
                    parts[1].parse::<i8>(),
                    parts[2].parse::<i16>(),
                ) {
                    (Ok(d), Ok(m), Ok(y)) if y >= 1000 => jiff::civil::Date::new(y, m, d).ok(),
                    _ => None,
                }
            } else {
                None
            }
        };
        if let Some(d) = parsed
            && d < today
        {
            return Some(format!(
                "\n[⚠️ warning: «{tok}» looks like a PAST date (today is {today}). If you meant \
a future date, do NOT submit: call resolve_datetime to get the right date and re-enter it.]"
            ));
        }
    }
    None
}

#[derive(Debug, Serialize)]
pub(crate) struct TimezoneView {
    /// User's explicit choice (None → following the system zone).
    selected: Option<String>,
    /// The zone actually in effect (choice or detected system zone).
    effective: String,
    /// Live "now" line in the effective zone, so the UI can show what the model sees.
    now: String,
}

pub(crate) async fn get_user_timezone() -> Json<TimezoneView> {
    Json(TimezoneView {
        selected: load_user_prefs().timezone.filter(|s| !s.trim().is_empty()),
        effective: effective_user_tz_name(),
        now: now_block(),
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetTimezoneRequest {
    /// IANA name (e.g. "Europe/Rome"); empty/null → follow the system zone.
    timezone: Option<String>,
}

pub(crate) async fn set_user_timezone(
    Json(request): Json<SetTimezoneRequest>,
) -> Result<Json<TimezoneView>, GatewayError> {
    let trimmed = request
        .timezone
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    // Validate the IANA name before persisting: a bad zone would silently fall
    // back to system and confuse the user.
    if let Some(name) = trimmed
        && jiff::tz::TimeZone::get(name).is_err()
    {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_timezone",
            message: format!("Invalid IANA timezone: «{name}»"),
        });
    }
    // Preserve other prefs (approval routing) — only update the timezone field.
    let mut prefs = load_user_prefs();
    prefs.timezone = trimmed.map(|s| s.to_string());
    save_user_prefs(&prefs).map_err(|message| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "timezone_save",
        message,
    })?;
    // Propagate to the contained computer so its clock (and Chromium's) matches:
    // if it's running, recycle it now so the next use recreates it with the new
    // TZ (Layer D reads effective_user_tz_name() at launch). Best-effort, and we
    // don't spin Docker up just to set a preference.
    let _ = tokio::task::spawn_blocking(|| {
        if sandbox::container_up() {
            sandbox::recycle_container();
        }
    })
    .await;
    Ok(Json(TimezoneView {
        selected: trimmed.map(|s| s.to_string()),
        effective: effective_user_tz_name(),
        now: now_block(),
    }))
}

#[derive(Debug, Serialize)]
pub(crate) struct ApprovalRoutingView {
    /// "in_app" (default) | "telegram" | "whatsapp".
    channel: String,
    /// The user's own number/chat id on that channel (only it can authorize remotely).
    target: Option<String>,
}

/// The language view returned by GET /api/prefs/language and used by the UI picker.
#[derive(Debug, Serialize)]
pub(crate) struct LanguageView {
    /// User's explicit choice (None → following the default "en").
    selected: Option<String>,
    /// The code actually in effect (choice or default).
    effective: String,
    /// Human-readable name for the effective language.
    effective_name: String,
    /// All supported languages (code, native name) for the picker.
    supported: Vec<(String, String)>,
}

pub(crate) async fn get_user_language() -> Json<LanguageView> {
    let effective = effective_user_language();
    Json(LanguageView {
        selected: load_user_prefs().language.filter(|s| !s.trim().is_empty()),
        effective_name: language_display_name(&effective).to_string(),
        effective,
        supported: SUPPORTED_LANGUAGES
            .iter()
            .map(|(c, n)| (c.to_string(), n.to_string()))
            .collect(),
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetLanguageRequest {
    /// ISO-639-1 code (e.g. "en", "it"); empty/null → default "en".
    language: Option<String>,
}

pub(crate) async fn set_user_language(
    Json(request): Json<SetLanguageRequest>,
) -> Result<Json<LanguageView>, GatewayError> {
    let code = request
        .language
        .as_deref()
        .map(str::trim)
        .map(str::to_lowercase)
        .filter(|s| !s.is_empty());
    if let Some(ref c) = code
        && !is_supported_language(c)
    {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_language",
            message: format!("Unsupported language code: «{c}»"),
        });
    }
    let mut prefs = load_user_prefs();
    prefs.language = code;
    save_user_prefs(&prefs).map_err(|message| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "language_save",
        message,
    })?;
    let effective = effective_user_language();
    Ok(Json(LanguageView {
        selected: prefs.language.filter(|s| !s.trim().is_empty()),
        effective_name: language_display_name(&effective).to_string(),
        effective,
        supported: SUPPORTED_LANGUAGES
            .iter()
            .map(|(c, n)| (c.to_string(), n.to_string()))
            .collect(),
    }))
}

// ── Onboarding setup wizard ─────────────────────────────────────────────────

/// The setup status returned by GET /api/setup/status — drives whether the UI
/// shows the onboarding wizard. `needs_setup` = !setup_complete AND no provider.
#[derive(Debug, Serialize)]
pub(crate) struct SetupStatus {
    needs_setup: bool,
    setup_complete: bool,
    docker_installed: bool,
    docker_running: bool,
    has_provider: bool,
    provider_kind: Option<String>,
}

pub(crate) async fn get_setup_status() -> Json<SetupStatus> {
    let prefs = load_user_prefs();
    let setup_complete = prefs.setup_complete.unwrap_or(false);
    let registry = load_provider_registry();
    let has_provider = registry
        .active()
        .or_else(|| registry.providers.first())
        .is_some();
    let provider_kind = registry
        .resolve_role("orchestrator")
        .map(|r| format!("{:?}", r.kind).to_lowercase())
        .or_else(|| {
            registry
                .active()
                .map(|p| format!("{:?}", p.kind).to_lowercase())
        });
    let (docker_installed, docker_running) = tokio::task::spawn_blocking(|| {
        let installed = sandbox::docker_installed();
        let running = installed && sandbox::docker_running();
        (installed, running)
    })
    .await
    .unwrap_or((false, false));
    Json(SetupStatus {
        needs_setup: !setup_complete && !has_provider,
        setup_complete,
        docker_installed,
        docker_running,
        has_provider,
        provider_kind,
    })
}

async fn setup_computer_endpoint_ok(http: &reqwest::Client, url: &str) -> bool {
    http.get(url)
        .timeout(std::time::Duration::from_millis(1_500))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

async fn setup_computer_observed_healthy(http: &reqwest::Client) -> bool {
    if !sandbox::container_up() {
        return false;
    }
    let (browser_ready, live_view_ready) = tokio::join!(
        setup_computer_endpoint_ok(http, "http://127.0.0.1:9222/json/version"),
        setup_computer_endpoint_ok(http, "http://127.0.0.1:6080/vnc.html"),
    );
    browser_ready && live_view_ready
}

async fn verify_setup_computer(http: &reqwest::Client) -> Result<(), String> {
    let mut browser_ready = false;
    let mut live_view_ready = false;
    for _ in 0..60 {
        let (browser, live_view) = tokio::join!(
            setup_computer_endpoint_ok(http, "http://127.0.0.1:9222/json/version"),
            setup_computer_endpoint_ok(http, "http://127.0.0.1:6080/vnc.html"),
        );
        browser_ready |= browser;
        live_view_ready |= live_view;
        if browser_ready && live_view_ready {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    if !browser_ready {
        Err("Homun Computer started, but its browser did not become ready.".to_string())
    } else {
        Err("Homun Computer started, but its live view did not become ready.".to_string())
    }
}

pub(crate) async fn begin_setup_computer(state: AppState) -> setup_computer::SetupComputerStatus {
    let observed_healthy = setup_computer_observed_healthy(&state.http).await;
    if let setup_computer::BeginSetup::Start { generation } =
        state.setup_computer.begin(observed_healthy)
    {
        let coordinator = state.setup_computer.clone();
        let http = state.http.clone();
        tokio::spawn(async move {
            let progress_coordinator = coordinator.clone();
            let bootstrap = tokio::task::spawn_blocking(move || {
                sandbox::ensure_contained_computer_with_progress(|phase| {
                    progress_coordinator
                        .advance(generation, setup_computer::phase_from_sandbox(phase));
                })
            })
            .await;
            match bootstrap {
                Ok(Ok(())) => {
                    coordinator.advance(
                        generation,
                        setup_computer::SetupComputerPhase::VerifyingBrowser,
                    );
                    match verify_setup_computer(&http).await {
                        Ok(()) => coordinator.ready(generation),
                        Err(message) => coordinator.fail(generation, message),
                    }
                }
                Ok(Err(message)) => coordinator.fail(generation, message),
                Err(_) => coordinator.fail(
                    generation,
                    "Homun Computer preparation stopped unexpectedly.",
                ),
            }
        });
    }
    state.setup_computer.status()
}

pub(crate) async fn prepare_setup_computer(
    State(state): State<AppState>,
) -> Json<setup_computer::SetupComputerStatus> {
    Json(begin_setup_computer(state).await)
}

pub(crate) async fn get_setup_computer_status(
    State(state): State<AppState>,
) -> Json<setup_computer::SetupComputerStatus> {
    Json(state.setup_computer.status())
}

/// Request body for POST /api/setup/validate-llm — tests an LLM configuration
/// without saving it. Returns the detected models on success.
#[derive(Debug, Deserialize)]
pub(crate) struct ValidateLlmRequest {
    kind: String,     // "openai_compat" | "anthropic" | "ollama"
    base_url: String, // e.g. "https://api.openai.com/v1" or "http://localhost:11434"
    api_key: Option<String>,
}

/// Validates an LLM provider configuration by making a real API call (GET /models
/// or equivalent). Does NOT save — the wizard saves via the normal provider CRUD
/// after validation succeeds.
pub(crate) async fn validate_llm_config(
    Json(request): Json<ValidateLlmRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "validate_http_client",
            message: e.to_string(),
        })?;
    let (url, mut headers) = match request.kind.as_str() {
        "ollama" => (
            format!("{}/api/tags", request.base_url.trim_end_matches('/')),
            vec![],
        ),
        "anthropic" => (
            format!("{}/v1/models", request.base_url.trim_end_matches('/')),
            vec![(
                "x-api-key".to_string(),
                request.api_key.clone().unwrap_or_default(),
            )],
        ),
        _ => (
            // openai_compat
            format!("{}/models", canonical_provider_base_url(&request.base_url)),
            request
                .api_key
                .as_ref()
                .map(|key| ("Authorization", format!("Bearer {key}")))
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        ),
    };
    // Anthropic also needs the anthropic-version header.
    if request.kind == "anthropic" {
        headers.push(("anthropic-version".to_string(), "2023-06-01".to_string()));
    }
    let mut req = client.get(&url);
    for (key, value) in &headers {
        req = req.header(key, value);
    }
    let response = req.send().await.map_err(|e| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "validate_connection_failed",
        message: format!("Could not reach the provider: {e}"),
    })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let hint = match status.as_u16() {
            401 => " — check your API key.",
            403 => " — the API key does not have permission.",
            404 => " — check the base URL.",
            _ => "",
        };
        return Err(GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "validate_provider_error",
            message: format!(
                "Provider returned {status}{hint}: {}",
                body.chars().take(200).collect::<String>()
            ),
        });
    }
    let body: serde_json::Value = response.json().await.map_err(|e| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "validate_parse_failed",
        message: format!("Could not parse provider response: {e}"),
    })?;
    // Extract model names from the response (format varies by provider).
    let models: Vec<String> = body
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    m.get("id")
                        .or_else(|| m.get("name"))
                        .or_else(|| m.get("model"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(serde_json::json!({
        "valid": true,
        "models": models,
        "models_count": models.len(),
    })))
}

/// POST /api/setup/complete — marks the onboarding wizard as done.
pub(crate) async fn complete_setup() -> Result<Json<serde_json::Value>, GatewayError> {
    let mut prefs = load_user_prefs();
    prefs.setup_complete = Some(true);
    save_user_prefs(&prefs).map_err(|message| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "setup_save",
        message,
    })?;
    Ok(Json(serde_json::json!({ "setup_complete": true })))
}

/// Local Ollama base URL (override via env, else the default loopback port).
fn ollama_base_url() -> String {
    std::env::var("HOMUN_OLLAMA_BASE")
        .or_else(|_| std::env::var("HOMUN_EMBED_BASE"))
        .unwrap_or_else(|_| "http://127.0.0.1:11434".to_string())
}

#[derive(Serialize)]
pub(crate) struct OllamaSetupModel {
    name: String,
    size: u64,
}

#[derive(Serialize)]
pub(crate) struct OllamaSetupStatus {
    running: bool,
    base_url: String,
    models: Vec<OllamaSetupModel>,
}

/// GET /api/setup/ollama — is the local Ollama runtime reachable, and which models
/// are already pulled. Drives the onboarding "Recommended AI" (local) step.
pub(crate) async fn get_ollama_setup() -> Json<OllamaSetupStatus> {
    let base = ollama_base_url();
    let trimmed = base.trim_end_matches('/');
    let resp = reqwest::Client::new()
        .get(format!("{trimmed}/api/tags"))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;
    let models = match resp {
        Ok(r) if r.status().is_success() => r
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|body| body.get("models").and_then(|m| m.as_array()).cloned())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        Some(OllamaSetupModel {
                            name: m.get("name")?.as_str()?.to_string(),
                            size: m
                                .get("size")
                                .and_then(serde_json::Value::as_u64)
                                .unwrap_or(0),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        _ => {
            return Json(OllamaSetupStatus {
                running: false,
                base_url: base,
                models: Vec::new(),
            });
        }
    };
    Json(OllamaSetupStatus {
        running: true,
        base_url: base,
        models,
    })
}

#[derive(Deserialize)]
pub(crate) struct PullModelRequest {
    model: String,
}

/// POST /api/setup/pull-model — proxy Ollama's native `/api/pull` and forward its
/// NDJSON progress stream verbatim to the client. The onboarding "Download & Get
/// Started" reads the `{status,total,completed}` lines to drive a progress bar.
pub(crate) async fn pull_model(
    Json(req): Json<PullModelRequest>,
) -> Result<Response, GatewayError> {
    let model = req.model.trim().to_string();
    if model.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "pull_model_empty",
            message: "model is required".to_string(),
        });
    }
    let base = ollama_base_url();
    let trimmed = base.trim_end_matches('/');
    let resp = reqwest::Client::new()
        .post(format!("{trimmed}/api/pull"))
        .json(&serde_json::json!({ "name": model, "model": model, "stream": true }))
        .send()
        .await
        .map_err(|error| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "ollama_unreachable",
            message: format!(
                "Ollama is not reachable at {base}: {error}. Is Ollama installed and running?"
            ),
        })?;
    if !resp.status().is_success() {
        return Err(GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "ollama_pull_failed",
            message: format!("Ollama pull failed: HTTP {}", resp.status()),
        });
    }
    let body = Body::from_stream(resp.bytes_stream());
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson")
        .header("cache-control", "no-cache")
        .body(body)
        .expect("valid streaming response"))
}

pub(crate) async fn get_approval_routing() -> Json<ApprovalRoutingView> {
    let prefs = load_user_prefs();
    Json(ApprovalRoutingView {
        channel: prefs
            .approval_channel
            .unwrap_or_else(|| "in_app".to_string()),
        target: prefs.approval_target.filter(|s| !s.trim().is_empty()),
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct SetApprovalRoutingRequest {
    channel: Option<String>,
    target: Option<String>,
}

pub(crate) async fn set_approval_routing(
    Json(request): Json<SetApprovalRoutingRequest>,
) -> Result<Json<ApprovalRoutingView>, GatewayError> {
    let channel = request
        .channel
        .map(|c| c.trim().to_ascii_lowercase())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "in_app".to_string());
    if !matches!(channel.as_str(), "in_app" | "telegram" | "whatsapp") {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_approval_channel",
            message: "Invalid approval channel (in_app | telegram | whatsapp).".to_string(),
        });
    }
    let target = request
        .target
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    // A non-in-app channel needs a target (the user's own number) to be usable.
    if channel != "in_app" && target.is_none() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "approval_target_required",
            message: "For Telegram/WhatsApp your number/chat is required (only from there can you authorize).".to_string(),
        });
    }
    let mut prefs = load_user_prefs();
    prefs.approval_channel = Some(channel.clone());
    prefs.approval_target = target.clone();
    save_user_prefs(&prefs).map_err(|message| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "approval_routing_save",
        message,
    })?;
    Ok(Json(ApprovalRoutingView { channel, target }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct ChannelIdentitiesQuery {
    channel: String,
}

/// GET /api/prefs/channel-identities?channel=telegram — recent chat ids seen on a channel
/// (from the per-contact channel threads), so the approval-routing form can offer the user's
/// OWN chat id as a quick-fill instead of the phone-number-vs-chat-id trap.
pub(crate) async fn channel_identities(
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<ChannelIdentitiesQuery>,
) -> Json<serde_json::Value> {
    let ch = q.channel.trim().to_ascii_lowercase();
    let prefix = format!("channel_{ch}_");
    let channel_label = match ch.as_str() {
        "telegram" => "Telegram",
        "whatsapp" => "WhatsApp",
        _ => "Canale",
    };
    let mut out = Vec::new();
    if let Ok(store) = lock_store(&state)
        && let Ok(snap) = store.threads(&base_workspace_id())
    {
        for t in snap.threads {
            if let Some(id) = t.thread_id.strip_prefix(&prefix) {
                // Prefer the curated contact's name; never expose a thread title
                // (which may be the text of a message) as the chip label.
                let name = store
                    .contact_name_for_identity(&ch, id)
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| channel_label.to_string());
                out.push(serde_json::json!({ "id": id, "name": name }));
                if out.len() >= 8 {
                    break;
                }
            }
        }
    }
    Json(serde_json::json!({ "identities": out }))
}

pub(crate) fn weekday_it(w: jiff::civil::Weekday) -> &'static str {
    use jiff::civil::Weekday::*;
    match w {
        Monday => "Monday",
        Tuesday => "Tuesday",
        Wednesday => "Wednesday",
        Thursday => "Thursday",
        Friday => "Friday",
        Saturday => "Saturday",
        Sunday => "Sunday",
    }
}

pub(crate) fn month_it(m: i8) -> &'static str {
    match m {
        1 => "January",
        2 => "February",
        3 => "March",
        4 => "April",
        5 => "May",
        6 => "June",
        7 => "July",
        8 => "August",
        9 => "September",
        10 => "October",
        11 => "November",
        _ => "December",
    }
}

/// UTC offset formatted as `+HH:MM` / `-HH:MM` from a jiff zoned datetime.
pub(crate) fn offset_hhmm(z: &jiff::Zoned) -> String {
    let secs = z.offset().seconds();
    let sign = if secs < 0 { '-' } else { '+' };
    let abs = secs.abs();
    format!("{sign}{:02}:{:02}", abs / 3600, (abs % 3600) / 60)
}

/// Rich, timezone-aware "now" line injected into prompts (Italian): weekday +
/// full date + time-of-day + IANA zone + UTC offset. Replaces the bare ISO date
/// so the model knows the weekday AND the current time (it can tell that "07:00
/// today" is already past) and is never tripped by the UTC midnight boundary.
pub(crate) fn now_block() -> String {
    let z = now_local();
    let tz = effective_user_tz_name();
    format!(
        "today is {wd} {day} {month} {year}, it's {h:02}:{m:02} ({tz} timezone, UTC{off})",
        wd = weekday_it(z.weekday()),
        day = z.day(),
        month = month_it(z.month()),
        year = z.year(),
        h = z.hour(),
        m = z.minute(),
        tz = tz,
        off = offset_hhmm(&z),
    )
}
