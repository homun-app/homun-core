use local_first_process_manager::{
    DiscoveredProcess, FakeProcessSupervisor, HealthCheck, ProcessKind, ProcessManager,
    ProcessRegistryStore, ProcessSnapshot, ProcessSpec, ProcessStatus, RuntimeControlStatus,
    RuntimeDiscoveryProbe, RuntimeResourceSnapshot,
};

#[derive(Default)]
struct FakeDiscovery {
    port_processes: Vec<DiscoveredProcess>,
    matching_processes: Vec<DiscoveredProcess>,
    resources: Option<RuntimeResourceSnapshot>,
}

impl RuntimeDiscoveryProbe for FakeDiscovery {
    fn listeners_on_port(&self, _port: u16) -> Vec<DiscoveredProcess> {
        self.port_processes.clone()
    }

    fn matching_processes(&self, _needle: &str) -> Vec<DiscoveredProcess> {
        self.matching_processes.clone()
    }

    fn resources_for_pid(&self, _pid: u32) -> Option<RuntimeResourceSnapshot> {
        self.resources.clone()
    }
}

#[test]
fn runtime_control_detects_external_listener_without_managed_snapshot() {
    let store = ProcessRegistryStore::open_in_memory().unwrap();
    let supervisor = FakeProcessSupervisor::default();
    let manager = ProcessManager::new(store, supervisor);
    manager
        .register(runtime_spec())
        .expect("register runtime spec");
    let discovery = FakeDiscovery {
        port_processes: vec![DiscoveredProcess {
            pid: 42,
            command: "python runtimes/llm/server.py".to_string(),
            cwd: Some("/workspace".to_string()),
            port: Some(8765),
        }],
        matching_processes: vec![],
        resources: Some(RuntimeResourceSnapshot {
            total_memory_mb: Some(32_768),
            available_memory_mb: Some(12_000),
            process_memory_mb: Some(5_700),
            process_cpu_percent: Some(18.5),
        }),
    };

    let snapshot = manager
        .runtime_control_snapshot("llm-runtime", &discovery)
        .unwrap();

    assert_eq!(snapshot.status, RuntimeControlStatus::ExternalRunning);
    assert_eq!(snapshot.port, Some(8765));
    assert_eq!(snapshot.port_owner.unwrap().pid, 42);
    assert_eq!(snapshot.resources.process_memory_mb, Some(5_700));
    assert_eq!(snapshot.managed.status, ProcessStatus::Configured);
}

#[test]
fn runtime_control_marks_duplicate_conflict_when_multiple_processes_exist() {
    let store = ProcessRegistryStore::open_in_memory().unwrap();
    let supervisor = FakeProcessSupervisor::default();
    let manager = ProcessManager::new(store, supervisor);
    manager.register(runtime_spec()).unwrap();
    let discovery = FakeDiscovery {
        port_processes: vec![process(10, Some(8765))],
        matching_processes: vec![process(10, Some(8765)), process(11, None)],
        resources: None,
    };

    let snapshot = manager
        .runtime_control_snapshot("llm-runtime", &discovery)
        .unwrap();

    assert_eq!(snapshot.status, RuntimeControlStatus::DuplicateConflict);
    assert_eq!(snapshot.duplicates.len(), 2);
    assert!(snapshot.message.contains("multiple"));
}

#[test]
fn runtime_restart_stops_and_starts_managed_process_with_new_snapshot() {
    let store = ProcessRegistryStore::open_in_memory().unwrap();
    let supervisor = FakeProcessSupervisor::default();
    let mut manager = ProcessManager::new(store, supervisor);
    manager.register(runtime_spec()).unwrap();

    let first = manager.start("llm-runtime").unwrap();
    let restarted = manager.restart("llm-runtime").unwrap();
    let detail = manager.detail("llm-runtime").unwrap().unwrap();

    assert_eq!(first.pid, Some(10_001));
    assert_eq!(restarted.status, ProcessStatus::Running);
    assert_eq!(restarted.pid, Some(10_001));
    assert_eq!(detail.snapshot.status, ProcessStatus::Running);
}

#[test]
fn ensure_runtime_started_starts_runtime_when_no_process_is_available() {
    let store = ProcessRegistryStore::open_in_memory().unwrap();
    let supervisor = FakeProcessSupervisor::default();
    let mut manager = ProcessManager::new(store, supervisor);
    manager.register(runtime_spec()).unwrap();

    let snapshot = manager
        .ensure_runtime_started("llm-runtime", &FakeDiscovery::default())
        .unwrap();
    let control = manager
        .runtime_control_snapshot("llm-runtime", &FakeDiscovery::default())
        .unwrap();

    assert_eq!(snapshot.status, ProcessStatus::Running);
    assert_eq!(snapshot.pid, Some(10_001));
    assert_eq!(control.managed.status, ProcessStatus::Running);
}

#[test]
fn ensure_runtime_started_reuses_external_listener_without_spawning_duplicate() {
    let store = ProcessRegistryStore::open_in_memory().unwrap();
    let supervisor = FakeProcessSupervisor::default();
    let mut manager = ProcessManager::new(store, supervisor);
    manager.register(runtime_spec()).unwrap();
    let discovery = FakeDiscovery {
        port_processes: vec![process(42, Some(8765))],
        matching_processes: vec![process(42, Some(8765))],
        resources: None,
    };

    let snapshot = manager
        .ensure_runtime_started("llm-runtime", &discovery)
        .unwrap();
    let detail = manager.detail("llm-runtime").unwrap().unwrap();

    assert_eq!(snapshot.status, ProcessStatus::Configured);
    assert_eq!(snapshot.pid, None);
    assert_eq!(detail.snapshot.status, ProcessStatus::Configured);
}

#[test]
fn ensure_runtime_started_recovers_stale_running_snapshot_without_listener() {
    let store = ProcessRegistryStore::open_in_memory().unwrap();
    let spec = runtime_spec();
    store.upsert_spec(&spec).unwrap();
    store
        .record_snapshot(
            &ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Running)
                .with_pid(42_424),
        )
        .unwrap();
    let supervisor = FakeProcessSupervisor::default();
    let mut manager = ProcessManager::new(store, supervisor);

    let snapshot = manager
        .ensure_runtime_started("llm-runtime", &FakeDiscovery::default())
        .unwrap();
    let detail = manager.detail("llm-runtime").unwrap().unwrap();

    assert_eq!(snapshot.status, ProcessStatus::Running);
    assert_ne!(snapshot.pid, Some(42_424));
    assert_eq!(snapshot.pid, Some(10_001));
    assert_eq!(detail.snapshot.pid, Some(10_001));
}

fn runtime_spec() -> ProcessSpec {
    ProcessSpec::new("llm-runtime", ProcessKind::LlmRuntime, "python")
        .with_arg("runtimes/llm/server.py")
        .with_health_check(HealthCheck::HttpGet {
            url: "http://127.0.0.1:8765/health".to_string(),
            timeout_ms: 1_000,
        })
}

fn process(pid: u32, port: Option<u16>) -> DiscoveredProcess {
    DiscoveredProcess {
        pid,
        command: "python runtimes/llm/server.py".to_string(),
        cwd: Some("/workspace".to_string()),
        port,
    }
}
