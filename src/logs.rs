use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

const LOG_STREAM_CAPACITY: usize = 2048;
const LOG_HISTORY_LIMIT: usize = 5000;

/// Profile/user context for scoping log records.
/// Set via [`TASK_PROFILE_SCOPE.scope()`] in the agent loop; read by [`SseLogLayer`].
#[derive(Debug, Clone)]
pub struct ProfileScope {
    pub profile_id: Option<i64>,
    pub user_id: Option<String>,
}

tokio::task_local! {
    /// Task-local profile scope. Survives `.await` and thread migration —
    /// tied to the tokio task, not the OS thread.
    pub static TASK_PROFILE_SCOPE: ProfileScope;
    /// Task-local trace ID (OBS-2). Set by the HTTP middleware from the
    /// `X-Request-ID` header (or freshly generated), and by each non-HTTP
    /// channel (CLI/Telegram/Discord/Slack/WhatsApp/Email) when it dispatches
    /// a message to the agent gateway. Survives `.await` and thread migration.
    ///
    /// Read by [`SseLogLayer`] to populate `LogRecord::trace_id`, and by
    /// [`crate::agent::request_trace::RequestTracer`] to unify the tracer ID
    /// with the HTTP-visible trace ID.
    pub static TASK_TRACE_ID: String;
}

/// Read the current profile scope (if any) from the task-local.
fn current_profile_scope() -> Option<ProfileScope> {
    TASK_PROFILE_SCOPE.try_with(|s| s.clone()).ok()
}

/// Read the current trace ID (if any) from the task-local.
///
/// Returns `None` when called outside a `TASK_TRACE_ID.scope(...)` context —
/// e.g. during gateway startup, background cron ticks, or tests without
/// explicit scoping. Callers that need a trace ID should generate their own
/// fallback if this returns `None`.
pub fn current_trace_id() -> Option<String> {
    TASK_TRACE_ID.try_with(|s| s.clone()).ok()
}

/// Generate a new short trace ID: 8 hex chars from a random UUID.
///
/// Short enough to fit comfortably in HTTP headers, JSON log fields, and UI
/// tooltips while still carrying ~10^9 bits of entropy — safe for any single
/// Homun instance across its lifetime.
pub fn new_trace_id() -> String {
    uuid::Uuid::new_v4()
        .to_string()
        .chars()
        .take(8)
        .collect::<String>()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogFieldRecord {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogRecord {
    pub timestamp: String,
    pub level: String,
    pub target: String,
    pub message: String,
    pub module_path: Option<String>,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub fields: Vec<LogFieldRecord>,
    /// Profile scoping — populated when log originates from a profile-scoped context.
    /// Currently None; requires tracing span propagation to populate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<i64>,
    /// User scoping — populated when log originates from an authenticated context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// Trace ID for the request that produced this log (OBS-2).
    ///
    /// Populated from [`TASK_TRACE_ID`] when the log is emitted inside a
    /// scoped context. Allows UI timeline + API clients to correlate all
    /// log records for a single user request end-to-end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
}

static LOG_STREAM: OnceLock<broadcast::Sender<LogRecord>> = OnceLock::new();

fn log_stream() -> &'static broadcast::Sender<LogRecord> {
    LOG_STREAM.get_or_init(|| {
        let (tx, _rx) = broadcast::channel(LOG_STREAM_CAPACITY);
        tx
    })
}

pub fn subscribe() -> broadcast::Receiver<LogRecord> {
    log_stream().subscribe()
}

fn log_state_dir() -> PathBuf {
    if let Ok(path) = std::env::var("HOMUN_LOG_STATE_DIR") {
        return PathBuf::from(path);
    }

    crate::config::Config::data_dir().join("logs")
}

fn log_history_path() -> PathBuf {
    log_state_dir().join("events.jsonl")
}

fn persist_record(record: &LogRecord) {
    let path = log_history_path();
    if let Some(parent) = path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            eprintln!(
                "[homun-logs] Failed to create logs directory {}: {}",
                parent.display(),
                err
            );
            return;
        }
    }

    let line = match serde_json::to_string(record) {
        Ok(line) => line,
        Err(err) => {
            eprintln!("[homun-logs] Failed to serialize log record: {}", err);
            return;
        }
    };

    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut file) => {
            if writeln!(file, "{line}").is_err() {
                eprintln!(
                    "[homun-logs] Failed to append log record to {}",
                    path.display()
                );
                return;
            }
        }
        Err(err) => {
            eprintln!(
                "[homun-logs] Failed to open log history file {}: {}",
                path.display(),
                err
            );
            return;
        }
    }

    if let Ok(metadata) = fs::metadata(&path) {
        if metadata.len() > 16 * 1024 * 1024 {
            trim_log_history_file(&path, LOG_HISTORY_LIMIT / 2);
        }
    }
}

fn trim_log_history_file(path: &std::path::Path, keep_last: usize) {
    let records = read_recent_records(path, keep_last);
    let file = match OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
    {
        Ok(file) => file,
        Err(err) => {
            eprintln!(
                "[homun-logs] Failed to trim log history file {}: {}",
                path.display(),
                err
            );
            return;
        }
    };

    let mut writer = std::io::BufWriter::new(file);
    for record in records {
        let line = match serde_json::to_string(&record) {
            Ok(line) => line,
            Err(err) => {
                eprintln!(
                    "[homun-logs] Failed to serialize trimmed log record: {}",
                    err
                );
                continue;
            }
        };
        if writeln!(writer, "{line}").is_err() {
            eprintln!(
                "[homun-logs] Failed to write trimmed log record to {}",
                path.display()
            );
            return;
        }
    }
}

fn read_recent_records(path: &std::path::Path, limit: usize) -> Vec<LogRecord> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };

    let mut records = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(record) = serde_json::from_str::<LogRecord>(trimmed) {
            records.push(record);
        }
    }

    let keep = limit.min(LOG_HISTORY_LIMIT);
    if records.len() > keep {
        records.drain(0..(records.len() - keep));
    }
    records
}

pub fn recent(limit: usize) -> Vec<LogRecord> {
    read_recent_records(&log_history_path(), limit.max(1))
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SseLogLayer;

impl<S> Layer<S> for SseLogLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let mut visitor = LogFieldVisitor::default();
        event.record(&mut visitor);

        let extra_fields = visitor.render_extra_fields();
        let mut message = visitor.message.take().unwrap_or_default();
        if !extra_fields.is_empty() {
            if !message.is_empty() {
                message.push(' ');
            }
            message.push_str(&extra_fields);
        }
        if message.trim().is_empty() {
            message = metadata.name().to_string();
        }

        // Read profile/user context and trace ID from task-locals (set by the
        // HTTP middleware, channel dispatchers, and the agent loop).
        let scope = current_profile_scope();
        let trace_id = current_trace_id();

        let record = LogRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            level: metadata.level().as_str().to_ascii_lowercase(),
            target: metadata.target().to_string(),
            message,
            module_path: metadata.module_path().map(ToString::to_string),
            file: metadata.file().map(ToString::to_string),
            line: metadata.line(),
            fields: visitor.extra_fields,
            profile_id: scope.as_ref().and_then(|s| s.profile_id),
            user_id: scope.and_then(|s| s.user_id),
            trace_id,
        };

        persist_record(&record);
        let _ = log_stream().send(record);
    }
}

#[derive(Default)]
struct LogFieldVisitor {
    message: Option<String>,
    extra_fields: Vec<LogFieldRecord>,
}

impl LogFieldVisitor {
    fn push_field(&mut self, key: &str, value: String) {
        if key == "message" {
            self.message = Some(value);
        } else {
            self.extra_fields.push(LogFieldRecord {
                key: key.to_string(),
                value,
            });
        }
    }

    fn render_extra_fields(&self) -> String {
        self.extra_fields
            .iter()
            .map(|field| format!("{}={}", field.key, field.value))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

impl Visit for LogFieldVisitor {
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.push_field(field.name(), value.to_string());
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.push_field(field.name(), value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.push_field(field.name(), value.to_string());
    }

    fn record_i128(&mut self, field: &Field, value: i128) {
        self.push_field(field.name(), value.to_string());
    }

    fn record_u128(&mut self, field: &Field, value: u128) {
        self.push_field(field.name(), value.to_string());
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.push_field(field.name(), value.to_string());
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.push_field(field.name(), value.to_string());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.push_field(field.name(), format!("{value:?}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn trace_id_scope_round_trip() {
        // Outside any scope, current_trace_id returns None.
        assert_eq!(current_trace_id(), None);

        // Inside a scope, current_trace_id returns the scoped value.
        let result = TASK_TRACE_ID
            .scope("abc12345".to_string(), async {
                let inner = current_trace_id();
                // Survives .await yield
                tokio::task::yield_now().await;
                let after_yield = current_trace_id();
                (inner, after_yield)
            })
            .await;
        assert_eq!(result.0.as_deref(), Some("abc12345"));
        assert_eq!(result.1.as_deref(), Some("abc12345"));

        // Outside again — task-local is dropped.
        assert_eq!(current_trace_id(), None);
    }

    #[test]
    fn new_trace_id_is_short_and_unique() {
        let a = new_trace_id();
        let b = new_trace_id();
        assert_eq!(a.len(), 8);
        assert_eq!(b.len(), 8);
        assert_ne!(a, b, "trace IDs should not collide across two calls");
        // All hex chars
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }

    #[test]
    fn recent_logs_round_trip_from_custom_dir() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::env::set_var("HOMUN_LOG_STATE_DIR", temp.path());

        persist_record(&LogRecord {
            timestamp: "2026-03-06T10:00:00Z".to_string(),
            level: "info".to_string(),
            target: "homun.test".to_string(),
            message: "hello".to_string(),
            module_path: Some("homun::test".to_string()),
            file: Some("src/test.rs".to_string()),
            line: Some(42),
            fields: vec![LogFieldRecord {
                key: "chat_id".to_string(),
                value: "abc".to_string(),
            }],
            profile_id: None,
            user_id: None,
            trace_id: None,
        });

        let records = recent(10);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].message, "hello");
        assert_eq!(records[0].fields.len(), 1);

        std::env::remove_var("HOMUN_LOG_STATE_DIR");
    }
}
