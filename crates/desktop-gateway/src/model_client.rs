//! The concrete `engine::ModelClient` for the gateway (ADR 0024). Owns everything transport-shaped
//! the engine must not: HTTP, per-round retry/backoff, provider fallback (the mid-turn model/url/key
//! swap), and the OpenAI-vs-Ollama stream collectors. The body is a VERBATIM lift of the round that
//! used to live inline in `stream_chat_via_openai`; behavior is unchanged. A mid-round fallback may
//! swap the provider — the effective binding is RETURNED so the loop reuses it next round.

use local_first_engine::{
    ModelCall, ModelCallError, ModelClient, ModelRoundOutput, ProviderBinding,
};
use local_first_subagents::GenerateStreamEvent;

use crate::{
    auth_fallback_config, build_chat_payload, chat_endpoint, collect_ollama_native_stream,
    collect_openai_stream, emit_stream_event, is_ollama_base, model_first_token_timeout_secs,
    model_headers_timeout_secs, model_idle_timeout_secs, model_request_timeout_secs,
    should_try_tool_compatibility_fallback, tool_compatibility_fallback_config, StreamSink,
};

/// Borrows the turn's reqwest client and stream sink; built once before the ReAct loop.
pub(crate) struct GatewayModelClient<'a> {
    pub http: &'a reqwest::Client,
    pub tx: &'a StreamSink,
}

/// Outcome of the bounded pre-stream send. `HeadersTimeout` is distinguished from a
/// `Transport` error so the caller can treat "upstream withheld headers past the budget"
/// exactly like a reqwest timeout (retry → provider fallback → clean message).
pub(crate) enum SendOutcome {
    Ready(reqwest::Response),
    Transport(reqwest::Error),
    HeadersTimeout,
}

/// Bound the pre-stream phase (connect + request send + **response headers**) with an
/// explicit deadline. A cold-loading / wedged model (e.g. Ollama loading a model into
/// memory) ACCEPTS the TCP connection but withholds the HTTP response until it is ready,
/// so `.send().await` blocks there. reqwest's per-request `.timeout()` is a multi-minute
/// backstop and the stream idle/first-token governors only start AFTER headers arrive —
/// leaving this phase effectively unbounded and, in production (2026-07-09), hanging the
/// turn for 20+ minutes. This wrapper caps it; `Elapsed` → `HeadersTimeout`.
pub(crate) async fn send_with_headers_timeout(
    request: reqwest::RequestBuilder,
    headers_timeout: std::time::Duration,
) -> SendOutcome {
    match tokio::time::timeout(headers_timeout, request.send()).await {
        Ok(Ok(response)) => SendOutcome::Ready(response),
        Ok(Err(error)) => SendOutcome::Transport(error),
        Err(_elapsed) => SendOutcome::HeadersTimeout,
    }
}

impl ModelClient for GatewayModelClient<'_> {
    async fn generate(
        &self,
        call: &ModelCall<'_>,
        _on_delta: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<ModelRoundOutput, ModelCallError> {
        // Provider copied locally: a mid-round fallback may swap it; the final binding is returned.
        let mut model = call.model.to_string();
        let mut base_url = call.base_url.to_string();
        let mut api_key = call.api_key.map(str::to_string);
        let mut endpoint = chat_endpoint(&base_url);
        let mut fallback_tried = false;
        let mut tool_compatibility_fallback_tried = false;
        // Alias the call fields under the names the lifted block uses (borrows, no clone).
        let messages = call.messages;
        let tool_schemas = call.tools;
        let temperature = call.temperature;
        let is_final_round = call.is_final_round;

        // Ollama (local or cloud) must use the NATIVE /api/chat: its OpenAI-compat
        // /v1 layer drops tool calls when streaming (ollama#12557). The payload
        // shape is provider-specific; both stream from upstream so the governor is
        // INACTIVITY (idle timeout) not total time.
        let payload_has_tools = !is_final_round && !tool_schemas.is_empty();
        let mut payload = build_chat_payload(
            &model,
            &base_url,
            messages,
            tool_schemas,
            temperature,
            is_final_round,
        );
        // Two-layer timeout (2026-07-09 resilience fix): `request_timeout` is the total
        // per-request backstop (covers the whole streamed body; fires mid-stream per
        // reqwest#2839, so it stays high). `headers_timeout` separately bounds the
        // PRE-STREAM phase (connect + response headers), which a cold-loading model
        // withholds — that phase is invisible to the stream idle/first-token governors
        // and used to hang the turn for 20+ minutes. Model proxies (e.g. ollama.com)
        // also occasionally return 502/timeout; retry transient failures a couple of
        // times with backoff and surface a CLEAN message if it persists.
        let request_timeout = std::time::Duration::from_secs(model_request_timeout_secs());
        let headers_timeout = std::time::Duration::from_secs(model_headers_timeout_secs());
        let resp = {
            let mut attempt: u32 = 0;
            loop {
                let mut builder = self.http.post(&endpoint).timeout(request_timeout);
                if let Some(key) = api_key.as_ref() {
                    builder = builder.bearer_auth(key);
                }
                match send_with_headers_timeout(builder.json(&payload), headers_timeout).await {
                    SendOutcome::Ready(value) if value.status().is_success() => break value,
                    SendOutcome::Ready(value) => {
                        let code = value.status();
                        // DIAGNOSTIC (task #105): log the upstream error body —
                        // swallowing it turned a payload bug (400 on the mid-turn
                        // model switch) into a generic, undebuggable fallback.
                        let err_body: String = value
                            .text()
                            .await
                            .unwrap_or_default()
                            .chars()
                            .take(600)
                            .collect();
                        eprintln!(
                            "[model-error] {code} model={model} endpoint={endpoint} \
tools={payload_has_tools} tool_count={} body={err_body}",
                            tool_schemas.len()
                        );
                        // Shape map of the failing payload: which message carries
                        // tool_calls with non-string arguments (the classic
                        // cross-provider 400).
                        if let Some(arr) = payload.get("messages").and_then(|m| m.as_array()) {
                            let shapes: Vec<String> = arr
                                .iter()
                                .map(|m| {
                                    let role =
                                        m.get("role").and_then(|r| r.as_str()).unwrap_or("?");
                                    match m.get("tool_calls").and_then(|t| t.as_array()) {
                                        None => role.to_string(),
                                        Some(calls) => {
                                            let kinds = calls
                                                .iter()
                                                .map(|c| match c.pointer("/function/arguments") {
                                                    Some(serde_json::Value::String(_)) => "str",
                                                    Some(_) => "OBJ",
                                                    None => "none",
                                                })
                                                .collect::<Vec<_>>()
                                                .join(",");
                                            format!("{role}[tc:{kinds}]")
                                        }
                                    }
                                })
                                .collect();
                            eprintln!("[model-error] shapes: {}", shapes.join(" | "));
                        }
                        // A project can intentionally route Auto to its coding
                        // provider. If that provider rejects this actual TOOLS
                        // payload, do not print a generic 400 and then continue
                        // with a no-tools synthesis: retry the same round once
                        // through the configured orchestrator, which owns the
                        // general agent/tool contract.
                        if should_try_tool_compatibility_fallback(
                            code.as_u16(),
                            payload_has_tools,
                            tool_compatibility_fallback_tried,
                        ) {
                            if let Some((fb_base, fb_model, fb_key)) =
                                tool_compatibility_fallback_config(&base_url, &model)
                            {
                                tool_compatibility_fallback_tried = true;
                                let _ = emit_stream_event(
                                    self.tx,
                                    GenerateStreamEvent::Delta {
                                        text: format!(
                                            "‹‹ACT››↩ «{model}» rejected the tool request (400); \
retrying through «{fb_model}»…‹‹/ACT››"
                                        ),
                                    },
                                )
                                .await;
                                model = fb_model;
                                base_url = fb_base;
                                endpoint = chat_endpoint(&base_url);
                                api_key = fb_key;
                                payload = build_chat_payload(
                                    &model,
                                    &base_url,
                                    messages,
                                    tool_schemas,
                                    temperature,
                                    is_final_round,
                                );
                                attempt = 0;
                                continue;
                            }
                        }
                        let transient = matches!(code.as_u16(), 408 | 429 | 500 | 502 | 503 | 504);
                        if transient && attempt < 2 {
                            attempt += 1;
                            let _ = emit_stream_event(self.tx, GenerateStreamEvent::Delta {
                                    text: format!("‹‹ACT››⏳ The model isn't responding ({code}), retrying ({attempt}/2)…‹‹/ACT››"),
                                })
                                .await;
                            tokio::time::sleep(std::time::Duration::from_millis(
                                800 * u64::from(attempt),
                            ))
                            .await;
                            continue;
                        }
                        // Self-heal on 401: retry once with a provider that has a
                        // valid key (or a local no-auth model) — even when the
                        // FAILING model is the orchestrator itself, so an
                        // unauthenticated binding doesn't break the turn.
                        if code.as_u16() == 401 && !fallback_tried {
                            if let Some((fb_base, fb_model, fb_key)) = auth_fallback_config(&model)
                            {
                                if fb_model != model {
                                    fallback_tried = true;
                                    let _ = emit_stream_event(self.tx, GenerateStreamEvent::Delta {
                                            text: format!("‹‹ACT››↩ «{model}» not authenticated (401): falling back to «{fb_model}»…‹‹/ACT››"),
                                        })
                                        .await;
                                    model = fb_model;
                                    base_url = fb_base;
                                    endpoint = chat_endpoint(&base_url);
                                    api_key = fb_key;
                                    payload = build_chat_payload(
                                        &model,
                                        &base_url,
                                        messages,
                                        tool_schemas,
                                        temperature,
                                        is_final_round,
                                    );
                                    attempt = 0;
                                    continue;
                                }
                            }
                        }
                        // 401 on a `:cloud` Ollama model = the cloud service
                        // needs auth (the local Ollama has no key). Make the
                        // fix actionable instead of a generic "check provider".
                        let hint = if code.as_u16() == 401 {
                            if model.contains(":cloud") {
                                format!(
                                    " The model «{model}» is a CLOUD Ollama model that \
requires authentication: run `ollama signin` (or add the provider key in Settings → \
Model & Runtime), or select a LOCAL model."
                                )
                            } else {
                                " It looks like a provider authentication problem: \
check/update the key in Settings → Model & Runtime."
                                    .to_string()
                            }
                        } else {
                            String::new()
                        };
                        // Pull the human reason out of the upstream body (e.g.
                        // "glm-4.6 was retired at 2026-06-16") so the user sees WHY,
                        // not a silent dead end. Falls back to the raw body, then a
                        // bare status. Stored AND streamed so the same message is the
                        // committed final text (the synthesis Done would otherwise
                        // overwrite this Delta with a generic fallback).
                        let detail = serde_json::from_str::<serde_json::Value>(&err_body)
                            .ok()
                            .and_then(|v| {
                                v.get("error")
                                    .and_then(|e| {
                                        e.as_str().map(str::to_string).or_else(|| {
                                            e.get("message")
                                                .and_then(|m| m.as_str())
                                                .map(str::to_string)
                                        })
                                    })
                                    .or_else(|| {
                                        v.get("message")
                                            .and_then(|m| m.as_str())
                                            .map(str::to_string)
                                    })
                            })
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| err_body.trim().chars().take(240).collect());
                        // The provider is telling us it cannot LOOK at the images this request carries.
                        // That is recoverable — the gateway describes them on the vision role and
                        // replays the turn — so it must not be streamed: emitting here would leave a
                        // dead 400 stranded in the transcript above an answer that ultimately worked.
                        // Gated on the request actually carrying an image, so an unrelated failure that
                        // merely says the word "image" can't trigger a pointless replay.
                        if crate::vision::messages_have_image(messages)
                            && crate::vision::looks_like_image_rejection(&detail)
                        {
                            return Err(ModelCallError::ImageUnsupported(format!(
                                "The model «{model}» cannot read images: {detail}"
                            )));
                        }
                        let reason = if detail.is_empty() {
                            format!("The model «{model}» responded with an error ({code}).")
                        } else {
                            format!("The model «{model}» is unavailable ({code}): {detail}")
                        };
                        let tail = if hint.is_empty() {
                            " — pick another model in Settings → Model & Runtime.".to_string()
                        } else {
                            hint
                        };
                        let message = format!("{reason}{tail}");
                        // Already streamed live; the loop puts this in `last_model_error` so it
                        // becomes the committed final answer if the turn produces nothing else.
                        let _ = emit_stream_event(
                            self.tx,
                            GenerateStreamEvent::Delta {
                                text: message.clone(),
                            },
                        )
                        .await;
                        return Err(ModelCallError::Upstream(message));
                    }
                    // A transport error and a pre-stream headers-timeout are both
                    // transient-capable (retry → provider fallback → clean message). A
                    // HeadersTimeout — a cold-loading upstream withholding headers — is
                    // treated exactly like a reqwest timeout so the same self-heal applies.
                    failure @ (SendOutcome::Transport(_) | SendOutcome::HeadersTimeout) => {
                        let transient = match &failure {
                            SendOutcome::Transport(error) => {
                                error.is_timeout() || error.is_connect()
                            }
                            _ => true,
                        };
                        if transient && attempt < 2 {
                            attempt += 1;
                            let _ = emit_stream_event(self.tx, GenerateStreamEvent::Delta {
                                    text: format!("‹‹ACT››⏳ Network to the model unstable, retrying ({attempt}/2)…‹‹/ACT››"),
                                })
                                .await;
                            tokio::time::sleep(std::time::Duration::from_millis(
                                800 * u64::from(attempt),
                            ))
                            .await;
                            continue;
                        }
                        // Persistent timeout/connect (e.g. a huge/slow cloud model,
                        // or a `:cloud` model on the local daemon): self-heal once
                        // onto a provider that has a key — same as the 401 path.
                        if transient && !fallback_tried {
                            if let Some((fb_base, fb_model, fb_key)) = auth_fallback_config(&model)
                            {
                                if fb_model != model {
                                    fallback_tried = true;
                                    let _ = emit_stream_event(self.tx, GenerateStreamEvent::Delta {
                                            text: format!("‹‹ACT››↩ «{model}» isn't responding (timeout): falling back to «{fb_model}»…‹‹/ACT››"),
                                        })
                                        .await;
                                    model = fb_model;
                                    base_url = fb_base;
                                    endpoint = chat_endpoint(&base_url);
                                    api_key = fb_key;
                                    payload = build_chat_payload(
                                        &model,
                                        &base_url,
                                        messages,
                                        tool_schemas,
                                        temperature,
                                        is_final_round,
                                    );
                                    attempt = 0;
                                    continue;
                                }
                            }
                        }
                        let _ = emit_stream_event(
                            self.tx,
                            GenerateStreamEvent::Delta {
                                text:
                                    "The model didn't respond (timeout/network). Try again shortly."
                                        .to_string(),
                            },
                        )
                        .await;
                        return Err(ModelCallError::Transport(
                            "The model didn't respond (timeout/network). Try again shortly."
                                .to_string(),
                        ));
                    }
                }
            }
        };
        // Consume the streamed completion with a generous FIRST-token budget +
        // a tight inter-token idle timeout (not a total-time cap), then reassemble
        // it into the non-streaming body shape. Ollama → NDJSON native parser;
        // others → OpenAI SSE parser.
        let first_token = std::time::Duration::from_secs(model_first_token_timeout_secs());
        let idle = std::time::Duration::from_secs(model_idle_timeout_secs());
        // Reflect the provider actually used (a 401/timeout fallback may have
        // switched it) so we parse the right stream format.
        let ollama = is_ollama_base(&base_url);
        let collected = if ollama {
            collect_ollama_native_stream(resp, first_token, idle, self.tx).await
        } else {
            collect_openai_stream(resp, first_token, idle, self.tx).await
        };
        let body: serde_json::Value = match collected {
            Ok(value) => value,
            Err(error) => {
                let _ = emit_stream_event(
                    self.tx,
                    GenerateStreamEvent::Delta {
                        text: format!(
                            "The model interrupted the response ({error}). Try again shortly."
                        ),
                    },
                )
                .await;
                return Err(ModelCallError::Transport(format!(
                    "The model interrupted the response ({error}). Try again shortly."
                )));
            }
        };
        let message = body
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("message"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));

        let finish_reason = body
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("finish_reason"))
            .and_then(|f| f.as_str())
            .map(str::to_string);
        Ok(ModelRoundOutput {
            message,
            provider: ProviderBinding {
                model,
                base_url,
                api_key,
            },
            finish_reason,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Resilience regression (2026-07-09): a cold-loading / wedged model endpoint
    // ACCEPTS the TCP connection but withholds the HTTP response headers until the
    // model is in memory. reqwest's per-request `.timeout()` is a 3600s backstop and
    // the stream idle/first-token timeouts only start AFTER headers arrive, so this
    // pre-headers phase used to hang the turn for up to ~3h. `send_with_headers_timeout`
    // must give up promptly instead.
    #[tokio::test]
    async fn send_with_headers_timeout_gives_up_when_upstream_withholds_headers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // Accept the connection and hold it open forever without ever replying —
        // exactly the cold-load shape (headers never sent).
        tokio::spawn(async move {
            let _held = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });

        let client = reqwest::Client::new();
        let request = client
            .post(format!("http://{addr}/v1/chat/completions"))
            .json(&serde_json::json!({ "model": "x", "messages": [] }));

        let started = std::time::Instant::now();
        let outcome =
            send_with_headers_timeout(request, std::time::Duration::from_millis(150)).await;

        assert!(
            matches!(outcome, SendOutcome::HeadersTimeout),
            "a header-withholding upstream must surface HeadersTimeout, got a different outcome"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "must give up in ~the headers budget, not hang (elapsed {:?})",
            started.elapsed()
        );
    }
}
