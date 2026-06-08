//! Streamable-HTTP transport for MCP (the modern remote transport, 2025 spec).
//!
//! The official registry is remote-first: ~3/4 of servers ship only a
//! `streamable-http` endpoint. This implements the `McpTransport` trait over
//! HTTP so those servers become connectable alongside stdio ones. Synchronous
//! (`reqwest::blocking`) — safe because every MCP call path runs on a
//! `spawn_blocking` thread, never a tokio runtime worker.
//!
//! Protocol essentials handled: POST JSON-RPC to the endpoint; accept either a
//! single `application/json` reply or an SSE (`text/event-stream`) stream and
//! pick the message matching our request id; carry the `Mcp-Session-Id` header
//! returned at `initialize` on subsequent requests; optional auth headers.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use local_first_capabilities::{CapabilityError, CapabilityResult, McpTransport};

/// Connection config for a remote (streamable-HTTP) MCP server.
pub struct McpHttpConfig {
    pub url: String,
    /// Extra request headers (e.g. `Authorization`) supplied by the user.
    pub headers: Vec<(String, String)>,
}

pub struct McpHttpTransport {
    client: reqwest::blocking::Client,
    url: String,
    headers: Vec<(String, String)>,
    session_id: Mutex<Option<String>>,
    next_id: AtomicU64,
}

impl McpHttpTransport {
    pub fn connect(config: McpHttpConfig) -> CapabilityResult<Self> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent("local-first-personal-assistant")
            .build()
            .map_err(|e| CapabilityError::ProviderUnavailable(format!("mcp_http_client:{e}")))?;
        Ok(Self {
            client,
            url: config.url,
            headers: config.headers,
            session_id: Mutex::new(None),
            next_id: AtomicU64::new(1),
        })
    }

    fn post(&self, body: &serde_json::Value) -> CapabilityResult<reqwest::blocking::Response> {
        let mut req = self
            .client
            .post(&self.url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json, text/event-stream");
        for (key, value) in &self.headers {
            req = req.header(key.as_str(), value.as_str());
        }
        if let Some(sid) = self.session_id.lock().ok().and_then(|g| g.clone()) {
            req = req.header("Mcp-Session-Id", sid);
        }
        req.json(body)
            .send()
            .map_err(|e| CapabilityError::ProviderUnavailable(format!("mcp_http_send:{e}")))
    }

    /// Captures the session id (if any) and returns the JSON-RPC message matching
    /// `id`, from either a JSON body or an SSE stream.
    fn read_result(
        &self,
        resp: reqwest::blocking::Response,
        id: u64,
    ) -> CapabilityResult<serde_json::Value> {
        if let Some(sid) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
        {
            if let Ok(mut guard) = self.session_id.lock() {
                *guard = Some(sid);
            }
        }
        let status = resp.status();
        let is_sse = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|c| c.contains("text/event-stream"))
            .unwrap_or(false);
        let text = resp
            .text()
            .map_err(|e| CapabilityError::ProviderUnavailable(format!("mcp_http_body:{e}")))?;
        if !status.is_success() {
            let snippet: String = text.chars().take(200).collect();
            return Err(CapabilityError::ProviderUnavailable(format!(
                "mcp_http_status_{}:{}",
                status.as_u16(),
                snippet
            )));
        }

        let messages: Vec<serde_json::Value> = if is_sse {
            text.lines()
                .filter_map(|line| line.strip_prefix("data:").map(str::trim))
                .filter_map(|data| serde_json::from_str::<serde_json::Value>(data).ok())
                .collect()
        } else {
            serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .into_iter()
                .collect()
        };

        for msg in messages {
            let id_match = msg
                .get("id")
                .map(|v| *v == serde_json::json!(id) || *v == serde_json::json!(id.to_string()))
                .unwrap_or(false);
            if !id_match {
                continue;
            }
            if let Some(error) = msg.get("error") {
                return Err(CapabilityError::ProviderUnavailable(format!(
                    "mcp_http_rpc_error:{error}"
                )));
            }
            return Ok(msg.get("result").cloned().unwrap_or(serde_json::Value::Null));
        }
        Err(CapabilityError::ProviderUnavailable(
            "mcp_http_no_matching_response".to_string(),
        ))
    }
}

impl McpTransport for McpHttpTransport {
    fn request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> CapabilityResult<serde_json::Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut body = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if let Some(params) = params {
            body["params"] = params;
        }
        let resp = self.post(&body)?;
        self.read_result(resp, id)
    }

    fn notify(&self, method: &str, params: Option<serde_json::Value>) -> CapabilityResult<()> {
        let mut body = serde_json::json!({ "jsonrpc": "2.0", "method": method });
        if let Some(params) = params {
            body["params"] = params;
        }
        // Notifications get 202 Accepted with no body; we don't need the result.
        let _ = self.post(&body)?;
        Ok(())
    }
}
