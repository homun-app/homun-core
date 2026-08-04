//! Automation tool schema ownership.
//!
//! Chat dispatch still lives in the gateway root for now; this module owns only
//! the manager-visible JSON schemas for schedule and automation tools.

pub(crate) fn schedule_task_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "schedule_task",
            "description": "Create a recurring time-based AUTOMATION (a rule, visible in \
    Automations). Use it when the user asks to do/check something periodically (e.g. \
    \"every morning check the news on X\", \"every Monday send me the summary\"). On each occurrence \
    I run the 'goal' with all tools and ASK FOR CONFIRMATION before sending/publishing. For \
    EVENT-based (non-time) triggers use create_automation. Do NOT use it for one-off immediate actions \
    (do those now).",
            "parameters": {
                "type": "object",
                "properties": {
                    "goal": {
                        "type": "string",
                        "description": "What to do on each execution, phrased as a complete instruction (e.g. \"Search the web for the latest news on Jannik Sinner and summarize them\")."
                    },
                    "every": {
                        "type": "string",
                        "description": "When/how often to repeat. INTERVAL: \"every 30m\", \"every 6h\", \"every 1d\", \"every 1w\". ANCHORED: \"daily@08:00\", \"weekly@mon@09:30\". MULTIPLE DAYS/TIMES: \"dow@mon,wed,fri@08:00,12:00,18:00\" (or \"dow@*@09:00\" for every day). Days: mon..sun or lun..dom."
                    },
                    "timezone": {
                        "type": "string",
                        "description": "IANA timezone for rules anchored to a time (e.g. \"Europe/Rome\"). Optional: if absent I use the system timezone. Irrelevant for intervals."
                    }
                },
                "required": ["goal", "every"]
            }
        }
    })
}

pub(crate) fn create_automation_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "create_automation",
            "description": "Create a first-class AUTOMATION: a «when → then» rule. The trigger is time-based (recurrence) OR event-based (an incoming message on a channel). The action is a prompt that you will execute yourself with all tools. Use it when the user wants something recurring or reactive: «every Friday send me the summary», «when Mario writes me prepare a draft». The automation appears in the Automations section of the app.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Short title of the automation" },
                    "prompt": { "type": "string", "description": "What to do when it triggers, in natural language" },
                    "trigger_type": { "type": "string", "enum": ["schedule", "event"], "description": "schedule = time-based; event = on an incoming message on a channel" },
                    "recurrence": { "type": "string", "description": "Schedule only. Formats: daily@HH:MM | weekly@<dd>@HH:MM | dow@<dd,dd,…>@<HH:MM,HH:MM,…> for MULTIPLE DAYS and MULTIPLE TIMES (e.g. \"dow@mon,wed,fri@08:00,12:00,18:00\"; use dow@*@HH:MM,… for every day) | every Nh | every Nd. Days: mon,tue,wed,thu,fri,sat,sun." },
                    "timezone": { "type": "string", "description": "Schedule only: IANA timezone (default: user's timezone)" },
                    "event_channel": { "type": "string", "description": "Channel event only: whatsapp | telegram (empty = any channel)" },
                    "event_from": { "type": "string", "description": "Channel event only: sender's name or number (empty = anyone)" },
                    "event_tool": { "type": "string", "description": "Only for event on a CONNECTED SERVICE (Gmail/Calendar/Slack/MCP/…): the EXACT name of the read tool to poll cyclically (discover it with find_capability), e.g. \"GMAIL_FETCH_EMAILS\". Leave empty for a channel event." },
                    "event_args": { "type": "object", "description": "Only with event_tool: the query arguments (e.g. {\"query\":\"is:unread from:mario\"})" },
                    "event_key_field": { "type": "string", "description": "Only with event_tool: the field that uniquely identifies an item (so already-seen ones don't trigger again), e.g. \"messageId\", \"id\"." },
                    "require_confirmation": { "type": "boolean", "description": "true (default) = asks for confirmation before sending/publishing; false = autonomous" }
                },
                "required": ["title", "prompt", "trigger_type"]
            }
        }
    })
}

pub(crate) fn update_automation_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "update_automation",
            "description": "Edit an EXISTING automation (a «when → then» rule the user already has): change its title, its action (prompt), or — for a scheduled one — its recurrence. Use it when the user wants to FIX or CHANGE an existing automation, e.g. «in the Mondiali automation drop the browser-is-down part», «move my Friday summary to 9am». Identify it by `id` if you know it, otherwise by `match` (a fragment of its title). Does NOT enable/disable it (that's a separate toggle).",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The automation id (auto_…), if known." },
                    "match": { "type": "string", "description": "Alternative to id: a fragment of the automation's TITLE to find it (e.g. \"Mondiali\")." },
                    "title": { "type": "string", "description": "New title (optional)." },
                    "prompt": { "type": "string", "description": "New action — what it does when it triggers (optional)." },
                    "recurrence": { "type": "string", "description": "Scheduled automations only: new recurrence, same formats as create (daily@HH:MM, weekly@fri@HH:MM, every Nh, …)." }
                },
                "required": []
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{
        create_automation_tool_schema, schedule_task_tool_schema, update_automation_tool_schema,
    };

    #[test]
    fn gateway_automation_tools_export_canonical_tool_names() {
        assert_eq!(
            schedule_task_tool_schema()["function"]["name"],
            "schedule_task"
        );
        assert_eq!(
            create_automation_tool_schema()["function"]["name"],
            "create_automation"
        );
        assert_eq!(
            update_automation_tool_schema()["function"]["name"],
            "update_automation"
        );
    }

    #[test]
    fn gateway_automation_tools_preserve_required_fields() {
        let schedule = schedule_task_tool_schema();
        assert_eq!(schedule["function"]["parameters"]["required"][0], "goal");
        assert_eq!(schedule["function"]["parameters"]["required"][1], "every");

        let create = create_automation_tool_schema();
        assert_eq!(create["function"]["parameters"]["required"][0], "title");
        assert_eq!(create["function"]["parameters"]["required"][1], "prompt");
        assert_eq!(
            create["function"]["parameters"]["required"][2],
            "trigger_type"
        );

        let update = update_automation_tool_schema();
        assert!(
            update["function"]["parameters"]["required"]
                .as_array()
                .is_some_and(|required| required.is_empty())
        );
    }
}
