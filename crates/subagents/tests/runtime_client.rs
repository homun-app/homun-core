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
        usage: local_first_inference_usage::UsageContext::new(
            "generate-request-test",
            local_first_inference_usage::InferencePurpose::Evaluation,
            "test",
        ),
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
            redacted_user_text: None,
        }
    );
}

#[test]
fn generate_stream_event_deserializes_structured_chat_events() {
    let reasoning: GenerateStreamEvent = serde_json::from_value(serde_json::json!({
        "type": "reasoning",
        "text": "Sto verificando il piano."
    }))
    .unwrap();
    let activity: GenerateStreamEvent = serde_json::from_value(serde_json::json!({
        "type": "activity",
        "text": "Apro il browser"
    }))
    .unwrap();
    let plan_update: GenerateStreamEvent = serde_json::from_value(serde_json::json!({
        "type": "plan_update",
        "markdown": "- [x] Aprire la pagina"
    }))
    .unwrap();

    assert_eq!(
        reasoning,
        GenerateStreamEvent::Reasoning {
            text: "Sto verificando il piano.".to_string()
        }
    );
    assert_eq!(
        activity,
        GenerateStreamEvent::Activity {
            text: "Apro il browser".to_string()
        }
    );
    assert_eq!(
        plan_update,
        GenerateStreamEvent::PlanUpdate {
            markdown: "- [x] Aprire la pagina".to_string()
        }
    );
}

#[test]
fn generate_stream_event_deserializes_structured_card_events() {
    let choice_prompt: GenerateStreamEvent = serde_json::from_value(serde_json::json!({
        "type": "choice_prompt",
        "payload": {"question": "Confermi?", "options": ["Si", "No"]}
    }))
    .unwrap();
    let vault_propose: GenerateStreamEvent = serde_json::from_value(serde_json::json!({
        "type": "vault_propose",
        "payload": {"category": "identity", "label": "Codice Fiscale"}
    }))
    .unwrap();
    let vault_reveal: GenerateStreamEvent = serde_json::from_value(serde_json::json!({
        "type": "vault_reveal",
        "payload": {"record_id": "vault_1", "label": "Codice Fiscale"}
    }))
    .unwrap();
    let payment_approval: GenerateStreamEvent = serde_json::from_value(serde_json::json!({
        "type": "payment_approval",
        "payload": {"snapshot": {"approval_id": "pay_1"}}
    }))
    .unwrap();
    let tool_result: GenerateStreamEvent = serde_json::from_value(serde_json::json!({
        "type": "tool_result",
        "payload": {"tool": "browser_snapshot", "ok": true}
    }))
    .unwrap();

    assert_eq!(
        choice_prompt,
        GenerateStreamEvent::ChoicePrompt {
            payload: serde_json::json!({"question": "Confermi?", "options": ["Si", "No"]})
        }
    );
    assert_eq!(
        vault_propose,
        GenerateStreamEvent::VaultPropose {
            payload: serde_json::json!({"category": "identity", "label": "Codice Fiscale"})
        }
    );
    assert_eq!(
        vault_reveal,
        GenerateStreamEvent::VaultReveal {
            payload: serde_json::json!({"record_id": "vault_1", "label": "Codice Fiscale"})
        }
    );
    assert_eq!(
        payment_approval,
        GenerateStreamEvent::PaymentApproval {
            payload: serde_json::json!({"snapshot": {"approval_id": "pay_1"}})
        }
    );
    assert_eq!(
        tool_result,
        GenerateStreamEvent::ToolResult {
            payload: serde_json::json!({"tool": "browser_snapshot", "ok": true})
        }
    );
}

#[test]
fn classify_intent_request_serializes_without_schema_or_repair_payload() {
    let request = IntentClassifyRequest {
        usage: local_first_inference_usage::UsageContext::new(
            "intent-request-test",
            local_first_inference_usage::InferencePurpose::Evaluation,
            "test",
        ),
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
