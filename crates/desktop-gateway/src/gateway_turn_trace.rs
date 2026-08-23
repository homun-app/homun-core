//! Gateway turn-trace entry owner.

use super::*;

pub(crate) struct TurnTraceEntry {
    pub(crate) request_id: String,
    pub(crate) prompt: String,
    pub(crate) mode: Option<String>,
    pub(crate) model: String,
    pub(crate) enabled: bool,
    pub(crate) logs_dir: Result<std::path::PathBuf, std::io::Error>,
    pub(crate) max_bytes: u64,
}

pub(crate) fn begin_turn_trace(entry: TurnTraceEntry) -> local_first_engine::turn_trace::TurnTrace {
    let turn_trace = if entry.enabled {
        match entry.logs_dir {
            Ok(dir) => local_first_engine::turn_trace::TurnTrace::new(
                entry.request_id.clone(),
                dir,
                entry.max_bytes,
            ),
            Err(_) => local_first_engine::turn_trace::TurnTrace::disabled(),
        }
    } else {
        local_first_engine::turn_trace::TurnTrace::disabled()
    };
    turn_trace.record(local_first_engine::turn_trace::TurnEvent::TurnReceived {
        prompt_head: entry.prompt.chars().take(200).collect(),
        prompt_len: entry.prompt.chars().count(),
        mode: entry.mode.as_deref().unwrap_or("agent").to_string(),
        model: entry.model,
    });
    turn_trace
}

pub(crate) struct ChatTurnTraceInput<'a> {
    pub(crate) request_id: &'a str,
    pub(crate) prompt: &'a str,
    pub(crate) mode: Option<&'a str>,
    pub(crate) model: &'a str,
}

pub(crate) fn begin_chat_turn_trace(
    input: ChatTurnTraceInput<'_>,
) -> local_first_engine::turn_trace::TurnTrace {
    begin_chat_turn_trace_with_config(
        input,
        turn_trace_enabled(),
        gateway_logs_dir(),
        turn_trace_max_bytes(),
    )
}

fn begin_chat_turn_trace_with_config(
    input: ChatTurnTraceInput<'_>,
    enabled: bool,
    logs_dir: Result<std::path::PathBuf, std::io::Error>,
    max_bytes: u64,
) -> local_first_engine::turn_trace::TurnTrace {
    begin_turn_trace(TurnTraceEntry {
        request_id: input.request_id.to_string(),
        prompt: input.prompt.to_string(),
        mode: input.mode.map(str::to_string),
        model: input.model.to_string(),
        enabled,
        logs_dir,
        max_bytes,
    })
}

pub(crate) struct ChatTurnStartTraceInput<'a> {
    pub(crate) turn_trace: &'a local_first_engine::turn_trace::TurnTrace,
    pub(crate) prompt: &'a str,
    pub(crate) mode: &'a str,
    pub(crate) model: &'a str,
    pub(crate) tier: &'a str,
}

pub(crate) fn record_chat_turn_start_trace(input: ChatTurnStartTraceInput<'_>) {
    input
        .turn_trace
        .record(local_first_engine::turn_trace::TurnEvent::TurnStart {
            prompt_head: input.prompt.chars().take(200).collect(),
            prompt_len: input.prompt.chars().count(),
            mode: input.mode.to_string(),
            model: input.model.to_string(),
            tier: input.tier.to_string(),
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_turn_trace_records_turn_received_when_enabled() {
        let dir = unique_temp_dir("enabled");
        std::fs::create_dir_all(&dir).unwrap();

        let _trace = begin_turn_trace(TurnTraceEntry {
            request_id: "turn-a".to_string(),
            prompt: "ciao Milano".to_string(),
            mode: Some("agent".to_string()),
            model: "gpt-test".to_string(),
            enabled: true,
            logs_dir: Ok(dir.clone()),
            max_bytes: 5_000_000,
        });

        let line = std::fs::read_to_string(dir.join("turn-trace.jsonl")).unwrap();
        assert!(line.contains("\"kind\":\"turn_received\""));
        assert!(line.contains("\"turn_id\":\"turn-a\""));
        assert!(line.contains("\"prompt_head\":\"ciao Milano\""));
        assert!(line.contains("\"prompt_len\":11"));
        assert!(line.contains("\"mode\":\"agent\""));
        assert!(line.contains("\"model\":\"gpt-test\""));
    }

    #[test]
    fn chat_turn_trace_bootstrap_records_turn_received() {
        let dir = unique_temp_dir("chat-bootstrap");
        std::fs::create_dir_all(&dir).unwrap();

        let _trace = begin_chat_turn_trace_with_config(
            ChatTurnTraceInput {
                request_id: "chat-turn-a",
                prompt: "trova report",
                mode: Some("agent"),
                model: "gpt-test",
            },
            true,
            Ok(dir.clone()),
            5_000_000,
        );

        let line = std::fs::read_to_string(dir.join("turn-trace.jsonl")).unwrap();
        assert!(line.contains("\"kind\":\"turn_received\""));
        assert!(line.contains("\"turn_id\":\"chat-turn-a\""));
        assert!(line.contains("\"prompt_head\":\"trova report\""));
        assert!(line.contains("\"prompt_len\":12"));
        assert!(line.contains("\"mode\":\"agent\""));
        assert!(line.contains("\"model\":\"gpt-test\""));
    }

    #[test]
    fn gateway_turn_trace_disabled_does_not_write() {
        let dir = unique_temp_dir("disabled");
        std::fs::create_dir_all(&dir).unwrap();

        let _trace = begin_turn_trace(TurnTraceEntry {
            request_id: "turn-a".to_string(),
            prompt: "ciao".to_string(),
            mode: None,
            model: "gpt-test".to_string(),
            enabled: false,
            logs_dir: Ok(dir.clone()),
            max_bytes: 5_000_000,
        });

        assert!(!dir.join("turn-trace.jsonl").exists());
    }

    #[test]
    fn gateway_turn_trace_records_turn_start_when_setup_completes() {
        let dir = unique_temp_dir("turn-start");
        std::fs::create_dir_all(&dir).unwrap();

        let trace = begin_turn_trace(TurnTraceEntry {
            request_id: "turn-start-a".to_string(),
            prompt: "ciao Roma".to_string(),
            mode: Some("agent".to_string()),
            model: "gpt-test".to_string(),
            enabled: true,
            logs_dir: Ok(dir.clone()),
            max_bytes: 5_000_000,
        });

        record_chat_turn_start_trace(ChatTurnStartTraceInput {
            turn_trace: &trace,
            prompt: "ciao Roma",
            mode: "agent",
            model: "gpt-test",
            tier: "frontier",
        });

        let lines = std::fs::read_to_string(dir.join("turn-trace.jsonl")).unwrap();
        assert!(lines.contains("\"kind\":\"turn_received\""));
        assert!(lines.contains("\"kind\":\"turn_start\""));
        assert!(lines.contains("\"prompt_head\":\"ciao Roma\""));
        assert!(lines.contains("\"prompt_len\":9"));
        assert!(lines.contains("\"mode\":\"agent\""));
        assert!(lines.contains("\"model\":\"gpt-test\""));
        assert!(lines.contains("\"tier\":\"frontier\""));
    }

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "homun-gateway-turn-trace-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        dir
    }
}
