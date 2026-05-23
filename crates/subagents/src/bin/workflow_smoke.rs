use local_first_subagents::{
    RuntimeClient, SubagentOrchestrator, SubagentRunner, SubagentStatus, routine_startup_workflow,
};

fn main() {
    let base_url = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("GEMMA4_RUNTIME_URL").ok())
        .unwrap_or_else(|| "http://127.0.0.1:8765".to_string());
    let model = std::env::var("GEMMA4_MODEL")
        .unwrap_or_else(|_| "mlx-community/gemma-4-e4b-it-4bit".to_string());

    let runtime = RuntimeClient::new(base_url);
    let runner = SubagentRunner::new(runtime, model);
    let mut orchestrator = SubagentOrchestrator::new(runner);
    orchestrator
        .add_workflow(routine_startup_workflow(sample_input()))
        .expect("workflow should be valid");

    let results = orchestrator.run_until_blocked();
    let failed = results
        .iter()
        .filter(|result| result.status != SubagentStatus::Succeeded)
        .count();
    let blocked = orchestrator.blocked_task_ids();

    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "total": results.len(),
            "failed": failed,
            "blocked": blocked,
            "results": results,
        }))
        .expect("results should serialize")
    );

    if failed > 0 || !blocked.is_empty() {
        std::process::exit(1);
    }
}

fn sample_input() -> serde_json::Value {
    serde_json::json!({
        "events": [
            "08:58 open_app Zed",
            "08:59 open_folder /Clients/Acme/app",
            "09:01 terminal git pull",
            "09:03 browser trello.com board Acme",
            "09:06 browser mattermost.acme.local unread messages"
        ],
        "configured_connectors": []
    })
}
