use crate::{
    LogBuffer, LogEntry, LogStream, ProcessKind, ProcessManagerError, ProcessManagerResult,
    ProcessSnapshot, ProcessSpec, ProcessStatus, RestartPolicy,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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
    kind: ProcessKind,
    handle: ProcessHandle,
}

/// Either a directly-managed child or one watched by a restart monitor.
enum ProcessHandle {
    Direct {
        child: Child,
        logs: Arc<Mutex<LogBuffer>>,
        exit_code: Option<i32>,
    },
    Monitored(MonitorHandle),
}

/// Shared state between the supervisor and the background restart monitor.
struct MonitorShared {
    pid: Option<u32>,
    status: ProcessStatus,
    exit_code: Option<i32>,
    restart_count: u32,
    logs: Arc<Mutex<LogBuffer>>,
}

/// Handle to a background restart monitor thread.
struct MonitorHandle {
    shared: Arc<Mutex<MonitorShared>>,
    shutdown: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
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
            let logs = match &state.handle {
                ProcessHandle::Direct { logs, .. } => Arc::clone(logs),
                ProcessHandle::Monitored(monitor) => {
                    let shared = monitor.shared.lock().map_err(|_| {
                        ProcessManagerError::InvalidSpec("monitor state lock poisoned".to_string())
                    })?;
                    Arc::clone(&shared.logs)
                }
            };
            return Ok(logs
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
        match &mut state.handle {
            ProcessHandle::Direct {
                child, exit_code, ..
            } => match child.try_wait()? {
                Some(status) => {
                    *exit_code = status.code();
                    let mut snapshot =
                        ProcessSnapshot::new(id, state.kind.clone(), ProcessStatus::Exited);
                    snapshot.pid = Some(child.id());
                    snapshot.exit_code = *exit_code;
                    Ok(snapshot)
                }
                None => Ok(
                    ProcessSnapshot::new(id, state.kind.clone(), ProcessStatus::Running)
                        .with_pid(child.id()),
                ),
            },
            ProcessHandle::Monitored(monitor) => {
                let shared = monitor.shared.lock().map_err(|_| {
                    ProcessManagerError::InvalidSpec("monitor state lock poisoned".to_string())
                })?;
                let mut snapshot = ProcessSnapshot::new(id, state.kind.clone(), shared.status);
                snapshot.pid = shared.pid;
                snapshot.exit_code = shared.exit_code;
                snapshot.restart_count = shared.restart_count;
                Ok(snapshot)
            }
        }
    }
}

impl Default for LocalProcessSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for LocalProcessSupervisor {
    fn drop(&mut self) {
        for state in self.children.values_mut() {
            if let ProcessHandle::Monitored(monitor) = &mut state.handle {
                monitor.shutdown.store(true, Ordering::Relaxed);
                if let Some(handle) = monitor.join.take() {
                    let _ = handle.join();
                }
            }
        }
    }
}

impl ProcessSupervisor for LocalProcessSupervisor {
    fn start(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot> {
        // Idempotency: if the process is already running (or restarting), return its snapshot.
        if let Some(state) = self.children.get_mut(&spec.id) {
            let snapshot = Self::snapshot_for_state(&spec.id, state)?;
            if snapshot.status == ProcessStatus::Running
                || snapshot.status == ProcessStatus::Restarting
            {
                return Ok(snapshot);
            }
            self.children.remove(&spec.id);
        }

        match &spec.restart_policy {
            RestartPolicy::Disabled => self.start_direct(spec),
            RestartPolicy::Bounded { .. } => self.start_monitored(spec),
        }
    }

    fn stop(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot> {
        let Some(mut state) = self.children.remove(&spec.id) else {
            return Ok(ProcessSnapshot::new(
                &spec.id,
                spec.kind.clone(),
                ProcessStatus::Stopped,
            ));
        };
        match &mut state.handle {
            ProcessHandle::Direct { child, .. } => match child.try_wait()? {
                Some(_status) => {}
                None => {
                    child.kill()?;
                    let _ = child.wait();
                }
            },
            ProcessHandle::Monitored(monitor) => {
                monitor.shutdown.store(true, Ordering::Relaxed);
                if let Some(handle) = monitor.join.take() {
                    let _ = handle.join();
                }
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

/// Non-restart path: spawn a child and manage it directly (original behaviour).
impl LocalProcessSupervisor {
    fn start_direct(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot> {
        let (child, logs) =
            spawn_child(spec, self.log_dir.as_deref(), self.persistent_log_capacity)?;
        let pid = child.id();
        self.children.insert(
            spec.id.clone(),
            LocalProcessState {
                kind: spec.kind.clone(),
                handle: ProcessHandle::Direct {
                    child,
                    logs,
                    exit_code: None,
                },
            },
        );
        Ok(ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Running).with_pid(pid))
    }

    /// Restart path: spawn a child, then launch a background monitor thread.
    fn start_monitored(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot> {
        let (child, logs) =
            spawn_child(spec, self.log_dir.as_deref(), self.persistent_log_capacity)?;
        let pid = child.id();
        let shared = Arc::new(Mutex::new(MonitorShared {
            pid: Some(pid),
            status: ProcessStatus::Running,
            exit_code: None,
            restart_count: 0,
            logs: Arc::clone(&logs),
        }));
        let shutdown = Arc::new(AtomicBool::new(false));

        let monitor_shared = Arc::clone(&shared);
        let monitor_shutdown = Arc::clone(&shutdown);
        let monitor_spec = spec.clone();
        let monitor_log_dir = self.log_dir.clone();
        let monitor_capacity = self.persistent_log_capacity;

        let join = thread::spawn(move || {
            run_restart_monitor(
                monitor_spec,
                monitor_log_dir,
                monitor_capacity,
                child,
                monitor_shared,
                monitor_shutdown,
            );
        });

        self.children.insert(
            spec.id.clone(),
            LocalProcessState {
                kind: spec.kind.clone(),
                handle: ProcessHandle::Monitored(MonitorHandle {
                    shared,
                    shutdown,
                    join: Some(join),
                }),
            },
        );

        Ok(ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Running).with_pid(pid))
    }
}

/// Spawn a child process with piped stdio and log readers attached.
///
/// Extracted from `start` so both the direct and monitored code paths share
/// the same spawning logic.
fn spawn_child(
    spec: &ProcessSpec,
    log_dir: Option<&Path>,
    persistent_log_capacity: usize,
) -> ProcessManagerResult<(Child, Arc<Mutex<LogBuffer>>)> {
    let mut command = Command::new(&spec.command);
    command.args(&spec.args);
    command.envs(&spec.env);
    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command.spawn()?;
    let logs = Arc::new(Mutex::new(LogBuffer::new(spec.log_capacity)));
    let persistent_log = log_dir
        .map(|dir| {
            fs::create_dir_all(dir)?;
            Ok::<_, std::io::Error>(Arc::new(Mutex::new(PersistentLogFile {
                path: persistent_log_path(dir, &spec.id),
                capacity: persistent_log_capacity,
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

    Ok((child, logs))
}

/// Background monitor thread for auto-restart.
///
/// Owns the current child handle and polls `try_wait` every 50 ms.  When the
/// process exits unexpectedly (non-zero code or signal kill) the monitor
/// applies exponential backoff and respawns the child up to `max_restarts`
/// times.  A clean exit (code 0) or an intentional shutdown (the `shutdown`
/// flag) stops the loop without respawning.
fn run_restart_monitor(
    spec: ProcessSpec,
    log_dir: Option<PathBuf>,
    persistent_log_capacity: usize,
    mut child: Child,
    shared: Arc<Mutex<MonitorShared>>,
    shutdown: Arc<AtomicBool>,
) {
    let mut restart_count: u32 = 0;
    let mut started_at = Instant::now();
    let poll_interval = Duration::from_millis(50);

    // The initial child was already spawned by `start_monitored`; shared state
    // is already set to Running with the correct pid.

    loop {
        // ── Phase 1: poll the current child until it exits or shutdown is signalled.
        let exit_code = loop {
            if shutdown.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                set_status(&shared, ProcessStatus::Stopped, None, None);
                return;
            }

            match child.try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => thread::sleep(poll_interval),
                Err(_) => {
                    set_status(&shared, ProcessStatus::Failed, None, None);
                    return;
                }
            }
        };

        // ── Phase 2: decide whether to restart.

        // Clean exit (code 0) — do not restart.
        let unexpected = exit_code.map(|c| c != 0).unwrap_or(true);
        if !unexpected {
            set_status(&shared, ProcessStatus::Exited, exit_code, None);
            return;
        }

        // Extract restart parameters from the policy.
        let (max_restarts, backoff_ms, backoff_max_ms, uptime_reset_ms) = match &spec.restart_policy
        {
            RestartPolicy::Bounded {
                max_restarts,
                backoff_ms,
                backoff_max_ms,
                uptime_reset_ms,
            } => (
                *max_restarts,
                *backoff_ms,
                *backoff_max_ms,
                *uptime_reset_ms,
            ),
            // Should not happen (monitor only started for Bounded), but guard anyway.
            RestartPolicy::Disabled => {
                set_status(&shared, ProcessStatus::Exited, exit_code, None);
                return;
            }
        };

        // Reset restart counter if the process ran long enough.
        let uptime = started_at.elapsed();
        if uptime_reset_ms > 0 && uptime >= Duration::from_millis(uptime_reset_ms) {
            restart_count = 0;
        }

        // Exhausted restart attempts — give up.
        if restart_count >= max_restarts {
            if let Ok(mut guard) = shared.lock() {
                guard.status = ProcessStatus::Failed;
                guard.exit_code = exit_code;
                guard.restart_count = restart_count;
                guard.pid = None;
            }
            return;
        }

        // ── Phase 3: backoff sleep, then respawn.

        // Exponential backoff: backoff_ms * 2^attempt, capped at backoff_max_ms.
        let multiplier = 1u64.checked_shl(restart_count).unwrap_or(u64::MAX);
        let delay_ms = backoff_ms.saturating_mul(multiplier).min(backoff_max_ms);

        // Update shared state to Restarting.
        {
            if let Ok(mut guard) = shared.lock() {
                guard.status = ProcessStatus::Restarting;
                guard.restart_count = restart_count;
                guard.pid = None;
            }
        }

        // Sleep in small chunks so shutdown stays responsive.
        let sleep_end = Instant::now() + Duration::from_millis(delay_ms);
        while Instant::now() < sleep_end {
            if shutdown.load(Ordering::Relaxed) {
                set_status(&shared, ProcessStatus::Stopped, exit_code, None);
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }

        // Check shutdown again after the full sleep.
        if shutdown.load(Ordering::Relaxed) {
            set_status(&shared, ProcessStatus::Stopped, exit_code, None);
            return;
        }

        restart_count += 1;

        // Spawn the replacement child.
        match spawn_child(&spec, log_dir.as_deref(), persistent_log_capacity) {
            Ok((new_child, new_logs)) => {
                child = new_child;
                started_at = Instant::now();
                let new_pid = child.id();
                if let Ok(mut guard) = shared.lock() {
                    guard.pid = Some(new_pid);
                    guard.status = ProcessStatus::Running;
                    guard.restart_count = restart_count;
                    guard.logs = new_logs;
                }
                // Continue the outer loop to poll the new child.
            }
            Err(_) => {
                if let Ok(mut guard) = shared.lock() {
                    guard.status = ProcessStatus::Failed;
                    guard.exit_code = exit_code;
                    guard.restart_count = restart_count;
                    guard.pid = None;
                }
                return;
            }
        }
    }
}

/// Convenience helper to set the shared status, optionally the exit code,
/// and clear the pid for terminal states.
fn set_status(
    shared: &Arc<Mutex<MonitorShared>>,
    status: ProcessStatus,
    exit_code: Option<i32>,
    pid: Option<u32>,
) {
    if let Ok(mut guard) = shared.lock() {
        guard.status = status;
        if exit_code.is_some() {
            guard.exit_code = exit_code;
        }
        if pid.is_some() {
            guard.pid = pid;
        } else if matches!(
            status,
            ProcessStatus::Stopped | ProcessStatus::Exited | ProcessStatus::Failed
        ) {
            guard.pid = None;
        }
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
