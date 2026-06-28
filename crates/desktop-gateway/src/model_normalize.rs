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
pub fn assistant_response(
    content: String,
    reasoning: String,
    tool_calls: Vec<serde_json::Value>,
    finish_reason: &str,
) -> serde_json::Value {
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
