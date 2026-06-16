//! Deterministic temporal resolution (Layer C of the "Now & Dates" design).
//!
//! The split that makes this both multilingual AND correct: **the LLM does the
//! language understanding**, mapping a phrase in any language ("domani mattina",
//! "next Monday at 9", "pasado mañana", "dans 3 jours", "übermorgen") into a
//! small STRUCTURED [`TemporalIntent`]; **this module does the arithmetic** with
//! `jiff` from a timezone-aware anchor. The model never computes a final date
//! (where it errs); it only classifies the kind of reference (where it's strong).
//!
//! Because everything here operates on `TemporalIntent` + ISO — never on words —
//! it needs no per-language lexicon and is multilingual by construction.

use jiff::ToSpan;

/// How to pick a weekday's date relative to the anchor's ISO week.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Which {
    /// This ISO week's occurrence (may be in the past, e.g. "questo lunedì" on Wed).
    This,
    /// The following week's occurrence ("lunedì prossimo").
    Next,
    /// Soonest occurrence today-or-later — the natural default for a bare weekday.
    Upcoming,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    Day,
    Week,
    Month,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DayPart {
    Morning,
    Afternoon,
    Evening,
    Night,
}

/// Which calendar day the expression points at (no time component yet).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DayRef {
    /// 0 = today, 1 = tomorrow, -1 = yesterday, 2 = day after tomorrow, …
    RelativeDay(i64),
    /// "lunedì prossimo" / "next Monday".
    Weekday(jiff::civil::Weekday, Which),
    /// "tra 3 settimane" / "in 2 months".
    RelativeUnit(i64, Unit),
    /// Fully explicit calendar date.
    Absolute(jiff::civil::Date),
}

/// The time-of-day part of the expression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimeSpec {
    /// No time given → the result is a DATE (date-only granularity).
    None,
    /// Explicit "alle 7" → 07:00.
    At { hour: i8, minute: i8 },
    /// "di mattina" → a representative time + a [start,end] window.
    Part(DayPart),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemporalIntent {
    pub day: DayRef,
    pub time: TimeSpec,
}

#[derive(Debug, Clone, Copy)]
pub struct ResolveOpts {
    /// Reject a result that is not in the future (for booking/search slots).
    pub must_be_future: bool,
}

impl Default for ResolveOpts {
    fn default() -> Self {
        Self {
            must_be_future: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Resolved {
    pub start: jiff::Zoned,
    /// Window end for part-of-day ranges (e.g. morning 06:00–12:00); else None.
    pub end: Option<jiff::Zoned>,
    /// True when no time was given → the consumer should treat it as a pure date.
    pub date_only: bool,
    /// Canonical machine value: `YYYY-MM-DD` (date-only) or full ISO 8601 w/ offset.
    pub iso: String,
    /// Italian human echo, e.g. "giovedì 11 giugno 2026 alle 07:00".
    pub human: String,
    pub is_future: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemporalError {
    /// The resolved instant is in the past but a future one was required.
    Past { chosen: String, now: String },
    /// Malformed input (bad date/time/weekday, arithmetic overflow).
    Invalid(String),
}

impl std::fmt::Display for TemporalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TemporalError::Past { chosen, now } => write!(
                f,
                "the date/time «{chosen}» is in the past (now is {now}): pick a future one"
            ),
            TemporalError::Invalid(why) => write!(f, "invalid temporal reference: {why}"),
        }
    }
}

/// Representative start time + window end (hour) for a part of the day. Night
/// wraps past midnight, so its end belongs to the following day.
fn part_window(part: DayPart) -> (i8, i8, bool) {
    // (start_hour, end_hour, end_is_next_day)
    match part {
        DayPart::Morning => (8, 12, false),
        DayPart::Afternoon => (15, 18, false),
        DayPart::Evening => (19, 22, false),
        DayPart::Night => (22, 6, true),
    }
}

/// Days to add to `from` to reach weekday `to`, honoring this/next/upcoming.
fn offset_to_weekday(from: jiff::civil::Weekday, to: jiff::civil::Weekday, which: Which) -> i64 {
    let f = from.to_monday_zero_offset() as i64;
    let t = to.to_monday_zero_offset() as i64;
    let this_week = t - f; // -6..=6: same ISO week's occurrence (negative = already past)
    match which {
        Which::This => this_week,
        Which::Next => this_week + 7,
        Which::Upcoming => this_week.rem_euclid(7), // 0..=6, soonest today-or-later
    }
}

fn base_date(day: &DayRef, anchor: &jiff::Zoned) -> Result<jiff::civil::Date, TemporalError> {
    let today = anchor.date();
    let out = match day {
        DayRef::RelativeDay(off) => today.checked_add(off.days()),
        DayRef::RelativeUnit(n, Unit::Day) => today.checked_add(n.days()),
        // Date arithmetic in whole days avoids week/month span edge cases.
        DayRef::RelativeUnit(n, Unit::Week) => today.checked_add((n * 7).days()),
        DayRef::RelativeUnit(n, Unit::Month) => today.checked_add(n.months()),
        DayRef::Weekday(wd, which) => {
            today.checked_add(offset_to_weekday(anchor.weekday(), *wd, *which).days())
        }
        DayRef::Absolute(d) => return Ok(*d),
    };
    out.map_err(|e| TemporalError::Invalid(e.to_string()))
}

fn at(date: jiff::civil::Date, hour: i8, minute: i8, tz: &jiff::tz::TimeZone) -> Result<jiff::Zoned, TemporalError> {
    date.at(hour, minute, 0, 0)
        .to_zoned(tz.clone())
        .map_err(|e| TemporalError::Invalid(e.to_string()))
}

/// Resolve a structured intent against a timezone-aware anchor, with validation.
pub fn resolve(
    intent: &TemporalIntent,
    anchor: &jiff::Zoned,
    opts: ResolveOpts,
) -> Result<Resolved, TemporalError> {
    let tz = anchor.time_zone().clone();
    let date = base_date(&intent.day, anchor)?;

    let (start, end, date_only) = match intent.time {
        TimeSpec::None => (at(date, 0, 0, &tz)?, None, true),
        TimeSpec::At { hour, minute } => (at(date, hour, minute, &tz)?, None, false),
        TimeSpec::Part(part) => {
            let (sh, eh, next_day) = part_window(part);
            let start = at(date, sh, 0, &tz)?;
            let end_date = if next_day {
                date.checked_add(1.days())
                    .map_err(|e| TemporalError::Invalid(e.to_string()))?
            } else {
                date
            };
            (start, Some(at(end_date, eh, 0, &tz)?), false)
        }
    };

    // Future check: a bare DATE is "future" if it's today or later (booking today
    // is legitimate); a DATETIME must be strictly after now (07:00 today, once
    // past, is not bookable).
    let is_future = if date_only {
        start.date() >= anchor.date()
    } else {
        start.timestamp() > anchor.timestamp()
    };

    let iso = if date_only {
        start.date().to_string()
    } else {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:00{}",
            start.year(),
            start.month(),
            start.day(),
            start.hour(),
            start.minute(),
            crate::offset_hhmm(&start),
        )
    };

    let human = {
        let base = format!(
            "{} {} {} {}",
            crate::weekday_it(start.weekday()),
            start.day(),
            crate::month_it(start.month()),
            start.year(),
        );
        match intent.time {
            TimeSpec::None => base,
            TimeSpec::At { hour, minute } => format!("{base} at {hour:02}:{minute:02}"),
            TimeSpec::Part(part) => {
                let label = match part {
                    DayPart::Morning => "morning",
                    DayPart::Afternoon => "afternoon",
                    DayPart::Evening => "evening",
                    DayPart::Night => "night",
                };
                format!("{base} ({label})")
            }
        }
    };

    if opts.must_be_future && !is_future {
        return Err(TemporalError::Past {
            chosen: human,
            now: now_human(anchor),
        });
    }

    Ok(Resolved {
        start,
        end,
        date_only,
        iso,
        human,
        is_future,
    })
}

fn now_human(anchor: &jiff::Zoned) -> String {
    format!(
        "{} {} {} {} at {:02}:{:02}",
        crate::weekday_it(anchor.weekday()),
        anchor.day(),
        crate::month_it(anchor.month()),
        anchor.year(),
        anchor.hour(),
        anchor.minute(),
    )
}

// ----------------------------------------------------------- parsing from JSON

/// Map a weekday word (it/en/es/fr/de, accent/caseless) to a jiff weekday.
pub fn parse_weekday(s: &str) -> Option<jiff::civil::Weekday> {
    use jiff::civil::Weekday::*;
    let k = s.trim().to_lowercase();
    Some(match k.as_str() {
        "monday" | "mon" | "lunedì" | "lunedi" | "lun" | "lunes" | "lundi" | "montag" => Monday,
        "tuesday" | "tue" | "martedì" | "martedi" | "mar" | "martes" | "mardi" | "dienstag" => {
            Tuesday
        }
        "wednesday" | "wed" | "mercoledì" | "mercoledi" | "mer" | "miércoles" | "miercoles"
        | "mercredi" | "mittwoch" => Wednesday,
        "thursday" | "thu" | "giovedì" | "giovedi" | "gio" | "jueves" | "jeudi" | "donnerstag" => {
            Thursday
        }
        "friday" | "fri" | "venerdì" | "venerdi" | "ven" | "viernes" | "vendredi" | "freitag" => {
            Friday
        }
        "saturday" | "sat" | "sabato" | "sab" | "sábado" | "sabado" | "samedi" | "samstag" => {
            Saturday
        }
        "sunday" | "sun" | "domenica" | "dom" | "domingo" | "dimanche" | "sonntag" => Sunday,
        _ => return None,
    })
}

fn parse_time(s: &str) -> Option<(i8, i8)> {
    let s = s.trim();
    let mut it = s.split(':');
    let h: i8 = it.next()?.trim().parse().ok()?;
    let m: i8 = it.next().unwrap_or("0").trim().parse().ok()?;
    if (0..=23).contains(&h) && (0..=59).contains(&m) {
        Some((h, m))
    } else {
        None
    }
}

fn parse_part(s: &str) -> Option<DayPart> {
    match s.trim().to_lowercase().as_str() {
        "morning" | "mattina" | "mattino" | "mañana" | "manana" | "matin" | "morgen" => {
            Some(DayPart::Morning)
        }
        "afternoon" | "pomeriggio" | "tarde" | "après-midi" | "apres-midi" | "nachmittag" => {
            Some(DayPart::Afternoon)
        }
        "evening" | "sera" | "noche" | "soir" | "abend" => Some(DayPart::Evening),
        "night" | "notte" | "nuit" | "nacht" => Some(DayPart::Night),
        _ => None,
    }
}

/// Build a [`TemporalIntent`] from the tool's JSON arguments (filled by the
/// orchestrator after it has understood the user's phrasing in any language).
pub fn intent_from_json(args: &serde_json::Value) -> Result<TemporalIntent, TemporalError> {
    let kind = args
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    let day = match kind.as_str() {
        "relative_day" => {
            let off = args.get("offset_days").and_then(|v| v.as_i64()).unwrap_or(0);
            DayRef::RelativeDay(off)
        }
        "weekday" => {
            let wd = args
                .get("weekday")
                .and_then(|v| v.as_str())
                .and_then(parse_weekday)
                .ok_or_else(|| TemporalError::Invalid("weekday missing or not recognized".into()))?;
            // Absent → Upcoming (soonest), the intuitive default for a bare weekday.
            let which = match args.get("which").and_then(|v| v.as_str()).unwrap_or("") {
                "this" | "questo" | "questa" | "esta" | "ce" | "diese" => Which::This,
                "next" | "prossimo" | "prossima" | "próximo" | "proximo" | "prochain"
                | "nächste" | "naechste" => Which::Next,
                _ => Which::Upcoming,
            };
            DayRef::Weekday(wd, which)
        }
        "relative_unit" => {
            let n = args.get("n").and_then(|v| v.as_i64()).unwrap_or(0);
            let unit = match args.get("unit").and_then(|v| v.as_str()).unwrap_or("day") {
                "week" | "weeks" | "settimana" | "settimane" => Unit::Week,
                "month" | "months" | "mese" | "mesi" => Unit::Month,
                _ => Unit::Day,
            };
            DayRef::RelativeUnit(n, unit)
        }
        "absolute" => {
            let raw = args
                .get("date")
                .and_then(|v| v.as_str())
                .ok_or_else(|| TemporalError::Invalid("date (YYYY-MM-DD) missing".into()))?;
            let date: jiff::civil::Date = raw
                .trim()
                .parse()
                .map_err(|_| TemporalError::Invalid(format!("invalid date: {raw}")))?;
            DayRef::Absolute(date)
        }
        other => {
            return Err(TemporalError::Invalid(format!(
                "unknown kind: «{other}» (use relative_day|weekday|relative_unit|absolute)"
            )))
        }
    };

    let time = if let Some((h, m)) = args.get("time").and_then(|v| v.as_str()).and_then(parse_time) {
        TimeSpec::At { hour: h, minute: m }
    } else if let Some(part) = args.get("part").and_then(|v| v.as_str()).and_then(parse_part) {
        TimeSpec::Part(part)
    } else {
        TimeSpec::None
    };

    Ok(TemporalIntent { day, time })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixed anchor: Wednesday 2026-06-10 08:12 Europe/Rome (UTC+02:00).
    fn anchor() -> jiff::Zoned {
        "2026-06-10T08:12:00+02:00[Europe/Rome]"
            .parse()
            .expect("valid anchor")
    }

    fn r(intent: TemporalIntent) -> Resolved {
        resolve(&intent, &anchor(), ResolveOpts::default()).expect("resolves")
    }

    #[test]
    fn it_domani_mattina_verso_le_7() {
        // "domani mattina verso le 7" → 11 giu 07:00, future.
        let intent = TemporalIntent {
            day: DayRef::RelativeDay(1),
            time: TimeSpec::At { hour: 7, minute: 0 },
        };
        let got = r(intent);
        assert_eq!(got.iso, "2026-06-11T07:00:00+02:00");
        assert!(got.is_future);
    }

    #[test]
    fn en_next_monday_at_9() {
        // Wed 10 → next Monday = 15 giu 09:00.
        let intent = TemporalIntent {
            day: DayRef::Weekday(jiff::civil::Weekday::Monday, Which::Next),
            time: TimeSpec::At { hour: 9, minute: 0 },
        };
        let got = r(intent);
        assert_eq!(got.iso, "2026-06-15T09:00:00+02:00");
    }

    #[test]
    fn es_pasado_manana() {
        // "pasado mañana" → +2 days, date-only.
        let got = r(TemporalIntent {
            day: DayRef::RelativeDay(2),
            time: TimeSpec::None,
        });
        assert_eq!(got.iso, "2026-06-12");
        assert!(got.date_only);
    }

    #[test]
    fn fr_dans_3_jours() {
        let got = r(TemporalIntent {
            day: DayRef::RelativeUnit(3, Unit::Day),
            time: TimeSpec::None,
        });
        assert_eq!(got.iso, "2026-06-13");
    }

    #[test]
    fn de_uebermorgen_via_json() {
        // The orchestrator maps "übermorgen" → relative_day offset 2.
        let intent = intent_from_json(&serde_json::json!({
            "kind": "relative_day", "offset_days": 2
        }))
        .unwrap();
        assert_eq!(r(intent).iso, "2026-06-12");
    }

    #[test]
    fn json_multilingual_weekday_and_part() {
        // "lunedì prossimo mattina" via structured args, any language word works.
        let intent = intent_from_json(&serde_json::json!({
            "kind": "weekday", "weekday": "lunedì", "which": "next", "part": "mattina"
        }))
        .unwrap();
        let got = r(intent);
        assert_eq!(got.start.date().to_string(), "2026-06-15");
        assert!(got.end.is_some(), "part-of-day yields a window");
    }

    #[test]
    fn past_time_today_is_rejected() {
        // 07:00 today, at anchor 08:12, is in the past → error when future required.
        let intent = TemporalIntent {
            day: DayRef::RelativeDay(0),
            time: TimeSpec::At { hour: 7, minute: 0 },
        };
        let err = resolve(&intent, &anchor(), ResolveOpts { must_be_future: true }).unwrap_err();
        assert!(matches!(err, TemporalError::Past { .. }));
    }

    #[test]
    fn today_as_a_date_is_allowed() {
        // A bare date == today is acceptable even with must_be_future.
        let got = r(TemporalIntent {
            day: DayRef::RelativeDay(0),
            time: TimeSpec::None,
        });
        assert_eq!(got.iso, "2026-06-10");
        assert!(got.is_future);
    }

    #[test]
    fn this_monday_can_be_in_the_past_this_week() {
        // Wed 10 → "this Monday" = Mon 8 (date-only, before today) → rejected when
        // future is required, accepted otherwise.
        let intent = TemporalIntent {
            day: DayRef::Weekday(jiff::civil::Weekday::Monday, Which::This),
            time: TimeSpec::None,
        };
        let lenient = resolve(&intent, &anchor(), ResolveOpts { must_be_future: false }).unwrap();
        assert_eq!(lenient.iso, "2026-06-08");
        assert!(!lenient.is_future);
        assert!(resolve(&intent, &anchor(), ResolveOpts { must_be_future: true }).is_err());
    }
}
