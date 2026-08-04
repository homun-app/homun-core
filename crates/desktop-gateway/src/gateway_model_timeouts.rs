use std::env;

fn positive_u64_or_default(raw: Option<&str>, default: u64) -> u64 {
    raw.and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

/// Total per-request timeout for a model completion (seconds). Default 3600s:
/// big reasoning models on slow proxies (e.g. nemotron on Ollama cloud) routinely
/// need far more than the old fixed 180s, and editors like Zed don't cap total time
/// at all because they stream. Override with HOMUN_MODEL_TIMEOUT_SECS.
pub(crate) fn model_request_timeout_secs() -> u64 {
    // High ceiling: with streaming the real governors are the first-token + idle
    // timeouts. A total cap that fires mid-stream is reported by reqwest as
    // "error decoding response body" (#2839), so keep it well above any real turn.
    positive_u64_or_default(env::var("HOMUN_MODEL_TIMEOUT_SECS").ok().as_deref(), 3600)
}

/// Time-to-response-headers budget for the model call (seconds). Bounds the
/// pre-stream phase: TCP connect, request send, and arrival of HTTP response
/// headers. Override with HOMUN_MODEL_HEADERS_TIMEOUT_SECS.
pub(crate) fn model_headers_timeout_secs() -> u64 {
    positive_u64_or_default(
        env::var("HOMUN_MODEL_HEADERS_TIMEOUT_SECS").ok().as_deref(),
        120,
    )
}

/// Idle inter-token timeout for streamed completions (seconds). With streaming
/// the governor is inactivity, not total time. Override with
/// HOMUN_MODEL_IDLE_TIMEOUT_SECS.
pub(crate) fn model_idle_timeout_secs() -> u64 {
    positive_u64_or_default(
        env::var("HOMUN_MODEL_IDLE_TIMEOUT_SECS").ok().as_deref(),
        180,
    )
}

/// Generous budget for the first token (seconds): Ollama may cold-load a big
/// model or the cloud may take a moment before the first byte. Inter-token gaps
/// use the tighter idle timeout. Override with HOMUN_MODEL_FIRST_TOKEN_SECS.
pub(crate) fn model_first_token_timeout_secs() -> u64 {
    positive_u64_or_default(
        env::var("HOMUN_MODEL_FIRST_TOKEN_SECS").ok().as_deref(),
        300,
    )
}

#[cfg(test)]
mod tests {
    use super::positive_u64_or_default;

    #[test]
    fn positive_values_override_the_default() {
        assert_eq!(positive_u64_or_default(Some("42"), 10), 42);
        assert_eq!(positive_u64_or_default(Some(" 7 "), 10), 7);
    }

    #[test]
    fn zero_negative_invalid_or_missing_values_use_the_default() {
        assert_eq!(positive_u64_or_default(Some("0"), 10), 10);
        assert_eq!(positive_u64_or_default(Some("-1"), 10), 10);
        assert_eq!(positive_u64_or_default(Some("bad"), 10), 10);
        assert_eq!(positive_u64_or_default(None, 10), 10);
    }
}
