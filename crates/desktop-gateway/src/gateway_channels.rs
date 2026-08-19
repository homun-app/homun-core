//! Channel settings, sidecars, inbound policy, and channel contact context.
//!
//! Owns WhatsApp/Telegram sidecar lifecycle, channel settings, inbound message
//! policy, outbound send/rebind helpers, channel memory recording, and contact
//! perimeter resolution. General runtime settings remain in `main.rs` until their
//! own owner is extracted.

use super::*;

use crate::gateway_project_access::resolve_project_contact_policy;

#[test]
fn channels_owner_smoke() {
    assert_eq!(
        inbound_action(&ChannelSettings::default(), "alice"),
        InboundAction::Ignore
    );
}

// ---------------------------------------------------------------- channels (C0)
//
// Channel bridges (WhatsApp via wa-rs, Telegram, …) deliver INBOUND messages and
// can send OUTBOUND ones. This is the in-repo foundation that does NOT depend on
// any bridge: the safety policy + settings. The concrete bridge (C1) plugs in
// later and calls `inbound_action` to decide what to do with each message.

/// Auto-reply settings for channels. OFF by default — the user opts in. `enabled`
/// is the global kill-switch; `auto_reply` the master toggle; `allowlist` the
/// contact ids cleared for automatic replies.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct ChannelSettings {
    #[serde(default)]
    pub(crate) enabled: bool,
    #[serde(default)]
    pub(crate) auto_reply: bool,
    #[serde(default)]
    pub(crate) allowlist: Vec<String>,
}

/// What to do with an inbound channel message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InboundAction {
    /// Channels off (kill-switch): do nothing.
    Ignore,
    /// Prepare a reply for the user to review/send (default, safe).
    Draft,
    /// Send a text reply automatically (allowlisted sender only).
    AutoReply,
    /// Draft a reply, then route it to the USER for approval (remote card) before sending it
    /// to the contact — the per-contact "ask before send" permission.
    ApproveReply,
}

/// Decides how to handle an inbound message. Kill-switch wins; auto-reply only for
/// allowlisted senders when the master toggle is on; otherwise a draft for review.
///
/// SECURITY: the allowlist auto-confirms ONLY a text reply. Message CONTENT is
/// always untrusted DATA (never instructions — even from an allowlisted sender,
/// whose account could be compromised), and any TOOL/action the assistant would
/// take in response still passes through an approval gate downstream (C4).
pub(crate) fn inbound_action(settings: &ChannelSettings, sender: &str) -> InboundAction {
    if !settings.enabled {
        return InboundAction::Ignore;
    }
    let allowlisted = settings
        .allowlist
        .iter()
        .any(|contact| contact.trim().eq_ignore_ascii_case(sender.trim()));
    if settings.auto_reply && allowlisted {
        InboundAction::AutoReply
    } else {
        InboundAction::Draft
    }
}

pub(crate) fn channel_settings_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("channel-settings.json"))
}

pub(crate) fn load_channel_settings() -> ChannelSettings {
    channel_settings_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn save_channel_settings(settings: &ChannelSettings) -> Result<(), String> {
    let path = channel_settings_path().ok_or_else(|| "data dir unavailable".to_string())?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub(crate) async fn get_channel_settings() -> Json<ChannelSettings> {
    Json(load_channel_settings())
}

pub(crate) async fn set_channel_settings(
    Json(settings): Json<ChannelSettings>,
) -> Result<Json<ChannelSettings>, GatewayError> {
    save_channel_settings(&settings).map_err(|message| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "channel_settings_save",
        message,
    })?;
    Ok(Json(settings))
}
// --- WhatsApp sidecar lifecycle + status (C1.5: connection managed from the app) ---

/// Connection status, mirroring what the sidecar writes to its status file, plus
/// a gateway-computed `running` (is the sidecar process alive?).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct WhatsAppStatus {
    #[serde(default)]
    pub(crate) connected: bool,
    #[serde(default)]
    pub(crate) needs_pairing: bool,
    /// QR payload (when pairing via QR).
    #[serde(default)]
    pub(crate) qr: Option<String>,
    /// 8-char code to enter on the phone (when pairing via phone number).
    #[serde(default)]
    pub(crate) pair_code: Option<String>,
    /// Gateway-computed: is the sidecar process currently running?
    #[serde(default)]
    pub(crate) running: bool,
}

pub(crate) fn whatsapp_status_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("channel-whatsapp-status.json"))
}

/// Locates the built sidecar binary (env override, else repo-relative).
pub(crate) fn whatsapp_bin() -> Option<PathBuf> {
    if let Ok(p) = env::var("HOMUN_WHATSAPP_BIN") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }
    for base in [
        "runtimes/channel-whatsapp/target/release/channel-whatsapp",
        "../runtimes/channel-whatsapp/target/release/channel-whatsapp",
        // Dev fallback: a plain `cargo build` (debug) is enough to run locally.
        "runtimes/channel-whatsapp/target/debug/channel-whatsapp",
        "../runtimes/channel-whatsapp/target/debug/channel-whatsapp",
    ] {
        let path = PathBuf::from(base);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

pub(crate) fn whatsapp_child() -> &'static std::sync::Mutex<Option<std::process::Child>> {
    static CHILD: std::sync::OnceLock<std::sync::Mutex<Option<std::process::Child>>> =
        std::sync::OnceLock::new();
    CHILD.get_or_init(|| std::sync::Mutex::new(None))
}

/// True if the sidecar is alive: either our tracked child, OR something is
/// listening on the sidecar's port (covers a sidecar orphaned by a gateway
/// restart). Port-awareness prevents double-spawning onto the same WhatsApp
/// session (which invalidates it).
pub(crate) fn whatsapp_running() -> bool {
    if let Ok(mut guard) = whatsapp_child().lock()
        && let Some(child) = guard.as_mut()
    {
        match child.try_wait() {
            Ok(None) => return true,
            _ => *guard = None,
        }
    }
    whatsapp_port_open()
}

/// Quick TCP probe of the sidecar's /send port (is a sidecar serving?).
pub(crate) fn whatsapp_port_open() -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], WHATSAPP_HTTP_PORT)),
        std::time::Duration::from_millis(150),
    )
    .is_ok()
}

pub(crate) async fn whatsapp_status() -> Json<WhatsAppStatus> {
    let mut status = whatsapp_status_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<WhatsAppStatus>(&raw).ok())
        .unwrap_or_default();
    status.running = whatsapp_running();
    // If the sidecar isn't running, the file is stale: not connected, and any
    // QR/pair-code from a past session no longer applies.
    if !status.running {
        status.connected = false;
        status.qr = None;
        status.pair_code = None;
    }
    Json(status)
}

#[derive(Debug, Deserialize)]
pub(crate) struct WhatsAppConnectRequest {
    /// Phone number (international, no '+') for pair-code; absent → QR mode.
    #[serde(default)]
    pub(crate) phone: Option<String>,
}

/// On gateway startup, bring channel sidecars back up automatically when they
/// were previously connected (WhatsApp session paired / Telegram bot token saved)
/// AND the channel master switch is on. This is what makes "messages sent while
/// the system was down get fetched and executed on restart" actually happen: the
/// sidecars resume, the platforms replay their backlog (Telegram getUpdates from
/// the persisted offset; WhatsApp store-and-forward), and the (now retrying)
/// forward delivers them to the gateway. Best-effort: failures are logged.
pub(crate) async fn reconnect_channels_on_startup(state: AppState) {
    if !load_channel_settings().enabled {
        return; // kill-switch off: stay disconnected.
    }
    let gw_port = env::var("HOMUN_DESKTOP_GATEWAY_PORT").unwrap_or_else(|_| "18765".to_string());
    let gw_token = state.auth_token.as_ref();

    // WhatsApp: only if a session was previously paired (matches the sidecar's
    // own session path under $HOME/.homun).
    let wa_session = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".homun")
        .join("whatsapp-session.db");
    if !whatsapp_running()
        && wa_session.exists()
        && let Some(bin) = whatsapp_bin()
    {
        let mut command = std::process::Command::new(bin);
        if let Some(path) = whatsapp_status_path() {
            command.env("WA_STATUS_FILE", path);
        }
        command.env("WA_HTTP_PORT", WHATSAPP_HTTP_PORT.to_string());
        command.env("WA_GATEWAY_URL", format!("http://127.0.0.1:{gw_port}"));
        command.env("WA_GATEWAY_TOKEN", gw_token);
        match command.spawn() {
            Ok(child) => {
                if let Ok(mut guard) = whatsapp_child().lock() {
                    *guard = Some(child);
                }
                eprintln!("channel/whatsapp: auto-reconnect at startup (session present)");
            }
            Err(error) => eprintln!("channel/whatsapp: auto-reconnect failed: {error}"),
        }
    }

    // Telegram: only if a bot token was saved.
    let tg_token = telegram_token_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(token) = tg_token
        && let Err(error) = ensure_telegram_sidecar(&state, &token).await
    {
        eprintln!("channel/telegram: auto-reconnect failed: {error:?}");
    }
}

pub(crate) async fn whatsapp_connect(
    Json(request): Json<WhatsAppConnectRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    if whatsapp_running() {
        return Ok(Json(
            serde_json::json!({ "ok": true, "already_running": true }),
        ));
    }
    let bin = whatsapp_bin().ok_or_else(|| GatewayError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "whatsapp_bin_missing",
        message: "Bridge not compiled: run `cargo build --release` in runtimes/channel-whatsapp."
            .to_string(),
    })?;
    let mut command = std::process::Command::new(bin);
    if let Some(phone) = request
        .phone
        .as_ref()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
    {
        command.env("WA_PAIR_PHONE", phone);
    }
    if let Some(path) = whatsapp_status_path() {
        command.env("WA_STATUS_FILE", path);
    }
    // Wire the sidecar↔gateway protocol (C2 outbound /send, C3 inbound forward).
    command.env("WA_HTTP_PORT", WHATSAPP_HTTP_PORT.to_string());
    let gw_port = env::var("HOMUN_DESKTOP_GATEWAY_PORT").unwrap_or_else(|_| "18765".to_string());
    command.env("WA_GATEWAY_URL", format!("http://127.0.0.1:{gw_port}"));
    if let Ok(token) = env::var("HOMUN_DESKTOP_GATEWAY_TOKEN") {
        command.env("WA_GATEWAY_TOKEN", token);
    }
    let child = command.spawn().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "whatsapp_spawn",
        message: error.to_string(),
    })?;
    if let Ok(mut guard) = whatsapp_child().lock() {
        *guard = Some(child);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn whatsapp_disconnect() -> Json<serde_json::Value> {
    if let Ok(mut guard) = whatsapp_child().lock()
        && let Some(mut child) = guard.take()
    {
        let _ = child.kill();
        let _ = child.wait();
    }
    // Also kill any sidecar orphaned by a gateway restart (still on the port).
    let _ = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!(
            "lsof -tiTCP:{WHATSAPP_HTTP_PORT} -sTCP:LISTEN | xargs kill 2>/dev/null"
        ))
        .status();
    Json(serde_json::json!({ "ok": true }))
}

/// Local port the WhatsApp sidecar listens on for outbound /send commands.
pub(crate) const WHATSAPP_HTTP_PORT: u16 = 18766;
pub(crate) const TELEGRAM_HTTP_PORT: u16 = 18767;

// ---------------------------------------------------------------- telegram
// Telegram is a Bot API sidecar (frankenstein): a bot token from @BotFather,
// no phone pairing. Same gateway↔sidecar protocol as WhatsApp.

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct TelegramStatus {
    #[serde(default)]
    pub(crate) connected: bool,
    #[serde(default)]
    pub(crate) bot_username: Option<String>,
    #[serde(default)]
    pub(crate) error: Option<String>,
    /// Gateway-computed: is the sidecar process currently running?
    #[serde(default)]
    pub(crate) running: bool,
}

pub(crate) fn telegram_status_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("channel-telegram-status.json"))
}

/// Persisted bot token (0600). Lets "Connetti" work without re-entering it.
pub(crate) fn telegram_token_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("telegram-bot-token"))
}

pub(crate) fn load_telegram_token() -> Option<String> {
    telegram_token_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(crate) fn telegram_bin() -> Option<PathBuf> {
    if let Ok(p) = env::var("HOMUN_TELEGRAM_BIN") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }
    for base in [
        "runtimes/channel-telegram/target/release/channel-telegram",
        "../runtimes/channel-telegram/target/release/channel-telegram",
        // Dev fallback: a plain `cargo build` (debug) is enough to run locally.
        "runtimes/channel-telegram/target/debug/channel-telegram",
        "../runtimes/channel-telegram/target/debug/channel-telegram",
    ] {
        let path = PathBuf::from(base);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

pub(crate) fn telegram_child() -> &'static std::sync::Mutex<Option<std::process::Child>> {
    static CHILD: std::sync::OnceLock<std::sync::Mutex<Option<std::process::Child>>> =
        std::sync::OnceLock::new();
    CHILD.get_or_init(|| std::sync::Mutex::new(None))
}

pub(crate) fn telegram_port_open() -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], TELEGRAM_HTTP_PORT)),
        std::time::Duration::from_millis(150),
    )
    .is_ok()
}

pub(crate) fn tracked_telegram_child_running() -> bool {
    if let Ok(mut guard) = telegram_child().lock()
        && let Some(child) = guard.as_mut()
    {
        match child.try_wait() {
            Ok(None) => return true,
            _ => *guard = None,
        }
    }
    false
}

pub(crate) fn telegram_running() -> bool {
    tracked_telegram_child_running() || telegram_port_open()
}

pub(crate) fn telegram_rebind_should_wait(tracked_child_running: bool, port_open: bool) -> bool {
    tracked_child_running && !port_open
}

pub(crate) async fn wait_for_telegram_sidecar_ready() {
    for _ in 0..30 {
        if telegram_port_open() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RebindResult {
    Configured,
    Http(u16),
    Transport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TelegramBridgeAction {
    Keep,
    Replace,
}

pub(crate) fn telegram_bridge_action(result: RebindResult) -> TelegramBridgeAction {
    match result {
        RebindResult::Configured => TelegramBridgeAction::Keep,
        RebindResult::Http(_) | RebindResult::Transport => TelegramBridgeAction::Replace,
    }
}

pub(crate) async fn rebind_telegram_sidecar(state: &AppState, bot_token: &str) -> RebindResult {
    let gateway_port =
        env::var("HOMUN_DESKTOP_GATEWAY_PORT").unwrap_or_else(|_| "18765".to_string());
    let response = state
        .http
        .post(format!(
            "http://127.0.0.1:{TELEGRAM_HTTP_PORT}/configure-gateway"
        ))
        .timeout(std::time::Duration::from_secs(3))
        .bearer_auth(bot_token)
        .json(&serde_json::json!({
            "gateway_url": format!("http://127.0.0.1:{gateway_port}"),
            "gateway_token": state.auth_token.as_ref(),
        }))
        .send()
        .await;
    match response {
        Ok(response) if response.status() == StatusCode::NO_CONTENT => RebindResult::Configured,
        Ok(response) => RebindResult::Http(response.status().as_u16()),
        Err(_) => RebindResult::Transport,
    }
}

pub(crate) fn stop_telegram_sidecar() {
    if let Ok(mut guard) = telegram_child().lock()
        && let Some(mut child) = guard.take()
    {
        let _ = child.kill();
        let _ = child.wait();
    }
    let _ = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!(
            "lsof -tiTCP:{TELEGRAM_HTTP_PORT} -sTCP:LISTEN | xargs kill 2>/dev/null"
        ))
        .status();
}

pub(crate) fn spawn_telegram_sidecar(state: &AppState, token: &str) -> Result<(), GatewayError> {
    let bin = telegram_bin().ok_or_else(|| GatewayError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "telegram_bin_missing",
        message: "Bridge not compiled: run `cargo build --release` in runtimes/channel-telegram."
            .to_string(),
    })?;
    let mut command = std::process::Command::new(bin);
    command.env("TG_BOT_TOKEN", token);
    command.env("TG_HTTP_PORT", TELEGRAM_HTTP_PORT.to_string());
    if let Some(path) = telegram_status_path() {
        command.env("TG_STATUS_FILE", path);
    }
    let gateway_port =
        env::var("HOMUN_DESKTOP_GATEWAY_PORT").unwrap_or_else(|_| "18765".to_string());
    command.env("TG_GATEWAY_URL", format!("http://127.0.0.1:{gateway_port}"));
    command.env("TG_GATEWAY_TOKEN", state.auth_token.as_ref());
    let child = command.spawn().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "telegram_spawn",
        message: error.to_string(),
    })?;
    if let Ok(mut guard) = telegram_child().lock() {
        *guard = Some(child);
    }
    Ok(())
}

pub(crate) async fn ensure_telegram_sidecar(
    state: &AppState,
    token: &str,
) -> Result<TelegramBridgeAction, GatewayError> {
    let tracked_child_running = tracked_telegram_child_running();
    if telegram_rebind_should_wait(tracked_child_running, telegram_port_open()) {
        wait_for_telegram_sidecar_ready().await;
    }
    if telegram_running() {
        let rebind = rebind_telegram_sidecar(state, token).await;
        let action = telegram_bridge_action(rebind);
        if action == TelegramBridgeAction::Keep {
            eprintln!("channel/telegram: reconfigured existing sidecar");
            return Ok(action);
        }
        eprintln!("channel/telegram: replacing stale or legacy sidecar");
        stop_telegram_sidecar();
    }
    spawn_telegram_sidecar(state, token)?;
    Ok(TelegramBridgeAction::Replace)
}

pub(crate) async fn telegram_status() -> Json<TelegramStatus> {
    let mut status = telegram_status_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<TelegramStatus>(&raw).ok())
        .unwrap_or_default();
    status.running = telegram_running();
    if !status.running {
        // Stale file: not connected once the sidecar is gone.
        status.connected = false;
    }
    Json(status)
}

#[derive(Debug, Deserialize)]
pub(crate) struct TelegramConnectRequest {
    /// Bot token from @BotFather. If absent, reuse the persisted token.
    #[serde(default)]
    pub(crate) token: Option<String>,
}

pub(crate) async fn telegram_connect(
    State(state): State<AppState>,
    Json(request): Json<TelegramConnectRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    // Resolve the token: explicit (persist it 0600) or previously persisted.
    let token = match request
        .token
        .as_ref()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
    {
        Some(token) => {
            if let Some(path) = telegram_token_path() {
                gateway_file_security::write_private_file(&path, token.as_bytes()).map_err(
                    |error| GatewayError {
                        status: StatusCode::INTERNAL_SERVER_ERROR,
                        code: "telegram_token_save",
                        message: error.to_string(),
                    },
                )?;
            }
            token.to_string()
        }
        None => telegram_token_path()
            .and_then(|p| fs::read_to_string(p).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| GatewayError {
                status: StatusCode::BAD_REQUEST,
                code: "telegram_token_missing",
                message: "Enter the bot token from @BotFather.".to_string(),
            })?,
    };

    let action = ensure_telegram_sidecar(&state, &token).await?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "reconfigured": action == TelegramBridgeAction::Keep,
    })))
}

pub(crate) async fn telegram_disconnect() -> Json<serde_json::Value> {
    stop_telegram_sidecar();
    Json(serde_json::json!({ "ok": true }))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChannelSendFailureKind {
    ConnectFailedBeforeDispatch,
    VerifiedRejection,
    UnknownRemoteOutcome,
}

impl ChannelSendFailureKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ConnectFailedBeforeDispatch => "connect_failed_before_dispatch",
            Self::VerifiedRejection => "verified_rejection",
            Self::UnknownRemoteOutcome => "unknown_remote_outcome",
        }
    }
}

pub(crate) struct ChannelSendFailure {
    pub(crate) kind: ChannelSendFailureKind,
    pub(crate) message: String,
}

pub(crate) fn channel_send_failure_kind_for_status(status: StatusCode) -> ChannelSendFailureKind {
    if status.is_client_error() {
        ChannelSendFailureKind::VerifiedRejection
    } else {
        ChannelSendFailureKind::UnknownRemoteOutcome
    }
}

pub(crate) fn telegram_send_may_rebind(kind: ChannelSendFailureKind) -> bool {
    kind == ChannelSendFailureKind::ConnectFailedBeforeDispatch
}

/// Sends one text message via a channel sidecar and preserves whether retrying is safe.
pub(crate) async fn channel_send_classified(
    state: &AppState,
    port: u16,
    recipient: &str,
    text: &str,
) -> Result<(), ChannelSendFailure> {
    let url = format!("http://127.0.0.1:{port}/send");
    let response = state
        .http
        .post(&url)
        .timeout(std::time::Duration::from_secs(30))
        .json(&serde_json::json!({ "recipient": recipient, "text": text }))
        .send()
        .await
        .map_err(|error| ChannelSendFailure {
            kind: if error.is_connect() {
                ChannelSendFailureKind::ConnectFailedBeforeDispatch
            } else {
                ChannelSendFailureKind::UnknownRemoteOutcome
            },
            message: format!("sidecar unreachable: {error}"),
        })?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(ChannelSendFailure {
            kind: channel_send_failure_kind_for_status(response.status()),
            message: format!("sidecar /send responded {}", response.status()),
        })
    }
}

/// Compatibility wrapper for callers that only surface text and never retry internally.
pub(crate) async fn channel_send(
    state: &AppState,
    port: u16,
    recipient: &str,
    text: &str,
) -> Result<(), String> {
    channel_send_classified(state, port, recipient, text)
        .await
        .map_err(|error| error.message)
}

/// POST an outbound message to a channel sidecar WITH an inline keyboard (Telegram only).
/// `buttons` = `[[label, callback_data], ...]`.
pub(crate) async fn channel_send_buttons_classified(
    state: &AppState,
    port: u16,
    recipient: &str,
    text: &str,
    buttons: Vec<[String; 2]>,
) -> Result<(), ChannelSendFailure> {
    let url = format!("http://127.0.0.1:{port}/send");
    let response = state
        .http
        .post(&url)
        .timeout(std::time::Duration::from_secs(30))
        .json(&serde_json::json!({ "recipient": recipient, "text": text, "buttons": buttons }))
        .send()
        .await
        .map_err(|error| ChannelSendFailure {
            kind: if error.is_connect() {
                ChannelSendFailureKind::ConnectFailedBeforeDispatch
            } else {
                ChannelSendFailureKind::UnknownRemoteOutcome
            },
            message: format!("sidecar unreachable: {error}"),
        })?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(ChannelSendFailure {
            kind: channel_send_failure_kind_for_status(response.status()),
            message: format!("sidecar /send responded {}", response.status()),
        })
    }
}

pub(crate) fn send_message_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "send_message",
            "description": "Send a message on a connected channel of the user (WhatsApp or Telegram). Use it for \"send/write/forward me a message\". The recipient MUST be an explicit number or chat ID (for «to me» ask for the number if you don't know it, do NOT make it up). Sending requires the user's confirmation before it goes out.",
            "parameters": {
                "type": "object",
                "properties": {
                    "channel": { "type": "string", "enum": ["whatsapp", "telegram"], "description": "Channel to send on" },
                    "to": { "type": "string", "description": "Recipient: number (e.g. 39333…) or chat ID. NOT a generic name." },
                    "text": { "type": "string", "description": "Message text" }
                },
                "required": ["channel", "to", "text"]
            }
        }
    })
}

/// Routes the agent's `send_message` tool (confirmed via the standard write-confirm card) to
/// the channel sidecar. The recipient must be an explicit id/number — a bare name that isn't
/// id-like is refused so the agent asks the user instead of guessing. Returns a Composio-shaped
/// `{successful, ...}` value so the existing confirm card + result handling work unchanged.
pub(crate) fn execute_send_message(
    state: &AppState,
    args: &serde_json::Value,
) -> Result<serde_json::Value, GatewayError> {
    let channel = args
        .get("channel")
        .and_then(|v| v.as_str())
        .unwrap_or("whatsapp")
        .trim()
        .to_lowercase();
    let to = args
        .get("to")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let text = args
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if to.is_empty() || text.is_empty() {
        return Ok(serde_json::json!({
            "successful": false,
            "error": "The recipient (to) and the text (text) are required."
        }));
    }
    let looks_like_id =
        to.chars().any(|c| c.is_ascii_digit()) || to.contains('@') || to.starts_with('+');
    if !looks_like_id {
        return Ok(serde_json::json!({
            "successful": false,
            "error": format!("Recipient «{to}» is ambiguous: pass a number or a chat ID, not just the name.")
        }));
    }
    let port = if channel == "telegram" {
        TELEGRAM_HTTP_PORT
    } else {
        WHATSAPP_HTTP_PORT
    };
    let st = state.clone();
    let recipient = to.clone();
    let body = text.clone();
    let sent = tokio::runtime::Handle::current()
        .block_on(async move { channel_send_classified(&st, port, &recipient, &body).await });
    match sent {
        Ok(()) => {
            Ok(serde_json::json!({ "successful": true, "data": { "channel": channel, "to": to } }))
        }
        Err(error) => Ok(serde_json::json!({
            "successful": false,
            "unknown_remote_outcome": error.kind == ChannelSendFailureKind::UnknownRemoteOutcome,
            "error": format!("Send failed: {}", error.message),
        })),
    }
}

pub(crate) async fn telegram_send_with_rebind(
    state: &AppState,
    recipient: &str,
    text: &str,
) -> Result<(), ChannelSendFailure> {
    match channel_send_classified(state, TELEGRAM_HTTP_PORT, recipient, text).await {
        Ok(()) => return Ok(()),
        Err(first_error) if telegram_send_may_rebind(first_error.kind) => {
            let Some(token) = load_telegram_token() else {
                return Err(ChannelSendFailure {
                    kind: ChannelSendFailureKind::ConnectFailedBeforeDispatch,
                    message: format!("{}; telegram token unavailable", first_error.message),
                });
            };
            if let Err(error) = ensure_telegram_sidecar(state, &token).await {
                return Err(ChannelSendFailure {
                    kind: ChannelSendFailureKind::ConnectFailedBeforeDispatch,
                    message: format!("{}; rebind failed: {}", first_error.message, error.message),
                });
            }
        }
        Err(first_error) => return Err(first_error),
    }
    channel_send_classified(state, TELEGRAM_HTTP_PORT, recipient, text).await
}

pub(crate) fn channel_reply_effect_request(
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
    thread_id: &str,
    channel: &str,
    recipient: &str,
    answer: &str,
) -> crate::effect_host::EffectRequest {
    let contract = contract.as_ref();
    let operation = format!("channel.{channel}.reply");
    let logical_call_id = format!("projection_revision_{}", contract.revision);
    crate::effect_host::EffectRequest::adapter_output(
        operation,
        logical_call_id,
        local_first_execution_protocol::EffectClass::ExternalWrite,
        serde_json::json!({
            "thread_id": thread_id,
            "channel": channel,
            "recipient": recipient,
            "answer": answer,
        }),
    )
}

pub(crate) fn recipient_fingerprint(recipient: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(recipient.trim().as_bytes()))
}

/// Turn-completion hook for a channel conversation. The external send is guarded by
/// a durable effect receipt so projection replay never repeats an uncertain delivery.
pub(crate) enum ChannelProjectionDelivery {
    NotApplicable,
    Delivered(serde_json::Value),
    Pending(local_first_execution_protocol::EffectReceiptRef),
}

pub(crate) async fn mirror_reply_to_channel_if_any(
    state: &AppState,
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
    projection_claim: Option<&local_first_task_runtime::ProjectionClaim>,
    thread_id: &str,
    answer: &str,
) -> Result<ChannelProjectionDelivery, String> {
    let answer = answer.trim();
    if answer.is_empty() {
        return Ok(ChannelProjectionDelivery::NotApplicable);
    }
    if contract.as_ref().scope.thread_id.as_deref() != Some(thread_id) {
        return Err("channel projection thread does not match execution scope".to_string());
    }
    let thread = lock_store(state)
        .map_err(|error| error.message)?
        .thread(thread_id)
        .map_err(|error| format!("channel thread lookup failed: {error}"))?;
    let Some(thread) = thread else {
        return Ok(ChannelProjectionDelivery::NotApplicable);
    };
    let recipient = match thread.channel_recipient.as_deref().map(str::trim) {
        Some(r) if !r.is_empty() => r.to_string(),
        _ => return Ok(ChannelProjectionDelivery::NotApplicable),
    };
    let channel = match thread.source.as_deref() {
        Some("telegram") => "telegram",
        Some("whatsapp") => "whatsapp",
        _ => return Ok(ChannelProjectionDelivery::NotApplicable),
    };
    let projection_claim = projection_claim
        .ok_or_else(|| "channel reply dispatch requires a projection claim".to_string())?;
    let effect_host = crate::effect_host::EffectHost::for_projection(
        state.task_store.as_ref(),
        contract,
        projection_claim,
    );
    let lease = match effect_host.begin(channel_reply_effect_request(
        contract, thread_id, channel, &recipient, answer,
    ))? {
        crate::effect_host::EffectDecision::Replay(receipt) => {
            return Ok(ChannelProjectionDelivery::Delivered(serde_json::json!({
                "receipt_ref": receipt.receipt_ref.as_ref(),
                "channel": channel,
                "status": "completed",
            })));
        }
        crate::effect_host::EffectDecision::Resolve(receipt) => {
            return Ok(ChannelProjectionDelivery::Pending(receipt.receipt_ref));
        }
        crate::effect_host::EffectDecision::Execute(lease) => lease,
    };

    let send_result = match channel {
        "telegram" => telegram_send_with_rebind(state, &recipient, answer).await,
        "whatsapp" => channel_send_classified(state, WHATSAPP_HTTP_PORT, &recipient, answer).await,
        _ => unreachable!("channel was validated before receipt preparation"),
    };
    if let Err(error) = send_result {
        if error.kind == ChannelSendFailureKind::UnknownRemoteOutcome {
            let receipt = effect_host.mark_uncertain_with_evidence(
                &lease,
                &serde_json::json!({
                    "channel": channel,
                    "recipient_fingerprint": recipient_fingerprint(&recipient),
                    "thread_id": thread_id,
                    "attempted": true,
                }),
            )?;
            eprintln!(
                "channel/{channel}: reply delivery uncertain for {}: {}",
                receipt.receipt_ref.as_ref(),
                redact_sensitive_text(&error.message)
            );
            return Ok(ChannelProjectionDelivery::Pending(receipt.receipt_ref));
        }
        effect_host.release_not_applied(
            &lease,
            error.kind.as_str(),
            &redact_sensitive_text(&error.message),
        )?;
        return Err(format!(
            "channel/{channel} reply was verified not applied: {}",
            redact_sensitive_text(&error.message)
        ));
    }
    let receipt = effect_host.complete(
        &lease,
        &serde_json::json!({"delivered": true}),
        &serde_json::json!({
            "channel": channel,
            "recipient_fingerprint": recipient_fingerprint(&recipient),
            "thread_id": thread_id,
        }),
    )?;
    eprintln!("channel/{channel}: reply mirrored to {recipient}");
    // Nudge the app: a BACKGROUND channel turn isn't streamed to this client, so without this
    // event the open thread's messages + working-island projection never refresh (they only
    // re-fetch on thread-switch / a streamed turn end). This is what re-populates the island.
    publish_app_event(serde_json::json!({
        "type": "thread.updated",
        "thread_id": thread_id,
        "workspace": base_workspace_id(),
        "channel": channel,
    }));
    Ok(ChannelProjectionDelivery::Delivered(serde_json::json!({
        "receipt_ref": receipt.receipt_ref.as_ref(),
        "channel": channel,
        "status": "completed",
    })))
}

/// Resolve a thread's outbound channel endpoint (sidecar port + recipient), or `None` when the
/// thread isn't a sendable channel conversation. Shared by the typing-indicator helpers.
pub(crate) fn channel_endpoint(state: &AppState, thread_id: &str) -> Option<(u16, String)> {
    let thread = lock_store(state)
        .ok()
        .and_then(|s| s.thread(thread_id).ok().flatten())?;
    let recipient = thread
        .channel_recipient
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())?
        .to_string();
    let port = match thread.source.as_deref() {
        Some("telegram") => TELEGRAM_HTTP_PORT,
        Some("whatsapp") => WHATSAPP_HTTP_PORT,
        _ => return None,
    };
    Some((port, recipient))
}

/// Show a "typing…" indicator on a channel thread's origin channel for as long as the returned
/// handle is alive. Returns `None` for non-channel threads. The broker runs a channel turn in a
/// worker AFTER the inbound handler returns, so — unlike the inline ApproveReply path — the
/// typing keepalive must be tied to the TURN lifecycle: the caller (turn_executor) starts it at
/// turn start and stops it when the model finishes. Refresh every 8s because the sidecar presence
/// expires on its own (so a crash never leaves the contact "typing" forever).
pub(crate) fn start_channel_typing_keepalive(
    state: &AppState,
    thread_id: &str,
) -> Option<tokio::task::JoinHandle<()>> {
    let (port, recipient) = channel_endpoint(state, thread_id)?;
    let state = state.clone();
    Some(tokio::runtime::Handle::current().spawn(async move {
        loop {
            if channel_set_presence(&state, port, &recipient, "composing")
                .await
                .is_err()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        }
    }))
}

/// Clear the typing indicator on a channel thread (best-effort). Aborting the keepalive stops the
/// refresh, but WhatsApp keeps "composing" until a message OR an explicit "paused" arrives — so a
/// CANCELLED channel turn (no reply sent) would otherwise leave the contact stuck typing. Mirrors
/// the inline path, which also sends "paused". No-op for non-channel threads.
pub(crate) async fn clear_channel_typing(state: &AppState, thread_id: &str) {
    if let Some((port, recipient)) = channel_endpoint(state, thread_id) {
        let _ = channel_set_presence(state, port, &recipient, "paused").await;
    }
}

pub(crate) async fn telegram_send_buttons_with_rebind(
    state: &AppState,
    recipient: &str,
    text: &str,
    buttons: Vec<[String; 2]>,
) -> Result<(), ChannelSendFailure> {
    match channel_send_buttons_classified(
        state,
        TELEGRAM_HTTP_PORT,
        recipient,
        text,
        buttons.clone(),
    )
    .await
    {
        Ok(()) => return Ok(()),
        Err(first_error) if telegram_send_may_rebind(first_error.kind) => {
            let Some(token) = load_telegram_token() else {
                return Err(ChannelSendFailure {
                    kind: ChannelSendFailureKind::ConnectFailedBeforeDispatch,
                    message: format!("{}; telegram token unavailable", first_error.message),
                });
            };
            if let Err(error) = ensure_telegram_sidecar(state, &token).await {
                return Err(ChannelSendFailure {
                    kind: ChannelSendFailureKind::ConnectFailedBeforeDispatch,
                    message: format!("{}; rebind failed: {}", first_error.message, error.message),
                });
            }
        }
        Err(first_error) => return Err(first_error),
    }
    channel_send_buttons_classified(state, TELEGRAM_HTTP_PORT, recipient, text, buttons).await
}

/// Drives a channel's typing indicator via its sidecar: `presence` is
/// "composing" (typing…) or "paused" (cleared). Best-effort, short timeout.
pub(crate) async fn channel_set_presence(
    state: &AppState,
    port: u16,
    recipient: &str,
    presence: &str,
) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/chatstate");
    let response = state
        .http
        .post(&url)
        .timeout(std::time::Duration::from_secs(10))
        .json(&serde_json::json!({ "recipient": recipient, "state": presence }))
        .send()
        .await
        .map_err(|error| format!("sidecar unreachable: {error}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "sidecar /chatstate responded {}",
            response.status()
        ))
    }
}

/// WhatsApp-specific thin wrapper (kept for the manual /send endpoint).
pub(crate) async fn whatsapp_send_to(
    state: &AppState,
    recipient: &str,
    text: &str,
) -> Result<(), String> {
    channel_send(state, WHATSAPP_HTTP_PORT, recipient, text).await
}

#[derive(Debug, Deserialize)]
pub(crate) struct WhatsAppSendRequest {
    pub(crate) recipient: String,
    pub(crate) text: String,
}

pub(crate) async fn whatsapp_send(
    State(state): State<AppState>,
    Json(request): Json<WhatsAppSendRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    whatsapp_send_to(&state, &request.recipient, &request.text)
        .await
        .map_err(|message| GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "whatsapp_send",
            message,
        })?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Inbound message forwarded by the sidecar (C3). Applies the C0 policy, records
/// the message to per-contact memory (+ a person node), and for allowlisted
/// senders generates and sends a TEXT auto-reply. SECURITY: content is untrusted
/// data; the reply generator is told never to act on instructions inside it, and
/// no tools are available to it.
#[derive(Debug, Deserialize)]
pub(crate) struct ChannelInbound {
    /// Stable sender identifier (WhatsApp phone/LID user, Telegram numeric id).
    pub(crate) sender: String,
    #[serde(default)]
    pub(crate) sender_name: String,
    pub(crate) content: String,
    /// Reply-target id: a WhatsApp JID ("…@lid" / "…@s.whatsapp.net") or a
    /// Telegram chat id (numeric). Reply here.
    #[serde(default)]
    pub(crate) chat: Option<String>,
    /// WhatsApp only: phone-number JID alternative when the chat is LID-addressed.
    /// Sending to a raw @lid can ack-OK yet never deliver, so the PN is preferred.
    /// Telegram leaves this unset.
    #[serde(default)]
    pub(crate) sender_pn: Option<String>,
    /// Channel-native message id (WhatsApp message-key id, Telegram message id).
    /// Used for idempotency: a message already handled live is dropped when it
    /// re-appears in a WhatsApp history sync. Optional — payloads without it skip
    /// dedup and process as before.
    #[serde(default)]
    pub(crate) message_id: Option<String>,
    /// Unix-seconds timestamp of the original message. Set by the WhatsApp
    /// history-recovery path so the gateway can defensively drop messages older
    /// than the recency window even if the sidecar filter let one slip. Live
    /// payloads may leave it unset.
    #[serde(default)]
    pub(crate) ts: Option<i64>,
}

pub(crate) async fn whatsapp_inbound(
    State(state): State<AppState>,
    Json(message): Json<ChannelInbound>,
) -> Json<serde_json::Value> {
    handle_channel_inbound(&state, "whatsapp", WHATSAPP_HTTP_PORT, message).await
}

pub(crate) async fn telegram_inbound(
    State(state): State<AppState>,
    Json(message): Json<ChannelInbound>,
) -> Json<serde_json::Value> {
    handle_channel_inbound(&state, "telegram", TELEGRAM_HTTP_PORT, message).await
}

#[derive(Debug, Deserialize)]
pub(crate) struct TelegramCallbackRequest {
    /// The tapping user's id (== the private chat id) — checked against the self target.
    pub(crate) from: String,
    /// `approve:<code>` or `cancel:<code>` (the inline button's callback_data).
    pub(crate) data: String,
}

/// Telegram inline-button tap for a remote approval. SECURITY: only when Telegram is the
/// configured approval channel AND the tapper is the self target. Executes/cancels the pending
/// action and messages the outcome back.
pub(crate) async fn telegram_callback(
    State(state): State<AppState>,
    Json(req): Json<TelegramCallbackRequest>,
) -> Json<serde_json::Value> {
    let prefs = load_user_prefs();
    let target = prefs.approval_target.unwrap_or_default();
    let authorized = prefs.approval_channel.as_deref() == Some("telegram")
        && !target.trim().is_empty()
        && req.from.trim().eq_ignore_ascii_case(target.trim());
    if !authorized {
        return Json(serde_json::json!({ "ok": false, "reason": "unauthorized" }));
    }
    let Some((verb, code)) = req.data.split_once(':') else {
        return Json(serde_json::json!({ "ok": false, "reason": "bad_data" }));
    };
    let approve = verb.eq_ignore_ascii_case("approve");
    let reply = if approve {
        if pending_approval_exists(&state, code) {
            let _ =
                telegram_send_with_rebind(&state, target.trim(), &approval_progress_reply(code))
                    .await;
        }
        execute_pending_approval(&state, code).await
    } else {
        match cancel_pending_remote_approval(&state, code) {
            true => format!("❌ Cancelled ({code})."),
            _ => format!("Code {code} not valid or expired."),
        }
    };
    let _ = telegram_send_with_rebind(&state, target.trim(), &reply).await;
    Json(serde_json::json!({ "ok": true, "approved": approve }))
}

/// Shared inbound pipeline for every channel: applies the C0 policy, records the
/// message into memory, and (on allowlist) auto-replies via the channel's sidecar
/// with a live typing indicator. `channel` is the tag ("whatsapp"/"telegram");
/// `port` selects the sidecar to send the reply + typing through.
pub(crate) async fn handle_channel_inbound(
    state: &AppState,
    channel: &'static str,
    port: u16,
    message: ChannelInbound,
) -> Json<serde_json::Value> {
    let prefs = load_user_prefs();
    let is_owner_message = channel_message_is_from_owner(
        &prefs,
        channel,
        &message.sender,
        message.chat.as_deref(),
        message.sender_pn.as_deref(),
    );
    // Remote-approval control reply: if the USER's own number (the configured approval_target
    // on THIS channel) replies "OK <code>" / "NO <code>", authorize or cancel the pending action
    // and stop — it's a control message, not a conversation. SECURITY: only the self target.
    {
        let routed_here = prefs.approval_channel.as_deref() == Some(channel);
        let target = prefs.approval_target.clone().unwrap_or_default();
        let id_matches = |v: Option<&str>| {
            v.map(|s| s.trim().eq_ignore_ascii_case(target.trim()))
                .unwrap_or(false)
        };
        let is_self = is_owner_message
            || (routed_here
                && !target.trim().is_empty()
                && (id_matches(Some(message.sender.as_str()))
                    || id_matches(message.chat.as_deref())
                    || id_matches(message.sender_pn.as_deref())));
        if is_self && let Some((approve, code)) = parse_approval_reply(&message.content) {
            // Only a REAL pending code is a control reply. Otherwise this is a
            // normal message that merely starts with No/Ok/Sì (e.g. "No, that's
            // wrong…") and must flow to the conversation — not be answered with
            // "Code … not valid or expired."
            if pending_approval_exists(state, &code) {
                let reply = if approve {
                    if channel == "telegram" {
                        let _ = telegram_send_with_rebind(
                            state,
                            &message.sender,
                            &approval_progress_reply(&code),
                        )
                        .await;
                    } else {
                        let _ = channel_send(
                            state,
                            port,
                            &message.sender,
                            &approval_progress_reply(&code),
                        )
                        .await;
                    }
                    execute_pending_approval(state, &code).await
                } else {
                    match cancel_pending_remote_approval(state, &code) {
                        true => format!("❌ Cancelled ({code})."),
                        _ => format!("Code {code} not valid or expired."),
                    }
                };
                if channel == "telegram" {
                    let _ = telegram_send_with_rebind(state, &message.sender, &reply).await;
                } else {
                    let _ = channel_send(state, port, &message.sender, &reply).await;
                }
                return Json(serde_json::json!({
                    "action": "approval", "code": code, "approved": approve
                }));
            }
        }
    }
    // Global policy first (the kill-switch always wins via Ignore)…
    let global_action = inbound_action(&load_channel_settings(), &message.sender);
    // …then the curated contact's response_mode refines it: automatic → reply now,
    // silent → drop, draft/assisted/on_demand → record without replying. '' or an
    // unknown sender = inherit today's global behavior (backward compatible).
    let action = if matches!(global_action, InboundAction::Ignore) {
        InboundAction::Ignore
    } else {
        let contact_mode = lock_store(state).ok().and_then(|store| {
            store
                .contact_response_mode(channel, &message.sender)
                .ok()
                .flatten()
        });
        match contact_mode.as_deref() {
            Some("automatic") => InboundAction::AutoReply,
            Some("approve") => InboundAction::ApproveReply,
            Some("silent") => InboundAction::Ignore,
            Some(_) => InboundAction::Draft,
            None => global_action,
        }
    };
    // Privacy-safe trace: identifier + decision only, never the message content.
    eprintln!(
        "channel/{channel}: inbound from={} chat={} pn={} action={action:?}",
        message.sender,
        message.chat.as_deref().unwrap_or("-"),
        message.sender_pn.as_deref().unwrap_or("-"),
    );
    if matches!(action, InboundAction::Ignore) {
        return Json(serde_json::json!({ "action": "ignore" }));
    }

    // Recency ceiling shared by the dedup/recency guard below and the WhatsApp
    // history-recovery sidecar (env WA_HISTORY_RECENCY_HOURS, default 48h). The
    // initial WhatsApp history sync carries months of chats; we only ever want
    // to act on messages from the recent offline window.
    let recency_secs: i64 = std::env::var("WA_HISTORY_RECENCY_HOURS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(48)
        .saturating_mul(3600)
        .min(i64::MAX as u64) as i64;

    // Defense-in-depth on top of the sidecar filter: if the payload carries the
    // original message timestamp (history-recovery path sets it) and it is older
    // than the recency ceiling, mark it seen and drop it WITHOUT replying. We
    // still mark it seen so a later, in-window re-delivery of the same id can't
    // sneak through.
    if let Some(ts) = message.ts {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if ts > 0 && now.saturating_sub(ts) > recency_secs {
            if let (Some(message_id), Ok(store)) =
                (message.message_id.as_deref(), lock_store(state))
            {
                let _ = store.mark_inbound_seen(&format!("{channel}:{message_id}"));
            }
            eprintln!("channel/{channel}: drop too-old inbound (ts={ts}, recency={recency_secs}s)");
            return Json(serde_json::json!({ "action": "too_old" }));
        }

        // Per-contact watermark. A recovered message older-or-equal to our last
        // activity in this contact's thread was already handled BEFORE the dedup
        // table existed (so its id isn't recorded there). Skip it — only messages
        // genuinely newer than our last thread activity are missed-while-offline.
        // Live messages carry no `ts`, so they always process.
        let watermark_thread = format!("channel_{channel}_{}", message.sender);
        if let Ok(store) = lock_store(state)
            && let Ok(Some(latest)) = store.latest_message_timestamp(&watermark_thread)
            && ts <= latest
        {
            if let Some(message_id) = message.message_id.as_deref() {
                let _ = store.mark_inbound_seen(&format!("{channel}:{message_id}"));
            }
            eprintln!(
                "channel/{channel}: skip already-handled inbound (ts={ts} <= watermark={latest})"
            );
            return Json(serde_json::json!({ "action": "already_handled" }));
        }
    }

    // Idempotency: dedup on "{channel}:{message_id}". The SAME handler runs for
    // live and history-recovered messages, so marking-seen here covers both:
    //  - a live message is recorded as seen, so when it later re-appears in a
    //    history sync it is recognized as a duplicate and not re-replied;
    //  - a recovered message that was never seen live is processed once.
    // Payloads without a message_id (none today, but allowed) skip dedup and
    // process as before.
    if let Some(message_id) = message.message_id.as_deref() {
        let dedup_key = format!("{channel}:{message_id}");
        match lock_store(state) {
            Ok(store) => match store.mark_inbound_seen(&dedup_key) {
                // Newly inserted → first time we see it; fall through and process.
                // Opportunistically trim entries well past the recency window so
                // the dedup table stays bounded (margin = 2× recency).
                Ok(true) => {
                    let _ = store.prune_inbound_seen(recency_secs.saturating_mul(2));
                }
                // Already present → duplicate; drop without recording or replying.
                Ok(false) => {
                    eprintln!("channel/{channel}: duplicate inbound {dedup_key} dropped");
                    return Json(serde_json::json!({ "action": "duplicate" }));
                }
                // On a store error, fail open: process the message rather than
                // silently dropping a possibly-new message.
                Err(error) => {
                    eprintln!("channel/{channel}: dedup check failed for {dedup_key}: {error}")
                }
            },
            Err(error) => {
                eprintln!("channel/{channel}: dedup store lock failed: {error:?}")
            }
        }
    }

    // Best-effort: record the contact (person node) + the message (episodic).
    record_channel_message(state, channel, &message, is_owner_message);
    // Event-triggered automations: fire any user rule listening for this channel message
    // (independent of the auto-reply/draft policy below — these are explicit rules).
    fire_channel_event_automations(state, channel, &message);
    // Learn durable knowledge from the channel conversation into the general
    // memory (fire-and-forget), attributed to the CONTACT rather than the user.
    {
        let st = state.clone();
        let speaker = if message.sender_name.is_empty() {
            message.sender.clone()
        } else {
            message.sender_name.clone()
        };
        let speaker = if is_owner_message {
            None
        } else {
            Some(speaker)
        };
        let content = message.content.clone();
        tokio::spawn(async move {
            // thread_id=None: record_channel_message already stored the episode.
            learn_via_service_or_inline(
                &st,
                &content,
                "",
                "",
                None,
                None,
                speaker.as_deref(),
                None,
                local_first_memory::MemoryReuseEnvelope::normal(),
            )
            .await;
        });
    }
    match action {
        InboundAction::AutoReply | InboundAction::ApproveReply => {
            // ApproveReply: same draft, but routed to the USER for approval before sending.
            let approve_mode = matches!(action, InboundAction::ApproveReply);
            let st = state.clone();
            // Reply-target preference: phone-number JID (most reliable) > chat id
            // (WhatsApp @lid / Telegram chat id) > bare sender. Sending to a raw
            // @lid can ack-OK yet never deliver, so prefer the PN when present.
            let non_empty = |s: &String| !s.trim().is_empty();
            let reply_to = message
                .sender_pn
                .clone()
                .filter(&non_empty)
                .or_else(|| message.chat.clone().filter(&non_empty))
                .unwrap_or_else(|| message.sender.clone());
            let name = if message.sender_name.is_empty() {
                message.sender.clone()
            } else {
                message.sender_name.clone()
            };
            let content = message.content.clone();
            let sender = message.sender.clone();
            tokio::spawn(async move {
                let label = match channel {
                    "whatsapp" => "WhatsApp",
                    "telegram" => "Telegram",
                    other => other,
                };
                // The channel conversation is a first-class chat thread (M8): one
                // persistent thread per contact, tagged with its origin so the app
                // badges it. The agent runs on it with history + tools.
                let thread_id = match lock_store(&st) {
                    Ok(store) => match store.find_or_create_channel_thread(
                        &base_workspace_id(),
                        channel,
                        &sender,
                        &format!("{label} · {name}"),
                    ) {
                        Ok(thread) => {
                            let _ =
                                store.set_channel_thread_recipient(&thread.thread_id, &reply_to);
                            Some(thread.thread_id)
                        }
                        Err(_) => None,
                    },
                    Err(_) => None,
                };

                let Some(tid) = thread_id.as_deref() else {
                    eprintln!("channel/{channel}: no thread — dropping inbound from {reply_to}");
                    return;
                };
                let request_id = format!(
                    "channel_{}_{}",
                    now_epoch_secs(),
                    uuid::Uuid::new_v4().simple()
                );
                let assistant_message_id = format!("local_assistant_{request_id}");
                let input = local_first_task_runtime::broker::ChatTurnInput {
                    thread_id: tid.to_string(),
                    request_id,
                    assistant_message_id,
                    prompt: content,
                    visible_prompt: None,
                    images: Vec::new(),
                    attachments: None,
                    mode: None,
                    model: None,
                    source: local_first_task_runtime::broker::ChatTurnSource::Channel,
                    approval: if approve_mode {
                        local_first_task_runtime::broker::TurnApproval::Confirm
                    } else {
                        local_first_task_runtime::broker::TurnApproval::ReadOnly
                    },
                };
                let mut enqueued = false;
                for _ in 0..6u32 {
                    match enqueue_chat_turn_core(&st, &input) {
                        Ok(_) => {
                            enqueued = true;
                            break;
                        }
                        Err(local_first_task_runtime::broker::EnqueueError::ThreadBusy {
                            ..
                        }) => tokio::time::sleep(std::time::Duration::from_secs(3)).await,
                        Err(error) => {
                            eprintln!("channel/{channel}: enqueue failed for {reply_to}: {error}");
                            break;
                        }
                    }
                }
                if enqueued {
                    eprintln!("channel/{channel}: turn enqueued (broker) for {reply_to}");
                } else {
                    eprintln!(
                        "channel/{channel}: could not enqueue turn for {reply_to} (thread stayed busy)"
                    );
                }
            });
            Json(serde_json::json!({
                "action": if approve_mode { "approve_reply" } else { "auto_reply" }
            }))
        }
        // Draft surface in the chat UI is a follow-up; for now we recorded it.
        _ => Json(serde_json::json!({ "action": "draft" })),
    }
}

/// A channel address as a contact handle, e.g. "whatsapp:39333…" / "telegram:123".
/// Stored in a contact's `aliases` and used as the episode thread id, so the
/// contact card can pull its own conversation history.
pub(crate) fn contact_handle(channel: &str, sender: &str) -> String {
    format!("{channel}:{sender}")
}

/// Records an inbound channel message into memory: resolves (or creates) the
/// contact for this channel handle and stores the message as an episodic memory.
/// Resolution is alias-based: once two handles are merged onto one contact, future
/// messages from either channel attach to the same person.
/// "channel_{source}_{sender}" → (source, sender). Channel thread ids are minted by
/// find_or_create_channel_thread; sources ("whatsapp"/"telegram") never contain '_'.
pub(crate) fn parse_channel_thread_id(thread_id: &str) -> Option<(String, String)> {
    let rest = thread_id.strip_prefix("channel_")?;
    let (channel, sender) = rest.split_once('_')?;
    if channel.is_empty() || sender.is_empty() {
        return None;
    }
    Some((channel.to_string(), sender.to_string()))
}

/// Everything a channel turn needs to answer AS the right persona INSIDE the right
/// perimeter: who we're talking to, how to speak, and what we're allowed to use.
pub(crate) struct ContactTurnContext {
    pub(crate) name: String,
    pub(crate) tone_of_voice: String,
    pub(crate) persona_instructions: String,
    pub(crate) handles: Vec<String>,
    pub(crate) perimeter: chat_store::StoredPerimeter,
    /// Intersection with Project Access for the currently active project.
    /// Personal turns do not need a project grant.
    pub(crate) can_use_project_memory: bool,
    /// Pre-formatted "Laura (moglie)" entries; populated ONLY when the perimeter
    /// allows mentioning other contacts.
    pub(crate) relationships: Vec<String>,
}

/// Resolve the curated contact bound to a channel thread. Returns
/// `(perimeter context, is_owner)`: context is None for in-app threads, unknown
/// senders, and the user's own card; `is_owner` is true ONLY when the sender
/// resolves to the `is_self` card — it relaxes channel gates (e.g. browser clicks)
/// that exist to protect the user from OTHER people, not from themselves.
pub(crate) fn contact_turn_context(
    state: &AppState,
    thread_id: Option<&str>,
) -> (Option<ContactTurnContext>, bool) {
    let Some((channel, sender)) = thread_id.and_then(parse_channel_thread_id) else {
        return (None, false);
    };
    let Ok(store) = lock_store(state) else {
        return (None, false);
    };
    let Some(id) = store
        .contact_id_by_identity(&channel, &sender)
        .ok()
        .flatten()
    else {
        return (None, false);
    };
    let Some(contact) = store.contact_by_id(id).ok().flatten() else {
        return (None, false);
    };
    if contact.is_self {
        return (None, true);
    }
    let handles = store.contact_handles(id).unwrap_or_default();
    let perimeter = store.perimeter_or_default(id);
    let profile = store.resolve_profile_for(id, &channel);
    let tone_of_voice = if !contact.tone_of_voice.trim().is_empty() {
        contact.tone_of_voice.clone()
    } else {
        profile
            .as_ref()
            .map(|p| p.tone_of_voice.clone())
            .unwrap_or_default()
    };
    let persona_instructions = {
        let mut parts: Vec<String> = Vec::new();
        if let Some(p) = &profile
            && !p.instructions.trim().is_empty()
        {
            parts.push(p.instructions.trim().to_string());
        }
        if !contact.persona_instructions.trim().is_empty() {
            parts.push(contact.persona_instructions.trim().to_string());
        }
        parts.join(" ")
    };
    let relationships = if perimeter.can_see_contacts {
        store
            .relationships_for(id)
            .unwrap_or_default()
            .into_iter()
            .map(|r| format!("{} ({})", r.other_name, r.relationship_type))
            .collect()
    } else {
        Vec::new()
    };
    let active_workspace = gateway_memory_workspace_id();
    let can_use_project_memory = if active_workspace.as_str() == PERSONAL_WORKSPACE {
        true
    } else {
        let policy = resolve_project_contact_policy(
            active_workspace.as_str(),
            &format!("contact_{id}"),
            &channel,
            &perimeter,
            false,
        );
        policy.authorized && policy.can_use_project_memory
    };
    (
        Some(ContactTurnContext {
            name: contact.name,
            tone_of_voice,
            persona_instructions,
            handles,
            perimeter,
            can_use_project_memory,
            relationships,
        }),
        false,
    )
}

/// One-shot backfill (G2): retro-link existing memories to the entities they
/// mention, per workspace — the stored graph was born with two disconnected
/// layers (facts/preferences vs entities) because the write path never emitted
/// memory→entity edges. Idempotent twice over: the settings flag skips the pass,
/// and link_memory_mentions itself skips already-linked pairs.
pub(crate) fn backfill_mentions(state: &AppState) {
    if let Ok(store) = lock_store(state) {
        if store.flag("mentions_backfill_v1").ok().flatten().is_some() {
            return;
        }
    } else {
        return;
    }
    let user = gateway_memory_user_id();
    let mut workspaces: Vec<String> = vec![PERSONAL_WORKSPACE.to_string()];
    workspaces.extend(
        load_workspaces_file()
            .workspaces
            .into_iter()
            .map(|w| w.id)
            .filter(|id| id != PERSONAL_WORKSPACE),
    );
    let facade = memory_facade(state);
    let mut linked_scopes = 0usize;
    for id in workspaces {
        let workspace = MemoryWorkspaceId::new(id);
        let items: Vec<(MemoryRef, String)> = facade
            .list_memories_for_ui(&user, &workspace)
            .unwrap_or_default()
            .into_iter()
            .filter(|m| !matches!(m.status, MemoryStatus::Deleted | MemoryStatus::Rejected))
            .filter(|m| {
                matches!(
                    m.memory_type.as_str(),
                    "fact" | "preference" | "decision" | "goal"
                )
            })
            .map(|m| (m.reference, m.text))
            .collect();
        if items.is_empty() {
            continue;
        }
        link_memory_mentions(facade, &user, &workspace, &items);
        linked_scopes += 1;
    }
    eprintln!("mentions-backfill: completed on {linked_scopes} scopes");
    if let Ok(store) = lock_store(state) {
        let _ = store.set_flag("mentions_backfill_v1", "1");
    }
}

/// One-shot: unify the user's own fragmented identity into `person:self`. The user
/// shows up as several person nodes — a bare `person:<name>` plus the owner's channel
/// identities (`person:telegram:HANDLE`, `person:whatsapp:HANDLE`) that are NOT backed
/// by a curated contact (contacts are OTHER people; the owner isn't one). We fold them
/// all into self: their names + channel handles become self's aliases (so the channel
/// resolver maps inbound owner handles → self, no re-fragmentation), their edges are
/// re-pointed, and they're marked `merged_into` + tombstoned so regeneration's resurrect
/// never brings them back. Idempotent via a flag; runs before the startup regeneration.
pub(crate) fn unify_owner_identity(state: &AppState) {
    if let Ok(store) = lock_store(state) {
        if store
            .flag("owner_identity_unified_v1")
            .ok()
            .flatten()
            .is_some()
        {
            return;
        }
    } else {
        return;
    }
    let user = gateway_memory_user_id();
    let workspace = MemoryWorkspaceId::new(PERSONAL_WORKSPACE);
    // OTHER contacts' entity refs = real other people; never fold those into self.
    // The SELF contact (is_self) is the exception: its entity IS the owner and must
    // be unified too — collect its id so we can re-point it to person:self after.
    let mut other_contact_refs: std::collections::HashSet<String> = Default::default();
    let mut self_contact_ids: Vec<i64> = Vec::new();
    if let Ok(store) = lock_store(state)
        && let Ok(contacts) = store.list_contacts()
    {
        for c in contacts {
            if c.is_self {
                self_contact_ids.push(c.id);
            } else if let Some(r) = c.entity_ref {
                other_contact_refs.insert(r);
            }
        }
    }
    let contact_refs = other_contact_refs; // self-contact entities are mergeable
    let facade = memory_facade(state);
    let all = facade
        .list_entities_including_tombstoned(&user, &workspace)
        .unwrap_or_default();
    let Some(mut self_entity) = all
        .iter()
        .find(|(e, _)| e.canonical_key == "person:self")
        .map(|(e, _)| e.clone())
    else {
        if let Ok(store) = lock_store(state) {
            let _ = store.set_flag("owner_identity_unified_v1", "1");
        }
        return;
    };
    // Owner channel identities: channel-handle person entities NOT backing a contact.
    let owner_channel: Vec<MemoryEntity> = all
        .iter()
        .map(|(e, _)| e)
        .filter(|e| {
            (e.canonical_key.starts_with("person:telegram:")
                || e.canonical_key.starts_with("person:whatsapp:"))
                && !contact_refs.contains(&e.reference.to_string())
        })
        .cloned()
        .collect();
    let owner_names: std::collections::HashSet<String> = owner_channel
        .iter()
        .map(|e| e.name.trim().to_lowercase())
        .filter(|n| !n.is_empty())
        .collect();
    // Bare person nodes that share a name with an owner channel identity (e.g. the
    // plain "Fabio" node next to the channel "Fabio"s) — also the owner.
    let losers: Vec<MemoryEntity> = all
        .into_iter()
        .map(|(e, _)| e)
        .filter(|e| e.canonical_key != "person:self")
        .filter(|e| {
            owner_channel.iter().any(|o| o.reference == e.reference)
                || (e.entity_type == "person"
                    && !contact_refs.contains(&e.reference.to_string())
                    && owner_names.contains(&e.name.trim().to_lowercase()))
        })
        .collect();
    if losers.is_empty() {
        if let Ok(store) = lock_store(state) {
            let _ = store.set_flag("owner_identity_unified_v1", "1");
        }
        return;
    }
    // Build self's new alias set: every loser name + alias + channel handle.
    let mut aliases: std::collections::BTreeSet<String> =
        self_entity.aliases.iter().cloned().collect();
    let mut owner_name: Option<String> = None;
    for loser in &losers {
        if !loser.name.trim().is_empty() {
            aliases.insert(loser.name.trim().to_string());
            if owner_name.is_none() && !owner_names.is_empty() {
                owner_name = Some(loser.name.trim().to_string());
            }
        }
        for a in &loser.aliases {
            if !a.trim().is_empty() {
                aliases.insert(a.trim().to_string());
            }
        }
        if let Some(handle) = loser.canonical_key.strip_prefix("person:") {
            aliases.insert(handle.to_string());
        }
    }
    // Name the unified node after the owner (e.g. "Fabio") instead of the generic "Utente".
    if let Some(name) = owner_name {
        self_entity.name = name;
    }
    self_entity.aliases = aliases.into_iter().collect();
    let _ = facade.upsert_entity(&self_entity);
    let self_ref = self_entity.reference.clone();
    let mut merged = 0usize;
    for mut loser in losers {
        let _ = facade.repoint_relations(&loser.reference, &self_ref, &user, &workspace);
        if let serde_json::Value::Object(map) = &mut loser.metadata {
            map.insert(
                "merged_into".to_string(),
                serde_json::Value::String(self_ref.to_string()),
            );
        } else {
            loser.metadata = serde_json::json!({ "merged_into": self_ref.to_string() });
        }
        let _ = facade.upsert_entity(&loser);
        let _ = facade.tombstone_entity(
            &loser.reference,
            &user,
            &workspace,
            "merged into self (owner)",
        );
        merged += 1;
    }
    // The self-contact pointed at one of the merged entities — re-point it to the
    // unified person:self so the address book's "you" card resolves to one node.
    if let Ok(store) = lock_store(state) {
        for id in &self_contact_ids {
            let _ = store.set_contact_entity_ref(*id, &self_ref.to_string());
        }
        let _ = store.set_flag("owner_identity_unified_v1", "1");
    }
    eprintln!("owner-unify: {merged} owner identities merged into person:self");
}

/// Startup graph regeneration (the completeness INVARIANT): on EVERY launch,
/// rebuild the auto-derived `mentions` edges of each scope from the live facts and
/// drop orphan entities. Ungated on purpose — the old one-shot `graph_sweep_v1`
/// flag left the graph stale whenever new entities/memories appeared after the
/// single run (e.g. "Jannik Sinner" created later → never linked). Running it every
/// boot is cheap at this scale and guarantees the structural layer is always whole.
pub(crate) fn sweep_graph_on_startup(state: &AppState) {
    let mut workspaces: Vec<String> = vec![PERSONAL_WORKSPACE.to_string()];
    workspaces.extend(
        load_workspaces_file()
            .workspaces
            .into_iter()
            .map(|w| w.id)
            .filter(|id| id != PERSONAL_WORKSPACE),
    );
    for id in workspaces {
        regenerate_graph_links(state, &MemoryWorkspaceId::new(id));
    }
    eprintln!("graph-regen: startup regeneration completed");
}

/// One-shot migration: seed the curated `contacts` table from existing `person`
/// memory entities that have a channel handle (real channel contacts). Mention-only
/// persons (no handle, e.g. "Jannik Sinner") are NOT imported — that's the bug fix.
/// Idempotent via a settings flag; read-only on the memory DB.
pub(crate) fn backfill_contacts(state: &AppState) {
    // Already done?
    if let Ok(store) = lock_store(state) {
        if store.flag("contacts_backfill_v1").ok().flatten().is_some() {
            return;
        }
    } else {
        return;
    }
    let user = gateway_memory_user_id();
    let workspace = MemoryWorkspaceId::new(PERSONAL_WORKSPACE);
    let entities = {
        let facade = memory_facade(state);
        facade
            .list_entities_for_ui(&user, &workspace)
            .unwrap_or_default()
    };
    let Ok(store) = lock_store(state) else {
        return;
    };
    for entity in entities.into_iter().filter(|e| e.entity_type == "person") {
        let handles: Vec<String> = contact_handles(&entity)
            .into_iter()
            .filter(|h| h.contains(':'))
            .collect();
        if handles.is_empty() {
            continue; // mention-only person — not a contact
        }
        let contact_type = {
            let t = contact_meta_str(&entity.metadata, "contact_type");
            if t.is_empty() {
                "unknown".to_string()
            } else {
                t
            }
        };
        let notes = contact_meta_str(&entity.metadata, "notes");
        let is_self = contact_is_self(&entity);
        // Reuse a contact already owning one of these handles (idempotency); else create.
        let existing = handles.iter().find_map(|h| {
            h.split_once(':')
                .and_then(|(ch, id)| store.contact_id_by_identity(ch, id).ok().flatten())
        });
        let contact_id = match existing {
            Some(id) => id,
            None => match store.create_contact(
                &entity.name,
                &contact_type,
                is_self,
                &notes,
                Some(&entity.reference.to_string()),
            ) {
                Ok(id) => id,
                Err(_) => continue,
            },
        };
        for handle in &handles {
            if let Some((ch, ident)) = handle.split_once(':') {
                let _ = store.add_identity(contact_id, ch, ident, None);
            }
        }
    }
    let _ = store.set_flag("contacts_backfill_v1", "1");
}

pub(crate) fn ensure_owner_self_entity(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    handle: &str,
    display: &str,
) -> Option<MemoryRef> {
    let existing = facade
        .list_entities_for_ui(user, workspace)
        .ok()
        .and_then(|entities| {
            entities
                .into_iter()
                .find(|e| e.canonical_key == "person:self")
        });
    let mut entity = existing.unwrap_or_else(|| MemoryEntity {
        reference: MemoryRef::generated(MemoryRefKind::Entity, user.clone(), workspace.clone()),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        entity_type: "person".to_string(),
        name: "Tu".to_string(),
        canonical_key: "person:self".to_string(),
        aliases: Vec::new(),
        privacy_domain: PrivacyDomain::new("personal"),
        sensitivity: MemoryDataSensitivity::Private,
        metadata: serde_json::json!({ "self": true }),
    });
    let mut aliases: std::collections::BTreeSet<String> = entity
        .aliases
        .iter()
        .filter(|a| !a.trim().is_empty())
        .cloned()
        .collect();
    aliases.insert(handle.to_string());
    if !display.trim().is_empty() && display.trim() != handle {
        aliases.insert(display.trim().to_string());
        if entity.name == "Tu" || entity.name.trim().is_empty() {
            entity.name = display.trim().to_string();
        }
    }
    entity.aliases = aliases.into_iter().collect();
    if let serde_json::Value::Object(map) = &mut entity.metadata {
        map.insert("self".to_string(), serde_json::Value::Bool(true));
        map.insert(
            "source".to_string(),
            serde_json::Value::String("owner_channel".to_string()),
        );
    } else {
        entity.metadata = serde_json::json!({ "self": true, "source": "owner_channel" });
    }
    let reference = entity.reference.clone();
    facade.upsert_entity(&entity).ok()?;
    Some(reference)
}

pub(crate) fn record_channel_message(
    state: &AppState,
    channel: &str,
    message: &ChannelInbound,
    is_owner: bool,
) {
    let display = if message.sender_name.is_empty() {
        message.sender.clone()
    } else {
        message.sender_name.clone()
    };
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let workspace = MemoryWorkspaceId::new(PERSONAL_WORKSPACE);
    let handle = contact_handle(channel, &message.sender);
    let owner_ref = if is_owner {
        ensure_owner_self_entity(facade, &user, &workspace, &handle, &display)
    } else {
        None
    };
    let owner_ref_string = owner_ref.as_ref().map(|reference| reference.to_string());
    // Curated contact book (separate lock, released before the memory work below):
    // someone who actually messages us IS a contact. If the sender is the owner,
    // the row is marked self and points at person:self instead of creating a
    // duplicate external Fabio.
    if let Ok(store) = lock_store(state) {
        let _ = store.ensure_contact_for_identity(
            channel,
            &message.sender,
            &display,
            is_owner,
            owner_ref_string.as_deref(),
        );
    }
    let label = match channel {
        "whatsapp" => "WhatsApp",
        "telegram" => "Telegram",
        other => other,
    };

    // Resolve: a person whose aliases already include this handle (e.g. after a
    // manual merge) or whose canonical_key is this handle's contact key.
    let existing = facade
        .list_entities_for_ui(&user, &workspace)
        .ok()
        .and_then(|entities| {
            entities.into_iter().find(|e| {
                e.entity_type == "person"
                    && (e.aliases.iter().any(|a| a == &handle)
                        || e.canonical_key == format!("person:{handle}"))
            })
        });

    if is_owner {
        // Owner channel handles are aliases of person:self; they must not create
        // channel-keyed person nodes.
    } else {
        match existing {
            Some(mut contact) => {
                // Keep the handle recorded; don't clobber a user-curated name/type.
                if !contact.aliases.iter().any(|a| a == &handle) {
                    contact.aliases.push(handle.clone());
                    let _ = facade.upsert_entity(&contact);
                }
            }
            None => {
                persist_graph(
                    facade,
                    &user,
                    &workspace,
                    vec![ExtractedEntity {
                        entity_type: "person".to_string(),
                        name: display.clone(),
                        canonical_key: format!("person:{handle}"),
                        aliases: vec![handle.clone()],
                        privacy_domain: PrivacyDomain::new("personal"),
                        sensitivity: MemoryDataSensitivity::Private,
                        metadata: serde_json::json!({ "contact_type": "unknown" }),
                    }],
                    Vec::new(),
                    None,
                );
            }
        }
    }

    store_episode(
        facade,
        &user,
        &handle,
        &format!("{label} da {display}: {}", message.content),
        PERSONAL_WORKSPACE,
    );
}

/// Generates a short reply to an inbound channel message. The content is treated
/// strictly as untrusted data (no instruction-following, no tools).
/// Builds a chat message for a channel thread (user inbound or assistant reply).
pub(crate) fn channel_chat_message(role: &str, text: &str) -> ChatMessage {
    ChatMessage {
        id: format!("msg_{}_{}", now_epoch_secs(), uuid::Uuid::new_v4().simple()),
        role: role.to_string(),
        text: text.to_string(),
        timestamp: now_epoch_secs().to_string(),
        metadata: None,
        metrics: None,
        feedback: None,
        saved_memory_ref: None,
        linked_task_id: None,
        linked_automation_ref: None,
        attachments: Vec::new(),
        event_parts: Vec::new(),
        memory_reuse: None,
        delivery_state: local_first_desktop_gateway::MessageDeliveryState::Delivered,
    }
}

pub(crate) fn channel_chat_message_with_id(
    role: &str,
    text: &str,
    message_id: &str,
) -> ChatMessage {
    let mut message = channel_chat_message(role, text);
    message.id = message_id.to_string();
    message
}
