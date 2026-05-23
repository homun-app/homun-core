use crate::{BrowserAutomationError, BrowserRequest, BrowserResult};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};

pub struct BrowserSidecarSession {
    child: Child,
    stdin: ChildStdin,
}

impl BrowserSidecarSession {
    pub fn spawn(command: &str, args: &[&str]) -> BrowserResult<Self> {
        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|error| BrowserAutomationError::Sidecar(error.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| BrowserAutomationError::Sidecar("missing sidecar stdin".to_string()))?;
        Ok(Self { child, stdin })
    }

    pub fn send(&mut self, request: &BrowserRequest) -> BrowserResult<String> {
        let stdout =
            self.child.stdout.as_mut().ok_or_else(|| {
                BrowserAutomationError::Sidecar("missing sidecar stdout".to_string())
            })?;
        writeln!(
            self.stdin,
            "{}",
            serde_json::to_string(request)
                .map_err(|error| BrowserAutomationError::InvalidRequest(error.to_string()))?
        )
        .map_err(|error| BrowserAutomationError::Sidecar(error.to_string()))?;
        self.stdin
            .flush()
            .map_err(|error| BrowserAutomationError::Sidecar(error.to_string()))?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|error| BrowserAutomationError::Sidecar(error.to_string()))?;
        Ok(line)
    }
}

impl Drop for BrowserSidecarSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
