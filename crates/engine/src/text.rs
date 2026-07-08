//! Pure text/answer helpers the ReAct loop uses when delivering an answer (ADR 0024 inc 5e.3):
//! extracting source URLs from model output, filtering low-value ones, and rendering the "Sources"
//! footer. Moved verbatim from the gateway so the loop body can follow into this crate; the gateway
//! re-exports them, so call sites are unchanged. Pure — plain `&str`/slices in, values out.

/// Extract `http(s)://…` URLs from free-form model text (deduped, trailing punctuation trimmed).
pub fn extract_source_urls(text: &str) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(pos) = rest.find("http") {
        let candidate = &rest[pos..];
        if candidate.starts_with("http://") || candidate.starts_with("https://") {
            let end = candidate
                .find(|c: char| {
                    c.is_whitespace() || matches!(c, ')' | ']' | '"' | '<' | '>' | '`' | '|' | '\\')
                })
                .unwrap_or(candidate.len());
            let mut url = candidate[..end].to_string();
            while url.ends_with(['.', ',', ';', ':', '*', '!', '?']) {
                url.pop();
            }
            if url.len() > 12 && !urls.contains(&url) {
                urls.push(url);
            }
            rest = &candidate[end..];
        } else {
            rest = &candidate[4..];
        }
    }
    urls
}

/// Non-citable URLs (login/cookie/edit/tracking pages) that shouldn't appear in "Sources".
pub fn is_low_value_source_url(url: &str) -> bool {
    let u = url.to_lowercase();
    [
        "donate.",
        "/w/index.php",
        "action=edit",
        "action=history",
        "oldid=",
        "/special:",
        "uselang=",
        "/login",
        "signin",
        "/cookie",
        "cookie-policy",
        "cookie-consent",
        "/privacy",
        "/preferences",
        "intcmp=",
        "utm_",
        "wmf_",
    ]
    .iter()
    .any(|needle| u.contains(needle))
}

/// The "Sources" footer for a delivered answer — `None` when there are no sources or the answer
/// already cites them.
pub fn fonti_section(sources: &[String], answer: &str) -> Option<String> {
    if sources.is_empty() {
        return None;
    }
    let lower = answer.to_lowercase();
    if lower.contains("**sources") || lower.contains("checked sources") {
        return None;
    }
    let list = sources
        .iter()
        .take(6)
        .map(|url| format!("- {url}"))
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!("\n\n**Sources**\n{list}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_dedups_and_trims_trailing_punct() {
        let urls = extract_source_urls("see https://a.example/x. and https://a.example/x, also http://b.example)");
        assert_eq!(urls, vec!["https://a.example/x".to_string(), "http://b.example".to_string()]);
    }

    #[test]
    fn low_value_urls_are_flagged() {
        assert!(is_low_value_source_url("https://en.wikipedia.org/w/index.php?action=edit"));
        assert!(!is_low_value_source_url("https://en.wikipedia.org/wiki/Rust"));
    }

    #[test]
    fn fonti_section_skips_when_empty_or_already_cited() {
        assert_eq!(fonti_section(&[], "x"), None);
        assert_eq!(fonti_section(&["u".into()], "see **Sources** below"), None);
        assert!(fonti_section(&["https://a".into()], "answer").unwrap().contains("**Sources**"));
    }
}
