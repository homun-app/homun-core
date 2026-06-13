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
        .join(".homun");
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

/// Parse a recipient into a Jid. A full JID ("user[:device]@server", e.g. …@lid)
/// is parsed losslessly via FromStr — this preserves the device + the
/// LID-specific handling, matching wa-rs' own reply path
/// (MessageContext::send_message clones info.source.chat). A bare value is
/// treated as a phone number on the default user server.
fn parse_recipient(raw: &str) -> Result<Jid, String> {
    let recipient = raw.trim().trim_start_matches('+');
    if recipient.is_empty() {
        return Err("recipient vuoto".to_string());
    }
    if recipient.contains('@') {
        recipient.parse::<Jid>().map_err(|error| error.to_string())
    } else {
        Ok(Jid::pn(recipient))
    }
}

/// One inbound message to forward to the gateway. Built identically from the
/// live `Event::Message` path and the history-recovery `Event::HistorySync`
/// path so both get the SAME auto-reply treatment downstream.
struct InboundForward {
    /// Stable sender identifier (the PN/LID user part).
    sender: String,
    /// Push name when known (history messages may not carry one).
    sender_name: Option<String>,
    content: String,
    /// WhatsApp message-key id — the gateway dedups on `{channel}:{message_id}`.
    message_id: String,
    /// Reply target JID (Display form, round-trips via Jid::from_str).
    chat: String,
    /// Preferred reply target when present (PN > LID).
    sender_pn: Option<String>,
    /// Original message Unix-seconds timestamp, when known. Lets the gateway
    /// apply a defensive recency ceiling on the recovery path.
    ts: Option<u64>,
}

/// Forwards one inbound message to the gateway with the at-least-once retry
/// loop. Shared by the live and history-recovery paths so the payload + endpoint
/// + auth are byte-for-byte identical (only `ts` is added). Privacy: never logs
/// message content, only outcomes.
async fn forward_inbound(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    msg: &InboundForward,
) {
    let payload = serde_json::json!({
        "sender": msg.sender,
        "sender_name": msg.sender_name,
        "content": msg.content,
        "message_id": msg.message_id,
        "chat": msg.chat,
        "sender_pn": msg.sender_pn,
        "ts": msg.ts,
    });
    for attempt in 0..3u32 {
        match http
            .post(format!("{url}/api/channels/whatsapp/inbound"))
            .bearer_auth(token)
            .json(&payload)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => break,
            Ok(response) => eprintln!(
                "inbound: gateway ha risposto {} (tentativo {})",
                response.status(),
                attempt + 1
            ),
            Err(error) => eprintln!(
                "inbound: inoltro al gateway fallito (tentativo {}): {error}",
                attempt + 1
            ),
        }
        if attempt + 1 < 3 {
            tokio::time::sleep(std::time::Duration::from_secs(attempt as u64 + 1)).await;
        }
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
    let jid = match parse_recipient(&request.recipient) {
        Ok(jid) => jid,
        Err(error) => {
            eprintln!("recipient JID non valido: {error}");
            return StatusCode::BAD_REQUEST;
        }
    };
    let message = wa::Message {
        conversation: Some(request.text),
        ..Default::default()
    };
    // Log the *resolved* recipient JID so we can see exactly where a send went
    // (a transport Ok is not a delivery guarantee on WhatsApp).
    let target = jid.to_string();
    match client.send_message(jid, message).await {
        Ok(id) => {
            println!("invio ok → {target} (msg id {id})");
            StatusCode::OK
        }
        Err(error) => {
            eprintln!("invio fallito → {target}: {error}");
            StatusCode::BAD_GATEWAY
        }
    }
}

/// Chat-state command from the gateway: show/hide the "typing…" indicator while
/// a (slow) reply is being generated, so the sender sees the assistant working.
#[derive(Deserialize)]
struct PresenceRequest {
    recipient: String,
    /// "composing" (typing…) or "paused" (cleared).
    state: String,
}

async fn presence_handler(
    State(client): State<Arc<Client>>,
    Json(request): Json<PresenceRequest>,
) -> StatusCode {
    let jid = match parse_recipient(&request.recipient) {
        Ok(jid) => jid,
        Err(error) => {
            eprintln!("chatstate: recipient non valido: {error}");
            return StatusCode::BAD_REQUEST;
        }
    };
    let result = match request.state.as_str() {
        "composing" => client.chatstate().send_composing(&jid).await,
        "paused" => client.chatstate().send_paused(&jid).await,
        other => {
            eprintln!("chatstate: stato sconosciuto «{other}»");
            return StatusCode::BAD_REQUEST;
        }
    };
    match result {
        Ok(()) => StatusCode::OK,
        Err(error) => {
            eprintln!("chatstate fallita → {jid}: {error:?}");
            StatusCode::BAD_GATEWAY
        }
    }
}

/// Tiny local HTTP server so the gateway can ask us to send messages (C2) and
/// drive the typing indicator (/chatstate).
async fn serve_send(client: Arc<Client>, port: u16) {
    let app = Router::new()
        .route("/send", post(send_handler))
        .route("/chatstate", post(presence_handler))
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
    // SECURITY (data at rest): the WhatsApp session DB holds the credentials that
    // authenticate this account — born owner-only (0600), not world-readable.
    #[cfg(unix)]
    // SAFETY: libc::umask has no preconditions; called once before any file is created.
    unsafe {
        libc::umask(0o077 as libc::mode_t);
    }
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
                                // The phone-number (PN) address: for a LID-addressed
                                // chat, `sender_alt` carries the PN, which is the
                                // reliably-deliverable reply target (sending to a raw
                                // @lid can ack-OK yet never deliver).
                                let sender_pn =
                                    info.source.sender_alt.as_ref().map(|j| j.to_string());
                                println!(
                                    "inbound: chat={} mode={:?} sender_alt_present={}",
                                    info.source.chat,
                                    info.source.addressing_mode,
                                    sender_pn.is_some(),
                                );
                                // At-least-once forwarding. WhatsApp store-and-forward
                                // already delivered it to us, so (unlike Telegram)
                                // there's no offset to replay from — the retry loop
                                // just rides out a momentary gateway outage.
                                let forward = InboundForward {
                                    sender: info.source.sender.user.clone(),
                                    sender_name: Some(info.push_name.clone()),
                                    content: text.to_string(),
                                    message_id: info.id.to_string(),
                                    // Correct reply target via Display (preserves
                                    // device + @lid/@s.whatsapp.net) so the reply
                                    // round-trips losslessly through Jid::from_str.
                                    chat: info.source.chat.to_string(),
                                    sender_pn,
                                    // Live messages are by definition current; leave
                                    // ts unset so the gateway recency ceiling is a
                                    // no-op here (it only guards the recovery path).
                                    ts: None,
                                };
                                forward_inbound(&http, url, token, &forward).await;
                            }
                        }
                        // Offline message recovery: when this companion device was
                        // offline, messages delivered to the primary phone are
                        // re-synced here on reconnect. wa-rs surfaces them via
                        // HistorySync (enabled by default; we never call
                        // skip_history_sync). We mine recent direct-chat text and
                        // forward it through the SAME gateway path as live messages,
                        // so allowlist + auto-reply apply identically — with a recency
                        // guard so the initial months-long sync can't trigger a spam
                        // of replies, and the gateway's dedup so an already-handled
                        // live message that re-appears here is dropped.
                        Event::HistorySync(hs) => {
                            let (Some(url), Some(token)) =
                                (gateway_url.as_ref(), gateway_token.as_ref())
                            else {
                                return;
                            };
                            // Recency window (default 48h). The initial bootstrap
                            // sync carries months of history; we only want the
                            // recent offline window.
                            let recency_secs: u64 = std::env::var("WA_HISTORY_RECENCY_HOURS")
                                .ok()
                                .and_then(|v| v.parse::<u64>().ok())
                                .unwrap_or(48)
                                .saturating_mul(3600);
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .unwrap_or(0);
                            let cutoff = now.saturating_sub(recency_secs);

                            let mut considered = 0u32;
                            let mut forwarded = 0u32;
                            for conv in &hs.conversations {
                                // Conversation.id is the chat JID string. A group
                                // chat (…@g.us) is skipped wholesale (v1: direct
                                // chats only), mirroring the live filter.
                                if conv.id.ends_with("@g.us") {
                                    continue;
                                }
                                for entry in &conv.messages {
                                    let Some(wmi) = entry.message.as_ref() else {
                                        continue;
                                    };
                                    let key = &wmi.key;
                                    // Skip our own messages (same as the live filter).
                                    if key.from_me == Some(true) {
                                        continue;
                                    }
                                    // The chat JID: prefer the message-key remote_jid,
                                    // fall back to the conversation id.
                                    let chat_jid = key
                                        .remote_jid
                                        .as_deref()
                                        .filter(|s| !s.is_empty())
                                        .unwrap_or(conv.id.as_str());
                                    // Skip groups (per-message guard, belt-and-braces).
                                    if chat_jid.ends_with("@g.us") {
                                        continue;
                                    }
                                    considered += 1;
                                    // RECENCY GUARD (mandatory): drop anything older
                                    // than the window. Missing timestamps are treated
                                    // as too-old (we can't prove recency) and skipped.
                                    let Some(ts) = wmi.message_timestamp else {
                                        continue;
                                    };
                                    if ts < cutoff {
                                        continue;
                                    }
                                    // Text only — reuse the live extractor.
                                    let Some(inner) = wmi.message.as_ref() else {
                                        continue;
                                    };
                                    let Some(text) = inner.text_content() else {
                                        continue;
                                    };
                                    // The message-key id is what the gateway dedups
                                    // on; without it we can't dedup, so skip.
                                    let Some(message_id) =
                                        key.id.as_deref().filter(|s| !s.is_empty())
                                    else {
                                        continue;
                                    };
                                    // Derive sender as best the types allow: the chat
                                    // JID's user part is the direct-chat counterparty.
                                    // Prefer a phone-number JID as the reply target.
                                    let chat: Jid = match chat_jid.parse() {
                                        Ok(jid) => jid,
                                        Err(_) => continue,
                                    };
                                    let sender = chat.user.clone();
                                    let sender_pn = if chat.server == "s.whatsapp.net" {
                                        Some(chat.to_string())
                                    } else {
                                        None
                                    };
                                    let forward = InboundForward {
                                        sender,
                                        sender_name: wmi.push_name.clone(),
                                        content: text.to_string(),
                                        message_id: message_id.to_string(),
                                        chat: chat.to_string(),
                                        sender_pn,
                                        ts: Some(ts),
                                    };
                                    forward_inbound(&http, url, token, &forward).await;
                                    forwarded += 1;
                                }
                            }
                            println!(
                                "history-sync: type={} conv={} considered={} forwarded={}",
                                hs.sync_type,
                                hs.conversations.len(),
                                considered,
                                forwarded,
                            );
                        }
                        // Observability for the offline-recovery flow: log the
                        // server's offline-queue counts so we can correlate a burst
                        // of recovered messages with what the server said was queued.
                        Event::OfflineSyncPreview(preview) => {
                            println!(
                                "offline-sync preview: total={} messages={} notifications={} receipts={}",
                                preview.total,
                                preview.messages,
                                preview.notifications,
                                preview.receipts,
                            );
                        }
                        Event::OfflineSyncCompleted(done) => {
                            println!("offline-sync completed: count={}", done.count);
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
