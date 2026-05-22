use local_first_subagents::{GenerateJsonResponse, RuntimeClient, TokenMetrics};

#[test]
fn runtime_client_builds_local_endpoint_without_double_slashes() {
    let client = RuntimeClient::new("http://127.0.0.1:8765/");

    assert_eq!(
        client.endpoint("/generate_json"),
        "http://127.0.0.1:8765/generate_json"
    );
}

#[test]
fn generate_json_response_deserializes_runtime_metrics() {
    let response: GenerateJsonResponse = serde_json::from_value(serde_json::json!({
        "valid": true,
        "errors": [],
        "json": {"ok": true},
        "raw_output": "{\"ok\": true}",
        "repaired": false,
        "metrics": {
            "prompt_tokens": 10,
            "generation_tokens": 5,
            "prompt_tps": 100.0,
            "generation_tps": 25.0,
            "peak_memory_gb": 5.3,
            "elapsed_seconds": 1.2
        }
    }))
    .unwrap();

    assert!(response.valid);
    assert_eq!(response.json["ok"], true);
    assert_eq!(
        response.metrics,
        TokenMetrics {
            prompt_tokens: 10,
            generation_tokens: 5,
            prompt_tps: 100.0,
            generation_tps: 25.0,
            peak_memory_gb: 5.3,
            elapsed_seconds: 1.2,
        }
    );
}
