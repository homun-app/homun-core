# Homun — Claude Code Instructions

> **Reference docs**: `docs/UNIFIED-ROADMAP.md` (roadmap & status), `docs/PROJECT.md` (vision), `docs/services/` (per-domain architecture)
> This file contains the technical guidelines for writing code in this codebase.

## What is Homun

Homun is a personal AI assistant written in Rust — a digital homunculus that lives on your machine and works 24/7. Managed via Telegram, WhatsApp, Discord, Slack, Email, Web UI, or CLI. Supports the open **Agent Skills** standard for extensible capabilities.

**Core philosophy**: single binary, local-first, privacy-focused, skill-powered.

**Scale**: ~121K LOC Rust, ~29K LOC JS, 245 source files, 45 JS files, 53 SQLite migrations, 952 tests, 11-check CI pipeline.

## Architecture Overview

```
src/
├── main.rs                          # Entry point, CLI (clap)
├── logs.rs                          # Structured logging + SSE streaming
├── mcp_setup.rs                     # MCP server auto-setup
│
├── agent/                           # Core agent loop (44 files)
│   ├── agent_loop.rs                # ReAct loop (reason → act → observe)
│   ├── cognition/                   # Cognition-First preprocessing (always active)
│   │   ├── mod.rs                   # Selective tool defs from cognition results
│   │   ├── engine.rs                # Mini ReAct loop with discovery tools
│   │   ├── discovery.rs             # Read-only discovery tools (memory, RAG, tools, skills, MCP)
│   │   └── types.rs                 # CognitionResult, DiscoveredTool, DiscoveredSkill, etc.
│   ├── orchestrator/                # Multi-agent orchestration
│   │   ├── mod.rs                   # Orchestrator entry + routing
│   │   ├── intent.rs                # Intent classification
│   │   ├── planner.rs               # Execution planning
│   │   ├── executor.rs              # Plan execution
│   │   ├── synthesizer.rs           # Result synthesis
│   │   └── types.rs                 # Orchestrator types
│   ├── prompt/                      # Prompt builder
│   │   ├── mod.rs                   # Prompt module
│   │   ├── builder.rs               # Prompt assembly
│   │   └── sections.rs              # 15+ prompt sections
│   ├── context.rs                   # System prompt assembly
│   ├── gateway.rs                   # Message routing + channel orchestration
│   ├── memory.rs                    # Long-term memory consolidation
│   ├── memory_db.rs                 # Memory database operations
│   ├── memory_search.rs             # Hybrid vector + FTS5 search (RRF scoring)
│   ├── embeddings.rs                # Embedding providers (OpenAI + fastembed)
│   ├── subagent.rs                  # Background task spawning
│   ├── heartbeat.rs                 # Proactive wake-up scheduler
│   ├── bootstrap_watcher.rs         # Hot-reload USER.md/SOUL.md
│   ├── browser_task_plan.rs         # Browser automation state tracking (cognition-driven)
│   ├── browser_context.rs           # Browser context management
│   ├── execution_plan.rs            # Structured execution plans + explicit plan steps
│   ├── iteration_budget.rs          # LLM iteration budget (adaptive on cognition complexity)
│   ├── llm_caller.rs                # LLM invocation wrapper
│   ├── tool_builder.rs              # Tool definition builder
│   ├── tool_veto.rs                 # Minimal runtime safety checks (search-first policy)
│   ├── skill_activator.rs           # Skill activation logic
│   ├── data_buffer.rs               # Structured data accumulator (off-context, used by add_data)
│   ├── context_compactor.rs         # Context window compression (3-level: micro/LLM-summary/truncate)
│   ├── debounce.rs                  # Message debouncing
│   ├── definition.rs                # Agent definition types
│   ├── registry.rs                  # Agent registry
│   ├── profile_resolver.rs          # Profile resolution
│   ├── request_trace.rs             # Request tracing
│   ├── index_meta.rs                # Index metadata
│   ├── auth.rs                      # Channel authentication
│   ├── verifier.rs                  # Approval verification
│   ├── attachment_router.rs         # Media attachment routing
│   ├── email_approval.rs            # Email approval flow
│   └── stop.rs                      # Graceful shutdown
│
├── provider/                        # LLM providers (12 files)
│   ├── traits.rs                    # Provider trait (chat, chat_stream)
│   ├── anthropic.rs                 # Native Claude API (tool_use, streaming)
│   ├── openai_compat.rs             # OpenAI format (OpenRouter, DeepSeek, Groq, etc.)
│   ├── ollama.rs                    # Ollama-specific (localhost:11434)
│   ├── factory.rs                   # Model → provider routing
│   ├── capabilities.rs              # Model capability detection (vision, tool_use, thinking)
│   ├── health.rs                    # Circuit breaker + health monitoring
│   ├── reliable.rs                  # Failover + retry logic
│   ├── queued.rs                    # Priority queue + per-provider concurrency limits
│   ├── one_shot.rs                  # Unified LLM engine for non-conversational calls
│   └── xml_dispatcher.rs            # XML fallback for models without function calling
│
├── tools/                           # 23+ built-in tools (37 files)
│   ├── registry.rs                  # Tool registry + dispatch
│   ├── shell.rs                     # Command execution (+ sandbox)
│   ├── file.rs                      # Read/write/edit/list files (+ build_workspace_file_block)
│   ├── send_file.rs                 # Deliver workspace file as channel attachment
│   ├── view_file.rs                 # Display workspace file inline in chat UI (modal)
│   ├── add_data.rs                  # Save structured records into DataBuffer (dynamic)
│   ├── web.rs                       # Web search (Brave, Tavily) + fetch (auto-escalate to browser)
│   ├── message.rs                   # Send message to user (optional file attach)
│   ├── spawn.rs                     # Spawn background subagent
│   ├── vault.rs                     # Encrypted secret storage
│   ├── remember.rs                  # Update USER.md memory
│   ├── knowledge.rs                 # RAG search/ingest/list
│   ├── approval.rs                  # Request user approval for actions
│   ├── automation.rs                # Create/manage automations
│   ├── workflow.rs                  # Multi-step workflow orchestration
│   ├── browser.rs                   # Browser automation (21 actions via MCP Playwright)
│   ├── mcp.rs                       # MCP server management
│   ├── mcp_token_refresh.rs         # MCP token refresh logic
│   ├── contacts.rs                  # Contact management tool
│   ├── email_inbox.rs               # Read email (IMAP)
│   ├── skill_create.rs              # LLM-driven skill generation
│   ├── response_blocks.rs           # Rich response blocks (choice, approval, status, result)
│   └── sandbox/                     # Unified sandbox (12 files, 5 backends)
│       ├── mod.rs                   # SandboxManager + backend auto-detection
│       ├── types.rs                 # SandboxConfig, SandboxResult
│       ├── resolve.rs               # Backend resolution logic
│       ├── env.rs                   # Environment injection
│       ├── events.rs                # Execution event logging
│       ├── runtime_image.rs         # Docker runtime image management
│       └── backends/                # Docker, native/macOS, Seatbelt, Linux Bubblewrap, Windows
│
├── skills/                          # Agent Skills ecosystem (12 files)
│   ├── loader.rs                    # Scan dirs, parse SKILL.md YAML frontmatter
│   ├── installer.rs                 # GitHub install (homun skills add owner/repo)
│   ├── executor.rs                  # Run scripts (Python/Bash/JS) with env injection
│   ├── creator.rs                   # LLM-driven skill generation
│   ├── security.rs                  # Pre-install security scanning
│   ├── adapter.rs                   # Format conversion (ClawHub SKILL.toml → SKILL.md)
│   ├── watcher.rs                   # Directory hot-reload
│   ├── search.rs                    # Skill discovery + search
│   ├── mcp_registry.rs              # MCP server registry + OAuth setup
│   ├── clawhub.rs                   # ClawHub marketplace integration
│   └── openskills.rs                # Open Skills registry integration
│
├── channels/                        # 7 messaging channels (11 files)
│   ├── traits.rs                    # Channel trait (start, send, name)
│   ├── capabilities.rs              # Channel capability detection
│   ├── health.rs                    # Channel health checks
│   ├── cli.rs                       # Interactive REPL + one-shot
│   ├── telegram.rs                  # Frankenstein (long polling)
│   ├── whatsapp.rs                  # wa-rs native (no Node.js)
│   ├── discord.rs                   # Serenity
│   ├── slack.rs                     # Socket Mode
│   ├── email.rs                     # IMAP + SMTP
│   ├── mcp_channel.rs               # MCP channel
│   └── web (in web/ws.rs)           # WebSocket in Web UI
│
├── contacts/                        # Contact management (6 files)
│   ├── mod.rs                       # Contact types + exports
│   ├── db.rs                        # Contact database operations
│   ├── context.rs                   # Contact context injection for agent
│   ├── resolver.rs                  # Contact identity resolution
│   ├── perimeter.rs                 # Contact perimeter enforcement
│   └── events.rs                    # Contact-related events
│
├── connections/                     # External connections (3 files)
│   ├── mod.rs                       # Connection types
│   ├── connect.rs                   # Connection establishment
│   └── recipes.rs                   # Connection recipes
│
├── profiles/                        # User/agent profiles (2 files)
│   ├── mod.rs                       # Profile types + exports
│   └── db.rs                        # Profile database operations
│
├── gateways/                        # Gateway services (3 files)
│   ├── mod.rs                       # Gateway types
│   ├── db.rs                        # Gateway database
│   └── migrate.rs                   # Gateway migration
│
├── sharing/                         # Share management (2 files)
│   ├── mod.rs                       # Sharing types
│   └── db.rs                        # Sharing database
│
├── rag/                             # RAG Knowledge Base (8 files)
│   ├── engine.rs                    # HNSW vector + FTS5 hybrid search
│   ├── db.rs                        # RAG database operations
│   ├── chunker.rs                   # 30+ format support (md, pdf, docx, code...)
│   ├── parsers.rs                   # PDF/DOCX/XLSX parsing
│   ├── sensitive.rs                 # Sensitive data classification + vault-gating
│   ├── watcher.rs                   # Directory auto-ingestion
│   └── cloud.rs                     # MCP cloud source integration
│
├── browser/                         # Browser automation (7 files)
│   ├── mcp_bridge.rs                # Persistent MCP Playwright peer
│   ├── site_memory.rs               # Site-specific browsing memory
│   ├── tab_session.rs               # Tab session state tracking
│   ├── action_policy.rs             # Action policy enforcement
│   ├── captcha.rs                   # CAPTCHA handling
│   ├── helpers.rs                   # Compact snapshot utilities
│   └── mod.rs                       # Browser manager
│
├── security/                        # Security infrastructure (7 files)
│   ├── exfiltration.rs              # Exfiltration guard + redaction
│   ├── estop.rs                     # Emergency kill switch
│   ├── pairing.rs                   # DM pairing + OTP verification
│   ├── totp.rs                      # TOTP 2FA
│   ├── two_factor.rs                # 2FA management
│   └── vault_leak.rs                # Vault leak detection
│
├── web/                             # Web UI (55 files, Axum, 29 pages)
│   ├── server.rs                    # Axum + TLS + session + rust-embed
│   ├── auth.rs                      # PBKDF2 auth, rate limiting, API keys
│   ├── pages.rs                     # HTML template generation (29 pages)
│   ├── ws.rs                        # WebSocket chat channel
│   ├── chat_attachments.rs          # File upload handling
│   ├── run_state.rs                 # Run state tracking
│   └── api/                         # 70+ REST endpoints
│       ├── mod.rs                   # Router + re-exports
│       ├── mcp/                     # MCP catalog, OAuth, install, CRUD (6 files)
│       ├── knowledge/               # Knowledge API + watchers (2 files)
│       └── {domain}.rs              # 30+ domain files (account, chat, skills, etc.)
│
├── workflows/                       # Persistent workflow engine (3 files)
│   ├── engine.rs                    # Orchestration, retry, approval gates, resume-on-boot
│   └── db.rs                        # Workflow DB operations
│
├── scheduler/                       # Scheduling (4 files)
│   ├── cron.rs                      # tokio-cron-scheduler
│   ├── automations.rs               # Automation trigger engine
│   └── background.rs                # Background task scheduling
│
├── storage/
│   ├── db.rs                        # SQLite (sqlx, 53 migrations)
│   ├── secrets.rs                   # AES-256-GCM vault + OS keychain
│   └── fixtures.rs                  # Test fixtures
│
├── config/
│   ├── schema.rs                    # 15+ config sections (TOML)
│   └── dotpath.rs                   # Dot-path get/set
│
├── bus/queue.rs                     # Message bus (mpsc)
├── session/manager.rs               # Session state
├── queue/                           # Batch processing (3 files)
├── service/                         # OS service install (launchd, systemd)
├── tui/                             # Terminal UI (ratatui, 4 files)
├── user/                            # User management
└── utils/
    ├── retry.rs                     # Exponential backoff + network state
    ├── reasoning_filter.rs          # Strip thinking blocks
    ├── dedup.rs                     # Deduplication utilities
    └── sandbox_import.rs            # Sandbox import helpers
```

### Frontend
```
static/
├── css/style.css                    # Design System
└── js/                              # 48 files, ~29K LOC
    ├── chat.js                      # Chat with streaming, markdown, tool timeline
    ├── automations.js               # Visual flow builder (n8n-style SVG canvas)
    ├── auto-validate.js             # Builder real-time validation engine
    ├── flow-renderer.js             # Flow rendering engine
    ├── model-loader.js              # Shared LLM model fetcher (DRY utility)
    ├── mcp-loader.js                # Shared MCP server/tool discovery (DRY utility)
    ├── embedding-loader.js          # Shared embedding model fetcher
    ├── schema-form.js               # JSON Schema → form fields for tool params
    ├── workflows.js                 # Workflow builder + approval UI
    ├── skills.js                    # Skill marketplace + install
    ├── knowledge.js                 # RAG document upload + search
    ├── memory.js                    # Memory editor + search
    ├── vault.js                     # Secret management + 2FA setup
    ├── mcp.js                       # MCP server discovery + OAuth
    ├── approvals.js                 # Approval queue
    ├── dashboard.js                 # Operational dashboard
    ├── dash-usage.js                # Dashboard usage analytics + charts
    ├── logs.js                      # Log streaming + filtering
    ├── setup.js                     # Config wizard
    ├── onboarding.js                # Multi-phase onboarding experience
    ├── account.js                   # User settings + API tokens
    ├── account-mobile.js            # Mobile account settings
    ├── account-gateways.js          # Gateway account settings
    ├── api-keys.js                  # API key management
    ├── contacts.js                  # Contact management
    ├── connections.js               # External connections UI
    ├── profiles.js                  # Profile management
    ├── channels.js                  # Channel configuration
    ├── traces.js                    # Request trace viewer
    ├── topbar.js                    # Top navigation bar
    ├── command-palette.js           # Command palette (Cmd+K)
    ├── settings-modal.js            # Settings modal
    ├── sharing-picker.js            # Sharing picker
    ├── response-blocks.js           # Rich response block renderer
    ├── contact-gateway-overrides.js # Contact gateway overrides
    ├── contact-perimeter.js         # Contact perimeter UI
    ├── sidebar.js                   # Navigation sidebar
    ├── appearance.js                # Theme + accent picker
    ├── accent-utils.js              # Accent color utilities
    ├── theme.js                     # Light/dark mode
    ├── sandbox.js                   # Sandbox settings UI
    ├── shell.js                     # Terminal interface
    ├── file-access.js               # File access UI
    ├── maintenance.js               # Maintenance page
    ├── toast.js                     # Toast notifications
    └── csrf.js                      # CSRF token management
```

## Key Design Decisions

### Runtime & Async
- **Tokio** as async runtime — `#[tokio::main]`, `tokio::spawn` for concurrency.
- All I/O must be async. Never `std::thread::sleep`, use `tokio::time::sleep`.
- `tokio::sync::mpsc` for internal message bus.

### LLM Provider System
- `Provider` trait in `provider/traits.rs` — `chat()`, `chat_stream()`, `name()`.
- **Model routing**: `anthropic/claude-*` → Anthropic provider, `ollama/*` → Ollama, everything else → OpenAI-compatible.
- **QueuedProvider** wraps providers with priority queue + per-provider concurrency limits (semaphore).
- **ReliableProvider** wraps any provider with circuit breaker + failover.
- **`one_shot.rs`**: shared `llm_one_shot()` for non-conversational calls (automations generation, MCP setup, skill creation). Disables extended thinking, 30s timeout.
- **Capabilities detection**: auto-detect vision, tool_use, extended_thinking per model.
- **XML fallback**: `xml_dispatcher.rs` for models without native function calling.

### Storage
- **SQLite via sqlx** — 53 migrations, single file `~/.homun/homun.db`.
- **TOML** config at `~/.homun/config.toml`.
- Never serde_json for config files.

### Tool System
- `Tool` trait: `name()`, `description()`, `parameters()` (JSON Schema), `execute()`.
- `ToolRegistry` at startup, tools converted to LLM format (OpenAI/Anthropic).
- **OnceCell** late-binding pattern for tools needing gateway state at runtime.

### Channel System
- `Channel` trait: `start()`, `send()`, `name()`.
- `ChannelBehavior` trait: unified interface for all channel configs (7 methods).
- `behavior_for(channel_name)`: single lookup point in `ChannelsConfig`.
- Flow: Channel → InboundMessage → MessageBus → AgentLoop → OutboundMessage → Channel.
- 7 channels: CLI, Telegram, WhatsApp, Discord, Slack, Email, Web (WebSocket).
- Auth centralized in gateway (`agent/auth.rs`), all channels fail-closed.

### Memory System
- **Short-term**: session messages (in-memory + SQLite).
- **Long-term**: LLM-consolidated summaries in `memories` table.
- **Hybrid search**: vector (HNSW) + FTS5, RRF scoring in `memory_search.rs`.
- **Daily files**: `~/.homun/memory/YYYY-MM-DD.md`.
- **User profile**: `~/.homun/brain/USER.md` (written only by `remember` tool).

### Skills System
- Open Agent Skills spec compatible (SKILL.md with YAML frontmatter).
- **Progressive disclosure**: name + description at startup, full body on activation.
- Scanned from: `~/.homun/skills/` (user), `./skills/` (project), bundled (5 default).
- **Security shield**: pre-install scanning before execution.
- **Runtime parity** with OpenClaw: eligibility, invocation policy, tool restriction, env injection.

### Cognition-First Architecture
The agent loop follows a 4-phase pattern: **INGRESS → COGNITION → EXECUTION → POST-PROCESSING**.

- **Cognition phase** (`agent/cognition/`): always active (no feature gate). A mini ReAct loop with read-only discovery tools (memory search, RAG search, tool/skill/MCP listing) analyzes the user's intent _before_ the main execution loop.
- **Output**: `CognitionResult` with understanding, plan steps, constraints, and discovered tools/skills/MCP/memory/RAG context.
- **Selective tool loading**: only tools identified by cognition are passed to the LLM (+ always-available set: send_message, remember, approval).
- **System prompt injection**: cognition understanding/plan/constraints are injected into the system prompt's Task Analysis section.
- **Browser task plan**: initialized from `CognitionResult` via `from_cognition()`.
- **Tool veto**: minimal safety-net only (search-first policy for web_fetch). Cognition already selected the right tools.
- **Fallback**: when `run_cognition()` fails (provider error, timeout), `fallback_full_context()` provides ALL tools so the execution loop can still function.

### Multi-Agent Orchestration
- `agent/orchestrator/`: intent classification → planning → execution → synthesis.
- `AgentDefinition` in `agent/definition.rs`, registry in `agent/registry.rs`.
- LLM classifier routes tasks to specialized agents.
- Pipeline paradigm: Task > Roles, RAG-first, Few-Shot via Skills.

### Contact System
- `contacts/`: full contact management with identity resolution across channels.
- `contacts/context.rs`: injects contact context (tone_of_voice, history) into agent prompts.
- `contacts/perimeter.rs`: contact perimeter enforcement for privacy.

### Rich Response Blocks
- `tools/response_blocks.rs`: structured UI blocks alongside markdown for native rendering.
- 5 block types: choice, approval, status, result, external_message.
- Blocks in WS (stream event), REST history, inline context encoding.
- `block_response` inbound for user interactions (option.id + metadata).

### RAG Knowledge Base
- Multi-format ingestion (30+ formats: md, pdf, docx, xlsx, code, etc.).
- Hybrid search: HNSW vectors + FTS5, with sensitive data vault-gating.
- Directory watcher for auto-ingest.

### Sandbox
- 5 backends: Docker, native/macOS, Seatbelt, Linux Bubblewrap, Windows Job Objects.
- Auto-detection of best available backend.
- Event logging + runtime image management.

### Browser Automation
- MCP Playwright (`@playwright/mcp` via npx), persistent peer.
- Stealth anti-bot injection, compact snapshots (tree-preserving).
- Auto-snapshot after navigate/click/type.
- 21 actions in unified `browser` tool.
- Site memory (`browser/site_memory.rs`): per-site browsing patterns.
- Tab sessions (`browser/tab_session.rs`): stateful tab management.
- Action policy (`browser/action_policy.rs`): policy enforcement per action.

### Security
- **Auth**: PBKDF2 (600k iterations), HMAC-signed session cookies.
- **Rate limiting**: auth 5/min, API 60/min, per-IP.
- **E-Stop**: emergency kill switch (agent loop, browser, MCP).
- **Exfiltration guard**: detects + redacts sensitive data leaks.
- **Vault**: AES-256-GCM, OS keychain master key, zeroized memory.
- **2FA**: TOTP support.

### Web UI
- **Axum** server with TLS + rust-embed for static assets.
- **29 pages**: chat, setup, appearance, channels, browser, automations, workflows, skills, mcp, agents, contacts, profiles, memory, knowledge, vault, file-access, shell, sandbox, approvals, account, api-keys, maintenance, logs, traces, onboarding, + OAuth callbacks.
- **70+ REST API endpoints** under `/api/v1/`.
- Debug mode: CSS/JS served from filesystem (hot reload), HTML templates require recompile.

### Workflow Engine
- Persistent multi-step workflows with approval gates.
- Retry logic + resume-on-boot from SQLite.

### Automations Builder v2
- Visual flow canvas (n8n-style SVG), 11 node kinds.
- Guided inspector (dropdown from API, no free text).
- NLP flow generation via LLM (`one_shot.rs`).

---

## Rust Conventions

### General
- Edition 2021, MSRV 1.75+.
- `anyhow::Result` for app errors, `thiserror` for typed library errors.
- `tracing` for logging (never `println!`).
- `clap` (derive) for CLI, `serde` for serialization.
- `rustfmt` + `clippy` (deny warnings in CI).

### Code Style
- One file per concern, keep under 300 lines when possible.
- `impl` blocks for anything with state.
- Prefer `&str` over `String` in parameters.
- `Arc<T>` for shared state, `Arc<RwLock<T>>` when mutation needed.
- `///` doc comments on public APIs.
- Unit tests in `#[cfg(test)] mod tests`, integration tests in `tests/`.

### Error Handling
- Never `.unwrap()` in production (only tests).
- `?` operator consistently.
- `anyhow::Context` for wrapping: `.with_context(|| format!("Failed to read {}", path.display()))?`.

### Key Dependencies
- `tokio` (full) — async runtime
- `reqwest` — HTTP client
- `sqlx` (sqlite, runtime-tokio) — database
- `serde`, `serde_json`, `toml` — serialization
- `clap` (derive) — CLI
- `tracing`, `tracing-subscriber` — logging
- `anyhow`, `thiserror` — errors
- `frankenstein` — Telegram
- `serenity` — Discord
- `wa-rs` — WhatsApp (GitHub fork: homunbot/wa-rs)
- `tokio-cron-scheduler` — cron
- `notify` — file watcher
- `gray_matter` — YAML frontmatter
- `keyring` — OS keychain (apple-native, linux-native, windows-native)
- `axum` — web server
- `rust-embed` — static asset embedding
- `rmcp` — MCP client
- `usearch` — HNSW vector index

Keep dependencies lean. Do NOT add unnecessary crates.

---

## Regole di Programmazione

> Queste regole si applicano a ogni modifica, grande o piccola. Prima di consegnare qualsiasi implementazione, verifica mentalmente questa lista. Se stai violando una regola, riscrivi o chiedi conferma prima di procedere.

### DRY — Don't Repeat Yourself

- **Prima di creare qualsiasi cosa**: cerca nel codebase se esiste gia logica simile. Estendila, non duplicarla.
- Estrai funzioni/metodi non appena la stessa logica appare **2+ volte** — anche se le occorrenze sono in file diversi.
- Preferisci parametrizzare piuttosto che duplicare con piccole variazioni.
- **Pattern gia esistenti — riusali sempre**:
  - `provider/one_shot.rs` → qualsiasi chiamata LLM non-conversazionale (mai creare chiamate reqwest ad-hoc)
  - `utils/retry.rs` → qualsiasi operazione di rete che richiede retry (mai scrivere loop retry custom)
  - `storage/db.rs` → qualsiasi operazione SQLite (mai aprire nuove connessioni)
  - `web/auth.rs` → qualsiasi check auth/rate-limit (mai reimplementare)
  - `tools/registry.rs` → registrazione tool (segui il pattern esistente esattamente)
  - `channels/traits.rs` → astrazione canale (implementa il trait, non inventare nuovi flussi)
  - `contacts/db.rs` → operazioni contatti (non duplicare query)
  - `profiles/db.rs` → operazioni profili
- **Refactor > duplica**: se due moduli condividono >20 righe di logica simile, estrai una funzione o trait condiviso.
- **CSS**: riusa i design token di `static/css/style.css`. Mai hardcodare colori, spaziature o font. Usa variabili CSS (`var(--*)`).
- **JS**: prima di scrivere un nuovo pattern UI, controlla se esiste gia in un altro file JS della pagina.

### Analisi Strutturale Prima di Ogni Implementazione

**Obbligatorio** prima di creare qualsiasi nuovo file o struct: esegui questa analisi.

#### Step 1 — Cerca duplicati strutturali
Quando ti viene chiesto di aggiungere `XyzHandler`, `XyzClient`, `XyzProcessor` o simili,
cerca nel codebase pattern con la stessa forma:
```
rg "struct.*Handler" src/
rg "struct.*Client" src/
rg "async fn execute" src/
rg "async fn run" src/
```

Se trovi 2+ struct con metodi simili → vai a Step 2. Altrimenti procedi normalmente.

#### Step 2 — Valuta se esiste gia un'astrazione
Chiediti:
- Esiste gia un trait che queste struct potrebbero implementare?
- Se non esiste, dovrei crearne uno prima?
- Le struct esistenti andrebbero refactorate per implementarlo?

Criteri per creare un nuovo trait:
- 2+ implementazioni esistenti o pianificate
- I metodi core sono identici nella firma (anche se diversi nell'implementazione)
- Il codice chiamante potrebbe usare `dyn Trait` o `impl Trait` invece di tipi concreti

#### Step 3 — Proponi prima di scrivere
Se individui un'opportunita di astrazione, **fermati e proponi** prima di implementare:

> "Ho notato che `EmailSender` e `TelegramSender` hanno entrambi `send(msg)` e `name()`.
> Prima di aggiungere `SlackSender`, propongo di estrarre un trait `MessageSender`.
> Vuoi che proceda con il refactor, o aggiungo `SlackSender` direttamente?"

Non fare il refactor silenziosamente. Non ignorare l'opportunita. Sempre segnala e chiedi.

### Interfacce e Astrazioni

- **Definisci sempre un trait prima** di implementare oggetti con comportamento simile. Il trait va in `{dominio}/traits.rs`.
- Gli oggetti concreti non devono mai dipendere da altri oggetti concreti — solo da astrazioni (trait o `Arc<dyn Trait>`).
- Se due struct condividono campi o comportamenti, considera un trait condiviso o una struct base.
- **Quando creare un trait vs una funzione libera**:
  - Trait: quando esistono o esisteranno piu implementazioni (es. piu provider, piu canali).
  - Funzione libera: quando la logica e unica e non ha varianti polimorfiche.
- **Extend over replace**: aggiungi varianti a enum esistenti, metodi a impl esistenti, campi a struct esistenti. Non creare tipi paralleli.
- **Enum esaustivi**: quando aggiungi una variante a un enum, cerca tutti i `match` su quell'enum nel codebase e gestisci il nuovo caso. Non usare `_ =>` per nascondere i casi mancanti.

### Naming Conventions

- **Funzioni**: `snake_case`, verbo + sostantivo (`send_message`, `load_skill`, `parse_config`).
- **Struct/Trait/Enum**: `PascalCase`, sostantivo (`SkillLoader`, `ProviderError`, `ChannelKind`).
- **Costanti**: `SCREAMING_SNAKE_CASE` (`MAX_RETRY_COUNT`, `DEFAULT_TIMEOUT_SECS`).
- **Varianti di enum**: `PascalCase`, concise e non ridondanti (`Provider::Anthropic` non `Provider::AnthropicProvider`).
- **Booleani**: inizia con `is_`, `has_`, `can_`, `should_` (`is_enabled`, `has_vision`, `can_retry`).
- **Evita abbreviazioni** non standard: `config` va bene, `cfg` solo se e il nome del modulo Rust. Mai `mgr`, `hlpr`, `proc`.
- **Nomi coerenti tra Rust e JS**: se un concetto si chiama `skill` in Rust, non chiamarlo `plugin` nel JS.

### Struttura degli `impl` Block

Mantieni un ordine coerente all'interno di ogni `impl`:

```
1. Costruttori (new, from_config, default)
2. Metodi pubblici principali (logica core)
3. Metodi pubblici di utilita (getter, helper pubblici)
4. Metodi privati (logica interna)
```

- Un solo `impl` per struct/trait per file, salvo casi eccezionali (`impl From<X>` separato e accettabile).
- Se l'impl supera ~150 righe, valuta se ha troppe responsabilita → split del file.

### Dimensioni dei File

- **Hard limit**: nessun file Rust oltre 500 righe. Se un file si avvicina a 400 righe, pianifica uno split.
- **Target**: 200-300 righe per file. Una responsabilita per file.
- **Come splittare**: estrai in una directory-submodule (es. pattern `tools/sandbox/`). Il `mod.rs` rimane thin: solo re-export + orchestrazione.
- **File JS**: stesso limite di 500 righe. I file grandi esistenti sono grandfathered, ma le nuove feature vanno in file separati.
- **Mai compattare arbitrariamente**: non unire file piccoli "per semplicita". Ogni file ha una ragione di esistere.

### Organizzazione delle Cartelle

- Segui la struttura esistente del progetto — non creare nuove cartelle senza discuterne.
- Raggruppa per **dominio/feature**, non per tipo di file (`/agent/`, `/tools/`, `/channels/` — non `/structs/`, `/helpers/`).
- I moduli pubblici espongono le API via `mod.rs` con re-export espliciti (`pub use`).
- I tipi condivisi tra piu moduli vanno in `{dominio}/types.rs` o `{dominio}/mod.rs`, non duplicati.
- I file di test restano separati dal codice produzione: `#[cfg(test)] mod tests` per unit test, `tests/` per integration test.

### Commenti e Documentazione

**Cosa documentare (obbligatorio):**
- Ogni `pub fn`, `pub struct`, `pub trait`, `pub enum` → doc comment `///`.
- Ogni modulo pubblico (`mod.rs`) → `//! Module-level doc` che spiega il dominio in 1-2 righe.
- Ogni campo di struct non ovvio → commento inline `//`.
- Blocchi di logica complessa o non ovvia → commento `//` prima del blocco che spiega il **perche**.

**Come scrivere i commenti:**
- I commenti spiegano il **perche**, non il **cosa** — il codice deve essere autoesplicativo.
- Per le `pub fn`, la prima riga del `///` e il sommario (una frase). Poi riga vuota, poi dettagli se necessari.
- Documenta i **casi d'errore** rilevanti: `/// Returns Err if the vault is locked or the key is missing.`

**Cosa NON fare:**
- Niente commenti TODO abbandonati — o risolvi subito o apri un issue tracciato nel roadmap.
- Niente codice commentato lasciato nel codebase — usa git per la storia.
- Niente commenti che riformulano il codice (`// calls send_message` sopra `send_message()`).

### Dead Code e Feature Discipline

- **Niente codice morto**: se una funzione non e usata, rimuovila. Non aggiungere `#[allow(dead_code)]` salvo casi documentati.
- **Niente feature sperimentali nascoste**: se una feature e WIP, deve stare in un branch, non nel main commentata o dietro un flag non documentato.
- **`#[cfg(feature = "...")]`**: usalo solo per feature genuinamente opzionali e documentale in `Cargo.toml` con una descrizione.
- **Import inutilizzati**: rimuovili sempre. `cargo check` li segnala — non ignorarli.

---

## CLI Commands

```
homun                        # Interactive chat (default)
homun chat                   # Interactive chat
homun chat -m "message"      # One-shot message
homun gateway                # Start gateway (channels + cron + heartbeat + web UI)
homun config                 # Initialize config
homun status                 # Show status
homun skills list            # List installed skills
homun skills add owner/repo  # Install skill from GitHub
homun skills remove name     # Remove skill
homun cron list              # List scheduled jobs
homun cron add ...           # Add cron job
homun cron remove <id>       # Remove cron job
homun service install        # Install as OS service (launchd/systemd)
```

## Development Workflow

1. `cargo check` — catch errors early.
2. `cargo clippy` — lint before committing.
3. `cargo test` — run 952 tests.
4. `RUST_LOG=debug cargo run -- gateway` — verbose logging.
5. Migrations in `migrations/` are auto-applied on startup.

## Development Conventions

### Research Before Building
Before implementing a new component or feature domain:
1. **Pull competitor repos** to get latest:
   ```
   cd ~/Projects/openclaw && git pull
   cd ~/Projects/zeroclaw && git pull
   ```
2. **Study how they do it**: check the relevant module in both projects.
   - OpenClaw (TypeScript): `~/Projects/openclaw/` — 30+ channels, Lobster workflows, ClawHub marketplace
   - ZeroClaw (Rust): `~/Projects/zeroclaw/` — lean binary, HNSW vectors, AIEOS identity
   - Competitive analysis conclusions are in `docs/UNIFIED-ROADMAP.md` (positioning section)
3. **Document findings** in the plan before writing code.
4. This applies to: new tools, new channels, new storage patterns, new API designs, new skill features.

### Plan Mode for Large Tasks
- **Mandatory** for any task touching more than 3 files.
- Use Plan Mode (Shift+Tab x2) to analyze and plan before modifying files.
- Workflow: Plan → User reviews → Approved → Execute step by step.
- For very large features: write a SPEC.md first, `/clear`, then new session to execute.

### Context Window Management
- **One feature per session**. Start with `/clear` when switching tasks.
- **Document & Clear pattern** for large tasks: dump progress to a `.md` file, `/clear`, continue in new session reading that file.
- **Avoid `/compact`** — prefer explicit `/clear` with documented state.
- **Read only what's needed**: don't read entire large files when you need one function.

### Feature Development Workflow
1. Create git branch: `git checkout -b feat/feature-name`
2. Plan in 3-5 steps with small diffs
3. Execute step by step — `cargo check` after each edit
4. `cargo test` after each meaningful change
5. PR description generated at the end

### Testing Requirements
- **After every change**: run `cargo test`. Never disable tests — fix them.
- **Every new module** requires at least unit tests for the happy path.
- **Every bug fix** requires a regression test.
- **Integration tests** in `tests/` for cross-module behavior.
- Tests are the only reliable validation for AI-generated code.
- In tests, `.unwrap()` e accettabile — ma aggiungi un commento se l'unwrap non e ovvio.

### Code Quality Gates
- `cargo check` runs automatically after edits (via Claude Code hook).
- `cargo fmt` + `cargo clippy` run before commits (via Claude Code hook).
- If `cargo check` fails after an edit, fix immediately before continuing.
- Never skip or ignore compiler warnings.

### Checklist Pre-Consegna

Prima di dichiarare una feature completa, verifica:

- [ ] `cargo check` passa senza warning
- [ ] `cargo clippy` passa senza warning
- [ ] `cargo test` passa — nessun test ignorato o disabilitato
- [ ] Nessun `unwrap()` in codice produzione
- [ ] Nessun `TODO` abbandonato nel codice
- [ ] Nessun `println!` — solo `tracing::*`
- [ ] Ogni `pub fn`/`pub struct`/`pub trait` ha un `///` doc comment
- [ ] Il file non supera 500 righe — se si, hai pianificato lo split?
- [ ] La logica e gia presente altrove nel codebase? (DRY check)
- [ ] I nomi di funzioni/struct/variabili rispettano le naming conventions?
- [ ] `docs/UNIFIED-ROADMAP.md` aggiornato con le task completate

### Roadmap Tracking
- **After completing a feature or significant change**, update `docs/UNIFIED-ROADMAP.md`:
  - Mark relevant tasks as done with date
  - Update "Stato Attuale" metrics table if numbers changed
  - Add new tasks discovered during implementation
- `docs/UNIFIED-ROADMAP.md` is the **single source of truth** for project status and planning.

### UX Conventions
- **Quality gate**: every UI change must pass `docs/design/ui-quality-gate.md` checklist.
- **States are mandatory**: every component must handle empty, loading, error, success states.
- **Mobile-first**: design at 375px, then scale up. Verify at 390, 768, 1024, 1280px.
- **Progressive disclosure**: hide advanced options behind expandable sections.
- **CSS tokens only**: use `var(--accent)`, `var(--surface-*)`, `var(--text-*)` etc. Never hardcode values.
- Use `/ux-review` and `/new-screen` commands for UI work.

---

## What NOT to Do

- Do NOT use `println!` — use `tracing::info!`, `tracing::debug!`, etc.
- Do NOT block the async runtime — no `std::thread::sleep`, no sync I/O.
- Do NOT hardcode API URLs — they come from config/provider.
- Do NOT store secrets in code — use vault or `config.toml`.
- Do NOT add Python/Node.js deps to the core binary.
- Do NOT use `.clone()` excessively — prefer references and borrows.
- Do NOT panic in library code — return `Result`.
- Do NOT use `_ =>` in match expressions to hide enum variants non gestite — gestiscile esplicitamente.
- Do NOT lasciare codice morto o commentato nel main branch.
- Do NOT creare tipi paralleli se esiste gia un tipo che puoi estendere.

---

## Important Directories

- `~/.homun/` — Data dir (config, db, memory)
- `~/.homun/brain/` — Agent-writable memory (USER.md, INSTRUCTIONS.md, SOUL.md)
- `~/.homun/skills/` — User-installed skills
- `./skills/` — Project-local bundled skills (5)
- `./migrations/` — SQLite migrations (53, auto-applied)
- `./docs/services/` — Per-domain architecture docs
- `./static/` — Web UI assets (CSS + 45 JS files)

## File Locations (Runtime)

- `~/.homun/config.toml` — Configuration
- `~/.homun/homun.db` — SQLite database
- `~/.homun/secrets.enc` — Encrypted vault
- `~/.homun/brain/USER.md` — User profile (remember tool writes)
- `~/.homun/brain/INSTRUCTIONS.md` — Learned instructions (consolidation)
- `~/.homun/MEMORY.md` — Long-term memory (consolidation)
- `~/.homun/memory/YYYY-MM-DD.md` — Daily memory files

---

## Integration Points — Where New Code Plugs In

Quick reference for adding new components without re-reading the whole codebase.

### New Tool
1. Create `src/tools/{name}.rs` — implement `Tool` trait
2. Register in `src/tools/mod.rs` (pub mod) + `src/tools/registry.rs` (register call)
3. Done — the agent loop auto-discovers registered tools

### New Channel
1. Create `src/channels/{name}.rs` — implement `Channel` trait
2. Add to `src/channels/mod.rs` (pub mod)
3. Config struct in `src/config/schema.rs` (under ChannelsConfig)
4. Start logic in `src/agent/gateway.rs` (match on channel name)
5. Web UI card in `src/web/pages.rs` (`build_channels_cards_html`)

### New API Endpoint
1. Add handler fn in the appropriate `src/web/api/{domain}.rs` file (or create a new domain file)
2. Register route in that file's `pub(super) fn routes()`, which is merged in `src/web/api/mod.rs`
3. Auth: use `require_auth()` middleware from `src/web/auth.rs`

### New Web UI Page
1. HTML template in `src/web/pages.rs` (fn + template)
2. Route in `src/web/server.rs`
3. JS file in `static/js/{name}.js`
4. Sidebar link in `src/web/pages.rs` (`build_sidebar_html`)

### New Migration
1. Create `migrations/NNN_{name}.sql`
2. Auto-applied on startup via `sqlx::migrate!`

### New Config Section
1. Add struct to `src/config/schema.rs`
2. Add field to parent config struct
3. Dotpath access via `src/config/dotpath.rs`

### New LLM One-Shot Call
1. Use `provider/one_shot.rs` → `llm_one_shot()` — do NOT create ad-hoc provider calls
2. Pass system prompt + user prompt + optional tools

### New Skill
1. Create dir in `skills/{name}/` with `SKILL.md` (YAML frontmatter)
2. Optional `scripts/` dir for executable scripts
3. Loaded automatically by `src/skills/loader.rs`

### New Cognition Discovery Tool
1. Add fn in `src/agent/cognition/discovery.rs` — follows the pattern of existing discovery fns
2. Register the tool definition in `discovery.rs`'s `build_discovery_tools()` function
3. Handle the tool call in `engine.rs`'s match on tool name
4. The cognition engine will auto-invoke it during the mini ReAct loop

### New Contact Domain
1. Add DB operations in `src/contacts/db.rs`
2. Business logic in `src/contacts/mod.rs`
3. API endpoint in `src/web/api/contacts.rs`
4. UI in `static/js/contacts.js`

---

## Grandfathered Files (Pre-Convention)

These files exceed the 500-line limit and predate the convention. Do NOT split them unless explicitly asked — they work as-is. New code within them should follow conventions; new features should go in separate files.

**Rust (>1000 lines):**
- `web/pages.rs` (5.3K) — HTML templates; unavoidable size, templates are self-contained
- `tools/browser.rs` (3.5K) — 17 browser actions; complex but cohesive
- `agent/agent_loop.rs` (3.4K) — core loop; complex but cohesive
- `storage/db.rs` (3.3K) — all DB operations; cohesive single-concern
- `config/schema.rs` (3.0K) — all config structs; grows with features
- `main.rs` (2.9K) — CLI entry; clap derive + subcommands
- `agent/gateway.rs` (2.5K) — message routing
- `tui/app.rs` (2.0K) — TUI state; cohesive
- `skills/loader.rs` (1.7K) — skill parsing + validation
- `web/auth.rs` (1.6K) — authentication + rate limiting
- `web/api/providers.rs` (1.5K) — LLM provider API
- `agent/memory.rs` (1.4K) — memory consolidation
- `skills/security.rs` (1.2K), `web/server.rs` (1.2K), `skills/clawhub.rs` (1.1K)
- `channels/email.rs` (1.1K), `tools/mcp.rs` (1.1K), `scheduler/automations.rs` (1.0K)

**JS (>500 lines):**
- `chat.js` (3.8K), `automations.js` (3.2K), `setup.js` (2.8K), `mcp.js` (1.8K)
- `skills.js` (1.1K), `knowledge.js` (1.0K), `connections.js` (863), `profiles.js` (859)
- `flow-renderer.js` (775), `onboarding.js` (752), `channels.js` (726), `contacts.js` (665)

---

## Git Commit Guidelines

- Conventional commit format: `type(scope): description`
- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`
- Italian or English
- Do NOT add Claude as co-author
