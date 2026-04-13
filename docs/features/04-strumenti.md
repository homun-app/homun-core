# 04 — Strumenti (Tools)

Documento di specifica funzionale del dominio **Tools** del progetto Homun.
Copre l'architettura di registrazione, il contesto di esecuzione e tutti i tool built-in disponibili per l'LLM.

---

## Panoramica

Il dominio Tools espone all'LLM un insieme di funzioni chiamabili (function calling OpenAI-compatible).
Ogni tool implementa il trait `Tool` e viene registrato nel `ToolRegistry`.

| # | Nome tool (LLM) | Struct Rust | Categoria | Feature flag |
|---|---|---|---|---|
| 1 | `shell` | `ShellTool` | Sistema | — |
| 2 | `read_file` | `ReadFileTool` | File | — |
| 3 | `write_file` | `WriteFileTool` | File | — |
| 4 | `edit_file` | `EditFileTool` | File | — |
| 5 | `list_dir` | `ListDirTool` | File | — |
| 6 | `web_search` | `WebSearchTool` | Web | — |
| 7 | `web_fetch` | `WebFetchTool` | Web | — |
| 8 | `send_message` | `MessageTool` | Comunicazione | — |
| 9 | `spawn_subagent` | `SpawnTool` | Agenti | — |
| 10 | `automation` | `AutomationTool` | Scheduler | — |
| 11 | `workflow` | `WorkflowTool` | Orchestrazione | — |
| 12 | `contacts` | `ContactsTool` | Rubrica | — |
| 13 | `vault` | `VaultTool` | Sicurezza | — |
| 14 | `remember` | `RememberTool` | Memoria | `embeddings` |
| 15 | `knowledge` | `KnowledgeTool` | Conoscenza | `embeddings` |
| 16 | `browser` | `BrowserTool` | Browser | `browser` |
| 17 | `create_skill` | `CreateSkillTool` | Skills | — |
| 18 | `read_email_inbox` | `ReadEmailInboxTool` | Email | `channel-email` |
| 19 | `mcp_*` | `McpManager` / peer tools | Protocollo MCP | `mcp` |
| 20 | `mcp_token_refresh` | `McpTokenRefreshTool` | Protocollo MCP | `mcp` |
| 21 | `send_file` | `SendFileTool` | File/Comunicazione | — |
| 22 | `view_file` | `ViewFileTool` | File/UI | — |
| 23 | `add_data` | `AddDataTool` | Data collection | — (dinamico) |

> I tool con feature flag sono compilati solo quando la feature corrispondente è attiva in `Cargo.toml`.
> `add_data` è **dinamico**: viene creato solo quando la fase di Cognition identifica un `data_schema` (task di raccolta dati strutturati). Lo schema dei parametri include i nomi delle colonne del `DataBuffer` in modo che l'LLM sappia esattamente quali campi fornire.

---

## Feature: Tool Registry

### Comportamento Atteso

- Il registry è il punto centrale dove tutti i tool built-in e i tool generati da skill vengono registrati all'avvio.
- Quando l'LLM effettua una chiamata a funzione (function call), il registry individua il tool per nome e lo esegue.
- Prima di ogni ciclo di risposta, il registry genera la lista di definizioni JSON Schema da passare all'LLM (`get_definitions()`).
- **Input**: nome tool + argomenti JSON (dal provider LLM).
- **Output**: `ToolResult` con campo `output: String` (sempre testuale per l'LLM) e `blocks: Vec<ResponseBlock>` (per client rich).
- **Stato errore**: se il tool non esiste o l'esecuzione fallisce, restituisce `ToolResult::error(...)` senza propagare il panic.
- **Edge case**: tool non trovato → errore leggibile ("Unknown tool: X"); tool che lancia un'eccezione interna → wrappato in `ToolResult::error`.

### Dettagli Tecnici

- **File**: `src/tools/registry.rs`
- **Struct principale**: `ToolRegistry` (HashMap `name → Box<dyn Tool>`)
- **Trait `Tool`**: metodi `name()`, `description()`, `parameters() → Value`, `execute(args, ctx) → Result<ToolResult>`
- **Struct `ToolResult`**: campi `output: String`, `is_error: bool`, `blocks: Vec<ResponseBlock>`
- **Costruttori helper**: `ToolResult::success(s)`, `ToolResult::error(s)`, `ToolResult::with_blocks(s, blocks)`
- **Flusso dati**:
  1. `AgentLoop` chiama `registry.get_definitions()` → lista `Vec<ToolDefinition>` in formato OpenAI function calling
  2. LLM risponde con tool call → `AgentLoop` chiama `registry.execute(name, args, ctx)`
  3. `registry.execute` delega al tool corretto → restituisce `ToolResult`
  4. `AgentLoop` invia il testo di output all'LLM come tool result message
- **Formato definizione**: `ToolDefinition { tool_type: "function", function: FunctionDefinition { name, description, parameters (JSON Schema) } }`
- **Tabelle DB**: nessuna (in-memory HashMap)
- **Endpoint API**: nessuno diretto; esposto indirettamente via gateway

### Dipendenze

- **Da cosa dipende**: `crate::provider::{FunctionDefinition, ToolDefinition}`, `crate::bus::OutboundMessage`, `crate::tools::approval::ApprovalManager`
- **Cosa dipende da questa feature**: `AgentLoop` (usa registry per dispatch), tutti i tool built-in (implementano `Tool`), skill engine (registra tool dinamici)

---

## Feature: Tool Context

### Comportamento Atteso

- Il `ToolContext` è la struttura passata a ogni tool durante l'esecuzione, contenente tutto il contesto necessario all'operazione.
- Consente ai tool di sapere in quale workspace operare, a quale utente/canale rispondere, e se richiedere approvazione.
- **Input**: costruito dall'`AgentLoop` prima di ogni esecuzione.
- **Output**: nessuno diretto (è un parametro passato ai tool).
- **Edge case**: campi opzionali (`message_tx`, `approval_manager`, `skill_env`, `profile_id`, ecc.) → i tool controllano la presenza prima dell'uso.

### Dettagli Tecnici

- **File**: `src/tools/registry.rs`
- **Struct**: `ToolContext`
- **Campi principali**:

| Campo | Tipo | Descrizione |
|---|---|---|
| `workspace` | `String` | Directory di lavoro del processo |
| `channel` | `String` | Canale corrente (es. `"telegram"`, `"cli"`) |
| `chat_id` | `String` | ID della chat corrente |
| `message_tx` | `Option<mpsc::Sender<OutboundMessage>>` | Sender per messaggi proattivi (None in CLI) |
| `approval_manager` | `Option<Arc<ApprovalManager>>` | Gestore approvazioni (None se disabilitato) |
| `skill_env` | `Option<HashMap<String, String>>` | Variabili d'ambiente da skill attiva |
| `user_id` | `Option<String>` | ID utente attivo |
| `profile_id` | `Option<i64>` | ID profilo attivo |
| `profile_brain_dir` | `Option<PathBuf>` | Directory brain del profilo (per `remember`) |
| `profile_slug` | `Option<String>` | Slug profilo (per `vault`) |
| `allowed_namespaces` | `Option<Vec<String>>` | Namespace conoscenza visibili al contatto |
| `contact_id` | `Option<i64>` | ID contatto della conversazione corrente |
| `channel_defaults` | `Option<HashMap<String, String>>` | Mapping canale → chat_id default (cross-channel) |

- **Flusso dati**: `AgentLoop` costruisce `ToolContext` per ogni sessione → passato per riferimento a ogni `tool.execute(args, ctx)`
- **Tabelle DB**: nessuna
- **Endpoint API**: nessuno

### Dipendenze

- **Da cosa dipende**: `crate::bus::OutboundMessage`, `crate::tools::approval::ApprovalManager`
- **Cosa dipende da questa feature**: tutti i tool built-in (ricevono `ToolContext` in `execute`), `AgentLoop`

---

## Feature: Shell Tool

### Comportamento Atteso

- Permette all'LLM di eseguire comandi shell arbitrari nel workspace dell'utente.
- Prima dell'esecuzione applica **tre livelli di filtri di sicurezza**: deny list esatta, pattern regex, comandi rischiosi.
- **Input**: `command: String` (obbligatorio), `working_dir: String` (opzionale, default: workspace).
- **Output**: stdout + stderr del processo, troncato a 10.000 caratteri.
- **Stato successo**: comando terminato con exit code 0, output restituito come stringa.
- **Stato errore**: comando bloccato dai filtri, timeout scaduto, exit code non zero → `ToolResult::error` con spiegazione.
- **Edge case e limiti**:
  - Comandi in `DENY_EXACT` bloccati incondizionatamente (es. `rm -rf /`, `shutdown`, fork bomb).
  - Pattern regex bloccano varianti e obfuscation (es. `curl | bash`, `eval | base64`).
  - Comandi `RISKY_COMMANDS` bloccati salvo `allow_risky: true` in config.
  - Timeout configurabile (default dal config), processo killato allo scadere.
  - Output troncato a `MAX_OUTPUT_LEN = 10_000` caratteri.
  - Environment del subprocess sanitizzato (API key rimosse).
  - Se `restrict_to_workspace: true`, il working_dir è limitato al workspace.
  - Esecuzione avviene dentro sandbox se configurata (vedi Feature: Sandbox).
  - **Sandbox denial detection**: se il processo viene killato da un segnale (SIGABRT su macOS Seatbelt, SIGKILL su Linux), il tool emette un `[diagnostic]` nel output con signal number, backend risolto, e suggerimenti. L'LLM legge il diagnostic e adatta la strategia (es. suggerisce l'escalation all'utente invece di riprovare ciecamente).
  - **Escalation Block**: quando il sandbox killa un comando, il tool emette un `ResponseBlock::Choice` con opzioni: "Allow Once" (bypass one-shot per la prossima invocazione), "Allow Always: folder" (persiste il path in `execution_sandbox.allow_paths`), "Allow Always: file" (idem), "Deny" (LLM adatta approccio).
  - **Shell fallback**: quando sandbox attivo, usa `sh -c` al posto di `zsh -c` (zsh ha problemi di startup sotto Seatbelt su macOS 26+).

### Dettagli Tecnici

- **File**: `src/tools/shell.rs`
- **Struct**: `ShellTool { timeout_secs, restrict_to_workspace, allow_risky, deny_regex, os_profile, sandbox_config, shared_config }`
- **Costruttore principale**: `ShellTool::with_permissions_and_sandbox(...)`
- **Layer di sicurezza**:
  1. `DENY_EXACT`: slice di stringhe, match esatto (trim)
  2. `DENY_REGEX_PATTERNS`: slice di regex compilate all'avvio
  3. `RISKY_COMMANDS`: slice, bloccati se `!allow_risky`
  4. Check OS-specifico via `OsShellProfile`
  5. Workspace restriction (path traversal check)
  6. Timeout via `tokio::time::timeout`
  7. Output truncation: `output[..MAX_OUTPUT_LEN]`
  8. Env sanitization via `sandbox::env::SAFE_ENV_KEYS`
- **Flusso dati**:
  1. Tool riceve `command` e `working_dir` dai parametri JSON
  2. Passa per i filtri di sicurezza (deny, regex, risky)
  3. Controlla sandbox bypass grant (`ApprovalManager.consume_sandbox_bypass()`) — se presente, disabilita sandbox per questa invocazione
  4. Se sandbox attivo e shell configurata != `sh`, fallback a `sh -c`
  5. Chiama `sandbox::build_process_command(...)` per costruire il processo con eventuale sandbox
  6. Esegue il processo con `tokio::process::Command`
  7. Legge stdout/stderr con `AsyncReadExt`, applica truncation
  8. Se processo terminato da segnale: `describe_termination()` aggiunge `[diagnostic]` + emette escalation block se sandbox attivo
  9. Restituisce `ToolResult::success(output)` o `ToolResult::error(...)` con eventuali `blocks`
- **Tabelle DB**: nessuna
- **Endpoint API**: nessuno

### Dipendenze

- **Da cosa dipende**: `sandbox::build_process_command`, `crate::config::{Config, ExecutionSandboxConfig, OsShellProfile, ShellPermissions}`, `crate::tools::approval::ApprovalManager` (via ctx)
- **Cosa dipende da questa feature**: `AgentLoop` (esegue comandi), approval workflow (per comandi risky)

---

## Feature: File Tool

### Comportamento Atteso

- Fornisce quattro tool distinti per operazioni su file: lettura, scrittura, modifica e listing directory.
- Ogni operazione è soggetta a controllo ACL (Access Control List) configurato dall'utente.
- **`read_file`**: legge il contenuto di un file. Input: `path`. Output: contenuto testuale (max 50.000 caratteri).
- **`write_file`**: scrive o crea un file. Input: `path`, `content`. Output: conferma + `ResultBlock` (con `Size` e `Download`) quando il file è dentro il workspace.
  - **Auto-generate workspace path**: se l'LLM omette `path` (o passa path vuoto), il tool genera automaticamente un path dentro `~/.homun/workspace/` basato su un filename derivato dal content type o da un UUID. Serve a difendersi da tool call args incompleti dei modelli più piccoli.
  - **Heredoc fallback**: quando il modello invia `{}` come args (args vuoti = truncation o mis-generation), il tool tenta un fallback via shell heredoc parsando il testo precedente della risposta LLM. Insieme al salvage dei truncated tool call args lato provider, elimina la classe "generated huge content but args arrived empty".
- **`edit_file`**: modifica parziale di un file (ricerca e sostituzione o patch). Input: `path`, parametri di edit.
- **`list_dir`**: elenca file e directory in un path. Input: `path`. Output: lista file con metadati.
- **Controllo permessi ACL**:
  - `PermissionResult::Allowed` → esecuzione diretta.
  - `PermissionResult::Denied(msg)` → errore immediato.
  - `PermissionResult::NeedsConfirmation(msg)` → richiede approvazione utente via `ApprovalManager`.
- **Glob pattern**: le regole ACL supportano `**`, `*`, `?` con espansione `~`.
- **Edge case**: file troppo grande troncato a `MAX_READ_SIZE = 50_000` caratteri; path non esistente → errore; path fuori workspace → bloccato se `restrict_to_workspace`.

### Dettagli Tecnici

- **File**: `src/tools/file.rs`
- **Struct esportate**: `ReadFileTool`, `WriteFileTool`, `EditFileTool`, `ListDirTool`
- **Enum interni**: `FileOp { Read, Write, Delete }`, `PermissionResult { Allowed, Denied(String), NeedsConfirmation(String) }`
- **Funzione ACL**: `check_acl_permission(resolved: &Path, operation: FileOp, permissions: &PermissionsConfig) → PermissionResult`
- **Glob matching**: `glob_matches(pattern, path)` — implementazione ricorsiva senza dipendenze esterne
- **Flusso dati**:
  1. Tool riceve `path` dal parametro JSON
  2. Risolve il path assoluto (espansione `~`, canonicalizzazione)
  3. Controlla ACL via `check_acl_permission`
  4. Se `NeedsConfirmation` → richiesta all'`ApprovalManager` del contesto
  5. Esegue l'operazione I/O (`tokio::fs`)
  6. Applica truncation se necessario
  7. Restituisce `ToolResult`
- **Tabelle DB**: nessuna (operazioni su filesystem)
- **Endpoint API**: nessuno

### Dipendenze

- **Da cosa dipende**: `crate::config::{AclEntry, DefaultPermissions, PathPermissions, PermissionMode, PermissionValue, PermissionsConfig}`, `dirs::home_dir()`, `crate::tools::approval::ApprovalManager` (via ctx)
- **Cosa dipende da questa feature**: `AgentLoop`, skill engine (lettura/scrittura file skill), workflow engine (file di output)

---

## Feature: Web Tool

### Comportamento Atteso

- Fornisce due tool distinti per accesso al web: ricerca e fetch.
- **`web_search`**: ricerca web tramite API Brave Search. Input: `query: String`. Output: lista di risultati (titolo, URL, descrizione), numerati.
- **`web_fetch`**: scarica e restituisce il contenuto testuale di una URL nota. Input: `url: String`. Output: testo estratto dall'HTML (max 50.000 caratteri).
- **`web_search` — Stato errore**: API key mancante → errore descrittivo; HTTP error → errore con status code; nessun risultato → messaggio "No results found".
- **`web_fetch` — Stato errore**: URL non valida → errore; HTTP error → errore con status; pagina JS-only → **auto-escalate al browser tool** (vedi sotto).
- **Edge case**:
  - `web_search`: configurabile `max_results` (parametro costruttore).
  - `web_fetch`: max 5 redirect seguiti; timeout 30 secondi; stripping HTML tag (basic); rilevazione pagine JavaScript-only.
  - **Auto-escalate to browser** (2026-04): quando `looks_like_js_required()` identifica una SPA vuota, invece di fallire con un hint testuale, l'agent loop escala automaticamente alla pipeline browser (navigate + snapshot) senza perdere l'iterazione. Questo elimina il giro "fetch → errore → LLM capisce → ri-prompt browser" su siti JS-rendered.
  - Brave Search alternativa: è possibile integrare Tavily come provider alternativo (pattern architetturale previsto).

### Dettagli Tecnici

- **File**: `src/tools/web.rs`
- **Struct**: `WebSearchTool { client, api_key, max_results }`, `WebFetchTool { client }`
- **API esterna**: Brave Search API `GET https://api.search.brave.com/res/v1/web/search` con header `X-Subscription-Token`
- **HTML stripping**: funzione interna `strip_html_tags(&body)` (rimozione tag, normalizzazione whitespace)
- **JS detection**: funzione `looks_like_js_required(&body, &text)` — rilevazione pagine SPA vuote
- **Flusso `web_search`**:
  1. Validazione API key non vuota
  2. GET all'API Brave con query e count
  3. Parsing risposta JSON
  4. Formattazione lista risultati
  5. Restituzione `ToolResult::success`
- **Flusso `web_fetch`**:
  1. Validazione schema URL
  2. GET con client reqwest (redirect limitati, timeout 30s)
  3. Check status HTTP
  4. Lettura body, strip HTML
  5. Truncation a `MAX_FETCH_CHARS = 50_000`
  6. Restituzione testo
- **Tabelle DB**: nessuna
- **Endpoint API**: Brave Search API (esterna)

### Dipendenze

- **Da cosa dipende**: `reqwest::Client`, `serde_json`, API key configurata in `[tools.web_search]`
- **Cosa dipende da questa feature**: `AgentLoop`, skill di ricerca, workflow con step "research"

---

## Feature: Message Tool

### Comportamento Atteso

- Permette all'LLM di inviare messaggi proattivi all'utente durante l'esecuzione di un task, senza attendere la fine dell'elaborazione.
- Utile per: aggiornamenti di progresso, notifiche da job schedulati, risposte multi-parte.
- **Input**: `content: String` (obbligatorio), `channel: String` (opzionale), `chat_id: String` (opzionale).
- **Output**: conferma "Message delivered to user" o nota sulle limitazioni del canale.
- **Stato CLI**: nessun canale disponibile → log interno, output "Message noted (no active channel to deliver to)" senza errore.
- **Stato Gateway**: messaggio inviato tramite `message_tx` all'`OutboundMessage` bus.
- **Cross-channel**: se `channel` è diverso dal contesto corrente e `chat_id` non è specificato, risolve il `chat_id` default dal campo `channel_defaults` del contesto.
- **Edge case**:
  - Canale senza supporto markdown → nota nell'output se il contenuto contiene markdown.
  - Canale senza supporto proactive send → nota nell'output.
  - `message_tx` pieno (canale saturo) → `ToolResult::error`.

### Dettagli Tecnici

- **File**: `src/tools/message.rs`
- **Struct**: `MessageTool` (zero-sized struct)
- **Nome LLM**: `send_message`
- **Flusso dati**:
  1. Estrae `content`, `channel`, `chat_id` dagli argomenti
  2. Risolve il `chat_id` target (esplicito > default canale > context)
  3. Controlla capabilities del canale target (`crate::channels::capabilities_for`)
  4. Costruisce `OutboundMessage { channel, chat_id, content, metadata: None }`
  5. Invia via `ctx.message_tx.send(outbound).await`
  6. Restituisce conferma o errore
- **Tabelle DB**: nessuna
- **Endpoint API**: nessuno (usa il bus interno `mpsc::Sender<OutboundMessage>`)

### Dipendenze

- **Da cosa dipende**: `crate::bus::OutboundMessage`, `crate::channels::capabilities_for`, `ctx.message_tx`, `ctx.channel_defaults`
- **Cosa dipende da questa feature**: automation job (notifiche), workflow engine (progress update), spawn subagent (completamento task)

> **Nota — allegati via `send_message`**: dal 2026-04 `send_message` accetta anche il parametro `file` per allegare un file del workspace come documento di canale (stesso pipeline di `send_file`). Il tool dedicato `send_file` rimane il canale preferito per delivery esplicita; l'allegato su `send_message` è pensato per i casi in cui l'LLM vuole accompagnare un testo con un file in un'unica chiamata.

---

## Feature: Send File Tool

### Comportamento Atteso

- Consegna un file del workspace all'utente come **documento allegato** sul canale messaggistica (es. `sendDocument` di Telegram, attachment WhatsApp/Discord/Email).
- Esiste come tool dedicato — **non è solo uno shortcut** di `send_message` — per rendere chiaro anche ai modelli più piccoli che *"mandami il file CSV"* deve instradare qui invece che tentare di dumpare bytes con `read_file`.
- **Azioni e parametri**:
  - `file` (obbligatorio): filename o path del file nel workspace (es. `report.pdf`, `data/out.csv`).
  - `caption` (opzionale): messaggio di accompagnamento; default: `"File: {filename}"`.
  - `channel` (opzionale): canale di destinazione, default il canale corrente.
  - `chat_id` (opzionale): override destinatario, default la chat corrente.
- **Risoluzione path**: cerca in ordine (1) path assoluto, (2) relativo al workspace, (3) solo filename dentro il workspace — specchio di `view_file`.
- **Stato errore**: file non trovato → errore descrittivo con hint a `write_file`/`list_dir`; canale senza supporto file upload → messaggio di fallback; nessun `message_tx` (CLI) → errore.
- **Edge case**: il file deve esistere fisicamente in `~/.homun/workspace/` al momento della chiamata; non vengono applicate ACL del filesystem tool perché il workspace è esplicitamente lo scope consentito.

### Dettagli Tecnici

- **File**: `src/tools/send_file.rs`
- **Struct**: `SendFileTool` (zero-sized)
- **Nome LLM**: `send_file`
- **Flusso dati**:
  1. `resolve_workspace_file(raw)` → `Option<String>` (assoluto/relativo/bare filename)
  2. Determinazione `channel` (esplicito o da `ctx.channel`) e `chat_id`
  3. Lookup capabilities canale via `capabilities_for(channel)`
  4. Costruzione `OutboundMessage` con metadata `{ "file": path, "caption": ... }`
  5. Invio via `ctx.message_tx.send(...)`
  6. Restituisce conferma + `ResultBlock` con download link workspace
- **Tabelle DB**: nessuna
- **Endpoint API**: nessuno diretto; il recupero lato client passa da `GET /api/v1/workspace/files/{*path}`

### Dipendenze

- **Da cosa dipende**: `crate::bus::OutboundMessage`, `crate::channels::capabilities_for`, `ctx.message_tx`, `crate::config::Config::data_dir`
- **Cosa dipende da questa feature**: `AgentLoop` (registra il tool), canali con upload file (Telegram, WhatsApp, Discord, Email), Web UI (download card inline)

---

## Feature: View File Tool

### Comportamento Atteso

- Mostra un file del workspace **inline nella chat UI** con un preview rich (modal) dotato di smart rendering per tipo di file.
- Complementare a `read_file` (dump raw per ispezione interna) e a `send_file` (consegna su canali esterni): `view_file` è il tool giusto quando l'utente dice *"mostrami"*, *"visualizza"*, *"fammi vedere"* un file nella Web UI.
- **Smart rendering per tipo** (gestito da `static/js/response-blocks.js`):
  - `.csv`/`.tsv` → tabella
  - `.pdf` → preview inline
  - immagini → `<img>`
  - `.json`, `.md`, sorgenti di codice → syntax highlighting
  - altro → `<pre>` plain text
- **Parametri**: solo `file` (obbligatorio) — filename, path relativo o assoluto dentro il workspace.
- **Output LLM**: messaggio testuale conferma + `ResultBlock` con campi `Size` e `Download`; il frontend rileva la presenza del campo `Download` e aggiunge pulsanti View + Download che aprono il file viewer modal.
- **Stato errore**: file mancante → errore con hint; `metadata()` fallisce → errore su stat.
- **Edge case**: per file non dentro il workspace `build_workspace_file_block` ritorna `None` → nessun ResultBlock generato (ma tool result resta valido come testo).

### Dettagli Tecnici

- **File**: `src/tools/view_file.rs` (helper in `src/tools/file.rs::build_workspace_file_block`)
- **Struct**: `ViewFileTool` (zero-sized)
- **Nome LLM**: `view_file`
- **Flusso dati**:
  1. `resolve_workspace_file(raw) → Option<PathBuf>` (stesso pattern di `send_file`)
  2. `tokio::fs::metadata(&path)` per size
  3. `build_workspace_file_block(&path, size_bytes)` → `Option<ResponseBlock::Result>` con `Size`/`Download`
  4. `ToolResult::with_blocks(testo, vec![block])`
- **Endpoint API**: il frontend scarica via `GET /api/v1/workspace/files/{*path}` (rotta Axum 0.7 wildcard)
- **Tabelle DB**: nessuna

### Dipendenze

- **Da cosa dipende**: `crate::tools::file::build_workspace_file_block`, `crate::tools::response_blocks::{ResultBlock, KeyValue}`, `crate::config::Config::data_dir`
- **Cosa dipende da questa feature**: Web UI file viewer modal (`static/js/chat.js`), gateway che serializza `ResponseBlock::Result` nel WS stream

---

## Feature: Add Data Tool (dinamico)

### Comportamento Atteso

- Permette all'LLM di **accumulare record strutturati fuori dal context window** durante un task di raccolta dati (scraping di listing, comparazioni, estrazione fatti).
- **Perché esiste**: senza di esso il modello doveva generare interi CSV come argomento di `write_file`, con conseguente troncamento frequente dei tool call args sui modelli più piccoli. `add_data` spinge i record in un `DataBuffer` lato agente, che viene esportato al termine.
- **Attivazione**: non è un tool sempre presente — viene registrato **dinamicamente dall'agent loop** solo quando la Cognition phase identifica un `data_schema` nel `CognitionResult` (cioè quando il task richiede raccolta strutturata).
- **Schema dei parametri dinamico**: i nomi delle colonne del `DataBuffer` vengono iniettati come `properties` dell'item record in `parameters_for_schema(&schema)`, così il modello vede esattamente quali campi fornire.
- **Input**: `records: Array<Object>` — ogni oggetto ha i campi dello schema (tutti stringhe).
- **Output**: conferma `"Added N records (total: M)"`.
- **Edge case**: `records` vuoto → `"No records provided."` (success, non errore); entry non-object → skippata silenziosamente; schema non configurato → fallback a `additionalProperties: string`.

### Dettagli Tecnici

- **File**: `src/tools/add_data.rs`
- **Struct**: `AddDataTool { buffer: Arc<Mutex<DataBuffer>> }` — share con l'agent loop tramite `Arc<Mutex<>>`
- **Nome LLM**: `add_data`
- **Metodo helper**: `AddDataTool::parameters_for_schema(schema: &[String]) → Value` per generare lo schema JSON dinamico
- **Flusso dati**:
  1. Cognition identifica `data_schema` in `CognitionResult`
  2. Agent loop crea `DataBuffer` con quel schema, poi `AddDataTool::new(Arc::new(Mutex::new(buffer)))`
  3. LLM chiama `add_data` con array di record → lock sul buffer, push N record
  4. Al termine del task, l'agent loop esporta il buffer (tipicamente CSV) e emette `ResultBlock` con download link
- **Tabelle DB**: nessuna (buffer in-memory per la run; esportato come file workspace)
- **Endpoint API**: nessuno diretto

### Dipendenze

- **Da cosa dipende**: `crate::agent::data_buffer::DataBuffer`, `tokio::sync::Mutex`
- **Cosa dipende da questa feature**: `AgentLoop` (registrazione dinamica via `CognitionResult.data_schema`), Cognition engine (decide quando emetterlo), esportazione finale (scrive il file workspace + emette `view_file`/download block)

---

## Feature: Approval Tool

### Comportamento Atteso

- Gestisce il flusso di approvazione interattiva per azioni potenzialmente rischiose prima dell'esecuzione.
- Tre livelli di autonomia: `Full` (nessuna approvazione), `Supervised` (approvazione per tool non in allowlist), `ReadOnly` (approvazione per tutto).
- **Flusso utente**:
  1. Tool richiede `needs_approval(tool_name)` → true
  2. Viene creata una `PendingApproval` con UUID univoco
  3. L'utente riceve la richiesta (via Web UI o blocco UI ricco)
  4. Utente risponde: `Yes` (una volta), `Always` (aggiunge alla session allowlist), `No` (blocca)
  5. Se `Always`: il comando base (es. `npm`) viene aggiunto alla session allowlist → successivi non richiedono approvazione
- **One-time pass**: meccanismo "Allow Once" che consuma un'approvazione singola per base command.
- **Audit log**: ogni decisione viene registrata in `ApprovalLogEntry` (timestamp, tool, args summary, decision, channel).
- **Edge case**:
  - `always_ask` list sovrascrive la session allowlist (il tool verrà sempre chiesto).
  - `auto_approve` list esclude tool dalla richiesta.
  - `Full` autonomy bypassa qualsiasi controllo.

### Dettagli Tecnici

- **File**: `src/tools/approval.rs`
- **Struct principale**: `ApprovalManager { auto_approve, always_ask, autonomy_level, session_allowlist (Mutex), audit_log (Mutex), pending_approvals (Mutex), approved_commands (Mutex) }`
- **Istanza globale**: `OnceLock<Arc<ApprovalManager>>` inizializzata con `init_approval_manager(config)`
- **Enum**: `ApprovalDecision { Yes, No, Always }`, `AutonomyLevel { Full, Supervised, ReadOnly }`
- **Struct**: `PendingApproval { id: UUID, tool_name, command, arguments, channel, chat_id, created_at }`, `ApprovalResponse { approved, decision, message, pending_id }`
- **Metodi chiave**:
  - `needs_approval(tool_name) → bool`
  - `create_pending(tool_name, command, args, channel, chat_id) → ApprovalId`
  - `approve(id, always) → Result<(), String>`
  - `deny(id) → Result<(), String>`
  - `approve_with_cmd(id, base_cmd) → Result<(), String>` — aggiunge base command alla allowlist
  - `grant_one_time_pass(base_cmd)` / `consume_one_time_pass(base_cmd) → bool`
  - `check_command(command, channel, chat_id) → ApprovalResponse` — entry point per ShellTool
- **Flusso dati**: ShellTool → `check_command` → `create_pending` → blocco attesa → UI risponde → `approve`/`deny` → sblocco esecuzione
- **Tabelle DB**: nessuna (in-memory, sessione corrente)
- **Endpoint API**: endpoint Web UI `/approvals` per gestione pending

### Dipendenze

- **Da cosa dipende**: `crate::config::{ApprovalConfig, AutonomyLevel}`, `uuid::Uuid`, `chrono::Utc`
- **Cosa dipende da questa feature**: `ShellTool` (check_command), `FileTool` (NeedsConfirmation), Web UI (gestione pending), `ToolContext` (porta l'Arc<ApprovalManager>)

---

## Feature: Spawn Tool

### Comportamento Atteso

- Permette all'LLM di delegare task lunghi o paralleli a **subagent** che girano in background senza bloccare la conversazione principale.
- **Azioni**:
  - `spawn`: avvia un nuovo task background. Input: `description: String`, `message: String`. Output: conferma con `task_id`.
  - `list`: elenca i task in esecuzione. Output: lista task con ID e stato.
- **Stato vuoto** (list): "No tasks running".
- **Stato errore**: SubagentManager non inizializzato (startup race) → errore descrittivo; spawn fallito → errore.
- **Edge case**: il `SubagentManager` viene collegato in modo lazy tramite `OnceCell` per evitare dipendenze circolari tra `AgentLoop` e `SubagentManager`.

### Dettagli Tecnici

- **File**: `src/tools/spawn.rs`
- **Struct**: `SpawnTool { manager: Arc<tokio::sync::OnceCell<Arc<SubagentManager>>> }`
- **Nome LLM**: `spawn_subagent`
- **Pattern late-binding**: `OnceCell` — il tool viene costruito prima di `AgentLoop`, il manager viene iniettato dopo la creazione di `AgentLoop`.
- **Flusso dati**:
  1. LLM chiama `spawn_subagent` con `action="spawn"`, `description`, `message`
  2. Tool ottiene il manager via `get_manager()`
  3. Chiama `manager.spawn(description, message, &ctx.channel, &ctx.chat_id).await`
  4. Restituisce `task_id` all'LLM
- **Tabelle DB**: gestite da `SubagentManager` (vedi dominio agenti)
- **Endpoint API**: nessuno diretto

### Dipendenze

- **Da cosa dipende**: `crate::agent::subagent::SubagentManager`, `tokio::sync::OnceCell`
- **Cosa dipende da questa feature**: `AgentLoop` (registra il tool), `SubagentManager` (esegue il task)

---

## Feature: Automation Tool

### Comportamento Atteso

- Permette all'LLM di creare e gestire **automazioni ricorrenti** con schedule, trigger condizionali e storico esecuzioni.
- Destinato a task ripetitivi (es. "ogni mattina controlla email"), diverso da `cron` (semplice reminder) e `workflow` (one-shot multi-step).
- **Azioni disponibili**: `create`, `list`, `status`, `history`, `enable`, `disable`, `update`, `delete`.
- **Schedule**: formato `cron:MIN HOUR DOM MON DOW` o `every:SECONDS`. Accetta linguaggio naturale che l'LLM converte nel formato corretto.
- **Trigger**:
  - `always`: notifica ad ogni esecuzione.
  - `on_change`: notifica solo se l'output cambia rispetto all'esecuzione precedente.
  - `contains`: notifica solo se l'output contiene `trigger_value`.
- **`deliver_to`**: destinazione `channel:chat_id` per le notifiche. Default: chat corrente.
- **Edge case**: schedule non valida → errore con hint; automation non trovata per ID → errore; update senza automation_id → errore.

### Dettagli Tecnici

- **File**: `src/tools/automation.rs`
- **Struct**: `AutomationTool { db: Database }`
- **Nome LLM**: `automation`
- **Flusso dati**:
  1. LLM invia `action` + parametri
  2. Tool esegue la action corrispondente (`handle_create`, `handle_list`, ecc.)
  3. Persistenza su DB via `Database`
  4. Lo scheduler legge la tabella `automations` per pianificare le esecuzioni
- **Tabelle DB**: `automations` (id, name, prompt, schedule, deliver_to, trigger, trigger_value, enabled, last_run, run_count, last_output)
- **Endpoint API**: Web UI (lista e gestione automazioni), endpoint trigger per esecuzione manuale

### Dipendenze

- **Da cosa dipende**: `crate::storage::Database`, `crate::scheduler::AutomationSchedule`, `crate::config::Config`
- **Cosa dipende da questa feature**: scheduler (legge tabella automations per eseguirle), Web UI (mostra e gestisce automazioni)

---

## Feature: Workflow Tool

### Comportamento Atteso

- Permette all'LLM di creare e gestire **workflow multi-step persistenti**, dove ogni step è eseguito da un agente dedicato con propria sessione.
- I risultati di uno step vengono passati automaticamente allo step successivo.
- Uno step può richiedere approvazione umana prima di procedere (`approval_required: true`).
- **Azioni**: `create`, `list`, `status`, `approve`, `cancel`, `restart`, `delete`.
- **Creazione**: parametri `name`, `objective`, `steps[]` (ogni step ha `name`, `instruction`, opzionali `approval_required`, `max_retries`, `agent_id`).
- **`deliver_to`**: `channel:chat_id` per notifiche di progresso.
- **Stato**: pending, running, waiting_approval, completed, failed, cancelled.
- **Edge case**: engine non inizializzato (startup race) → errore; step senza `instruction` → errore di validazione; approvazione su workflow non in attesa → errore.

### Dettagli Tecnici

- **File**: `src/tools/workflow.rs`
- **Struct**: `WorkflowTool { engine: Arc<tokio::sync::OnceCell<Arc<WorkflowEngine>>> }`
- **Nome LLM**: `workflow`
- **Pattern late-binding**: identico a `SpawnTool` — `OnceCell` per evitare dipendenze circolari.
- **Flusso dati**:
  1. LLM chiama `workflow` con `action="create"` + definizione step
  2. Tool invia `WorkflowCreateRequest` al `WorkflowEngine`
  3. Engine persiste il workflow sul DB e avvia l'esecuzione asincrona
  4. Ogni step esegue in una sessione agente separata
  5. Notifiche progress via `send_message` al `deliver_to`
- **Tabelle DB**: `workflows`, `workflow_steps`, `workflow_runs` (gestite da `WorkflowEngine`)
- **Endpoint API**: Web UI (visualizzazione e approvazione step)

### Dipendenze

- **Da cosa dipende**: `crate::workflows::engine::WorkflowEngine`, `crate::workflows::WorkflowCreateRequest`, `tokio::sync::OnceCell`
- **Cosa dipende da questa feature**: `AgentLoop` (registra tool), `WorkflowEngine` (esecuzione), Web UI (approvazione step), `MessageTool` (notifiche)

---

## Feature: Contacts Tool

### Comportamento Atteso

- Fornisce un'agenda contatti completa gestibile dall'LLM tramite linguaggio naturale.
- **10 azioni**: `search`, `resolve`, `get`, `create`, `update`, `add_identity`, `add_relationship`, `add_event`, `upcoming`, `send`.
- **`search`**: ricerca full-text per nome, bio, note, tag.
- **`resolve`**: risolve un nome in contatto concreto (fuzzy match).
- **`get`**: dettagli completo di un contatto.
- **`create`**: crea nuovo contatto. Input: `name` (obbligatorio), campi opzionali (nickname, bio, notes, birthday, preferred_channel, response_mode, tone_of_voice, tags).
- **`update`**: aggiorna campi di un contatto esistente.
- **`add_identity`**: aggiunge identità di canale (es. Telegram ID).
- **`add_relationship`**: aggiunge relazione tra contatti.
- **`add_event`**: aggiunge evento ricorrente (compleanno, onomastico, anniversario).
- **`upcoming`**: lista eventi nei prossimi N giorni.
- **`send`**: risolve canale preferito del contatto e restituisce `channel` + `chat_id` per `send_message`.
- **Edge case**: contatto non trovato → errore descrittivo; `send` senza identità di canale → errore "No contact method found".

### Dettagli Tecnici

- **File**: `src/tools/contacts.rs`
- **Struct**: `ContactsTool { db: Database, config: Arc<RwLock<Config>> }`
- **Nome LLM**: `contacts`
- **Flusso dati**:
  1. LLM invia `action` + parametri
  2. Tool instrada verso handler specifico per action
  3. Handler esegue query su DB (contacts, contact_identities, contact_relationships, contact_events)
  4. Restituisce risultato formattato come testo
- **Tabelle DB**: `contacts`, `contact_identities`, `contact_relationships`, `contact_events`
- **Endpoint API**: Web UI (visualizzazione rubrica), endpoint API contatti

### Dipendenze

- **Da cosa dipende**: `crate::storage::Database`, `crate::config::Config`, `crate::contacts::db`
- **Cosa dipende da questa feature**: `MessageTool` (send usa il canale del contatto), automation (destinatari), workflow (notifiche a contatti), Web UI

---

## Feature: Sandbox (5 backend)

### Comportamento Atteso

- Il modulo Sandbox avvolge l'esecuzione dei processi (shell tool, skill runner) con un layer di isolamento configurabile.
- **5 backend supportati**:

| Backend | Piattaforma | Meccanismo |
|---|---|---|
| `none` | Tutte | Esecuzione nativa senza restrizioni |
| `docker` | Linux/macOS/Windows | Container Docker isolato |
| `linux_native` | Linux | Bubblewrap (`bwrap`) con namespace |
| `macos_seatbelt` | macOS | `sandbox-exec` con profilo Seatbelt |
| `windows_native` | Windows | Job Objects con limiti di risorse |

- La scelta del backend è automatica (`resolve_sandbox_backend`) in base alla piattaforma e alla disponibilità.
- Ogni esecuzione viene loggata in `SandboxEvent` (execution_kind, program, backend usato, status, reason).
- **Env sanitization**: `SAFE_ENV_KEYS` whitelist — solo variabili sicure vengono passate al subprocess.
- **Edge case**: backend non disponibile → fallback a `none` con log; Docker non avviato → errore o fallback; Bubblewrap non installato → fallback.

### Dettagli Tecnici

- **File**: `src/tools/sandbox/mod.rs` (orchestratore), `backends/` (implementazioni), `resolve.rs` (selezione), `env.rs` (sanitizzazione), `events.rs` (logging), `types.rs` (tipi), `runtime_image.rs` (gestione immagine Docker)
- **Entry point principale**: `build_process_command(execution_kind, program, args, working_dir, extra_env, sanitize_env, sandbox) → Result<Command>`
- **Flusso**:
  1. `resolve_sandbox_backend(config)` → `ResolvedSandboxBackend`
  2. `build_command_for_backend(request, config, backend)` → `Command` tokio
  3. `log_sandbox_event(...)` — registra evento
- **Struct chiave**: `SandboxExecutionRequest { execution_kind, program, args, working_dir, extra_env, sanitize_env }`, `ResolvedSandboxBackend { None, Docker, LinuxNative, WindowsNative, MacosSeatbelt }`
- **Docker**: usa `docker run` con immagine configurabile, mount del workspace, network policy
- **LinuxNative (Bubblewrap)**: `bwrap` con bind mount read-only di `/usr`, `/lib`, ecc., working dir writable
- **macOS Seatbelt**: `sandbox-exec -p <profile>` con profilo generato dinamicamente
- **Windows Native**: Job Objects con limiti CPU/memoria via Win32 API
- **Tabelle DB**: `sandbox_events` (log eventi — append-only)
- **Endpoint API**: nessuno diretto; visibile via Web UI diagnostics

### Dipendenze

- **Da cosa dipende**: `crate::config::ExecutionSandboxConfig`, `tokio::process::Command`, `bubblewrap`/`sandbox-exec`/`docker` (runtime esterni)
- **Cosa dipende da questa feature**: `ShellTool` (usa `build_process_command`), skill runner, qualsiasi tool che esegue processi esterni

---

## Feature: Response Blocks

### Comportamento Atteso

- I `ResponseBlock` sono elementi UI ricchi che i tool possono restituire accanto all'output testuale per l'LLM.
- I client capaci (Flutter, Web UI) li renderizzano come card interattive; i canali senza supporto (Telegram, CLI) usano il markdown testuale come fallback.
- L'LLM non vede i blocchi — sono esclusivamente per l'interfaccia utente.
- **5 tipi di blocco**:

| Tipo | Uso | Interazione utente |
|---|---|---|
| `choice` | Scelta tra N opzioni (treni, voli, ristoranti) | Tap su un'opzione → risposta con `option_id` |
| `approval` | Approvazione/rifiuto di un'azione | Tap "Approva" o "Rifiuta" |
| `status` | Stato avanzamento (ordine, task) | Sola lettura |
| `result` | Risultato strutturato (carta d'imbarco, ricevuta) | Sola lettura |
| `external_message` | Anteprima messaggio esterno (email, notifica) | Sola lettura |

- **Blocchi inline**: l'LLM può includere blocchi nel proprio testo usando fence ` ```blocks ``` ` con JSON array — estratti da `extract_fence_blocks()`.
- **`BlockResponse`**: struttura inviata dal client quando l'utente interagisce con un blocco (campi: `block_id`, `option_id`, `action`, `metadata`).

### Dettagli Tecnici

- **File**: `src/tools/response_blocks.rs`
- **Enum principale**: `ResponseBlock` tagged union con `block_type` come discriminante JSON (`snake_case`)
- **Struct per tipo**:
  - `ChoiceBlock { id, title, subtitle?, options: Vec<BlockOption> }` — `BlockOption { id, label, subtitle?, icon?, metadata? }`
  - `ApprovalBlock { id, title, description?, approve_label, deny_label, metadata? }`
  - `StatusBlock { id, title, status: BlockStatus, fields: Vec<KeyValue> }` — `BlockStatus { Pending, Active, Completed, Failed }`
  - `ResultBlock { id, title, fields: Vec<KeyValue>, icon? }`
  - `ExternalMessageBlock { id, source, sender?, subject?, preview, metadata? }`
- **Shared**: `KeyValue { label, value }` per display campi strutturati
- **Funzione estrazione**: `extract_fence_blocks(text) → (String, Vec<ResponseBlock>)` — rimuove i fence dal testo, parsa i blocchi JSON, ignora silenziosamente JSON invalidi
- **Serializzazione**: `serde` con `#[serde(tag = "block_type", rename_all = "snake_case")]`
- **Tabelle DB**: nessuna (in-memory, per sessione/risposta)
- **Endpoint API**: inviati come campo aggiuntivo nella risposta del gateway; ricevuti come `block_response` nei messaggi inbound

### Dipendenze

- **Da cosa dipende**: `serde`, `serde_json`
- **Cosa dipende da questa feature**: `ToolResult` (campo `blocks`), Web UI/Flutter (rendering), `ApprovalManager` (blocco approval per approvazioni shell), gateway (serializzazione outbound), message ingestion (deserializzazione `BlockResponse` inbound)
