use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use axum::routing::get;
use axum::Router;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

use super::super::server::AppState;

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/channels/test", axum::routing::post(test_channel))
        .route(
            "/v1/channels/{name}/start",
            axum::routing::post(start_channel),
        )
        .route("/v1/channels/whatsapp/pair", get(ws_whatsapp_pair))
}

// Legacy get_channel, configure_channel, deactivate_channel removed.
// Channel configuration is now managed via /api/v1/gateways (DB-backed).

// ── Test / Start / Pairing ────────────────────────────────────────

#[derive(Deserialize)]
struct ChannelTestRequest {
    name: String,
    token: Option<String>,
    /// If provided, try vault key `gateway.{id}.token` before legacy key.
    gateway_id: Option<i64>,
}

#[derive(Serialize)]
struct ChannelTestResponse {
    ok: bool,
    message: String,
}

/// Resolve a token: prefer explicit value, then gateway vault key, then legacy channel key.
fn resolve_test_token(
    explicit: &Option<String>,
    gateway_id: Option<i64>,
    channel_type: &str,
) -> Option<String> {
    // Explicit token from the request
    if let Some(t) = explicit {
        if !t.is_empty() {
            return Some(t.clone());
        }
    }
    // Gateway vault key
    if let Some(gw_id) = gateway_id {
        if let Ok(secrets) = crate::storage::global_secrets() {
            let key = crate::storage::SecretKey::gateway_token(gw_id);
            if let Ok(Some(t)) = secrets.get(&key) {
                return Some(t);
            }
        }
    }
    // Legacy channel vault key
    crate::storage::global_secrets().ok().and_then(|s| {
        let key = crate::storage::SecretKey::channel_token(channel_type);
        s.get(&key).ok().flatten()
    })
}

async fn test_channel(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ChannelTestRequest>,
) -> Json<ChannelTestResponse> {
    match req.name.as_str() {
        "telegram" => {
            let token = resolve_test_token(&req.token, req.gateway_id, "telegram");

            let Some(token) = token else {
                return Json(ChannelTestResponse {
                    ok: false,
                    message: "No token provided or stored".to_string(),
                });
            };

            // Call Telegram getMe API
            let url = format!("https://api.telegram.org/bot{}/getMe", token);
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default();

            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    #[derive(Deserialize)]
                    struct TgResponse {
                        ok: bool,
                        result: Option<TgUser>,
                    }
                    #[derive(Deserialize)]
                    struct TgUser {
                        username: Option<String>,
                        first_name: Option<String>,
                    }

                    match resp.json::<TgResponse>().await {
                        Ok(tg) if tg.ok => {
                            let name = tg
                                .result
                                .map(|u| {
                                    u.username
                                        .unwrap_or_else(|| u.first_name.unwrap_or_default())
                                })
                                .unwrap_or_default();
                            Json(ChannelTestResponse {
                                ok: true,
                                message: format!("Connected as @{}", name),
                            })
                        }
                        _ => Json(ChannelTestResponse {
                            ok: false,
                            message: "Invalid response from Telegram".to_string(),
                        }),
                    }
                }
                Ok(resp) => Json(ChannelTestResponse {
                    ok: false,
                    message: format!("Telegram returned {}", resp.status()),
                }),
                Err(e) => Json(ChannelTestResponse {
                    ok: false,
                    message: format!("Connection failed: {}", e),
                }),
            }
        }
        "discord" => {
            let token = resolve_test_token(&req.token, req.gateway_id, "discord");

            match token {
                Some(t) if t.len() > 20 => Json(ChannelTestResponse {
                    ok: true,
                    message: "Token format looks valid".to_string(),
                }),
                Some(_) => Json(ChannelTestResponse {
                    ok: false,
                    message: "Token too short -- check your Discord bot token".to_string(),
                }),
                None => Json(ChannelTestResponse {
                    ok: false,
                    message: "No token provided or stored".to_string(),
                }),
            }
        }
        "whatsapp" => {
            let config = state.config.read().await;
            let db_exists = config.channels.whatsapp.resolved_db_path().exists();
            let has_phone = !config.channels.whatsapp.phone_number.is_empty();
            drop(config);

            if db_exists && has_phone {
                Json(ChannelTestResponse {
                    ok: true,
                    message: "Session exists -- WhatsApp is paired".to_string(),
                })
            } else if has_phone {
                Json(ChannelTestResponse {
                    ok: false,
                    message: "Phone configured but not paired yet".to_string(),
                })
            } else {
                Json(ChannelTestResponse {
                    ok: false,
                    message: "Not configured -- enter phone number and pair".to_string(),
                })
            }
        }
        "slack" => {
            let token = resolve_test_token(&req.token, req.gateway_id, "slack");

            let Some(token) = token else {
                return Json(ChannelTestResponse {
                    ok: false,
                    message: "No token provided or stored".to_string(),
                });
            };

            // Call Slack auth.test API
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default();

            match client
                .get("https://slack.com/api/auth.test")
                .bearer_auth(&token)
                .send()
                .await
            {
                Ok(resp) => {
                    #[derive(Deserialize)]
                    struct SlackAuth {
                        ok: bool,
                        user: Option<String>,
                        team: Option<String>,
                        error: Option<String>,
                    }
                    match resp.json::<SlackAuth>().await {
                        Ok(auth) if auth.ok => {
                            let user = auth.user.unwrap_or_default();
                            let team = auth.team.unwrap_or_default();
                            Json(ChannelTestResponse {
                                ok: true,
                                message: format!("Connected as {} in {}", user, team),
                            })
                        }
                        Ok(auth) => Json(ChannelTestResponse {
                            ok: false,
                            message: format!(
                                "Slack auth failed: {}",
                                auth.error.unwrap_or_else(|| "unknown error".into())
                            ),
                        }),
                        Err(e) => Json(ChannelTestResponse {
                            ok: false,
                            message: format!("Failed to parse Slack response: {}", e),
                        }),
                    }
                }
                Err(e) => Json(ChannelTestResponse {
                    ok: false,
                    message: format!("Connection failed: {}", e),
                }),
            }
        }
        "email" => {
            let config = state.config.read().await;
            let imap_host = config.channels.email.imap_host.clone();
            let imap_port = config.channels.email.imap_port;
            let smtp_host = config.channels.email.smtp_host.clone();
            let username = config.channels.email.username.clone();
            let password_stored = config.channels.email.password.clone();
            drop(config);

            if imap_host.is_empty() {
                return Json(ChannelTestResponse {
                    ok: false,
                    message: "IMAP host is required".to_string(),
                });
            }
            if username.is_empty() {
                return Json(ChannelTestResponse {
                    ok: false,
                    message: "Username is required".to_string(),
                });
            }

            // Resolve password from vault if encrypted
            let has_password = if password_stored == "***ENCRYPTED***" {
                crate::storage::global_secrets()
                    .ok()
                    .and_then(|s| {
                        let key = crate::storage::SecretKey::channel_token("email");
                        s.get(&key).ok().flatten()
                    })
                    .is_some()
            } else {
                !password_stored.is_empty()
            };

            if !has_password {
                return Json(ChannelTestResponse {
                    ok: false,
                    message: "No password configured".to_string(),
                });
            }

            // Test TCP connection to IMAP server
            match tokio::time::timeout(
                std::time::Duration::from_secs(10),
                tokio::net::TcpStream::connect(format!("{}:{}", imap_host, imap_port)),
            )
            .await
            {
                Ok(Ok(_)) => {
                    let smtp_status = if !smtp_host.is_empty() {
                        " SMTP configured."
                    } else {
                        " SMTP not configured (send disabled)."
                    };
                    Json(ChannelTestResponse {
                        ok: true,
                        message: format!(
                            "IMAP reachable at {}:{}.{}",
                            imap_host, imap_port, smtp_status
                        ),
                    })
                }
                Ok(Err(e)) => Json(ChannelTestResponse {
                    ok: false,
                    message: format!("Cannot reach {}:{} -- {}", imap_host, imap_port, e),
                }),
                Err(_) => Json(ChannelTestResponse {
                    ok: false,
                    message: format!("Connection to {}:{} timed out (10s)", imap_host, imap_port),
                }),
            }
        }
        "web" => Json(ChannelTestResponse {
            ok: true,
            message: "Web UI is running".to_string(),
        }),
        _ => Json(ChannelTestResponse {
            ok: false,
            message: "Unknown channel".to_string(),
        }),
    }
}

// ═══════════════════════════════════════════════════
// WhatsApp Pairing -- WebSocket endpoint
// ═══════════════════════════════════════════════════

/// Hot-start a channel that was configured/paired while the gateway is running.
async fn start_channel(
    Path(name): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let tx = state
        .channel_cmd_tx
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    tx.send(crate::agent::gateway::ChannelCommand::Start {
        channel: name.clone(),
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(
        serde_json::json!({ "ok": true, "message": format!("Start command sent for {name}") }),
    ))
}

/// 2. Server starts wa-rs bot with `with_pair_code()`
/// 3. Server sends events:
///    - `{ "type": "pairing_code", "code": "ABCD-EFGH", "timeout": 60 }`
///    - `{ "type": "paired" }`
///    - `{ "type": "connected" }`
///    - `{ "type": "error", "message": "..." }`
async fn ws_whatsapp_pair(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_whatsapp_pairing(socket, state))
}

async fn handle_whatsapp_pairing(socket: WebSocket, state: Arc<AppState>) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Step 1: wait for { "phone": "..." } from client
    let phone = loop {
        match ws_receiver.next().await {
            Some(Ok(Message::Text(text))) => {
                let text = text.to_string();
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(phone) = parsed.get("phone").and_then(|v| v.as_str()) {
                        if !phone.is_empty() {
                            break phone.to_string();
                        }
                    }
                }
                let err =
                    serde_json::json!({"type": "error", "message": "Send {\"phone\": \"number\"}"});
                let _ = ws_sender.send(Message::Text(err.to_string().into())).await;
            }
            Some(Ok(Message::Close(_))) | None => return,
            _ => continue,
        }
    };

    tracing::info!(phone = %phone, "WhatsApp pairing started via WebSocket");

    // Step 2: resolve DB path from config
    let db_path = {
        let config = state.config.read().await;
        config.channels.whatsapp.resolved_db_path()
    };

    // Ensure parent directory exists
    if let Some(parent) = db_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            let msg = serde_json::json!({"type": "error", "message": format!("Cannot create directory: {e}")});
            let _ = ws_sender.send(Message::Text(msg.to_string().into())).await;
            return;
        }
    }

    // Step 3: start wa-rs bot with pair code
    // Note: wa-rs now handles stale sessions internally -- when with_pair_code() is set,
    // it clears the device identity so the handshake uses registration instead of login.
    // Bridge events from wa-rs callback -> mpsc -> WebSocket
    let (_event_tx, mut event_rx) = tokio::sync::mpsc::channel::<serde_json::Value>(16);

    #[cfg(feature = "channel-whatsapp")]
    let bot_handle = {
        let pair_phone = phone.clone();
        let db_path_str = db_path.to_string_lossy().to_string();
        let event_tx = _event_tx; // Use the sender
        tokio::spawn(async move { run_whatsapp_pair_bot(pair_phone, db_path_str, event_tx).await })
    };

    #[cfg(not(feature = "channel-whatsapp"))]
    let bot_handle = tokio::spawn(async {
        // WhatsApp not available without channel-whatsapp feature
    });

    // Step 4: Forward events to WebSocket
    let state_for_save = state.clone();
    let phone_for_save = phone.clone();

    loop {
        tokio::select! {
            // Event from wa-rs bot
            event = event_rx.recv() => {
                match event {
                    Some(msg) => {
                        let is_done = msg.get("type").and_then(|v| v.as_str()) == Some("paired")
                            || msg.get("type").and_then(|v| v.as_str()) == Some("connected");

                        if ws_sender.send(Message::Text(msg.to_string().into())).await.is_err() {
                            break; // WebSocket closed
                        }

                        // On successful pairing, update config
                        if msg.get("type").and_then(|v| v.as_str()) == Some("paired") {
                            let mut config = state_for_save.config.read().await.clone();
                            config.channels.whatsapp.phone_number = phone_for_save.clone();
                            config.channels.whatsapp.enabled = true;
                            let _ = state_for_save.save_config(config).await;

                            // Hot-start the WhatsApp channel in the running gateway
                            if let Some(tx) = &state_for_save.channel_cmd_tx {
                                let _ = tx.send(crate::agent::gateway::ChannelCommand::Start {
                                    channel: "whatsapp".into(),
                                }).await;
                            }

                            // Send done message
                            let done = serde_json::json!({"type": "done"});
                            let _ = ws_sender.send(Message::Text(done.to_string().into())).await;
                        }

                        if is_done {
                            // Give the client a moment to process, then close
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            break;
                        }
                    }
                    None => break, // Channel closed (bot finished or errored)
                }
            }
            // Client message (close or cancel)
            client_msg = ws_receiver.next() => {
                match client_msg {
                    Some(Ok(Message::Close(_))) | None => {
                        bot_handle.abort();
                        break;
                    }
                    _ => {} // Ignore other client messages during pairing
                }
            }
        }
    }

    // Cleanup: abort bot if still running
    bot_handle.abort();
    tracing::info!(phone = %phone, "WhatsApp pairing WebSocket closed");
}

/// Run the wa-rs bot for pairing, sending events back via the channel.
/// This mirrors the TUI's `run_whatsapp_pairing()` logic.
#[cfg(feature = "channel-whatsapp")]
async fn run_whatsapp_pair_bot(
    phone: String,
    db_path: String,
    event_tx: tokio::sync::mpsc::Sender<serde_json::Value>,
) {
    use wa_rs::bot::Bot;
    use wa_rs::store::SqliteStore;
    use wa_rs_core::types::events::Event as WaEvent;
    use wa_rs_proto::whatsapp as wa;
    use wa_rs_tokio_transport::TokioWebSocketTransportFactory;
    use wa_rs_ureq_http::UreqHttpClient;

    let backend = match SqliteStore::new(&db_path).await {
        Ok(store) => Arc::new(store),
        Err(e) => {
            let msg = serde_json::json!({"type": "error", "message": format!("WhatsApp store error: {e}")});
            let _ = event_tx.send(msg).await;
            return;
        }
    };

    let transport_factory = TokioWebSocketTransportFactory::new();
    let http_client = UreqHttpClient::new();
    let tx = event_tx.clone();

    let bot = Bot::builder()
        .with_backend(backend)
        .with_transport_factory(transport_factory)
        .with_http_client(http_client)
        .with_device_props(
            Some("Linux".to_string()),
            None,
            Some(wa::device_props::PlatformType::Chrome),
        )
        .with_pair_code(wa_rs::pair_code::PairCodeOptions {
            phone_number: phone,
            ..Default::default()
        })
        .skip_history_sync()
        .on_event(move |event, _client| {
            let tx = tx.clone();
            async move {
                let msg = match event {
                    WaEvent::PairingCode { code, timeout } => Some(serde_json::json!({
                        "type": "pairing_code",
                        "code": code,
                        "timeout": timeout.as_secs()
                    })),
                    WaEvent::PairSuccess(_) => Some(serde_json::json!({"type": "paired"})),
                    WaEvent::PairError(err) => Some(serde_json::json!({
                        "type": "error",
                        "message": format!("{}", err.error)
                    })),
                    WaEvent::Connected(_) => Some(serde_json::json!({"type": "connected"})),
                    WaEvent::LoggedOut(_) => Some(serde_json::json!({
                        "type": "error",
                        "message": "Logged out"
                    })),
                    _ => None,
                };
                if let Some(msg) = msg {
                    let _ = tx.send(msg).await;
                }
            }
        })
        .build()
        .await;

    let mut bot = match bot {
        Ok(b) => b,
        Err(e) => {
            let msg = serde_json::json!({"type": "error", "message": format!("Failed to build WhatsApp bot: {e}")});
            let _ = event_tx.send(msg).await;
            return;
        }
    };

    match bot.run().await {
        Ok(handle) => {
            let _ = handle.await;
        }
        Err(e) => {
            let msg = serde_json::json!({"type": "error", "message": format!("Failed to start WhatsApp bot: {e}")});
            let _ = event_tx.send(msg).await;
        }
    }
}
