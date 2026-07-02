//! Panic trail for the gateway process (P0, docs/confronto-codex-produzione.md).
//!
//! WHY: the gateway has no panic hook — a panic in a non-tokio thread (or an
//! abort-on-panic future) kills the process leaving zero trace once the shell
//! stops inheriting stdio. This hook appends the panic message + backtrace to
//! `~/.homun/logs/panic.log` and drops a `last-crash.json` marker the shell
//! (or a future startup notice) can read. It never panics itself and never
//! blocks: logging must not be the thing that takes the process down.

use std::backtrace::Backtrace;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Render one panic to a self-contained log entry. Kept pure for testability.
/// Timestamps are epoch seconds on purpose: no chrono dependency in the
/// workspace, and the shell-side logs already carry ISO timestamps.
fn render_panic_entry(info: &std::panic::PanicHookInfo<'_>, at_epoch_secs: u64) -> String {
    let message = info
        .payload()
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "<non-string panic payload>".to_string());
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "<unknown location>".to_string());
    format!(
        "=== panic at epoch {at_epoch_secs} ===\nmessage: {message}\nlocation: {location}\nbacktrace:\n{}\n",
        Backtrace::force_capture()
    )
}

fn append_panic_log(logs_dir: &Path, entry: &str) {
    let _ = std::fs::create_dir_all(logs_dir);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("panic.log"))
    {
        let _ = file.write_all(entry.as_bytes());
    }
}

fn write_crash_marker(logs_dir: &Path, info: &std::panic::PanicHookInfo<'_>, at_epoch_secs: u64) {
    let message = info
        .payload()
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_default();
    let marker = serde_json::json!({ "at": at_epoch_secs, "message": message });
    let _ = std::fs::write(
        logs_dir.join("last-crash.json"),
        serde_json::to_vec_pretty(&marker).unwrap_or_default(),
    );
}

/// Install the process-wide panic hook. Call once, first thing in `main()`.
pub fn install(logs_dir: PathBuf) {
    std::panic::set_hook(Box::new(move |info| {
        let at = epoch_secs();
        let entry = render_panic_entry(info, at);
        // stderr first (visible in dev / captured by the shell's gateway.log),
        // file second (survives even if the pipe is gone).
        eprintln!("{entry}");
        append_panic_log(&logs_dir, &entry);
        write_crash_marker(&logs_dir, info, at);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "homun-panic-test-{tag}-{}-{}",
            std::process::id(),
            epoch_secs()
        ));
        std::fs::create_dir_all(&dir).expect("create tmp dir");
        dir
    }

    #[test]
    fn hook_writes_panic_log_and_marker() {
        let dir = unique_tmp_dir("hook");
        install(dir.clone());
        // Panic in a scoped thread: the hook runs, the test survives.
        let _ = std::thread::spawn(|| panic!("boom for panic_log test")).join();
        // Restore the default hook so other tests' intentional panics stay quiet.
        let _ = std::panic::take_hook();

        let log = std::fs::read_to_string(dir.join("panic.log")).expect("panic.log written");
        assert!(log.contains("boom for panic_log test"));
        assert!(log.contains("location:"));
        assert!(log.contains("backtrace:"));

        let marker = std::fs::read_to_string(dir.join("last-crash.json")).expect("marker written");
        assert!(marker.contains("boom for panic_log test"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
