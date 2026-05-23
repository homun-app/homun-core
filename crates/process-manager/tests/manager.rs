use local_first_process_manager::{
    FakeProcessSupervisor, HealthCheck, ProcessKind, ProcessManager, ProcessRegistryStore,
    ProcessSpec, ProcessStatus,
};

#[test]
fn manager_registers_starts_checks_health_and_stops_processes() {
    let store = ProcessRegistryStore::open_in_memory().unwrap();
    let supervisor = FakeProcessSupervisor::default();
    let mut manager = ProcessManager::new(store, supervisor);
    let spec = ProcessSpec::new("browser", ProcessKind::BrowserSidecar, "node")
        .with_health_check(HealthCheck::ProcessAlive);

    manager.register(spec).unwrap();
    let started = manager.start("browser").unwrap();
    assert_eq!(started.status, ProcessStatus::Running);
    assert_eq!(started.pid, Some(10_001));

    let health = manager.check_health("browser").unwrap();
    assert_eq!(health.status, ProcessStatus::Healthy);
    assert_eq!(health.message.as_deref(), Some("process alive"));

    let stopped = manager.stop("browser").unwrap();
    assert_eq!(stopped.status, ProcessStatus::Stopped);

    let detail = manager.detail("browser").unwrap().unwrap();
    assert_eq!(detail.snapshot.status, ProcessStatus::Stopped);
}
