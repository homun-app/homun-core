//! Recurrence rules for proactive (recurring) tasks.
//!
//! Two families:
//! - **Interval** — "every <N><unit>" (minutes/hours/days/weeks): timezone-independent,
//!   dependency-free.
//! - **Calendar** — "daily@HH:MM" / "weekly@<dow>@HH:MM": anchored to a wall-clock
//!   time in a timezone, **DST-aware via `jiff`**. The timezone is passed separately
//!   (IANA name, e.g. "Europe/Rome"); absent → the system timezone.
//!
//! `jiff` is used only here; `next_occurrence` returns a `time::OffsetDateTime`, so
//! the rest of the crate is unaffected (conversion is via unix seconds).

use time::{Duration, OffsetDateTime};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Rule {
    Interval(Duration),
    DailyAt { hour: i8, minute: i8 },
    WeeklyAt {
        weekday: jiff::civil::Weekday,
        hour: i8,
        minute: i8,
    },
}

/// Next occurrence strictly after `after`, or `None` when `rule` is unparseable
/// (the caller treats the task as one-shot). `tz` is an IANA name for calendar
/// rules (ignored by interval rules); an absent/invalid tz falls back to the
/// system timezone.
pub fn next_occurrence(
    rule: &str,
    tz: Option<&str>,
    after: OffsetDateTime,
) -> Option<OffsetDateTime> {
    match parse(rule)? {
        Rule::Interval(duration) => Some(after + duration),
        Rule::DailyAt { hour, minute } => next_daily(after, tz, hour, minute),
        Rule::WeeklyAt {
            weekday,
            hour,
            minute,
        } => next_weekly(after, tz, weekday, hour, minute),
    }
}

fn parse(rule: &str) -> Option<Rule> {
    let normalized = rule.trim().to_ascii_lowercase();

    // Interval first ("every 6h", "1d", "2 weeks"). Returns None for calendar rules.
    if let Some(duration) = parse_interval(&normalized) {
        return Some(Rule::Interval(duration));
    }
    // daily@HH:MM | daily HH:MM
    if let Some(rest) = normalized.strip_prefix("daily") {
        let (hour, minute) = parse_hhmm(rest)?;
        return Some(Rule::DailyAt { hour, minute });
    }
    // weekly@<dow>@HH:MM | weekly <dow> HH:MM
    if let Some(rest) = normalized.strip_prefix("weekly") {
        let rest = rest.trim_start_matches(['@', ' ']);
        let mut parts = rest.splitn(2, |c| c == '@' || c == ' ');
        let weekday = parse_weekday(parts.next()?.trim())?;
        let (hour, minute) = parse_hhmm(parts.next()?)?;
        return Some(Rule::WeeklyAt {
            weekday,
            hour,
            minute,
        });
    }
    None
}

/// Parses an interval rule into a positive `Duration`. Accepts an optional "every"
/// prefix and an optional space before the unit. Returns None for non-interval
/// rules (e.g. "daily@08:00"), zero/negative counts, and unknown units.
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

fn parse_hhmm(s: &str) -> Option<(i8, i8)> {
    let trimmed = s.trim().trim_start_matches(['@', ' ']).trim();
    let (hour, minute) = trimmed.split_once(':')?;
    let hour: i8 = hour.trim().parse().ok()?;
    let minute: i8 = minute.trim().parse().ok()?;
    if (0..=23).contains(&hour) && (0..=59).contains(&minute) {
        Some((hour, minute))
    } else {
        None
    }
}

fn parse_weekday(s: &str) -> Option<jiff::civil::Weekday> {
    use jiff::civil::Weekday::*;
    Some(match s.trim() {
        "mon" | "monday" | "lun" | "lunedi" | "lunedì" => Monday,
        "tue" | "tuesday" | "mar" | "martedi" | "martedì" => Tuesday,
        "wed" | "wednesday" | "mer" | "mercoledi" | "mercoledì" => Wednesday,
        "thu" | "thursday" | "gio" | "giovedi" | "giovedì" => Thursday,
        "fri" | "friday" | "ven" | "venerdi" | "venerdì" => Friday,
        "sat" | "saturday" | "sab" | "sabato" => Saturday,
        "sun" | "sunday" | "dom" | "domenica" => Sunday,
        _ => return None,
    })
}

fn zoned_from(after: OffsetDateTime, tz: Option<&str>) -> Option<jiff::Zoned> {
    let ts = jiff::Timestamp::from_second(after.unix_timestamp()).ok()?;
    let zoned = match tz {
        Some(name) => ts
            .in_tz(name)
            .unwrap_or_else(|_| ts.to_zoned(jiff::tz::TimeZone::system())),
        None => ts.to_zoned(jiff::tz::TimeZone::system()),
    };
    Some(zoned)
}

fn to_offset_datetime(zoned: &jiff::Zoned) -> Option<OffsetDateTime> {
    OffsetDateTime::from_unix_timestamp(zoned.timestamp().as_second()).ok()
}

fn at_time(now: &jiff::Zoned, hour: i8, minute: i8) -> Option<jiff::Zoned> {
    now.with()
        .hour(hour)
        .minute(minute)
        .second(0)
        .subsec_nanosecond(0)
        .build()
        .ok()
}

fn next_daily(
    after: OffsetDateTime,
    tz: Option<&str>,
    hour: i8,
    minute: i8,
) -> Option<OffsetDateTime> {
    use jiff::ToSpan;
    let now = zoned_from(after, tz)?;
    let mut candidate = at_time(&now, hour, minute)?;
    if candidate.timestamp() <= now.timestamp() {
        candidate = candidate.checked_add(1.day()).ok()?;
    }
    to_offset_datetime(&candidate)
}

fn next_weekly(
    after: OffsetDateTime,
    tz: Option<&str>,
    weekday: jiff::civil::Weekday,
    hour: i8,
    minute: i8,
) -> Option<OffsetDateTime> {
    use jiff::ToSpan;
    let now = zoned_from(after, tz)?;
    let mut candidate = at_time(&now, hour, minute)?;
    // Advance day-by-day to the first matching weekday strictly in the future.
    for _ in 0..8 {
        if candidate.weekday() == weekday && candidate.timestamp() > now.timestamp() {
            return to_offset_datetime(&candidate);
        }
        candidate = candidate.checked_add(1.day()).ok()?;
    }
    None
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
        // Calendar rules are not intervals.
        assert_eq!(parse_interval("daily@08:00"), None);
    }

    #[test]
    fn interval_next_occurrence_adds_the_interval() {
        let base = OffsetDateTime::UNIX_EPOCH;
        assert_eq!(
            next_occurrence("every 1h", None, base),
            Some(base + Duration::hours(1))
        );
        assert_eq!(next_occurrence("nope", None, base), None);
    }

    #[test]
    fn daily_anchors_to_time_of_day_in_tz() {
        // 1970-01-01T00:00:00Z is a Thursday at midnight UTC.
        let after = OffsetDateTime::from_unix_timestamp(0).unwrap();
        let next = next_occurrence("daily@08:00", Some("UTC"), after).unwrap();
        assert_eq!(next.unix_timestamp(), 8 * 3600);

        // Exactly at 08:00 → roll to the next day (strictly future).
        let at_eight = OffsetDateTime::from_unix_timestamp(8 * 3600).unwrap();
        let next2 = next_occurrence("daily@08:00", Some("UTC"), at_eight).unwrap();
        assert_eq!(next2.unix_timestamp(), 8 * 3600 + 86_400);
    }

    #[test]
    fn weekly_anchors_to_weekday_and_time_in_tz() {
        // 1970-01-01 is a Thursday.
        let after = OffsetDateTime::from_unix_timestamp(0).unwrap();

        // Same-day Thursday 08:00 is in the future relative to Thursday 00:00.
        let thu = next_occurrence("weekly@thu@08:00", Some("UTC"), after).unwrap();
        assert_eq!(thu.unix_timestamp(), 8 * 3600);

        // Next Monday 00:00 = 1970-01-05 = +4 days.
        let mon = next_occurrence("weekly@mon@00:00", Some("UTC"), after).unwrap();
        assert_eq!(mon.unix_timestamp(), 4 * 86_400);

        // Italian abbreviation works too.
        let mon_it = next_occurrence("weekly lun 00:00", Some("UTC"), after).unwrap();
        assert_eq!(mon_it.unix_timestamp(), 4 * 86_400);
    }
}
