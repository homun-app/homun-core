//! noVNC live-view reverse proxy.
//!
//! The contained computer serves noVNC (websockify) on `:6080` inside the host /
//! Docker network. On the desktop build the browser is on the same machine, so it
//! loads `127.0.0.1:6080` directly. On a cloud build the browser is REMOTE and that
//! port is internal (deliberately not exposed — an open VNC on the internet would be
//! a takeover risk), so the live view is blank.
//!
//! These routes proxy both the static noVNC assets (HTTP) and the VNC pixel stream
//! (WebSocket) through the gateway's OWN public origin, so a remote browser loads
//! everything from `https://<host>/api/computer/novnc/...` over the same TLS. They
//! are gated by a short-lived ticket because an iframe navigation and its WebSocket
//! cannot carry the gateway's Bearer header; a Bearer-authed endpoint mints it.

use std::time::{Duration, Instant};

use axum::{
    body::Body,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio_tungstenite::tungstenite::Message as Up;

use crate::AppState;

/// How long a minted ticket stays valid. Covers a live-view session incl. noVNC's
/// auto-reconnects; the frontend mints a fresh one each time it opens the panel.
const TICKET_TTL: Duration = Duration::from_secs(3600);

pub(crate) fn mint_ticket(state: &AppState) -> String {
    let ticket = uuid::Uuid::new_v4().simple().to_string();
    let now = Instant::now();
    let mut map = state.novnc_tickets.lock().unwrap();
    map.retain(|_, exp| *exp > now);
    map.insert(ticket.clone(), now + TICKET_TTL);
    ticket
}

pub(crate) fn ticket_valid(state: &AppState, ticket: &str) -> bool {
    if ticket.is_empty() {
        return false;
    }
    let now = Instant::now();
    let mut map = state.novnc_tickets.lock().unwrap();
    map.retain(|_, exp| *exp > now);
    map.contains_key(ticket)
}

/// Bearer-authed (registered inside the token layer): mint a ticket for a session.
pub(crate) async fn novnc_ticket(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ticket": mint_ticket(&state) }))
}

/// A STABLE view ticket reused across status polls (so the embed URL — and the
/// iframe — doesn't churn every poll). Re-minted only once the cached one expires.
pub(crate) fn current_view_ticket(state: &AppState) -> String {
    if let Some(cached) = state.novnc_view_ticket.lock().unwrap().clone() {
        if ticket_valid(state, &cached) {
            return cached;
        }
    }
    let fresh = mint_ticket(state);
    *state.novnc_view_ticket.lock().unwrap() = Some(fresh.clone());
    fresh
}

/// The contained computer's noVNC origin (`scheme://host:port`): from
/// `HOMUN_CONTAINED_COMPUTER_NOVNC` on a server (e.g. `http://homun-cc:6080/...`),
/// else the desktop loopback `http://127.0.0.1:6080`.
fn novnc_origin() -> String {
    parse_novnc_origin(
        std::env::var("HOMUN_CONTAINED_COMPUTER_NOVNC")
            .ok()
            .as_deref(),
    )
}

/// Bounded readiness probe for the exact viewer page embedded by the desktop.
/// A listening TCP port is not enough: stale images can be missing the custom
/// `lfpa-view.html` asset while websockify still accepts connections.
pub(crate) async fn viewer_ready(http: &reqwest::Client) -> bool {
    http.get(format!("{}/lfpa-view.html", novnc_origin()))
        .timeout(Duration::from_millis(800))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn parse_novnc_origin(raw: Option<&str>) -> String {
    if let Some(raw) = raw {
        if let Some(idx) = raw.find("://") {
            let scheme = &raw[..idx];
            let host = raw[idx + 3..].split('/').next().unwrap_or_default();
            if !host.is_empty() {
                return format!("{scheme}://{host}");
            }
        }
    }
    "http://127.0.0.1:6080".to_string()
}

#[derive(Deserialize)]
pub(crate) struct TicketQuery {
    #[serde(default)]
    ticket: String,
}

/// HTTP proxy for noVNC static assets (`lfpa-view.html`, `core/*.js`, …). These are
/// public, open-source noVNC files and serving them leaks nothing — the SENSITIVE
/// part (the live pixel stream) is the WebSocket, which IS ticket-gated. Leaving the
/// assets unticketed lets the page's relative `./core/*.js` imports load without
/// threading a ticket through every request.
pub(crate) async fn novnc_asset(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> Response {
    let url = format!("{}/{}", novnc_origin(), path);
    let upstream = match state.http.get(&url).send().await {
        Ok(r) => r,
        Err(_) => {
            return (StatusCode::BAD_GATEWAY, "contained computer unreachable").into_response();
        }
    };
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = upstream.bytes().await.unwrap_or_default();
    let mut builder = Response::builder().status(status);
    if let Some(ct) = content_type {
        builder = builder.header("content-type", ct);
    }
    builder
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

/// WebSocket proxy: browser ⇄ gateway ⇄ websockify(:6080) — the actual VNC stream.
pub(crate) async fn novnc_ws(
    State(state): State<AppState>,
    Query(q): Query<TicketQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !ticket_valid(&state, &q.ticket) {
        return (StatusCode::UNAUTHORIZED, "invalid ticket").into_response();
    }
    ws.on_upgrade(pump)
}

async fn pump(client: WebSocket) {
    let ws_url = novnc_origin().replacen("http", "ws", 1) + "/websockify";
    let upstream = match tokio_tungstenite::connect_async(&ws_url).await {
        Ok((stream, _)) => stream,
        Err(_) => return,
    };
    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut cl_tx, mut cl_rx) = client.split();

    // browser -> websockify
    let c2u = async {
        while let Some(Ok(msg)) = cl_rx.next().await {
            let out = match msg {
                Message::Binary(b) => Up::Binary(b.to_vec().into()),
                Message::Text(t) => Up::Text(t.as_str().into()),
                Message::Ping(p) => Up::Ping(p.to_vec().into()),
                Message::Pong(p) => Up::Pong(p.to_vec().into()),
                Message::Close(_) => {
                    let _ = up_tx.send(Up::Close(None)).await;
                    break;
                }
            };
            if up_tx.send(out).await.is_err() {
                break;
            }
        }
    };

    // websockify -> browser
    let u2c = async {
        while let Some(Ok(msg)) = up_rx.next().await {
            let out = match msg {
                Up::Binary(b) => Message::Binary(b.to_vec().into()),
                Up::Text(t) => Message::Text(t.as_str().into()),
                Up::Ping(p) => Message::Ping(p.to_vec().into()),
                Up::Pong(p) => Message::Pong(p.to_vec().into()),
                Up::Close(_) => {
                    let _ = cl_tx.send(Message::Close(None)).await;
                    break;
                }
                Up::Frame(_) => continue,
            };
            if cl_tx.send(out).await.is_err() {
                break;
            }
        }
    };

    tokio::select! {
        _ = c2u => {}
        _ = u2c => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    fn tickets() -> Arc<Mutex<HashMap<String, Instant>>> {
        Arc::new(Mutex::new(HashMap::new()))
    }

    #[test]
    fn ticket_roundtrip_and_expiry() {
        let map = tickets();
        // valid right after insert
        {
            let mut m = map.lock().unwrap();
            m.insert("good".into(), Instant::now() + Duration::from_secs(60));
            m.insert("stale".into(), Instant::now() - Duration::from_secs(1));
        }
        let now = Instant::now();
        let mut m = map.lock().unwrap();
        m.retain(|_, exp| *exp > now);
        assert!(m.contains_key("good"));
        assert!(!m.contains_key("stale"), "expired ticket must be pruned");
        assert!(!m.contains_key("never-issued"));
    }

    #[test]
    fn novnc_origin_parses_env() {
        assert_eq!(parse_novnc_origin(None), "http://127.0.0.1:6080");
        assert_eq!(
            parse_novnc_origin(Some("http://homun-cc:6080/vnc.html")),
            "http://homun-cc:6080"
        );
        assert_eq!(
            parse_novnc_origin(Some("https://cc.example.com:6080/")),
            "https://cc.example.com:6080"
        );
    }
}
