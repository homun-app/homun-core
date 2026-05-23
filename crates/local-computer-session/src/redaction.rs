pub fn redact_text(value: &str) -> String {
    value
        .split_whitespace()
        .map(redact_token)
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn redact_url(value: &str) -> String {
    let without_query = value.split(['?', '#']).next().unwrap_or(value);
    redact_text(without_query)
}

fn redact_token(token: &str) -> String {
    let lower = token.to_ascii_lowercase();
    if lower.contains("password=")
        || lower.contains("token=")
        || lower.contains("secret=")
        || lower.contains("api_key=")
        || lower.contains("sk-")
        || looks_like_email(token)
    {
        "[REDACTED]".to_string()
    } else {
        token.to_string()
    }
}

fn looks_like_email(token: &str) -> bool {
    let trimmed = token.trim_matches(|character: char| {
        matches!(character, ',' | ';' | ':' | ')' | '(' | '"' | '\'')
    });
    let Some((local, domain)) = trimmed.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.ends_with('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_common_secret_shapes_and_query_strings() {
        assert_eq!(
            redact_url("https://example.test/path?token=abc&email=a@b.com"),
            "https://example.test/path"
        );
        assert_eq!(redact_text("TOKEN=sk-live-secret ok"), "[REDACTED] ok");
        assert_eq!(redact_text("mail fabio@example.com"), "mail [REDACTED]");
    }
}
