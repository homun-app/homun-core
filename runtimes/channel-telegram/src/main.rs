//! Telegram channel bridge sidecar (frankenstein Bot API).
//!
//! Mirrors the WhatsApp sidecar's gateway protocol so the gateway can treat both
//! channels identically:
//! - long-poll Telegram `getUpdates` and forward inbound text to the gateway
//!   (`POST {gateway}/api/channels/telegram/inbound`);
//! - expose `POST /send` (outbound) and `POST /chatstate` (typing indicator).
//!
//! Telegram uses a bot token (from @BotFather) — no phone pairing. The Bot API
//! client is reqwest-based and light, so this stays a small standalone process.
//!
//! The markdown→HTML + message-splitting helpers are ported from Homun's
//! `channels/telegram.rs`.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use frankenstein::client_reqwest::Bot;
use frankenstein::methods::{
    AnswerCallbackQueryParams, GetUpdatesParams, SendChatActionParams, SendMessageParams,
};
use frankenstein::types::{
    AllowedUpdate, ChatAction, ChatId, ChatType, InlineKeyboardButton, InlineKeyboardMarkup,
    ReplyMarkup,
};
use frankenstein::updates::UpdateContent;
use frankenstein::{AsyncTelegramApi, ParseMode};
use serde::{Deserialize, Serialize};

const DEFAULT_HTTP_PORT: u16 = 18767;

/// Connection state the gateway reads to drive the UI.
#[derive(Default, Serialize)]
struct Status {
    connected: bool,
    /// The bot's @username once `getMe` succeeds (so the UI can show it).
    bot_username: Option<String>,
    /// Why the connection failed (e.g. invalid token), if it did.
    error: Option<String>,
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
    std::env::var("TG_STATUS_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir().join("channel-telegram-status.json"))
}

fn write_status(status: &Status) {
    if let Ok(json) = serde_json::to_string_pretty(status) {
        let _ = std::fs::write(status_path(), json);
    }
}

/// File holding the last-confirmed getUpdates offset, so a restart resumes from
/// where it left off instead of re-pulling (and re-executing) the whole backlog.
fn offset_path() -> PathBuf {
    std::env::var("TG_OFFSET_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir().join("telegram-offset"))
}

fn read_offset() -> u32 {
    std::fs::read_to_string(offset_path())
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0)
}

fn persist_offset(offset: u32) {
    let _ = std::fs::write(offset_path(), offset.to_string());
}

/// Outbound send command from the gateway.
#[derive(Deserialize)]
struct SendRequest {
    /// Telegram chat id (numeric).
    recipient: String,
    text: String,
    /// Optional inline keyboard: each entry is `[label, callback_data]`. When present the text
    /// is sent as a single block with tappable buttons (used for remote-approval cards).
    #[serde(default)]
    buttons: Vec<[String; 2]>,
}

async fn send_handler(State(bot): State<Arc<Bot>>, Json(request): Json<SendRequest>) -> StatusCode {
    let Ok(chat_id) = request.recipient.trim().parse::<i64>() else {
        eprintln!("recipient non valido (atteso chat_id numerico): {}", request.recipient);
        return StatusCode::BAD_REQUEST;
    };

    // Inline-keyboard message (approval card): a single block with tappable buttons.
    if !request.buttons.is_empty() {
        let row: Vec<InlineKeyboardButton> = request
            .buttons
            .iter()
            .map(|b| {
                InlineKeyboardButton::builder()
                    .text(b[0].clone())
                    .callback_data(b[1].clone())
                    .build()
            })
            .collect();
        let markup = InlineKeyboardMarkup::builder().inline_keyboard(vec![row]).build();
        let params = SendMessageParams::builder()
            .chat_id(ChatId::Integer(chat_id))
            .text(&request.text)
            .reply_markup(ReplyMarkup::InlineKeyboardMarkup(markup))
            .build();
        return match bot.send_message(&params).await {
            Ok(_) => StatusCode::OK,
            Err(error) => {
                eprintln!("invio con bottoni fallito → chat {chat_id}: {error:?}");
                StatusCode::BAD_GATEWAY
            }
        };
    }

    // Split to Telegram's 4096-char limit; render markdown as HTML with a
    // plain-text fallback if the HTML is rejected (matches Homun).
    for chunk in split_message(&request.text, 4000) {
        let html = markdown_to_html(&chunk);
        let params = SendMessageParams::builder()
            .chat_id(ChatId::Integer(chat_id))
            .text(&html)
            .parse_mode(ParseMode::Html)
            .build();
        if bot.send_message(&params).await.is_err() {
            let plain = SendMessageParams::builder()
                .chat_id(ChatId::Integer(chat_id))
                .text(&chunk)
                .build();
            if let Err(error) = bot.send_message(&plain).await {
                eprintln!("invio fallito → chat {chat_id}: {error:?}");
                return StatusCode::BAD_GATEWAY;
            }
        }
    }
    println!("invio ok → chat {chat_id}");
    StatusCode::OK
}

/// Typing indicator command from the gateway. Telegram's typing action expires
/// after ~5s on its own and is cleared when a message is sent, so "paused" is a
/// no-op (nothing to actively retract).
#[derive(Deserialize)]
struct PresenceRequest {
    recipient: String,
    state: String,
}

async fn presence_handler(
    State(bot): State<Arc<Bot>>,
    Json(request): Json<PresenceRequest>,
) -> StatusCode {
    let Ok(chat_id) = request.recipient.trim().parse::<i64>() else {
        eprintln!("chatstate: recipient non valido: {}", request.recipient);
        return StatusCode::BAD_REQUEST;
    };
    if request.state == "composing" {
        let params = SendChatActionParams::builder()
            .chat_id(ChatId::Integer(chat_id))
            .action(ChatAction::Typing)
            .build();
        let _ = bot.send_chat_action(&params).await;
    }
    StatusCode::OK
}

/// Local HTTP server so the gateway can push outbound messages + typing.
async fn serve_http(bot: Arc<Bot>, port: u16) {
    let app = Router::new()
        .route("/send", post(send_handler))
        .route("/chatstate", post(presence_handler))
        .with_state(bot);
    match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => {
            println!("sidecar telegram: HTTP /send in ascolto su 127.0.0.1:{port}");
            if let Err(error) = axum::serve(listener, app).await {
                eprintln!("server HTTP terminato: {error}");
            }
        }
        Err(error) => eprintln!("impossibile aprire la porta {port}: {error}"),
    }
}

/// Forward one inbound Telegram message to the gateway (direct chats only, v1).
/// Returns true when it is safe to ADVANCE the offset past this update: either
/// the message was delivered to the gateway, or there was nothing to deliver
/// (group/empty/no gateway configured). Returns false ONLY on a transient
/// delivery failure (gateway momentarily unreachable) so the caller re-fetches
/// the same update on the next poll instead of losing it.
async fn forward_inbound(
    http: &reqwest::Client,
    gateway_url: Option<&str>,
    gateway_token: Option<&str>,
    msg: frankenstein::types::Message,
) -> bool {
    // v1: direct chats only (parity with the WhatsApp bridge); skip groups.
    if matches!(msg.chat.type_field, ChatType::Group | ChatType::Supergroup) {
        return true;
    }
    let Some(text) = msg
        .text
        .as_deref()
        .or(msg.caption.as_deref())
        .filter(|t| !t.is_empty())
    else {
        return true;
    };
    let sender_id = msg
        .from
        .as_ref()
        .map(|u| u.id.to_string())
        .unwrap_or_default();
    let sender_name = msg
        .from
        .as_ref()
        .map(|u| {
            if !u.first_name.is_empty() {
                u.first_name.clone()
            } else {
                u.username.clone().unwrap_or_else(|| u.id.to_string())
            }
        })
        .unwrap_or_default();
    let chat_id = msg.chat.id.to_string();

    let (Some(url), Some(token)) = (gateway_url, gateway_token) else {
        return true;
    };
    let payload = serde_json::json!({
        "sender": sender_id,
        "sender_name": sender_name,
        "content": text,
        // Reply target = the chat id (numeric string).
        "chat": chat_id,
    });
    // At-least-once: retry a few times before giving up, so a momentary gateway
    // outage doesn't drop the message. Don't log message content (privacy).
    for attempt in 0..3u32 {
        match http
            .post(format!("{url}/api/channels/telegram/inbound"))
            .bearer_auth(token)
            .json(&payload)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return true,
            Ok(response) => eprintln!(
                "inbound: gateway ha risposto {} (tentativo {})",
                response.status(),
                attempt + 1
            ),
            Err(error) => {
                eprintln!("inbound: inoltro al gateway fallito (tentativo {}): {error}", attempt + 1)
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(attempt as u64 + 1)).await;
    }
    false
}

/// Forward an inline-button tap (remote approval) to the gateway. `from` = the tapping user's
/// id (== the private chat id), which the gateway checks against the configured self target.
async fn forward_callback(
    http: &reqwest::Client,
    gateway_url: Option<&str>,
    gateway_token: Option<&str>,
    cb: &frankenstein::types::CallbackQuery,
) {
    let (Some(url), Some(token)) = (gateway_url, gateway_token) else {
        return;
    };
    let payload = serde_json::json!({
        "from": cb.from.id.to_string(),
        "data": cb.data.clone().unwrap_or_default(),
    });
    let _ = http
        .post(format!("{url}/api/channels/telegram/callback"))
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await;
}

fn main() -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    runtime.block_on(async {
        let token = std::env::var("TG_BOT_TOKEN").unwrap_or_default();
        if token.trim().is_empty() {
            let status = Status {
                connected: false,
                error: Some("TG_BOT_TOKEN mancante".to_string()),
                ..Default::default()
            };
            write_status(&status);
            return Err(anyhow::anyhow!("TG_BOT_TOKEN mancante"));
        }

        let bot = Arc::new(Bot::new(&token));

        // Validate the token + fetch the bot identity.
        match bot.get_me().await {
            Ok(me) => {
                let status = Status {
                    connected: true,
                    bot_username: me.result.username,
                    error: None,
                };
                write_status(&status);
                println!("✅ Telegram connesso.");
            }
            Err(error) => {
                let status = Status {
                    connected: false,
                    error: Some(format!("getMe fallito: {error:?}")),
                    ..Default::default()
                };
                write_status(&status);
                return Err(anyhow::anyhow!("getMe fallito: {error:?}"));
            }
        }

        // Expose /send + /chatstate for the gateway.
        let port: u16 = std::env::var("TG_HTTP_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(DEFAULT_HTTP_PORT);
        tokio::spawn(serve_http(bot.clone(), port));

        // Where to forward inbound messages.
        let gateway_url = std::env::var("TG_GATEWAY_URL").ok().filter(|s| !s.is_empty());
        let gateway_token = std::env::var("TG_GATEWAY_TOKEN").ok().filter(|s| !s.is_empty());
        let http = reqwest::Client::new();

        // Long-polling loop. Resume from the persisted offset so a restart picks
        // up exactly where it left off (messages sent while down are still held
        // by Telegram's servers ~24h and get re-fetched here).
        let mut offset: u32 = read_offset();
        loop {
            let params = GetUpdatesParams {
                offset: Some(offset as i64),
                limit: Some(100),
                timeout: Some(60),
                allowed_updates: Some(vec![
                    AllowedUpdate::Message,
                    AllowedUpdate::CallbackQuery,
                ]),
            };
            match bot.get_updates(&params).await {
                Ok(response) => {
                    for update in response.result {
                        let next = update.update_id + 1;
                        // Forward BEFORE confirming: only advance once the gateway
                        // has the message. On a transient delivery failure, stop
                        // the batch and re-fetch from the same offset next poll.
                        match update.content {
                            UpdateContent::Message(message) => {
                                let delivered = forward_inbound(
                                    &http,
                                    gateway_url.as_deref(),
                                    gateway_token.as_deref(),
                                    *message,
                                )
                                .await;
                                if !delivered {
                                    break;
                                }
                            }
                            // Inline-button tap (remote approval): dismiss the spinner, then
                            // forward {from, data} to the gateway which verifies + executes.
                            UpdateContent::CallbackQuery(cb) => {
                                let _ = bot
                                    .answer_callback_query(
                                        &AnswerCallbackQueryParams::builder()
                                            .callback_query_id(cb.id.clone())
                                            .build(),
                                    )
                                    .await;
                                forward_callback(
                                    &http,
                                    gateway_url.as_deref(),
                                    gateway_token.as_deref(),
                                    &cb,
                                )
                                .await;
                            }
                            _ => {}
                        }
                        offset = next;
                        persist_offset(offset);
                    }
                }
                Err(error) => {
                    let err = format!("{error:?}");
                    if err.contains("TimedOut") || err.contains("timed out") {
                        // Long-poll timeouts are expected — retry immediately.
                    } else {
                        eprintln!("telegram poll error, backoff 5s: {error:?}");
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                }
            }
        }
    })
}

// --------------------------------------------------------------------------
// markdown→HTML + splitting (ported from Homun's channels/telegram.rs)
// --------------------------------------------------------------------------

/// Convert basic Markdown to Telegram-compatible HTML.
fn markdown_to_html(text: &str) -> String {
    let mut result = String::with_capacity(text.len() + 128);
    let mut in_code_block = false;
    for line in text.lines() {
        if line.starts_with("```") {
            if in_code_block {
                result.push_str("</code></pre>\n");
                in_code_block = false;
            } else {
                in_code_block = true;
                result.push_str("<pre><code>");
            }
            continue;
        }
        if in_code_block {
            result.push_str(&escape_html(line));
            result.push('\n');
            continue;
        }
        result.push_str(&convert_inline_markdown(line));
        result.push('\n');
    }
    if in_code_block {
        result.push_str("</code></pre>\n");
    }
    if result.ends_with('\n') {
        result.pop();
    }
    result
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn convert_inline_markdown(line: &str) -> String {
    let line = escape_html(line);
    if let Some(t) = line.strip_prefix("### ") {
        return format!("<b>{t}</b>");
    }
    if let Some(t) = line.strip_prefix("## ") {
        return format!("<b>{t}</b>");
    }
    if let Some(t) = line.strip_prefix("# ") {
        return format!("<b>{t}</b>");
    }
    let line = if let Some(rest) = line.strip_prefix("- ") {
        format!("• {rest}")
    } else if let Some(rest) = line.strip_prefix("* ") {
        format!("• {rest}")
    } else {
        line
    };
    let line = replace_paired_marker(&line, '`', "<code>", "</code>");
    let line = replace_paired_double(&line, "**", "<b>", "</b>");
    let line = replace_paired_marker(&line, '*', "<i>", "</i>");
    replace_paired_double(&line, "~~", "<s>", "</s>")
}

fn replace_paired_marker(text: &str, marker: char, open: &str, close: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut is_open = false;
    for ch in text.chars() {
        if ch == marker {
            result.push_str(if is_open { close } else { open });
            is_open = !is_open;
        } else {
            result.push(ch);
        }
    }
    if is_open {
        return text.to_string();
    }
    result
}

fn replace_paired_double(text: &str, marker: &str, open: &str, close: &str) -> String {
    let parts: Vec<&str> = text.split(marker).collect();
    if parts.len() < 3 || parts.len() % 2 == 0 {
        return text.to_string();
    }
    let mut result = String::new();
    for (i, part) in parts.iter().enumerate() {
        if i % 2 == 1 {
            result.push_str(open);
            result.push_str(part);
            result.push_str(close);
        } else {
            result.push_str(part);
        }
    }
    result
}

/// Split a message into chunks that fit within Telegram's character limit.
fn split_message(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut remaining = text;
    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }
        let split_at = remaining[..max_len].rfind('\n').unwrap_or(max_len);
        let (chunk, rest) = remaining.split_at(split_at);
        chunks.push(chunk.to_string());
        remaining = rest.strip_prefix('\n').unwrap_or(rest);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_bold_and_code() {
        assert_eq!(markdown_to_html("This is **bold**"), "This is <b>bold</b>");
        assert_eq!(markdown_to_html("Use `cargo`"), "Use <code>cargo</code>");
    }

    #[test]
    fn splits_long_message_on_newline() {
        let chunks = split_message("line1\nline2\nline3\nline4", 12);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], "line1\nline2");
    }

    #[test]
    fn escapes_html() {
        assert_eq!(markdown_to_html("a < b & c"), "a &lt; b &amp; c");
    }
}
