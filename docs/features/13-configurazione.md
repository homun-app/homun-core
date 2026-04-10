# Configurazione

## Panoramica

Il dominio Configurazione governa il caricamento, la validazione, la persistenza e l'accesso programmatico a tutte le impostazioni di Homun. Il file sorgente e `~/.homun/config.toml`, parsato nella struct `Config` (`src/config/schema.rs`) con ~30 sotto-struct per 17 sezioni principali. Oltre allo schema statico, il dominio include il sistema di provider LLM (factory, reliability, queue), il wizard di setup, l'onboarding multi-fase, l'auto-setup MCP e la gestione servizio OS.

---

## Feature

### 1. Schema Configurazione TOML

#### Comportamento Atteso
- Il file `~/.homun/config.toml` contiene tutte le impostazioni dell'applicazione, organizzate in sezioni TOML.
- Al caricamento, ogni campo non presente nel file assume il valore di default definito in `impl Default`.
- La struct root `Config` contiene 16 sezioni top-level: `agent`, `providers`, `channels`, `tools`, `storage`, `memory`, `knowledge`, `mcp`, `permissions`, `security`, `browser`, `ui`, `skills`, `agents`, `routing`, `profiles`.
- Il salvataggio (`Config::save()`) rimuove automaticamente il server MCP virtuale "playwright" prima di scrivere su disco per evitare che configurazioni auto-iniettate finiscano nel file.
- **Input**: file TOML su disco o `Config::default()` se assente.
- **Output**: struct `Config` completa con tutti i campi risolti.
- **Edge case**: se il file non esiste, viene usato `Config::default()` con un warning. Se il parsing fallisce, l'errore viene propagato con contesto (`anyhow::Context`).

#### Sezioni e Struct Principali

| Sezione TOML | Struct Rust | Default rilevanti |
|---|---|---|
| `[agent]` | `AgentConfig` | model=`anthropic/claude-sonnet-4-20250514`, max_tokens=8192, temperature=0.7, max_iterations=20, memory_window=50, consolidation_threshold=20 |
| `[providers.*]` | `ProvidersConfig` (26 provider) | Tutti vuoti (nessuna API key) |
| `[channels.telegram]` | `TelegramConfig` | enabled=false, mention_required=true, persona="bot" |
| `[channels.whatsapp]` | `WhatsAppConfig` | enabled=false, db_path="~/.homun/whatsapp.db", skip_history_sync=true |
| `[channels.discord]` | `DiscordConfig` | enabled=false, mention_required=true |
| `[channels.web]` | `WebConfig` | enabled=true, host="127.0.0.1", port=18443, auto_tls=true, session_ttl=86400 |
| `[channels.slack]` | `SlackConfig` | enabled=false, mention_required=true |
| `[channels.email]` | `EmailConfig` (legacy) | enabled=false, imap_port=993, smtp_port=465 |
| `[channels.emails.*]` | `EmailAccountConfig` | mode=Assisted, batch_threshold=3, batch_window=120s |
| `[tools]` | `ToolsConfig` | default_timeout=120s, exec.timeout=60s |
| `[storage]` | `StorageConfig` | path="~/.homun/homun.db" |
| `[memory]` | `MemoryConfig` | retention=30gg, embedding_provider="ollama", dimensions=384 |
| `[knowledge]` | `KnowledgeConfig` | enabled=true, chunk_max_tokens=512, results_per_query=3 |
| `[mcp]` | `McpConfig` | servers={} (vuoto) |
| `[permissions]` | `PermissionsConfig` | mode=Workspace, ACL con deny per ~/.ssh, ~/.aws, ~/.gnupg |
| `[security]` | `SecurityConfig` | exfiltration.enabled=true, sandbox.backend="auto" |
| `[browser]` | `BrowserConfig` | enabled=false, headless=true, browser_type="chromium", stealth=true |
| `[ui]` | `UiConfig` | theme="system", language="system", accent="moss" |
| `[skills]` | `SkillsConfig` | entries={} (vuoto) |
| `[agents.*]` | `AgentDefinitionConfig` | Eredita da `[agent]` se vuoto |
| `[routing]` | `RoutingConfig` | classifier_model="" (disabilitato) |
| `[profiles]` | `ProfilesConfig` | default="default" |

#### Dettagli Tecnici
- **Moduli**: `src/config/schema.rs` (~2900 righe, grandfathered), `src/config/mod.rs` (re-export)
- **Parsing**: `toml::from_str` con `#[serde(default)]` su tutte le struct
- **Serializzazione**: `toml::to_string_pretty` per il salvataggio
- **Migrazione legacy**: `ChannelsConfig::migrate_legacy_email()` promuove `[channels.email]` a `[channels.emails.default]`; `BrowserConfig::maybe_auto_enable_for_legacy_config()` abilita automaticamente il browser per config legacy se npx e disponibile
- **Directory statiche**: `Config::data_dir()` -> `~/.homun/`, `Config::workspace_dir()`, `Config::skills_dir()`, `Config::brain_dir()`, `Config::memory_dir()`, `Config::knowledge_dir()`, `Config::cache_dir()`, `Config::logs_dir()`, `Config::tls_dir()`
- **Nessuna tabella DB**: la config vive interamente su filesystem TOML

#### Dipendenze
- **Da cosa dipende**: `serde`, `toml`, `dirs` (home dir), `crate::storage` (per API key encrypted)
- **Cosa dipende da questa feature**: tutto il sistema -- ogni modulo legge la config

---

### 2. Dot-Path Get/Set

#### Comportamento Atteso
- Accesso programmatico ai valori di configurazione tramite path dot-separated (es. `agent.model`, `providers.anthropic.api_key`, `memory.conversation_retention_days`)
- **Get**: `config_get(&config, "agent.model")` restituisce il valore come stringa; i campi sensibili (api_key, token, secret, password) vengono mascherati mostrando solo i primi 6 caratteri
- **Set**: `config_set(&mut config, "agent.temperature", "0.5")` auto-coerce il valore: "true"/"false" -> bool, numeri interi -> i64, decimali -> f64, tutto il resto -> String. Dopo il set, la config viene deserializzata di nuovo per validare la modifica
- **Set value**: `config_set_value()` accetta valori JSON pre-tipizzati per array e oggetti
- **List**: `config_list_keys(&config)` restituisce tutte le chiavi come coppie `(dot_path, valore_formattato)`
- **Edge case**: chiavi inesistenti restituiscono errore con il punto esatto di fallimento. I set su campi omessi da `skip_serializing_if` inseriscono il valore nell'albero JSON e la validazione avviene alla deserializzazione di ritorno

#### Dettagli Tecnici
- **Modulo**: `src/config/dotpath.rs` (380 righe con test)
- **Flusso dati**: Config -> `serde_json::to_value` -> navigazione/modifica JSON -> `serde_json::from_value` -> Config validata
- **Funzioni**: `config_get()`, `config_set()`, `config_set_value()`, `config_list_keys()`
- **Helper interni**: `navigate_path()` (navigazione dot-path), `set_path()` (set con creazione intermedi), `coerce_value()` (auto-coercion), `format_value()` (display con masking), `is_sensitive_key()` (deteccion campi sensibili), `flatten_value()` (appiattimento ricorsivo)
- **Endpoint API**: `PATCH /api/v1/config` (usato dal setup wizard e dall'onboarding JS con `patchConfig(key, value)`)

#### Dipendenze
- **Da cosa dipende**: `serde_json` per la serializzazione intermedia
- **Cosa dipende da questa feature**: Setup wizard JS (`patchConfig()`), onboarding JS, CLI `homun config get/set`

---

### 3. Provider Factory

#### Comportamento Atteso
- Dato un model string (es. `anthropic/claude-sonnet-4-20250514`), crea l'istanza del provider LLM corretta wrappata in `ReliableProvider` + `QueuedProvider`
- **Risoluzione provider** (`Config::resolve_provider()`): priorita a 4 livelli:
  1. **Keyword match diretto**: il nome del modello contiene keyword del provider (es. "claude" -> anthropic, "gpt-" -> openai, "gemini" -> gemini). 26 provider supportati in 5 categorie (Primary, Local, Cloud, Gateways, Chinese)
  2. **Prefix locale**: `ollama/` -> ollama o ollama_cloud, `vllm/` -> vllm, `custom/` -> custom
  3. **Gateway**: se OpenRouter o AiHubMix sono configurati, qualsiasi modello viene instradato li
  4. **Fallback**: primo provider con credenziali
- **API key**: recuperata da encrypted storage (`***ENCRYPTED***` marker) con auto-migrazione da plaintext a vault
- **Concorrenza auto-detect**: `llm_max_concurrent` = 0 -> 1 per provider locali (ollama/vllm), 5 per cloud

#### Dettagli Tecnici
- **Modulo**: `src/provider/factory.rs`
- **Funzioni**: `create_provider()` (da config), `create_provider_with_health()` (con circuit breaker), `create_provider_for_model()`, `create_provider_for_model_without_fallbacks()`, `create_single_provider()` (singolo provider senza wrapping)
- **Chain**: `create_single_provider()` -> provider concreto (`AnthropicProvider` | `OllamaProvider` | `OpenAICompatProvider`) -> `ReliableProvider::new(chain)` -> `QueuedProvider::new(reliable, max_concurrent)`
- **Provider concreti**: `AnthropicProvider` (API nativa Claude), `OllamaProvider` (localhost:11434), `OpenAICompatProvider` (tutti gli altri, formato OpenAI)

#### Dipendenze
- **Da cosa dipende**: `Config`, `storage::global_secrets()`, provider concreti in `src/provider/`
- **Cosa dipende da questa feature**: `agent_loop.rs` (ottiene il provider), `one_shot.rs`, web API

---

### 4. Provider Capabilities Detection

#### Comportamento Atteso
- Data una coppia (provider_name, model_name), rileva automaticamente le capability del modello: `multimodal`, `image_input`, `tool_calls`, `thinking`
- La detection e basata su string matching sul nome del modello (heuristica, nessuna API call)
- Le capability possono essere sovrascritte manualmente tramite `[agent.model_overrides."model_name"]` nella config
- **Thinking**: abilitato per Claude 4 (Sonnet/Opus), DeepSeek-R1, QwQ, o1/o3
- **Tool calls**: default true per tutti; blacklist per Ollama su modelli noti senza supporto (deepseek-r1, phi-2, tinyllama, codellama, starcoder)
- **XML fallback**: se `tool_calls` e false, il sistema usa `xml_dispatcher.rs` per injection XML nel system prompt. Priorita di decisione: provider-specific `force_xml_tools` > global `agent.force_xml_tools` > model override > auto-detect

#### Dettagli Tecnici
- **Modulo**: `src/provider/capabilities.rs`
- **Struct**: `ModelCapabilities { multimodal, image_input, tool_calls, thinking }`
- **Funzioni**: `detect_model_capabilities()`, `supports_multimodal()`, `supports_tool_calls()`, `supports_thinking()`, `supports_native_documents()` (sempre false per ora)
- **Override**: `AgentConfig::effective_model_capabilities()` in `schema.rs` applica `ModelOverrides` sopra la detection automatica
- **Endpoint API**: `POST /v1/providers/model-capabilities`

#### Dipendenze
- **Da cosa dipende**: nessuna (pura logica string-matching)
- **Cosa dipende da questa feature**: `agent_loop.rs` (decisione streaming/tools), `Config::should_use_xml_dispatch()`, prompt builder

---

### 5. Provider Reliability (Circuit Breaker, Failover, Retry)

#### Comportamento Atteso
- Wrappa una chain ordinata di provider con retry su errori transienti e failover automatico su errori permanenti
- **Retry** (stesso provider): errori 429, 5xx, timeout di rete, connection refused. Exponential backoff con jitter (default: 5 retry, delay iniziale 500ms, max 60s, moltiplicatore 2x, jitter 30%)
- **Failover** (provider successivo): errori 401, 403, context_length_exceeded, model_not_found, bad request, payload too large. Nessun retry, switch immediato
- **Sticky preference**: l'ultimo provider che ha avuto successo viene ricordato con `AtomicUsize` (`last_good`) e tentato per primo nella prossima richiesta
- **Circuit breaker**: `ProviderHealthTracker` monitora le ultime 20 richieste per provider. Soglie: >50% errori = Degraded, >80% = Down. Provider Down vengono saltati dal failover (a meno che non siano l'ultimo disponibile). Recovery automatico quando i successi riportano la rate sotto soglia
- **Streaming**: per stream con fallback multipli, max 1 retry per provider (per evitare chunk parziali da tentativi falliti)

#### Dettagli Tecnici
- **Moduli**: `src/provider/reliable.rs` (ReliableProvider), `src/provider/health.rs` (ProviderHealthTracker), `src/utils/retry.rs` (RetryConfig)
- **Struct**: `ReliableProvider { providers: Vec<ProviderEntry>, retry_config, last_good: AtomicUsize, health: Option<Arc<ProviderHealthTracker>> }`
- **Health tracker**: buffer circolare di 20 slot per provider, latenza media EMA (alpha=0.3), snapshot per API (`GET /v1/providers/health`)
- **Enum**: `FailoverDecision { Retry, NextProvider }` — classificazione errori in `classify_error()`
- **RetryConfig**: `max_retries=5`, `initial_delay=500ms`, `max_delay=60s`, `multiplier=2.0`, `jitter_factor=0.3`. Variante `RetryConfig::fast()` per operazioni rapide (3 retry, 100ms)
- **Stato rete globale**: `NETWORK_ONLINE: AtomicBool` in retry.rs, condiviso tra tutti i componenti

#### Dipendenze
- **Da cosa dipende**: `Provider` trait, `RetryConfig`
- **Cosa dipende da questa feature**: `factory.rs` wrappa ogni provider chain in ReliableProvider

---

### 6. Provider Queue (Priority + Concurrency)

#### Comportamento Atteso
- Limita la concorrenza per-provider con un semaforo Tokio, prevenendo il sovraccarico di API remote o hardware locale
- Le richieste hanno 3 livelli di priorita: **High** (chat utente interattivo), **Normal** (subagent, automazioni), **Low** (heartbeat, consolidamento memoria)
- Quando il semaforo e conteso: High passa subito, Normal attende che non ci siano High in coda, Low attende che non ci siano High ne Normal
- **Concorrenza default**: 1 per provider locali (ollama, vllm), 5 per cloud API. Configurabile con `agent.llm_max_concurrent`
- Il polling per priorita avviene ogni 50ms

#### Dettagli Tecnici
- **Modulo**: `src/provider/queued.rs`
- **Struct**: `QueuedProvider { inner: Arc<dyn Provider>, semaphore, pending: PendingCounters }`
- **PendingCounters**: `high: AtomicUsize`, `normal: AtomicUsize` — Low non ha contatore perche non blocca nessuno
- **Enum**: `RequestPriority { Low=0, Normal=1, High=2 }` definito in `traits.rs`
- Il priority e un campo di `ChatRequest` (default: Normal)

#### Dipendenze
- **Da cosa dipende**: `Provider` trait, `tokio::sync::Semaphore`
- **Cosa dipende da questa feature**: `factory.rs` wrappa ReliableProvider in QueuedProvider come ultimo strato

---

### 7. Setup Wizard

#### Comportamento Atteso
- Pagina web (`/setup`) per configurare provider LLM, modello attivo e parametri agente dopo l'installazione iniziale
- **Provider accordion**: mostra tutti i 26 provider raggruppati (Primary, Local, Cloud, Gateways, Chinese) con card espandibili
- Per ogni provider: campo API key (salvata in encrypted storage), campo API base URL opzionale, lista modelli disponibili con radio button per attivazione
- **Model activation**: selezionare un modello aggiorna `agent.model` via `PATCH /api/v1/config`. Banner in alto mostra il modello attivo
- **Connection test**: `POST /v1/providers/test` invia una richiesta di test al provider selezionato e mostra il risultato
- **Parametri agente**: temperature, max_tokens, max_iterations, memory_window con validazione real-time (range check)
- **Ollama integration**: auto-detect modelli locali via `GET /v1/providers/ollama/models`, pull modelli via `POST /v1/providers/ollama/pull`

#### Dettagli Tecnici
- **Frontend**: `static/js/setup.js` (~2800 righe, grandfathered)
- **Backend API**: `src/web/api/providers.rs` (~1500 righe, grandfathered)
- **Endpoint**:
  - `GET /v1/providers` — lista provider con stato configured/active
  - `POST /v1/providers/configure` — salva API key in encrypted storage + api_base in config
  - `POST /v1/providers/activate` — attiva un modello (`config.agent.model = model`)
  - `POST /v1/providers/deactivate` — disattiva un provider
  - `POST /v1/providers/test` — test connessione con richiesta LLM reale
  - `GET /v1/providers/health` — snapshot salute provider (dal HealthTracker)
  - `GET /v1/providers/models` — lista tutti i modelli disponibili
  - `POST /v1/providers/model-capabilities` — risolve capability per un modello
  - `GET /v1/providers/ollama/models` — lista modelli Ollama locali
  - `POST /v1/providers/ollama/pull` — scarica modello Ollama
  - `GET /v1/providers/ollama-cloud/models` — lista modelli Ollama Cloud
  - `GET /v1/providers/embedding-models` — lista modelli embedding
- **Validazione JS**: `validateNumberField()` (range), `validateUrlField()` (formato URL), `setFieldValidation()` (feedback visivo)

#### Dipendenze
- **Da cosa dipende**: `Config`, `storage::global_secrets()`, `provider/factory.rs`
- **Cosa dipende da questa feature**: l'intero sistema LLM richiede almeno un provider configurato

---

### 8. Onboarding

#### Comportamento Atteso
- Wizard multi-fase al primo avvio, full-page senza sidebar. 5 step: Account -> Provider -> Persona -> Channels -> Ready
- **Step 1 - Account**: creazione utente admin (username + password), selezione lingua (en/it), auto-detect timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone`
- **Step 2 - Provider**: selezione provider LLM tra 8 opzioni principali (Anthropic, OpenAI, Ollama, Ollama Cloud, OpenRouter, DeepSeek, Groq, Gemini). Inserimento API key, selezione modello
- **Step 3 - Persona**: configurazione nome utente e personalita assistente, selezione accent color (5 preset: Blue, Moss, Terra, Plum, Stone)
- **Step 4 - Channels**: configurazione opzionale canali (Telegram, WhatsApp, Discord, Slack, Email)
- **Step 5 - Ready**: riepilogo e avvio
- **Resume**: lo stato viene verificato tramite `GET /v1/onboarding/status` che indica quali step sono gia completati (has_account, has_provider, has_model, has_profile, gateways_count)
- **Completamento**: `POST /v1/onboarding/complete` setta `ui.onboarding_completed = true` nella config
- **Sicurezza**: tutto il contenuto dinamico e sanitizzato via `esc()` prima dell'inserimento DOM (XSS prevention)

#### Dettagli Tecnici
- **Frontend**: `static/js/onboarding.js` (~750 righe)
- **Backend**: `src/web/api/onboarding.rs`
- **Endpoint**:
  - `GET /v1/onboarding/status` — struct `OnboardingStatus` con campi: completed, has_account, has_provider, has_model, has_profile, gateways_count, user_name, language, timezone, model
  - `POST /v1/onboarding/complete` — segna il wizard come completato
- **Stato**: `ui.onboarding_completed` in config determina se mostrare la pagina di onboarding o la chat
- **Persistenza config**: ogni step salva via `patchConfig()` -> `PATCH /api/v1/config`
- **DB check**: `has_account` controlla `db.count_users_with_password()`, `has_profile` controlla tabella profiles

#### Dipendenze
- **Da cosa dipende**: API account (`POST /api/v1/account`), API providers, API config
- **Cosa dipende da questa feature**: il redirect alla chat dopo il completamento, flag `ui.onboarding_completed`

---

### 9. MCP Auto-Setup

#### Comportamento Atteso
- Configurazione automatica di server MCP a partire da preset curati (`McpServerPreset`)
- I preset definiscono: transport (stdio/http), command, args, variabili d'ambiente richieste (con flag `secret` e `required`)
- Le variabili segrete vengono salvate nel vault con riferimento `vault://` nella config
- Template nei args: `{{workspace}}` -> `~/.homun/workspace/`, `{{home}}` -> home directory
- Connection test via `test_mcp_server_connection()`: avvia il server MCP, lista i tool, restituisce risultato con tool_count e info server

#### Dettagli Tecnici
- **Modulo**: `src/mcp_setup.rs`
- **Struct**: `McpSetupResult { stored_vault_keys, missing_required_env }`, `McpConnectionTestResult { connected, tool_count, server_name, server_version, error }`
- **Funzioni**: `apply_mcp_preset_setup()` (applica preset a config), `render_mcp_arg_template()` (resolve template), `parse_env_assignments()` (parse KEY=VALUE), `test_mcp_server_connection()` (test connessione)
- **Config struct**: `McpServerConfig { transport, command, args, url, env, capabilities, enabled, recipe_id, auth_env_key, discovered_tool_count }`
- **Feature gate**: `test_mcp_server_connection()` richiede `#[cfg(feature = "mcp")]`; senza la feature restituisce errore

#### Dipendenze
- **Da cosa dipende**: `Config`, `storage::global_secrets()`, `tools::McpManager`, `skills::McpServerPreset`
- **Cosa dipende da questa feature**: gateway (avvio server MCP), web API MCP catalog

---

### 10. Service Management

#### Comportamento Atteso
- Installazione di Homun come servizio OS per auto-avvio al boot
- **macOS**: launchd user agent. Plist in `~/Library/LaunchAgents/ai.homun.daemon.plist`. RunAtLoad=true, KeepAlive on crash, ThrottleInterval=10s. Logs in `~/.homun/logs/daemon.log`
- **Linux**: systemd user service. Unit in `~/.config/systemd/user/homun.service`. Restart=on-failure, RestartSec=10s. Security hardening: NoNewPrivileges, ProtectSystem=strict, ProtectHome=read-only con ReadWritePaths per ~/.homun
- **Comandi**: `homun service install` (installa + abilita), `homun service start`, `homun service stop`, `homun service uninstall`
- **Status**: `ServiceStatus { installed, running, enabled, service_file }`
- **Windows**: non supportato (bail con errore)

#### Dettagli Tecnici
- **Moduli**: `src/service/mod.rs` (dispatch per OS), `src/service/launchd.rs` (macOS), `src/service/systemd.rs` (Linux)
- **Label macOS**: `ai.homun.daemon`
- **Unit Linux**: `homun.service` in `~/.config/systemd/user/`
- **Comando eseguito**: `{binary_path} gateway` (avvia il gateway completo)
- **Funzioni**: `install()`, `uninstall()`, `start()`, `stop()`, `is_installed()`, `status()`
- **Binary path**: risolto via `std::env::current_exe()`

#### Dipendenze
- **Da cosa dipende**: comandi OS (`launchctl`, `systemctl`), accesso filesystem
- **Cosa dipende da questa feature**: CLI `homun service *`

---

### 11. Hot-Reload vs Restart

#### Comportamento Atteso
- Alcune modifiche alla configurazione si applicano immediatamente, altre richiedono un restart del gateway.

**Hot-reload (nessun restart necessario)**:
- File bootstrap: `USER.md`, `SOUL.md`, `INSTRUCTIONS.md` in `~/.homun/brain/` — monitorati da `BootstrapWatcher` con `notify` crate, ricaricati automaticamente nel contesto dell'agente
- Summary delle skill: aggiornabile a runtime via `Arc<RwLock<String>>`
- Modello corrente nel system prompt: aggiornabile via `update_model_name()`
- Config in memoria: l'`AppState` del web server mantiene `config: Arc<RwLock<Config>>` — i PATCH API aggiornano sia il file che la copia in-memory

**Modifiche che richiedono restart del gateway**:
- Canali (Telegram, WhatsApp, Discord, Slack, Email): i listener vengono avviati una sola volta in `gateway.rs`
- Provider LLM: la chain di provider viene costruita una volta all'avvio (il modello puo cambiare, ma la chain Reliable+Queued e fissa)
- Server MCP: avviati all'avvio del gateway (eccezione: hot-add via `start_channel` per canali aggiunti post-pairing)
- Porta web/TLS: l'Axum server viene bindato una volta all'avvio
- Cron jobs e automazioni: il scheduler viene configurato all'avvio

**Hot-add canali (parziale)**:
- Il gateway supporta `start_channel` per avviare un canale a runtime dopo pairing (es. WhatsApp dopo scansione QR code), ma non supporta la rimozione o riconfigurazione di canali gia avviati

#### Dettagli Tecnici
- **Moduli**: `src/agent/bootstrap_watcher.rs` (file watcher), `src/agent/context.rs` (contesto agente con `Arc<RwLock<>>`)
- **AppState**: `config: Arc<RwLock<Config>>`, `save_config()` aggiorna sia l'in-memory che il file TOML
- **Settings modal**: `src/web/api/settings.rs` serve sezioni HTML del settings modal via `GET /v1/settings/section/{name}` (17 sezioni: account, setup, appearance, channels, browser, vault, api-keys, approvals, file-access, shell, sandbox, maintenance, logs, traces, usage, health, history)

#### Dipendenze
- **Da cosa dipende**: `notify` crate (filesystem watcher), `tokio::sync::RwLock`
- **Cosa dipende da questa feature**: tutto il sistema dipende dalla corretta propagazione delle modifiche config
