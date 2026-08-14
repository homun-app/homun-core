use std::time::Duration;

const MCP_CALL_TIMEOUT_SECS_DEFAULT: u64 = 30;

/// Timeout for a single MCP `tools/call` from chat. The stdio transport's
/// `read_line` is blocking and uncapped, so without this a hung server would
/// freeze the turn forever. Overridable via `HOMUN_MCP_CALL_TIMEOUT_SECS`.
pub(crate) fn mcp_call_timeout() -> Duration {
    mcp_call_timeout_from_env(std::env::var("HOMUN_MCP_CALL_TIMEOUT_SECS").ok().as_deref())
}

fn mcp_call_timeout_from_env(raw: Option<&str>) -> Duration {
    let secs = raw
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(MCP_CALL_TIMEOUT_SECS_DEFAULT);
    Duration::from_secs(secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_call_timeout_defaults_to_bounded_policy() {
        assert_eq!(
            mcp_call_timeout_from_env(None),
            Duration::from_secs(MCP_CALL_TIMEOUT_SECS_DEFAULT)
        );
    }

    #[test]
    fn mcp_call_timeout_ignores_invalid_or_zero_values() {
        assert_eq!(
            mcp_call_timeout_from_env(Some("0")),
            Duration::from_secs(MCP_CALL_TIMEOUT_SECS_DEFAULT)
        );
        assert_eq!(
            mcp_call_timeout_from_env(Some("not-a-number")),
            Duration::from_secs(MCP_CALL_TIMEOUT_SECS_DEFAULT)
        );
    }

    #[test]
    fn mcp_call_timeout_accepts_positive_override() {
        assert_eq!(
            mcp_call_timeout_from_env(Some("45")),
            Duration::from_secs(45)
        );
    }
}
