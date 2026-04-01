# Homun — Indice Specifiche Funzionali

> **Aggiornato**: 2026-04-01
> **Versione codebase**: ~116K LOC Rust, ~29K LOC JS, 245 source files, 864 test, 50 migrazioni SQLite

Questo indice raccoglie le specifiche funzionali di tutti i domini di Homun.
Ogni documento copre: comportamento atteso (prospettiva utente) + dettagli tecnici (struct, tabelle DB, endpoint API) + dipendenze.

---

## Documenti

| # | Documento | Dominio | Features coperte |
|---|-----------|---------|-----------------|
| 01 | [Messaggistica e Canali](01-messaggistica-canali.md) | Canali + Gateway | Gateway, CLI, Telegram, WhatsApp, Discord, Slack, Email, Web WS, Debouncing, Auth, Capabilities, Allegati |
| 02 | [Agente e Cognizione](02-agente-cognizione.md) | Agent Loop + Cognition | Agent Loop ReAct, Cognition-First, Discovery Tools, CognitionResult, Selective Tool Loading, Prompt Assembly, Iteration Budget, LLM Caller, Orchestrator, Context Compaction |
| 03 | [Memoria e Conoscenza](03-memoria-conoscenza.md) | Memory + RAG | Short-term memory, Long-term consolidation, Remember tool, Hybrid search (HNSW+FTS5+RRF), Embedding providers, RAG ingest, RAG search, Chunking, Sensitive data, Directory watcher, Knowledge tool, Cloud sources |
| 04 | [Strumenti](04-strumenti.md) | Tools + Sandbox | Tool Registry, Tool Context, Shell, File, Web, Message, Approval, Spawn, Automation, Workflow, Contacts, Sandbox (5 backend), Response Blocks |
| 05 | [Skills & MCP](05-skills-mcp.md) | Skills + MCP | SKILL.md standard, Loader, Executor, Installer (GitHub), Security scan, Creator LLM, Watcher hot-reload, Search, MCP Registry + OAuth, ClawHub, Open Skills, MCP Tool runtime, MCP Auto-Setup, Skill Activator |
| 06 | [Sicurezza](06-sicurezza.md) | Security | Vault AES-256-GCM, Web Auth PBKDF2, E-Stop, Exfiltration Guard, Channel Pairing OTP, 2FA TOTP, Vault Leak Detection, API Keys |
| 07 | [Automazioni e Scheduling](07-automazioni-scheduling.md) | Scheduler + Automations | Cron jobs, Automation triggers (cron/every/event), Automation Builder v2, NLP generation, Heartbeat proattivo, Background tasks |
| 08 | [Workflow Engine](08-workflow.md) | Workflows | Workflow multi-step, Approval gates, Retry logic, Resume-on-boot, Workflow builder UI |
| 09 | [Business Autopilot](09-business.md) | Business | OODA loop, Autonomy levels, Budget enforcement, Transaction tracking, 13 LLM tool actions |
| 10 | [Contatti e Profili](10-contatti-profili.md) | Contacts + Profiles + Gateways | Contact CRUD, Context injection, Contact Perimeter, Identity Resolution, Profiles, Profile Brain Dir, Gateways, Gateway Overrides, Auto-Association |
| 11 | [Interfaccia Web](11-interfaccia-web.md) | Web UI + API | Web Server Axum, Auth Web, API Keys, 29 Pagine, WebSocket Chat, Chat UI, Navigazione, Tema, Upload Allegati, REST API (70+ endpoint), Run State streaming, Toast, Visual Flow Builder |
| 12 | [Browser Automation](12-browser-automation.md) | Browser | 21 browser actions, MCP Playwright Bridge, Browser Task Plan, Site Memory, Tab Sessions, Action Policy, CAPTCHA Handling, Compact Snapshots, Stealth injection |
| 13 | [Configurazione](13-configurazione.md) | Config | Config TOML schema, 15+ sezioni, Setup wizard, Provider management, Config API, Dotpath access, Hot-reload |
| 14 | [Osservabilità](14-osservabilita.md) | Observability | Structured logging (tracing), SSE log streaming, Request tracing, Provider health monitoring, Channel health, Circuit breaker |
| 15 | [Condivisione e Connessioni](15-condivisione-connessioni.md) | Sharing + Connections | Share management, Connection establishment, Connection recipes, Namespace scoping |
| 16 | [App Mobile](16-app-mobile.md) | Mobile App | Mobile Pairing (QR flow), Device management, Bootstrap, Tunnel config, Chat Profile API |

---

## Grafo delle Dipendenze

Il grafo mostra le dipendenze principali tra domini (A → B significa "A dipende da B").

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         LIVELLO APPLICATIVO                             │
│                                                                         │
│  [02 Agente+Cognizione] ←── [03 Memoria] ←── [04 Strumenti]           │
│         │                         │                  │                  │
│         │                    [RAG engine]      [05 Skills+MCP]         │
│         │                                           │                   │
│         └────────────────────────┬──────────────────┘                  │
│                                  ↓                                      │
│                          [01 Canali+Gateway]                           │
│                                  │                                      │
│              ┌───────────────────┼───────────────────┐                 │
│              ↓                   ↓                   ↓                 │
│    [11 Interfaccia Web]  [08 Workflow]         [07 Automazioni]        │
│              │                   │                   │                  │
│              └───────────────────┴───────────────────┘                 │
│                                  ↓                                      │
│                          [09 Business]                                  │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                         LIVELLO TRASVERSALE                             │
│                                                                         │
│  [06 Sicurezza] ←── usato da TUTTI i moduli                           │
│  [13 Configurazione] ←── usato da TUTTI i moduli                      │
│  [14 Osservabilità] ←── usato da TUTTI i moduli                       │
│  [10 Contatti+Profili] ←── usato da Agente, Canali, Web UI            │
│  [12 Browser] ←── usato da Agente (tool browser)                      │
│  [15 Condivisione] ←── usato da Web UI, Agente                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Dipendenze Dirette per Dominio

| Dominio | Dipende da | Usato da |
|---------|-----------|---------|
| 01 Canali | 06 Sicurezza, 13 Config | 02 Agente, 11 Web |
| 02 Agente | 01 Canali, 03 Memoria, 04 Strumenti, 05 Skills, 10 Contatti | 11 Web (via WS), 07 Automazioni |
| 03 Memoria | 14 Osservabilità, 13 Config, 06 Sicurezza (vault-gating) | 02 Agente, 04 Strumenti (knowledge tool) |
| 04 Strumenti | 06 Sicurezza, 02 Agente (Tool Registry), 05 Skills | 02 Agente (esecuzione) |
| 05 Skills | 04 Strumenti, 06 Sicurezza, 13 Config | 02 Agente, 11 Web (API) |
| 06 Sicurezza | 13 Config (vault) | Tutti i moduli |
| 07 Automazioni | 02 Agente, 13 Config | 09 Business, 11 Web |
| 08 Workflow | 02 Agente, 06 Sicurezza (approval) | 09 Business, 11 Web |
| 09 Business | 02 Agente, 07 Automazioni, 08 Workflow | 11 Web |
| 10 Contatti | 13 Config, 15 Condivisione | 01 Canali, 02 Agente (context), 11 Web |
| 11 Web | Tutti | Browser (client) |
| 12 Browser | 02 Agente, 05 Skills (MCP Playwright), 06 Sicurezza | 02 Agente (browser tool) |
| 13 Config | — | Tutti i moduli |
| 14 Osservabilità | 13 Config | Tutti i moduli |
| 15 Condivisione | 13 Config | 10 Contatti, 11 Web |
| 16 App Mobile | 06 Sicurezza, 10 Profili, 11 Web (API) | Client Flutter |

---

## Glossario

### Architettura Core

| Termine | Definizione |
|---------|-------------|
| **ReAct Loop** | Pattern Reason → Act → Observe — il ciclo principale dell'agente. Ogni iterazione: LLM ragiona, chiama tool, osserva il risultato, ripete fino a completamento. |
| **Cognition-First** | Architettura 4-fase: INGRESS → COGNITION → EXECUTION → POST-PROCESSING. La fase Cognition è un mini-ReAct read-only che analizza l'intent *prima* del loop principale. |
| **CognitionResult** | Contratto tra fase Cognition e fase Execution. Contiene: understanding (piano in linguaggio naturale), plan_steps, constraints, discovered_tools, discovered_skills, memory_context, rag_context. |
| **Selective Tool Loading** | Solo i tool identificati dalla Cognition vengono passati all'LLM (+ set always-available: send_message, remember, approval, vault). Riduce il context window e migliora la precisione. |
| **Iteration Budget** | Limite dinamico alle iterazioni del ReAct loop. Si estende su progresso (+10 browser, +4 search, +3 default), si contrae su stall/cicli. Cycle detection su periodi 1, 2, 3. |
| **Fallback Full Context** | Quando la Cognition fallisce (errore provider, timeout), il fallback fornisce TUTTI i tool. Il loop può ancora funzionare, con degradazione graceful. |

### Memoria e Conoscenza

| Termine | Definizione |
|---------|-------------|
| **Short-term Memory** | Messaggi della sessione corrente (in-memory + SQLite tabella `session_messages`). Finestra configurabile (`memory_window`). |
| **Long-term Memory** | Riassunti LLM consolidati nella tabella `memories`. Scritti dal `remember` tool, consolidati periodicamente. |
| **Hybrid Search** | Algoritmo di ricerca che combina HNSW (vettori, similarità semantica) + FTS5 (keyword, exact match) tramite RRF (Reciprocal Rank Fusion, k=60). Usato sia in memoria che in RAG. |
| **RRF** | Reciprocal Rank Fusion — formula: `score = Σ(1 / (k + rank_i))`. Combina ranking di ricerche eterogenee senza normalizzazione esplicita. |
| **HNSW** | Hierarchical Navigable Small World — grafo di prossimità per nearest-neighbor search su vettori di embedding. Implementato con `usearch` crate. |
| **RAG** | Retrieval-Augmented Generation — pattern di ingestione documenti (chunking → embedding → storage) + retrieval (query → hybrid search → context injection) per arricchire l'LLM con conoscenza specifica. |
| **Temporal Decay** | Punteggio memoria ridotto per memorie vecchie. Half-life: 30 giorni. Bilancia recency vs. rilevanza semantica. |
| **Progressive Disclosure** | Le skill caricano solo il frontmatter YAML all'avvio (~100 token), il body Markdown completo viene caricato on-demand al momento dell'attivazione. |

### Canali e Messaggi

| Termine | Definizione |
|---------|-------------|
| **Channel** | Interfaccia di comunicazione: CLI, Telegram, WhatsApp, Discord, Slack, Email, Web (WebSocket). Ogni canale implementa il trait `Channel`. |
| **InboundMessage** | Messaggio in entrata dal canale verso l'AgentLoop. Contiene: source (canale), sender_id, content, attachments. |
| **OutboundMessage** | Messaggio in uscita dall'AgentLoop verso il canale. Contiene: target (canale), recipient_id, content, blocks. |
| **Debouncing** | Finestra temporale per raggruppare messaggi rapidi in un unico batch. Parametri: `window_ms`, `max_batch`. Bypassato per allegati. |
| **ChannelCapabilities** | 12 campi booleani per capability detection per canale (markdown, threads, reactions, file_uploads, ecc.). Usato per adattare il formato della risposta. |
| **Channel Auth** | AuthDecision: `Authorized` (contatto noto), `NeedsPairing` (nuovo utente, invia OTP), `Rejected` (blocklisted). Centralized in `agent/auth.rs`. |
| **Response Block** | Unità di risposta strutturata: choice (pulsanti scelta), approval (gate), status (progresso), result (output strutturato), external_message. Renderizzate nativamente nella Web UI. |

### Sicurezza

| Termine | Definizione |
|---------|-------------|
| **Vault** | Storage crittografato per segreti. AES-256-GCM per cifratura, master key in OS keychain via `keyring` crate. Accesso audit-logged. |
| **E-Stop** | Emergency Stop — kill switch di emergenza che interrompe: agent loop, browser, processi MCP. Trigger: `/estop` via qualsiasi canale autorizzato. |
| **Exfiltration Guard** | Interceptor che scansiona le risposte uscenti per 18+ regex patterns (segreti, PII, token). Livelli: CRITICAL (blocca), HIGH/MEDIUM/LOW (redact + log). |
| **Pairing OTP** | Quando un nuovo utente contatta l'agente via messaggio, viene inviato un OTP a 6 cifre con TTL 5min e max 3 tentativi. Autenticazione out-of-band. |
| **TOTP** | Time-based One-Time Password (RFC 6238) per 2FA. Chiave in `~/.homun/2fa.enc`, 10 recovery codes. |
| **PBKDF2** | Password-Based Key Derivation Function 2 — derivazione chiave da password con 600,000 iterazioni, salt 16 byte, output 32 byte. Timing-safe verify. |

### Skills e MCP

| Termine | Definizione |
|---------|-------------|
| **SKILL.md** | File di specifica skill nel formato Agent Skills standard. YAML frontmatter (name, description, allowed-tools, user-invocable) + corpo Markdown con workflow. |
| **Eligibility** | Verifica runtime dei prerequisiti di una skill: binari presenti (`bins`/`any_bins`), variabili d'ambiente, OS. Skill ineligibili escluse dal prompt LLM. |
| **Smoke Test** | Test minimale di uno skill script: eseguito con `--smoke-test`, deve stampare `homun_skill_smoke_ok`. Verifica che lo script si avvii senza errori. |
| **ClawHub** | Marketplace ufficiale per Agent Skills. Repository GitHub monorepo (openclaw/skills) + API native (`https://clawhub.ai/api/v1`). |
| **MCP** | Model Context Protocol — protocollo per esporre tool, resource e prompt da server esterni all'LLM. Trasporto: stdio (processo locale) o HTTP. |
| **McpClientTool** | Wrapper che espone un tool MCP come un tool standard di Homun. Nome formato: `{server_name}__{mcp_tool_name}`. |
| **Vault Resolution** | Sostituzione `vault://key` con il valore reale dal vault a runtime. Usato per env vars di server MCP senza esporre segreti nel config. |

### Web e API

| Termine | Definizione |
|---------|-------------|
| **AppState** | Stato condiviso del web server Axum. Contiene: config, database, channel sessions, stream sessions, WebRunStore, rate limiters, engine handles. |
| **WebChatRunSnapshot** | Snapshot di una run di chat attiva. Contiene: run_id, status, user_message, assistant_response (accumulata), events (tool timeline), error. |
| **WsStreamEvent** | Evento singolo nel WebSocket stream. Types: stream (text delta), tool_start/tool_end, plan, blocks, error, workflow_progress. |
| **rust-embed** | Crate Rust che compila asset statici (JS, CSS, HTML) direttamente nel binario. Rende Homun self-contained senza file statici esterni. |
| **Session Cookie** | Cookie HMAC-SHA256 signed (`homun_session`) con TTL 24h. Contiene: session_id, IP, User-Agent per replay protection. |

### Workflow e Automazioni

| Termine | Definizione |
|---------|-------------|
| **Workflow** | Sequenza multi-step persistente con supporto per approval gates, retry, e resume-on-boot. Ogni step può essere eseguito dall'agente o richiedere approvazione umana. |
| **Automation** | Job schedulato (cron/every) o event-driven (always/on_change/contains) che invoca l'agente con un prompt fisso. |
| **Approval Gate** | Punto di controllo in un workflow o autonomy level che richiede approvazione esplicita umana prima di procedere. |
| **OODA Loop** | Observe → Orient → Decide → Act — framework per decisioni autonome del Business Autopilot. Permette all'agente di operare senza supervisione entro budget/autonomia configurati. |
| **Autonomy Level** | Livello di autonomia del business engine: supervised (approva tutto), semi-autonomous (approva sopra soglia), autonomous (opera liberamente entro budget). |
| **Heartbeat** | Wake-up proattivo dell'agente a intervalli configurabili per controllare task pendenti, follow-up, e trigger time-based senza input utente. |

### Configurazione e Infrastruttura

| Termine | Definizione |
|---------|-------------|
| **SQLite + sqlx** | Database embedded `~/.homun/homun.db`. 46 migrazioni auto-applicate all'avvio. Thread-safe tramite connection pool sqlx. |
| **OnceCell** | Pattern Rust per inizializzazione lazy di risorse condivise (es. ApprovalManager, gateway handles). Usato per late-binding di tool che necessitano di stato gateway. |
| **Circuit Breaker** | Pattern di resilienza: se un provider LLM supera `failure_threshold` errori consecutivi, il circuit si "apre" e le richieste vengono rifiutate per `recovery_timeout`. |
| **QueuedProvider** | Wrapper di provider con coda prioritaria + semaforo di concorrenza per-provider. Previene overload di API esterne. |
| **ReliableProvider** | Wrapper di provider con failover automatico + retry su errori transienti. Livello sopra QueuedProvider. |
| **one_shot** | Pattern per chiamate LLM non-conversazionali (generazione automazioni, setup MCP, creazione skill). Timeout 30s, no extended thinking. |

---

## Modello di Isolamento

Il sistema è **single-user** (v2) ma predisposto per multi-user (v3). L'isolamento opera su 3 livelli:

### Livello 1: Profili (personalità dell'agente)

Ogni dominio filtra per `profile_id` con il pattern `WHERE profile_id IS NULL OR profile_id = ?`. I record con `profile_id = NULL` sono **globali** (visibili a tutti i profili).

| Dominio | Tabella | Filtro profile_id | Note |
|---------|---------|-------------------|------|
| Memory chunks | memory_chunks | ✅ SQL | Pruning profile-scoped |
| Memory search | (runtime) | ✅ filter_map | + namespace isolation |
| RAG sources | rag_sources | ✅ SQL | `list_rag_sources_for_profile()` |
| Contacts | contacts | ✅ SQL | Commit b992488 |
| Automations | automations | ✅ SQL | Scheduler carica tutto (None) |
| Business | businesses | ✅ SQL | Commit 0336b11 |
| Workflows | workflows | ✅ SQL | |
| Vault log | vault_access_log | ✅ SQL | Migration 050 |
| Skill audit | skill_audit | ✅ SQL | Migration 050 |
| Pending responses | pending_responses | ✅ SQL | Migration 050 |
| Skills (filesystem) | — | ✅ Directory | `~/.homun/brain/profiles/{slug}/skills/` |
| Brain files | — | ✅ Directory | `~/.homun/brain/profiles/{slug}/` |
| MCP servers | config.toml | ❌ Globale | By design (risorse dell'operatore) |
| Vault secrets | secrets.enc | ❌ Globale | By design |

### Livello 2: Namespace (visibilità memoria)

Il campo `namespace` in `memory_chunks` controlla chi può vedere un chunk:

| Namespace | Significato | Visibile a |
|-----------|-------------|-----------|
| `_private` | Default per chunk del proprietario | Solo owner (CLI, Web) |
| `_public` | Auto-set per chunk con contact_id | Owner + tutti i contatti |
| Custom | Es. `acme`, `contact_7` | Solo chi ha il namespace nel perimeter |

**Difesa strutturale**: il filtro `_private` è applicato nel memory_search a livello Rust (non prompt-based). La cognition propaga `allowed_namespaces` dal contact perimeter.

### Livello 3: Contact Perimeter (isolamento interlocutori)

Ogni contatto ha un perimeter con restrizioni:

| Campo | Default | Significato |
|-------|---------|-------------|
| `knowledge_namespaces` | `["_public", "contact_{id}"]` | Namespace RAG accessibili |
| `memory_scope` | `contact_only` | Solo memorie del contatto + globali |
| `tools_allowed` | `[]` (tutti) | Tool permessi |
| `tools_denied` | `["vault"]` | Tool negati |
| `can_see_contacts` | `false` | L'agente non menziona altri contatti |
| `can_see_calendar` | `false` | L'agente non menziona eventi |

### Audit Wizard

La Web UI (pagina `/memory`) include una sezione "Visibility Audit" per gestire i chunk privati:
- `GET /v1/memory/audit?profile=slug` — conteggio e preview chunk
- `POST /v1/memory/audit/classify` — reclassifica chunk specifici
- `POST /v1/memory/audit/classify-all` — reclassifica in bulk

---

## Metriche del Progetto

| Metrica | Valore |
|---------|--------|
| Linee di codice Rust | ~116K LOC |
| Linee di codice JavaScript | ~29K LOC |
| File sorgente Rust | 245 |
| File JavaScript | 48 |
| Migrazioni SQLite | 50 |
| Test totali | 864 |
| Canali supportati | 7 (CLI, Telegram, WhatsApp, Discord, Slack, Email, Web) |
| Pagine Web UI | 29 |
| REST API endpoints | 70+ |
| Built-in tools | 20+ |
| Browser actions | 21 |
| Sandbox backends | 5 |
| Skill bundled | 5 |
| Formato ingestione RAG | 37+ estensioni |
| MCP preset curati | 7 |

---

## File di Riferimento nel Codebase

| Dominio | File chiave |
|---------|------------|
| Entry point | `src/main.rs` |
| Agent loop | `src/agent/agent_loop.rs` |
| Cognition | `src/agent/cognition/engine.rs`, `mod.rs`, `discovery.rs` |
| Gateway | `src/agent/gateway.rs` |
| Prompt builder | `src/agent/prompt/builder.rs`, `sections.rs` |
| Tool registry | `src/tools/registry.rs` |
| Memory search | `src/agent/memory_search.rs` |
| RAG engine | `src/rag/engine.rs` |
| Channels | `src/channels/` |
| Skills | `src/skills/` |
| Security | `src/security/` |
| Web server | `src/web/server.rs` |
| Web pages | `src/web/pages.rs` |
| Web API router | `src/web/api/mod.rs` |
| WebSocket | `src/web/ws.rs` |
| Config schema | `src/config/schema.rs` |
| DB migrations | `migrations/` |
| Provider traits | `src/provider/traits.rs` |
| Browser | `src/browser/mcp_bridge.rs` |
| Frontend chat | `static/js/chat.js` |
| Frontend flow | `static/js/flow-renderer.js` |

---

## Punti di Integrazione (Quick Reference)

Per aggiungere nuovi componenti senza rileggere tutto il codebase:

| Componente | Dove aggiungere |
|-----------|----------------|
| Nuovo tool | `src/tools/{name}.rs` + `src/tools/registry.rs` |
| Nuovo canale | `src/channels/{name}.rs` + `src/channels/mod.rs` + `src/config/schema.rs` + `src/agent/gateway.rs` |
| Nuovo endpoint API | `src/web/api/{domain}.rs` + `routes()` + `src/web/api/mod.rs` |
| Nuova pagina Web | `src/web/pages.rs` + `src/web/server.rs` + `static/js/{name}.js` |
| Nuova migrazione | `migrations/NNN_{name}.sql` (auto-applicata all'avvio) |
| Nuova sezione config | `src/config/schema.rs` |
| Chiamata LLM one-shot | `provider/one_shot.rs` → `llm_one_shot()` |
| Nuova skill bundled | `skills/{name}/SKILL.md` + `scripts/run.py` |
| Nuovo tool di Cognition | `src/agent/cognition/discovery.rs` + `engine.rs` |
| Nuovo dominio contatti | `src/contacts/db.rs` + `src/web/api/contacts.rs` |
