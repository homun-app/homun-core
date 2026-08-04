//! Datetime tool schema ownership.
//!
//! This module owns the manager-facing `resolve_datetime` contract. The model
//! classifies localized or relative time references; the runtime computes the
//! absolute value from the current timezone-aware clock.

pub(crate) fn resolve_datetime_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "resolve_datetime",
            "description": "Converts a user's time reference (in ANY language: \"tomorrow morning\", \
    \"next Monday at 9\", \"pasado mañana\", \"in 3 days\", \"the 15th\") into the correct ABSOLUTE \
    date/time, computed relative to NOW and the user's timezone. CALL IT BEFORE using any date — don't \
    compute dates yourself (you easily get \"today\" wrong). You CLASSIFY the reference by filling in the \
    fields below; I do the computation. Returns the ISO value to write into forms or pass to other tools.",
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["relative_day", "weekday", "relative_unit", "absolute"],
                        "description": "relative_day: today/tomorrow/yesterday/day-after-tomorrow (use offset_days). \
    weekday: a day of the week (use weekday + which). relative_unit: \"in N days/weeks/months\" \
    (use n + unit). absolute: explicit date (use date)."
                    },
                    "offset_days": {
                        "type": "integer",
                        "description": "For kind=relative_day: 0=today, 1=tomorrow, -1=yesterday, 2=day-after-tomorrow, etc."
                    },
                    "weekday": {
                        "type": "string",
                        "description": "For kind=weekday: monday..sunday (or monday..sunday, any language)."
                    },
                    "which": {
                        "type": "string",
                        "enum": ["upcoming", "this", "next"],
                        "description": "For kind=weekday: upcoming=the closest future (default), this=this week, next=next week."
                    },
                    "n": { "type": "integer", "description": "For kind=relative_unit: how many units (e.g. 3)." },
                    "unit": {
                        "type": "string",
                        "enum": ["day", "week", "month"],
                        "description": "For kind=relative_unit: the unit (day/week/month)."
                    },
                    "date": { "type": "string", "description": "For kind=absolute: ISO date YYYY-MM-DD." },
                    "time": { "type": "string", "description": "Time \"HH:MM\" if the user specifies it (e.g. \"07:00\"). Optional." },
                    "part": {
                        "type": "string",
                        "enum": ["morning", "afternoon", "evening", "night"],
                        "description": "Part of day if there's no precise time (e.g. \"in the morning\"). Optional."
                    },
                    "must_be_future": {
                        "type": "boolean",
                        "description": "Default true: rejects an already-past date/time (for bookings/searches). Set false only if a past date is needed."
                    }
                },
                "required": ["kind"]
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::resolve_datetime_tool_schema;

    #[test]
    fn gateway_datetime_tools_exports_resolve_datetime_schema() {
        let schema = resolve_datetime_tool_schema();

        assert_eq!(schema["function"]["name"], "resolve_datetime");
        assert_eq!(schema["function"]["parameters"]["required"][0], "kind");
        assert_eq!(
            schema["function"]["parameters"]["properties"]["kind"]["enum"][0],
            "relative_day"
        );
        assert_eq!(
            schema["function"]["parameters"]["properties"]["must_be_future"]["type"],
            "boolean"
        );
    }
}
