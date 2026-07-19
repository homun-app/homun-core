use local_first_engine::{AgentExecutionEvent, ExecutionJournal, LoopCheckpoint};
use local_first_task_runtime::TaskStore;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::time::{Duration, Instant};

const JOURNAL_QUEUE_CAPACITY: usize = 256;

enum WriterMessage {
    Event {
        kind: &'static str,
        round: Option<usize>,
        payload: Value,
    },
    Checkpoint {
        round: usize,
        state: Value,
        fingerprint: String,
    },
    Flush(mpsc::Sender<()>),
}

/// Non-blocking engine adapter. SQLite I/O happens only on its dedicated writer thread.
#[derive(Clone)]
pub(crate) struct GatewayExecutionJournal {
    sender: SyncSender<WriterMessage>,
    dropped_events: Arc<AtomicU64>,
    accepting: Arc<Mutex<bool>>,
}

#[derive(Clone)]
pub(crate) enum GatewayJournal {
    Durable(GatewayExecutionJournal),
    Disabled,
}

impl ExecutionJournal for GatewayJournal {
    fn record(&self, event: AgentExecutionEvent) {
        if let Self::Durable(journal) = self {
            journal.record(event);
        }
    }

    fn checkpoint(&self, checkpoint: LoopCheckpoint) {
        if let Self::Durable(journal) = self {
            journal.checkpoint(checkpoint);
        }
    }
}

impl GatewayExecutionJournal {
    pub(crate) fn start(run_id: String, database_path: PathBuf) -> Option<Self> {
        let (sender, receiver) = mpsc::sync_channel(JOURNAL_QUEUE_CAPACITY);
        let dropped_events = Arc::new(AtomicU64::new(0));
        let writer_dropped_events = dropped_events.clone();
        let accepting = Arc::new(Mutex::new(true));
        std::thread::Builder::new()
            .name(format!("agent-journal-{}", run_id.chars().take(16).collect::<String>()))
            .spawn(move || {
                let store = match TaskStore::open(database_path) {
                    Ok(store) => Some(store),
                    Err(error) => {
                        tracing::warn!(target: "agent::journal", %run_id, %error, "journal writer unavailable");
                        None
                    }
                };
                let mut seq = 2_i64;
                while let Ok(message) = receiver.recv() {
                    match message {
                        WriterMessage::Event { kind, round, payload } => {
                            if let Some(store) = &store {
                                if let Err(error) = store.append_agent_run_event(
                                    &run_id,
                                    seq,
                                    round.map(|value| value as i64),
                                    kind,
                                    &payload,
                                ) {
                                    writer_dropped_events.fetch_add(1, Ordering::Relaxed);
                                    tracing::warn!(target: "agent::journal", %run_id, seq, kind, %error, "journal event write failed");
                                }
                            } else {
                                writer_dropped_events.fetch_add(1, Ordering::Relaxed);
                            }
                            seq += 1;
                        }
                        WriterMessage::Checkpoint { round, state, fingerprint } => {
                            if let Some(store) = &store {
                                if let Err(error) = store.append_agent_checkpoint(
                                    &run_id,
                                    round as u32,
                                    &state,
                                    &fingerprint,
                                    true,
                                ) {
                                    writer_dropped_events.fetch_add(1, Ordering::Relaxed);
                                    tracing::warn!(target: "agent::journal", %run_id, round, %error, "checkpoint write failed");
                                }
                            }
                        }
                        WriterMessage::Flush(ack) => {
                            let _ = ack.send(());
                        }
                    }
                }
            })
            .ok()?;
        Some(Self {
            sender,
            dropped_events,
            accepting,
        })
    }

    /// Waits only at the gateway lifecycle boundary, never inside the engine loop.
    pub(crate) fn flush(&self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        let (ack_tx, ack_rx) = mpsc::channel();
        let mut message = WriterMessage::Flush(ack_tx);
        loop {
            match self.sender.try_send(message) {
                Ok(()) => break,
                Err(TrySendError::Full(returned)) => {
                    if Instant::now() >= deadline {
                        return false;
                    }
                    message = returned;
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(TrySendError::Disconnected(_)) => return false,
            }
        }
        ack_rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .is_ok()
    }

    pub(crate) fn close_and_flush(&self) -> bool {
        let mut accepting = self
            .accepting
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *accepting = false;
        drop(accepting);
        self.flush()
    }

    pub(crate) fn dropped_events(&self) -> u64 {
        self.dropped_events.load(Ordering::Relaxed)
    }
}

impl ExecutionJournal for GatewayExecutionJournal {
    fn record(&self, event: AgentExecutionEvent) {
        let accepting = self
            .accepting
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !*accepting {
            self.dropped_events.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let (kind, round, payload) = prepare_event(event);
        match self.sender.try_send(WriterMessage::Event {
            kind,
            round,
            payload,
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.dropped_events.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn checkpoint(&self, checkpoint: LoopCheckpoint) {
        let accepting = self.accepting.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !*accepting {
            self.dropped_events.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let round = checkpoint.round;
        let state = redact_json_value(
            serde_json::to_value(checkpoint).unwrap_or_else(|_| serde_json::json!({})),
        );
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&state).unwrap_or_default())
        );
        if self.sender.try_send(WriterMessage::Checkpoint { round, state, fingerprint }).is_err() {
            self.dropped_events.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn journal_registry() -> &'static Mutex<HashMap<String, GatewayExecutionJournal>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, GatewayExecutionJournal>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn register(run_id: &str, journal: GatewayExecutionJournal) {
    if let Ok(mut registry) = journal_registry().lock() {
        registry.insert(run_id.to_string(), journal);
    }
}

pub(crate) fn get(run_id: &str) -> Option<GatewayExecutionJournal> {
    journal_registry().lock().ok()?.get(run_id).cloned()
}

pub(crate) fn for_run(run_id: Option<&str>) -> GatewayJournal {
    run_id
        .and_then(get)
        .map(GatewayJournal::Durable)
        .unwrap_or(GatewayJournal::Disabled)
}

pub(crate) fn unregister(run_id: &str) {
    if let Ok(mut registry) = journal_registry().lock() {
        registry.remove(run_id);
    }
}

fn prepare_event(event: AgentExecutionEvent) -> (&'static str, Option<usize>, Value) {
    let (kind, round, payload) = event.into_parts();
    let mut payload = redact_json_value(payload);
    if let Value::Object(object) = &mut payload {
        object.insert("schema_version".to_string(), Value::from(1));
    } else {
        payload = serde_json::json!({"schema_version": 1, "value": payload});
    }
    (kind, round, payload)
}

pub(crate) fn redact_json_value(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_prompt_text(&text)),
        Value::Array(values) => Value::Array(values.into_iter().map(redact_json_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    if key == "redacted" {
                        (key, Value::Bool(true))
                    } else if sensitive_json_key(&key) {
                        (key, Value::String("[REDACTED]".to_string()))
                    } else {
                        (key, redact_json_value(value))
                    }
                })
                .collect(),
        ),
        other => other,
    }
}

fn sensitive_json_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().replace('-', "_").as_str(),
        "api_key"
            | "apikey"
            | "authorization"
            | "access_token"
            | "refresh_token"
            | "oauth_token"
            | "token"
            | "password"
            | "secret"
            | "pin"
            | "cvv"
            | "private_key"
    )
}

fn redact_prompt_text(text: &str) -> String {
    let mut output = crate::strip_terminal_control_sequences(&redact_data_urls(text));
    let earliest = [
        "sk-",
        "sk_proj_",
        "token=",
        "api_key=",
        "access_token=",
        "refresh_token=",
        "Authorization:",
        "Bearer ",
        "password=",
        "secret=",
        "pin=",
        "cvv=",
    ]
    .into_iter()
    .filter_map(|marker| {
        output
            .to_lowercase()
            .find(&marker.to_lowercase())
            .map(|index| (index, marker.len()))
    })
    .min_by_key(|(index, _)| *index);
    if let Some((index, marker_len)) = earliest {
        output.truncate(index + marker_len);
        output.push_str("[REDACTED]");
    }
    output
}

fn redact_data_urls(text: &str) -> String {
    let mut output = text.to_string();
    loop {
        let Some(start) = output.find("data:") else {
            break;
        };
        let Some(relative_comma) = output[start..].find(";base64,") else {
            break;
        };
        let body_start = start + relative_comma + ";base64,".len();
        let body_end = output[body_start..]
            .find(|character: char| character.is_whitespace() || matches!(character, '"' | '\''))
            .map(|offset| body_start + offset)
            .unwrap_or(output.len());
        output.replace_range(start..body_end, "[DATA_URL_REDACTED]");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use local_first_engine::{AgentExecutionEvent, build_prompt_snapshot};
    use local_first_task_runtime::NewAgentRun;
    use serde_json::json;

    #[test]
    fn persisted_prompt_payload_is_redacted_and_keeps_data_url_metadata_only() {
        let snapshot = build_prompt_snapshot(
            "model",
            "provider",
            &[json!({
                "role": "user",
                "content": "Authorization: Bearer secret-token api_key=sk-test data:image/png;base64,QUJD"
            })],
            &[],
            false,
            None,
        );
        let (_, _, payload) =
            prepare_event(AgentExecutionEvent::PromptSnapshot { round: 1, snapshot });
        let encoded = serde_json::to_string(&payload).unwrap();
        assert!(!encoded.contains("secret-token"));
        assert!(!encoded.contains("sk-test"));
        assert!(!encoded.contains("QUJD"));
        assert!(encoded.contains("[REDACTED]"));
    }

    #[test]
    fn nested_strings_are_redacted_without_reordering_arrays() {
        let value = json!({"items": ["first", "token=abc", "third"]});
        let redacted = redact_json_value(value);
        assert_eq!(redacted["items"][0], "first");
        assert_eq!(redacted["items"][2], "third");
        assert_ne!(redacted["items"][1], "token=abc");
    }

    #[test]
    fn sensitive_json_keys_are_redacted_even_when_the_value_has_no_marker() {
        let value = json!({
            "api_key": "plain-value",
            "nested": {"refresh_token": "another-value", "safe": "kept"}
        });
        let redacted = redact_json_value(value);
        assert_eq!(redacted["api_key"], "[REDACTED]");
        assert_eq!(redacted["nested"]["refresh_token"], "[REDACTED]");
        assert_eq!(redacted["nested"]["safe"], "kept");
    }

    #[test]
    fn flush_persists_all_accepted_events_before_returning() {
        let path = std::env::temp_dir().join(format!(
            "homun-agent-journal-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = TaskStore::open(&path).unwrap();
        store
            .create_agent_run(&NewAgentRun {
                run_id: "run-test".to_string(),
                turn_id: "turn-test".to_string(),
                thread_id: "thread-test".to_string(),
                user_id: "u".to_string(),
                workspace_id: "w".to_string(),
                model: None,
                provider: None,
                prompt_fingerprint: None,
            })
            .unwrap();
        drop(store);

        let journal = GatewayExecutionJournal::start("run-test".to_string(), path.clone()).unwrap();
        journal.record(AgentExecutionEvent::RunCompleted {
            reason: "test".to_string(),
        });
        assert!(journal.flush());

        let store = TaskStore::open(&path).unwrap();
        let events = store
            .list_agent_run_events("run-test", "u", "w", None)
            .unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["run_started", "run_completed"]
        );
        drop(store);
        drop(journal);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn close_and_flush_rejects_late_events() {
        let path = std::env::temp_dir().join(format!(
            "homun-agent-journal-close-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = TaskStore::open(&path).unwrap();
        store
            .create_agent_run(&NewAgentRun {
                run_id: "run-close".to_string(),
                turn_id: "turn-close".to_string(),
                thread_id: "thread-close".to_string(),
                user_id: "u".to_string(),
                workspace_id: "w".to_string(),
                model: None,
                provider: None,
                prompt_fingerprint: None,
            })
            .unwrap();
        drop(store);

        let journal =
            GatewayExecutionJournal::start("run-close".to_string(), path.clone()).unwrap();
        journal.record(AgentExecutionEvent::RunAborted {
            reason: "cancelled".to_string(),
        });
        assert!(journal.close_and_flush());
        journal.record(AgentExecutionEvent::RunCompleted {
            reason: "late".to_string(),
        });
        assert_eq!(journal.dropped_events(), 1);

        let store = TaskStore::open(&path).unwrap();
        let events = store
            .list_agent_run_events("run-close", "u", "w", None)
            .unwrap();
        assert_eq!(
            events
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["run_started", "run_aborted"]
        );
        drop(store);
        drop(journal);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn unavailable_store_is_counted_as_dropped_observability() {
        let root = std::env::temp_dir().join(format!(
            "homun-agent-journal-missing-parent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let journal = GatewayExecutionJournal::start(
            "run-unavailable".to_string(),
            root.join("missing").join("journal.sqlite"),
        )
        .unwrap();

        journal.record(AgentExecutionEvent::RunFailed {
            reason: "test".to_string(),
        });
        assert!(journal.close_and_flush());
        assert_eq!(journal.dropped_events(), 1);
    }
}
