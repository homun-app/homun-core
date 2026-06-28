//! Model-output normalization (ADR 0019): the anti-corruption boundary between the
//! varied raw shapes models emit and ONE canonical, provably-valid representation that
//! the harness + UI consume. "Pydantic in Rust": serde-permissive `Raw*` types →
//! strict `Canonical*` via `TryFrom`, so illegal states are unrepresentable — once a
//! `Canonical` exists it is valid by construction.
//!
//! First slice (ADR 0019, step 1): the `‹‹PLAN_PROPOSE››` plan proposal, tolerant to
//! `steps` being plain strings OR rich objects (e.g. gemma proposes object-steps).
//! This is the gateway-side parser that supersedes the frontend's hand-rolled regex
//! coercion (`ChatView.tsx::PLAN_PROPOSE_RE`).

use serde::Deserialize;

/// Build the canonical assistant-response body `{choices:[{message, finish_reason}]}` that the
/// agent loop consumes, from a streamed/assembled response's parts. This is the SINGLE place
/// where a raw model response becomes the canonical shape — it centralizes the one
/// model-independent rule that used to be duplicated across the OpenAI and Ollama stream
/// collectors:
///
/// - **Reasoning fallback**: a thinking model that put the whole answer in `reasoning` and left
///   `content` empty (the GLM/kimi dead-end) → fall back to the reasoning, so the turn never
///   commits an empty answer (only the Sources footer, the reported bug). Model-independent,
///   supersedes the per-provider thinking-disable hack.
/// - **Tool calls** are attached ONLY when present: OpenAI-compat wants the field omitted, not
///   an empty array.
///
/// F0 / ADR 0019: the convergence point for model-output normalization. Future slices fold
/// sanitization and tool-call-as-text parsing in here too, so every provider path produces ONE
/// canonical representation by construction.
/// Pull `<think>…</think>` / `<thinking>…</thinking>` reasoning blocks OUT of model content,
/// returning `(content_without_think, reasoning)`. Reasoning models emit their trace inline
/// like this when not asked with a separate-thinking flag (e.g. Ollama without `think:true`).
/// Centralizing it here keeps the trace available for the reasoning-fallback, instead of the
/// loop's text sanitizer deleting it. Only well-formed (closed) blocks are extracted; a stray
/// unclosed tag is left for the downstream sanitizer.
pub fn split_reasoning_from_content(content: &str) -> (String, String) {
    let mut clean = content.to_string();
    let mut reasoning = String::new();
    for (open, close) in [("<think>", "</think>"), ("<thinking>", "</thinking>")] {
        while let Some(o) = clean.find(open) {
            let after = o + open.len();
            let Some(close_rel) = clean[after..].find(close) else {
                break; // unclosed → leave it for the sanitizer
            };
            let inner = clean[after..after + close_rel].trim();
            if !inner.is_empty() {
                if !reasoning.is_empty() {
                    reasoning.push('\n');
                }
                reasoning.push_str(inner);
            }
            clean.replace_range(o..after + close_rel + close.len(), "");
        }
    }
    (clean.trim().to_string(), reasoning)
}

pub fn assistant_response(
    content: String,
    reasoning: String,
    tool_calls: Vec<serde_json::Value>,
    finish_reason: &str,
) -> serde_json::Value {
    // Pull any inline `<think>…</think>` reasoning OUT of content into the reasoning channel.
    // A reasoning model that wasn't asked with Ollama's `think:true` (so `message.thinking` is
    // empty) emits its trace inline as these tags; extracting it here — instead of the loop's
    // text sanitizer silently DELETING it — lets the fallback below recover an answer when the
    // model put everything inside the think block (else: empty answer committed). An explicit
    // `reasoning` (e.g. OpenAI `reasoning_content`, Ollama `message.thinking`) still wins.
    let (content, inline_reasoning) = split_reasoning_from_content(&content);
    let reasoning = if reasoning.trim().is_empty() {
        inline_reasoning
    } else {
        reasoning
    };
    let content = if content.trim().is_empty() && !reasoning.trim().is_empty() {
        reasoning
    } else {
        content
    };
    let mut message = serde_json::json!({ "role": "assistant", "content": content });
    if !tool_calls.is_empty() {
        message["tool_calls"] = serde_json::Value::Array(tool_calls);
    }
    serde_json::json!({
        "choices": [ { "message": message, "finish_reason": finish_reason } ]
    })
}

/// Normalize ONE Ollama-native tool call into the OpenAI-compat shape the agent loop expects.
/// Ollama native `/api/chat` differs from OpenAI in two ways that must be reconciled HERE (not
/// scattered): it omits the call `id`, and it sends `arguments` as a JSON **object**, not a
/// string. The loop + OpenAI-compat downstream want `{id, type:"function", function:{name,
/// arguments:<string>}}`. The synthetic id is stable within a turn via `index` (the number of
/// calls already collected). Unlike OpenAI (whose tool_calls arrive already-shaped, only their
/// argument fragments need reassembling), Ollama needs this shape coercion.
pub fn ollama_tool_call(call: &serde_json::Value, index: usize) -> serde_json::Value {
    let name = call
        .get("function")
        .and_then(|f| f.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("");
    let arguments = match call.get("function").and_then(|f| f.get("arguments")) {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(value) => serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string()),
        None => "{}".to_string(),
    };
    serde_json::json!({
        "id": format!("ollama_call_{index}"),
        "type": "function",
        "function": { "name": name, "arguments": arguments }
    })
}

/// Read `attr="value"` from a tag/block. Shared by the tool-as-text parsers below.
fn xml_attr_value(block: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=\"");
    let start = block.find(&needle)? + needle.len();
    let rest = &block[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Build a JSON args object from Claude/MiniMax-style
/// `<parameter name="p">value</parameter>` pairs inside an `<invoke>` block.
fn parse_xml_parameters(block: &str) -> String {
    let mut map = serde_json::Map::new();
    let mut rest = block;
    while let Some(pos) = rest.find("<parameter") {
        let after = &rest[pos..];
        let Some(name) = xml_attr_value(after, "name") else {
            break;
        };
        let Some(gt) = after.find('>') else { break };
        let value_region = &after[gt + 1..];
        let Some(close) = value_region.find("</parameter>") else {
            break;
        };
        let value = value_region[..close].trim().to_string();
        map.insert(name, serde_json::Value::String(value));
        rest = &value_region[close + "</parameter>".len()..];
    }
    serde_json::Value::Object(map).to_string()
}

/// Parse tool calls a model emitted as TEXT instead of the structured `tool_calls`
/// field. This is the cross-model floor: weak models (minimax, Hermes/Qwen via Ollama)
/// leak their native chat-template syntax into `content` rather than returning structured
/// calls, so the loop would otherwise see "no tool call" and stall. Normalizing it HERE —
/// not in the loop — keeps every way a call can arrive (structured or leaked-as-text) on
/// the one canonical boundary (ADR 0019). Handles the two common leaked formats:
///   - Hermes/Qwen JSON:   `<tool_call>{"name":"X","arguments":{...}}</tool_call>`
///   - Claude/MiniMax XML: `<invoke name="X"><parameter name="p">v</parameter></invoke>`
/// Returns `(name, arguments_json)`, filtered to `known` tool names so prose that merely
/// mentions a tag is not mistaken for a call.
pub fn parse_text_tool_calls(text: &str, known: &[String]) -> Vec<(String, String)> {
    let cleaned = text.replace("]<]minimax[>[", "");
    let mut out: Vec<(String, String)> = Vec::new();
    // 1) Claude/MiniMax XML invokes.
    let mut rest = cleaned.as_str();
    while let Some(pos) = rest.find("<invoke") {
        let after = &rest[pos..];
        let Some(close) = after.find("</invoke>") else {
            break;
        };
        let block = &after[..close];
        if let Some(name) = xml_attr_value(block, "name") {
            if known.iter().any(|k| k == &name) {
                out.push((name, parse_xml_parameters(block)));
            }
        }
        rest = &after[close + "</invoke>".len()..];
    }
    // 2) Hermes/Qwen JSON tool_calls (only if no XML invokes were found).
    if out.is_empty() {
        let mut rest = cleaned.as_str();
        while let Some(pos) = rest.find("<tool_call>") {
            let after = &rest[pos + "<tool_call>".len()..];
            let Some(close) = after.find("</tool_call>") else {
                break;
            };
            let inner = after[..close].trim();
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(inner) {
                if let Some(name) = value.get("name").and_then(|n| n.as_str()) {
                    if known.iter().any(|k| k == name) {
                        let args = value
                            .get("arguments")
                            .map(|a| a.to_string())
                            .unwrap_or_else(|| "{}".to_string());
                        out.push((name.to_string(), args));
                    }
                }
            }
            rest = &after[close + "</tool_call>".len()..];
        }
    }
    out
}

/// Synthesize an OpenAI-style `tool_calls` array from text-parsed calls so the existing
/// dispatch path handles them unchanged. The synthetic `id` is stable within a round via
/// `round`+`index` (mirrors `ollama_tool_call`'s id strategy).
pub fn synthesize_tool_calls(round: usize, parsed: Vec<(String, String)>) -> Vec<serde_json::Value> {
    parsed
        .into_iter()
        .enumerate()
        .map(|(index, (name, arguments))| {
            serde_json::json!({
                "id": format!("textcall_{round}_{index}"),
                "type": "function",
                "function": { "name": name, "arguments": arguments }
            })
        })
        .collect()
}

/// Strip a balanced `<open>…<close>` block (all occurrences) from text. Used by
/// `sanitize_model_text`. An unclosed `open` drops the rest (a streamed/truncated tag).
fn strip_tag_blocks(input: &str, open: &str, close: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find(open) {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        match after.find(close) {
            Some(end_rel) => rest = &after[end_rel + close.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Removes `<…｜…>` / `</…｜…>` tokens (fullwidth bar U+FF5C) that some models (GLM/Zhipu) leak as
/// text instead of using structured tool calls — e.g. `<｜tool▁calls▁begin｜>`. A leaked end-token
/// can also replace a marker's proper close, so stripping it keeps the marker parseable.
fn strip_fullwidth_bar_tokens(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' {
            if let Some(rel) = chars[i..].iter().position(|&c| c == '>') {
                if chars[i..=i + rel].iter().any(|&c| c == '｜') {
                    i += rel + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Strip model control-token leakage from text shown to the user: native tool-call / reasoning
/// template tokens some models (MiniMax via Ollama's shim, GLM, …) leak into `content` instead of
/// the structured fields. Conservative — only KNOWN control markup is removed. The final
/// defensive net in L0 (the canonical builder already extracts `<think>` into reasoning upstream).
pub fn sanitize_model_text(text: &str) -> String {
    let mut s = strip_fullwidth_bar_tokens(&text.replace("]<]minimax[>[", ""));
    for (open, close) in [
        ("<tool_call>", "</tool_call>"),
        ("<invoke", "</invoke>"),
        ("<function_calls>", "</function_calls>"),
        ("<think>", "</think>"),
        ("<thinking>", "</thinking>"),
    ] {
        s = strip_tag_blocks(&s, open, close);
    }
    for stray in [
        "<tool_call>",
        "</tool_call>",
        "</invoke>",
        "<parameter>",
        "</parameter>",
    ] {
        s = s.replace(stray, "");
    }
    s.trim().to_string()
}

pub const PLAN_PROPOSE_OPEN: &str = "‹‹PLAN_PROPOSE››";
pub const PLAN_PROPOSE_CLOSE: &str = "‹‹/PLAN_PROPOSE››";

#[derive(Debug, PartialEq, Eq)]
pub enum NormalizeError {
    NotFound,
    Malformed,
    EmptyPlan,
}

/// A proposed step as a model may emit it: a bare label, or a rich object. Tolerant by
/// construction (`untagged`) — no manual "is it a string?" filtering at the call site.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawStep {
    Label(String),
    Rich {
        #[serde(default)]
        title: String,
        #[serde(default)]
        step: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        detail: String,
    },
}

impl RawStep {
    /// The human label: the bare string, or the first non-blank object field.
    fn label(self) -> String {
        match self {
            RawStep::Label(t) => t,
            RawStep::Rich {
                title,
                step,
                name,
                detail,
            } => [title, step, name, detail]
                .into_iter()
                .find(|c| !c.trim().is_empty())
                .unwrap_or_default(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawPlanPropose {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    steps: Vec<RawStep>,
}

/// Canonical plan proposal: guaranteed non-empty, all-non-blank steps. The UI renders
/// it with no defensive checks (the empty-card bug is unrepresentable here).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanProposed {
    pub summary: String,
    pub steps: Vec<String>,
}

impl TryFrom<RawPlanPropose> for PlanProposed {
    type Error = NormalizeError;
    fn try_from(raw: RawPlanPropose) -> Result<Self, Self::Error> {
        let steps: Vec<String> = raw
            .steps
            .into_iter()
            .map(RawStep::label)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if steps.is_empty() {
            return Err(NormalizeError::EmptyPlan);
        }
        Ok(PlanProposed {
            summary: raw.summary.trim().to_string(),
            steps,
        })
    }
}

/// Extract + normalize the LAST `‹‹PLAN_PROPOSE››{json}‹‹/PLAN_PROPOSE››` block from
/// model text into a canonical proposal. The single tolerant parser (ADR 0019) —
/// strings OR objects, both accepted; the frontend regex retires once events are wired.
pub fn parse_plan_propose(text: &str) -> Result<PlanProposed, NormalizeError> {
    let open = text.rfind(PLAN_PROPOSE_OPEN).ok_or(NormalizeError::NotFound)?;
    let after = open + PLAN_PROPOSE_OPEN.len();
    let close_rel = text[after..]
        .find(PLAN_PROPOSE_CLOSE)
        .ok_or(NormalizeError::Malformed)?;
    let json = text[after..after + close_rel].trim();
    let raw: RawPlanPropose = serde_json::from_str(json).map_err(|_| NormalizeError::Malformed)?;
    PlanProposed::try_from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_known_control_tokens() {
        assert_eq!(sanitize_model_text("<think>reasoning</think>Answer."), "Answer.");
        assert_eq!(sanitize_model_text("ok<tool_call>{}</tool_call>"), "ok");
        assert_eq!(sanitize_model_text("a]<]minimax[>[b"), "ab");
        assert_eq!(sanitize_model_text("x<｜tool▁calls▁begin｜>y"), "xy");
        // Plain text is untouched (besides trim).
        assert_eq!(sanitize_model_text("  hello  "), "hello");
    }

    #[test]
    fn split_reasoning_extracts_think_tags() {
        let (content, reasoning) =
            split_reasoning_from_content("<think>step by step</think>The answer is 8.");
        assert_eq!(content, "The answer is 8.");
        assert_eq!(reasoning, "step by step");
        // No tags → content unchanged, reasoning empty.
        let (c, r) = split_reasoning_from_content("plain answer");
        assert_eq!(c, "plain answer");
        assert_eq!(r, "");
    }

    #[test]
    fn assistant_response_recovers_answer_buried_in_think_tags() {
        // Ollama reasoning model without think:true: whole answer inside <think>, content
        // otherwise empty → sanitizer would delete it → empty. Canonical builder recovers it.
        let body = assistant_response("<think>the real answer</think>".into(), String::new(), vec![], "stop");
        assert_eq!(body["choices"][0]["message"]["content"], "the real answer");
    }

    #[test]
    fn assistant_response_keeps_content_when_present() {
        let body = assistant_response("hello".into(), "thoughts".into(), vec![], "stop");
        assert_eq!(body["choices"][0]["message"]["content"], "hello");
        assert_eq!(body["choices"][0]["finish_reason"], "stop");
        assert!(body["choices"][0]["message"].get("tool_calls").is_none());
    }

    #[test]
    fn assistant_response_falls_back_to_reasoning_when_content_empty() {
        // The GLM/kimi dead-end: whole answer in reasoning, content blank.
        let body = assistant_response("   ".into(), "the real answer".into(), vec![], "stop");
        assert_eq!(body["choices"][0]["message"]["content"], "the real answer");
    }

    #[test]
    fn assistant_response_attaches_tool_calls_only_when_present() {
        let call = serde_json::json!({"id":"c1","type":"function","function":{"name":"x","arguments":"{}"}});
        let body = assistant_response(String::new(), String::new(), vec![call.clone()], "tool_calls");
        assert_eq!(body["choices"][0]["message"]["tool_calls"][0], call);
        // No reasoning, no content → content stays empty (not replaced by an empty reasoning).
        assert_eq!(body["choices"][0]["message"]["content"], "");
    }

    #[test]
    fn ollama_tool_call_stringifies_object_arguments_and_synthesizes_id() {
        // Ollama native shape: no id, arguments as an OBJECT.
        let raw = serde_json::json!({
            "function": { "name": "get_weather", "arguments": {"city": "London"} }
        });
        let norm = ollama_tool_call(&raw, 0);
        assert_eq!(norm["id"], "ollama_call_0");
        assert_eq!(norm["type"], "function");
        assert_eq!(norm["function"]["name"], "get_weather");
        // arguments must be a STRING (OpenAI-compat), the JSON-encoded object.
        let args = norm["function"]["arguments"].as_str().unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(args).unwrap()["city"], "London");
    }

    #[test]
    fn ollama_tool_call_keeps_string_arguments_and_handles_missing() {
        let with_str = serde_json::json!({"function":{"name":"x","arguments":"{\"a\":1}"}});
        assert_eq!(ollama_tool_call(&with_str, 2)["function"]["arguments"], "{\"a\":1}");
        assert_eq!(ollama_tool_call(&with_str, 2)["id"], "ollama_call_2");
        let missing = serde_json::json!({"function":{"name":"x"}});
        assert_eq!(ollama_tool_call(&missing, 0)["function"]["arguments"], "{}");
    }

    #[test]
    fn parse_text_tool_calls_extracts_claude_xml_invoke() {
        // Claude/MiniMax leaked into content: <invoke name=...><parameter ...>.
        let known = vec!["browse_web".to_string()];
        let text = r#"sure ]<]minimax[>[<invoke name="browse_web"><parameter name="query">trains to Rome</parameter></invoke> done"#;
        let calls = parse_text_tool_calls(text, &known);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "browse_web");
        let args: serde_json::Value = serde_json::from_str(&calls[0].1).unwrap();
        assert_eq!(args["query"], "trains to Rome");
    }

    #[test]
    fn parse_text_tool_calls_extracts_hermes_json() {
        // Hermes/Qwen leaked JSON tool_call.
        let known = vec!["get_weather".to_string()];
        let text = r#"<tool_call>{"name":"get_weather","arguments":{"city":"London"}}</tool_call>"#;
        let calls = parse_text_tool_calls(text, &known);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "get_weather");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&calls[0].1).unwrap()["city"], "London");
    }

    #[test]
    fn parse_text_tool_calls_ignores_unknown_and_prose() {
        // A tag for a tool not in `known`, or mere prose mentioning a name, is NOT a call.
        let known = vec!["browse_web".to_string()];
        assert!(parse_text_tool_calls(
            r#"<invoke name="rm_rf"><parameter name="p">x</parameter></invoke>"#,
            &known,
        )
        .is_empty());
        assert!(parse_text_tool_calls("I could browse_web for you", &known).is_empty());
    }

    #[test]
    fn synthesize_tool_calls_builds_openai_shape_with_stable_ids() {
        let calls = synthesize_tool_calls(3, vec![("a".into(), "{}".into()), ("b".into(), "{\"x\":1}".into())]);
        assert_eq!(calls[0]["id"], "textcall_3_0");
        assert_eq!(calls[0]["type"], "function");
        assert_eq!(calls[0]["function"]["name"], "a");
        assert_eq!(calls[1]["id"], "textcall_3_1");
        assert_eq!(calls[1]["function"]["arguments"], "{\"x\":1}");
    }

    #[test]
    fn accepts_string_steps() {
        let t = r#"prefix ‹‹PLAN_PROPOSE››{"summary":"S","steps":["a","b"]}‹‹/PLAN_PROPOSE›› suffix"#;
        let p = parse_plan_propose(t).unwrap();
        assert_eq!(p.summary, "S");
        assert_eq!(p.steps, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn accepts_object_steps() {
        // gemma's shape: steps are rich objects → previously dropped, leaving an empty card.
        let t = r#"‹‹PLAN_PROPOSE››{"summary":"Briefing","steps":[{"id":"s1","title":"Squadre","detail":"x"},{"id":"s2","title":"Partite"}]}‹‹/PLAN_PROPOSE››"#;
        let p = parse_plan_propose(t).unwrap();
        assert_eq!(p.steps, vec!["Squadre".to_string(), "Partite".to_string()]);
    }

    #[test]
    fn rejects_missing_and_empty() {
        assert_eq!(parse_plan_propose("no marker"), Err(NormalizeError::NotFound));
        let empty = r#"‹‹PLAN_PROPOSE››{"steps":[]}‹‹/PLAN_PROPOSE››"#;
        assert_eq!(parse_plan_propose(empty), Err(NormalizeError::EmptyPlan));
        let blanks = r#"‹‹PLAN_PROPOSE››{"steps":["  ",{"title":""}]}‹‹/PLAN_PROPOSE››"#;
        assert_eq!(parse_plan_propose(blanks), Err(NormalizeError::EmptyPlan));
    }
}
