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
        &["cvv", "cvc", "cv2", "cvv2"],
        VaultCategory::Payments,
        "cvv_one_shot",
        "[VAULT:payments:cvv:one_shot]",
        3,
        4,
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

fn detect_contextual_digits(
    text: &str,
    detections: &mut Vec<SensitiveDetection>,
    labels: &[&str],
    category: VaultCategory,
    kind: &str,
    placeholder: &str,
    min_len: usize,
    max_len: usize,
) {
    let lower = text.to_ascii_lowercase();
    for label in labels {
        let mut offset = 0;
        while let Some(relative) = lower[offset..].find(label) {
            let label_start = offset + relative;
            let after = label_start + label.len();
            let Some((digits_start, digits_end)) = first_digit_run(text, after, min_len, max_len)
            else {
                offset = after;
                continue;
            };
            detections.push(SensitiveDetection {
                category,
                kind: kind.to_string(),
                placeholder: placeholder.to_string(),
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
    let has_health = [
        "allerg", "diagnos", "farmac", "patolog", "terapia", "sanitari",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if !has_health {
        return;
    }
    for (start, sentence) in sentence_spans(text) {
        let lower_sentence = sentence.to_ascii_lowercase();
        if [
            "allerg", "diagnos", "farmac", "patolog", "terapia", "sanitari",
        ]
        .iter()
        .any(|needle| lower_sentence.contains(needle))
        {
            detections.push(SensitiveDetection {
                category: VaultCategory::Health,
                kind: "health_note".to_string(),
                placeholder: "[VAULT:health:health_note]".to_string(),
                start,
                end: start + sentence.trim_end_matches('.').len(),
            });
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
            let Some((secret_start, secret_end)) = first_secret_value(text, value_start) else {
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

fn sentence_spans(text: &str) -> Vec<(usize, &str)> {
    let mut spans = Vec::new();
    let mut start = 0;
    for (idx, ch) in text.char_indices() {
        if matches!(ch, '.' | '!' | '?' | '\n') {
            let sentence = text[start..idx].trim();
            if !sentence.is_empty() {
                let leading = text[start..idx]
                    .len()
                    .saturating_sub(text[start..idx].trim_start().len());
                spans.push((start + leading, sentence));
            }
            start = idx + ch.len_utf8();
        }
    }
    let sentence = text[start..].trim();
    if !sentence.is_empty() {
        let leading = text[start..]
            .len()
            .saturating_sub(text[start..].trim_start().len());
        spans.push((start + leading, sentence));
    }
    spans
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
