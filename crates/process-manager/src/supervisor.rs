use crate::{
    LogBuffer, LogEntry, LogStream, ProcessKind, ProcessManagerError, ProcessManagerResult,
    ProcessSnapshot, ProcessSpec, ProcessStatus,
};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::collections::{BTreeMap, BTreeSet};

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
            Ok(ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Running)
                .with_pid(*self.pids.get(&spec.id).unwrap_or(&10_001)))
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
        }
    }

    pub fn logs(&self, id: &str) -> ProcessManagerResult<Vec<LogEntry>> {
        let Some(state) = self.children.get(id) else {
            return Err(ProcessManagerError::NotFound(id.to_string()));
        };
        Ok(state
            .logs
            .lock()
            .map_err(|_| ProcessManagerError::InvalidSpec("log buffer lock poisoned".to_string()))?
            .entries())
    }

    fn snapshot_for_state(id: &str, state: &mut LocalProcessState) -> ProcessManagerResult<ProcessSnapshot> {
        match state.child.try_wait()? {
            Some(status) => {
                state.exit_code = status.code();
                let mut snapshot =
                    ProcessSnapshot::new(id, state.kind.clone(), ProcessStatus::Exited);
                snapshot.pid = Some(state.child.id());
                snapshot.exit_code = state.exit_code;
                Ok(snapshot)
            }
            None => Ok(ProcessSnapshot::new(id, state.kind.clone(), ProcessStatus::Running)
                .with_pid(state.child.id())),
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
        if let Some(stdout) = child.stdout.take() {
            spawn_log_reader(Arc::clone(&logs), LogStream::Stdout, stdout);
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_log_reader(Arc::clone(&logs), LogStream::Stderr, stderr);
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

fn spawn_log_reader<R>(logs: Arc<Mutex<LogBuffer>>, stream: LogStream, reader: R)
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(mut logs) = logs.lock() {
                logs.push(stream, line);
            }
        }
    });
}
