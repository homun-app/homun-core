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

/// Extract the panic message from the payload, done in one place so the log
/// entry and the crash marker agree on wording and fallback.
fn panic_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    info.payload()
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "<non-string panic payload>".to_string())
}

/// Render one panic to a self-contained log entry. PURE over primitives so it
/// is testable without installing the process-wide hook (installing it in a
/// test would hijack every other parallel test's panic). Timestamps are epoch
/// seconds on purpose: no chrono dependency in the workspace, and the
/// shell-side logs already carry ISO timestamps.
fn render_panic_entry(message: &str, location: &str, backtrace: &str, at_epoch_secs: u64) -> String {
    format!(
        "=== panic at epoch {at_epoch_secs} ===\nmessage: {message}\nlocation: {location}\nbacktrace:\n{backtrace}\n"
    )
}

/// Serialize the crash marker. PURE (returns bytes) so the shape is unit-
/// testable without touching the filesystem and the writer stays trivial.
fn render_crash_marker(message: &str, at_epoch_secs: u64) -> Vec<u8> {
    let marker = serde_json::json!({ "at": at_epoch_secs, "message": message });
    serde_json::to_vec_pretty(&marker).unwrap_or_default()
}

fn append_panic_log(logs_dir: &Path, entry: &str) {
    let _ = std::fs::create_dir_all(logs_dir);
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    // WHY 0600 at creation: `install()` runs BEFORE main()'s umask(0o077), so a
    // panic in that startup window could otherwise create this file world-
    // readable. It can hold sensitive strings and ships in the feedback bundle
    // (caposaldo #3) — force owner-only regardless of umask ordering.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    if let Ok(mut file) = opts.open(logs_dir.join("panic.log")) {
        let _ = file.write_all(entry.as_bytes());
    }
}

fn write_crash_marker(logs_dir: &Path, bytes: &[u8]) {
    let _ = std::fs::create_dir_all(logs_dir);
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    // WHY 0600: same as append_panic_log — owner-only independent of umask
    // ordering, because the marker carries the panic message and ships in the
    // feedback bundle (caposaldo #3).
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    if let Ok(mut file) = opts.open(logs_dir.join("last-crash.json")) {
        let _ = file.write_all(bytes);
    }
}

/// Install the process-wide panic hook. Call once, first thing in `main()`.
pub fn install(logs_dir: PathBuf) {
    std::panic::set_hook(Box::new(move |info| {
        let at = epoch_secs();
        let message = panic_message(info);
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        let backtrace = Backtrace::force_capture().to_string();
        let entry = render_panic_entry(&message, &location, &backtrace, at);
        // stderr first (visible in dev / captured by the shell's gateway.log),
        // file second (survives even if the pipe is gone).
        eprintln!("{entry}");
        append_panic_log(&logs_dir, &entry);
        write_crash_marker(&logs_dir, &render_crash_marker(&message, at));
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
    fn render_entry_is_self_contained() {
        let entry = render_panic_entry("boom", "src/x.rs:1:2", "<bt>", 42);
        assert!(entry.contains("boom"));
        assert!(entry.contains("src/x.rs:1:2"));
        assert!(entry.contains("backtrace:"));
        assert!(entry.contains("<bt>"));
        assert!(entry.contains("42"));
    }

    #[test]
    fn render_marker_is_valid_json() {
        let bytes = render_crash_marker("boom", 42);
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).expect("marker is JSON");
        assert_eq!(parsed["at"], 42);
        assert_eq!(parsed["message"], "boom");
    }

    #[test]
    fn writers_persist_files_owner_only() {
        let dir = unique_tmp_dir("writers");
        append_panic_log(&dir, "entry line\n");
        write_crash_marker(&dir, &render_crash_marker("boom for panic_log test", 7));

        let log = std::fs::read_to_string(dir.join("panic.log")).expect("panic.log written");
        assert!(log.contains("entry line"));

        let marker = std::fs::read_to_string(dir.join("last-crash.json")).expect("marker written");
        assert!(marker.contains("boom for panic_log test"));

        // Files must be owner-only regardless of the current umask (0600 forced
        // at creation) — they can hold sensitive strings and ship in the bundle.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for name in ["panic.log", "last-crash.json"] {
                let mode = std::fs::metadata(dir.join(name))
                    .expect("metadata")
                    .permissions()
                    .mode();
                assert_eq!(mode & 0o777, 0o600, "{name} must be owner-only");
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    // End-to-end coverage of the REAL hook. IGNORED by default: it mutates the
    // process-wide panic hook, so running it alongside the ~435 parallel tests
    // in this binary would route their intentional panics through our hook and
    // suppress libtest's normal output — masking real regressions. Run it
    // explicitly and serially:
    //   cargo test -p local-first-desktop-gateway panic_log -- --ignored --test-threads=1
    #[test]
    #[ignore = "mutates the global panic hook; run serially with --ignored"]
    fn install_hook_writes_files_end_to_end() {
        let dir = unique_tmp_dir("hook");
        install(dir.clone());
        let _ = std::thread::spawn(|| panic!("boom for panic_log test")).join();
        // Restore the default hook so nothing else routes through ours.
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
