use crate::{
    LogBuffer, LogEntry, LogStream, ProcessKind, ProcessManagerError, ProcessManagerResult,
    ProcessSnapshot, ProcessSpec, ProcessStatus,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

pub trait ProcessSupervisor {
    fn start(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot>;
    fn stop(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot>;
    fn snapshot(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot>;
}

#[derive(Default)]
pub struct FakeProcessSupervisor {
    running: BTreeSet<String>,
    pids: BTreeMap<String, u32>,
    next_pid: u32,
}

impl ProcessSupervisor for FakeProcessSupervisor {
    fn start(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot> {
        if self.next_pid == 0 {
            self.next_pid = 10_001;
        }
        let pid = *self.pids.entry(spec.id.clone()).or_insert_with(|| {
            let pid = self.next_pid;
            self.next_pid += 1;
            pid
        });
        self.running.insert(spec.id.clone());
        Ok(ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Running).with_pid(pid))
    }

    fn stop(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot> {
        self.running.remove(&spec.id);
        Ok(ProcessSnapshot::new(
            &spec.id,
            spec.kind.clone(),
            ProcessStatus::Stopped,
        ))
    }

    fn snapshot(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot> {
        if self.running.contains(&spec.id) {
            Ok(
                ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Running)
                    .with_pid(*self.pids.get(&spec.id).unwrap_or(&10_001)),
            )
        } else {
            Err(ProcessManagerError::NotFound(spec.id.clone()))
        }
    }
}

pub(crate) fn configured_snapshot(spec: &ProcessSpec) -> ProcessSnapshot {
    ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Configured)
}

#[allow(dead_code)]
pub(crate) fn failed_snapshot(spec: &ProcessSpec, message: impl Into<String>) -> ProcessSnapshot {
    ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Failed).with_message(message)
}

#[allow(dead_code)]
fn _kind_used(_kind: ProcessKind) {}

pub struct LocalProcessSupervisor {
    children: BTreeMap<String, LocalProcessState>,
    log_dir: Option<PathBuf>,
    persistent_log_capacity: usize,
}

struct LocalProcessState {
    child: Child,
    kind: ProcessKind,
    logs: Arc<Mutex<LogBuffer>>,
    exit_code: Option<i32>,
}

impl LocalProcessSupervisor {
    pub fn new() -> Self {
        Self {
            children: BTreeMap::new(),
            log_dir: None,
            persistent_log_capacity: 2_000,
        }
    }

    pub fn with_log_dir(mut self, log_dir: impl Into<PathBuf>, capacity: usize) -> Self {
        self.log_dir = Some(log_dir.into());
        self.persistent_log_capacity = capacity;
        self
    }

    pub fn logs(&self, id: &str) -> ProcessManagerResult<Vec<LogEntry>> {
        if let Some(state) = self.children.get(id) {
            return Ok(state
                .logs
                .lock()
                .map_err(|_| {
                    ProcessManagerError::InvalidSpec("log buffer lock poisoned".to_string())
                })?
                .entries());
        }

        if let Some(log_dir) = &self.log_dir {
            let entries = read_persistent_log(&persistent_log_path(log_dir, id))?;
            if !entries.is_empty() {
                return Ok(entries);
            }
        }

        Err(ProcessManagerError::NotFound(id.to_string()))
    }

    fn snapshot_for_state(
        id: &str,
        state: &mut LocalProcessState,
    ) -> ProcessManagerResult<ProcessSnapshot> {
        match state.child.try_wait()? {
            Some(status) => {
                state.exit_code = status.code();
                let mut snapshot =
                    ProcessSnapshot::new(id, state.kind.clone(), ProcessStatus::Exited);
                snapshot.pid = Some(state.child.id());
                snapshot.exit_code = state.exit_code;
                Ok(snapshot)
            }
            None => Ok(
                ProcessSnapshot::new(id, state.kind.clone(), ProcessStatus::Running)
                    .with_pid(state.child.id()),
            ),
        }
    }
}

impl Default for LocalProcessSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessSupervisor for LocalProcessSupervisor {
    fn start(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot> {
        if let Some(state) = self.children.get_mut(&spec.id) {
            let snapshot = Self::snapshot_for_state(&spec.id, state)?;
            if snapshot.status == ProcessStatus::Running {
                return Ok(snapshot);
            }
            self.children.remove(&spec.id);
        }

        let mut command = Command::new(&spec.command);
        command.args(&spec.args);
        command.envs(&spec.env);
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        command.stdout(Stdio::piped()).stderr(Stdio::piped());

        let mut child = command.spawn()?;
        let logs = Arc::new(Mutex::new(LogBuffer::new(spec.log_capacity)));
        let persistent_log = self
            .log_dir
            .as_ref()
            .map(|log_dir| {
                fs::create_dir_all(log_dir)?;
                Ok::<_, std::io::Error>(Arc::new(Mutex::new(PersistentLogFile {
                    path: persistent_log_path(log_dir, &spec.id),
                    capacity: self.persistent_log_capacity,
                })))
            })
            .transpose()?;

        if let Some(stdout) = child.stdout.take() {
            spawn_log_reader(
                Arc::clone(&logs),
                persistent_log.clone(),
                LogStream::Stdout,
                stdout,
            );
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_log_reader(
                Arc::clone(&logs),
                persistent_log.clone(),
                LogStream::Stderr,
                stderr,
            );
        }

        let pid = child.id();
        self.children.insert(
            spec.id.clone(),
            LocalProcessState {
                child,
                kind: spec.kind.clone(),
                logs,
                exit_code: None,
            },
        );
        Ok(ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Running).with_pid(pid))
    }

    fn stop(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot> {
        let Some(mut state) = self.children.remove(&spec.id) else {
            return Ok(ProcessSnapshot::new(
                &spec.id,
                spec.kind.clone(),
                ProcessStatus::Stopped,
            ));
        };
        match state.child.try_wait()? {
            Some(_status) => {}
            None => {
                state.child.kill()?;
                let _ = state.child.wait();
            }
        }
        Ok(ProcessSnapshot::new(
            &spec.id,
            spec.kind.clone(),
            ProcessStatus::Stopped,
        ))
    }

    fn snapshot(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot> {
        let Some(state) = self.children.get_mut(&spec.id) else {
            return Err(ProcessManagerError::NotFound(spec.id.clone()));
        };
        Self::snapshot_for_state(&spec.id, state)
    }
}

struct PersistentLogFile {
    path: PathBuf,
    capacity: usize,
}

impl PersistentLogFile {
    fn push(&self, stream: LogStream, line: &str) -> ProcessManagerResult<()> {
        if self.capacity == 0 {
            return Ok(());
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let entry = LogEntry {
            stream,
            line: redact_sensitive_log_line(line),
        };
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(
            file,
            "{}",
            serde_json::to_string(&entry).map_err(|error| {
                ProcessManagerError::InvalidSpec(format!("serialize log entry failed: {error}"))
            })?
        )?;
        trim_persistent_log(&self.path, self.capacity)?;
        Ok(())
    }
}

fn spawn_log_reader<R>(
    logs: Arc<Mutex<LogBuffer>>,
    persistent_log: Option<Arc<Mutex<PersistentLogFile>>>,
    stream: LogStream,
    reader: R,
) where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(mut logs) = logs.lock() {
                logs.push(stream, line.clone());
            }
            if let Some(persistent_log) = &persistent_log
                && let Ok(writer) = persistent_log.lock()
            {
                let _ = writer.push(stream, &line);
            }
        }
    });
}

fn read_persistent_log(path: &Path) -> ProcessManagerResult<Vec<LogEntry>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut content = String::new();
    OpenOptions::new()
        .read(true)
        .open(path)?
        .read_to_string(&mut content)?;
    let entries = content
        .lines()
        .filter_map(|line| serde_json::from_str::<LogEntry>(line).ok())
        .collect();
    Ok(entries)
}

fn trim_persistent_log(path: &Path, capacity: usize) -> ProcessManagerResult<()> {
    let mut content = String::new();
    OpenOptions::new()
        .read(true)
        .open(path)?
        .read_to_string(&mut content)?;
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= capacity {
        return Ok(());
    }
    let retained = lines[lines.len() - capacity..].join("\n");
    fs::write(path, format!("{retained}\n"))?;
    Ok(())
}

fn persistent_log_path(log_dir: &Path, id: &str) -> PathBuf {
    let safe_id: String = id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    log_dir.join(format!("{safe_id}.jsonl"))
}

fn redact_sensitive_log_line(input: &str) -> String {
    let mut output = input.to_string();
    for marker in [
        "sk-",
        "sk_proj_",
        "token=",
        "Authorization:",
        "Bearer ",
        "password=",
        "secret=",
    ] {
        if let Some(index) = output.to_lowercase().find(&marker.to_lowercase()) {
            output.truncate(index + marker.len());
            output.push_str("[REDACTED]");
            return output;
        }
    }
    output
}
