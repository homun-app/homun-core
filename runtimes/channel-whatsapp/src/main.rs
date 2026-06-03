//! WhatsApp channel bridge (C1): connect via wa-rs, show the pairing QR in the
//! terminal, persist the session, and write a small status file the gateway can
//! read. Outbound send (C2) and inbound → gateway forwarding (C3) come next.
//!
//! Mirrors the canonical wa-rs example (`builder → on_event → build → run`) to
//! stay close to a known-compiling shape.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use wa_rs::bot::Bot;
use wa_rs::pair_code::PairCodeOptions;
use wa_rs::store::SqliteStore;
use wa_rs::{Client, Jid};
use wa_rs_core::proto_helpers::MessageExt;
use wa_rs_core::types::events::Event;
use wa_rs_proto::whatsapp as wa;
use wa_rs_tokio_transport::TokioWebSocketTransportFactory;
use wa_rs_ureq_http::UreqHttpClient;

/// Connection state the gateway reads to drive the UI (QR / connected).
#[derive(Default, Serialize)]
struct Status {
    connected: bool,
    needs_pairing: bool,
    /// The raw QR payload when pairing via QR (the UI renders it as an image).
    qr: Option<String>,
    /// The 8-char code to enter on the phone when pairing via phone number.
    pair_code: Option<String>,
}

fn data_dir() -> PathBuf {
    let base = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(".local-first-personal-assistant");
    let _ = std::fs::create_dir_all(&base);
    base
}

fn status_path() -> PathBuf {
    std::env::var("WA_STATUS_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir().join("channel-whatsapp-status.json"))
}

fn session_db() -> String {
    std::env::var("WA_SESSION_DB")
        .unwrap_or_else(|_| data_dir().join("whatsapp-session.db").display().to_string())
}

fn write_status(status: &Status) {
    if let Ok(json) = serde_json::to_string_pretty(status) {
        let _ = std::fs::write(status_path(), json);
    }
}

fn print_qr(code: &str) {
    match qrcode::QrCode::new(code.as_bytes()) {
        Ok(qr) => {
            let rendered = qr
                .render::<qrcode::render::unicode::Dense1x2>()
                .quiet_zone(true)
                .build();
            println!(
                "\n── WhatsApp: scansiona questo QR da Telefono ▸ Dispositivi collegati ──\n{rendered}\n"
            );
        }
        // Fall back to the raw payload so another tool can render it.
        Err(_) => println!("QR (payload grezzo): {code}"),
    }
}

/// Outbound send command from the gateway (C2).
#[derive(Deserialize)]
struct SendRequest {
    /// Phone number (international, no '+') or full JID user part.
    recipient: String,
    text: String,
}

async fn send_handler(
    State(client): State<Arc<Client>>,
    Json(request): Json<SendRequest>,
) -> StatusCode {
    let recipient = request.recipient.trim().trim_start_matches('+');
    let jid = Jid::new(recipient, "s.whatsapp.net");
    let message = wa::Message {
        conversation: Some(request.text),
        ..Default::default()
    };
    match client.send_message(jid, message).await {
        Ok(_) => StatusCode::OK,
        Err(error) => {
            eprintln!("invio fallito: {error}");
            StatusCode::BAD_GATEWAY
        }
    }
}

/// Tiny local HTTP server so the gateway can ask us to send messages (C2).
async fn serve_send(client: Arc<Client>, port: u16) {
    let app = Router::new()
        .route("/send", post(send_handler))
        .with_state(client);
    match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => {
            println!("sidecar: HTTP /send in ascolto su 127.0.0.1:{port}");
            if let Err(error) = axum::serve(listener, app).await {
                eprintln!("server HTTP terminato: {error}");
            }
        }
        Err(error) => eprintln!("impossibile aprire la porta {port}: {error}"),
    }
}

fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    runtime.block_on(async {
        let backend = Arc::new(
            SqliteStore::new(&session_db())
                .await
                .map_err(|e| anyhow::anyhow!("sessione SQLite: {e}"))?,
        );

        let status = Arc::new(Mutex::new(Status { needs_pairing: true, ..Default::default() }));
        write_status(&status.lock().unwrap());

        let handler_status = Arc::clone(&status);
        // Where to forward inbound messages (C3): the gateway passes its URL +
        // token when it spawns us.
        let gateway_url = std::env::var("WA_GATEWAY_URL").ok().filter(|s| !s.is_empty());
        let gateway_token = std::env::var("WA_GATEWAY_TOKEN").ok().filter(|s| !s.is_empty());
        let http = Arc::new(reqwest::Client::new());

        let mut builder = Bot::builder()
            .with_backend(backend)
            .with_transport_factory(TokioWebSocketTransportFactory::new())
            .with_http_client(UreqHttpClient::new());
        // Phone-number pairing (more reliable than scanning a terminal QR): set
        // WA_PAIR_PHONE to your number in international format WITHOUT '+' (e.g.
        // 39333xxxxxxx). You'll get an 8-char code to enter on the phone.
        if let Ok(phone) = std::env::var("WA_PAIR_PHONE") {
            let phone = phone.trim().trim_start_matches('+').to_string();
            if !phone.is_empty() {
                println!("Pairing via numero {phone}: ti darò un CODICE da inserire sul telefono.");
                builder = builder.with_pair_code(PairCodeOptions {
                    phone_number: phone,
                    ..Default::default()
                });
            }
        }
        let mut bot = builder
            .on_event(move |event, _client| {
                let status = Arc::clone(&handler_status);
                let http = Arc::clone(&http);
                let gateway_url = gateway_url.clone();
                let gateway_token = gateway_token.clone();
                async move {
                    match event {
                        // C3: forward incoming text messages to the gateway (which
                        // applies the C0 policy → memory + draft/auto-reply). Skip
                        // our own messages and groups (v1: direct chats only).
                        Event::Message(message, info) => {
                            // Direct text messages only (v1); skip our own + groups.
                            if info.source.is_from_me || info.source.is_group {
                                return;
                            }
                            let Some(text) = message.text_content() else {
                                return;
                            };
                            if let (Some(url), Some(token)) =
                                (gateway_url.as_ref(), gateway_token.as_ref())
                            {
                                let payload = serde_json::json!({
                                    "sender": info.source.sender.user,
                                    "sender_name": info.push_name,
                                    "content": text,
                                    "message_id": info.id.to_string(),
                                });
                                // Don't log message content (privacy): only the outcome.
                                if let Err(error) = http
                                    .post(format!("{url}/api/channels/whatsapp/inbound"))
                                    .bearer_auth(token)
                                    .json(&payload)
                                    .send()
                                    .await
                                {
                                    eprintln!("inbound: inoltro al gateway fallito: {error}");
                                }
                            }
                        }
                        Event::PairingQrCode { code, .. } => {
                            print_qr(&code);
                            let mut s = status.lock().unwrap();
                            s.connected = false;
                            s.needs_pairing = true;
                            s.qr = Some(code);
                            s.pair_code = None;
                            write_status(&s);
                        }
                        Event::PairingCode { code, .. } => {
                            println!(
                                "\n── WhatsApp: inserisci questo CODICE sul telefono ──\n   \
WhatsApp ▸ Dispositivi collegati ▸ Collega un dispositivo ▸ Collega con numero di telefono\n\n        {code}\n"
                            );
                            let mut s = status.lock().unwrap();
                            s.connected = false;
                            s.needs_pairing = true;
                            s.pair_code = Some(code);
                            s.qr = None;
                            write_status(&s);
                        }
                        Event::Connected(_) => {
                            let mut s = status.lock().unwrap();
                            s.connected = true;
                            s.needs_pairing = false;
                            s.qr = None;
                            s.pair_code = None;
                            write_status(&s);
                            println!("✅ WhatsApp connesso.");
                        }
                        Event::LoggedOut(_) => {
                            let mut s = status.lock().unwrap();
                            s.connected = false;
                            s.needs_pairing = true;
                            s.qr = None;
                            write_status(&s);
                            eprintln!("❌ WhatsApp disconnesso (logout): rifai il pairing.");
                        }
                        // Surface WHY pairing failed instead of a silent "impossibile collegare".
                        Event::PairError(err) => {
                            eprintln!("❌ Pairing fallito: {}", err.error);
                        }
                        Event::QrScannedWithoutMultidevice(_) => {
                            eprintln!(
                                "❌ QR scansionato ma l'account non è in modalità multi-dispositivo. \
Aggiorna WhatsApp sul telefono e riprova."
                            );
                        }
                        Event::ClientOutdated(_) => {
                            eprintln!(
                                "❌ ClientOutdated: WhatsApp ha rifiutato la versione del client. \
Serve impostare una versione recente con .with_version((2, 3000, <revision>))."
                            );
                        }
                        Event::ConnectFailure(_) => {
                            eprintln!("❌ ConnectFailure: handshake col server WhatsApp non riuscito.");
                        }
                        other => {
                            // Diagnostic: show that events flow + which kind arrive.
                            let dump = format!("{other:?}");
                            eprintln!("SIDECAR evt: {}", &dump[..dump.len().min(80)]);
                        }
                    }
                }
            })
            .build()
            .await
            .map_err(|e| anyhow::anyhow!("build bot: {e}"))?;

        // C2: expose /send for the gateway (uses the bot's client handle).
        let send_port: u16 = std::env::var("WA_HTTP_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(18766);
        tokio::spawn(serve_send(bot.client(), send_port));

        let handle = bot.run().await.map_err(|e| anyhow::anyhow!("avvio bot: {e}"))?;
        handle.await.map_err(|e| anyhow::anyhow!("task bot: {e}"))?;
        Ok::<(), anyhow::Error>(())
    })
}
