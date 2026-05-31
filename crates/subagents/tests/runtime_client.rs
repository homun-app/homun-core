use local_first_subagents::{
    GenerateJsonResponse, GenerateRequest, GenerateResponse, GenerateStreamEvent,
    IntentClassifyRequest, RuntimeClient, RuntimeWarmupResponse, TokenMetrics,
};

#[test]
fn runtime_client_builds_local_endpoint_without_double_slashes() {
    let client = RuntimeClient::new("http://127.0.0.1:8765/");

    assert_eq!(
        client.endpoint("/generate_json"),
        "http://127.0.0.1:8765/generate_json"
    );
    assert_eq!(
        client.endpoint("/classify_intent"),
        "http://127.0.0.1:8765/classify_intent"
    );
    assert_eq!(
        client.endpoint("/generate"),
        "http://127.0.0.1:8765/generate"
    );
    assert_eq!(
        client.endpoint("/generate_stream"),
        "http://127.0.0.1:8765/generate_stream"
    );
    assert_eq!(client.endpoint("/warmup"), "http://127.0.0.1:8765/warmup");
}

#[test]
fn generate_request_serializes_as_plain_chat_payload() {
    let request = GenerateRequest {
        prompt: "Ciao, spiegami cosa sai fare.".to_string(),
        max_tokens: 512,
        temperature: 0.2,
        wait_if_busy: true,
        request_timeout_seconds: Some(120.0),
        request_id: None,
    };

    let value = serde_json::to_value(request).unwrap();

    assert_eq!(value["prompt"], "Ciao, spiegami cosa sai fare.");
    assert_eq!(value["max_tokens"], 512);
    assert!((value["temperature"].as_f64().unwrap() - 0.2).abs() < 0.001);
    assert!(value.get("schema").is_none());
    assert!(value.get("required_keys").is_none());
    assert!(value.get("repair").is_none());
}

#[test]
fn generate_response_deserializes_plain_text_and_metrics() {
    let response: GenerateResponse = serde_json::from_value(serde_json::json!({
        "text": "Risposta semplice.",
        "metrics": {
            "prompt_tokens": 12,
            "generation_tokens": 4,
            "prompt_tps": 100.0,
            "generation_tps": 20.0,
            "peak_memory_gb": 5.4,
            "elapsed_seconds": 0.8
        }
    }))
    .unwrap();

    assert_eq!(response.text, "Risposta semplice.");
    assert_eq!(response.metrics.generation_tokens, 4);
}

#[test]
fn runtime_warmup_response_deserializes_loaded_state() {
    let response: RuntimeWarmupResponse = serde_json::from_value(serde_json::json!({
        "ok": true,
        "model": "local-model-v1",
        "loaded": true,
        "load_seconds": 8.947,
        "elapsed_seconds": 0.001,
        "local_first": true
    }))
    .unwrap();

    assert!(response.ok);
    assert!(response.loaded);
    assert_eq!(response.load_seconds, Some(8.947));
    assert!(response.local_first);
}

#[test]
fn generate_stream_event_deserializes_delta_and_done_payloads() {
    let delta: GenerateStreamEvent = serde_json::from_value(serde_json::json!({
        "type": "delta",
        "text": "Ciao"
    }))
    .unwrap();
    let done: GenerateStreamEvent = serde_json::from_value(serde_json::json!({
        "type": "done",
        "text": "Ciao Fabio",
        "metrics": {
            "prompt_tokens": 12,
            "generation_tokens": 4,
            "prompt_tps": 100.0,
            "generation_tps": 20.0,
            "peak_memory_gb": 5.4,
            "elapsed_seconds": 0.8
        }
    }))
    .unwrap();

    assert_eq!(
        delta,
        GenerateStreamEvent::Delta {
            text: "Ciao".to_string()
        }
    );
    assert_eq!(
        done,
        GenerateStreamEvent::Done {
            text: "Ciao Fabio".to_string(),
            metrics: TokenMetrics {
                prompt_tokens: 12,
                generation_tokens: 4,
                prompt_tps: 100.0,
                generation_tps: 20.0,
                peak_memory_gb: 5.4,
                elapsed_seconds: 0.8,
            },
        }
    );
}

#[test]
fn classify_intent_request_serializes_without_schema_or_repair_payload() {
    let request = IntentClassifyRequest {
        text: "quanto fa 6*3".to_string(),
        locale: Some("it-IT".to_string()),
        max_tokens: 96,
        wait_if_busy: true,
        request_timeout_seconds: Some(8.0),
    };

    let value = serde_json::to_value(request).unwrap();

    assert_eq!(value["text"], "quanto fa 6*3");
    assert_eq!(value["max_tokens"], 96);
    assert!(value.get("schema").is_none());
    assert!(value.get("required_keys").is_none());
    assert!(value.get("repair").is_none());
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
