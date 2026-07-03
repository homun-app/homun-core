//! Provider-specific chat-request payload shaping (ADR 0024 Inc-1, extracted from the
//! gateway monolith). PURE: the impure lookups the gateway did inline — model capability
//! cache (`ollama_capabilities`), env flags — are lifted to PARAMETERS, so the gateway
//! keeps a same-signature wrapper (does the lookups) and this owns the shape. Native
//! Ollama `/api/chat` vs OpenAI-compat `/v1`, plus the z.ai "thinking-off" and Ollama
//! `think`/tool-capability quirks. No IO, no runtime — testable in isolation.

use serde_json::Value;

/// Convert OpenAI-shaped chat messages to Ollama native `/api/chat` shape: multipart
/// content (text + `image_url`) is flattened to a `content` string + raw-base64 `images`;
/// `tool_calls` arguments are normalized to a JSON object under `function`.
pub fn to_ollama_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| {
            let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
            let mut out = serde_json::Map::new();
            out.insert("role".into(), Value::String(role.to_string()));
            match m.get("content") {
                Some(Value::Array(parts)) => {
                    let mut text = String::new();
                    let mut images: Vec<Value> = Vec::new();
                    for part in parts {
                        match part.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(t) = part.get("text").and_then(|x| x.as_str()) {
                                    text.push_str(t);
                                }
                            }
                            Some("image_url") => {
                                if let Some(url) = part
                                    .get("image_url")
                                    .and_then(|u| u.get("url"))
                                    .and_then(|x| x.as_str())
                                {
                                    // Native wants raw base64 (no data: prefix).
                                    let b64 = url.rsplit("base64,").next().unwrap_or(url);
                                    images.push(Value::String(b64.to_string()));
                                }
                            }
                            _ => {}
                        }
                    }
                    out.insert("content".into(), Value::String(text));
                    if !images.is_empty() {
                        out.insert("images".into(), Value::Array(images));
                    }
                }
                Some(Value::String(s)) => {
                    out.insert("content".into(), Value::String(s.clone()));
                }
                Some(other) => {
                    out.insert("content".into(), other.clone());
                }
                None => {
                    out.insert("content".into(), Value::String(String::new()));
                }
            }
            if let Some(calls) = m.get("tool_calls").and_then(|v| v.as_array()) {
                let converted: Vec<Value> = calls
                    .iter()
                    .map(|tc| {
                        let name = tc
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(|n| n.as_str())
                            .unwrap_or("");
                        let args = match tc.get("function").and_then(|f| f.get("arguments")) {
                            Some(Value::String(s)) => serde_json::from_str::<Value>(s)
                                .unwrap_or_else(|_| serde_json::json!({})),
                            Some(value) => value.clone(),
                            None => serde_json::json!({}),
                        };
                        serde_json::json!({ "function": { "name": name, "arguments": args } })
                    })
                    .collect();
                if !converted.is_empty() {
                    out.insert("tool_calls".into(), Value::Array(converted));
                }
            }
            Value::Object(out)
        })
        .collect()
}

/// Build the streaming chat-completion request body for the model. PURE: the gateway
/// wrapper resolves the flags from the capability cache / env and passes them in:
/// - `is_ollama`: native `/api/chat` shape vs OpenAI-compat `/v1`.
/// - `zai_thinking_disabled`: z.ai GLM defaults to thinking-mode (empty `content`) → off.
/// - `tool_capable` / `thinking_supported`: Ollama `/api/show` capabilities.
/// - `max_tokens`: output cap (final round vs normal), computed by the caller.
/// Tools are omitted on the final round (force a text answer) and, on Ollama, when the
/// model isn't tool-capable.
#[allow(clippy::too_many_arguments)]
pub fn build_chat_payload(
    model: &str,
    messages: &[Value],
    tools: &[Value],
    temperature: f64,
    is_final_round: bool,
    is_ollama: bool,
    zai_thinking_disabled: bool,
    tool_capable: bool,
    thinking_supported: bool,
    max_tokens: u32,
) -> Value {
    if is_ollama {
        let mut payload = serde_json::json!({
            "model": model,
            "messages": to_ollama_messages(messages),
            "stream": true,
            "keep_alive": "10m",
            "options": { "temperature": temperature, "num_predict": max_tokens },
        });
        if !is_final_round && !tools.is_empty() && tool_capable {
            payload["tools"] = Value::Array(tools.to_vec());
        }
        if thinking_supported {
            payload["think"] = Value::Bool(true);
        }
        payload
    } else {
        let mut payload = serde_json::json!({
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": true,
        });
        if zai_thinking_disabled {
            payload["thinking"] = serde_json::json!({ "type": "disabled" });
        }
        if !is_final_round && !tools.is_empty() {
            payload["tools"] = Value::Array(tools.to_vec());
            payload["tool_choice"] = Value::String("auto".to_string());
        }
        payload
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ollama_payload_uses_native_shape_and_options() {
        let msgs = vec![serde_json::json!({"role": "user", "content": "hi"})];
        let tools = vec![serde_json::json!({"function": {"name": "t"}})];
        let p = build_chat_payload("gemma", &msgs, &tools, 0.3, false, true, false, true, false, 6000);
        assert_eq!(p["stream"], serde_json::json!(true));
        assert_eq!(p["keep_alive"], serde_json::json!("10m"));
        assert_eq!(p["options"]["num_predict"], serde_json::json!(6000));
        assert!(p.get("tools").is_some(), "tool-capable non-final → tools offered");
        assert!(p.get("think").is_none(), "thinking not supported → no think");
    }

    #[test]
    fn ollama_final_round_and_incapable_strip_tools() {
        let msgs = vec![serde_json::json!({"role": "user", "content": "hi"})];
        let tools = vec![serde_json::json!({"function": {"name": "t"}})];
        // final round → no tools
        let f = build_chat_payload("gemma", &msgs, &tools, 0.3, true, true, false, true, false, 500);
        assert!(f.get("tools").is_none());
        // not tool-capable → no tools even mid-turn
        let nc = build_chat_payload("gemma", &msgs, &tools, 0.3, false, true, false, false, false, 6000);
        assert!(nc.get("tools").is_none());
    }

    #[test]
    fn openai_payload_shape_and_zai_thinking_off() {
        let msgs = vec![serde_json::json!({"role": "user", "content": "hi"})];
        let tools = vec![serde_json::json!({"function": {"name": "t"}})];
        let p = build_chat_payload("glm", &msgs, &tools, 0.5, false, false, true, true, false, 6000);
        assert_eq!(p["max_tokens"], serde_json::json!(6000));
        assert_eq!(p["thinking"], serde_json::json!({ "type": "disabled" }));
        assert_eq!(p["tool_choice"], serde_json::json!("auto"));
        assert!(p.get("tools").is_some());
        // non-zai → no thinking key
        let n = build_chat_payload("gpt", &msgs, &tools, 0.5, false, false, false, true, false, 6000);
        assert!(n.get("thinking").is_none());
    }

    #[test]
    fn to_ollama_flattens_multipart_and_normalizes_tool_calls() {
        let msgs = vec![serde_json::json!({
            "role": "user",
            "content": [
                {"type": "text", "text": "look"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,ABC"}}
            ]
        })];
        let out = to_ollama_messages(&msgs);
        assert_eq!(out[0]["content"], serde_json::json!("look"));
        assert_eq!(out[0]["images"], serde_json::json!(["ABC"]));
    }
}
