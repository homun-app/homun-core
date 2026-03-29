//! Browser action policy — category-based allow/deny rules.
//!
//! Checked in the agent loop *before* the browser tool executes, right
//! after the browser-task-planner veto.  Returns `Some(reason)` to deny
//! an action, `None` to allow it.

use crate::config::BrowserPolicyConfig;

/// Map a browser action name to its policy category.
fn action_category(action: &str) -> &'static str {
    match action {
        "navigate" => "navigate",
        "click" | "click_coordinates" | "hold_click" => "click",
        "type" | "fill" | "fill_form" | "select_option" | "press_key" => "fill",
        "snapshot" | "screenshot" => "observe",
        "hover" | "scroll" | "drag" => "interact",
        "evaluate" => "eval",
        "tab_list" | "tab_new" | "tab_select" | "tab_close" => "tabs",
        "block_resources" | "unblock_resources" => "network",
        "close" | "wait" => "_internal",
        _ => "unknown",
    }
}

/// Check whether a browser action is allowed by the configured policy.
///
/// Returns `Some(reason)` to deny, `None` to allow.
pub fn check_browser_policy(
    policy: &BrowserPolicyConfig,
    action: &str,
    args: &serde_json::Value,
) -> Option<String> {
    if !policy.enabled {
        return None;
    }

    let category = action_category(action);

    // Internal actions always allowed.
    if category == "_internal" {
        return None;
    }

    // Navigate: check URL patterns before category rules.
    if action == "navigate" {
        if let Some(url) = args.get("url").and_then(|v| v.as_str()) {
            // Blocked URLs always deny.
            for pattern in &policy.blocked_urls {
                if url_matches_pattern(url, pattern) {
                    return Some(format!(
                        "Policy: navigate to \"{url}\" blocked (matches \"{pattern}\")"
                    ));
                }
            }
            // In deny-default mode, allowed_urls is the whitelist.
            if policy.default == "deny"
                && !policy.allowed_urls.is_empty()
                && !policy
                    .allowed_urls
                    .iter()
                    .any(|p| url_matches_pattern(url, p))
            {
                return Some(format!(
                    "Policy: navigate to \"{url}\" denied — not in allowed_urls"
                ));
            }
        }
    }

    // Category deny list (takes precedence).
    if policy.deny.iter().any(|c| c == category) {
        return Some(format!(
            "Policy: action \"{action}\" denied (category \"{category}\" is blocked)"
        ));
    }

    // Category allow list.
    if policy.allow.iter().any(|c| c == category) {
        return None;
    }

    // Fall back to default.
    if policy.default == "deny" {
        Some(format!(
            "Policy: action \"{action}\" denied (category \"{category}\", default=deny)"
        ))
    } else {
        None
    }
}

/// Extract the bare host from a URL (strip scheme, port, path).
///
/// `"https://www.sub.example.com:443/path"` → `"www.sub.example.com"`
fn extract_host(url: &str) -> &str {
    let without_scheme = url
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let host_with_path = without_scheme.split('/').next().unwrap_or("");
    host_with_path.split(':').next().unwrap_or("")
}

/// Simple glob-style URL pattern matching (no external crate).
///
/// - `"*.evil.com"` — matches hosts ending with `.evil.com` (or exactly `evil.com`)
/// - `"example.com"` — substring match anywhere in the URL
fn url_matches_pattern(url: &str, pattern: &str) -> bool {
    let pattern = pattern.trim();
    if let Some(suffix) = pattern.strip_prefix("*.") {
        let host = extract_host(url);
        host.ends_with(&format!(".{suffix}")) || host == suffix
    } else {
        url.contains(pattern)
    }
}

// ── Domain allowlist utilities ──────────────────────────────────────

/// Extract the registrable domain from a URL.
///
/// Strips scheme, `www.`, port, and path. Returns the last two+ segments
/// of the host as the bare domain.
///
/// ```text
/// "https://www.booking.trenitalia.com/path" → Some("trenitalia.com")
/// "https://en.wikipedia.org/wiki/Rust"      → Some("wikipedia.org")
/// "about:blank"                              → None
/// ```
pub fn extract_domain(url: &str) -> Option<String> {
    let host = extract_host(url);
    if host.is_empty() || !host.contains('.') {
        return None;
    }

    // Strip leading "www."
    let host = host.strip_prefix("www.").unwrap_or(host);

    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() < 2 {
        return None;
    }

    // For two-part TLDs (co.uk, com.au, com.br, etc.) keep 3 segments.
    let two_part_tlds = [
        "co.uk", "com.au", "com.br", "co.jp", "co.kr", "co.nz", "co.za", "com.ar", "com.mx",
        "com.tr", "org.uk", "net.au",
    ];
    if parts.len() >= 3 {
        let last_two = format!("{}.{}", parts[parts.len() - 2], parts[parts.len() - 1]);
        if two_part_tlds.contains(&last_two.as_str()) {
            // Take last 3 parts: "bbc.co.uk"
            return Some(parts[parts.len() - 3..].join("."));
        }
    }

    // Default: last 2 parts → "trenitalia.com"
    Some(parts[parts.len() - 2..].join("."))
}

/// Check whether a URL's host matches a stored domain (exact or subdomain).
///
/// `"booking.trenitalia.com"` matches `"trenitalia.com"`.
/// `"trenitalia.com"` matches `"trenitalia.com"`.
/// `"evilrenitalia.com"` does NOT match `"trenitalia.com"`.
pub fn url_matches_domain(url: &str, domain: &str) -> bool {
    let host = extract_host(url).strip_prefix("www.").unwrap_or(extract_host(url));
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// Look up a URL's rendering mode from the allowlist cache.
///
/// Iterates entries (small set, <50) and returns the mode for the first
/// matching domain. Returns `None` if the URL doesn't match any entry.
pub fn find_site_mode<'a>(
    url: &str,
    allowlist: &'a std::collections::HashMap<String, String>,
) -> Option<&'a str> {
    for (domain, mode) in allowlist {
        if url_matches_domain(url, domain) {
            return Some(mode.as_str());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy(default: &str, allow: &[&str], deny: &[&str]) -> BrowserPolicyConfig {
        BrowserPolicyConfig {
            enabled: true,
            default: default.to_string(),
            allow: allow.iter().map(|s| s.to_string()).collect(),
            deny: deny.iter().map(|s| s.to_string()).collect(),
            blocked_urls: Vec::new(),
            allowed_urls: Vec::new(),
        }
    }

    #[test]
    fn disabled_allows_everything() {
        let p = BrowserPolicyConfig::default(); // enabled = false
        assert!(check_browser_policy(&p, "evaluate", &json!({})).is_none());
        assert!(
            check_browser_policy(&p, "navigate", &json!({"url": "https://evil.com"})).is_none()
        );
    }

    #[test]
    fn default_allow_denies_listed() {
        let p = policy("allow", &[], &["eval", "network"]);
        assert!(check_browser_policy(&p, "evaluate", &json!({})).is_some());
        assert!(check_browser_policy(&p, "block_resources", &json!({})).is_some());
        assert!(check_browser_policy(&p, "click", &json!({})).is_none());
        assert!(check_browser_policy(&p, "navigate", &json!({"url": "https://ok.com"})).is_none());
    }

    #[test]
    fn default_deny_allows_listed() {
        let p = policy("deny", &["navigate", "observe"], &[]);
        assert!(check_browser_policy(&p, "navigate", &json!({"url": "https://ok.com"})).is_none());
        assert!(check_browser_policy(&p, "snapshot", &json!({})).is_none());
        assert!(check_browser_policy(&p, "click", &json!({})).is_some());
    }

    #[test]
    fn internal_always_allowed() {
        let p = policy("deny", &[], &[]);
        assert!(check_browser_policy(&p, "close", &json!({})).is_none());
        assert!(check_browser_policy(&p, "wait", &json!({})).is_none());
    }

    #[test]
    fn blocked_urls_deny_navigate() {
        let mut p = policy("allow", &[], &[]);
        p.blocked_urls = vec!["*.evil.com".to_string()];

        let blocked = json!({"url": "https://sub.evil.com/page"});
        assert!(check_browser_policy(&p, "navigate", &blocked).is_some());

        let ok = json!({"url": "https://good.com"});
        assert!(check_browser_policy(&p, "navigate", &ok).is_none());
    }

    #[test]
    fn allowed_urls_in_deny_mode() {
        let mut p = policy("deny", &["navigate"], &[]);
        p.allowed_urls = vec!["*.mysite.com".to_string()];

        let ok = json!({"url": "https://app.mysite.com/dash"});
        assert!(check_browser_policy(&p, "navigate", &ok).is_none());

        let blocked = json!({"url": "https://other.com"});
        assert!(check_browser_policy(&p, "navigate", &blocked).is_some());
    }

    #[test]
    fn url_pattern_matching() {
        assert!(url_matches_pattern(
            "https://sub.evil.com/page",
            "*.evil.com"
        ));
        assert!(url_matches_pattern("https://evil.com/page", "*.evil.com"));
        assert!(!url_matches_pattern("https://notevil.com", "*.evil.com"));
        assert!(url_matches_pattern(
            "https://example.com/search",
            "example.com"
        ));
        assert!(!url_matches_pattern("https://other.com", "example.com"));
    }

    #[test]
    fn category_mapping_exhaustive() {
        let all_actions = [
            "navigate",
            "click",
            "click_coordinates",
            "hold_click",
            "type",
            "fill",
            "fill_form",
            "select_option",
            "press_key",
            "snapshot",
            "screenshot",
            "hover",
            "scroll",
            "drag",
            "evaluate",
            "tab_list",
            "tab_new",
            "tab_select",
            "tab_close",
            "block_resources",
            "unblock_resources",
            "close",
            "wait",
        ];
        for action in &all_actions {
            assert_ne!(action_category(action), "unknown", "unmapped: {action}");
        }
    }

    #[test]
    fn unknown_action_uses_default() {
        let deny = policy("deny", &[], &[]);
        assert!(check_browser_policy(&deny, "nonexistent", &json!({})).is_some());

        let allow = policy("allow", &[], &[]);
        assert!(check_browser_policy(&allow, "nonexistent", &json!({})).is_none());
    }

    // ── Domain utilities tests ──────────────────────────────────────

    #[test]
    fn extract_domain_basic() {
        assert_eq!(
            extract_domain("https://www.trenitalia.com/path"),
            Some("trenitalia.com".to_string())
        );
        assert_eq!(
            extract_domain("https://booking.trenitalia.com/checkout"),
            Some("trenitalia.com".to_string())
        );
        assert_eq!(
            extract_domain("https://google.com"),
            Some("google.com".to_string())
        );
        assert_eq!(
            extract_domain("https://en.wikipedia.org/wiki/Rust"),
            Some("wikipedia.org".to_string())
        );
    }

    #[test]
    fn extract_domain_two_part_tlds() {
        assert_eq!(
            extract_domain("https://www.bbc.co.uk/news"),
            Some("bbc.co.uk".to_string())
        );
        assert_eq!(
            extract_domain("https://shop.example.com.au"),
            Some("example.com.au".to_string())
        );
    }

    #[test]
    fn extract_domain_edge_cases() {
        assert_eq!(extract_domain("about:blank"), None);
        assert_eq!(extract_domain("chrome://settings"), None);
        assert_eq!(extract_domain(""), None);
        // Localhost with port
        assert_eq!(extract_domain("http://localhost:3000"), None);
    }

    #[test]
    fn url_matches_domain_exact_and_subdomain() {
        assert!(url_matches_domain("https://trenitalia.com/page", "trenitalia.com"));
        assert!(url_matches_domain(
            "https://booking.trenitalia.com",
            "trenitalia.com"
        ));
        assert!(url_matches_domain(
            "https://www.trenitalia.com",
            "trenitalia.com"
        ));
        // Must not match partial host names
        assert!(!url_matches_domain(
            "https://evilrenitalia.com",
            "trenitalia.com"
        ));
        assert!(!url_matches_domain("https://other.com", "trenitalia.com"));
    }

    #[test]
    fn find_site_mode_lookup() {
        let mut allowlist = std::collections::HashMap::new();
        allowlist.insert("trenitalia.com".to_string(), "visible".to_string());
        allowlist.insert("google.com".to_string(), "headless".to_string());

        assert_eq!(
            find_site_mode("https://www.trenitalia.com/search", &allowlist),
            Some("visible")
        );
        assert_eq!(
            find_site_mode("https://google.com/search?q=test", &allowlist),
            Some("headless")
        );
        assert_eq!(find_site_mode("https://unknown.com", &allowlist), None);
    }
}
