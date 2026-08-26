//! Deterministic temporal preflight for clearly impossible future-slot requests.
//!
//! The model still owns broad language understanding through `resolve_datetime`.
//! This preflight is deliberately narrower: it catches explicit date+time slots
//! in operational search/booking prompts before any browser/tool work can start.

use local_first_subagents::{GenerateStreamEvent, TokenMetrics};

use crate::{now_local, temporal};

pub(crate) enum TemporalPreflightOutcome {
    Continue,
    EarlyResponse(GenerateStreamEvent),
}

impl TemporalPreflightOutcome {
    pub(crate) fn into_done_text(self) -> Option<String> {
        match self {
            Self::EarlyResponse(GenerateStreamEvent::Done { text, .. }) => Some(text),
            _ => None,
        }
    }
}

pub(crate) fn evaluate_chat_temporal_preflight(prompt: &str) -> TemporalPreflightOutcome {
    evaluate_chat_temporal_preflight_at(prompt, &now_local())
}

fn evaluate_chat_temporal_preflight_at(
    prompt: &str,
    anchor: &jiff::Zoned,
) -> TemporalPreflightOutcome {
    if !looks_like_future_slot_request(prompt) {
        return TemporalPreflightOutcome::Continue;
    }
    let Some(intent) = explicit_absolute_datetime_intent(prompt, anchor) else {
        return TemporalPreflightOutcome::Continue;
    };
    match temporal::resolve(
        &intent,
        anchor,
        temporal::ResolveOpts {
            must_be_future: true,
        },
    ) {
        Ok(_) => TemporalPreflightOutcome::Continue,
        Err(temporal::TemporalError::Past { chosen, now }) => {
            TemporalPreflightOutcome::EarlyResponse(GenerateStreamEvent::Done {
                text: format!(
                    "Non posso cercare quella partenza come opzione utile: {chosen} e' gia' nel passato. Ora e' {now}. Dimmi un nuovo orario o una nuova data futura e riparto da li."
                ),
                metrics: TokenMetrics::zero(),
                redacted_user_text: None,
            })
        }
        Err(_) => TemporalPreflightOutcome::Continue,
    }
}

fn looks_like_future_slot_request(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    let has_operational_verb = [
        "trova",
        "trovi",
        "cerca",
        "cercami",
        "prenota",
        "prenotare",
        "find",
        "search",
        "book",
        "get me",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let has_slot_domain = [
        "treno",
        "treni",
        "train",
        "volo",
        "voli",
        "flight",
        "hotel",
        "ristorante",
        "restaurant",
        "biglietto",
        "ticket",
        "appuntamento",
        "reservation",
        "booking",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    has_operational_verb && has_slot_domain
}

fn explicit_absolute_datetime_intent(
    prompt: &str,
    anchor: &jiff::Zoned,
) -> Option<temporal::TemporalIntent> {
    let tokens = normalized_tokens(prompt);
    let (date_index, day) = find_explicit_day_ref(&tokens, anchor)?;
    let (hour, minute) = find_time(&tokens, date_index)?;
    Some(temporal::TemporalIntent {
        day,
        time: temporal::TimeSpec::At { hour, minute },
    })
}

fn normalized_tokens(prompt: &str) -> Vec<String> {
    prompt
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ':' | 'à' | 'è' | 'é' | 'ì' | 'ò' | 'ù') {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

fn find_explicit_day_ref(
    tokens: &[String],
    anchor: &jiff::Zoned,
) -> Option<(usize, temporal::DayRef)> {
    for (index, token) in tokens.iter().enumerate() {
        if matches!(token.as_str(), "oggi" | "today") {
            return Some((index, temporal::DayRef::RelativeDay(0)));
        }
        let Ok(day) = token.parse::<i8>() else {
            continue;
        };
        if !(1..=31).contains(&day) {
            continue;
        }
        let Some(month) = tokens.get(index + 1).and_then(|value| month_number(value)) else {
            continue;
        };
        let year = tokens
            .iter()
            .skip(index + 2)
            .take(3)
            .find_map(|value| {
                let parsed = value.parse::<i16>().ok()?;
                (1900..=2200).contains(&parsed).then_some(parsed)
            })
            .unwrap_or(anchor.year());
        let raw = format!("{year:04}-{month:02}-{day:02}");
        let date = raw.parse::<jiff::civil::Date>().ok()?;
        return Some((index, temporal::DayRef::Absolute(date)));
    }
    None
}

fn find_time(tokens: &[String], date_index: usize) -> Option<(i8, i8)> {
    for (index, token) in tokens.iter().enumerate() {
        if index == date_index {
            continue;
        }
        let Some((mut hour, minute)) = parse_hour_token(token) else {
            continue;
        };
        if !time_has_slot_context(tokens, index) {
            continue;
        }
        if hour <= 12
            && nearby(
                tokens,
                index,
                &["pomeriggio", "sera", "afternoon", "evening"],
            )
        {
            hour = if hour == 12 { 12 } else { hour + 12 };
        }
        return Some((hour, minute));
    }
    None
}

fn parse_hour_token(token: &str) -> Option<(i8, i8)> {
    if let Some((h, m)) = token.split_once(':') {
        let hour = h.parse::<i8>().ok()?;
        let minute = m.parse::<i8>().ok()?;
        if (0..=23).contains(&hour) && (0..=59).contains(&minute) {
            return Some((hour, minute));
        }
        return None;
    }
    let hour = token.parse::<i8>().ok()?;
    (0..=23).contains(&hour).then_some((hour, 0))
}

fn time_has_slot_context(tokens: &[String], index: usize) -> bool {
    nearby(
        tokens,
        index,
        &[
            "alle",
            "le",
            "ore",
            "verso",
            "circa",
            "at",
            "around",
            "mattina",
            "mattino",
            "morning",
            "pomeriggio",
            "afternoon",
            "sera",
            "evening",
        ],
    )
}

fn nearby(tokens: &[String], index: usize, needles: &[&str]) -> bool {
    let start = index.saturating_sub(3);
    let end = usize::min(tokens.len(), index + 4);
    tokens[start..end]
        .iter()
        .any(|token| needles.iter().any(|needle| token == needle))
}

fn month_number(value: &str) -> Option<i8> {
    Some(match value {
        "gennaio" | "january" | "jan" => 1,
        "febbraio" | "february" | "feb" => 2,
        "marzo" | "march" | "mar" => 3,
        "aprile" | "april" | "apr" => 4,
        "maggio" | "may" => 5,
        "giugno" | "june" | "jun" => 6,
        "luglio" | "july" | "jul" => 7,
        "agosto" | "august" | "aug" => 8,
        "settembre" | "september" | "sep" => 9,
        "ottobre" | "october" | "oct" => 10,
        "novembre" | "november" | "nov" => 11,
        "dicembre" | "december" | "dec" => 12,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor() -> jiff::Zoned {
        "2026-08-25T14:39:00+02:00[Europe/Rome]"
            .parse()
            .expect("valid anchor")
    }

    #[test]
    fn past_train_departure_today_short_circuits_before_browser() {
        let prompt =
            "mi trovi un treno da Milano a Roma per il 25 agosto 2026 verso le 8 del mattino";

        let TemporalPreflightOutcome::EarlyResponse(GenerateStreamEvent::Done { text, .. }) =
            evaluate_chat_temporal_preflight_at(prompt, &anchor())
        else {
            panic!("expected early response");
        };

        assert!(text.contains("gia' nel passato"));
        assert!(text.contains("14:39"));
    }

    #[test]
    fn past_train_departure_relative_today_short_circuits_before_browser() {
        let prompt = "Mi trovi un treno da Milano a Roma oggi alle 8 del mattino";

        let TemporalPreflightOutcome::EarlyResponse(GenerateStreamEvent::Done { text, .. }) =
            evaluate_chat_temporal_preflight_at(prompt, &anchor())
        else {
            panic!("expected early response");
        };

        assert!(text.contains("gia' nel passato"));
        assert!(text.contains("14:39"));
    }

    #[test]
    fn future_train_departure_continues_to_agent_loop() {
        let prompt = "mi trovi un treno da Milano a Roma per il 25 agosto 2026 verso le 18";

        assert!(matches!(
            evaluate_chat_temporal_preflight_at(prompt, &anchor()),
            TemporalPreflightOutcome::Continue
        ));
    }

    #[test]
    fn non_operational_historical_question_is_not_blocked() {
        let prompt = "che treni c'erano da Milano a Roma il 25 agosto 2026 alle 8?";

        assert!(matches!(
            evaluate_chat_temporal_preflight_at(prompt, &anchor()),
            TemporalPreflightOutcome::Continue
        ));
    }

    #[test]
    fn month_names_cover_italian_and_english_prompts() {
        assert_eq!(month_number("agosto"), Some(8));
        assert_eq!(month_number("august"), Some(8));
    }
}
