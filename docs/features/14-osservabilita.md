# Osservabilita

## Panoramica

Il dominio Osservabilita comprende tutti i meccanismi che permettono di monitorare, diagnosticare e ispezionare il comportamento del sistema Homun in tempo reale e a posteriori. Include il tracciamento delle richieste agent (dalla cognition all'output), il logging strutturato con streaming SSE, il circuit breaker per provider LLM e canali, il tracking dello stato delle esecuzioni web, e le API per status, usage, log e trace.

I dati di osservabilita vivono su tre supporti: file system (`~/.homun/logs/`, `~/.homun/traces/`), database SQLite (tabella `token_usage`), e memoria in-process (broadcast channel, `WebRunStore`, health tracker).

## Funzionalita

---

### 1. Request Tracing

#### Comportamento Atteso

- Ogni richiesta elaborata dall'agent loop genera una **trace** completa che documenta l'intero ciclo di vita: messaggio utente, fase di cognition (intent, piano, tool scoperti, discovery step), ogni tool call eseguita durante l'execution loop, risposta finale, contatori e durata.
- La trace viene scritta come file JSON in `~/.homun/traces/` al termine dell'elaborazione.
- Il nome del file segue il formato `{timestamp_ms}_{id}.json` per ordinamento cronologico naturale.
- I file piu vecchi vengono eliminati automaticamente quando il conteggio supera `traces_max_files` (default: 50).
- Input: messaggi inbound dall'agent loop. Output: file JSON su disco.
- Stati possibili della trace: `completed`, `cancelled`.
- Edge case: la cognition puo fallire e ricadere nel fallback (tutti i tool caricati). Questo viene registrato con `is_fallback: true` e `fallback_reason`.
- I campi di testo lungo vengono troncati: `args_summary` a 400 caratteri, `result_summary` a 500, `final_response` a 500.
- Il trace ID e un UUID v4 troncato a 8 caratteri.

#### Dettagli Tecnici

- **Moduli/file**: `src/agent/request_trace.rs`
- **Struct principali**:
  - `RequestTracer` — accumulatore mutabile, creato a inizio richiesta con `RequestTracer::new(channel, session_key, request)`
  - `RequestTrace` — struttura serializzabile finale
  - `TraceCognition` — sommario della fase cognition (intent_type, understanding, plan, constraints, discovered_tools, discovery_steps, answer_directly, is_fallback, fallback_reason)
  - `CognitionStep` — singola chiamata tool nel mini-loop cognition (iteration, tool, args_summary, result_summary)
  - `TraceStep` — singola chiamata tool nel loop principale (iteration, tool, args_summary, result_summary, is_error, guard_decision, browser_stuck_level, visual_check, iteration_budget)
  - `TraceStatus` — enum `Completed | Cancelled`
- **Flusso dati**:
  1. `RequestTracer::new()` crea il tracer con timestamp e ID
  2. `record_models()` registra i modelli LLM usati per cognition e execution
  3. `record_cognition_step()` registra ogni discovery tool call nella cognition
  4. `record_cognition()` registra il risultato finale della cognition (preservando i discovery_steps precedenti)
  5. `record_step()` registra ogni tool call nell'execution loop
  6. `annotate_last_step_browser()` annota con guard decision e stuck level
  7. `annotate_last_step_visual()` annota con risultato visual check
  8. `record_stop_reason()` registra perche l'esecuzione si e fermata
  9. `finalize()` chiude la trace con risposta, iterazioni, token e durata
  10. `write_to_disk()` serializza in JSON pretty e scrive su disco
- **Funzioni di lettura**: `list_traces()` (ordinamento newest-first), `read_trace(id)` (match per suffisso `_{id}.json`)
- **Trimming**: `trim_old_traces()` rimuove i file piu vecchi quando il conteggio supera il massimo
- **Storage**: file JSON su filesystem in `~/.homun/traces/` (no DB)
- **Tabelle DB**: nessuna (solo filesystem)
- **Endpoint API**: vedi sezione "Trace Viewer"

#### Dipendenze

- Dipende da: `agent/cognition::CognitionResult`, `utils::text::truncate_str`, `uuid`, `chrono`, `serde_json`
- Dipendono da questa feature: API traces (`web/api/traces.rs`), pagina Trace Viewer (`static/js/traces.js`)

---

### 2. Structured Logging

#### Comportamento Atteso

- Tutti gli eventi di tracing del processo vengono intercettati da un layer custom (`SseLogLayer`) che li converte in record strutturati (`LogRecord`) e li distribuisce su due canali: persistenza su file e streaming real-time via broadcast.
- Ogni `LogRecord` contiene: timestamp (RFC 3339), livello (info/warn/error/debug/trace), target, messaggio, module_path, file sorgente, numero riga, campi extra (key-value), e contesto opzionale di profilo (`profile_id`, `user_id`).
- I log vengono persistiti su disco in formato JSONL in `~/.homun/logs/events.jsonl`.
- Quando il file supera 16 MB, viene trimmato mantenendo gli ultimi 2500 record (meta di `LOG_HISTORY_LIMIT / 2`).
- Lo streaming real-time avviene via `tokio::sync::broadcast` con capacita 2048 messaggi. I client lenti ricevono un evento di warning con il conteggio dei messaggi persi (lag).
- Il contesto profilo/utente viene propagato tramite `tokio::task_local` (`TASK_PROFILE_SCOPE`), impostato dall'agent loop e letto dal layer al momento dell'emissione.

#### Dettagli Tecnici

- **Moduli/file**: `src/logs.rs`
- **Struct principali**:
  - `LogRecord` — record strutturato serializzabile (timestamp, level, target, message, module_path, file, line, fields, profile_id, user_id)
  - `LogFieldRecord` — singolo campo extra (key, value)
  - `SseLogLayer` — implementazione `tracing_subscriber::Layer` che intercetta ogni evento
  - `ProfileScope` — contesto task-local con profile_id e user_id
  - `LogFieldVisitor` — visitor per estrarre campi dagli eventi tracing
- **Flusso dati**:
  1. Evento tracing emesso in qualsiasi punto del codice
  2. `SseLogLayer::on_event()` lo cattura, estrae i campi con `LogFieldVisitor`
  3. Legge il `ProfileScope` dal task-local (se presente)
  4. Costruisce un `LogRecord`
  5. `persist_record()` lo appende a `events.jsonl` e controlla la dimensione del file
  6. `log_stream().send()` lo invia al broadcast channel
- **Persistenza**: file JSONL in `~/.homun/logs/events.jsonl` (configurabile via `HOMUN_LOG_STATE_DIR`)
- **Costanti**: `LOG_STREAM_CAPACITY = 2048`, `LOG_HISTORY_LIMIT = 5000`
- **Funzione pubblica**: `subscribe()` restituisce un `broadcast::Receiver<LogRecord>`, `recent(limit)` legge gli ultimi N record dal file
- **Tabelle DB**: nessuna (solo filesystem)

#### Dipendenze

- Dipende da: `tracing`, `tracing_subscriber`, `tokio::sync::broadcast`, `chrono`, `serde_json`
- Dipendono da questa feature: API logs (`web/api/logs.rs`), pagina Log Viewer (`static/js/logs.js`)

---

### 3. Health Monitoring

#### Comportamento Atteso

- **Provider LLM**: ogni chiamata LLM (successo o errore) viene registrata nel `ProviderHealthTracker`. Lo stato del provider e calcolato sulla base dell'error rate degli ultimi 20 risultati (circular buffer). Tre stati: `Healthy` (error rate < 50%), `Degraded` (50-80%), `Down` (> 80%). I provider Down vengono saltati dal `ReliableProvider` per il failover. La latenza media viene calcolata con EMA (alpha = 0.3). Il recovery avviene naturalmente quando nuovi successi entrano nel buffer circolare.
- **Canali**: ogni canale di messaggistica ha un tracker analogo (`ChannelHealthTracker`) con gli stessi meccanismi. Aggiunge campi specifici: `started_at`, `restart_count`, `uptime_secs`, `enabled`. Quattro stati: `Healthy`, `Degraded`, `Down`, `Stopped` (canale non in esecuzione). Il `mark_started()` incrementa il restart count dopo il primo avvio. Il `mark_stopped()` segna il canale come non running e registra l'eventuale errore.
- **Health composita**: l'endpoint `/api/v1/health/components` aggrega lo stato di 6 sottosistemi: database (query `SELECT 1`), LLM providers, channels, tools (conteggio), knowledge/RAG (stats), data directory (esiste e scrivibile). Lo stato globale e il peggiore tra i componenti.

#### Dettagli Tecnici

- **Moduli/file**: `src/provider/health.rs`, `src/channels/health.rs`, `src/web/api/health.rs`
- **Struct principali**:
  - `ProviderHealthTracker` — tracker provider con `RwLock<HashMap<String, ProviderMetrics>>`
  - `ProviderMetrics` — buffer circolare di 20 outcome, contatori totali, latenza EMA, ultimo errore
  - `ProviderHealthSnapshot` — snapshot per API (name, status, total_requests, total_errors, error_rate_recent, avg_latency_ms, last_error_msg)
  - `ProviderStatus` — enum `Healthy | Degraded | Down`
  - `ChannelHealthTracker` — tracker canali con struttura analoga
  - `ChannelMetrics` — come ProviderMetrics ma con enabled, started_at, started_at_wall, restart_count, running
  - `ChannelHealthSnapshot` — snapshot per API (name, status, enabled, total_messages, total_errors, error_rate_recent, last_error, last_error_at, started_at, restart_count, uptime_secs)
  - `ChannelStatus` — enum `Healthy | Degraded | Down | Stopped`
  - `ComponentHealth` — health di un singolo sottosistema (name, status, message, details)
- **Costanti provider**: `WINDOW_SIZE = 20`, `DEGRADED_THRESHOLD = 0.5`, `DOWN_THRESHOLD = 0.8`, `LATENCY_ALPHA = 0.3`
- **Costanti canali**: stessi threshold di provider
- **Metodi chiave provider**: `record_success()`, `record_error()`, `is_available()`, `status()`, `snapshots()`
- **Metodi chiave canali**: `mark_started()`, `mark_stopped()`, `mark_enabled()`, `record_message()`, `record_error()`, `status()`, `is_available()`, `snapshot()`, `snapshots()`
- **Componenti health check**: `check_database()` (query SELECT 1), `check_providers()` (snapshot tracker), `check_channels()` (snapshot tracker o fallback config), `check_tools()` (conteggio registry), `check_knowledge()` (stats RAG, solo con feature `embeddings`), `check_data_dir()` (esistenza e tipo directory)
- **Tabelle DB**: nessuna (in-memory)
- **Endpoint API**:
  - `GET /api/health` — health check pubblico (status, version, uptime_secs). Registrato direttamente in `server.rs`, non autenticato
  - `GET /api/v1/health/components` — health dettagliata per sottosistema, autenticato. Restituisce stato globale derivato dal peggiore componente
  - `GET /api/v1/channels/health` — health runtime per singolo canale, autenticato
  - `POST /api/v1/emergency-stop` — attiva l'emergency stop (richiede permesso e-stop)
  - `POST /api/v1/resume` — riprende dopo emergency stop

#### Dipendenze

- Dipende da: `AppState` (db, health_tracker, channel_health, tool_registry, rag_engine, estop_handles, config), `sqlx`
- Dipendono da questa feature: `ReliableProvider` (failover basato su `is_available()`), gateway (restart logic basata su stato canale), dashboard UI (`static/js/dashboard.js`)

---

### 4. Run State

#### Comportamento Atteso

- Traccia lo stato di ogni esecuzione (run) della chat web in tempo reale. Ogni messaggio utente inviato via WebSocket crea un run con stato `running`.
- Lo store mantiene al massimo un run attivo per sessione. Un tentativo di avviare un secondo run sulla stessa sessione restituisce errore.
- Durante l'esecuzione, gli eventi di streaming (delta di testo, eventi tipizzati come tool call, model, plan) vengono accumulati nella snapshot del run.
- Gli eventi `plan` seguono una politica di sostituzione: solo l'ultimo evento plan viene mantenuto, per evitare replay di stati intermedi alla riconnessione.
- L'evento `model` popola il campo `effective_model` della snapshot.
- Il run transita tra gli stati: `running` -> `stopping` (richiesta di stop) -> `completed` (completamento), oppure `running` -> `interrupted` (run stale scaduto).
- La funzione `expire_stale_runs(max_age_secs)` marca come `interrupted` i run in stato `running` o `stopping` piu vecchi del cutoff, prevenendo run orfani dopo crash o disconnessione WebSocket.
- `clear_session()` rimuove tutti i run (attivi e completati) per una sessione.

#### Dettagli Tecnici

- **Moduli/file**: `src/web/run_state.rs`
- **Struct principali**:
  - `WebRunStore` — store thread-safe con `Mutex<WebRunStoreInner>` e `AtomicU64` per ID incrementale
  - `WebRunStoreInner` — contiene `runs: HashMap<String, WebChatRunSnapshot>` e `active_by_session: HashMap<String, String>`
  - `WebChatRunSnapshot` — snapshot completa di un run (run_id, session_key, status, user_message, effective_model, assistant_response, created_at, updated_at, events, error)
  - `WebChatRunEvent` — singolo evento (event_type, name, tool_call opzionale con `ToolCallData`)
- **Formato run_id**: `run_{timestamp_ms}_{counter}`
- **Metodi chiave**: `start_run()`, `active_snapshot()`, `append_stream_message()`, `complete_run()`, `request_stop()`, `clear_session()`, `expire_stale_runs()`
- **Flusso dati**:
  1. Client WebSocket invia messaggio -> `start_run()` crea snapshot con stato `running`
  2. Agent loop emette `StreamMessage` -> `append_stream_message()` accumula delta e eventi
  3. Agent loop completa -> `complete_run()` imposta stato `completed` e risposta finale
  4. Oppure: client richiede stop -> `request_stop()` imposta stato `stopping`
  5. Cleanup: `expire_stale_runs()` rimuove run orfani dopo il timeout
- **Tabelle DB**: nessuna (in-memory)

#### Dipendenze

- Dipende da: `bus::StreamMessage`, `provider::ToolCallData`, `chrono`
- Dipendono da questa feature: WebSocket handler (`web/ws.rs`), chat API

---

### 5. Status API

#### Comportamento Atteso

- Espone un endpoint che restituisce una panoramica dello stato del sistema: versione del binario, modello LLM configurato, provider LLM risolto, uptime, stato abilitazione di ogni canale (telegram, discord, slack, whatsapp, email, web), e conteggio skill installate.
- Espone anche endpoint per leggere e modificare la configurazione corrente (model, max_tokens, temperature, max_iterations, stato canali, provider).

#### Dettagli Tecnici

- **Moduli/file**: `src/web/api/status.rs`
- **Struct principali**:
  - `StatusResponse` — version, model, provider, uptime_secs, channels (Vec<ChannelStatus>), skills_count
  - `ChannelStatus` — name, enabled
  - `ConfigResponse` — agent (model, max_tokens, temperature, max_iterations), channels (*_enabled per ogni canale), has_provider, provider_name
  - `ConfigPatch` — key (dotpath), value (JSON)
- **Endpoint API**:
  - `GET /api/v1/status` — stato generale del sistema
  - `GET /api/v1/config` — configurazione corrente (lettura)
  - `PATCH /api/v1/config` — modifica configurazione via dotpath (body: `{"key": "agent.model", "value": "claude-sonnet-4-20250514"}`)
- **Flusso dati**:
  - Status: legge config da `state.config`, risolve il provider tramite `config.resolve_provider()`, conta le skill via `SkillInstaller::list_installed()`
  - Config patch: deserializza il valore, applica via `config_set()` o `config_set_value()`, salva con `state.save_config()`
- **Tabelle DB**: nessuna (legge config TOML e stato in-memory)

#### Dipendenze

- Dipende da: `AppState` (config, started_at), `config::dotpath`, `skills::SkillInstaller`
- Dipendono da questa feature: dashboard UI, setup wizard, pagina account

---

### 6. Usage API

#### Comportamento Atteso

- Espone metriche di utilizzo dei token LLM, aggregate per modello/provider e per giorno.
- Supporta filtri opzionali: `session` (session_key specifica), `since` e `until` (range temporale ISO 8601).
- Restituisce tre sezioni: `models` (aggregati per modello+provider), `days` (aggregati per giorno), `totals` (somma globale di prompt_tokens, completion_tokens, total_tokens, call_count).
- I dati provengono dalla tabella `token_usage` in SQLite, alimentata ad ogni chiamata LLM tramite `db.insert_token_usage()`.

#### Dettagli Tecnici

- **Moduli/file**: `src/web/api/usage.rs`, `src/storage/db.rs` (query e insert)
- **Struct principali**:
  - `UsageResponse` — models (Vec<TokenUsageAggRow>), days (Vec<TokenUsageDailyRow>), totals (UsageTotals)
  - `UsageTotals` — prompt_tokens, completion_tokens, total_tokens, call_count (calcolati come somma delle righe aggregate)
  - `TokenUsageAggRow` — model, provider, prompt_tokens, completion_tokens, total_tokens, call_count
  - `TokenUsageDailyRow` — day, prompt_tokens, completion_tokens, total_tokens, call_count
  - `UsageQuery` — session (Option), since (Option), until (Option)
- **Tabella DB**: `token_usage`
  - Colonne: `id` (PK autoincrement), `session_key` (TEXT NOT NULL), `model` (TEXT NOT NULL), `provider` (TEXT NOT NULL), `prompt_tokens` (INTEGER), `completion_tokens` (INTEGER), `total_tokens` (INTEGER), `created_at` (TEXT, default datetime('now'))
  - Indici: `idx_token_usage_session` su session_key, `idx_token_usage_created` su created_at
  - Migrazione: `migrations/004_token_usage.sql`
- **Endpoint API**:
  - `GET /api/v1/usage` — metriche di utilizzo token
  - Query parameters: `session`, `since`, `until`
- **Flusso dati**:
  1. Ogni chiamata LLM nel provider scrive una riga tramite `db.insert_token_usage(session_key, model, provider, prompt, completion, total)`
  2. `db.query_token_usage()` aggrega per modello+provider con SUM e COUNT, filtrando per session/since/until
  3. `db.query_token_usage_daily()` aggrega per giorno (`date(created_at)`) con gli stessi filtri
  4. L'handler somma i totali dalle righe aggregate

#### Dipendenze

- Dipende da: `AppState` (db), `storage::db` (query_token_usage, query_token_usage_daily)
- Dipendono da questa feature: dashboard usage analytics (`static/js/dash-usage.js`)

---

### 7. Log Viewer

#### Comportamento Atteso

- Permette la visualizzazione dei log del sistema sia in modalita storica (ultimi N record) che in streaming real-time via Server-Sent Events (SSE).
- L'endpoint `recent` restituisce fino a 1000 record dal file `events.jsonl`, con default 250. Il parametro `limit` viene clamped tra 1 e 1000.
- L'endpoint `stream` apre una connessione SSE persistente che emette eventi `log` in formato JSON. Il keep-alive invia un heartbeat ogni 15 secondi. In caso di lag (client lento), viene emesso un evento di warning con il conteggio dei messaggi persi.
- Lo stream SSE si chiude quando il broadcast sender viene droppato (shutdown del processo).

#### Dettagli Tecnici

- **Moduli/file**: `src/web/api/logs.rs`, `src/logs.rs` (subscribe, recent)
- **Endpoint API**:
  - `GET /api/v1/logs/recent` — log storici. Query parameter: `limit` (default 250, max 1000)
  - `GET /api/v1/logs/stream` — streaming SSE real-time. Evento SSE di tipo `log` con payload JSON `LogRecord`
- **Flusso dati stream**:
  1. Handler chiama `crate::logs::subscribe()` per ottenere un `broadcast::Receiver<LogRecord>`
  2. `futures::stream::unfold()` trasforma il receiver in uno stream SSE
  3. `Ok(record)` -> evento `log` con payload JSON
  4. `RecvError::Lagged(n)` -> evento `log` con messaggio di warning sul lag
  5. `RecvError::Closed` -> stream terminato
  6. Keep-alive ogni 15 secondi con testo `keepalive`
- **Flusso dati recent**:
  1. Handler chiama `crate::logs::recent(limit)`
  2. `read_recent_records()` legge il file `events.jsonl` riga per riga, deserializza, e mantiene gli ultimi N record (capped a `LOG_HISTORY_LIMIT = 5000`)
- **Tabelle DB**: nessuna (file system + broadcast in-memory)

#### Dipendenze

- Dipende da: `logs::subscribe()`, `logs::recent()`, `futures`, `axum::response::sse`
- Dipendono da questa feature: pagina Log Viewer (`static/js/logs.js`)

---

### 8. Trace Viewer

#### Comportamento Atteso

- Permette la visualizzazione delle trace delle richieste agent, sia come lista sommaria che come dettaglio completo di una singola trace.
- La lista restituisce un sommario leggero per ogni trace: id, timestamp, canale, sommario della richiesta (80 caratteri), intent_type, modelli LLM, flag fallback, iterazioni totali, token totali, durata in ms, stato, numero di step. L'ordinamento e newest-first (dal nome file che inizia con timestamp ms).
- Il dettaglio restituisce l'intera struttura `RequestTrace` con tutti i campi (cognition completa, tutti gli step con annotazioni browser/visual, stop reason, budget finale).
- L'endpoint delete svuota la directory traces eliminando tutti i file `.json`.

#### Dettagli Tecnici

- **Moduli/file**: `src/web/api/traces.rs`, `src/agent/request_trace.rs` (list_traces, read_trace, traces_dir)
- **Struct principali**:
  - `TraceListItem` — sommario leggero per la lista (id, started_at, channel, request_summary, intent_type, cognition_model, execution_model, is_fallback, total_iterations, total_tokens, duration_ms, status, steps count)
- **Endpoint API**:
  - `GET /api/v1/traces` — lista di tutte le trace (newest-first)
  - `GET /api/v1/traces/{id}` — dettaglio completo di una trace per ID. Restituisce 404 se non trovata
  - `DELETE /api/v1/traces` — elimina tutti i file trace. Restituisce `{"ok": true, "deleted": N}`
- **Flusso dati lista**:
  1. `list_traces()` legge la directory `~/.homun/traces/`, filtra per `.json`, ordina per nome file (newest-first)
  2. Per ogni file, legge il contenuto e deserializza in `RequestTrace`
  3. Costruisce un `TraceListItem` con campi riassuntivi (request troncata a 80 caratteri)
  4. Il flag `is_fallback` viene incluso nella risposta solo se `true`
- **Flusso dati dettaglio**:
  1. `read_trace(id)` scorre i file in `~/.homun/traces/`, cerca un file il cui nome contiene l'ID
  2. Legge e deserializza il file in `RequestTrace`
- **Tabelle DB**: nessuna (file system)

#### Dipendenze

- Dipende da: `agent::request_trace` (list_traces, read_trace, traces_dir, RequestTrace, TraceStatus), `utils::text::truncate_str`
- Dipendono da questa feature: pagina Trace Viewer (`static/js/traces.js`)

---

### 9. Prometheus Metrics Endpoint (Sprint 9 OBS-1)

#### Comportamento Atteso

- Espone un endpoint `/metrics` in formato testo Prometheus (versione 0.0.4) con counter, gauge e histogram per le hot path principali del sistema.
- L'endpoint esiste in **due varianti**:
  - `GET /api/v1/metrics` — sempre dietro web auth, usato dalla dashboard UI per renderizzare tile metriche live.
  - `GET /metrics` — esposto sul root path **solo** quando `[metrics] public = true`. Patterns Prometheus scrape standard.
- Il registry è registrato al boot del Gateway via `register_homun_metrics()` e popolato in tempo reale dalle hot path instrumentate.
- Quando `[metrics] enabled = false`, entrambi gli endpoint restituiscono 404 e tutte le `counter_inc/gauge_set/histogram_observe` diventano no-op silenti.

#### Metriche esposte

| Metrica | Tipo | Labels | Sorgente |
|---|---|---|---|
| `homun_requests_total` | counter | `channel`, `status` | `AgentLoop::process_message_with_retry` |
| `homun_tool_calls_total` | counter | `tool`, `status` | `ToolRegistry::execute` |
| `homun_llm_tokens_total` | counter | `provider`, `direction` | `ReliableProvider::chat` |
| `homun_active_sessions` | gauge | — | (TBD: SessionManager) |
| `homun_memory_chunks_total` | gauge | — | (TBD: memory_db) |
| `homun_vault_entries_total` | gauge | — | (TBD: vault) |
| `homun_rag_documents_total` | gauge | — | (TBD: rag engine) |
| `homun_uptime_seconds` | gauge | — | scrape time da AppState.started_at |
| `homun_heartbeat_last_fire_timestamp` | gauge | — | (TBD: HeartbeatService — surface bug #64) |
| `homun_cognition_latency_seconds` | histogram | `outcome` | `run_cognition` Ok/Err branch |
| `homun_tool_execution_latency_seconds` | histogram | `tool` | `ToolRegistry::execute` |
| `homun_llm_latency_seconds` | histogram | `provider`, `model` | `ReliableProvider::chat` |

#### Dettagli Tecnici

- **Moduli/file**: `src/metrics.rs` (registry zero-deps), `src/web/api/metrics.rs` (handler axum)
- **Design**: `OnceLock<MetricsRegistry>` per il singleton, `RwLock<BTreeMap<String, *Family>>` interno con fast path read-lock + slow path write-lock per nuove (label set) coppie. Counter/Gauge usano `Arc<AtomicU64>`, Gauge stora `f64` come `to_bits()` per atomicità lock-free, Histogram usa CAS loop sul `sum_bits` e `Vec<(f64, AtomicU64)>` per i bucket cumulative.
- **Output Prometheus text format** con escape RFC-compliant (backslash, quote, newline), label sorting deterministico, integer float elision.
- **Auth gating**: `/api/v1/metrics` usa il middleware standard `auth_middleware` come ogni altro `/v1/*`. Il `/metrics` root è registrato condizionalmente in `WebServer::start()` dentro il sub-tree `public` (no auth) solo se `metrics_public == true`.

#### Configurazione

- `[metrics] enabled = true` (default) — master switch
- `[metrics] public = false` (default) — opt-in per scrape Prometheus standard

#### Dipendenze

- Dipende da: tracing (per il `tracing::info!` di registrazione), `chrono` (per `homun_uptime_seconds` rendering), nessuna dep nuova
- Dipendono da questa feature: hot path instrumentation in `agent_loop.rs`, `cognition/engine.rs`, `tools/registry.rs`, `provider/reliable.rs`

---

### 10. End-to-End Trace ID Propagation (Sprint 9 OBS-2)

#### Comportamento Atteso

- Ogni richiesta utente (HTTP o non-HTTP) riceve un **trace ID** univoco di 8 caratteri esadecimali.
- Per richieste HTTP: il middleware `trace_id_middleware` legge l'header `X-Request-ID` se presente (validato tramite whitelist `[a-zA-Z0-9_-]{4,128}`) o ne genera uno fresco. L'ID viene echoed nell'header di risposta.
- Per richieste non-HTTP (CLI, Telegram, Discord, Slack, WhatsApp, Email, Web-via-bus): `dispatch_to_agent` (gateway message bus) wrappa il processing in `TASK_TRACE_ID.scope(new_trace_id(), ...)`.
- L'ID è disponibile via `crate::logs::current_trace_id()` da qualsiasi punto del codice — sopravvive a `.await` yields e thread migration grazie a `tokio::task_local!`.
- Tutti i `LogRecord` emessi dentro uno scope vengono automaticamente taggati con il `trace_id` via `SseLogLayer::on_event`.
- `RequestTracer::new` legge `current_trace_id()` per unificare l'ID del trace file con il `X-Request-ID` HTTP — un singolo identificatore end-to-end.

#### Dettagli Tecnici

- **Moduli/file**: `src/logs.rs` (task-local + `current_trace_id()` + `new_trace_id()`), `src/web/trace.rs` (HTTP middleware), `src/agent/gateway.rs` (`dispatch_to_agent` wrap), `src/channels/cli.rs` (CLI wrap), `src/agent/request_trace.rs` (RequestTracer unification)
- **`is_well_formed`** valida inbound `X-Request-ID`: rifiuta lunghezze fuori da [4, 128], rifiuta tutto ciò che non è ASCII alfanumerico o `-_`. Difensiva contro log injection, JSON escape, SQL-ish, path traversal, non-ASCII.
- **Anti-pattern evitati**: thread_local (rotto da `.await`), trace span con `info_span!` (overhead, ridondante con il task-local approach), header scaffolding manuale (axum `from_fn` middleware è il pattern idiomatico).

#### Dipendenze

- Dipende da: `tokio::task_local!`, `uuid` (per la generazione), `serde` (per il LogRecord field)
- Dipendono da questa feature: `SseLogLayer`, `RequestTracer`, le `dispatch_to_agent_inner` + i 7 canali, la chat UI che renderizza il trace_id nel timeline tool

---

### 11. Crash Reporting (Sprint 9 OBS-3)

#### Comportamento Atteso

- Un panic handler globale installato come **prima riga** di `async fn main()` cattura ogni panic — sia di runtime che di boot (rustls init, CLI parse, config load, DB open) — e ne salva un report JSON in `~/.homun/crashes/YYYY-MM-DD_HH-MM-SS_<trace_id>.json`.
- Il report contiene: timestamp, trace_id (dal task-local o "unscoped"), version, OS/arch, panic message, location, backtrace force-captured, gli ultimi 200 record di log dal ring buffer in-memory.
- Il contenuto JSON viene **redatto** via `crate::security::redact` prima di essere scritto su disco, eliminando PII tramite i pattern dell'exfiltration guard.
- Un anti-loop guard (`AtomicBool CRASH_IN_PROGRESS`) impedisce il panic-during-panic — un secondo panic durante l'handler salta direttamente al default chained hook.
- Il default hook viene preservato via `take_hook()` e ri-chiamato dopo, mantenendo l'output stderr familiare per il dev loop.

#### Submission flow (4-channel)

L'utente decide come segnalare un crash via UI (`/v1/crashes/{id}/formats`):

1. **Copy to clipboard** — sempre attivo, copia il markdown del report
2. **Download JSON** — sempre attivo, scarica il file raw
3. **Open GitHub Issue** — gated su `crash_submit_github + public_repo` non vuoto, apre un issue pre-filled su `homun-app/homun`
4. **Email maintainer** — gated su `crash_submit_email + email` non vuoto, apre un `mailto:` con subject e body pre-filled

L'utente vede sempre cosa sta inviando prima di confermare. Nessun crash report parte automaticamente.

#### Dettagli Tecnici

- **Moduli/file**: `src/crash_reporter.rs` (panic hook + persistence), `src/web/api/crashes.rs` (CRUD API + format builder), config in `[support]`
- **Endpoint API**:
  - `GET /api/v1/crashes` — lista crash con preview metadata
  - `GET /api/v1/crashes/{id}` — full report
  - `DELETE /api/v1/crashes/{id}` — rimozione
  - `GET /api/v1/crashes/{id}/formats` — 4 URL gated dalla config
- **Path traversal defense**: `read_crash` e `delete_crash` rifiutano qualsiasi filename contenente `/` o `..`, doppio check oltre alla validazione dell'axum Path extractor
- **`percent_encode` inline** (10 righe, RFC 3986) per costruire GitHub issue URL e mailto URL — evita di aggiungere `urlencoding` come dep

#### Configurazione

- `[support] public_repo = "homun-app/homun"` (default)
- `[support] source_repo = ""` (vuoto = no "view source" link)
- `[support] email = ""`
- `[support] crash_submit_clipboard = true`
- `[support] crash_submit_download = true`
- `[support] crash_submit_github = false` (default off finché il repo non viene creato)
- `[support] crash_submit_email = false` (default off finché email non è configurata)

---

### 12. Update Checker (Sprint 9 UPD-1)

#### Comportamento Atteso

- Un task tokio in background, spawn-ato in `WebServer::start()`, polla `https://api.github.com/repos/{public_repo}/releases/latest` una volta al giorno (default: `[updates] check_enabled = true`).
- Confronta il `tag_name` (stripped del leading `v`) con `env!("CARGO_PKG_VERSION")` via `semver::Version` — gestisce correttamente prerelease (1.0.0 > 1.0.0-rc1 per spec semver).
- Se `available = true`, scrive il risultato in `AppState.update_status: Arc<RwLock<Option<UpdateInfo>>>`.
- Drafts e prereleases vengono ignorati — il maintainer può tagger pre-release senza che gli utenti vedano subito "new version!".
- L'endpoint `GET /api/v1/updates/status` espone la cache senza polling diretto a GitHub, permettendo alla UI di pollare ogni 5 min senza preoccupazioni di rate limit.
- La UI topbar (`static/js/topbar.js`) renderizza un chip non-dismissable quando un update è disponibile, con il latest version, il platform hint come tooltip, e link a `release_url`.

#### Platform hints

`detect_platform_hint()` ispeziona `std::env::consts::OS`:

- **Linux**: parsa `/etc/os-release` per distinguere Debian-family (`apt upgrade homun`) da Red Hat-family (`dnf upgrade homun`). Fallback generico per altre distro.
- **macOS**: `brew upgrade homun`
- **Windows** (WSL): `Open your WSL terminal and run: sudo apt upgrade homun`

#### Dettagli Tecnici

- **Moduli/file**: `src/updates.rs` (`check_for_update` + `is_newer` + `detect_platform_hint`), `src/web/api/updates.rs` (handler), `src/web/server.rs` (`spawn_update_checker`)
- **HTTP client**: reqwest con timeout 15s, User-Agent `homun/{version} update-checker`, header `Accept: application/vnd.github+json`
- **Initial delay 60s**: dà tempo al gateway di settle prima del primo poll, evita thundering herd verso GitHub
- **Notifier only**: NON è un auto-updater. Il binary viene aggiornato solo via apt/dnf/brew/manual download. Auto-update è UPD-2, post-v1.0
- **Cache lifecycle**: `Arc<RwLock<Option<UpdateInfo>>>` legato al lifetime dell'AppState; alla `WebServer::start()` reboot, riparte da `None` e attende il primo poll

#### Configurazione

- `[updates] check_enabled = true` (default)
- `[support] public_repo` viene riusato per puntare al repo da pollare
