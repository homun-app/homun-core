use local_first_process_manager::{
    LocalProcessSupervisor, LogStream, ProcessKind, ProcessSpec, ProcessStatus, ProcessSupervisor,
};
use std::{fs, thread::sleep, time::Duration};

#[test]
fn local_supervisor_spawns_captures_logs_and_observes_exit() {
    let mut supervisor = LocalProcessSupervisor::new();
    let spec = ProcessSpec::new("fixture", ProcessKind::Other, "sh")
        .with_arg("-c")
        .with_arg("printf 'hello stdout\\n'; printf 'hello stderr\\n' >&2");

    let started = supervisor.start(&spec).unwrap();
    assert_eq!(started.status, ProcessStatus::Running);
    assert!(started.pid.is_some());

    let mut snapshot = supervisor.snapshot(&spec).unwrap();
    for _ in 0..20 {
        if snapshot.status == ProcessStatus::Exited {
            break;
        }
        sleep(Duration::from_millis(25));
        snapshot = supervisor.snapshot(&spec).unwrap();
    }

    assert_eq!(snapshot.status, ProcessStatus::Exited);
    assert_eq!(snapshot.exit_code, Some(0));

    let logs = supervisor.logs("fixture").unwrap();
    assert!(
        logs.iter()
            .any(|entry| entry.stream == LogStream::Stdout && entry.line == "hello stdout")
    );
    assert!(
        logs.iter()
            .any(|entry| entry.stream == LogStream::Stderr && entry.line == "hello stderr")
    );
}

#[test]
fn local_supervisor_start_is_idempotent_while_running() {
    let mut supervisor = LocalProcessSupervisor::new();
    let spec = ProcessSpec::new("sleep", ProcessKind::Other, "sh")
        .with_arg("-c")
        .with_arg("sleep 1");

    let first = supervisor.start(&spec).unwrap();
    let second = supervisor.start(&spec).unwrap();

    assert_eq!(first.pid, second.pid);
    assert_eq!(second.status, ProcessStatus::Running);
    let stopped = supervisor.stop(&spec).unwrap();
    assert_eq!(stopped.status, ProcessStatus::Stopped);
}

#[test]
fn local_supervisor_persists_redacted_logs_with_retention() {
    let log_dir = std::env::temp_dir().join(format!(
        "local-first-process-manager-logs-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&log_dir);
    let mut supervisor = LocalProcessSupervisor::new().with_log_dir(&log_dir, 2);
    let spec = ProcessSpec::new("fixture/persist", ProcessKind::Other, "sh")
        .with_arg("-c")
        .with_arg("printf 'one\\n'; printf 'token=abc123\\n'; printf 'three\\n'");

    supervisor.start(&spec).unwrap();
    let mut snapshot = supervisor.snapshot(&spec).unwrap();
    for _ in 0..20 {
        if snapshot.status == ProcessStatus::Exited {
            break;
        }
        sleep(Duration::from_millis(25));
        snapshot = supervisor.snapshot(&spec).unwrap();
    }

    let restarted = LocalProcessSupervisor::new().with_log_dir(&log_dir, 2);
    let logs = restarted.logs("fixture/persist").unwrap();

    assert_eq!(logs.len(), 2);
    assert_eq!(logs[0].line, "token=[REDACTED]");
    assert_eq!(logs[1].line, "three");
    let log_file = log_dir.join("fixture_persist.jsonl");
    let persisted = fs::read_to_string(log_file).unwrap();
    assert!(!persisted.contains("abc123"));
    let _ = fs::remove_dir_all(&log_dir);
}
