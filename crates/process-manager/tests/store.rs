use local_first_process_manager::{
    HealthCheck, ProcessKind, ProcessRegistryStore, ProcessSnapshot, ProcessSpec, ProcessStatus,
};

#[test]
fn store_creates_schema_and_round_trips_specs_and_snapshots() {
    let store = ProcessRegistryStore::open_in_memory().unwrap();
    let spec = ProcessSpec::new("browser", ProcessKind::BrowserSidecar, "node")
        .with_arg("src/server.ts")
        .with_health_check(HealthCheck::ProcessAlive);

    store.upsert_spec(&spec).unwrap();
    let loaded = store.get_spec("browser").unwrap().unwrap();
    assert_eq!(loaded, spec);

    let snapshot = ProcessSnapshot::new("browser", ProcessKind::BrowserSidecar, ProcessStatus::Healthy)
        .with_pid(1234)
        .with_message("ready");
    store.record_snapshot(&snapshot).unwrap();

    let loaded_snapshot = store.latest_snapshot("browser").unwrap().unwrap();
    assert_eq!(loaded_snapshot.process_id, "browser");
    assert_eq!(loaded_snapshot.status, ProcessStatus::Healthy);
    assert_eq!(loaded_snapshot.pid, Some(1234));
    assert_eq!(loaded_snapshot.message.as_deref(), Some("ready"));

    let specs = store.list_specs().unwrap();
    assert_eq!(specs, vec![spec]);
}
