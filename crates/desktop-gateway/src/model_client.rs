//! The concrete `engine::ModelClient` for the gateway (ADR 0024). Owns everything transport-shaped
//! the engine must not: HTTP, per-round retry/backoff, provider fallback (the mid-turn model/url/key
//! swap), and the OpenAI-vs-Ollama stream collectors. The body is a VERBATIM lift of the round that
//! used to live inline in `stream_chat_via_openai`; behavior is unchanged. A mid-round fallback may
//! swap the provider — the effective binding is RETURNED so the loop reuses it next round.

use local_first_engine::{
    ModelCall, ModelCallError, ModelClient, ModelRoundOutput, ProviderBinding,
};
use local_first_inference_usage::{
    CostProvenance, Locality, NormalizedUsage, UsageContext, UsageProvenance, UsageRecorder,
};
use local_first_subagents::GenerateStreamEvent;

use crate::{
    StreamSink, auth_fallback_config, build_chat_payload,
    collect_ollama_native_stream, collect_openai_stream, emit_stream_event, is_ollama_base,
    model_first_token_timeout_secs, model_headers_timeout_secs, model_idle_timeout_secs,
    model_request_timeout_secs, should_try_tool_compatibility_fallback,
    tool_compatibility_fallback_config,
};

pub(crate) fn chat_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if is_ollama_base(base_url) {
        let root = trimmed
            .strip_suffix("/v1")
            .unwrap_or(trimmed)
            .trim_end_matches('/');
        format!("{root}/api/chat")
    } else {
        format!("{trimmed}/chat/completions")
    }
}

/// Borrows the turn's reqwest client and stream sink; built once before the ReAct loop.
pub(crate) struct GatewayModelClient<'a> {
    pub http: &'a reqwest::Client,
    pub tx: &'a StreamSink,
    pub usage: &'a dyn UsageRecorder,
    pub steering: Option<GatewaySteeringContext<'a>>,
}

#[derive(Clone, Copy)]
pub(crate) struct GatewaySteeringContext<'a> {
    pub state: &'a crate::AppState,
    pub user_id: &'a str,
    pub workspace_id: &'a str,
    pub thread_id: &'a str,
    pub turn_id: &'a str,
}

impl GatewayModelClient<'_> {
    fn consume_steering_messages(&self) -> Vec<serde_json::Value> {
        let Some(context) = self.steering else {
            return Vec::new();
        };
        steering_messages_for_round(context)
    }
}

pub(crate) fn steering_messages_for_round(
    context: GatewaySteeringContext<'_>,
) -> Vec<serde_json::Value> {
    let Ok(store) = context.state.task_store.lock() else {
        return Vec::new();
    };
    let objective = store
        .load_objective_contract(context.user_id, context.workspace_id, context.thread_id)
        .ok()
        .flatten();
    let messages = store
        .consume_pending_turn_steering(
            context.user_id,
            context.workspace_id,
            context.thread_id,
            context.turn_id,
        )
        .unwrap_or_default();
    drop(store);

    messages
        .into_iter()
        .map(|message| {
            let requires_confirmation = objective.as_ref().is_none_or(|objective| {
                message.objective_revision != objective.revision
                    || crate::classify_steering(objective.mode, &message.content)
                        == crate::SteeringDisposition::RequiresConfirmation
            });
            let content = if requires_confirmation {
                format!(
                    "[USER STEERING — CONFIRMATION REQUIRED]\n{}\n\nThis changes the canonical objective, scope, or mutation level. Do not execute it yet. Ask the user for explicit confirmation and explain the proposed contract change.",
                    message.content
                )
            } else {
                format!(
                    "[USER STEERING — APPLY TO THE CURRENT RUN]\n{}\n\nIncorporate this now, preserving the current objective and already verified progress. Replan autonomously if needed.",
                    message.content
                )
            };
            serde_json::json!({"role": "user", "content": content})
        })
        .collect()
}

#[derive(Debug, Clone, Copy, Default)]
struct RateLimitSnapshot {
    limit: Option<u64>,
    remaining: Option<u64>,
    reset_at: Option<i64>,
}

fn unix_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or_default()
}

fn provider_identity(base_url: &str) -> (String, Locality) {
    let parsed = reqwest::Url::parse(base_url).ok();
    let host = parsed
        .as_ref()
        .and_then(reqwest::Url::host_str)
        .unwrap_or("");
    let locality = if matches!(host, "localhost" | "127.0.0.1" | "::1") {
        Locality::Local
    } else {
        Locality::Cloud
    };
    let provider = if is_ollama_base(base_url) {
        "ollama".to_string()
    } else if host.contains("openrouter") {
        "openrouter".to_string()
    } else if host.contains("openai") {
        "openai".to_string()
    } else if host.is_empty() {
        "openai_compatible".to_string()
    } else {
        host.to_string()
    };
    (provider, locality)
}

fn parse_rate_limit_headers(headers: &reqwest::header::HeaderMap) -> RateLimitSnapshot {
    fn number(headers: &reqwest::header::HeaderMap, names: &[&str]) -> Option<u64> {
        names.iter().find_map(|name| {
            headers
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse().ok())
        })
    }
    fn timestamp(headers: &reqwest::header::HeaderMap, names: &[&str]) -> Option<i64> {
        names.iter().find_map(|name| {
            headers
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse().ok())
        })
    }
    RateLimitSnapshot {
        limit: number(headers, &["x-ratelimit-limit-requests", "ratelimit-limit"]),
        remaining: number(
            headers,
            &["x-ratelimit-remaining-requests", "ratelimit-remaining"],
        ),
        reset_at: timestamp(headers, &["x-ratelimit-reset-requests", "ratelimit-reset"]),
    }
}

fn estimate_tokens(value: &serde_json::Value) -> u64 {
    let chars = serde_json::to_string(value)
        .ok()
        .and_then(|text| u64::try_from(text.chars().count()).ok())
        .unwrap_or_default();
    chars.div_ceil(4).max(1)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ParsedTerminalUsage {
    tokens: NormalizedUsage,
    provider_cost_microusd: Option<u64>,
}

fn parse_openai_usage(value: &serde_json::Value) -> ParsedTerminalUsage {
    let usage = value.get("usage").unwrap_or(value);
    ParsedTerminalUsage {
        tokens: NormalizedUsage {
            input_tokens: usage
                .get("prompt_tokens")
                .and_then(serde_json::Value::as_u64),
            output_tokens: usage
                .get("completion_tokens")
                .and_then(serde_json::Value::as_u64),
            reasoning_tokens: usage
                .pointer("/completion_tokens_details/reasoning_tokens")
                .and_then(serde_json::Value::as_u64),
            cache_read_tokens: usage
                .pointer("/prompt_tokens_details/cached_tokens")
                .or_else(|| usage.get("cache_read_input_tokens"))
                .and_then(serde_json::Value::as_u64),
            cache_write_tokens: usage
                .pointer("/prompt_tokens_details/cache_write_tokens")
                .or_else(|| usage.get("cache_creation_input_tokens"))
                .and_then(serde_json::Value::as_u64),
        },
        provider_cost_microusd: usage.get("cost").and_then(decimal_dollars_to_microusd),
    }
}

fn parse_ollama_usage(value: &serde_json::Value) -> ParsedTerminalUsage {
    ParsedTerminalUsage {
        tokens: NormalizedUsage {
            input_tokens: value
                .get("prompt_eval_count")
                .and_then(serde_json::Value::as_u64),
            output_tokens: value.get("eval_count").and_then(serde_json::Value::as_u64),
            ..NormalizedUsage::default()
        },
        provider_cost_microusd: None,
    }
}

fn decimal_dollars_to_microusd(value: &serde_json::Value) -> Option<u64> {
    let owned;
    let text = if let Some(value) = value.as_str() {
        value.trim()
    } else {
        owned = value.as_number()?.to_string();
        owned.as_str()
    };
    if text.is_empty() || text.starts_with('-') || text.contains(['e', 'E']) {
        return None;
    }
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let whole = whole.parse::<u64>().ok()?;
    let mut fractional = 0u64;
    let mut digits = 0usize;
    let mut round_up = false;
    for byte in fraction.bytes() {
        if !byte.is_ascii_digit() {
            return None;
        }
        if digits < 6 {
            fractional = fractional
                .checked_mul(10)?
                .checked_add(u64::from(byte - b'0'))?;
            digits += 1;
        } else if digits == 6 {
            round_up = byte >= b'5';
            digits += 1;
        }
    }
    for _ in digits.min(6)..6 {
        fractional = fractional.checked_mul(10)?;
    }
    let mut microusd = whole.checked_mul(1_000_000)?.checked_add(fractional)?;
    if round_up {
        microusd = microusd.checked_add(1)?;
    }
    Some(microusd)
}

struct AttemptLifecycle<'a> {
    recorder: &'a dyn UsageRecorder,
    started: local_first_inference_usage::UsageAttemptEvent,
}

impl<'a> AttemptLifecycle<'a> {
    #[allow(clippy::too_many_arguments)]
    fn start(
        recorder: &'a dyn UsageRecorder,
        context: &UsageContext,
        attempt_id: impl Into<String>,
        provider_id: impl Into<String>,
        model_id: impl Into<String>,
        locality: Locality,
        recorded_at: i64,
    ) -> Self {
        let started = local_first_inference_usage::UsageAttemptEvent::started(
            context.clone(),
            attempt_id,
            provider_id,
            model_id,
            locality,
            recorded_at,
        );
        recorder.record(started.clone());
        Self { recorder, started }
    }

    fn completed(
        self,
        recorded_at: i64,
        usage: ParsedTerminalUsage,
        provenance: UsageProvenance,
        latency_ms: Option<u64>,
        time_to_first_token_ms: Option<u64>,
        finish_reason: Option<String>,
        rate_limit: RateLimitSnapshot,
    ) {
        let has_usage = usage.tokens.input_tokens.is_some()
            || usage.tokens.output_tokens.is_some()
            || usage.tokens.reasoning_tokens.is_some()
            || usage.tokens.cache_read_tokens.is_some()
            || usage.tokens.cache_write_tokens.is_some();
        let mut completed = self.started.completed(recorded_at, usage.tokens);
        completed.latency_ms = latency_ms;
        completed.time_to_first_token_ms = time_to_first_token_ms;
        completed.finish_reason = finish_reason;
        completed.rate_limit_limit = rate_limit.limit;
        completed.rate_limit_remaining = rate_limit.remaining;
        completed.rate_limit_reset_at = rate_limit.reset_at;
        completed.usage_provenance = if has_usage {
            provenance
        } else {
            UsageProvenance::Unavailable
        };
        completed.cost_microusd = usage.provider_cost_microusd;
        completed.cost_provenance = if usage.provider_cost_microusd.is_some() {
            CostProvenance::ProviderReported
        } else if completed.locality == Locality::Local {
            CostProvenance::NotBilled
        } else {
            CostProvenance::Unavailable
        };
        self.recorder.record(completed);
    }

    fn failed(
        self,
        recorded_at: i64,
        error_class: impl Into<String>,
        upstream_status: Option<u16>,
        latency_ms: Option<u64>,
        rate_limit: RateLimitSnapshot,
    ) {
        let mut failed = self
            .started
            .failed(recorded_at, error_class, upstream_status);
        failed.latency_ms = latency_ms;
        failed.rate_limit_limit = rate_limit.limit;
        failed.rate_limit_remaining = rate_limit.remaining;
        failed.rate_limit_reset_at = rate_limit.reset_at;
        if failed.locality == Locality::Local {
            failed.cost_provenance = CostProvenance::NotBilled;
        }
        self.recorder.record(failed);
    }
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
        // S2 T5: whether this round's payload FORCES `tool_choice` onto a specific tool (belt-
        // and-suspenders on top of the hard-prune). Mutable — cleared once, below, if the
        // provider 400s specifically on the forcing shape. `None` everywhere but the loop's main
        // per-round call (see `ModelCall::forced_tool`), so this is a no-op for every other turn.
        let mut forced_tool_fallback_tried = false;
        // Consume steering only at a round boundary: `generate` is entered once per
        // model round, before the request payload is built. The durable queue makes
        // this exactly-once even across provider retries within this round.
        let mut messages_owned = call.messages.to_vec();
        messages_owned.extend(self.consume_steering_messages());
        let messages = messages_owned.as_slice();
        let tool_schemas = call.tools;
        let temperature = call.temperature;
        let is_final_round = call.is_final_round;

        // Ollama (local or cloud) must use the NATIVE /api/chat: its OpenAI-compat
        // /v1 layer drops tool calls when streaming (ollama#12557). The payload
        // shape is provider-specific; both stream from upstream so the governor is
        // INACTIVITY (idle timeout) not total time.
        let payload_has_tools = !is_final_round && !tool_schemas.is_empty();
        // S2 T5: the ONLY forced value this fn ever sees — every rebuild below (401/timeout/
        // tool-compat provider swaps) deliberately passes `None`, so a mid-round fallback to a
        // DIFFERENT provider never inherits a forcing shape that provider hasn't been vetted
        // against. Mutable so the dedicated 400-fallback below can clear it and retry same-provider.
        let mut forced_tool = call.forced_tool;
        let mut payload = build_chat_payload(
            &model,
            &base_url,
            messages,
            tool_schemas,
            temperature,
            is_final_round,
            forced_tool,
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
                let attempt_started = std::time::Instant::now();
                let (provider_id, locality) = provider_identity(&base_url);
                let lifecycle = AttemptLifecycle::start(
                    self.usage,
                    call.usage,
                    uuid::Uuid::new_v4().to_string(),
                    provider_id,
                    model.clone(),
                    locality,
                    unix_timestamp(),
                );
                let mut builder = self.http.post(&endpoint).timeout(request_timeout);
                if let Some(key) = api_key.as_ref() {
                    builder = builder.bearer_auth(key);
                }
                match send_with_headers_timeout(builder.json(&payload), headers_timeout).await {
                    SendOutcome::Ready(value) if value.status().is_success() => {
                        let rate_limit = parse_rate_limit_headers(value.headers());
                        break (value, lifecycle, attempt_started, rate_limit);
                    }
                    SendOutcome::Ready(value) => {
                        let code = value.status();
                        let rate_limit = parse_rate_limit_headers(value.headers());
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
                        lifecycle.failed(
                            unix_timestamp(),
                            "http_status",
                            Some(code.as_u16()),
                            u64::try_from(attempt_started.elapsed().as_millis()).ok(),
                            rate_limit,
                        );
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
                        // S2 T5 (belt-and-suspenders forced routing) 400-fallback: some providers
                        // reject a function-forced `tool_choice` outright even though they'd
                        // happily accept the SAME tools with "auto". Try this specific, narrower
                        // fix FIRST — same provider/model, forcing just dropped — before the
                        // broader tool-compatibility swap below assumes the whole tools payload
                        // is the problem. The hard-prune (S2 T4) already narrowed the toolset to
                        // the routed tool, so "auto" still finds it: a graceful degrade, not a
                        // dead end.
                        if code.as_u16() == 400
                            && forced_tool.is_some()
                            && !forced_tool_fallback_tried
                        {
                            forced_tool_fallback_tried = true;
                            forced_tool = None;
                            let _ = emit_stream_event(
                                self.tx,
                                GenerateStreamEvent::Delta {
                                    text: format!(
                                        "‹‹ACT››↩ «{model}» rejected the forced tool selection \
(400); retrying without forcing…‹‹/ACT››"
                                    ),
                                },
                            )
                            .await;
                            payload = build_chat_payload(
                                &model,
                                &base_url,
                                messages,
                                tool_schemas,
                                temperature,
                                is_final_round,
                                forced_tool,
                            );
                            attempt = 0;
                            continue;
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
                                // S2 T5: hardcoded `None`, not `forced_tool` — a provider SWAP is a
                                // bigger fallback than the narrower branch above, and the new
                                // provider/model hasn't been vetted against a forced tool_choice
                                // shape at all.
                                payload = build_chat_payload(
                                    &model,
                                    &base_url,
                                    messages,
                                    tool_schemas,
                                    temperature,
                                    is_final_round,
                                    None,
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
                                    // S2 T5: `None`, same reasoning as the tool-compat swap above —
                                    // the fallback provider hasn't been vetted against forcing.
                                    payload = build_chat_payload(
                                        &model,
                                        &base_url,
                                        messages,
                                        tool_schemas,
                                        temperature,
                                        is_final_round,
                                        None,
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
                        let error_class = match &failure {
                            SendOutcome::HeadersTimeout => "headers_timeout",
                            SendOutcome::Transport(error) if error.is_timeout() => {
                                "transport_timeout"
                            }
                            SendOutcome::Transport(error) if error.is_connect() => {
                                "transport_connect"
                            }
                            SendOutcome::Transport(_) => "transport",
                            SendOutcome::Ready(_) => unreachable!(),
                        };
                        lifecycle.failed(
                            unix_timestamp(),
                            error_class,
                            None,
                            u64::try_from(attempt_started.elapsed().as_millis()).ok(),
                            RateLimitSnapshot::default(),
                        );
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
                                    // S2 T5: `None` — same reasoning as the other provider swaps.
                                    payload = build_chat_payload(
                                        &model,
                                        &base_url,
                                        messages,
                                        tool_schemas,
                                        temperature,
                                        is_final_round,
                                        None,
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
        let (resp, lifecycle, attempt_started, rate_limit) = resp;
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
                let error_class = if error.contains("first token") {
                    "first_token_timeout"
                } else if error.contains("idle") || error.contains("stalled") {
                    "idle_timeout"
                } else {
                    "stream_decode"
                };
                lifecycle.failed(
                    unix_timestamp(),
                    error_class,
                    None,
                    u64::try_from(attempt_started.elapsed().as_millis()).ok(),
                    rate_limit,
                );
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
        let mut terminal_usage = if ollama {
            parse_ollama_usage(&body)
        } else {
            parse_openai_usage(&body)
        };
        let provider_reported = terminal_usage.tokens.input_tokens.is_some()
            || terminal_usage.tokens.output_tokens.is_some()
            || terminal_usage.tokens.reasoning_tokens.is_some()
            || terminal_usage.tokens.cache_read_tokens.is_some()
            || terminal_usage.tokens.cache_write_tokens.is_some();
        let usage_provenance = if provider_reported {
            UsageProvenance::ProviderReported
        } else {
            terminal_usage.tokens.input_tokens =
                Some(estimate_tokens(&serde_json::json!(messages)));
            terminal_usage.tokens.output_tokens = Some(estimate_tokens(&message));
            UsageProvenance::HomunEstimated
        };
        let latency_ms = u64::try_from(attempt_started.elapsed().as_millis()).ok();
        lifecycle.completed(
            unix_timestamp(),
            terminal_usage.clone(),
            usage_provenance,
            latency_ms,
            None,
            finish_reason.clone(),
            rate_limit,
        );
        Ok(ModelRoundOutput {
            message,
            provider: ProviderBinding {
                model,
                base_url,
                api_key,
            },
            finish_reason,
            usage: terminal_usage.tokens,
            latency_ms,
            time_to_first_token_ms: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use local_first_inference_usage::{
        AttemptEventKind, InferencePurpose, Locality, UsageAttemptEvent, UsageContext,
        UsageRecorder,
    };
    use std::{collections::HashSet, sync::Mutex};

    #[derive(Default)]
    struct RecordingUsageRecorder {
        events: Mutex<Vec<UsageAttemptEvent>>,
    }

    impl UsageRecorder for RecordingUsageRecorder {
        fn record(&self, event: UsageAttemptEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    impl RecordingUsageRecorder {
        fn events(&self) -> Vec<UsageAttemptEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    #[test]
    fn openai_usage_keeps_reasoning_cache_and_exact_cost() {
        let usage = parse_openai_usage(&serde_json::json!({
            "prompt_tokens": 100,
            "completion_tokens": 40,
            "completion_tokens_details": {"reasoning_tokens": 12},
            "prompt_tokens_details": {"cached_tokens": 60},
            "cost": 0.00125
        }));
        assert_eq!(usage.tokens.input_tokens, Some(100));
        assert_eq!(usage.tokens.output_tokens, Some(40));
        assert_eq!(usage.tokens.reasoning_tokens, Some(12));
        assert_eq!(usage.tokens.cache_read_tokens, Some(60));
        assert_eq!(usage.provider_cost_microusd, Some(1_250));
    }

    #[test]
    fn ollama_usage_maps_native_terminal_counts() {
        let usage = parse_ollama_usage(&serde_json::json!({
            "prompt_eval_count": 81,
            "eval_count": 23
        }));
        assert_eq!(usage.tokens.input_tokens, Some(81));
        assert_eq!(usage.tokens.output_tokens, Some(23));
        assert_eq!(usage.provider_cost_microusd, None);
    }

    #[test]
    fn retry_records_each_transport_attempt_under_one_call() {
        let recorder = RecordingUsageRecorder::default();
        let context = UsageContext::new("call-1", InferencePurpose::ChatResponse, "local");

        let first = AttemptLifecycle::start(
            &recorder,
            &context,
            "attempt-1",
            "openrouter",
            "model-a",
            Locality::Cloud,
            100,
        );
        first.failed(
            110,
            "headers_timeout",
            None,
            Some(10_000),
            RateLimitSnapshot::default(),
        );
        let second = AttemptLifecycle::start(
            &recorder,
            &context,
            "attempt-2",
            "openrouter",
            "model-a",
            Locality::Cloud,
            120,
        );
        second.completed(
            150,
            ParsedTerminalUsage::default(),
            UsageProvenance::Unavailable,
            Some(30_000),
            None,
            Some("stop".to_string()),
            RateLimitSnapshot::default(),
        );

        let events = recorder.events();
        let terminal_attempts = events
            .iter()
            .filter(|event| event.event_kind != AttemptEventKind::AttemptStarted)
            .count();
        let call_ids = events
            .iter()
            .map(|event| event.call_id.as_str())
            .collect::<HashSet<_>>();
        let attempt_ids = events
            .iter()
            .map(|event| event.attempt_id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(terminal_attempts, 2);
        assert_eq!(call_ids.len(), 1);
        assert_eq!(attempt_ids.len(), 2);
    }

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
