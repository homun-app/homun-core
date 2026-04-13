use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use axum::Router;
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

#[cfg(feature = "web-ui")]
use std::path::Path;

use crate::bus::{InboundMessage, OutboundMessage, StreamMessage};
use crate::config::Config;
use crate::provider::ProviderHealthTracker;
use crate::security::EStopHandles;
use crate::storage::Database;
use crate::workflows::engine::WorkflowEngine;

use super::api;
use super::auth;
use super::pages;
use super::run_state::WebRunStore;
use super::ws;

/// Shared state accessible by all web handlers.
/// The config Arc is shared with the AgentLoop for hot-reload:
/// web UI writes → agent reads on next request.
pub struct AppState {
    pub config: Arc<tokio::sync::RwLock<Config>>,
    pub started_at: Instant,
    pub public_base_url: Option<String>,
    pub inbound_tx: Option<mpsc::Sender<InboundMessage>>,
    pub web_runs: Arc<WebRunStore>,
    /// Active WebSocket sessions: chat_id → sender for outbound messages
    pub ws_sessions: tokio::sync::RwLock<std::collections::HashMap<String, mpsc::Sender<String>>>,
    /// Stream sessions: chat_id → sender for real-time stream chunks and tool events.
    /// Used to deliver incremental text as the LLM generates it,
    /// plus tool_start/tool_end notifications.
    pub stream_sessions: tokio::sync::RwLock<
        std::collections::HashMap<String, mpsc::Sender<super::ws::WsStreamEvent>>,
    >,
    /// Database handle — used by memory/vault API endpoints.
    /// `None` in setup-only mode (no agent, just config UI).
    pub db: Option<Database>,
    /// Shared memory searcher for hybrid vector + FTS5 search.
    /// Shared with the AgentLoop — both use the same HNSW index.
    #[cfg(feature = "embeddings")]
    pub memory_searcher: Option<Arc<tokio::sync::Mutex<crate::agent::MemorySearcher>>>,
    /// Shared RAG knowledge base engine.
    #[cfg(feature = "embeddings")]
    pub rag_engine: Option<Arc<tokio::sync::Mutex<crate::rag::RagEngine>>>,
    /// Provider health tracker for circuit breaker metrics.
    pub health_tracker: Option<Arc<ProviderHealthTracker>>,
    /// Channel health tracker for circuit breaker + restart monitoring.
    pub channel_health: Option<Arc<crate::channels::ChannelHealthTracker>>,
    /// Workflow engine for multi-step orchestration.
    pub workflow_engine: Option<Arc<WorkflowEngine>>,
    /// Emergency stop handles — shared with the estop module.
    pub estop_handles: Arc<tokio::sync::RwLock<EStopHandles>>,
    /// Web authentication session store (SEC-1).
    pub session_store: Option<Arc<auth::SessionStore>>,
    /// Rate limiter for auth endpoints — 5 req/min per IP (SEC-3).
    pub auth_rate_limiter: Arc<auth::RateLimiter>,
    /// Rate limiter for general API — 60 req/min per IP (SEC-3).
    pub api_rate_limiter: Arc<auth::RateLimiter>,
    /// Rate limiter for Bearer token API calls — 60 req/min per token (SEC-4c).
    pub token_rate_limiter: Arc<auth::RateLimiter<String>>,
    /// Tool registry — shared with AgentLoop for listing registered tools.
    pub tool_registry: Option<Arc<tokio::sync::RwLock<crate::tools::ToolRegistry>>>,
    /// Channel command sender — for hot-starting channels after config/pairing.
    pub channel_cmd_tx: Option<mpsc::Sender<crate::agent::gateway::ChannelCommand>>,
    /// Signal the RAG watcher to reload its watch list from DB.
    #[cfg(feature = "embeddings")]
    pub watch_update_tx: Option<mpsc::Sender<crate::rag::watcher::WatchUpdate>>,
}

impl AppState {
    /// Save config to disk AND update the in-memory copy atomically.
    /// Since config is shared via Arc, the AgentLoop sees changes on next request.
    pub async fn save_config(&self, config: Config) -> anyhow::Result<()> {
        config.save()?;
        *self.config.write().await = config;
        Ok(())
    }

    /// Persist a specific config section to the DB (primary) and TOML (backup).
    ///
    /// Reads the current in-memory config, serializes the requested
    /// section to JSON, writes it to the `settings` table, and also
    /// calls `config.save()` so the TOML stays in sync as a human-
    /// readable backup.
    pub async fn save_config_section(&self, section: &str) -> anyhow::Result<()> {
        let config = self.config.read().await;
        let value = match section {
            // Security
            crate::config::SECTION_SANDBOX => {
                serde_json::to_string(&config.security.execution_sandbox)?
            }
            crate::config::SECTION_EXFILTRATION => {
                serde_json::to_string(&config.security.exfiltration)?
            }
            // Permissions
            crate::config::SECTION_PERMISSIONS => serde_json::to_string(&config.permissions)?,
            // Agent
            crate::config::SECTION_AGENT => serde_json::to_string(&config.agent)?,
            // Channels
            crate::config::SECTION_TELEGRAM => serde_json::to_string(&config.channels.telegram)?,
            crate::config::SECTION_WHATSAPP => serde_json::to_string(&config.channels.whatsapp)?,
            crate::config::SECTION_DISCORD => serde_json::to_string(&config.channels.discord)?,
            crate::config::SECTION_SLACK => serde_json::to_string(&config.channels.slack)?,
            crate::config::SECTION_EMAIL => serde_json::to_string(&config.channels.emails)?,
            crate::config::SECTION_WEB => serde_json::to_string(&config.channels.web)?,
            // Tools
            crate::config::SECTION_EXEC => serde_json::to_string(&config.tools.exec)?,
            // Browser
            crate::config::SECTION_BROWSER => serde_json::to_string(&config.browser)?,
            // MCP
            crate::config::SECTION_MCP => serde_json::to_string(&config.mcp)?,
            // Providers
            crate::config::SECTION_PROVIDERS => serde_json::to_string(&config.providers)?,
            // Storage
            crate::config::SECTION_STORAGE => serde_json::to_string(&config.storage)?,
            // UI
            crate::config::SECTION_UI => serde_json::to_string(&config.ui)?,
            // Agents (multi-agent definitions)
            crate::config::SECTION_AGENTS => serde_json::to_string(&config.agents)?,
            // Routing
            crate::config::SECTION_ROUTING => serde_json::to_string(&config.routing)?,
            other => anyhow::bail!("Unknown settings section: {other}"),
        };
        if let Some(ref db) = self.db {
            db.set_settings_section(section, &value).await?;
        }
        // TOML backup — best-effort, don't fail the request if TOML write fails
        if let Err(e) = config.save() {
            tracing::warn!(section, error = %e, "TOML backup write failed (DB is primary)");
        }
        Ok(())
    }
}

fn mobile_reachable_base_url(domain: &str, tunnel_url: Option<&String>) -> Option<String> {
    if let Some(url) = tunnel_url {
        return Some(url.clone());
    }

    let normalized = domain.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized == "localhost"
        || normalized == "127.0.0.1"
        || normalized == "::1"
        || normalized == "[::1]"
    {
        None
    } else {
        Some(format!("https://{domain}"))
    }
}

/// Web server — embedded dashboard + REST API + WebSocket chat
pub struct WebServer {
    config: Arc<tokio::sync::RwLock<Config>>,
    inbound_tx: Option<mpsc::Sender<InboundMessage>>,
    outbound_rx: Option<mpsc::Receiver<OutboundMessage>>,
    stream_rx: Option<mpsc::Receiver<StreamMessage>>,
    db: Option<Database>,
    #[cfg(feature = "embeddings")]
    memory_searcher: Option<Arc<tokio::sync::Mutex<crate::agent::MemorySearcher>>>,
    #[cfg(feature = "embeddings")]
    rag_engine: Option<Arc<tokio::sync::Mutex<crate::rag::RagEngine>>>,
    health_tracker: Option<Arc<ProviderHealthTracker>>,
    channel_health: Option<Arc<crate::channels::ChannelHealthTracker>>,
    workflow_engine: Option<Arc<WorkflowEngine>>,
    estop_handles: Arc<tokio::sync::RwLock<EStopHandles>>,
    tool_registry: Option<Arc<tokio::sync::RwLock<crate::tools::ToolRegistry>>>,
    channel_cmd_tx: Option<mpsc::Sender<crate::agent::gateway::ChannelCommand>>,
    #[cfg(feature = "embeddings")]
    watch_update_tx: Option<mpsc::Sender<crate::rag::watcher::WatchUpdate>>,
}

impl WebServer {
    /// Create a web server that shares config with the agent for hot-reload.
    pub fn new(
        config: Arc<tokio::sync::RwLock<Config>>,
        inbound_tx: mpsc::Sender<InboundMessage>,
        outbound_rx: mpsc::Receiver<OutboundMessage>,
        db: Database,
    ) -> Self {
        Self {
            config,
            inbound_tx: Some(inbound_tx),
            outbound_rx: Some(outbound_rx),
            stream_rx: None,
            db: Some(db),
            #[cfg(feature = "embeddings")]
            memory_searcher: None,
            #[cfg(feature = "embeddings")]
            rag_engine: None,
            health_tracker: None,
            channel_health: None,
            workflow_engine: None,
            estop_handles: Arc::new(tokio::sync::RwLock::new(EStopHandles::default())),
            tool_registry: None,
            channel_cmd_tx: None,
            #[cfg(feature = "embeddings")]
            watch_update_tx: None,
        }
    }

    /// Set the shared memory searcher for hybrid search in the web API.
    #[cfg(feature = "embeddings")]
    pub fn set_memory_searcher(
        &mut self,
        searcher: Arc<tokio::sync::Mutex<crate::agent::MemorySearcher>>,
    ) {
        self.memory_searcher = Some(searcher);
    }

    /// Set the shared RAG engine for knowledge base API endpoints.
    #[cfg(feature = "embeddings")]
    pub fn set_rag_engine(&mut self, engine: Arc<tokio::sync::Mutex<crate::rag::RagEngine>>) {
        self.rag_engine = Some(engine);
    }

    /// Set the provider health tracker for the `/api/v1/providers/health` endpoint.
    pub fn set_health_tracker(&mut self, tracker: Arc<ProviderHealthTracker>) {
        self.health_tracker = Some(tracker);
    }

    pub fn set_channel_health(&mut self, tracker: Arc<crate::channels::ChannelHealthTracker>) {
        self.channel_health = Some(tracker);
    }

    /// Set the tool registry for the /v1/tools endpoint.
    pub fn set_tool_registry(
        &mut self,
        registry: Arc<tokio::sync::RwLock<crate::tools::ToolRegistry>>,
    ) {
        self.tool_registry = Some(registry);
    }

    pub fn set_channel_cmd_tx(&mut self, tx: mpsc::Sender<crate::agent::gateway::ChannelCommand>) {
        self.channel_cmd_tx = Some(tx);
    }

    /// Set the RAG watcher update channel for hot-reloading watches from DB.
    #[cfg(feature = "embeddings")]
    pub fn set_watch_update_tx(&mut self, tx: mpsc::Sender<crate::rag::watcher::WatchUpdate>) {
        self.watch_update_tx = Some(tx);
    }

    /// Set the workflow engine for multi-step orchestration API endpoints.
    pub fn set_workflow_engine(&mut self, engine: Arc<WorkflowEngine>) {
        self.workflow_engine = Some(engine);
    }

    /// Set the emergency stop handles (shared with the estop module).
    pub fn set_estop_handles(&mut self, handles: Arc<tokio::sync::RwLock<EStopHandles>>) {
        self.estop_handles = handles;
    }

    /// Set the receiver for streaming chunks from the gateway.
    /// When the agent streams text for a web chat session, the gateway
    /// sends StreamMessage chunks here so they can be forwarded to the
    /// correct WebSocket connection.
    pub fn set_stream_rx(&mut self, rx: mpsc::Receiver<StreamMessage>) {
        self.stream_rx = Some(rx);
    }

    /// Create a setup-only server (no agent, just config UI).
    /// Wraps config in its own Arc — not shared with any agent.
    /// The database is initialized so that the setup wizard can create admin accounts.
    pub async fn setup_only(config: Config) -> Self {
        // Open DB so auth/setup endpoints work even in setup-only mode
        let db = match crate::storage::Database::open(&config.storage.resolved_path()).await {
            Ok(db) => {
                tracing::info!("Database initialized for setup-only mode");
                Some(db)
            }
            Err(e) => {
                tracing::warn!(error = %e, "Failed to open database in setup-only mode");
                None
            }
        };
        Self {
            config: Arc::new(tokio::sync::RwLock::new(config)),
            inbound_tx: None,
            outbound_rx: None,
            stream_rx: None,
            db,
            #[cfg(feature = "embeddings")]
            memory_searcher: None,
            #[cfg(feature = "embeddings")]
            rag_engine: None,
            health_tracker: None,
            channel_health: None,
            workflow_engine: None,
            estop_handles: Arc::new(tokio::sync::RwLock::new(EStopHandles::default())),
            tool_registry: None,
            channel_cmd_tx: None,
            #[cfg(feature = "embeddings")]
            watch_update_tx: None,
        }
    }

    /// Start the web server. Runs until the server is shut down.
    pub async fn start(self) -> Result<()> {
        let (
            host,
            port,
            domain,
            rate_limit,
            auth_rate_limit,
            tls_cert,
            tls_key,
            auto_tls,
            session_ttl,
            tunnel_config,
        ) = {
            let cfg = self.config.read().await;
            (
                cfg.channels.web.host.clone(),
                cfg.channels.web.port,
                cfg.channels.web.domain.clone(),
                cfg.channels.web.rate_limit_per_minute,
                cfg.channels.web.auth_rate_limit_per_minute,
                cfg.channels.web.tls_cert.clone(),
                cfg.channels.web.tls_key.clone(),
                cfg.channels.web.auto_tls,
                cfg.channels.web.session_ttl_secs,
                cfg.channels.web.tunnel.clone(),
            )
        };

        let tls_config = build_tls_config(&tls_cert, &tls_key, auto_tls, &domain).await;
        let local_tunnel_target = if tls_config.is_some() {
            format!("https://localhost:{port}")
        } else {
            format!("http://localhost:{port}")
        };

        // Start tunnel if configured (before building the router so CORS can use the URL)
        let tunnel_url: Option<String> = if let Some(ref tc) = tunnel_config {
            if tc.enabled {
                match super::tunnel::create_tunnel(tc) {
                    Ok(mut tunnel) => match tunnel.start(port, &local_tunnel_target).await {
                        Ok(url) => {
                            tracing::info!(
                                provider = tunnel.name(),
                                url = %url,
                                "Tunnel active — web UI accessible externally"
                            );
                            // Keep the tunnel process alive in the background
                            tokio::spawn(async move {
                                // Tunnel runs until the process exits or is killed
                                // (kill_on_drop handles cleanup when this task is dropped)
                                tokio::signal::ctrl_c().await.ok();
                                let _ = tunnel.stop().await;
                            });
                            Some(url)
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "Tunnel failed to start — continuing without");
                            None
                        }
                    },
                    Err(e) => {
                        tracing::warn!(error = %e, "Invalid tunnel config — continuing without");
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

        if let Some(db) = self.db.as_ref() {
            let interrupted = db.mark_incomplete_web_chat_runs_interrupted().await?;
            if interrupted > 0 {
                tracing::warn!(
                    count = interrupted,
                    "Marked stale web chat runs as interrupted"
                );
            }
        }

        // Initialize session store (may fail if vault is not available — that's OK in setup mode)
        let session_store = match auth::SessionStore::new(session_ttl) {
            Ok(store) => {
                tracing::info!("Web session store initialized");
                Some(Arc::new(store))
            }
            Err(e) => {
                tracing::warn!(error = %e, "Failed to initialize session store (auth disabled)");
                None
            }
        };

        let auth_rate_limiter = Arc::new(auth::RateLimiter::new(auth_rate_limit, 60));
        let api_rate_limiter = Arc::new(auth::RateLimiter::new(rate_limit, 60));
        let token_rate_limiter = Arc::new(auth::RateLimiter::<String>::new(rate_limit, 60));

        let state = Arc::new(AppState {
            config: self.config,
            started_at: Instant::now(),
            public_base_url: mobile_reachable_base_url(&domain, tunnel_url.as_ref()),
            inbound_tx: self.inbound_tx,
            web_runs: Arc::new(WebRunStore::default()),
            ws_sessions: tokio::sync::RwLock::new(std::collections::HashMap::new()),
            stream_sessions: tokio::sync::RwLock::new(std::collections::HashMap::new()),
            db: self.db,
            #[cfg(feature = "embeddings")]
            memory_searcher: self.memory_searcher,
            #[cfg(feature = "embeddings")]
            rag_engine: self.rag_engine,
            health_tracker: self.health_tracker,
            channel_health: self.channel_health,
            workflow_engine: self.workflow_engine,
            estop_handles: self.estop_handles,
            session_store: session_store.clone(),
            auth_rate_limiter: auth_rate_limiter.clone(),
            api_rate_limiter: api_rate_limiter.clone(),
            token_rate_limiter: token_rate_limiter.clone(),
            tool_registry: self.tool_registry,
            channel_cmd_tx: self.channel_cmd_tx,
            #[cfg(feature = "embeddings")]
            watch_update_tx: self.watch_update_tx,
        });

        // If we have outbound messages, spawn task to route them to WebSocket sessions
        if let Some(mut outbound_rx) = self.outbound_rx {
            let state_for_outbound = state.clone();
            tokio::spawn(async move {
                while let Some(msg) = outbound_rx.recv().await {
                    if msg.channel == "web" {
                        let session_key = format!("web:{}", msg.chat_id);
                        if let Some(run) = state_for_outbound
                            .web_runs
                            .complete_run(&session_key, &msg.content)
                        {
                            if let Some(db) = state_for_outbound.db.as_ref() {
                                if let Err(error) = db.upsert_web_chat_run(&run).await {
                                    tracing::error!(run_id = %run.run_id, %error, "Failed to persist completed web chat run");
                                }
                            }
                        }
                    }
                    // Web channel: if the outbound message carries a file attachment,
                    // emit a ResultBlock with View + Download buttons before the text.
                    // Other channels (Telegram, WhatsApp) handle file_path natively;
                    // the web channel needs to translate it into a UI block.
                    if msg.channel == "web" {
                        if let Some(ref fp) = msg.file_path {
                            let path = std::path::Path::new(fp);
                            if path.exists() {
                                let size = path.metadata().map(|m| m.len() as usize).unwrap_or(0);
                                if let Some(block) =
                                    crate::tools::file::build_workspace_file_block(path, size)
                                {
                                    let blocks_json =
                                        serde_json::to_string(&vec![block]).unwrap_or_default();
                                    let streams = state_for_outbound.stream_sessions.read().await;
                                    if let Some(stream_tx) = streams.get(&msg.chat_id) {
                                        let _ = stream_tx
                                            .send(super::ws::WsStreamEvent {
                                                delta: blocks_json,
                                                event_type: Some("blocks".to_string()),
                                                tool_call_data: None,
                                            })
                                            .await;
                                    }
                                }
                            }
                        }
                    }

                    let sessions = state_for_outbound.ws_sessions.read().await;
                    if let Some(tx) = sessions.get(&msg.chat_id) {
                        if tx.send(msg.content).await.is_err() {
                            tracing::warn!(chat_id = %msg.chat_id, "WebSocket session closed");
                        }
                    } else {
                        tracing::debug!(
                            chat_id = %msg.chat_id,
                            "No WebSocket session found for outbound message"
                        );
                    }
                }
            });
        }

        // If we have stream messages, spawn task to forward chunks to WebSocket stream sessions
        if let Some(mut stream_rx) = self.stream_rx {
            let state_for_stream = state.clone();
            tokio::spawn(async move {
                while let Some(msg) = stream_rx.recv().await {
                    if !msg.chat_id.is_empty() {
                        let session_key = format!("web:{}", msg.chat_id);
                        let stream_done = msg.done;
                        if let Some(run) = state_for_stream
                            .web_runs
                            .append_stream_message(&session_key, &msg)
                        {
                            if let Some(db) = state_for_stream.db.as_ref() {
                                if let Err(error) = db.upsert_web_chat_run(&run).await {
                                    tracing::error!(run_id = %run.run_id, %error, "Failed to persist streaming web chat run");
                                }
                            }
                        }

                        // Stream signals end-of-turn (`done: true`) — finalize the run
                        // so a tab focus won't re-hydrate it from DB. Idempotent: if the
                        // outbound path already called `complete_run`, this is a no-op.
                        if stream_done {
                            if let Some(run) = state_for_stream
                                .web_runs
                                .finalize_streaming_run(&session_key)
                            {
                                if let Some(db) = state_for_stream.db.as_ref() {
                                    if let Err(error) = db.upsert_web_chat_run(&run).await {
                                        tracing::error!(run_id = %run.run_id, %error, "Failed to persist finalized web chat run");
                                    }
                                }
                            }
                        }
                    }
                    let streams = state_for_stream.stream_sessions.read().await;
                    if let Some(tx) = streams.get(&msg.chat_id) {
                        let event = super::ws::WsStreamEvent {
                            delta: msg.delta,
                            event_type: msg.event_type,
                            tool_call_data: msg.tool_call_data,
                        };
                        if tx.send(event).await.is_err() {
                            tracing::debug!(chat_id = %msg.chat_id, "Stream session closed");
                        }
                    }
                }
            });
        }

        // Spawn session + rate limiter + stale run cleanup task (every 5 minutes)
        {
            let session_store_clone = session_store.clone();
            let auth_rl = auth_rate_limiter.clone();
            let api_rl = api_rate_limiter.clone();
            let token_rl = token_rate_limiter.clone();
            let state_for_cleanup = state.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(300));
                loop {
                    interval.tick().await;
                    if let Some(ref store) = session_store_clone {
                        store.cleanup_expired().await;
                    }
                    auth_rl.cleanup().await;
                    api_rl.cleanup().await;
                    token_rl.cleanup().await;
                    // Expire web chat runs stuck in "running" for >10 min (orphaned)
                    // and persist the updated snapshots to DB.
                    let expired = state_for_cleanup.web_runs.expire_stale_runs(600);
                    if let Some(db) = state_for_cleanup.db.as_ref() {
                        for run in &expired {
                            if let Err(e) = db.upsert_web_chat_run(run).await {
                                tracing::warn!(run_id = %run.run_id, error = %e, "Failed to persist expired run");
                            }
                        }
                    }
                }
            });
        }

        // ─── Router: public vs protected ────────────────────────────

        // Auth routes with strict rate limiting (SEC-3: 5 req/min)
        let auth_routes = Router::new()
            .route("/api/auth/login", axum::routing::post(auth::login_handler))
            .route("/api/auth/setup", axum::routing::post(auth::setup_handler))
            .route(
                "/api/auth/device-approve",
                axum::routing::post(auth::device_approve_handler),
            )
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::auth_rate_limit_middleware,
            ));

        // Public routes — no auth required
        let public = Router::new()
            .route("/login", axum::routing::get(pages::login_page))
            .route(
                "/setup-wizard",
                axum::routing::get(pages::setup_wizard_page),
            )
            .route("/api/health", axum::routing::get(api::health))
            .route(
                "/api/v1/webhook/{token}",
                axum::routing::post(api::webhook_ingress),
            )
            .merge(api::public_router())
            .merge(static_assets())
            .merge(auth_routes);

        // Protected routes — require auth (SEC-1 middleware + SEC-3 API rate limit)
        let protected = Router::new()
            .merge(pages::router())
            .route(
                "/api/auth/logout",
                axum::routing::post(auth::logout_handler),
            )
            .nest("/api", api::router())
            .merge(ws::router())
            .layer(axum::middleware::from_fn(auth::csrf_guard_middleware))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::api_rate_limit_middleware,
            ))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                auth::auth_middleware,
            ));

        let app = Router::new()
            .merge(public)
            .merge(protected)
            .layer(TraceLayer::new_for_http())
            .layer(
                CorsLayer::new()
                    .allow_origin(tower_http::cors::AllowOrigin::predicate({
                        let cors_domain = domain.clone();
                        let cors_tunnel_url = tunnel_url.clone();
                        move |origin, _| {
                            let s = origin.as_bytes();
                            let allowed_domain_http = format!("http://{cors_domain}");
                            let allowed_domain_https = format!("https://{cors_domain}");
                            s.starts_with(b"https://localhost")
                                || s.starts_with(b"https://127.0.0.1")
                                || s.starts_with(b"http://localhost")
                                || s.starts_with(b"http://127.0.0.1")
                                || (!cors_domain.is_empty()
                                    && (s == allowed_domain_https.as_bytes()
                                        || s == allowed_domain_http.as_bytes()))
                                || cors_tunnel_url
                                    .as_ref()
                                    .is_some_and(|url| s == url.trim_end_matches('/').as_bytes())
                        }
                    }))
                    .allow_methods([
                        axum::http::Method::GET,
                        axum::http::Method::POST,
                        axum::http::Method::PATCH,
                        axum::http::Method::DELETE,
                    ])
                    .allow_headers([
                        axum::http::header::CONTENT_TYPE,
                        axum::http::header::AUTHORIZATION,
                        axum::http::header::COOKIE,
                    ])
                    .allow_credentials(true),
            )
            .with_state(state);

        let addr: SocketAddr = format!("{host}:{port}")
            .parse()
            .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 18443)));

        let listener = tokio::net::TcpListener::bind(addr).await?;

        if let Some(tls_cfg) = tls_config {
            // One-shot system setup: hosts entry + cert trust + port forward
            // All privileged operations are batched into a single admin prompt.
            let is_local = domain.is_empty() || domain == "localhost" || domain.starts_with("127.");
            if !is_local {
                // Custom domain: set up /etc/hosts + cert trust, proxy port 443
                let cert_path = if auto_tls && tls_cert.is_empty() {
                    Some(Config::tls_dir().join("cert.pem"))
                } else {
                    None
                };
                setup_system(&domain, cert_path.as_deref());
                if port != 443 {
                    let proxy_target_port = port;
                    tokio::spawn(start_port_proxy(443, proxy_target_port));
                }
                tracing::info!(%addr, url = %format!("https://{domain}"), tunnel = ?tunnel_url, "Web UI starting (HTTPS)");
            } else {
                tracing::info!(%addr, url = %format!("https://localhost:{port}"), tunnel = ?tunnel_url, "Web UI starting (HTTPS)");
            }
            let acceptor = tokio_rustls::TlsAcceptor::from(tls_cfg);
            let make_service = app.into_make_service_with_connect_info::<SocketAddr>();

            // Manual accept loop for TLS
            loop {
                let (stream, remote_addr) = listener.accept().await?;
                let acceptor = acceptor.clone();
                let mut make_service = make_service.clone();
                tokio::spawn(async move {
                    match acceptor.accept(stream).await {
                        Ok(tls_stream) => {
                            use tower::Service;
                            let io = hyper_util::rt::TokioIo::new(tls_stream);
                            let Ok(svc) =
                                tower::Service::<SocketAddr>::call(&mut make_service, remote_addr)
                                    .await;
                            let hyper_svc = hyper_util::service::TowerToHyperService::new(svc);
                            // serve_connection_with_upgrades is required for WebSocket
                            // to work — without it, hyper won't release the TCP stream
                            // for the HTTP Upgrade mechanism that WS relies on.
                            let _ = hyper_util::server::conn::auto::Builder::new(
                                hyper_util::rt::TokioExecutor::new(),
                            )
                            .serve_connection_with_upgrades(io, hyper_svc)
                            .await;
                        }
                        Err(e) => {
                            tracing::debug!(error = %e, "TLS handshake failed");
                        }
                    }
                });
            }
        } else {
            tracing::info!(%addr, "Web UI starting (HTTP)");
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await?;
        }

        Ok(())
    }
}

/// Build a rustls ServerConfig from cert/key paths, or generate self-signed if `auto_tls` is set.
/// Returns `None` if TLS is not configured.
async fn build_tls_config(
    tls_cert: &str,
    tls_key: &str,
    auto_tls: bool,
    domain: &str,
) -> Option<Arc<rustls::ServerConfig>> {
    // Ensure ring CryptoProvider is installed
    let _ = rustls::crypto::ring::default_provider().install_default();

    let (cert_path, key_path) = if !tls_cert.is_empty() && !tls_key.is_empty() {
        // User-provided cert/key
        (
            std::path::PathBuf::from(tls_cert),
            std::path::PathBuf::from(tls_key),
        )
    } else if auto_tls {
        // Auto-generate self-signed cert
        let tls_dir = Config::tls_dir();
        let cert_path = tls_dir.join("cert.pem");
        let key_path = tls_dir.join("key.pem");

        // Only generate if files don't already exist
        if !cert_path.exists() || !key_path.exists() {
            // Collect extra domains for the certificate
            let extra_domains: Vec<&str> = if domain.is_empty() {
                vec![]
            } else {
                vec![domain]
            };
            if let Err(e) = generate_self_signed(&cert_path, &key_path, &extra_domains) {
                tracing::error!(error = %e, "Failed to generate self-signed TLS certificate");
                return None;
            }
            tracing::info!(cert = %cert_path.display(), "Generated self-signed TLS certificate");
        } else {
            tracing::info!(cert = %cert_path.display(), "Using existing self-signed TLS certificate");
        }
        (cert_path, key_path)
    } else {
        return None;
    };

    // Load cert chain — `tls_pem::load_cert_chain` opens the file and
    // parses in one call, and surfaces malformed PEM blocks as errors
    // instead of silently dropping them like the old API did.
    let certs = match crate::web::tls_pem::load_cert_chain(&cert_path) {
        Ok(c) if !c.is_empty() => c,
        Ok(_) => {
            tracing::error!(path = %cert_path.display(), "No valid certificates found in PEM file");
            return None;
        }
        Err(e) => {
            tracing::error!(error = %e, "Failed to load TLS cert chain");
            return None;
        }
    };

    // Load private key
    let key = match crate::web::tls_pem::load_private_key(&key_path) {
        Ok(k) => k,
        Err(e) => {
            tracing::error!(error = %e, "Failed to load TLS private key");
            return None;
        }
    };

    // Build ServerConfig with ALPN — HTTP/1.1 first so that WebSocket upgrade works.
    // HTTP/2 WebSocket requires Extended CONNECT (RFC 8441) which hyper doesn't enable
    // by default, so we prefer HTTP/1.1 to keep classic WS upgrade mechanism working.
    match rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
    {
        Ok(mut config) => {
            config.alpn_protocols = vec![b"http/1.1".to_vec(), b"h2".to_vec()];
            Some(Arc::new(config))
        }
        Err(e) => {
            tracing::error!(error = %e, "Failed to build TLS config");
            None
        }
    }
}

/// Generate a self-signed TLS certificate for localhost and optional extra domains.
fn generate_self_signed(cert_path: &Path, key_path: &Path, extra_domains: &[&str]) -> Result<()> {
    use std::io::Write;

    // Ensure parent directory exists
    if let Some(parent) = cert_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Build SAN list: localhost + any extra domains (e.g., "homun.example.com")
    let mut dns_names = vec!["localhost".to_string()];
    for domain in extra_domains {
        if !domain.is_empty() && *domain != "localhost" {
            dns_names.push(domain.to_string());
        }
    }

    let mut params = rcgen::CertificateParams::new(dns_names)?;
    params.distinguished_name = rcgen::DistinguishedName::new();
    params.distinguished_name.push(
        rcgen::DnType::CommonName,
        rcgen::DnValue::Utf8String("Homun Self-Signed".into()),
    );
    // Add IP SANs for localhost
    params
        .subject_alt_names
        .push(rcgen::SanType::IpAddress(std::net::IpAddr::V4(
            std::net::Ipv4Addr::new(127, 0, 0, 1),
        )));
    params
        .subject_alt_names
        .push(rcgen::SanType::IpAddress(std::net::IpAddr::V6(
            std::net::Ipv6Addr::LOCALHOST,
        )));
    // Valid for 10 years
    params.not_after = rcgen::date_time_ymd(2036, 1, 1);

    let key_pair = rcgen::KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;

    // Write cert PEM
    let mut cert_file = std::fs::File::create(cert_path)?;
    cert_file.write_all(cert.pem().as_bytes())?;

    // Write key PEM
    let mut key_file = std::fs::File::create(key_path)?;
    key_file.write_all(key_pair.serialize_pem().as_bytes())?;

    // Set restrictive permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600))?;
        std::fs::set_permissions(cert_path, std::fs::Permissions::from_mode(0o600))?;
    }

    Ok(())
}

/// One-shot system configuration: hosts entry + cert trust + port forward.
/// One-time system setup: hosts entry + cert trust.
///
/// - **Cert trust (macOS)**: login keychain with `-p ssl` — no admin needed
/// - **Cert trust (Linux)**: `update-ca-certificates` — needs admin
/// - **Cert trust (Windows)**: `certutil` — needs admin (UAC)
/// - **Hosts**: adds `127.0.0.1 <domain>` to `/etc/hosts` — needs admin
///
/// Port forwarding is handled separately via `start_port_proxy()` (in-process TCP proxy).
fn setup_system(domain: &str, cert_path: Option<&Path>) {
    let loopback = "127.0.0.1";

    let hosts_path = if cfg!(windows) {
        r"C:\Windows\System32\drivers\etc\hosts"
    } else {
        "/etc/hosts"
    };

    // ── Check what needs to be done ──────────────────────────────────
    let needs_hosts = !std::fs::read_to_string(hosts_path)
        .map(|c| c.contains(domain))
        .unwrap_or(false);

    let cert_marker = Config::tls_dir().join(".trusted");
    let needs_cert_trust = cert_path.is_some() && !cert_marker.exists();

    if !needs_hosts && !needs_cert_trust {
        tracing::debug!(domain, "System already configured");
        return;
    }

    // ── macOS: trust cert in login keychain (NO admin needed) ────────
    if needs_cert_trust {
        if let Some(cert) = cert_path {
            if cfg!(target_os = "macos") {
                let cert_str = cert.to_string_lossy();
                let ok = std::process::Command::new("security")
                    .args([
                        "add-trusted-cert",
                        "-p",
                        "ssl",
                        "-r",
                        "trustRoot",
                        "-k",
                        &format!(
                            "{}/Library/Keychains/login.keychain-db",
                            std::env::var("HOME").unwrap_or_default()
                        ),
                        &cert_str,
                    ])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if ok {
                    let _ = std::fs::write(&cert_marker, "");
                    tracing::info!("Trusted self-signed cert in login keychain");
                } else {
                    tracing::warn!(
                        "Could not trust cert in login keychain — browser will show warning"
                    );
                }
            }
        }
    }

    // ── Build privileged commands (hosts entry, Linux/Windows cert) ──
    let mut commands: Vec<String> = Vec::new();

    if needs_hosts {
        commands.push(format!("echo '{loopback}\t{domain}' >> {hosts_path}"));
    }

    if needs_cert_trust {
        if let Some(cert) = cert_path {
            let cert_str = cert.to_string_lossy();
            if cfg!(target_os = "linux") {
                commands.push(format!(
                    "cp {cert_str} /usr/local/share/ca-certificates/homun-self-signed.crt && update-ca-certificates"
                ));
            } else if cfg!(windows) {
                commands.push(format!("certutil -addstore -f ROOT {cert_str}"));
            }
        }
    }

    if commands.is_empty() {
        return;
    }

    let combined = commands.join(" && ");

    // ── Execute with a single privilege escalation ───────────────────
    let success = if cfg!(target_os = "macos") {
        let escaped = combined.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(r#"do shell script "{escaped}" with administrator privileges"#);
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    } else if cfg!(target_os = "linux") {
        std::process::Command::new("pkexec")
            .args(["sh", "-c", &combined])
            .status()
            .map(|s| s.success())
            .unwrap_or_else(|_| {
                std::process::Command::new("sudo")
                    .args(["sh", "-c", &combined])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            })
    } else if cfg!(windows) {
        let ps_cmd = format!("Start-Process cmd -ArgumentList '/c {combined}' -Verb RunAs -Wait");
        std::process::Command::new("powershell")
            .args(["-Command", &ps_cmd])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    } else {
        false
    };

    if success {
        if needs_cert_trust && !cfg!(target_os = "macos") {
            let _ = std::fs::write(&cert_marker, "");
        }
        let ops: Vec<&str> = [
            if needs_hosts { Some("hosts") } else { None },
            if needs_cert_trust {
                Some("cert-trust")
            } else {
                None
            },
        ]
        .into_iter()
        .flatten()
        .collect();
        tracing::info!(domain, operations = ?ops, "System configured");
    } else {
        tracing::warn!(
            domain,
            "Could not configure system (admin prompt declined?) — \
             add '{loopback}\t{domain}' to {hosts_path} manually"
        );
    }
}

/// In-process TCP proxy: binds on `listen_port` (e.g. 443) and forwards
/// all connections to `target_port` (e.g. 18443) on localhost.
///
/// This avoids pfctl/iptables entirely — works on all OS, no VPN conflicts.
/// Binding to port < 1024 requires admin on first run; subsequent runs
/// reuse the listener.
async fn start_port_proxy(listen_port: u16, target_port: u16) {
    let addr: SocketAddr = ([127, 0, 0, 1], listen_port).into();

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => {
            tracing::info!(
                listen_port,
                target_port,
                "Port proxy started (443 → {target_port})"
            );
            l
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                tracing::info!(
                    listen_port,
                    "Port {listen_port} requires admin — use https://localhost:{target_port} or run with sudo"
                );
            } else {
                tracing::debug!(listen_port, error = %e, "Could not bind port proxy");
            }
            return;
        }
    };

    let target_addr: SocketAddr = ([127, 0, 0, 1], target_port).into();
    loop {
        let (mut inbound, _) = match listener.accept().await {
            Ok(c) => c,
            Err(_) => continue,
        };
        tokio::spawn(async move {
            match tokio::net::TcpStream::connect(target_addr).await {
                Ok(mut outbound) => {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                }
                Err(e) => {
                    tracing::debug!(error = %e, "Port proxy: target connection failed");
                }
            }
        });
    }
}

/// Route for embedded static assets (CSS, JS, images)
fn static_assets() -> Router<Arc<AppState>> {
    use axum::extract::Path;
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;

    #[cfg(debug_assertions)]
    async fn serve_static(Path(path): Path<String>) -> impl IntoResponse {
        // In debug mode, serve from filesystem for hot reload (no cache)
        let static_path = std::path::Path::new("static").join(&path);

        match tokio::fs::read(&static_path).await {
            Ok(content) => {
                let mime = mime_guess::from_path(&path).first_or_octet_stream();
                (
                    StatusCode::OK,
                    [
                        (header::CONTENT_TYPE, mime.as_ref().to_string()),
                        (
                            header::CACHE_CONTROL,
                            "no-cache, no-store, must-revalidate".to_string(),
                        ),
                    ],
                    content,
                )
                    .into_response()
            }
            Err(_) => {
                tracing::warn!(path = %static_path.display(), "Static file not found");
                StatusCode::NOT_FOUND.into_response()
            }
        }
    }

    #[cfg(not(debug_assertions))]
    async fn serve_static(Path(path): Path<String>) -> impl IntoResponse {
        use rust_embed::Embed;

        #[derive(Embed)]
        #[folder = "static/"]
        struct StaticAssets;

        match StaticAssets::get(&path) {
            Some(content) => {
                let mime = mime_guess::from_path(&path).first_or_octet_stream();
                (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, mime.as_ref().to_string())],
                    content.data.to_vec(),
                )
                    .into_response()
            }
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    Router::new().route("/static/{*path}", axum::routing::get(serve_static))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install_crypto_provider() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    #[test]
    fn test_self_signed_cert_generation() {
        install_crypto_provider();
        let dir = tempfile::tempdir().unwrap();
        let cert_path = dir.path().join("cert.pem");
        let key_path = dir.path().join("key.pem");

        generate_self_signed(&cert_path, &key_path, &["homun.example.com"]).unwrap();

        // Verify files exist and contain valid PEM (text-level sanity check)
        let cert_text = std::fs::read_to_string(&cert_path).unwrap();
        let key_text = std::fs::read_to_string(&key_path).unwrap();

        assert!(cert_text.contains("BEGIN CERTIFICATE"));
        assert!(cert_text.contains("END CERTIFICATE"));
        assert!(key_text.contains("BEGIN PRIVATE KEY"));
        assert!(key_text.contains("END PRIVATE KEY"));

        // Verify rustls can parse them via the wrapper
        let certs = crate::web::tls_pem::load_cert_chain(&cert_path).unwrap();
        assert_eq!(certs.len(), 1, "Should produce exactly one certificate");

        let key = crate::web::tls_pem::load_private_key(&key_path).unwrap();

        // Verify we can build a valid ServerConfig
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(certs, key);
        assert!(
            config.is_ok(),
            "Certificate and key should form valid TLS config"
        );
    }

    #[test]
    fn test_self_signed_cert_with_custom_domain() {
        install_crypto_provider();
        let dir = tempfile::tempdir().unwrap();
        let cert_path = dir.path().join("cert.pem");
        let key_path = dir.path().join("key.pem");

        generate_self_signed(
            &cert_path,
            &key_path,
            &["homun.example.com", "my.custom.dev"],
        )
        .unwrap();

        let certs = crate::web::tls_pem::load_cert_chain(&cert_path).unwrap();
        assert_eq!(certs.len(), 1);

        // Parse the DER certificate to verify SANs
        // The cert should be valid for localhost, homun.example.com, and my.custom.dev
        // We just verify it parses and builds a valid TLS config
        let key = crate::web::tls_pem::load_private_key(&key_path).unwrap();
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(certs, key);
        assert!(config.is_ok(), "Multi-domain cert should be valid");
    }

    #[test]
    fn test_self_signed_cert_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let cert_path = dir.path().join("cert.pem");
        let key_path = dir.path().join("key.pem");

        generate_self_signed(&cert_path, &key_path, &[]).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let key_perms = std::fs::metadata(&key_path).unwrap().permissions().mode();
            // Check that only owner has permissions (mode & 0o077 == 0)
            assert_eq!(
                key_perms & 0o077,
                0,
                "Key file should have 0600 permissions"
            );
        }
    }

    #[tokio::test]
    async fn test_build_tls_config_no_tls() {
        let result = build_tls_config("", "", false, "").await;
        assert!(result.is_none(), "No TLS config when not configured");
    }

    #[tokio::test]
    async fn test_build_tls_config_auto_tls() {
        install_crypto_provider();
        let dir = tempfile::tempdir().unwrap();
        let cert_path = dir.path().join("cert.pem");
        let key_path = dir.path().join("key.pem");

        // Pre-generate certs in the temp dir
        generate_self_signed(&cert_path, &key_path, &["homun.example.com"]).unwrap();

        let result = build_tls_config(
            cert_path.to_str().unwrap(),
            key_path.to_str().unwrap(),
            false,
            "homun.example.com",
        )
        .await;
        assert!(
            result.is_some(),
            "Should produce valid TLS config from provided cert/key"
        );
    }
}
