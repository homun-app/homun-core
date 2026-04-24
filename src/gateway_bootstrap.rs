use std::sync::Arc;

use anyhow::Result;

use crate::config::{self, Config};
use crate::scheduler::CronScheduler;
use crate::session::SessionManager;
use crate::storage::Database;
use crate::tools::bootstrap::create_tool_registry;
use crate::tools::{MessageTool, ToolRegistry, WorkflowTool};
use crate::utils::watcher::WatcherHandle;
use crate::{agent, gateway_process, profiles, provider, skills, tools, workflows};

#[cfg(feature = "mcp")]
use crate::tools::McpManager;

#[cfg(feature = "embeddings")]
use crate::rag;

struct RuntimeSetup {
    config: Config,
    db: Database,
    shared_config: Arc<tokio::sync::RwLock<Config>>,
    health_tracker: Arc<provider::ProviderHealthTracker>,
    provider: Option<Arc<dyn provider::Provider>>,
}

struct GatewayToolSetup {
    registry: ToolRegistry,
    spawn_manager_cell: Arc<tokio::sync::OnceCell<Arc<agent::SubagentManager>>>,
    workflow_engine_cell: Arc<tokio::sync::OnceCell<Arc<workflows::engine::WorkflowEngine>>>,
}

struct AgentRegistryContext<'a> {
    config: &'a Config,
    shared_config: Arc<tokio::sync::RwLock<Config>>,
    skill_registry: Arc<tokio::sync::RwLock<skills::SkillRegistry>>,
    tool_msg_tx: tokio::sync::mpsc::Sender<crate::bus::OutboundMessage>,
    tool_names: &'a [String],
    #[cfg(feature = "embeddings")]
    db_for_searcher: Database,
    #[cfg(feature = "embeddings")]
    rag_engine: Option<Arc<tokio::sync::Mutex<rag::RagEngine>>>,
}

struct RuntimeServicesContext<'a> {
    config: &'a Config,
    db_for_web: Database,
    registry: agent::AgentRegistry,
    cron_scheduler: Arc<CronScheduler>,
    spawn_manager_cell: Arc<tokio::sync::OnceCell<Arc<agent::SubagentManager>>>,
    workflow_engine_cell: Arc<tokio::sync::OnceCell<Arc<workflows::engine::WorkflowEngine>>>,
    #[cfg(feature = "embeddings")]
    rag_engine: Option<Arc<tokio::sync::Mutex<rag::RagEngine>>>,
    #[cfg(feature = "embeddings")]
    db_for_watcher: Database,
}

struct RuntimeServices {
    registry: Arc<agent::AgentRegistry>,
    agent: Arc<agent::AgentLoop>,
    subagent_manager_for_estop: Arc<agent::SubagentManager>,
    workflow_engine: Arc<workflows::engine::WorkflowEngine>,
    workflow_event_rx: tokio::sync::mpsc::Receiver<workflows::WorkflowEvent>,
    _skill_watcher_handle: WatcherHandle,
    _bootstrap_watcher_handle: WatcherHandle,
    #[cfg(feature = "embeddings")]
    watch_update_tx: Option<tokio::sync::mpsc::Sender<rag::watcher::WatchUpdate>>,
    #[cfg(feature = "embeddings")]
    _rag_watcher_handle: Option<WatcherHandle>,
}

async fn load_runtime_setup(startup_t0: std::time::Instant) -> Result<RuntimeSetup> {
    let mut config = Config::load()?;

    // Kill any orphaned Playwright processes from previous sessions
    // (e.g. after SIGKILL or crash where graceful shutdown didn't run)
    #[cfg(feature = "browser")]
    crate::browser::cleanup_orphan_playwright_processes();

    // Inject browser MCP server into config BEFORE wrapping in Arc<RwLock>,
    // so runtime_config lookups in McpClientTool::execute() can find it.
    #[cfg(feature = "mcp")]
    if let Some(browser_mcp) = crate::browser::browser_mcp_server_config(&config.browser) {
        config.mcp.servers.insert(
            crate::browser::BROWSER_MCP_SERVER_NAME.to_string(),
            browser_mcp,
        );
        tracing::info!("Browser MCP server injected into config from [browser] section");
    }
    tracing::info!(
        elapsed_ms = startup_t0.elapsed().as_millis(),
        "⏱ config loaded"
    );

    if config.metrics.enabled {
        crate::metrics::register_homun_metrics();
        tracing::info!("⏱ metrics registry initialized");
    }

    // Open DB BEFORE wrapping config in Arc so we can apply the DB settings
    // overlay (DB overrides TOML for security/permissions sections).
    let db = Database::open(&config.storage.resolved_path()).await?;
    tracing::info!(
        elapsed_ms = startup_t0.elapsed().as_millis(),
        "⏱ database opened"
    );

    crate::config::overlay_db_settings(&mut config, &db).await;

    // Shared config: web UI writes -> agent reads on next request (hot-reload).
    let shared_config = Arc::new(tokio::sync::RwLock::new(config));
    // Snapshot for one-time startup operations (provider, tools, channels, etc.).
    let config = shared_config.read().await.clone();

    let data_dir = Config::data_dir();
    if let Err(e) = profiles::ProfileRegistry::load(&db, &data_dir).await {
        tracing::warn!(error = %e, "Failed to initialize profile registry");
    }
    if let Err(e) = profiles::db::migrate_contact_personas(db.pool(), &data_dir).await {
        tracing::warn!(error = %e, "Failed to migrate contact personas to profiles");
    }

    let health_tracker = Arc::new(provider::ProviderHealthTracker::new());

    let provider = match provider::create_provider_with_health(&config, health_tracker.clone()) {
        Ok(p) => Some(p),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "No provider configured. Gateway starting in setup mode. \
                Configure a provider at {}/setup",
                crate::local_web_ui_url(&config)
            );
            None
        }
    };
    tracing::info!(
        elapsed_ms = startup_t0.elapsed().as_millis(),
        "⏱ provider created"
    );

    Ok(RuntimeSetup {
        config,
        db,
        shared_config,
        health_tracker,
        provider,
    })
}

fn build_gateway_tool_registry(
    config: &Config,
    db: Database,
    shared_config: Arc<tokio::sync::RwLock<Config>>,
) -> GatewayToolSetup {
    let mut registry = create_tool_registry(config, db, Some(shared_config));
    registry.register(Box::new(MessageTool::new()));
    registry.register(Box::new(tools::send_file::SendFileTool::new()));
    registry.register(Box::new(tools::view_file::ViewFileTool::new()));

    let spawn_manager_cell = Arc::new(tokio::sync::OnceCell::new());
    registry.register(Box::new(tools::SpawnTool::new(spawn_manager_cell.clone())));

    let workflow_engine_cell = Arc::new(tokio::sync::OnceCell::new());
    registry.register(Box::new(WorkflowTool::new(workflow_engine_cell.clone())));

    GatewayToolSetup {
        registry,
        spawn_manager_cell,
        workflow_engine_cell,
    }
}

async fn load_skill_registry() -> Arc<tokio::sync::RwLock<skills::SkillRegistry>> {
    let mut skill_registry = skills::SkillRegistry::new();
    if let Err(e) = skill_registry.scan_and_load().await {
        tracing::warn!(error = %e, "Failed to load skills");
    }
    Arc::new(tokio::sync::RwLock::new(skill_registry))
}

async fn configure_agent_registry(
    registry: &mut Option<agent::AgentRegistry>,
    context: AgentRegistryContext<'_>,
) {
    let active_channels = context.config.channels.active_channels_with_chat_ids();
    let channel_refs: Vec<(&str, &str)> = active_channels
        .iter()
        .map(|(name, id)| (name.as_str(), id.as_str()))
        .collect();
    let email_accounts: Vec<(String, crate::config::EmailMode)> = context
        .config
        .channels
        .active_email_accounts()
        .into_iter()
        .map(|(name, acc)| (name.clone(), acc.mode.clone()))
        .collect();

    if let Some(ref mut reg) = registry {
        #[cfg(feature = "embeddings")]
        let (memory_searcher, rag_for_agents) = {
            let cfg = context.shared_config.read().await;
            let searcher = crate::try_create_memory_searcher(context.db_for_searcher, &cfg)
                .map(|s| Arc::new(tokio::sync::Mutex::new(s)));
            (searcher, context.rag_engine.clone())
        };

        let skills_summary = {
            let sr = context.skill_registry.read().await;
            if !sr.is_empty() {
                tracing::info!(
                    skills = sr.len(),
                    "Skills loaded into agent context (gateway)"
                );
                Some(sr.build_prompt_summary())
            } else {
                None
            }
        };

        reg.for_each_mut(|a| {
            a.set_message_tx(context.tool_msg_tx.clone());
            a.set_skill_registry(context.skill_registry.clone());

            if !active_channels.is_empty() {
                a.set_channels_info(&channel_refs);
            }
            if !email_accounts.is_empty() {
                a.set_email_accounts_info(&email_accounts);
            }

            #[cfg(feature = "embeddings")]
            {
                if let Some(ref searcher) = memory_searcher {
                    a.set_memory_searcher_shared(searcher.clone());
                }
                if let Some(ref rag) = rag_for_agents {
                    a.set_rag_engine(rag.clone());
                }
            }
        });

        for agent in reg.agents() {
            if let Some(ref summary) = skills_summary {
                agent.set_skills_summary(summary.clone()).await;
            }
            agent
                .set_registered_tool_names(context.tool_names.to_vec())
                .await;
        }
    }
}

fn start_runtime_services(context: RuntimeServicesContext<'_>) -> RuntimeServices {
    let default_agent = context.registry.default_agent();
    let skills_summary_handle = default_agent.skills_summary_handle();
    let (bootstrap_content_handle, bootstrap_files_handle) = default_agent.bootstrap_handles();

    let registry = Arc::new(context.registry);
    let agent = registry.default_agent().clone();

    let (subagent_result_tx, _subagent_result_rx) = tokio::sync::mpsc::channel(50);
    let subagent_manager = Arc::new(agent::SubagentManager::new(
        agent.clone(),
        subagent_result_tx,
    ));
    let subagent_manager_for_estop = subagent_manager.clone();
    if context.spawn_manager_cell.set(subagent_manager).is_err() {
        tracing::error!("SpawnTool OnceCell was already initialized — this is a bug");
    }

    tracing::info!("Subagent manager initialized (SpawnTool registered)");

    let (workflow_event_tx, workflow_event_rx) = tokio::sync::mpsc::channel(50);
    let workflow_engine = Arc::new(workflows::engine::WorkflowEngine::new(
        context.db_for_web.clone(),
        registry.clone(),
        workflow_event_tx,
    ));
    if context
        .workflow_engine_cell
        .set(workflow_engine.clone())
        .is_err()
    {
        tracing::error!("WorkflowTool OnceCell was already initialized — this is a bug");
    }
    tracing::info!("Workflow engine initialized (WorkflowTool registered)");

    context
        .cron_scheduler
        .set_workflow_engine(workflow_engine.clone());

    let skills_dir = config::Config::data_dir().join("skills");
    let skill_watcher = skills::SkillWatcher::new(skills_summary_handle, skills_dir);
    let skill_watcher_handle = skill_watcher.start();

    let data_dir = config::Config::data_dir();
    let bootstrap_watcher =
        agent::BootstrapWatcher::new(bootstrap_content_handle, bootstrap_files_handle, data_dir);
    let bootstrap_watcher_handle = bootstrap_watcher.start();

    #[cfg(feature = "embeddings")]
    let (watch_update_tx, rag_watcher_handle) = {
        if let Some(ref rag) = context.rag_engine {
            let legacy_dirs: Vec<std::path::PathBuf> = context
                .config
                .knowledge
                .watch_dirs
                .iter()
                .filter_map(|d| {
                    if d.starts_with("~/") {
                        dirs::home_dir().map(|h| h.join(&d[2..]))
                    } else {
                        Some(std::path::PathBuf::from(d))
                    }
                })
                .collect();
            let (tx, rx) = tokio::sync::mpsc::channel(16);
            let w = rag::watcher::RagWatcher::new(
                rag.clone(),
                context.db_for_watcher.clone(),
                legacy_dirs,
                rx,
            );
            (Some(tx), Some(w.start()))
        } else {
            (None, None)
        }
    };

    RuntimeServices {
        registry,
        agent,
        subagent_manager_for_estop,
        workflow_engine,
        workflow_event_rx,
        _skill_watcher_handle: skill_watcher_handle,
        _bootstrap_watcher_handle: bootstrap_watcher_handle,
        #[cfg(feature = "embeddings")]
        watch_update_tx,
        #[cfg(feature = "embeddings")]
        _rag_watcher_handle: rag_watcher_handle,
    }
}

pub async fn run_gateway() -> Result<()> {
    let pid_file = gateway_process::prepare_pid_file()?;

    let startup_t0 = std::time::Instant::now();
    let RuntimeSetup {
        config,
        db,
        shared_config,
        health_tracker,
        provider,
    } = load_runtime_setup(startup_t0).await?;

    let session_manager = SessionManager::new(db.clone());

    let (cron_event_tx, cron_event_rx) = tokio::sync::mpsc::channel(50);
    let contact_event_tx = cron_event_tx.clone();
    let cron_scheduler = Arc::new(CronScheduler::new(db.clone(), cron_event_tx));

    let _contact_event_scanner = crate::contacts::events::start_event_scanner(
        db.clone(),
        shared_config.clone(),
        contact_event_tx,
    );

    let GatewayToolSetup {
        registry: mut tool_registry,
        spawn_manager_cell,
        workflow_engine_cell,
    } = build_gateway_tool_registry(&config, db.clone(), shared_config.clone());

    #[cfg(feature = "mcp")]
    let mcp_servers_config = config.mcp.servers.clone();
    #[cfg(feature = "mcp")]
    let mcp_sandbox_config = config.security.execution_sandbox.clone();
    #[cfg(feature = "mcp")]
    let mcp_shared_config = shared_config.clone();
    #[cfg(all(feature = "mcp", feature = "browser"))]
    let config_for_pool = shared_config.clone();

    let (tool_msg_tx, tool_msg_rx) = tokio::sync::mpsc::channel(100);

    #[cfg(feature = "embeddings")]
    let db_for_searcher = db.clone();
    #[cfg(not(feature = "embeddings"))]
    let _db_for_searcher = db.clone();
    let db_for_web = db.clone();
    #[cfg(feature = "embeddings")]
    let db_for_watcher = db.clone();

    #[cfg(feature = "embeddings")]
    let rag_engine = {
        let rag = crate::try_create_rag_engine(db.clone(), &config);
        if let Some(ref engine) = rag {
            if let Err(e) = engine.lock().await.reindex_if_needed().await {
                tracing::warn!(error = %e, "Failed to reindex RAG at startup");
            }
            tool_registry.register(Box::new(tools::KnowledgeTool::new(engine.clone())));
        }
        rag
    };
    #[cfg(not(feature = "embeddings"))]
    let _rag_engine: Option<()> = None;
    tracing::info!(
        elapsed_ms = startup_t0.elapsed().as_millis(),
        "⏱ RAG engine ready"
    );

    let tool_names: Vec<String> = tool_registry
        .names()
        .iter()
        .map(|s| s.to_string())
        .collect();
    let tool_registry = Arc::new(tokio::sync::RwLock::new(tool_registry));

    let mut registry = if provider.is_some() {
        let definitions = agent::AgentDefinition::resolve_all(&config);
        let reg = agent::AgentRegistry::build(
            definitions,
            shared_config.clone(),
            session_manager.clone(),
            tool_registry,
            db,
        )
        .await?;
        Some(reg)
    } else {
        None
    };

    let skill_registry = load_skill_registry().await;
    configure_agent_registry(
        &mut registry,
        AgentRegistryContext {
            config: &config,
            shared_config: shared_config.clone(),
            skill_registry: skill_registry.clone(),
            tool_msg_tx: tool_msg_tx.clone(),
            tool_names: &tool_names,
            #[cfg(feature = "embeddings")]
            db_for_searcher,
            #[cfg(feature = "embeddings")]
            rag_engine: rag_engine.clone(),
        },
    )
    .await;

    let Some(registry) = registry else {
        #[cfg(feature = "web-ui")]
        {
            let web_config = config.clone();
            let web_port = config.channels.web.port;
            let web_server = crate::web::server::WebServer::setup_only(web_config).await;
            tokio::spawn(async move {
                if let Err(e) = web_server.start().await {
                    tracing::error!(error = %e, "Web UI server failed");
                }
            });
            tracing::info!(
                url = %crate::local_web_ui_url(&config),
                port = web_port,
                "Web UI available"
            );
            tracing::info!("Gateway running in setup mode. Configure a provider via Web UI.");
            tokio::signal::ctrl_c().await?;
            return Ok(());
        }
        #[cfg(not(feature = "web-ui"))]
        {
            tracing::error!(
                "No provider configured and web-ui feature is disabled. Cannot start gateway."
            );
            return Err(anyhow::anyhow!(
                "No provider configured. Enable web-ui feature or configure a provider."
            ));
        }
    };

    let RuntimeServices {
        registry,
        agent,
        subagent_manager_for_estop,
        workflow_engine,
        workflow_event_rx,
        _skill_watcher_handle,
        _bootstrap_watcher_handle,
        #[cfg(feature = "embeddings")]
        watch_update_tx,
        #[cfg(feature = "embeddings")]
        _rag_watcher_handle,
    } = start_runtime_services(RuntimeServicesContext {
        config: &config,
        db_for_web: db_for_web.clone(),
        registry,
        cron_scheduler: cron_scheduler.clone(),
        spawn_manager_cell,
        workflow_engine_cell,
        #[cfg(feature = "embeddings")]
        rag_engine: rag_engine.clone(),
        #[cfg(feature = "embeddings")]
        db_for_watcher,
    });

    #[cfg(feature = "mcp")]
    let agent_for_mcp_deferred = agent.clone();
    let mut gateway = agent::Gateway::new(
        registry,
        shared_config,
        session_manager,
        cron_scheduler,
        cron_event_rx,
        db_for_web,
    );
    gateway.set_tool_message_rx(tool_msg_rx);
    gateway.set_health_tracker(health_tracker);
    gateway.set_workflow_engine(workflow_engine, workflow_event_rx);
    #[cfg(feature = "embeddings")]
    if let Some(tx) = watch_update_tx {
        gateway.set_watch_update_tx(tx);
    }

    let estop_arc = gateway.estop_handles();
    {
        let mut estop = estop_arc.write().await;
        estop.subagent_manager = Some(subagent_manager_for_estop);
    }

    #[cfg(feature = "mcp")]
    let _mcp_handle = {
        let agent_for_mcp = agent_for_mcp_deferred;
        let estop_for_mcp = estop_arc.clone();
        let startup_t0_mcp = startup_t0;
        tokio::spawn(async move {
            let (mut mcp_manager, mcp_tools) = McpManager::start_with_sandbox(
                &mcp_servers_config,
                Some(mcp_sandbox_config.clone()),
                Some(mcp_shared_config),
            )
            .await;

            let mut regular_tools: Vec<Box<dyn crate::tools::Tool>> = Vec::new();
            for tool in mcp_tools {
                if !crate::browser::is_browser_tool(tool.name()) {
                    regular_tools.push(tool);
                }
            }

            agent_for_mcp.register_deferred_tools(regular_tools).await;

            #[cfg(feature = "browser")]
            {
                let browser_peer = if let Some(peer) = mcp_manager.take_browser_peer() {
                    Some(peer)
                } else {
                    let browser_name = crate::browser::BROWSER_MCP_SERVER_NAME;
                    if let Some(browser_cfg) = mcp_servers_config.get(browser_name) {
                        tracing::warn!(
                            "⚠️ Browser MCP failed on first attempt — retrying with backoff"
                        );
                        const MAX_RETRIES: u32 = 5;
                        const DELAYS: [u64; 5] = [10, 20, 40, 60, 120];
                        let mut connected = None;
                        for attempt in 0..MAX_RETRIES {
                            let delay = std::time::Duration::from_secs(DELAYS[attempt as usize]);
                            tokio::time::sleep(delay).await;
                            tracing::info!(
                                attempt = attempt + 1,
                                delay_secs = delay.as_secs(),
                                "🔄 Retrying browser MCP connection"
                            );
                            match McpManager::connect_peer(
                                browser_name,
                                browser_cfg,
                                &mcp_sandbox_config,
                            )
                            .await
                            {
                                Ok(peer) => {
                                    tracing::info!(
                                        "✅ Browser MCP connected on retry {}",
                                        attempt + 1
                                    );
                                    connected = Some(peer);
                                    break;
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        attempt = attempt + 1,
                                        error = %e,
                                        "Browser MCP retry failed"
                                    );
                                }
                            }
                        }
                        connected
                    } else {
                        None
                    }
                };

                if let Some(peer) = browser_peer {
                    let browser_pool = std::sync::Arc::new(crate::browser::BrowserPool::new(
                        config_for_pool.clone(),
                    ));
                    browser_pool
                        .set_default_peer(
                            &config_for_pool.read().await.browser.default_profile,
                            peer.clone(),
                        )
                        .await;
                    let monitor_pool_ref = browser_pool.clone();
                    let browser_tool = crate::tools::BrowserTool::new(peer, Some(browser_pool));
                    let session = browser_tool.session();
                    agent_for_mcp
                        .register_deferred_tools(vec![Box::new(browser_tool)])
                        .await;
                    agent_for_mcp.set_browser_session(session.clone()).await;
                    estop_for_mcp.write().await.browser_session = Some(session.clone());

                    let monitor_session = session;
                    let monitor_pool = monitor_pool_ref;
                    tokio::spawn(async move {
                        const CHECK_INTERVAL_SECS: u64 = 60;
                        const POOL_IDLE_TIMEOUT_SECS: u64 = 600;
                        let mut last_active: std::collections::HashMap<String, std::time::Instant> =
                            std::collections::HashMap::new();

                        loop {
                            tokio::time::sleep(std::time::Duration::from_secs(CHECK_INTERVAL_SECS))
                                .await;

                            monitor_session
                                .close_idle_tabs(crate::tools::browser::browser_idle_timeout_secs())
                                .await;

                            let active = monitor_pool.active_profiles().await;
                            let now = std::time::Instant::now();
                            let default_profile = {
                                let config = config_for_pool.read().await;
                                config.browser.default_profile.clone()
                            };

                            for name in &active {
                                if monitor_session.has_any_active().await
                                    || !last_active.contains_key(name)
                                {
                                    last_active.insert(name.clone(), now);
                                }
                            }

                            let idle_threshold =
                                std::time::Duration::from_secs(POOL_IDLE_TIMEOUT_SECS);
                            let profiles_to_close: Vec<String> = last_active
                                .iter()
                                .filter(|(name, last)| {
                                    **name != default_profile
                                        && now.duration_since(**last) > idle_threshold
                                })
                                .map(|(name, _)| name.clone())
                                .collect();

                            for name in profiles_to_close {
                                tracing::info!(
                                    profile = %name,
                                    "Shutting down idle browser profile (>10 min inactive)"
                                );
                                monitor_pool.shutdown_profile(&name).await;
                                last_active.remove(&name);
                            }

                            let active_set: std::collections::HashSet<String> =
                                active.into_iter().collect();
                            last_active.retain(|k, _| active_set.contains(k));
                        }
                    });

                    tracing::info!("🌐 Browser tool registered successfully");
                } else {
                    tracing::warn!(
                        "⚠️ Browser MCP peer not available after retries — browser tool will NOT be registered. \
                         Check that @playwright/mcp is installed: npx @playwright/mcp --help"
                    );
                }
            }

            estop_for_mcp.write().await.mcp_manager = Some(std::sync::Arc::new(mcp_manager));

            tracing::info!(
                elapsed_ms = startup_t0_mcp.elapsed().as_millis(),
                "⏱ MCP servers connected (deferred)"
            );
        })
    };

    tracing::info!(
        elapsed_ms = startup_t0.elapsed().as_millis(),
        "⏱ gateway ready, starting channels"
    );
    let result = gateway.run().await;

    gateway_process::cleanup_pid_file(&pid_file);

    result
}
