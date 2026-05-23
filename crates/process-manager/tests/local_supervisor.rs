use local_first_process_manager::{
    LocalProcessSupervisor, LogStream, ProcessKind, ProcessSpec, ProcessStatus, ProcessSupervisor,
};
use std::{thread::sleep, time::Duration};

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
    assert!(logs.iter().any(|entry| entry.stream == LogStream::Stdout && entry.line == "hello stdout"));
    assert!(logs.iter().any(|entry| entry.stream == LogStream::Stderr && entry.line == "hello stderr"));
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
