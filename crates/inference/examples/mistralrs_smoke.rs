//! Runtime smoke for the in-process mistral.rs provider.
//!
//! Validates that mistral.rs actually loads a model and produces JSON through
//! our `InferenceProvider`, before we build the chat path on it and retire MLX.
//!
//! Run (downloads + quantizes the model on first run; CPU unless mistral.rs is
//! built with the `metal`/`cuda` feature):
//!   MISTRALRS_MODEL=Qwen/Qwen3-0.6B \
//!   cargo run -p local-first-inference --features local-mistralrs --example mistralrs_smoke

#[cfg(feature = "local-mistralrs")]
fn main() {
    use local_first_inference::{
        CapabilityDescriptor, InferenceProvider, Locality, MistralRsProvider,
    };
    use local_first_subagents::GenerateJsonRequest;

    let model = std::env::var("MISTRALRS_MODEL").unwrap_or_else(|_| "Qwen/Qwen3-0.6B".to_string());
    let descriptor = CapabilityDescriptor {
        id: format!("mistralrs:{model}"),
        locality: Locality::Local,
        supports_vision: false,
        supports_tools: true,
        context_window: 32_768,
        approx_tokens_per_second: None,
    };

    eprintln!("[smoke] loading {model} (downloads + in-situ quantizes on first run)...");
    let provider = match MistralRsProvider::load(
        descriptor,
        model.clone(),
        std::sync::Arc::new(local_first_inference_usage::NoopUsageRecorder),
    ) {
        Ok(provider) => provider,
        Err(error) => {
            eprintln!("[smoke] LOAD FAILED: {error}");
            std::process::exit(1);
        }
    };
    eprintln!("[smoke] loaded. running generate_json...");

    let max_tokens = std::env::var("MISTRALRS_MAX_TOKENS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(64);
    let request = GenerateJsonRequest {
        usage: local_first_inference_usage::UsageContext::new(
            "mistralrs-smoke",
            local_first_inference_usage::InferencePurpose::Evaluation,
            "local",
        ),
        prompt: "Reply with ONLY a JSON object: {\"ok\": true, \"engine\": \"mistralrs\"}"
            .to_string(),
        max_tokens,
        temperature: 0.0,
        wait_if_busy: true,
        request_timeout_seconds: None,
        json_schema: None,
        required_keys: vec!["ok".to_string()],
        repair: true,
    };

    match provider.generate_json(&request) {
        Ok(response) => {
            println!("valid       = {}", response.valid);
            println!("repaired    = {}", response.repaired);
            println!("errors      = {:?}", response.errors);
            println!("json        = {}", response.json);
            println!("raw_output  = {}", response.raw_output);
            println!("gen tok/s   = {}", response.metrics.generation_tps);
        }
        Err(error) => {
            eprintln!("[smoke] GENERATE FAILED: {error:?}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(feature = "local-mistralrs"))]
fn main() {
    eprintln!("build with --features local-mistralrs");
}
