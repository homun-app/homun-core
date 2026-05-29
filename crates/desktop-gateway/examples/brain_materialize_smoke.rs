//! Live validation of A1.1: build the OrchestratorBrain exactly like
//! `brain_materialize_tasks` (cached browser tools, durable-only policy, real
//! Gemma) and run it on a prompt, printing the plan and the durable tasks it
//! materializes. Lets us design A1.2 (session/chat linkage) on real output.
//!
//! Run (needs Gemma on :8765):
//!   cargo run -p local-first-desktop-gateway --example brain_materialize_smoke

use local_first_capabilities::{
    ActionClass, CachedToolProvider, CapabilityFacade, CapabilityPolicy, CapabilityProviderKind,
    CapabilityTool, InMemoryCapabilityAudit, PolicyContext, ProviderId, UserId, WorkspaceId,
};
use local_first_inference::{
    CapabilityDescriptor, Locality, ModelRouter, OpenAiCompatProvider, PrivacyPolicy,
};
use local_first_orchestrator::{
    NoopMemoryContextProvider, OrchestratorBrain, OrchestratorBudgets, OrchestratorRequest,
    ToolSearchIndexStore,
};
use local_first_subagents::{JsonRuntime, RuntimeClient};
use local_first_task_runtime::TaskStore;

/// Resolves the cloud API key WITHOUT it ever appearing in a command/env value:
/// reads the 0600 file at `LOCAL_FIRST_INFERENCE_API_KEY_FILE` (preferred), else
/// falls back to the `OLLAMA_API_KEY` env var.
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

fn browser_tool(name: &str, action: ActionClass) -> CapabilityTool {
    CapabilityTool {
        name: name.to_string(),
        provider_id: ProviderId::new("browser"),
        provider_kind: CapabilityProviderKind::Browser,
        action,
        description: format!("browser tool {name}"),
        privacy_domains: vec!["browser".to_string()],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({ "type": "object" }),
    }
}

fn main() {
    let goal = std::env::var("BRAIN_GOAL").unwrap_or_else(|_| {
        "Cerca un treno da Napoli a Milano per il 10 giugno 2026 intorno alle 9:00".to_string()
    });

    // Runtime: Ollama (capable model via router) when BRAIN_OLLAMA_MODEL is set,
    // else the local MLX Gemma runtime.
    if let Ok(model) = std::env::var("BRAIN_OLLAMA_MODEL") {
        let base = std::env::var("BRAIN_OLLAMA_BASE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:11434/v1".to_string());
        eprintln!("[smoke] runtime: ollama {base} model={model}");
        let descriptor = CapabilityDescriptor {
            id: format!("ollama:{model}"),
            locality: Locality::Local,
            supports_vision: false,
            supports_tools: true,
            context_window: 32_768,
            approx_tokens_per_second: None,
        };
        let api_key = resolve_api_key();
        let router = ModelRouter::new(PrivacyPolicy::local_only())
            .with_provider(Box::new(OpenAiCompatProvider::new(descriptor, base, model, api_key)));
        run_brain(router, &goal);
    } else {
        let gemma = std::env::var("LOCAL_FIRST_GEMMA_RUNTIME_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8765".to_string());
        eprintln!("[smoke] runtime: mlx {gemma}");
        run_brain(RuntimeClient::new(gemma), &goal);
    }
}

fn run_brain<R: JsonRuntime>(runtime: R, goal: &str) {
    // Same cached browser tools the gateway seeds.
    let tools = vec![
        browser_tool("browser.health", ActionClass::Read),
        browser_tool("browser.tabs", ActionClass::Read),
        browser_tool("browser.snapshot", ActionClass::Read),
        browser_tool("browser.navigate", ActionClass::WriteWithConfirmation),
        browser_tool("browser.act", ActionClass::WriteWithConfirmation),
        browser_tool("browser.screenshot", ActionClass::WriteWithConfirmation),
    ];
    let mut facade = CapabilityFacade::new(CapabilityPolicy::new(), InMemoryCapabilityAudit::default());
    facade.register_provider(CachedToolProvider::new(
        ProviderId::new("browser"),
        CapabilityProviderKind::Browser,
        tools,
    ));

    // Durable-only policy: tools visible, none executable (allowed_actions empty).
    let policy_context = PolicyContext {
        user_id: UserId::new("local-user"),
        workspace_id: WorkspaceId::new("local-workspace"),
        enabled_providers: vec![ProviderId::new("browser")],
        privacy_domains: vec!["browser".to_string(), "local".to_string()],
        allowed_actions: Vec::new(),
        max_autonomy_level: 3,
        allow_managed_cloud: false,
    };

    let mut brain = OrchestratorBrain::new(
        runtime,
        NoopMemoryContextProvider,
        facade,
        ToolSearchIndexStore::open_in_memory().expect("tool index"),
        TaskStore::open_in_memory().expect("task store"),
    );

    let request = OrchestratorRequest {
        request_id: "smoke".to_string(),
        policy_context,
        user_message: goal.to_string(),
        conversation_summary: None,
        attachments: Vec::new(),
        budgets: OrchestratorBudgets::default(),
    };

    eprintln!("[smoke] goal: {goal}");
    match brain.run(request) {
        Ok(outcome) => {
            println!("route            = {:?}", outcome.plan.route);
            println!("loaded_tools     = {}", outcome.loaded_tools.len());
            if let Some(answer) = &outcome.direct_answer {
                println!("direct_answer    = {}", answer.answer);
            }
            if let Some(reason) = &outcome.blocked_reason {
                println!("blocked_reason   = {reason}");
            }
            println!("plan.steps ({}):", outcome.plan.steps.len());
            for step in &outcome.plan.steps {
                println!(
                    "  - {} kind={:?} tool={:?} policy={:?} risk={}",
                    step.step_id, step.kind, step.tool_name, step.execution_policy, step.risk_level
                );
            }
            println!("enqueued capability tasks ({}):", outcome.enqueued_tasks.len());
            for summary in &outcome.enqueued_tasks {
                println!("  - {}", summary.task_id.as_str());
            }
            println!(
                "enqueued subagent tasks ({}):",
                outcome.enqueued_subagent_tasks.len()
            );
            for summary in &outcome.enqueued_subagent_tasks {
                println!("  - {}", summary.task_id.as_str());
            }
        }
        Err(error) => {
            eprintln!("[smoke] brain.run FAILED: {error:?}");
            std::process::exit(1);
        }
    }
}
