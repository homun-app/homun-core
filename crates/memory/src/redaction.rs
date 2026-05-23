pub fn redact_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut redacted = serde_json::Map::new();
            for (key, value) in map {
                if is_secret_key(key) {
                    redacted.insert(
                        key.clone(),
                        serde_json::Value::String("[REDACTED]".to_string()),
                    );
                } else {
                    redacted.insert(key.clone(), redact_json(value));
                }
            }
            serde_json::Value::Object(redacted)
        }
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(redact_json).collect())
        }
        serde_json::Value::String(text) => serde_json::Value::String(redact_text(text)),
        other => other.clone(),
    }
}

pub fn redact_text(text: &str) -> String {
    let lowered = text.to_ascii_lowercase();
    if lowered.contains("api key")
        || lowered.contains("access token")
        || lowered.contains("password")
        || lowered.contains("secret")
        || lowered.contains("authorization:")
    {
        "[REDACTED]".to_string()
    } else {
        text.to_string()
    }
}

pub fn contains_secret(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => map
            .iter()
            .any(|(key, value)| is_secret_key(key) || contains_secret(value)),
        serde_json::Value::Array(values) => values.iter().any(contains_secret),
        serde_json::Value::String(text) => redact_text(text) == "[REDACTED]",
        _ => false,
    }
}

fn is_secret_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['-', ' '], "_");
    normalized.contains("api_key")
        || normalized.contains("access_token")
        || normalized.contains("auth_token")
        || normalized.contains("password")
        || normalized.contains("secret")
        || normalized.contains("private_key")
        || normalized == "authorization"
        || normalized == "cookie"
}
