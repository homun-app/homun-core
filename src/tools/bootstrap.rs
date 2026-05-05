use std::sync::Arc;

use crate::config::Config;
use crate::storage::Database;
use crate::tools::{
    app_factory::app_factory_tools, AutomationTool, ContactsTool, CreateSkillTool,
    DocumentConversionTool, EditFileTool, ListDirTool, ReadFileTool, ShellTool, ToolRegistry,
    VaultTool, WebFetchTool, WebSearchTool, WriteFileTool,
};

#[cfg(feature = "channel-email")]
use crate::tools::ReadEmailInboxTool;

#[cfg(feature = "embeddings")]
use crate::tools::RememberTool;

/// Create and register all tools from config.
pub fn create_tool_registry(
    config: &Config,
    db: Database,
    shared_config: Option<Arc<tokio::sync::RwLock<Config>>>,
) -> ToolRegistry {
    let mut registry = ToolRegistry::new();

    let allowed_dir = if config.tools.exec.restrict_to_workspace {
        Some(Config::workspace_dir())
    } else {
        None
    };

    let permissions = Arc::new(config.permissions.clone());
    let shell_permissions = Arc::new(config.permissions.shell.clone());

    crate::tools::init_approval_manager(&config.permissions.approval);
    crate::agent::approval_gate::init_approval_gate();

    registry.register(Box::new(ShellTool::with_permissions_sandbox_and_config(
        config.tools.exec.timeout,
        config.tools.exec.restrict_to_workspace,
        Some(shell_permissions),
        Some(config.security.execution_sandbox.clone()),
        shared_config.clone(),
    )));

    registry.register(Box::new(ReadFileTool::with_permissions(
        allowed_dir.clone(),
        permissions.clone(),
    )));
    registry.register(Box::new(WriteFileTool::with_permissions(
        allowed_dir.clone(),
        permissions.clone(),
    )));
    registry.register(Box::new(EditFileTool::with_permissions(
        allowed_dir.clone(),
        permissions.clone(),
    )));
    registry.register(Box::new(DocumentConversionTool::with_permissions(
        allowed_dir.clone(),
        permissions.clone(),
    )));
    registry.register(Box::new(ListDirTool::with_permissions(
        allowed_dir,
        permissions,
    )));

    if !config.tools.web_search.api_key.is_empty() {
        registry.register(Box::new(WebSearchTool::new(
            &config.tools.web_search.api_key,
            config.tools.web_search.max_results,
        )));
    } else {
        tracing::debug!("web_search tool not registered: no API key configured");
    }

    registry.register(Box::new(WebFetchTool::new()));
    registry.register(Box::new(VaultTool::with_db(db.clone())));

    if let Some(ref sc) = shared_config {
        registry.register(Box::new(ContactsTool::new(db.clone(), sc.clone())));
    }

    registry.register(Box::new(AutomationTool::new(db.clone())));
    for tool in app_factory_tools(db, Config::data_dir()) {
        registry.register(tool);
    }
    registry.register(Box::new(CreateSkillTool::new()));

    #[cfg(feature = "channel-email")]
    registry.register(Box::new(ReadEmailInboxTool::new()));

    #[cfg(feature = "embeddings")]
    registry.register(Box::new(RememberTool::new()));

    tracing::info!(tools = registry.len(), "Tool registry initialized");

    registry
}
