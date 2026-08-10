use local_first_process_manager::{
    LocalProcessSupervisor, ProcessKind, ProcessSpec, ProcessStatus, ProcessSupervisor,
    RestartPolicy,
};
use std::thread::sleep;
use std::time::{Duration, Instant};

/// Poll `snapshot` until it returns a status matching `want`, or `timeout` elapses.
fn wait_for_status(
    supervisor: &mut LocalProcessSupervisor,
    spec: &ProcessSpec,
    want: ProcessStatus,
    timeout: Duration,
) -> Option<local_first_process_manager::ProcessSnapshot> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(snap) = supervisor.snapshot(spec)
            && snap.status == want
        {
            return Some(snap);
        }
        if Instant::now() >= deadline {
            return None;
        }
        sleep(Duration::from_millis(25));
    }
}

fn crash_spec(id: &str, policy: RestartPolicy) -> ProcessSpec {
    ProcessSpec::new(id, ProcessKind::Other, "sh")
        .with_arg("-c")
        .with_arg("exit 1")
        .with_restart_policy(policy)
}

// ---------------------------------------------------------------------------
// Test 1: process with a Bounded restart policy restarts on crash.
// ---------------------------------------------------------------------------

#[test]
fn bounded_policy_restarts_on_crash() {
    let mut supervisor = LocalProcessSupervisor::new();
    let spec = crash_spec(
        "restart-on-crash",
        RestartPolicy::Bounded {
            max_restarts: 3,
            backoff_ms: 20,
            backoff_max_ms: 200,
            uptime_reset_ms: 0,
        },
    );

    let started = supervisor.start(&spec).unwrap();
    assert_eq!(started.status, ProcessStatus::Running);
    let original_pid = started.pid.expect("started should have a pid");

    // The process exits immediately (exit 1).  The monitor should detect
    // the crash, wait the backoff, and respawn.  We poll until we see
    // Running again with a *different* pid.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut restarted = false;
    while Instant::now() < deadline {
        if let Ok(snap) = supervisor.snapshot(&spec)
            && snap.status == ProcessStatus::Running
            && snap.pid != Some(original_pid)
        {
            assert!(snap.pid.is_some(), "restarted process should have a pid");
            restarted = true;
            break;
        }
        sleep(Duration::from_millis(25));
    }
    assert!(
        restarted,
        "process should have been restarted with a new pid"
    );

    let _ = supervisor.stop(&spec);
}

// ---------------------------------------------------------------------------
// Test 2: process with Disabled policy does NOT restart (backward compat).
// ---------------------------------------------------------------------------

#[test]
fn disabled_policy_does_not_restart() {
    let mut supervisor = LocalProcessSupervisor::new();
    let spec = crash_spec("no-restart", RestartPolicy::Disabled);

    let started = supervisor.start(&spec).unwrap();
    assert_eq!(started.status, ProcessStatus::Running);

    // Wait for the process to exit.  It should show Exited and stay Exited
    // (no restart).
    let exited = wait_for_status(
        &mut supervisor,
        &spec,
        ProcessStatus::Exited,
        Duration::from_secs(3),
    );
    assert!(exited.is_some(), "process should exit");

    // Give the monitor a brief window in case a restart *would* have happened.
    sleep(Duration::from_millis(200));

    let snap = supervisor.snapshot(&spec).unwrap();
    assert_eq!(
        snap.status,
        ProcessStatus::Exited,
        "process should still be Exited — no auto-restart with Disabled policy"
    );

    let _ = supervisor.stop(&spec);
}

// ---------------------------------------------------------------------------
// Test 3: max restarts limit is respected.
// ---------------------------------------------------------------------------

#[test]
fn max_restarts_limit_is_respected() {
    let mut supervisor = LocalProcessSupervisor::new();
    let max_restarts = 2u32;
    let spec = crash_spec(
        "max-restarts",
        RestartPolicy::Bounded {
            max_restarts,
            backoff_ms: 10,
            backoff_max_ms: 50,
            uptime_reset_ms: 0,
        },
    );

    supervisor.start(&spec).unwrap();

    // With max_restarts=2 the process is started 3 times total (1 initial +
    // 2 restarts), each crashing immediately.  After the third crash the
    // monitor should give up and set the status to Failed.
    let failed = wait_for_status(
        &mut supervisor,
        &spec,
        ProcessStatus::Failed,
        Duration::from_secs(5),
    );
    assert!(
        failed.is_some(),
        "process should reach Failed after exhausting restarts"
    );

    let snap = failed.unwrap();
    assert_eq!(snap.restart_count, max_restarts);

    let _ = supervisor.stop(&spec);
}

// ---------------------------------------------------------------------------
// Test 4: backoff timing is correct (exponential, capped).
// ---------------------------------------------------------------------------

#[test]
fn backoff_timing_is_applied_between_restarts() {
    let mut supervisor = LocalProcessSupervisor::new();
    // First-attempt backoff = 200 ms (200 * 2^0).
    let backoff_ms = 200u64;
    let spec = crash_spec(
        "backoff-timing",
        RestartPolicy::Bounded {
            max_restarts: 1,
            backoff_ms,
            backoff_max_ms: 5_000,
            uptime_reset_ms: 0,
        },
    );

    supervisor.start(&spec).unwrap();

    // Wait until the monitor sets the status to Restarting (process has
    // crashed and the backoff clock has started).
    let restarting = wait_for_status(
        &mut supervisor,
        &spec,
        ProcessStatus::Restarting,
        Duration::from_secs(3),
    );
    assert!(restarting.is_some(), "should observe Restarting status");
    let restart_start = Instant::now();

    // Wait until the process is Running again (backoff elapsed + respawn).
    let running = wait_for_status(
        &mut supervisor,
        &spec,
        ProcessStatus::Running,
        Duration::from_secs(3),
    );
    assert!(running.is_some(), "should observe Running after backoff");
    let elapsed = restart_start.elapsed();

    // The backoff for attempt 0 is backoff_ms * 2^0 = backoff_ms.
    // Allow a tolerance window: at least 60 % of the configured backoff,
    // at most 3× (covers poll + scheduling jitter).
    let lower = Duration::from_millis((backoff_ms * 6) / 10);
    let upper = Duration::from_millis(backoff_ms * 3);
    assert!(
        elapsed >= lower && elapsed <= upper,
        "backoff elapsed {:?} should be within [{:?}, {:?}]",
        elapsed,
        lower,
        upper
    );

    let _ = supervisor.stop(&spec);
}

// ---------------------------------------------------------------------------
// Test 5: restart counter resets after a successful long-running period.
// ---------------------------------------------------------------------------

#[test]
fn restart_counter_resets_after_long_uptime() {
    let mut supervisor = LocalProcessSupervisor::new();
    // max_restarts=1 → without the uptime reset, only 1 restart is possible
    // before the process reaches Failed.  With uptime_reset_ms=200 and the
    // process running ~350 ms between crashes, the counter resets each time
    // so it never exhausts.  Seeing ≥ 2 restarts proves the reset works
    // (without it, at most 1 restart can occur).
    let spec = ProcessSpec::new("uptime-reset", ProcessKind::Other, "sh")
        .with_arg("-c")
        .with_arg("sleep 0.35; exit 1")
        .with_restart_policy(RestartPolicy::Bounded {
            max_restarts: 1,
            backoff_ms: 20,
            backoff_max_ms: 100,
            uptime_reset_ms: 200,
        });

    supervisor.start(&spec).unwrap();

    // Each cycle takes ~350 ms uptime + ~20 ms backoff + ~50 ms poll overhead
    // ≈ ~420 ms.  2 cycles ≈ 840 ms; we allow 8 seconds for headroom on slow
    // schedulers (macOS CI).
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut restarts_seen: u32 = 0;
    let mut last_status = ProcessStatus::Running;
    while Instant::now() < deadline {
        if let Ok(snap) = supervisor.snapshot(&spec) {
            // Count transitions into Running that follow a Restarting
            // (i.e. actual restarts, not the initial start).
            if snap.status == ProcessStatus::Running && last_status == ProcessStatus::Restarting {
                restarts_seen += 1;
                if restarts_seen >= 2 {
                    break;
                }
            }
            last_status = snap.status;

            // If the process ever goes Failed, the reset is broken.
            assert_ne!(
                snap.status,
                ProcessStatus::Failed,
                "process should not reach Failed — uptime reset should keep it alive"
            );
        }
        sleep(Duration::from_millis(50));
    }
    assert!(
        restarts_seen >= 2,
        "should observe at least 2 restarts with uptime reset; saw {restarts_seen}"
    );

    let _ = supervisor.stop(&spec);
}

// ---------------------------------------------------------------------------
// Test 6: clean exit (code 0) does not trigger a restart.
// ---------------------------------------------------------------------------

#[test]
fn clean_exit_does_not_restart() {
    let mut supervisor = LocalProcessSupervisor::new();
    let spec = ProcessSpec::new("clean-exit", ProcessKind::Other, "sh")
        .with_arg("-c")
        .with_arg("exit 0")
        .with_restart_policy(RestartPolicy::Bounded {
            max_restarts: 3,
            backoff_ms: 10,
            backoff_max_ms: 50,
            uptime_reset_ms: 0,
        });

    supervisor.start(&spec).unwrap();

    let exited = wait_for_status(
        &mut supervisor,
        &spec,
        ProcessStatus::Exited,
        Duration::from_secs(3),
    );
    assert!(exited.is_some(), "clean exit should produce Exited status");

    // Wait a bit to make sure no restart fires.
    sleep(Duration::from_millis(200));

    let snap = supervisor.snapshot(&spec).unwrap();
    assert_eq!(
        snap.status,
        ProcessStatus::Exited,
        "clean exit should not trigger auto-restart"
    );
    assert_eq!(snap.exit_code, Some(0));

    let _ = supervisor.stop(&spec);
}

// ---------------------------------------------------------------------------
// Test 7: signal kill triggers a restart (non-zero / signal exit).
// ---------------------------------------------------------------------------

#[test]
fn signal_killed_process_restarts() {
    let mut supervisor = LocalProcessSupervisor::new();
    // Start a long-running process, then kill it externally (simulating a
    // crash).  The monitor should detect the signal exit and restart.
    let spec = ProcessSpec::new("signal-kill", ProcessKind::Other, "sh")
        .with_arg("-c")
        .with_arg("sleep 10")
        .with_restart_policy(RestartPolicy::Bounded {
            max_restarts: 3,
            backoff_ms: 20,
            backoff_max_ms: 100,
            uptime_reset_ms: 0,
        });

    let started = supervisor.start(&spec).unwrap();
    assert_eq!(started.status, ProcessStatus::Running);
    let original_pid = started.pid.expect("should have pid");

    // Kill the process externally using the `kill` command (SIGKILL).
    // On macOS / Linux `kill -9 <pid>` works.
    std::process::Command::new("kill")
        .arg("-9")
        .arg(original_pid.to_string())
        .spawn()
        .expect("kill command should start")
        .wait()
        .expect("kill should complete");

    // The monitor should detect the signal exit and restart.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut restarted = false;
    while Instant::now() < deadline {
        if let Ok(snap) = supervisor.snapshot(&spec)
            && snap.status == ProcessStatus::Running
            && snap.pid != Some(original_pid)
        {
            restarted = true;
            break;
        }
        sleep(Duration::from_millis(25));
    }
    assert!(restarted, "signal-killed process should be restarted");

    let _ = supervisor.stop(&spec);
}

// ---------------------------------------------------------------------------
// Test 8: logs are accessible for a monitored (restartable) process.
// ---------------------------------------------------------------------------

#[test]
fn monitored_process_logs_are_accessible() {
    let mut supervisor = LocalProcessSupervisor::new();
    let spec = ProcessSpec::new("monitored-logs", ProcessKind::Other, "sh")
        .with_arg("-c")
        .with_arg("printf 'hello from sidecar\\n'; exit 1")
        .with_restart_policy(RestartPolicy::Bounded {
            max_restarts: 1,
            backoff_ms: 10,
            backoff_max_ms: 50,
            uptime_reset_ms: 0,
        });

    supervisor.start(&spec).unwrap();

    // Give the log reader thread time to capture the line.
    sleep(Duration::from_millis(100));

    let logs = supervisor.logs("monitored-logs").unwrap();
    assert!(
        logs.iter()
            .any(|entry| entry.line.contains("hello from sidecar")),
        "should capture stdout from monitored process"
    );

    let _ = supervisor.stop(&spec);
}
