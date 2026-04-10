# Interfaccia Web — Specifiche Funzionali

## Panoramica

L'interfaccia web di Homun è un sistema completo di gestione conversazionale e orchestrazione costruito con **Axum** (framework Rust moderno), **WebSocket** per lo streaming in tempo reale, e un'architettura frontend reattiva basata su **vanilla JavaScript**. La piattaforma integra autenticazione sessionale sicura (PBKDF2), streaming markdown con strumenti integrati, 29 pagine di configurazione/dashboard, e un visual flow builder n8n-style per le automazioni. Tutti gli asset sono embedded nel binario tramite `rust-embed`, rendendo Homun completamente self-contained senza dipendenze da file statici esterni.

---

## Features

### 1. Web Server — Axum + TLS + Embedding

#### Comportamento Atteso

- Server avviato sulla porta configurabile (default 3000)
- Supporta TLS con certificati auto-firmati per ambienti di produzione
- Tutti gli asset statici (HTML, JS, CSS) sono compilati nel binario tramite `rust-embed`
- Modalità debug: serve asset da disco per hot-reload durante sviluppo
- Router principale gestisce routing per pagine HTML, API REST, WebSocket, e asset statici
- CORS abilitato per richieste cross-origin controllate
- Tracing distribuito integrato con `tower-http::TraceLayer`
- Health check pubblico senza autenticazione su `/health` e `/api/v1/health`
- Webhook pubblico per ingestione canali su `/api/v1/webhook/{token}` senza auth
- URL mobile: `mobile_reachable_base_url()` calcola l'URL pubblico per accesso mobile

#### Dettagli Tecnici

**Struct principale** (`src/web/server.rs`):
```rust
pub struct AppState {
    pub config: Arc<tokio::sync::RwLock<Config>>,
    pub started_at: Instant,
    pub public_base_url: Option<String>,
    pub inbound_tx: Option<mpsc::Sender<InboundMessage>>,
    pub web_runs: Arc<WebRunStore>,
    pub ws_sessions: tokio::sync::RwLock<HashMap<String, mpsc::Sender<String>>>,
    pub stream_sessions: tokio::sync::RwLock<HashMap<String, mpsc::Sender<WsStreamEvent>>>,
    pub db: Option<Database>,
    pub memory_searcher: Option<Arc<Mutex<MemorySearcher>>>,   // embeddings feature
    pub rag_engine: Option<Arc<Mutex<RagEngine>>>,             // embeddings feature
    pub health_tracker: Option<Arc<ProviderHealthTracker>>,
    pub channel_health: Option<Arc<ChannelHealthTracker>>,
    pub workflow_engine: Option<Arc<WorkflowEngine>>,
    pub estop_handles: Arc<tokio::sync::RwLock<EStopHandles>>,
    pub session_store: Option<Arc<SessionStore>>,              // SEC-1
    pub auth_rate_limiter: Arc<RateLimiter>,                   // 5 req/min per IP
    pub api_rate_limiter: Arc<RateLimiter>,                    // 60 req/min per IP
    pub token_rate_limiter: Arc<RateLimiter<String>>,          // 60 req/min per token
    pub tool_registry: Option<Arc<RwLock<ToolRegistry>>>,
    pub channel_cmd_tx: Option<mpsc::Sender<ChannelCommand>>,
    pub watch_update_tx: Option<mpsc::Sender<WatchUpdate>>,    // embeddings feature
}
```

**URL mobile**: `mobile_reachable_base_url()` — priorità: tunnel_url > dominio pubblico (esclude localhost/127.0.0.1)

**Feature flag**: `#[cfg(feature = "web-ui")]` per embedded web interface

#### Dipendenze

- Dipende da: Config, Database, MemorySearcher, RagEngine, HealthTracker, SessionStore
- Usato da: tutti gli handler HTTP, WebSocket, API endpoint

---

### 2. Autenticazione Web

#### Comportamento Atteso

- **Login**: username/password → PBKDF2 hashing (600,000 iterazioni) → verifica → sessione
- **Sessione**: cookie `homun_session` con TTL 24h (configurabile)
- **Session store**: in-memory `HashMap<session_id, WebSession>` con signed HMAC-SHA256
- **Token di sessione**: generato da SystemRandom, 32 byte base64-encoded
- **CSRF token**: generato per ogni sessione, stored in `WebSession.csrf_token`
- **Client IP tracking**: registrato al login per validazione di replay attack (REM-4b)
- **User-Agent tracking**: registrato al login per validazione di replay (REM-4b)
- **Rate limiting auth**: 5 richieste/min per IP (SEC-3) su `/api/v1/login`

#### Dettagli Tecnici

**Struct WebSession** (`src/web/auth.rs`):
```rust
pub struct WebSession {
    pub user_id: String,
    pub username: String,
    pub roles: Vec<String>,
    pub created_at: Instant,
    pub ttl: Duration,
    pub csrf_token: String,        // REM-4a
    pub client_ip: String,         // REM-4b
    pub user_agent: String,        // REM-4b
}
```

**SessionStore**: HashMap thread-safe con RwLock, signing key HMAC-SHA256 da vault

**Password hashing**:
- Algoritmo: `ring::pbkdf2::PBKDF2_HMAC_SHA256`
- Iterazioni: 600,000 (`PBKDF2_ITERATIONS`)
- Output: `"base64(salt):base64(hash)"`
- Verifica: `pbkdf2::verify()` con timing-safe comparison

**Costanti**:
```rust
const PBKDF2_ITERATIONS: u32 = 600_000;
const SALT_LEN: usize = 16;
const CREDENTIAL_LEN: usize = 32;
const SESSION_COOKIE_NAME: &str = "homun_session";
const DEFAULT_SESSION_TTL_SECS: u64 = 86400;
const SESSION_ID_LEN: usize = 32;
```

**File**: `src/web/auth.rs`

#### Dipendenze

- Dipende da: Ring (crypto), Vault (signing key)
- Usato da: middleware `Extension<AuthUser>`, tutti gli endpoint protetti

---

### 3. API Keys e Webhook Tokens

#### Comportamento Atteso

- **Token scope**: `admin` (accesso pieno), `read` (sola lettura), `mobile_stop` (stop chat per mobile)
- **Autenticazione Bearer**: header `Authorization: Bearer {token}`
- **Masked display**: token visualizzato come `wh_****…abcd` (prime 4 + ultime 4 char)
- **Token ID**: primo 16 char del token, usato per delete/toggle senza esporre il token completo
- **Rate limiting token**: 60 richieste/min per token (SEC-4c)
- **Last used**: timestamp aggiornato ad ogni uso, visibile nell'API
- **Expiration**: opzionale, data RFC3339
- **Disabled token**: toggle via PATCH

#### Dettagli Tecnici

**Struct TokenResponse** (GET `/v1/account/tokens`):
```rust
struct TokenResponse {
    token_id: String,              // first 16 chars
    display_token: String,         // masked "wh_****…abcd"
    name: String,
    enabled: bool,
    scope: String,                 // "admin" | "read" | "mobile_stop"
    last_used: Option<String>,     // RFC3339
    created_at: String,
    expires_at: Option<String>,
}
```

**Struct CreateTokenResponse** (POST `/v1/account/tokens`):
```rust
struct CreateTokenResponse {
    token: String,                 // Full token (shown once)
    token_id: String,
    name: String,
    scope: String,
    expires_at: Option<String>,
    created_at: String,
}
```

**API Endpoints** (`src/web/api/account.rs`):
- `GET /v1/account/tokens` — lista tokens
- `POST /v1/account/tokens` — crea token
- `DELETE /v1/account/tokens/{token_id}`
- `POST /v1/account/tokens/{token_id}` — toggle (enable/disable)

#### Dipendenze

- Dipende da: Database (token storage), RateLimiter, Vault (encryption)
- Usato da: API token auth middleware, webhook handler

---

### 4. Le 29 Pagine

#### Comportamento Atteso

- Tutte le pagine sono **server-rendered HTML** usando template string Rust
- Layout comune: sidebar icon bar (56px fisso) + subnav collapsibile + main content
- Sidebar attiva mostra logo + 5 icone principali (Chat, Automation, Brain, Extensions, Settings)
- Subnav di sinistra mostra sottomenu contestuali per il gruppo di pagine (collapsibile)
- Topbar globale: connection status (solo chat), avatar button, settings icon
- Asset JS/CSS: inlineati nel HTML server-rendered
- Empty state, loading, error states predefiniti per ogni dominio

#### Elenco Pagine Completo

| Route | Funzione Template | JS File | Descrizione |
|-------|------------------|---------|-------------|
| `/` | reindirizza a `/chat` | — | Home redirect |
| `/chat` | `chat_page()` | chat.js | Chat principale con WebSocket, conversazioni, allegati |
| `/setup` | `setup_page()` | setup.js | Configurazione model/provider (Anthropic, OpenAI, ecc.) |
| `/appearance` | `appearance_page()` | appearance.js | Tema (light/dark), accent color, font size |
| `/channels` | `channels_page()` | channels.js | Gestione canali (Telegram, Discord, Slack, Email) |
| `/browser` | `browser_page()` | browser.js | Browser integration settings, allowed sites |
| `/automations` | `automations_page()` | automations.js | Lista automazioni, CRUD, run history |
| `/workflows` | `workflows_page()` | workflows.js | Workflow visual builder, orchestrazione multi-step |
| `/skills` | `skills_page()` | skills.js | Skills installed, search, install, delete |
| `/mcp` | `mcp_page()` | mcp.js | MCP servers list, install, config, OAuth |
| `/mcp/oauth/google/callback` | `mcp_google_oauth_callback_page()` | mcp.js | Google OAuth return endpoint |
| `/mcp/oauth/github/callback` | `mcp_github_oauth_callback_page()` | mcp.js | GitHub OAuth return endpoint |
| `/mcp/oauth/notion/callback` | `mcp_notion_oauth_callback_page()` | mcp.js | Notion OAuth return endpoint |
| `/contacts` | `contacts_page()` | contacts.js | Contatti con profile link, gateway override |
| `/profiles` | `profiles_page()` | profiles.js | Profile management (default, custom per canale) |
| `/memory` | `memory_page()` | memory.js | Memory search, watcher config, personal facts |
| `/knowledge` | `knowledge_page()` | knowledge.js | RAG knowledge base, document upload, embedding stats |
| `/vault` | `vault_page()` | vault.js | Secrets management, 2FA, encryption |
| `/file-access` | `file_access_page()` | file-access.js | File permissions, sandbox rules, path whitelist |
| `/shell` | `shell_page()` | shell.js | Shell access control, command audit log |
| `/sandbox` | `sandbox_page()` | sandbox.js | Sandbox config, isolation mode, max processes |
| `/approvals` | `approvals_page()` | approvals.js | Pending approvals dashboard, human-in-loop |
| `/account` | `account_page()` | account.js | Account info, avatar, identities, tokens |
| `/api-keys` | `api_keys_page()` | api-keys.js | API key management, token creation/rotation |
| `/maintenance` | `maintenance_page()` | maintenance.js | Database: vacuum, backup, stats, cleanup |
| `/logs` | `logs_page()` | logs.js | Tail logs, filtering, full-text search |
| `/traces` | `traces_page()` | traces.js | Request analysis, latency traces, debugging |
| `/onboarding` | `onboarding_page()` | onboarding.js | Setup wizard per primo accesso |
| `/agents` | `agents_page()` | agents.js | Agent registry, multi-agent orchestration |

#### Rendering Comune

**Sidebar groups** (`src/web/pages.rs`):
- `AUTOMATION_PAGES = ["automations", "workflows"]`
- `BRAIN_PAGES = ["memory", "knowledge", "contacts", "profiles"]`
- `EXTENSIONS_PAGES = ["skills", "mcp", "agents"]`
- `SETTINGS_PAGES = ["settings", "appearance", "channels", "browser"]`
- `SECURITY_PAGES = ["vault", "api-keys", "approvals", "file-access", "shell", "sandbox"]`
- `SYSTEM_PAGES = ["maintenance", "logs", "traces"]`

**SVG icons**: ICON_CHAT, ICON_SETTINGS, ICON_BRAIN, ICON_EXTENSIONS, ICON_AUTOMATION, ICON_SECURITY, ICON_SYSTEM — tutti inline SVG

**Subnav toggle**: classe `.is-open` server-rendered, toggle button `<button class="subnav-toggle-btn" id="subnav-toggle">`

**File**: `src/web/pages.rs` (5312 righe — grandfathered)

#### Dipendenze

- Dipende da: AppState (config), AuthUser (username, user_id), Database
- Usato da: browser (client), JavaScript API layer

---

### 5. WebSocket Chat

#### Comportamento Atteso

- **Endpoint**: `GET /ws/chat?conversation_id={id}` → HTTP Upgrade → WebSocket
- **Session key**: `web:{conversation_id}` per routing interno
- **Welcome message**: tipo `"connected"` con session_id e conversation_id
- **Dual-channel architecture**:
  - `response_tx/response_rx`: full response messages (tipo `"response"`)
  - `stream_tx/stream_rx`: incremental chunks + tool events (tipo `"stream"`, `"tool_start"`, `"tool_end"`, ecc.)
- **Tool timeline**: eventi sequenziali `tool_start` → ... → `tool_end` con nome tool e metadati
- **Plan events**: `{"type": "plan", "name": "plan summary"}` con task list
- **Block events**: `{"type": "blocks", "blocks": [ResponseBlock]}` per rich UI
- **Workflow progress**: `{"type": "workflow_progress", "data": {...}}`
- **Reconnection**: client-side JS gestisce reconnect automatico con backoff esponenziale
- **Message framing**: tutti i dati JSON stringificati, UTF-8 encoded

#### Dettagli Tecnici

**Struct WsStreamEvent** (`src/web/ws.rs`):
```rust
pub struct WsStreamEvent {
    pub delta: String,                           // text chunk or event name
    pub event_type: Option<String>,              // "stream" | "tool_start" | "tool_end" | "error" | "plan" | "blocks" | "workflow_progress"
    pub tool_call_data: Option<ToolCallData>,    // for tool_start events
}
```

**Channel sizing**:
- response channel: 32-message buffer
- stream channel: 128-message buffer

**Event payload examples**:

Response message:
```json
{ "type": "response", "content": "Here is the answer..." }
```

Stream chunk:
```json
{ "type": "stream", "delta": "incremental text" }
```

Tool event:
```json
{
  "type": "tool_start",
  "name": "web_search",
  "tool_call": { "id": "call_123", "name": "web_search", "arguments": {"query": "..."} }
}
```

Blocks event (rich UI):
```json
{ "type": "blocks", "blocks": [{ "type": "choice", "choices": [...] }] }
```

**Session registration** (AppState):
```rust
state.ws_sessions.write().await.insert(chat_id.clone(), response_tx);
state.stream_sessions.write().await.insert(chat_id.clone(), stream_tx);
```

**Run persistence**: snapshot salvata async in DB via `db.upsert_web_chat_run(run)` senza bloccare il forward loop

**File**: `src/web/ws.rs`

#### Dipendenze

- Dipende da: AppState (ws_sessions, stream_sessions, db), AuthUser
- Usato da: chat.js (client WebSocket)

---

### 6. Chat UI

#### Comportamento Atteso

- **Message rendering**: markdown con syntax highlighting per code blocks
- **Streaming**: incremental text append al messaggio attuale in tempo reale
- **Tool timeline**: visualizzazione sequenziale di strumenti usati (spinner durante esecuzione)
- **Response blocks**: rich UI per choice cards, approvals, detailed outputs
- **Thinking display**: ragionamento esteso collassibile/espandibile
- **Conversation sidebar**: lista conversazioni con titolo, preview, last updated, archive state
- **Search conversazioni**: search modal con fulltext + archived filter
- **Bulk actions**: multi-select conversazioni con archive/delete batch
- **Attachments**: strip visuale per file allegati con preview thumbnail
- **Plan panel**: collapsibile bottom panel con task checklist da AI plan
- **Auto-scroll**: segue i messaggi arrivanti, manual scroll abilita "scroll to bottom" button
- **Connection status**: topbar mostra "Connected", "Connecting…", "Disconnected"

#### Dettagli Tecnici

**Elementi DOM key** (`static/js/chat.js`):
```javascript
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chat-form');
const chatText = document.getElementById('chat-text');
const wsStatus = document.getElementById('ws-status');
const chatPlanPanel = document.getElementById('chat-plan-panel');
const chatAttachmentStrip = document.getElementById('chat-attachment-strip');
const conversationListEl = document.getElementById('chat-conversation-list');
```

**API Endpoints chat**:
- `GET /api/v1/chat/conversations?limit=50&q={query}&include_archived={bool}`
- `GET /api/v1/chat/history?limit=100&conversation_id={id}`
- `POST /api/v1/chat/uploads` (multipart)
- `GET /api/v1/chat/uploads/{conversation_id}/{file_name}`
- `GET /api/v1/chat/run` → active WebChatRunSnapshot
- `POST /api/v1/chat/stop` → stop chat run

**WebSocket connection**: `ws://localhost:3000/ws/chat?conversation_id={id}`

**File**: `static/js/chat.js` (1000+ linee — grandfathered)

#### Dipendenze

- Dipende da: WebSocket handler (ws.rs), chat API endpoints, auth session
- Usato da: utenti attraverso browser

---

### 7. Sistema di Navigazione

#### Comportamento Atteso

- **Sidebar icon bar**: 56px fisso, icone gruppo + settings button
- **Subnav collapsibile**: slide out/in da sinistra, persistenza nella sessione
- **Topbar**: static header con status + avatar menu
- **Command palette**: Cmd/Ctrl+K apre fuzzy-searchable action launcher
- **Active state**: page route corrente highlighted in nav
- **Mobile responsive**: sidebar collassa su schermi stretti

#### Dettagli Tecnici

**Command Palette actions** (`static/js/command-palette.js`):
```javascript
const actions = [
    { id: 'nav-chat', label: 'Go to Chat', icon: '💬', fn: () => go('/chat') },
    { id: 'nav-automations', label: 'Go to Automations', icon: '⚡', fn: () => go('/automations') },
    { id: 'nav-memory', label: 'Go to Memory', icon: '🧠', fn: () => go('/memory') },
    { id: 'toggle-theme', label: 'Toggle Dark/Light Mode', icon: '🌓', fn: toggleTheme },
    // ... 20+ actions
];
```

**Fuzzy matching**: simple sequential char matching

**Keyboard**: Cmd+K (Mac) / Ctrl+K (Windows/Linux)

**File**:
- Navigation structure: `src/web/pages.rs` (lines 115-300)
- Command palette: `static/js/command-palette.js`
- Sidebar: `static/js/sidebar.js`

#### Dipendenze

- Dipende da: pages.rs (sidebar rendering), CSS layout
- Usato da: tutte le pagine

---

### 8. Tema e Aspetto

#### Comportamento Atteso

- **Dark/Light mode toggle**: global theme switch persistente in localStorage
- **Accent color**: customizzabile per branding (default primario)
- **Font size**: small/normal/large (default normal)
- **Sistema preferenza**: detect OS `prefers-color-scheme` se no stored preference
- **CSS tokens**: `--bg-primary`, `--text-primary`, `--accent`, `--border`, ecc.
- **Applicazione immediata**: no page reload, live CSS update via `data-theme` attribute

#### Dettagli Tecnici

**Theme logic** (`static/js/theme.js`):
```javascript
const STORAGE_KEY = 'homun-theme';
const DARK = 'dark';
const LIGHT = 'light';

function getPreferredTheme() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === DARK || stored === LIGHT) return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? DARK : LIGHT;
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || LIGHT;
    const next = current === DARK ? LIGHT : DARK;
    applyTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
}
```

**CSS custom properties**:
- `--bg-primary`, `--bg-secondary`, `--bg-subtle`
- `--text-primary`, `--text-secondary`, `--text-tertiary`
- `--accent`, `--accent-border`, `--accent-bg`
- `--border`, `--border-light`
- `--success`, `--warning`, `--danger`, `--info`
- Override per `:root[data-theme="dark"]` vs `:root[data-theme="light"]`

**Appearance page API**:
- `GET /api/v1/account/settings/appearance`
- `POST /api/v1/account/settings/appearance` (theme, accent, font_size)

**File**: `static/js/theme.js`, `static/js/appearance.js`, `src/web/pages.rs`

#### Dipendenze

- Dipende da: localStorage API
- Usato da: tutte le pagine (injected globally)

---

### 9. Upload Allegati

#### Comportamento Atteso

- **File upload**: endpoint `/api/v1/chat/uploads` (POST multipart/form-data)
- **MIME types supportati**: image/* (jpg, png, webp, gif), document/* (pdf, docx, pptx, xlsx, txt)
- **Limite dimensione**: immagini 5MB, documenti 20MB
- **Storage**: files salvati in `.chat-uploads/{conversation_id}/{filename}`
- **Anteprima**: endpoint GET `/api/v1/chat/uploads/{conversation_id}/{filename}`
- **RAG ingest**: file di documenti automaticamente ingestiti nel knowledge base se embedding enabled
- **Inline encoding**: attachment metadata + MCP servers serializzati in base64 nel message content (`[[homun-attachments:...]]`)
- **Drag-and-drop**: overlay visuale durante drag, drop trigger upload batch

#### Dettagli Tecnici

**Struct ChatAttachment** (`src/web/chat_attachments.rs`):
```rust
pub struct ChatAttachment {
    pub kind: String,              // "image" or "document"
    pub name: String,
    pub stored_path: String,       // e.g., ".chat-uploads/conv-123/file.pdf"
    pub preview_url: String,       // "/api/v1/chat/uploads/conv-123/file.pdf"
    pub content_type: String,
    pub size_bytes: u64,
}
```

**Inline context encoding**:
```rust
pub fn encode_inline_context(
    text: &str,
    attachments: &[ChatAttachment],
    mcp_servers: &[ChatMcpServerRef],
    blocks: &[ResponseBlock],
) -> Option<String> {
    // Serializes to: [[homun-attachments:{base64_json}]]\n{text}
}
```

**Cleanup stats**:
```rust
pub struct ChatUploadCleanupStats {
    pub files_deleted: u64,
    pub directories_deleted: u64,
    pub bytes_deleted: u64,
}
```

**Upload root**: `{workspace_dir}/.chat-uploads`

**API Endpoints**:
- `POST /api/v1/chat/uploads` → `ChatUploadResponse { ok, attachment }`
- `GET /api/v1/chat/uploads/{conversation_id}/{file_name}`

#### Dipendenze

- Dipende da: filesystem, RAG engine (se embeddings enabled), chat API
- Usato da: chat.js (upload button, drag-and-drop)

---

### 10. REST API — Router e Endpoint

#### Comportamento Atteso

- **Base path**: `/api/v1/*`
- **Public endpoints**: `/health`, `/api/v1/health`, `/api/v1/webhook/{token}`
- **Authenticated**: tutti gli altri endpoint richiedono `Authorization: Bearer {token}` o session cookie
- **Rate limiting**: auth 5 req/min per IP, API 60 req/min per IP, Bearer token 60 req/min
- **Response format**: JSON (Content-Type: application/json)
- **Error handling**: HTTP status codes standard (400, 401, 403, 404, 500)

#### Elenco Principali Endpoint

**Account**:
- `GET /v1/account` — account info
- `GET/POST /v1/account/identities` — gestione identità
- `DELETE /v1/account/identities/{channel}/{platform_id}`
- `GET/POST /v1/account/tokens` — API tokens
- `DELETE/POST /v1/account/tokens/{token_id}` — delete/toggle
- `GET/POST /v1/account/avatar` — avatar

**Chat**:
- `GET/POST /v1/chat/conversations` — lista e crea
- `PATCH/DELETE /v1/chat/conversations/{id}` — update (title, archived) e delete
- `GET/DELETE /v1/chat/history` — fetch e clear
- `POST /v1/chat/truncate` — truncate from message_id
- `POST/GET /v1/chat/uploads` — upload e download allegati
- `GET/POST /v1/chat/run` — current run snapshot / stop
- `POST /v1/chat/compact` — compact conversation

**Memory**: `GET /v1/memory/search`, `POST /v1/memory/add`, `DELETE /v1/memory/{fact_id}`

**Knowledge (RAG)**:
- `GET /v1/knowledge/documents`, `POST /v1/knowledge/upload`, `DELETE /v1/knowledge/{doc_id}`
- `GET /v1/knowledge/status` — embedding stats

**Skills**:
- `GET /v1/skills` — lista, `GET /v1/skills/search` — catalog search
- `POST /v1/skills/install`, `POST /v1/skills/create`
- `GET/DELETE /v1/skills/{name}`, `POST /v1/skills/{name}/scan`

**MCP**:
- `GET /v1/mcp` — lista, `POST /v1/mcp/install`, `DELETE /v1/mcp/{name}`
- `GET /v1/mcp/oauth/google/start` — init OAuth

**Automations**:
- `GET/POST /v1/automations` — lista e crea
- `PATCH/DELETE /v1/automations/{id}` — update e delete
- `POST /v1/automations/{id}/run`, `GET /v1/automations/{id}/history`

**Workflows**: `GET/POST /v1/workflows`, `PATCH/DELETE /v1/workflows/{id}`

**Vault**:
- `GET/POST /v1/vault/secrets` — lista e crea
- `PATCH/DELETE /v1/vault/secrets/{id}`

**System**:
- `GET /v1/providers/health`, `GET /v1/providers/list`
- `GET /v1/logs?level=error&limit=100&pattern=...`
- `POST /v1/maintenance/vacuum`, `POST /v1/maintenance/backup`, `DELETE /v1/maintenance/cache`
- `GET /v1/traces`, `GET /v1/status`

**Contacts/Profiles**:
- `GET/POST /v1/contacts`, `GET/POST /v1/profiles`

**Sessions**: `GET /v1/sessions`, `DELETE /v1/sessions/{session_id}`

#### Dettagli Tecnici

**API Router assembly** (`src/web/api/mod.rs`):
```rust
pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .merge(logs::routes())
        .merge(status::routes())
        .merge(skills::routes())
        .merge(providers::routes())
        .merge(mcp::routes())
        .merge(channels::routes())
        .merge(account::routes())
        .merge(memory::routes())
        .merge(chat::routes())
        .merge(vault::routes())
        .merge(automations::routes())
        .merge(maintenance::routes())
        .merge(workflows::routes())
        .merge(contacts::routes())
        .merge(profiles::routes())
        .merge(gateways::routes())
        .merge(sharing::routes())
        .merge(sessions::routes())
        .merge(traces::routes())
        #[cfg(feature = "embeddings")]
        .merge(knowledge::routes())
        #[cfg(feature = "browser")]
        .merge(browser::routes())
        .merge(health::routes())
        // ... altri moduli
}
```

**File**: `src/web/api/mod.rs` + 35 file API separati in `src/web/api/`

#### Dipendenze

- Dipende da: AppState (db, config), AuthUser (session/token auth)
- Usato da: client JavaScript, mobile app, webhook handler

---

### 11. Run State e Streaming

#### Comportamento Atteso

- **Run tracking**: ogni chat produce uno snapshot `WebChatRunSnapshot` con ID univoco
- **Real-time updates**: via WebSocket stream events, non HTTP polling
- **Event accumulation**: plan, tool_start, tool_end, stream accumulati nella snapshot
- **Plan event replacement**: events sostituti il precedente (no replay di stati intermedi)
- **Status transitions**: running → stopping → completed
- **Model tracking**: first non-empty "model" event captures effective_model
- **Run persistence**: snapshot salvata async in DB senza bloccare forward loop
- **Active run query**: una sola run attiva per conversation_id

#### Dettagli Tecnici

**Struct WebChatRunSnapshot** (`src/web/run_state.rs`):
```rust
pub struct WebChatRunSnapshot {
    pub run_id: String,                     // run_TIMESTAMP_counter
    pub session_key: String,                // "web:{conversation_id}"
    pub status: String,                     // "running" | "stopping" | "completed"
    pub user_message: String,
    pub effective_model: Option<String>,
    pub assistant_response: String,
    pub created_at: String,                 // RFC3339
    pub updated_at: String,
    pub events: Vec<WebChatRunEvent>,
    pub error: Option<String>,
}
```

**Struct WebChatRunEvent**:
```rust
pub struct WebChatRunEvent {
    pub event_type: String,                 // "tool_start", "tool_end", "model", "plan", etc.
    pub name: String,
    pub tool_call: Option<ToolCallData>,    // for tool_start
}
```

**WebRunStore** (in-memory):
```rust
pub struct WebRunStore {
    next_id: AtomicU64,
    inner: Mutex<WebRunStoreInner>,
}

struct WebRunStoreInner {
    runs: HashMap<String, WebChatRunSnapshot>,
    active_by_session: HashMap<String, String>,  // session_key → run_id
}
```

**Methods**:
- `start_run(session_key, user_message)` — crea snapshot
- `active_snapshot(session_key)` — fetch snapshot corrente
- `append_stream_message(session_key, StreamMessage)` — aggiungi event
- `complete_run(session_key, final_response)` — mark completed
- `request_stop(session_key)` — mark stopping

**Plan event replacement**:
```rust
if event_type == "plan" {
    if let Some(existing) = run.events.iter_mut().rev().find(|e| e.event_type == "plan") {
        *existing = event;  // replace, not append
    } else {
        run.events.push(event);  // first plan
    }
}
```

**API endpoint**: `GET /v1/chat/run` → fetch active WebChatRunSnapshot

#### Dipendenze

- Dipende da: StreamMessage (from bus), Database (async persist)
- Usato da: WebSocket handler, chat API, chat.js

---

### 12. Toast e Notifiche UI

#### Comportamento Atteso

- **Global toast function**: `window.showToast(message, type, duration)`
- **Types**: success (verde), error (rosso), warning (giallo), info (blu)
- **Position**: fixed bottom-right, 24px padding
- **Duration**: default 2500ms
- **Auto-dismiss**: slide out e remove dopo timeout
- **Replacement**: solo un toast visible alla volta, nuovo sostituisce il vecchio
- **Safe DOM**: `createElement`/`textContent`, no innerHTML per evitare XSS
- **Error state**: `showErrorState(containerId, message, retryFn)` per inline containers
- **Progress toast**: `showProgressToast(message)` persistent fino a update/dismiss
- **CSRF protection**: token estratto da session cookie, inviato in `X-CSRF-Token` header per POST

#### Dettagli Tecnici

**Toast implementation** (`static/js/toast.js`):
```javascript
window.showToast = function(message, type, duration) {
    type = type || 'success';
    duration = duration || 2500;
    var existing = document.querySelector('.hm-toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.className = 'hm-toast hm-toast--' + type;
    toast.textContent = message;  // safe, no innerHTML
    document.body.appendChild(toast);
    requestAnimationFrame(function() { toast.classList.add('hm-toast--visible'); });
    setTimeout(function() {
        toast.classList.remove('hm-toast--visible');
        setTimeout(function() { toast.remove(); }, 200);
    }, duration);
};
```

**CSRF token** (`static/js/csrf.js`):
```javascript
function getCsrfToken() {
    var match = document.cookie.match(/homun_session=([^;]+)/);
    return match ? match[1] : null;
}
```

**CSS classes**:
- `.hm-toast`, `.hm-toast--success`, `.hm-toast--error`, `.hm-toast--warning`, `.hm-toast--info`
- `.hm-toast--visible` — animate in/out transition
- `.hm-toast--progress` — persistent toast
- `.hm-error-state`, `.hm-retry-btn`

#### Dipendenze

- Dipende da: DOM, CSS (styling)
- Usato da: tutte le pagine (global functions via `window.*`)

---

### 13. Visual Flow Builder (Automations)

#### Comportamento Atteso

- **Rendering modi**: mini (dot strip con hover tooltip), full (n8n-style dark canvas)
- **Node kinds**: trigger, tool, skill, mcp, llm, condition, parallel, subprocess, loop, transform, deliver
- **Colori per kind**: amber (trigger), green (tool), terracotta (skill), plum (mcp), blue (llm), ecc.
- **Canvas**: SVG con grid pattern, nodes posizionati assolutamente, connettori come path SVG
- **Dark canvas**: background `#1E1F2B`, node bg `#2A2B3D`, border `#383A4E`
- **Icons**: SVG path inline per ogni kind
- **Save**: persist flow JSON in DB
- **Mini render**: tiny dot strip per preview conversazioni

#### Dettagli Tecnici

**KIND_CONFIG** (`static/js/flow-renderer.js`):
```javascript
var KIND_CONFIG = {
    trigger: { accent: '#E8A838', icon: 'M13 10V3L4 14h7v7l9-11h-7z', iconFill: true },
    tool:    { accent: '#68B984', icon: '...', iconFill: false },
    skill:   { accent: '#E07C4F' },   // terracotta
    mcp:     { accent: '#9B72CF' },   // plum
    llm:     { accent: '#5B9BD5' },   // blue
    condition: { accent: '#8BC34A', shape: 'diamond' },
    parallel:  { accent: '#26A69A', shape: 'diamond' },
    subprocess: { accent: '#5C7AEA', shape: 'subprocess' },
    loop:      { accent: '#AB8F67' },
    transform: { accent: '#78909C' },
    deliver:   { accent: '#42A5F5' },
};
```

**Canvas constants**:
```javascript
var NODE_W = 160; var NODE_H = 72; var DIAMOND_S = 56;
var NODE_RX = 12; var GAP_X = 70; var GAP_Y = 36; var PAD = 40;
var CANVAS_BG = '#1E1F2B'; var NODE_BG = '#2A2B3D'; var NODE_BORDER = '#383A4E';
var NODE_TEXT = '#E8E6E3';
```

**SVG rendering functions**:
- `renderFlowMini(container, flowData)` — 4x4 grid di small nodes
- `renderFlow(container, flowData)` — full canvas n8n-style

**API endpoints**:
- `GET /v1/automations` — fetch flow JSON
- `POST /v1/automations` — save flow
- `PATCH /v1/automations/{id}` — update flow

**File**: `static/js/flow-renderer.js`, `static/js/automations.js` (grandfathered)

#### Dipendenze

- Dipende da: Automation API, SVG rendering
- Usato da: automations.js, workflows.js

---

### 14. Debug Mode e Osservabilità

#### Comportamento Atteso

- **Development mode**: asset da disco per hot-reload JavaScript/CSS senza rebuild
- **Production mode**: asset embedded nel binario via rust-embed
- **Traces**: endpoint `/v1/traces` per analizzare request latency, errors
- **Logs endpoint**: `/v1/logs` per tail real-time log output con filtering
- **SSE logs**: structured log streaming (livello, modulo, messaggio)
- **Health endpoints**: pubblici `/health` + `/api/v1/health` per monitoraggio

#### Dettagli Tecnici

**Conditional embedding** (`src/web/server.rs`):
```rust
#[cfg(feature = "web-ui")]
use std::path::Path;

// rust-embed macro
#[folder = "static"]
pub struct Assets;
// In debug: serve da ./static (hot-reload)
// In release: embedded nel binario
```

**WebSocket debug logging**:
```rust
tracing::info!(session = %chat_id, "WebSocket client connected");
tracing::error!(run_id = %run.run_id, %error, "Failed to persist web chat run");
```

**Logs API** — `GET /v1/logs?level=error&limit=100&pattern=...`:
- Tail real-time logs con filtering per level, module, pattern

**Traces API** — `GET /v1/traces`:
- Registra tutti i request HTTP con timing, status, payload size
- Endpoint: `GET /v1/traces?limit=50&filter={filter}`

**File**: `src/web/server.rs`, `src/web/api/logs.rs`, `src/web/api/traces.rs`

#### Dipendenze

- Dipende da: rust-embed, tracing
- Usato da: developers per debugging, monitoring

---

## Architettura di Flusso Dati

### Flusso Chat Completo

```
1. User digita in chat.js → textarea
2. Form submit → InboundMessage → inbound_tx → AgentLoop
3. AgentLoop elabora → produce StreamMessage events
4. StreamMessage → stream_tx (WebSocket stream channel, buffer 128)
5. WebSocket handler legge stream_rx, serializza JSON
6. ws.send(Message::Text(json)) → client
7. chat.js riceve message, aggiorna DOM in tempo reale
8. User vede streaming text + tool timeline + plan panel
9. Final response → store in DB conversation
```

### Ciclo Autenticazione

```
1. GET /login → login_page HTML
2. POST /api/v1/login (username, password)
3. RateLimiter check (5 req/min per IP)
4. verify_password() PBKDF2 check (600K iterations, timing-safe)
5. SessionStore::create_session() → session_id + CSRF token
6. Set-Cookie: homun_session={session_id}
7. Browser invia homun_session cookie in tutti i request
8. Middleware Extension<AuthUser> valida session via HMAC
9. Logout: DELETE /api/v1/sessions/{session_id}
```

---

## Tabelle Database

| Tabella | Uso |
|---------|-----|
| `web_chat_runs` | WebChatRunSnapshot storage |
| `api_tokens` | Bearer token records |
| `conversations` | chat conversation metadata (title, archived, updated_at) |
| `messages` | chat messages (role, content, attachments, blocks) |
| `skill_audits` | skill execution audit log |
| `automations` | automation flow definitions |
| `users` | user account info (username, role, avatar, created_at) |
| `approvals` | pending human-in-loop approvals |
| `contacts` | contact directory |
| `profiles` | user profile per channel |
| `knowledge_documents` | RAG document metadata (se embeddings enabled) |

---

## Feature Flags

| Flag | Effetto |
|------|---------|
| `web-ui` | abilita embedded web interface |
| `embeddings` | abilita RAG/memory search endpoints (`/v1/knowledge/`, `/v1/embeddings/`) |
| `browser` | abilita browser integration (`/v1/browser/`) |

---

## Sicurezza

| Meccanismo | Implementazione |
|------------|----------------|
| Password hashing | PBKDF2-HMAC-SHA256, 600K iterazioni, 16-byte salt, timing-safe verify |
| Session cookies | HMAC-SHA256 signed, TTL 24h, client IP + User-Agent tracking |
| CSRF protection | Token per sessione, inviato in `X-CSRF-Token` header |
| Rate limiting | 5 req/min per IP (auth), 60 req/min (API), 60 req/min per token |
| TLS | Certificati auto-firmati, opzionale tunnel URL per mobile |
| Safe DOM | toast.js usa `textContent` no innerHTML injection |
| Bearer scopes | admin / read / mobile_stop (least privilege) |
