use crate::{BrowserAutomationError, BrowserRequest, BrowserResult};
use std::cell::RefCell;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

pub struct BrowserSidecarSession {
    child: RefCell<Child>,
    stdin: RefCell<ChildStdin>,
    stdout: RefCell<ChildStdout>,
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
        Ok(Self {
            child: RefCell::new(child),
            stdin: RefCell::new(stdin),
            stdout: RefCell::new(stdout),
        })
    }

    pub fn send(&self, request: &BrowserRequest) -> BrowserResult<String> {
        writeln!(
            self.stdin.borrow_mut(),
            "{}",
            serde_json::to_string(request)
                .map_err(|error| BrowserAutomationError::InvalidRequest(error.to_string()))?
        )
        .map_err(|error| BrowserAutomationError::Sidecar(error.to_string()))?;
        self.stdin
            .borrow_mut()
            .flush()
            .map_err(|error| BrowserAutomationError::Sidecar(error.to_string()))?;
        let mut stdout = self.stdout.borrow_mut();
        let mut reader = BufReader::new(&mut *stdout);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|error| BrowserAutomationError::Sidecar(error.to_string()))?;
        Ok(line)
    }
}

impl crate::BrowserTransport for BrowserSidecarSession {
    fn send(&self, request: &BrowserRequest) -> BrowserResult<String> {
        self.send(request)
    }
}

impl Drop for BrowserSidecarSession {
    fn drop(&mut self) {
        let mut child = self.child.borrow_mut();
        let _ = child.kill();
        let _ = child.wait();
    }
}
