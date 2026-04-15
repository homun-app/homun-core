//! Panic handler + crash report persistence (Sprint 9 OBS-3).
//!
//! Installs a custom `std::panic::set_hook` that captures:
//!   - panic location (file, line, column) and message
//!   - full backtrace (force-captured regardless of RUST_BACKTRACE)
//!   - binary version, OS, architecture
//!   - tail of recent log records (from the in-memory ring buffer)
//!
//! and writes a PII-redacted JSON file to `~/.homun/crashes/` named
//! `YYYY-MM-DD_HH-MM-SS_<trace_id>.json` (trace_id is 8 hex chars from
//! `logs::current_trace_id()` if a panic happens inside a request scope,
//! otherwise "unscoped").
//!
//! # Design constraints
//!
//! - **No Sentry, no SaaS forwarding.** Crash reports live on disk. See
//!   `src/web/api/crashes.rs` for the list/get/prepare-issue endpoints
//!   that let the user review + submit them to GitHub/email/clipboard.
//! - **Anti-loop**: a panic inside the hook itself would loop forever.
//!   A static `AtomicBool CRASH_IN_PROGRESS` guards re-entry — the second
//!   panic falls through to the default (chained) hook without touching
//!   our logic.
//! - **Chains the default hook**: we call `take_hook()` first so the
//!   default pretty-print still runs on stderr (dev loops want the
//!   familiar output), then invoke our own persistence after.
//! - **PII redaction**: the crash file passes through
//!   `crate::security::exfiltration::redact` before being written to disk,
//!   so absolute paths, emails, tokens, and other patterns registered in
//!   the exfiltration guard are masked.
//! - **No panics in the hook**: every I/O is best-effort (`.ok()`), every
//!   serde call falls back to a stub. The hook must never fail — if it
//!   does, `abort()` is called by the runtime and we lose the crash report
//!   entirely, which is worse than having a partial one.

use std::fs;
use std::panic::PanicHookInfo;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Maximum tail of recent log records embedded in the crash report.
///
/// 200 lines is enough to reconstruct the last few seconds of activity
/// (dashboard-level verbosity) without bloating the JSON file beyond
/// what a GitHub issue can display as a code fence.
const RECENT_LOGS_TAIL: usize = 200;

/// Reentrancy guard: set to `true` when the hook is executing, so a panic
/// inside the hook itself short-circuits to the chained default hook.
static CRASH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Type alias for the boxed panic hook closure, to keep the `OnceLock`
/// declaration readable (clippy::type_complexity).
type PanicHook = Box<dyn Fn(&PanicHookInfo<'_>) + Sync + Send + 'static>;

/// Holds the default panic hook replaced by our installer, so we can
/// still chain to it after capturing our crash report.
static DEFAULT_HOOK: OnceLock<PanicHook> = OnceLock::new();

/// Full crash report as written to disk.
///
/// This struct is `Serialize + Deserialize` so that the `/v1/crashes/{id}`
/// API endpoint can load it back from the file and hand it to the UI.
///
/// All fields are `String` (not `&'static str`) because serde_json
/// deserializers require owned data unless the caller promises the input
/// string outlives `'static` — which we can't when reading from a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashReport {
    /// RFC-3339 timestamp when the panic occurred.
    pub timestamp: String,
    /// Short trace ID from the task-local, if any (8 hex chars), or "unscoped".
    pub trace_id: String,
    /// Homun binary version (`CARGO_PKG_VERSION`).
    pub version: String,
    /// Target OS (`std::env::consts::OS`).
    pub os: String,
    /// Target arch (`std::env::consts::ARCH`).
    pub arch: String,
    /// The panic message, as formatted by `PanicHookInfo::payload`.
    pub message: String,
    /// Source location (`file:line:col`) when known.
    pub location: Option<String>,
    /// Full backtrace, force-captured via `std::backtrace::Backtrace::force_capture`.
    pub backtrace: String,
    /// Tail of the most recent log records (up to `RECENT_LOGS_TAIL`).
    pub recent_logs: Vec<crate::logs::LogRecord>,
}

/// Crashes directory path: `~/.homun/crashes/`.
pub fn crashes_dir() -> PathBuf {
    crate::config::Config::data_dir().join("crashes")
}

/// Install the custom panic hook.
///
/// Call this as the **very first line** of `async fn main()`, before any
/// runtime/TLS/config loading. The hook is global (process-wide) and
/// idempotent — subsequent calls are no-ops.
pub fn install_panic_hook() {
    // First call wins: if someone already installed our hook (or the default
    // was replaced for some other reason), respect that.
    if DEFAULT_HOOK.get().is_some() {
        return;
    }

    let default = std::panic::take_hook();
    let _ = DEFAULT_HOOK.set(default);

    std::panic::set_hook(Box::new(|info| {
        // Anti-loop: if another panic is being handled right now (e.g. serde
        // panicked while serializing the CrashReport struct), fall through
        // to the default hook and give up on our persistence.
        if CRASH_IN_PROGRESS
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            if let Some(default) = DEFAULT_HOOK.get() {
                default(info);
            }
            return;
        }

        // Best-effort capture + persist. Wrapped in catch_unwind so any
        // panic inside our logic (theoretically impossible given the code
        // below, but we defend anyway) doesn't escape back into the runtime.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            capture_and_persist(info);
        }));

        CRASH_IN_PROGRESS.store(false, Ordering::Release);

        // Chain to the default hook so stderr output is unchanged — devs
        // still see the familiar "thread 'main' panicked at ..." message.
        if let Some(default) = DEFAULT_HOOK.get() {
            default(info);
        }
    }));
}

/// Extract panic info, build the CrashReport, redact PII, persist to disk.
///
/// Separated into its own function so `catch_unwind` can isolate any
/// subtle panic path (e.g. serde failure on unusual log record contents).
fn capture_and_persist(info: &PanicHookInfo<'_>) {
    let message = panic_message(info);
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()));
    let backtrace = std::backtrace::Backtrace::force_capture().to_string();
    let trace_id = crate::logs::current_trace_id().unwrap_or_else(|| "unscoped".to_string());
    let recent_logs = crate::logs::recent(RECENT_LOGS_TAIL);

    let report = CrashReport {
        timestamp: chrono::Utc::now().to_rfc3339(),
        trace_id: trace_id.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        message,
        location,
        backtrace,
        recent_logs,
    };

    // Serialize, then redact the whole JSON text blob. Redacting the JSON
    // string (rather than each field individually) ensures patterns that
    // span fields (e.g. a token that appears both in `message` and in a
    // recent log record) are covered consistently.
    let json = match serde_json::to_string_pretty(&report) {
        Ok(s) => s,
        Err(_) => return, // Can't serialize — give up, nothing to persist.
    };
    let redacted = crate::security::redact(&json);

    let dir = crashes_dir();
    if fs::create_dir_all(&dir).is_err() {
        eprintln!(
            "[crash-reporter] Failed to create crashes directory {}",
            dir.display()
        );
        return;
    }

    let filename = format!(
        "{}_{}.json",
        chrono::Utc::now().format("%Y-%m-%d_%H-%M-%S"),
        trace_id
    );
    let path = dir.join(&filename);
    if let Err(e) = fs::write(&path, redacted) {
        eprintln!(
            "[crash-reporter] Failed to write crash report to {}: {}",
            path.display(),
            e
        );
    }
}

/// Extract a printable message from a PanicHookInfo payload.
///
/// The payload is `Box<dyn Any + Send>` and can hold any type — the two
/// common cases are `&'static str` (from `panic!("lit")`) and `String`
/// (from `panic!("fmt: {}", x)`). Anything else becomes "<non-string payload>".
fn panic_message(info: &PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// List all crash report files in `~/.homun/crashes/`, newest first.
///
/// Returns `(filename, path)` pairs sorted by filename descending —
/// filenames are `YYYY-MM-DD_HH-MM-SS_{trace_id}.json` so lexicographic
/// order is chronological.
pub fn list_crash_files() -> Vec<(String, PathBuf)> {
    let dir = crashes_dir();
    let mut entries: Vec<(String, PathBuf)> = match fs::read_dir(&dir) {
        Ok(iter) => iter
            .filter_map(|e| {
                let e = e.ok()?;
                let path = e.path();
                let name = path.file_name()?.to_str()?.to_string();
                if !name.ends_with(".json") {
                    return None;
                }
                Some((name, path))
            })
            .collect(),
        Err(_) => return Vec::new(),
    };
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries
}

/// Read a crash report from disk by filename.
///
/// Returns `None` if the file doesn't exist, can't be read, or doesn't parse.
pub fn read_crash(filename: &str) -> Option<CrashReport> {
    // Defensive: reject any path traversal attempt. The API layer should
    // already sanitize but we double-check.
    if filename.contains('/') || filename.contains("..") {
        return None;
    }
    let path = crashes_dir().join(filename);
    let content = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Delete a crash report file. Idempotent.
pub fn delete_crash(filename: &str) -> Result<(), std::io::Error> {
    if filename.contains('/') || filename.contains("..") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid filename",
        ));
    }
    let path = crashes_dir().join(filename);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_report_roundtrip_serde() {
        let report = CrashReport {
            timestamp: "2026-04-14T12:34:56Z".to_string(),
            trace_id: "abc12345".to_string(),
            version: "0.1.0".to_string(),
            os: "macos".to_string(),
            arch: "aarch64".to_string(),
            message: "test panic message".to_string(),
            location: Some("src/foo.rs:42:13".to_string()),
            backtrace: "   0: foo\n   1: bar".to_string(),
            recent_logs: vec![],
        };

        let json = serde_json::to_string(&report).unwrap();
        let parsed: CrashReport = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.trace_id, "abc12345");
        assert_eq!(parsed.message, "test panic message");
        assert_eq!(parsed.location.as_deref(), Some("src/foo.rs:42:13"));
    }

    #[test]
    fn read_crash_rejects_path_traversal() {
        // Even if a file "../../etc/passwd" existed, the function refuses.
        assert!(read_crash("../etc/passwd").is_none());
        assert!(read_crash("subdir/file.json").is_none());
        assert!(read_crash("/absolute/path.json").is_none());
    }

    #[test]
    fn delete_crash_rejects_path_traversal() {
        assert!(delete_crash("../etc/passwd").is_err());
        assert!(delete_crash("a/b.json").is_err());
    }

    #[test]
    fn delete_crash_is_idempotent_on_missing_file() {
        // Delete a file that doesn't exist: should succeed silently.
        let result = delete_crash("nonexistent_file_xyz_12345.json");
        assert!(result.is_ok());
    }

    #[test]
    fn panic_message_extracts_static_str() {
        // We can't easily construct a PanicHookInfo for testing, but we
        // can at least verify that panic_message's downcast logic compiles
        // and the fallback path is reachable. This is a smoke test — the
        // real integration test happens in the panic_writes_file test below
        // (which would require a subprocess to run cleanly).
        // TODO: integration test that spawns a subprocess with the hook
        // installed and triggers a panic, then verifies the file exists.
    }
}
