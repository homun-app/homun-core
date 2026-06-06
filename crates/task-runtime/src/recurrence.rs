//! Recurrence rules for proactive (recurring) tasks.
//!
//! v1 supports **interval** rules — "every <N><unit>" with unit minutes / hours /
//! days / weeks — which are timezone-independent and dependency-free. Calendar-
//! anchored / cron rules (e.g. "every day at 08:00 Europe/Rome") are a planned
//! extension; the `tz` parameter is already threaded through so storage and call
//! sites stay stable when they land.

use time::{Duration, OffsetDateTime};

/// Next occurrence strictly after `after`, or `None` when `rule` is unparseable
/// (the caller then treats the task as one-shot). Whitespace/case tolerant.
pub fn next_occurrence(
    rule: &str,
    _tz: Option<&str>,
    after: OffsetDateTime,
) -> Option<OffsetDateTime> {
    let interval = parse_interval(rule)?;
    Some(after + interval)
}

/// Parses an interval rule into a positive `Duration`. Accepts an optional
/// "every" prefix and an optional space before the unit: "every 6h",
/// "EVERY 30 m", "1d", "2 weeks". Zero/negative counts and unknown units → None.
pub fn parse_interval(rule: &str) -> Option<Duration> {
    let normalized = rule.trim().to_ascii_lowercase();
    let body = normalized
        .strip_prefix("every")
        .map(str::trim)
        .unwrap_or(normalized.as_str())
        .trim();

    let digits: String = body.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let count: i64 = digits.parse().ok()?;
    if count <= 0 {
        return None;
    }
    // ASCII digits → byte length equals char count, so slicing here is safe.
    let unit = body[digits.len()..].trim();
    let duration = match unit {
        "m" | "min" | "mins" | "minute" | "minutes" => Duration::minutes(count),
        "h" | "hr" | "hrs" | "hour" | "hours" => Duration::hours(count),
        "d" | "day" | "days" => Duration::days(count),
        "w" | "wk" | "wks" | "week" | "weeks" => Duration::weeks(count),
        _ => return None,
    };
    Some(duration)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_interval_specs() {
        assert_eq!(parse_interval("every 6h"), Some(Duration::hours(6)));
        assert_eq!(parse_interval("EVERY 30 m"), Some(Duration::minutes(30)));
        assert_eq!(parse_interval("1d"), Some(Duration::days(1)));
        assert_eq!(parse_interval("2 weeks"), Some(Duration::weeks(2)));
    }

    #[test]
    fn rejects_invalid_or_zero_rules() {
        assert_eq!(parse_interval("every 0h"), None);
        assert_eq!(parse_interval("soon"), None);
        assert_eq!(parse_interval("every 5 lightyears"), None);
        assert_eq!(parse_interval(""), None);
    }

    #[test]
    fn next_occurrence_adds_the_interval() {
        let base = OffsetDateTime::UNIX_EPOCH;
        assert_eq!(
            next_occurrence("every 1h", None, base),
            Some(base + Duration::hours(1))
        );
        assert_eq!(next_occurrence("nope", None, base), None);
    }
}
