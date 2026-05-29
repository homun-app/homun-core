use local_first_subagents::{GenerateJsonRequest, GenerateJsonResponse, TokenMetrics};
use serde_json::Value;

/// Turns a model's raw text output into our JSON response contract: strips a
/// markdown code fence, parses, and (when `repair` is set) falls back to the
/// first balanced JSON object so stray trailing tokens do not discard an
/// otherwise-valid object. Shared by every provider so JSON handling is
/// identical regardless of backend (OpenAI-compatible, mistral.rs, ...).
pub fn json_response_from_text(
    content: String,
    request: &GenerateJsonRequest,
    metrics: TokenMetrics,
) -> GenerateJsonResponse {
    let json_text = extract_json_text(&content);
    let (parsed, repaired) = match serde_json::from_str::<Value>(&json_text) {
        Ok(value) => (Ok(value), false),
        Err(error) if request.repair => match first_json_object(&json_text) {
            Some(object) => (serde_json::from_str::<Value>(&object), true),
            None => (Err(error), false),
        },
        Err(error) => (Err(error), false),
    };

    match parsed {
        Ok(value) => {
            let missing = missing_required_keys(&value, &request.required_keys);
            GenerateJsonResponse {
                valid: missing.is_empty(),
                errors: if missing.is_empty() {
                    Vec::new()
                } else {
                    vec![format!("missing required keys: {}", missing.join(", "))]
                },
                json: value,
                raw_output: content,
                repaired,
                metrics,
            }
        }
        Err(error) => GenerateJsonResponse {
            valid: false,
            errors: vec![format!("response content is not valid JSON: {error}")],
            json: Value::Null,
            raw_output: content,
            repaired: false,
            metrics,
        },
    }
}

/// Strips a leading/trailing markdown code fence if a model wrapped its JSON in
/// one (common with smaller local models).
pub fn extract_json_text(content: &str) -> String {
    let trimmed = content.trim();
    let Some(stripped) = trimmed.strip_prefix("```") else {
        return trimmed.to_string();
    };
    let after_lang = stripped.splitn(2, '\n').nth(1).unwrap_or("");
    after_lang
        .trim_end()
        .strip_suffix("```")
        .unwrap_or(after_lang)
        .trim()
        .to_string()
}

/// Extracts the first balanced top-level JSON object (`{...}`) from text,
/// ignoring anything before or after it. String contents and escapes are
/// respected so braces inside strings do not confuse the scan.
pub fn first_json_object(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let start = text.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for index in start..bytes.len() {
        let byte = bytes[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[start..=index].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn missing_required_keys(value: &Value, required_keys: &[String]) -> Vec<String> {
    let Some(object) = value.as_object() else {
        return required_keys.to_vec();
    };
    required_keys
        .iter()
        .filter(|key| !object.contains_key(key.as_str()))
        .cloned()
        .collect()
}
