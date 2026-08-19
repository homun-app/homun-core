//! Automation formatting ownership.
//!
//! UI DTOs and chat confirmations use these helpers to present recurrence rules
//! and event triggers in one-line human-readable form.

use local_first_task_runtime::{AutomationTrigger, EventTrigger};

pub(crate) fn scheduled_thread_sender_for_task_id(task_id: &str) -> String {
    task_id.split("@occ@").next().unwrap_or(task_id).to_string()
}

pub(crate) fn scheduled_thread_title(goal: &str) -> String {
    let trimmed: String = goal.chars().take(48).collect();
    format!("Pianificato · {trimmed}")
}

/// Human label for a recurrence rule (handles the flexible `dow@days@times` form).
pub(crate) fn humanize_recurrence(rec: &str) -> String {
    fn day_label(d: &str) -> &str {
        match d.trim() {
            "mon" => "Mon",
            "tue" => "Tue",
            "wed" => "Wed",
            "thu" => "Thu",
            "fri" => "Fri",
            "sat" => "Sat",
            "sun" => "Sun",
            other => other,
        }
    }
    let lower = rec.trim().to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("dow")
        && let Some((days, times)) = rest.trim_start_matches(['@', ' ']).split_once('@')
    {
        let times_h = times
            .split(',')
            .map(str::trim)
            .collect::<Vec<_>>()
            .join(", ");
        let days_h = if matches!(days.trim(), "*" | "all" | "daily" | "") {
            "Every day".to_string()
        } else {
            days.split(',')
                .map(day_label)
                .collect::<Vec<_>>()
                .join(", ")
        };
        return format!("{days_h} · {times_h}");
    }
    if let Some(t) = lower.strip_prefix("daily") {
        return format!("Every day · {}", t.trim_start_matches(['@', ' ']).trim());
    }
    if let Some(rest) = lower.strip_prefix("weekly") {
        let rest = rest.trim_start_matches(['@', ' ']);
        if let Some((d, t)) = rest.split_once(['@', ' ']) {
            return format!(
                "{} · {}",
                day_label(d),
                t.trim_start_matches(['@', ' ']).trim()
            );
        }
    }
    if lower.starts_with("every") {
        return rec.replacen("every", "Every", 1);
    }
    rec.to_string()
}

/// Human one-line summary of a trigger for the list view.
pub(crate) fn automation_trigger_summary(trigger: &AutomationTrigger) -> String {
    match trigger {
        AutomationTrigger::Schedule { recurrence, .. } => {
            format!("Schedule · {}", humanize_recurrence(recurrence))
        }
        AutomationTrigger::Event { event } => match event {
            EventTrigger::ChannelMessage { channel, from } => {
                let ch = channel.as_deref().unwrap_or("any channel");
                match from {
                    Some(f) => format!("When {f} writes on {ch}"),
                    None => format!("Message on {ch}"),
                }
            }
            EventTrigger::EmailReceived { from } => match from {
                Some(f) => format!("Email from {f}"),
                None => "Email received".to_string(),
            },
            EventTrigger::FileChanged { path } => format!("File changed: {path}"),
            EventTrigger::MemoryUpdated { topic } => match topic {
                Some(t) => format!("Memory updated: {t}"),
                None => "Memory updated".to_string(),
            },
            EventTrigger::ConnectorPoll { tool, label, .. } => match label {
                Some(l) => format!("Event · {l}"),
                None => format!("Event · {tool}"),
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{automation_trigger_summary, humanize_recurrence};
    use local_first_task_runtime::{AutomationTrigger, EventTrigger};

    #[test]
    fn gateway_automation_formatting_humanizes_recurrence_rules() {
        assert_eq!(
            humanize_recurrence("dow@mon,wed,fri@08:00,12:00"),
            "Mon, Wed, Fri · 08:00, 12:00"
        );
        assert_eq!(humanize_recurrence("dow@*@09:00"), "Every day · 09:00");
        assert_eq!(humanize_recurrence("daily@08:00"), "Every day · 08:00");
        assert_eq!(humanize_recurrence("weekly@fri@18:00"), "Fri · 18:00");
        assert_eq!(humanize_recurrence("every 6h"), "Every 6h");
    }

    #[test]
    fn gateway_automation_formatting_summarizes_schedule_and_channel_triggers() {
        let schedule = AutomationTrigger::Schedule {
            recurrence: "daily@08:00".to_string(),
            tz: Some("Europe/Rome".to_string()),
        };
        assert_eq!(
            automation_trigger_summary(&schedule),
            "Schedule · Every day · 08:00"
        );

        let channel = AutomationTrigger::Event {
            event: EventTrigger::ChannelMessage {
                channel: Some("telegram".to_string()),
                from: Some("Mario".to_string()),
            },
        };
        assert_eq!(
            automation_trigger_summary(&channel),
            "When Mario writes on telegram"
        );
    }

    #[test]
    fn gateway_automation_formatting_summarizes_connector_poll_fallbacks() {
        let labeled = AutomationTrigger::Event {
            event: EventTrigger::ConnectorPoll {
                tool: "GMAIL_FETCH_EMAILS".to_string(),
                args: serde_json::json!({}),
                key_field: "id".to_string(),
                label: Some("Inbox".to_string()),
            },
        };
        assert_eq!(automation_trigger_summary(&labeled), "Event · Inbox");

        let unlabeled = AutomationTrigger::Event {
            event: EventTrigger::ConnectorPoll {
                tool: "GMAIL_FETCH_EMAILS".to_string(),
                args: serde_json::json!({}),
                key_field: "id".to_string(),
                label: None,
            },
        };
        assert_eq!(
            automation_trigger_summary(&unlabeled),
            "Event · GMAIL_FETCH_EMAILS"
        );
    }
}
