use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultCategory {
    Payments,
    Identity,
    Health,
    Vehicles,
    Credentials,
    PrivateNotes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SensitiveDetection {
    pub category: VaultCategory,
    pub kind: String,
    pub placeholder: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SensitiveClassification {
    pub has_critical: bool,
    pub redacted_text: String,
    pub detections: Vec<SensitiveDetection>,
}

pub fn classify_sensitive_text(text: &str) -> SensitiveClassification {
    let mut detections = Vec::new();
    detect_card_numbers(text, &mut detections);
    detect_contextual_digits(
        text,
        &mut detections,
        &ContextualDigitPattern {
            labels: &["cvv", "cvc", "cv2", "cvv2"],
            category: VaultCategory::Payments,
            kind: "cvv_one_shot",
            placeholder: "[VAULT:payments:cvv:one_shot]",
            length: 3..=4,
        },
    );
    detect_codice_fiscale(text, &mut detections);
    detect_italian_plate(text, &mut detections);
    detect_health_notes(text, &mut detections);
    detect_credentials(text, &mut detections);
    detections.sort_by_key(|d| (d.start, d.end));
    detections = without_overlaps(detections);
    let redacted_text = apply_redactions(text, &detections);
    SensitiveClassification {
        has_critical: !detections.is_empty(),
        redacted_text,
        detections,
    }
}

fn detect_card_numbers(text: &str, detections: &mut Vec<SensitiveDetection>) {
    for (start, token) in token_spans(text) {
        let digits = token
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>();
        if !(13..=19).contains(&digits.len()) {
            continue;
        }
        if !token
            .chars()
            .all(|c| c.is_ascii_digit() || c == ' ' || c == '-')
        {
            continue;
        }
        if !luhn_valid(&digits) {
            continue;
        }
        let last4 = &digits[digits.len().saturating_sub(4)..];
        let placeholder = format!("[VAULT:payments:card:last4={last4}]");
        detections.push(SensitiveDetection {
            category: VaultCategory::Payments,
            kind: "card_number".to_string(),
            placeholder,
            start,
            end: start + token.len(),
        });
    }
}

struct ContextualDigitPattern<'a> {
    labels: &'a [&'a str],
    category: VaultCategory,
    kind: &'a str,
    placeholder: &'a str,
    length: std::ops::RangeInclusive<usize>,
}

fn detect_contextual_digits(
    text: &str,
    detections: &mut Vec<SensitiveDetection>,
    pattern: &ContextualDigitPattern<'_>,
) {
    let lower = text.to_ascii_lowercase();
    for label in pattern.labels {
        let mut offset = 0;
        while let Some(relative) = lower[offset..].find(label) {
            let label_start = offset + relative;
            let after = label_start + label.len();
            let Some((digits_start, digits_end)) = first_digit_run(
                text,
                after,
                *pattern.length.start(),
                *pattern.length.end(),
            ) else {
                offset = after;
                continue;
            };
            detections.push(SensitiveDetection {
                category: pattern.category,
                kind: pattern.kind.to_string(),
                placeholder: pattern.placeholder.to_string(),
                start: digits_start,
                end: digits_end,
            });
            offset = digits_end;
        }
    }
}

fn detect_codice_fiscale(text: &str, detections: &mut Vec<SensitiveDetection>) {
    for (start, token) in word_spans(text) {
        let candidate = token.trim_matches(|c: char| !c.is_ascii_alphanumeric());
        if candidate.len() == 16 && codice_fiscale_shape(candidate) {
            let adjusted_start = start + token.find(candidate).unwrap_or(0);
            detections.push(SensitiveDetection {
                category: VaultCategory::Identity,
                kind: "codice_fiscale".to_string(),
                placeholder: "[VAULT:identity:codice_fiscale]".to_string(),
                start: adjusted_start,
                end: adjusted_start + candidate.len(),
            });
        }
    }
}

fn detect_italian_plate(text: &str, detections: &mut Vec<SensitiveDetection>) {
    for (start, token) in word_spans(text) {
        let candidate = token.trim_matches(|c: char| !c.is_ascii_alphanumeric());
        if candidate.len() == 7 && italian_plate_shape(candidate) {
            let adjusted_start = start + token.find(candidate).unwrap_or(0);
            detections.push(SensitiveDetection {
                category: VaultCategory::Vehicles,
                kind: "plate".to_string(),
                placeholder: "[VAULT:vehicles:plate]".to_string(),
                start: adjusted_start,
                end: adjusted_start + candidate.len(),
            });
        }
    }
}

fn detect_health_notes(text: &str, detections: &mut Vec<SensitiveDetection>) {
    let lower = text.to_ascii_lowercase();
    for needle in [
        "allerg", "diagnos", "farmac", "patolog", "terapia", "sanitari",
    ] {
        let mut offset = 0;
        while let Some(relative) = lower[offset..].find(needle) {
            let idx = offset + relative;
            let (start, end) = containing_clause(text, idx);
            detections.push(SensitiveDetection {
                category: VaultCategory::Health,
                kind: "health_note".to_string(),
                placeholder: "[VAULT:health:health_note]".to_string(),
                start,
                end,
            });
            offset = end;
        }
    }
}

fn detect_credentials(text: &str, detections: &mut Vec<SensitiveDetection>) {
    let labels = ["password", "api key", "token", "secret", "private key"];
    for label in labels {
        let lower = text.to_ascii_lowercase();
        let mut offset = 0;
        while let Some(relative) = lower[offset..].find(label) {
            let label_start = offset + relative;
            let value_start = label_start + label.len();
            // The label must be a WORD, and the value must be genuinely separated from it. A bare
            // substring search matches labels buried in identifiers and paths — "crates/secrets/src/
            // lib.rs" contains "secret", and `first_secret_value` then captured the remainder of the
            // very same token ("s/src/lib.rs") and redacted it, so an ordinary file path was rewritten
            // into a vault placeholder and the model never saw what it was asked to read. A real
            // credential is always written `label: value`, `label=value` or `label value`, so require
            // the character right after the label to be a separator (or the end of the text).
            let follows = lower[value_start..].chars().next();
            let separated = match follows {
                None => true,
                Some(c) => c.is_whitespace() || matches!(c, ':' | '=' | '"' | '\''),
            };
            let preceded_by_word_char = lower[..label_start]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric());
            if !separated || preceded_by_word_char {
                offset = value_start;
                continue;
            }
            // An explicit `label:`/`label=` states the intent, so whatever follows is the secret.
            // In prose ("il token refresh loop va sistemato") the next word is just the next word —
            // taking it blindly redacted ordinary sentences — so there we require the value to LOOK
            // like a secret (length or a letter+digit/symbol mix) and scan the clause for the first
            // such token instead of grabbing whatever comes next.
            let explicit_assignment = lower[value_start..]
                .chars()
                .find(|c| !c.is_whitespace())
                .is_some_and(|c| matches!(c, ':' | '='));
            let found = if explicit_assignment {
                first_secret_value(text, value_start)
            } else {
                first_secret_shaped_value(text, value_start)
            };
            let Some((secret_start, secret_end)) = found else {
                offset = value_start;
                continue;
            };
            detections.push(SensitiveDetection {
                category: VaultCategory::Credentials,
                kind: "secret".to_string(),
                placeholder: "[VAULT:credentials:secret]".to_string(),
                start: secret_start,
                end: secret_end,
            });
            offset = secret_end;
        }
    }
}

fn token_spans(text: &str) -> Vec<(usize, &str)> {
    let mut spans = Vec::new();
    let mut start = None;
    for (idx, ch) in text.char_indices() {
        let eligible = ch.is_ascii_digit() || ch == ' ' || ch == '-';
        match (start, eligible) {
            (None, true) => start = Some(idx),
            (Some(s), false) => {
                spans.push((s, &text[s..idx]));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        spans.push((s, &text[s..]));
    }
    spans
}

fn word_spans(text: &str) -> Vec<(usize, &str)> {
    let mut spans = Vec::new();
    let mut start = None;
    for (idx, ch) in text.char_indices() {
        let eligible = ch.is_ascii_alphanumeric();
        match (start, eligible) {
            (None, true) => start = Some(idx),
            (Some(s), false) => {
                spans.push((s, &text[s..idx]));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        spans.push((s, &text[s..]));
    }
    spans
}

fn containing_clause(text: &str, idx: usize) -> (usize, usize) {
    let start = text[..idx]
        .rfind([',', '.', '!', '?', '\n'])
        .map(|pos| pos + 1)
        .unwrap_or(0);
    let end = text[idx..]
        .find([',', '.', '!', '?', '\n'])
        .map(|pos| idx + pos)
        .unwrap_or(text.len());
    let leading = text[start..end]
        .len()
        .saturating_sub(text[start..end].trim_start().len());
    let trailing = text[start..end]
        .len()
        .saturating_sub(text[start..end].trim_end().len());
    (start + leading, end - trailing)
}

fn first_digit_run(
    text: &str,
    offset: usize,
    min_len: usize,
    max_len: usize,
) -> Option<(usize, usize)> {
    let mut start = None;
    for (relative, ch) in text[offset..].char_indices() {
        let idx = offset + relative;
        if ch.is_ascii_digit() {
            start.get_or_insert(idx);
            continue;
        }
        if let Some(s) = start {
            let len = idx - s;
            if (min_len..=max_len).contains(&len) {
                return Some((s, idx));
            }
            return None;
        }
        if !(ch.is_whitespace() || matches!(ch, ':' | '=' | '-' | '#')) {
            return None;
        }
    }
    start.and_then(|s| {
        let len = text.len() - s;
        (min_len..=max_len)
            .contains(&len)
            .then_some((s, text.len()))
    })
}

/// Does this token look like an actual secret rather than an ordinary word? Real keys/tokens are
/// long, or mix letters with digits/symbols ("hunter2", "sk-abc123", "ghp_ABCDEF…"); prose words
/// ("refresh", "loop", "e'") are short, all-letter and single-case.
fn looks_like_secret_value(value: &str) -> bool {
    let trimmed = value.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | '.' | ';'));
    if trimmed.len() >= 16 {
        return true;
    }
    if trimmed.len() < 6 {
        return false;
    }
    let has_digit = trimmed.chars().any(|c| c.is_ascii_digit());
    let has_alpha = trimmed.chars().any(|c| c.is_ascii_alphabetic());
    let has_symbol = trimmed.chars().any(|c| matches!(c, '-' | '_' | '.' | '/' | '+'));
    let mixed_case = trimmed.chars().any(|c| c.is_ascii_uppercase())
        && trimmed.chars().any(|c| c.is_ascii_lowercase());
    has_alpha && (has_digit || (has_symbol && mixed_case))
}

/// Like [`first_secret_value`] but only accepts a token that actually looks like a secret, scanning
/// forward within the same clause. Used when the label appears in prose rather than as `label: value`.
fn first_secret_shaped_value(text: &str, offset: usize) -> Option<(usize, usize)> {
    let (_, clause_end) = containing_clause(text, offset.min(text.len().saturating_sub(1)));
    let end_bound = clause_end.max(offset);
    let mut cursor = offset;
    while cursor < end_bound {
        let (start, end) = first_secret_value(&text[..end_bound], cursor)?;
        if looks_like_secret_value(&text[start..end]) {
            return Some((start, end));
        }
        if end <= cursor {
            return None;
        }
        cursor = end;
    }
    None
}

fn first_secret_value(text: &str, offset: usize) -> Option<(usize, usize)> {
    let mut start = None;
    for (relative, ch) in text[offset..].char_indices() {
        let idx = offset + relative;
        if ch.is_whitespace() || matches!(ch, ':' | '=' | '-') {
            if start.is_some() {
                break;
            }
            continue;
        }
        start.get_or_insert(idx);
    }
    start.map(|s| {
        let end = text[s..]
            .find(char::is_whitespace)
            .map(|relative| s + relative)
            .unwrap_or(text.len());
        (s, end)
    })
}

fn codice_fiscale_shape(value: &str) -> bool {
    let chars = value.chars().collect::<Vec<_>>();
    let letter_positions = [0, 1, 2, 3, 4, 5, 8, 11, 15];
    let digit_positions = [6, 7, 9, 10, 12, 13, 14];
    letter_positions
        .iter()
        .all(|idx| chars[*idx].is_ascii_alphabetic())
        && digit_positions
            .iter()
            .all(|idx| chars[*idx].is_ascii_digit())
}

fn italian_plate_shape(value: &str) -> bool {
    let chars = value.chars().collect::<Vec<_>>();
    chars[0].is_ascii_alphabetic()
        && chars[1].is_ascii_alphabetic()
        && chars[2].is_ascii_digit()
        && chars[3].is_ascii_digit()
        && chars[4].is_ascii_digit()
        && chars[5].is_ascii_alphabetic()
        && chars[6].is_ascii_alphabetic()
}

fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0;
    let mut double = false;
    for ch in digits.chars().rev() {
        let Some(mut digit) = ch.to_digit(10) else {
            return false;
        };
        if double {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
        double = !double;
    }
    sum % 10 == 0
}

fn without_overlaps(detections: Vec<SensitiveDetection>) -> Vec<SensitiveDetection> {
    let mut kept: Vec<SensitiveDetection> = Vec::new();
    for detection in detections {
        if kept
            .iter()
            .any(|existing| detection.start < existing.end && detection.end > existing.start)
        {
            continue;
        }
        kept.push(detection);
    }
    kept
}

fn apply_redactions(text: &str, detections: &[SensitiveDetection]) -> String {
    let mut output = text.to_string();
    for detection in detections.iter().rev() {
        output.replace_range(detection.start..detection.end, &detection.placeholder);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_labels_buried_in_paths_and_words_are_not_redacted() {
        // "crates/secrets/src/lib.rs" contains "secret"; the old substring match captured the rest of
        // the SAME token ("s/src/lib.rs") and redacted it, so asking to read a file in this very repo
        // reached the model as "read crates/[VAULT:credentials:secret]".
        for text in [
            "read crates/secrets/src/lib.rs",
            "apri il file token_store.rs",
            "il token refresh loop va sistemato",
        ] {
            let out = classify_sensitive_text(text);
            assert_eq!(
                out.redacted_text, text,
                "ordinary text must pass through untouched: {text}"
            );
        }
    }

    #[test]
    fn real_credentials_are_still_redacted() {
        for text in [
            "password: hunter2",
            "api key = sk-abc123def456",
            "il token e' ghp_ABCDEFGHIJKLMNOP",
        ] {
            let out = classify_sensitive_text(text);
            assert!(
                out.redacted_text.contains("[VAULT:credentials:secret]"),
                "a real credential must still be redacted: {text} -> {}",
                out.redacted_text
            );
        }
    }

    #[test]
    fn detects_and_redacts_payment_card_without_cvv_storage() {
        let out = classify_sensitive_text("La mia carta e' 4111 1111 1111 1111 e cvv 123");

        assert!(out.has_critical);
        assert!(
            out.redacted_text
                .contains("[VAULT:payments:card:last4=1111]")
        );
        assert!(out.redacted_text.contains("[VAULT:payments:cvv:one_shot]"));
        assert!(!out.redacted_text.contains("4111 1111 1111 1111"));
        assert!(!out.redacted_text.contains("123"));
        assert!(
            out.detections
                .iter()
                .any(|d| d.category == VaultCategory::Payments && d.kind == "card_number")
        );
        assert!(
            out.detections
                .iter()
                .any(|d| d.category == VaultCategory::Payments && d.kind == "cvv_one_shot")
        );
    }

    #[test]
    fn detects_identity_health_vehicle_and_credentials() {
        let out = classify_sensitive_text(
            "Codice fiscale RSSMRA80A01H501U. Targa AB123CD. Sono allergico alla penicillina. password hunter2",
        );

        assert!(out.has_critical);
        assert!(
            out.redacted_text
                .contains("[VAULT:identity:codice_fiscale]")
        );
        assert!(out.redacted_text.contains("[VAULT:vehicles:plate]"));
        assert!(out.redacted_text.contains("[VAULT:health:health_note]"));
        assert!(out.redacted_text.contains("[VAULT:credentials:secret]"));
        assert!(!out.redacted_text.contains("RSSMRA80A01H501U"));
        assert!(!out.redacted_text.contains("AB123CD"));
        assert!(!out.redacted_text.contains("hunter2"));
    }

    #[test]
    fn leaves_normal_preferences_unredacted() {
        let out = classify_sensitive_text("Preferisco partire da Napoli e viaggiare al mattino");

        assert!(!out.has_critical);
        assert!(out.detections.is_empty());
        assert_eq!(
            out.redacted_text,
            "Preferisco partire da Napoli e viaggiare al mattino"
        );
    }
}
