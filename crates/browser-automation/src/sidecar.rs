use crate::{BrowserAutomationError, BrowserRequest, BrowserResult};
use std::cell::RefCell;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

/// Defensive ceiling on how long a single sidecar request may wait for its reply. Playwright's
/// own action timeouts fire well within this (the sidecar returns a `BROWSER_ACTION_TIMEOUT`
/// line, handled as recoverable) — this only trips when the SIDECAR ITSELF is wedged (crash
/// without a reply, deadlock, broken pipe), which would otherwise hang the whole turn forever.
fn browser_sidecar_timeout_secs() -> u64 {
    std::env::var("HOMUN_BROWSER_SIDECAR_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(90)
}

pub struct BrowserSidecarSession {
    child: RefCell<Child>,
    // `Option` so `Drop` can close the pipe (take + drop) before killing: the
    // sidecar treats stdin EOF as "parent gone" and shuts the browser down
    // gracefully, which avoids orphaning Chromium.
    stdin: RefCell<Option<ChildStdin>>,
    // stdout is drained on a dedicated reader thread into this channel, so `send` can wait
    // for a reply WITH a timeout instead of blocking forever on a raw pipe read.
    lines: Receiver<std::io::Result<String>>,
    timeout: Duration,
}

#[derive(Debug, Clone, Default)]
pub struct BrowserSidecarSpawnOptions {
    pub current_dir: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

impl BrowserSidecarSession {
    pub fn spawn(command: &str, args: &[&str]) -> BrowserResult<Self> {
        Self::spawn_with_options(command, args, BrowserSidecarSpawnOptions::default())
    }

    pub fn spawn_with_options(
        command: &str,
        args: &[&str],
        options: BrowserSidecarSpawnOptions,
    ) -> BrowserResult<Self> {
        let mut command = Command::new(command);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if let Some(current_dir) = options.current_dir {
            command.current_dir(current_dir);
        }
        for (key, value) in options.env {
            command.env(key, value);
        }
        let mut child = command
            .spawn()
            .map_err(|error| BrowserAutomationError::Sidecar(error.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| BrowserAutomationError::Sidecar("missing sidecar stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BrowserAutomationError::Sidecar("missing sidecar stdout".to_string()))?;
        // Drain stdout on a dedicated thread → channel. Detached: it exits on EOF (sidecar
        // closed, incl. Drop's kill) or on a read error, so no explicit join is needed.
        let (tx, lines) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // EOF — sidecar exited
                    Ok(_) => {
                        if tx.send(Ok(line)).is_err() {
                            break; // session dropped
                        }
                    }
                    Err(error) => {
                        let _ = tx.send(Err(error));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child: RefCell::new(child),
            stdin: RefCell::new(Some(stdin)),
            lines,
            timeout: Duration::from_secs(browser_sidecar_timeout_secs()),
        })
    }

    pub fn send(&self, request: &BrowserRequest) -> BrowserResult<String> {
        let payload = serde_json::to_string(request)
            .map_err(|error| BrowserAutomationError::InvalidRequest(error.to_string()))?;
        {
            let mut guard = self.stdin.borrow_mut();
            let stdin = guard.as_mut().ok_or_else(|| {
                BrowserAutomationError::Sidecar("sidecar stdin closed".to_string())
            })?;
            writeln!(stdin, "{payload}")
                .map_err(|error| BrowserAutomationError::Sidecar(error.to_string()))?;
            stdin
                .flush()
                .map_err(|error| BrowserAutomationError::Sidecar(error.to_string()))?;
        }
        // Wait for the reply WITH a timeout. A wedged sidecar (no reply) trips this instead of
        // hanging the turn forever; the browse loop then fails cleanly and the session is torn
        // down (a wedged sidecar won't recover, so this is a fatal Sidecar error, not a retry).
        match self.lines.recv_timeout(self.timeout) {
            Ok(Ok(line)) => Ok(line),
            Ok(Err(error)) => Err(BrowserAutomationError::Sidecar(error.to_string())),
            Err(RecvTimeoutError::Timeout) => Err(BrowserAutomationError::Sidecar(format!(
                "sidecar unresponsive: no reply within {}s",
                self.timeout.as_secs()
            ))),
            Err(RecvTimeoutError::Disconnected) => Err(BrowserAutomationError::Sidecar(
                "sidecar closed unexpectedly".to_string(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BrowserMethod;
    use serde_json::json;
    use std::time::Instant;

    #[test]
    fn send_times_out_when_sidecar_never_replies() {
        // `sleep` reads no stdin and writes no stdout — a stand-in for a WEDGED sidecar. The
        // request line sits in the pipe buffer with no reply; `send` must TIME OUT promptly
        // rather than block the turn forever (the regression this guards against).
        unsafe { std::env::set_var("HOMUN_BROWSER_SIDECAR_TIMEOUT_SECS", "1") };
        let session = BrowserSidecarSession::spawn("sleep", &["30"]).expect("spawn sleep");
        unsafe { std::env::remove_var("HOMUN_BROWSER_SIDECAR_TIMEOUT_SECS") };
        let request = BrowserRequest::new("req_1".to_string(), BrowserMethod::Snapshot, json!({}));
        let start = Instant::now();
        let result = session.send(&request);
        assert!(result.is_err(), "a non-replying sidecar must error, not hang");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "send must time out promptly (took {:?})",
            start.elapsed()
        );
    }
}

impl crate::BrowserTransport for BrowserSidecarSession {
    fn send(&self, request: &BrowserRequest) -> BrowserResult<String> {
        self.send(request)
    }
}

impl Drop for BrowserSidecarSession {
    fn drop(&mut self) {
        // Close stdin first: the sidecar sees EOF, shuts the browser down
        // gracefully (closing Chromium so it is not orphaned), and exits. Give
        // it a brief grace period, then force-kill only if it is still alive.
        self.stdin.borrow_mut().take();
        let mut child = self.child.borrow_mut();
        for _ in 0..30 {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}
