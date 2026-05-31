use local_first_process_manager::{
    HealthCheck, ProcessKind, ProcessSpec, ProcessStatus, RestartPolicy,
};

#[test]
fn process_spec_serializes_stable_contracts() {
    let spec = ProcessSpec::new(
        "llm-runtime",
        ProcessKind::LlmRuntime,
        ".venv/bin/python",
    )
    .with_arg("runtimes/llm/server.py")
    .with_env("PYTHONUNBUFFERED", "1")
    .with_cwd("/tmp/workspace")
    .with_health_check(HealthCheck::HttpGet {
        url: "http://127.0.0.1:8765/health".to_string(),
        timeout_ms: 500,
    })
    .with_restart_policy(RestartPolicy::Bounded {
        max_restarts: 3,
        backoff_ms: 250,
    });

    let json = serde_json::to_value(&spec).unwrap();

    assert_eq!(json["id"], "llm-runtime");
    assert_eq!(json["kind"], "llm_runtime");
    assert_eq!(json["command"], ".venv/bin/python");
    assert_eq!(
        json["args"],
        serde_json::json!(["runtimes/llm/server.py"])
    );
    assert_eq!(json["env"]["PYTHONUNBUFFERED"], "1");
    assert_eq!(json["cwd"], "/tmp/workspace");
    assert_eq!(json["health_check"]["type"], "http_get");
    assert_eq!(json["restart_policy"]["type"], "bounded");
}

#[test]
fn process_status_serializes_for_ui() {
    assert_eq!(
        serde_json::to_value(ProcessStatus::Healthy).unwrap(),
        "healthy"
    );
    assert_eq!(
        serde_json::to_value(ProcessKind::BrowserSidecar).unwrap(),
        "browser_sidecar"
    );
}
