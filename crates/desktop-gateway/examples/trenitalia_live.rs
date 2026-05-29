//! Live end-to-end smoke for the browser observe/act loop against the real
//! Trenitalia site, driven either by the local MLX Gemma runtime or by a model
//! served through Ollama (local or cloud) via the inference ModelRouter.
//!
//! This exercises the recent work together: sidecar tab hygiene, the explicit
//! PLAN injected into the planner prompt, and the new inference routing layer.
//! It is an example (not a unit test) because it needs a running model, a real
//! Chromium and network access.
//!
//! Run (Ollama, default):
//!   LOCAL_FIRST_BROWSER_LOOP_DEBUG=1 \
//!   cargo run -p local-first-desktop-gateway --example trenitalia_live
//!
//! Run (MLX Gemma):
//!   INFERENCE_BACKEND=mlx cargo run -p local-first-desktop-gateway --example trenitalia_live
//!
//! Env knobs:
//!   INFERENCE_BACKEND = ollama|mlx              (default ollama)
//!   OLLAMA_BASE_URL   (default http://127.0.0.1:11434/v1)
//!   OLLAMA_MODEL      (default qwen3-vl:235b-cloud)
//!   LOCAL_FIRST_GEMMA_RUNTIME_URL (default http://127.0.0.1:8765)
//!   TRENITALIA_MAX_ITERATIONS     (default 16)
//!   BROWSER_AUTOMATION_HEADLESS = true|false    (default true)

use std::error::Error;
use std::path::PathBuf;

use browser_loop_controller::{BrowserContextProfile, RuntimeBrowserLoopPlanner};
use local_first_browser_automation::{
    BrowserAutomationClient, BrowserLoopOutput, BrowserLoopPlanner, BrowserLoopRequest,
    BrowserLoopRunner, BrowserResult, BrowserSidecarSession, BrowserSidecarSpawnOptions,
    browser_loop_event_payload,
};
use local_first_desktop_gateway::browser_loop_controller;
use local_first_inference::{
    CapabilityDescriptor, Locality, ModelRouter, OpenAiCompatProvider, PrivacyPolicy, Requirements,
};
use local_first_subagents::RuntimeClient;

/// Resolves the cloud API key from the 0600 file at
/// `LOCAL_FIRST_INFERENCE_API_KEY_FILE` (preferred, so the value never appears
/// in a command/env), else from `OLLAMA_API_KEY`.
fn resolve_api_key() -> Option<String> {
    if let Ok(path) = std::env::var("LOCAL_FIRST_INFERENCE_API_KEY_FILE")
        && !path.trim().is_empty()
        && let Ok(contents) = std::fs::read_to_string(path.trim())
    {
        let key = contents.trim().to_string();
        if !key.is_empty() {
            return Some(key);
        }
    }
    std::env::var("OLLAMA_API_KEY").ok().filter(|key| !key.is_empty())
}

fn main() -> Result<(), Box<dyn Error>> {
    let backend = std::env::var("INFERENCE_BACKEND").unwrap_or_else(|_| "ollama".to_string());
    let headless =
        std::env::var("BROWSER_AUTOMATION_HEADLESS").unwrap_or_else(|_| "true".to_string());
    let max_iterations = std::env::var("TRENITALIA_MAX_ITERATIONS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(16);

    let goal = "Cerca un treno da Napoli a Milano per il 10 giugno 2026 intorno alle 9:00. \
        Raccogli le opzioni reali (treno, orari, durata, prezzo) e fermati prima di \
        selezione treno, login, passeggeri o pagamento.";

    let plan = vec![
        "Dismiss any cookie/consent banner if present".to_string(),
        "Set the departure station field to: Napoli Centrale".to_string(),
        "Click the correct departure suggestion from the autocomplete list".to_string(),
        "Set the arrival station field to: Milano Centrale".to_string(),
        "Click the correct arrival suggestion from the autocomplete list".to_string(),
        "Open the date field and select the day: 2026-06-10".to_string(),
        "Set the departure time to about: 09:00".to_string(),
        "Click the search button (Cerca) to run the search".to_string(),
        "Read the result rows and complete with structured options (train, times, \
         duration, price). Stop before train selection, login, passengers, payment or purchase."
            .to_string(),
    ];

    let request = BrowserLoopRequest::new(goal, "loop_0")
        .with_initial_url("https://www.trenitalia.com/")
        .with_max_iterations(max_iterations)
        .with_plan(plan);

    let browser_dir =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../runtimes/browser-automation");
    let artifact_root = std::env::temp_dir().join("local-first-browser-artifacts");

    eprintln!("[harness] backend={backend} headless={headless} max_iter={max_iterations}");
    eprintln!("[harness] goal: {goal}\n");

    let session = BrowserSidecarSession::spawn_with_options(
        "npm",
        &["run", "start", "--silent"],
        BrowserSidecarSpawnOptions {
            current_dir: Some(browser_dir),
            env: vec![
                ("BROWSER_AUTOMATION_HEADLESS".to_string(), headless),
                (
                    "BROWSER_AUTOMATION_ARTIFACT_ROOT".to_string(),
                    artifact_root.display().to_string(),
                ),
            ],
        },
    )?;

    let output = match backend.as_str() {
        "mlx" => {
            let gemma_url = std::env::var("LOCAL_FIRST_GEMMA_RUNTIME_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8765".to_string());
            eprintln!("[harness] mlx runtime: {gemma_url}");
            // MLX runtime exposes no capability descriptor here, so the window is
            // unknown -> compact frame (right for the small local Gemma).
            let profile = BrowserContextProfile::for_context_window(None);
            eprintln!("[harness] context profile: {profile:?}");
            let planner = RuntimeBrowserLoopPlanner::with_context_profile(
                RuntimeClient::new(gemma_url),
                profile,
            );
            run_browser_loop(session, planner, &request)?
        }
        _ => {
            let base_url = std::env::var("OLLAMA_BASE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:11434/v1".to_string());
            let model =
                std::env::var("OLLAMA_MODEL").unwrap_or_else(|_| "qwen3-vl:235b-cloud".to_string());
            eprintln!("[harness] ollama: {base_url} model={model}");
            // A `:cloud` model leaves the device, so model it as Cloud locality
            // and opt in explicitly — this exercises the privacy gate, not bypasses it.
            let descriptor = CapabilityDescriptor {
                id: format!("ollama:{model}"),
                locality: Locality::Cloud,
                supports_vision: true,
                supports_tools: true,
                context_window: 32_768,
                approx_tokens_per_second: None,
            };
            // Cloud key from a 0600 file (LOCAL_FIRST_INFERENCE_API_KEY_FILE),
            // else OLLAMA_API_KEY env — the value never appears in a command.
            let provider = OpenAiCompatProvider::new(descriptor, base_url, model, resolve_api_key());
            let router = ModelRouter::new(PrivacyPolicy::allowing_cloud())
                .with_provider(Box::new(provider));
            // Size the snapshot to the model: large-context models get the full
            // page (the calendar grid survives), small ones get a compact frame.
            // BROWSER_CONTEXT_PROFILE overrides this — Full prompts are huge and
            // make heavy/reasoning cloud models crawl, so Compact is often the
            // practical choice even on a large-context model.
            let window = router.active_context_window(&Requirements::default());
            let profile = match std::env::var("BROWSER_CONTEXT_PROFILE")
                .unwrap_or_default()
                .to_ascii_lowercase()
                .as_str()
            {
                "full" => BrowserContextProfile::Full,
                "compact" => BrowserContextProfile::Compact,
                "minimal" => BrowserContextProfile::Minimal,
                _ => BrowserContextProfile::for_context_window(window),
            };
            eprintln!("[harness] context_window={window:?} -> profile {profile:?}");
            let planner = RuntimeBrowserLoopPlanner::with_context_profile(router, profile);
            run_browser_loop(session, planner, &request)?
        }
    };

    println!("\n================ LOOP RESULT ================");
    println!("backend: {backend}");
    println!("completed: {}", output.completed);
    println!("iterations: {}", output.iterations.len());
    println!("final url: {}", output.final_observation.url);
    println!(
        "output:\n{}",
        serde_json::to_string_pretty(&output.output).unwrap_or_default()
    );
    Ok(())
}

/// Runs the browser loop with any planner, logging one line per iteration. The
/// MLX and Ollama paths produce different concrete planner types, so the loop
/// body is generic over the planner.
fn run_browser_loop<P: BrowserLoopPlanner>(
    session: BrowserSidecarSession,
    planner: P,
    request: &BrowserLoopRequest,
) -> BrowserResult<BrowserLoopOutput> {
    let client = BrowserAutomationClient::new(session);
    let mut runner = BrowserLoopRunner::from_client(client, planner);
    runner.run_with_iteration_observer(request, |iteration| {
        eprintln!(
            "[iter {:>2}] status={} url={} action={}",
            iteration.iteration,
            iteration.status,
            iteration.url_after,
            serde_json::to_string(
                &browser_loop_event_payload(iteration)
                    .get("action")
                    .cloned()
                    .unwrap_or_default()
            )
            .unwrap_or_default(),
        );
        Ok(())
    })
}
