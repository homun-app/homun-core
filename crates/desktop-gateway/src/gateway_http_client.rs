use std::{env, time::Duration};

fn http_connect_timeout_secs_from_env(value: Option<&str>) -> u64 {
    value
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(10)
}

/// The shared gateway HTTP client. One `connect_timeout` here bounds the TCP
/// connect phase for every outbound call (model, embeddings, privacy guard,
/// channels) so an unreachable host fails fast instead of parking a worker.
/// Per-call streaming timeouts layer on top for the model path.
pub(crate) fn build_gateway_http_client() -> reqwest::Client {
    let connect_secs = http_connect_timeout_secs_from_env(
        env::var("HOMUN_HTTP_CONNECT_TIMEOUT_SECS").ok().as_deref(),
    );
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(connect_secs))
        .build()
        // A builder failure here is a TLS/backend init problem, not a per-call
        // error; fall back to the default client so the gateway still boots.
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[cfg(test)]
mod tests {
    use super::http_connect_timeout_secs_from_env;

    #[test]
    fn positive_connect_timeout_override_is_used() {
        assert_eq!(http_connect_timeout_secs_from_env(Some("30")), 30);
        assert_eq!(http_connect_timeout_secs_from_env(Some(" 5 ")), 5);
    }

    #[test]
    fn invalid_connect_timeout_uses_default() {
        assert_eq!(http_connect_timeout_secs_from_env(None), 10);
        assert_eq!(http_connect_timeout_secs_from_env(Some("0")), 10);
        assert_eq!(http_connect_timeout_secs_from_env(Some("-1")), 10);
        assert_eq!(http_connect_timeout_secs_from_env(Some("bad")), 10);
    }
}
