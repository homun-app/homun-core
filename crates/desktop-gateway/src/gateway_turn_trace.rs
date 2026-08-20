//! Gateway turn-trace entry owner.

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
