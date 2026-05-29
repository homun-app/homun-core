use local_first_process_manager::{
    HealthCheck, McpProcessConfig, ProcessKind, ProcessRegistryStore, SidecarProcessCatalog,
};
use std::path::PathBuf;

#[test]
fn catalog_builds_gemma_runtime_process_spec() {
    let catalog = SidecarProcessCatalog::new("/workspace");

    let spec = catalog.gemma_runtime();

    assert_eq!(spec.id, "llm-gemma4-mlx");
    assert_eq!(spec.kind, ProcessKind::LlmRuntime);
    assert_eq!(spec.command, path("/workspace/.venv-mlx/bin/python"));
    assert_eq!(spec.args, vec!["runtimes/mlx-gemma4/server.py"]);
    assert_eq!(spec.cwd.as_deref(), Some("/workspace"));
    assert_eq!(spec.env["PYTHONDONTWRITEBYTECODE"], "1");
    assert_eq!(spec.env["PYTHONUNBUFFERED"], "1");
    assert_eq!(
        spec.health_check,
        HealthCheck::HttpGet {
            url: "http://127.0.0.1:8765/health".to_string(),
            timeout_ms: 1_000,
        }
    );
}

#[test]
fn catalog_builds_browser_sidecar_process_spec() {
    let catalog = SidecarProcessCatalog::new("/workspace");

    let spec = catalog.browser_sidecar();

    assert_eq!(spec.id, "browser-automation");
    assert_eq!(spec.kind, ProcessKind::BrowserSidecar);
    assert_eq!(spec.command, "node");
    assert_eq!(
        spec.args,
        vec!["node_modules/tsx/dist/cli.mjs", "src/server.ts"]
    );
    assert_eq!(
        spec.cwd.as_deref(),
        Some("/workspace/runtimes/browser-automation")
    );
    assert_eq!(spec.env["BROWSER_AUTOMATION_HEADLESS"], "1");
    assert_eq!(spec.health_check, HealthCheck::ProcessAlive);
}

#[test]
fn catalog_builds_mcp_stdio_process_specs_from_user_config() {
    let catalog = SidecarProcessCatalog::new("/workspace");
    let config = McpProcessConfig::new("filesystem", "uvx")
        .with_arg("mcp-server-filesystem")
        .with_arg("/workspace")
        .with_env("RUST_LOG", "info")
        .with_cwd("/workspace");

    let spec = catalog.mcp_stdio(config);

    assert_eq!(spec.id, "mcp-filesystem");
    assert_eq!(spec.kind, ProcessKind::McpServer);
    assert_eq!(spec.command, "uvx");
    assert_eq!(spec.args, vec!["mcp-server-filesystem", "/workspace"]);
    assert_eq!(spec.env["RUST_LOG"], "info");
    assert_eq!(spec.cwd.as_deref(), Some("/workspace"));
    assert_eq!(spec.health_check, HealthCheck::ProcessAlive);
}

#[test]
fn catalog_registers_default_sidecars_in_process_registry() {
    let catalog = SidecarProcessCatalog::new("/workspace");
    let store = ProcessRegistryStore::open_in_memory().unwrap();

    catalog.register_default_sidecars(&store).unwrap();

    assert!(store.get_spec("llm-gemma4-mlx").unwrap().is_some());
    assert!(store.get_spec("browser-automation").unwrap().is_some());
}

fn path(value: &str) -> String {
    PathBuf::from(value).to_string_lossy().to_string()
}
