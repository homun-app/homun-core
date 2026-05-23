use local_first_process_manager::{
    HealthCheck, HealthProbe, HealthProbeResult, ProcessKind, ProcessSnapshot, ProcessSpec,
    ProcessStatus, evaluate_health,
};

struct FakeProbe {
    ok: bool,
}

impl HealthProbe for FakeProbe {
    fn http_get(&self, _url: &str, _timeout_ms: u64) -> HealthProbeResult {
        if self.ok {
            HealthProbeResult::healthy("http ok")
        } else {
            HealthProbeResult::unhealthy("http failed")
        }
    }
}

#[test]
fn health_check_uses_process_alive_for_running_status() {
    let spec = ProcessSpec::new("browser", ProcessKind::BrowserSidecar, "node")
        .with_health_check(HealthCheck::ProcessAlive);
    let snapshot = ProcessSnapshot::new("browser", ProcessKind::BrowserSidecar, ProcessStatus::Running);

    let result = evaluate_health(&spec, &snapshot, &FakeProbe { ok: false });

    assert!(result.healthy);
    assert_eq!(result.message, "process alive");
}

#[test]
fn health_check_delegates_http_get_to_probe() {
    let spec = ProcessSpec::new("llm", ProcessKind::LlmRuntime, "python")
        .with_health_check(HealthCheck::HttpGet {
            url: "http://127.0.0.1:8765/health".to_string(),
            timeout_ms: 500,
        });
    let snapshot = ProcessSnapshot::new("llm", ProcessKind::LlmRuntime, ProcessStatus::Running);

    let result = evaluate_health(&spec, &snapshot, &FakeProbe { ok: true });

    assert!(result.healthy);
    assert_eq!(result.message, "http ok");
}
