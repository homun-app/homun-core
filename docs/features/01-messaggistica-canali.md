# Dominio: Messaggistica e Canali

**Progetto:** Homun — AI assistant in Rust
**Data:** 2026-03-30
**Versione:** 1.0

---

## Panoramica

Il dominio "Messaggistica e Canali" gestisce l'intero ciclo di vita di un messaggio: ricezione da una piattaforma esterna, routing attraverso il Gateway, elaborazione da parte dell'AgentLoop, e restituzione della risposta al canale di origine.

L'architettura si basa su un **bus di messaggi** (coppie `mpsc` Tokio) e sul **trait `Channel`**, che ogni implementazione di canale deve rispettare. Il Gateway orchestra tutti i canali attivi, il debouncing, l'autenticazione e il dispatch verso l'agente.

```
Telegram ─┐
CLI ───────┤──→ InboundMessage ──→ Gateway ──→ AgentLoop ──→ OutboundMessage ──→ Channel
Email ─────┤
Discord ───┘
```

---

## Feature 1 — Gateway (routing messaggi in ingresso/uscita)

### Comportamento Atteso

- L'utente finale non interagisce direttamente con il Gateway; lo percepisce come la "mente" che smista i messaggi verso l'agente e restituisce le risposte al canale corretto.
- **Input:** `InboundMessage` proveniente da qualsiasi canale attivo.
- **Output:** `OutboundMessage` instradato verso il canale e la chat di origine.
- **Stati:**
  - *Avvio:* spawn di tutti i canali configurati, ciascuno con un proprio `JoinHandle` e un `outbound_tx` stabile nella routing table.
  - *Running:* loop selettivo su `inbound_rx`, `cron_event_rx`, `workflow_event_rx`, `tool_message_rx`.
  - *Errore canale:* restart automatico con backoff esponenziale fino a `MAX_CHANNEL_RESTARTS = 10`.
  - *Shutdown:* uscita pulita quando tutti i sender vengono droppati.
- **Edge case e limiti:**
  - Se un canale crasha, la routing table mantiene il suo `outbound_tx` stabile; un relay task fa da ponte verso la nuova istanza del canale riavviato.
  - Superati i 10 restart, il canale viene abbandonato e loggato come errore permanente.
  - I messaggi in arrivo per sessioni non autorizzate vengono scartati o indirizzati al flusso OTP (pairing).

### Dettagli Tecnici

- **File:** `src/agent/gateway.rs`
- **Struttura principale:** `Gateway` — contiene `AgentRegistry`, `Config` (Arc<RwLock>), `CronScheduler`, handle opzionali per web-ui, workflow engine, business engine.
- **Flusso dati:**
  1. Ogni canale viene avvolto in `spawn_monitored_channel`, che crea un `ChannelHandle` con `outbound_tx` stabile.
  2. Il Gateway tiene una `SharedOutboundSenders` (`Arc<RwLock<Vec<(String, Sender<OutboundMessage>)>>>`).
  3. I messaggi inbound vengono pre-processati (auth, debounce, routing email/approval) e trasformati in `PreparedMessage`.
  4. Il `MessageDebouncer` aggrega burst e chiama il dispatcher.
  5. Il dispatcher invoca `AgentLoop::process_message` e scrive la risposta in `outbound_tx`.
- **Tabelle DB:** `contacts`, `contact_identities`, `automations`, `email_pending`, `web_chat_runs`.
- **Endpoint API:** nessuno diretto; il Gateway è interno. Le API REST sono esposte dal `WebServer`.

### Dipendenze

- **Dipende da:** `Channel` trait, `AgentLoop`, `MessageDebouncer`, `auth::check_authorization`, `CronScheduler`, `WorkflowEngine`, `SessionManager`, `Database`.
- **Dipendono da questa feature:** tutti i canali (ricevono i loro `outbound_rx` dal Gateway), `WebServer` (riceve `web_stream_tx`), automazioni e workflow.

---

## Feature 2 — Canale CLI (REPL interattivo + one-shot)

### Comportamento Atteso

- **One-shot:** l'utente lancia `homun "<messaggio>"` da terminale; riceve la risposta e il processo termina.
- **Interattivo (REPL):** l'utente lancia `homun` senza argomenti; viene presentato un prompt `you>`. Digita messaggi, riceve risposte `homun>`. Comandi speciali:
  - `/new` — azzera la cronologia della sessione.
  - `/quit`, `/exit`, `exit`, `quit`, `:q` — esce dal REPL.
  - `Ctrl+D` (EOF) — esce pulitamente.
- **Input:** testo libero da stdin.
- **Output:** testo su stdout.
- **Stati:**
  - *Vuoto:* input vuoto ignorato, il prompt viene ristampato.
  - *Processing:* il messaggio viene inviato ad `AgentLoop`; non c'è indicatore di caricamento visuale.
  - *Errore:* stampa `[error] <messaggio>` e continua il loop.
  - *Successo:* stampa la risposta dell'agente.
- **Edge case e limiti:**
  - Nessun supporto per allegati (capability `inbound_attachments: false`).
  - Nessun markdown rendering nel terminale (capability `markdown_support: false`).
  - Session key fissa: `"cli:default"`.
  - Non supporta invio proattivo (`proactive_send: false`).

### Dettagli Tecnici

- **File:** `src/channels/cli.rs`
- **Struttura:** `CliChannel { agent: AgentLoop, session_manager: SessionManager, session_key: String }`
- **Flusso dati:**
  - `one_shot`: chiama direttamente `agent.process_message(message, "cli:default", "cli", "local")`.
  - `interactive`: loop stdin → `process_message` → stdout. Non usa il bus `InboundMessage`/`OutboundMessage` — bypass diretto ad `AgentLoop`.
- **Tabelle DB:** `sessions` (via `SessionManager`).
- **Endpoint API:** nessuno.

### Dipendenze

- **Dipende da:** `AgentLoop`, `SessionManager`.
- **Dipendono da questa feature:** nessuno (entry point terminale).

---

## Feature 3 — Canale Telegram (long polling, media, sticker, comandi)

### Comportamento Atteso

- Il bot Telegram riceve messaggi da utenti (DM e gruppi) tramite long polling con timeout di 60 secondi.
- Supporta testo, didascalie, documenti allegati.
- In modalità gruppo, se `mention_required = true`, processa solo i messaggi che menzionano il bot.
- Invia l'indicatore "sta scrivendo..." (`ChatAction::Typing`) mentre l'agente elabora.
- Risponde in Markdown (`ParseMode::MarkdownV2`).
- **Input:** `Message` Telegram (testo, documento, caption).
- **Output:** risposta testuale, eventualmente con allegati.
- **Stati:**
  - *Poll timeout:* normale, si ritenta immediatamente.
  - *Errore di rete:* backoff di 5 secondi, poi si ritenta.
  - *Documento scaricato:* path locale salvato in `attachment_path` del metadata.
  - *Errore download:* warn loggato, il messaggio viene comunque processato senza allegato.
- **Edge case e limiti:**
  - Gli sticker vengono ricevuti come `Message` ma non hanno testo — vengono scartati se non c'è caption.
  - Il `bot_username` viene ottenuto all'avvio con `get_me()`; cambiamenti successivi richiedono restart.
  - `mention_required` si applica solo nei gruppi (chat di tipo non-privato).
  - Autenticazione delegata al Gateway (`sender_id` = Telegram user ID).

### Dettagli Tecnici

- **File:** `src/channels/telegram.rs`
- **Crate:** `frankenstein` (client reqwest async).
- **Struttura:** `TelegramChannel { config: TelegramConfig }`, `BotContext { mention_required, bot_id, bot_username, token }`.
- **Flusso dati:**
  1. `start()` avvia il long-polling loop e uno spawn separato per il loop outbound.
  2. `handle_message()` estrae `sender_id`, `chat_id`, testo/caption, scarica eventuali documenti.
  3. Costruisce `InboundMessage` con `MessageMetadata { attachment_path }` e lo invia su `inbound_tx`.
  4. Il loop outbound riceve `OutboundMessage` e chiama `send_message` / `send_document`.
- **Tabelle DB:** nessuna diretta (la gestione sessioni è nel Gateway/SessionManager).
- **Endpoint API:** Telegram Bot API (`getUpdates`, `sendMessage`, `sendChatAction`, `getFile`).

### Dipendenze

- **Dipende da:** `frankenstein`, `TelegramConfig`, `InboundMessage`/`OutboundMessage` bus, Gateway (per auth e routing).
- **Dipendono da questa feature:** Gateway (riceve `InboundMessage`), canale attachment routing.

---

## Feature 4 — Canale Email (IMAP polling + SMTP reply, threading)

### Comportamento Atteso

- Supporta più account email, ognuno con la propria configurazione IMAP/SMTP.
- Polling IMAP con IDLE per ricezione messaggi in tempo (quasi) reale.
- Risponde via SMTP mantenendo il threading email (`In-Reply-To`, `References`).
- Tre modalità operative per account:
  - `assisted` (default): l'agente genera una bozza che richiede approvazione umana prima dell'invio.
  - `automatic`: l'agente risponde direttamente senza approvazione.
  - `on_demand`: l'agente elabora solo se esplicitamente richiesto.
- Filtri mittenti:
  - `allow_from`: whitelist di indirizzi o domini (es. `@example.com`).
  - Indirizzi noreply/mailer-daemon vengono ignorati silenziosamente.
- **Input:** email in arrivo su casella IMAP.
- **Output:** email di risposta via SMTP.
- **Stati:**
  - *IMAP IDLE attivo:* attesa push notifiche dal server.
  - *Nuovo messaggio:* parse, filtraggio mittente, inoltro al Gateway.
  - *Modalità assisted:* salvataggio in `email_pending`, notifica su canale di approvazione configurato.
  - *Errore IMAP:* reconnect con backoff.
  - *Errore SMTP:* log errore, risposta non inviata.
- **Edge case e limiti:**
  - Il canale email usa il prefisso `email:<nome_account>` come identificatore (es. `email:lavoro`). `capabilities_for` normalizza strippando il prefisso.
  - Le password possono essere cifrate nel vault (`***ENCRYPTED***`); vengono risolte a runtime via `storage::global_secrets()`.
  - L'HTML nelle email viene strippato prima di essere passato all'agente.
  - Gli allegati email vengono scaricati nel filesystem locale e passati come `attachment_path`.

### Dettagli Tecnici

- **File:** `src/channels/email.rs`
- **Crate:** `async-imap`, `lettre`, `mail-parser`, `tokio-rustls`.
- **Struttura:** `EmailChannel { accounts: HashMap<String, EmailAccountConfig> }`, `ParsedEmail { uid, from, subject, body_text, message_id, attachment_path }`.
- **Flusso dati:**
  1. Per ogni account, spawn di un task IMAP IDLE.
  2. Alla ricezione di un messaggio: parse con `mail-parser`, download allegati, filtro mittente.
  3. `InboundMessage` inviato su `inbound_tx` con metadata email (`email_account`, `email_mode`, `email_subject`, `email_message_id`).
  4. Per modalità `assisted`: salvataggio in tabella `email_pending`, invio notifica di approvazione.
  5. Risposta outbound: costruzione `Message` lettre con `In-Reply-To`, invio via `SmtpTransport`.
- **Tabelle DB:** `email_pending` (bozze in attesa di approvazione).
- **Endpoint API:** IMAP (porta 993 TLS), SMTP (porta 587 STARTTLS o 465 TLS).

### Dipendenze

- **Dipende da:** `async-imap`, `lettre`, `EmailAccountConfig`, `storage::global_secrets`, Gateway (auth, email approval handler).
- **Dipendono da questa feature:** `EmailApprovalHandler`, Gateway routing, canale attachment routing.

---

## Feature 5 — Canale Discord (Serenity, slash commands, attachments)

### Comportamento Atteso

- Bot Discord che ascolta messaggi in canali di testo (guild) e DM.
- Se `mention_required = true`, processa solo i messaggi che menzionano il bot.
- Supporta attachments in ingresso e uscita.
- Supporta thread (`thread_scope: true`) — i messaggi all'interno di un thread vengono risposti nello stesso thread.
- Indica che sta scrivendo durante l'elaborazione (`typing_state: true`).
- Se `default_channel_id` non è configurato, il messaging proattivo è disabilitato.
- **Input:** `Message` Discord (testo + eventuali allegati).
- **Output:** risposta testuale nel canale/thread di origine.
- **Stati:**
  - *Ready:* bot connesso, `bot_user_id` memorizzato.
  - *Messaggio ricevuto:* filtro mention, filtro allow_from, inoltro al Gateway.
  - *Errore client:* loggato, il task termina (riavvio gestito dal Gateway).
- **Edge case e limiti:**
  - `bot_user_id` viene popolato in modo atomico (`AtomicU64`) all'evento `on_ready`.
  - I messaggi del bot stesso vengono ignorati (check su `author.id == bot_user_id`).
  - `OutboundRxKey` in TypeMap di Serenity: il receiver outbound viene estratto e mosso nell'handler `on_ready` per avviare il loop outbound.
  - Allegati in uscita: supportati via `ChannelId::send_files`.

### Dettagli Tecnici

- **File:** `src/channels/discord.rs`
- **Crate:** `serenity`.
- **Struttura:** `DiscordChannel { config: DiscordConfig, health: Option<Arc<ChannelHealthTracker>> }`, `Handler { inbound_tx, mention_required, bot_user_id: Arc<AtomicU64>, health }`.
- **Gateway Intents:** `GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT`.
- **Flusso dati:**
  1. `start()` crea il client Serenity con `Handler` come event handler.
  2. Inserisce `outbound_rx` nel TypeMap.
  3. `on_ready`: estrae `outbound_rx`, spawna loop outbound, registra `bot_user_id`.
  4. `on_message`: filtri → costruisce `InboundMessage` (con `thread_id` se in un thread) → `inbound_tx.send`.
  5. Loop outbound: riceve `OutboundMessage`, invia con `ChannelId::say` o nel thread specificato da `metadata.thread_id`.
- **Tabelle DB:** nessuna diretta.
- **Endpoint API:** Discord Gateway WebSocket (gestito da Serenity), Discord REST API.

### Dipendenze

- **Dipende da:** `serenity`, `DiscordConfig`, `ChannelHealthTracker`, Gateway.
- **Dipendono da questa feature:** Gateway (inbound routing), canale thread_scope.

---

## Feature 6 — Canale Slack (Socket Mode)

### Comportamento Atteso

- Bot Slack che riceve messaggi via Socket Mode WebSocket (latenza <100ms) se `app_token` è configurato; altrimenti polling `conversations.history` ogni 3 secondi.
- Se `mention_required = true`, processa solo i messaggi con `<@BOT_USER_ID>` nel testo; la mention viene strippata prima di passare il testo all'agente.
- Supporta thread (`thread_scope: true`) tramite `thread_ts`.
- Supporta gruppi e DM.
- **Input:** evento Slack `message` (testo; allegati in ingresso non supportati nella capability attuale).
- **Output:** risposta testuale via `chat.postMessage` (con `thread_ts` se in thread).
- **Stati:**
  - *Socket Mode attivo:* WebSocket connesso, riceve eventi push.
  - *Fallback polling:* richieste HTTP periodiche a `conversations.history`.
  - *Errore WebSocket:* riconnessione con backoff.
  - *Messaggio del bot ignorato:* self-messages filtrati via `bot_user_id` da `auth.test`.
- **Edge case e limiti:**
  - `inbound_attachments: false` nella capability (gli allegati in ingresso non sono gestiti).
  - `outbound_attachments: false`.
  - `typing_state: false` — Slack non ha un'API equivalente a "typing" per le app bot.
  - L'`app_token` deve avere scope `connections:write` per Socket Mode.

### Dettagli Tecnici

- **File:** `src/channels/slack.rs`
- **Crate:** `tokio-tungstenite`, `reqwest`, `serde_json`.
- **Struttura:** `SlackChannel { config: SlackConfig, client: reqwest::Client }`.
- **Flusso dati (Socket Mode):**
  1. `open_socket_mode_url()` chiama `apps.connections.open` con `app_token`.
  2. Connessione WebSocket alla URL restituita.
  3. Loop receive: parse eventi JSON → filtro tipo `message` → `normalize_content` → `InboundMessage`.
  4. Acknowledge degli eventi con `{"envelope_id": "...", "payload": {"type": "ack"}}`.
  5. Loop outbound: `chat.postMessage` con `token` (bot token) e opzionale `thread_ts`.
- **Tabelle DB:** nessuna diretta.
- **Endpoint API:** `slack.com/api/apps.connections.open`, `slack.com/api/auth.test`, `slack.com/api/chat.postMessage`, `slack.com/api/conversations.history` (fallback).

### Dipendenze

- **Dipende da:** `tokio-tungstenite`, `reqwest`, `SlackConfig`, Gateway.
- **Dipendono da questa feature:** Gateway (inbound routing).

---

## Feature 7 — Canale WhatsApp (wa-rs native)

### Comportamento Atteso

- Client WhatsApp nativo in Rust tramite `wa-rs` (WhatsApp Web protocol diretto, senza Node.js).
- Il pairing del dispositivo avviene **esclusivamente** dalla TUI (`homun config`, tab WhatsApp). Il Gateway si limita a riconnettersi usando una sessione esistente.
- Se il file SQLite di sessione non esiste, il canale logga un warning e termina senza errore.
- Riconnessione automatica con backoff esponenziale (2s → 4s → ... → 120s cap); il backoff si azzera dopo una connessione stabile.
- **Grace period:** i messaggi ricevuti nei primi 10 secondi dopo la connessione vengono ignorati (previene risposte a messaggi in coda offline).
- Traccia gli ID dei messaggi inviati (fino a 500) per evitare echo-loop.
- Supporta gruppi e DM, allegati in/out, mention policy.
- **Input:** evento WhatsApp `Message` (testo, media).
- **Output:** messaggio testuale o media via `wa-rs`.
- **Stati:**
  - *Non accoppiato:* nessun DB di sessione → warning + uscita pulita.
  - *Connessione in corso:* grace period attivo.
  - *Connesso:* ricezione eventi.
  - *Disconnesso/errore:* backoff + riconnessione.
- **Edge case e limiti:**
  - `markdown_support: false` — WhatsApp usa un formato di formattazione proprietario (*grassetto*, _corsivo_, ~barrato~), non Markdown standard.
  - Il `phone_number` configurato è necessario per il messaging proattivo; senza di esso, Homun può solo rispondere.

### Dettagli Tecnici

- **File:** `src/channels/whatsapp.rs`
- **Crate:** `wa-rs`, `wa-rs-core`, `wa-rs-tokio-transport`, `wa-rs-ureq-http`.
- **Struttura:** `WhatsAppChannel { config: WhatsAppConfig }`.
- **Storage sessione:** SQLite locale (`config.resolved_db_path()`), gestito da `wa_rs::store::SqliteStore`.
- **Flusso dati:**
  1. Check esistenza DB sessione.
  2. `Bot::new(store, transport_factory, http_client)`.
  3. Loop eventi: `Event::Message` → filtri (grace period, self-message, sent-ids) → `InboundMessage` → `inbound_tx`.
  4. Loop outbound: `OutboundMessage` → `bot.send_message(chat_id, content)`.
  5. Gestione `Event::Disconnected`: break del loop interno → backoff → nuova iterazione.
- **Tabelle DB:** SQLite esterno (`whatsapp_session.db`) gestito da `wa-rs`.
- **Endpoint API:** WhatsApp Web WebSocket (diretto, no API ufficiale).

### Dipendenze

- **Dipende da:** `wa-rs`, `WhatsAppConfig`, Gateway.
- **Dipendono da questa feature:** Gateway (inbound routing), TUI (pairing).

---

## Feature 8 — Canale Web (WebSocket in web/ws.rs)

### Comportamento Atteso

- Interfaccia chat WebSocket per la Web UI di Homun.
- L'utente si connette a `GET /ws/chat?conversation_id=<id>` dal browser.
- Alla connessione, riceve un messaggio `{"type": "connected", "session_id": ..., "conversation_id": ...}`.
- Invia messaggi in formato JSON; riceve risposte in streaming (delta per delta) e poi il messaggio completo.
- Supporta streaming di tool call events (`tool_start`, `tool_end`).
- **Input:** messaggio JSON dal browser via WebSocket.
- **Output:** stream di delta JSON + messaggio finale.
- **Stati:**
  - *Connesso:* registrazione in `ws_sessions` e `stream_sessions`.
  - *Messaggio ricevuto:* costruzione `InboundMessage` con `web_run_id`, inoltro al Gateway.
  - *Streaming:* il Gateway invia `StreamMessage` su `web_stream_tx`; il handler WS li forwarda al client.
  - *Disconnessione:* rimozione da `ws_sessions` e `stream_sessions`.
- **Edge case e limiti:**
  - Richiede autenticazione (`check_write(&auth)`); restituisce `403` se non autorizzato.
  - Se `conversation_id` non è specificato, viene usato l'ID di default per l'utente autenticato.
  - `outbound_attachments: false` (la Web UI non supporta download di file via WS al momento).
  - I messaggi Web bypassano il debounce (presenza di `web_run_id` nel metadata).

### Dettagli Tecnici

- **File:** `src/web/ws.rs`
- **Crate:** `axum` (WebSocket upgrade), `tokio::sync::mpsc`.
- **Struttura:** handler `ws_handler` → `handle_socket(socket, state, conversation_id)`.
- **AppState condiviso:** `ws_sessions: RwLock<HashMap<String, Sender<String>>>`, `stream_sessions: RwLock<HashMap<String, Sender<WsStreamEvent>>>`.
- **Flusso dati:**
  1. HTTP upgrade → `handle_socket`.
  2. Registrazione session in `ws_sessions` e `stream_sessions`.
  3. Task receive: messaggi dal client → `InboundMessage { channel: "web", metadata: { web_run_id } }` → `inbound_tx` del Gateway.
  4. Task send: riceve da `response_rx` (risposta completa) e `stream_rx` (delta streaming) → JSON → WebSocket.
  5. Alla chiusura: deregistrazione dalla mappa sessioni.
- **Tabelle DB:** `web_chat_runs` (snapshot persistiti), `conversations`.
- **Endpoint API:** `GET /ws/chat?conversation_id=<id>` (WebSocket upgrade).

### Dipendenze

- **Dipende da:** `axum`, `AppState`, `WebServer`, Gateway (`web_stream_tx`), sistema di autenticazione web.
- **Dipendono da questa feature:** Web UI browser client.

---

## Feature 9 — Debouncing messaggi (accumulo burst di testo brevi)

### Comportamento Atteso

- Quando un utente invia più messaggi brevi in rapida successione (burst), il sistema li aggrega in un unico messaggio prima di passarli all'agente.
- Evita chiamate LLM multiple per frammenti della stessa frase ("ciao" + "come stai?" → unico messaggio aggregato).
- Configurabile: `window_ms` (durata finestra di attesa) e `max_batch` (numero massimo messaggi prima del flush forzato).
- Se `window_ms = 0`, il debounce è disabilitato e tutti i messaggi vengono forwardati immediatamente.
- **Messaggi che bypassano il debounce:**
  - Messaggi di sistema (`is_system = true`: scheduler, automazioni, cron).
  - Messaggi con allegato (`attachment_path` presente): l'ingestion RAG è già avvenuta.
  - Messaggi con `web_run_id`: invio esplicito dalla Web UI.
- **Aggregazione:**
  - I contenuti vengono uniti con `\n`.
  - Il `thinking_override` dell'ultimo messaggio prevale.
  - Il `thread_id` del primo messaggio disponibile viene mantenuto.
  - Il timestamp dell'ultimo messaggio viene usato.
- **Serializzazione per sessione:** un `Mutex` per `session_key` garantisce che un solo task di elaborazione sia attivo per sessione.

### Dettagli Tecnici

- **File:** `src/agent/debounce.rs`
- **Strutture:** `DebounceConfig { window, max_batch }`, `MessageDebouncer { config, rx }`, `SessionBuffer { messages, first_arrival }`, `PreparedMessage`, `DispatchContext`.
- **Flusso dati:**
  1. Il Gateway invia `PreparedMessage` al canale del debouncer.
  2. `MessageDebouncer::run(dispatch)` — loop `tokio::select!` con tick ogni 100ms.
  3. Per ogni messaggio: `should_skip_debounce` → dispatch immediato oppure inserimento in `SessionBuffer`.
  4. Tick: controlla buffer scaduti (età > `window`) → `aggregate` → `dispatch`.
  5. `max_batch` raggiunto → `aggregate` → `dispatch` forzato.
- **Tabelle DB:** nessuna.
- **Endpoint API:** nessuno.

### Dipendenze

- **Dipende da:** `InboundMessage`, `MessageMetadata`, `tokio::sync::mpsc`, `tokio::time`.
- **Dipendono da questa feature:** Gateway (usa `MessageDebouncer` per preparare i messaggi verso `AgentLoop`).

---

## Feature 10 — Autenticazione canale (auth.rs, pairing, whitelist)

### Comportamento Atteso

- Ogni messaggio inbound passa per `check_authorization` nel Gateway prima di raggiungere l'agente.
- I canali sono **transport-only**: non filtrano i mittenti, delegano tutto al Gateway.
- Pipeline di autorizzazione:
  1. Il `sender_id` è nella `allow_from` statica? → **Authorized**.
  2. Per canali email: il dominio del mittente corrisponde a una entry `@dominio.com`? → **Authorized**.
  3. Il `sender_id` è presente nel DB contatti (lookup live)? → **Authorized**.
  4. Mittente sconosciuto + `pairing_required = true` → **NeedsPairing** (flow OTP).
  5. Mittente sconosciuto + `pairing_required = false` → **Rejected** (messaggio scartato).
- **Pairing OTP:** quando `NeedsPairing`, il Gateway avvia il flusso di pairing tramite `PairingManager`: genera un codice OTP, lo invia al mittente, attende la conferma.
- **Whitelist dinamica:** i contatti aggiunti dopo l'avvio del Gateway vengono trovati tramite lookup live sul DB (step 3), senza necessità di restart.

### Dettagli Tecnici

- **File:** `src/agent/auth.rs`
- **Funzione principale:** `check_authorization(db, channel, sender_id, allow_from, pairing_required) -> AuthDecision`.
- **Enum:** `AuthDecision { Authorized, NeedsPairing, Rejected }`.
- **Normalizzazione canale email:** `"email:lavoro"` viene trattato come `"email"` per il lookup DB.
- **Lookup DB:** `db.find_contact_by_identity(channel_key, sender_id)`.
- **Tabelle DB:** `contacts`, `contact_identities`.
- **Endpoint API:** nessuno diretto.

### Dipendenze

- **Dipende da:** `Database`, `PairingManager`, configurazione `allow_from` e `pairing_required`.
- **Dipendono da questa feature:** Gateway (chiama `check_authorization` per ogni `InboundMessage`), sistema contatti.

---

## Feature 11 — Response Modes e Capabilities Canale

### Comportamento Atteso

- Ogni canale dichiara staticamente le proprie capacità di formattazione tramite `ChannelCapabilities`.
- L'agente adatta il formato della risposta in base alle capability del canale di destinazione.
- Il sistema costruisce un blocco del system prompt (`### Channel Capabilities`) che informa l'LLM su cosa ogni canale supporta.
- **Modalità supportate per canale:**
  - `markdown_support: true` → Telegram, Discord, Slack, Email, Web: l'agente può usare Markdown/HTML/mrkdwn.
  - `markdown_support: false` → CLI, WhatsApp: l'agente deve rispondere in testo piano.
- **Response mode per contatto:** il `DispatchContext` porta un `contact_response_mode` opzionale che può sovrascrivere il default del canale (es. risposta sempre in testo piano per un contatto specifico).
- **Modalità email speciali:** `assisted`, `automatic`, `on_demand` (vedi Feature 4).

### Dettagli Tecnici

- **File:** `src/channels/capabilities.rs`
- **Struttura:** `ChannelCapabilities` (12 campi bool).
- **Funzioni:**
  - `capabilities_for(channel_name) -> ChannelCapabilities`: restituisce le capability statiche per nome canale. Normalizza il prefisso `email:<account>`.
  - `build_capabilities_prompt(channels: &[&str]) -> String`: costruisce il blocco system prompt per l'LLM.
  - `ChannelCapabilities::summary() -> String`: stringa leggibile delle capability abilitate.
- **Tabelle DB:** nessuna.
- **Endpoint API:** nessuno.

### Dipendenze

- **Dipende da:** nessuna dipendenza esterna (modulo puro, solo logica statica).
- **Dipendono da questa feature:** Gateway (usa `build_capabilities_prompt` per il system prompt), `AgentLoop` (decide la formattazione), `DispatchContext` (porta `contact_response_mode`).

---

## Feature 12 — Attachment Routing (media, immagini, file)

### Comportamento Atteso

- Quando un utente invia un file/immagine tramite un canale che supporta `inbound_attachments`, il canale scarica il file localmente e imposta `attachment_path` nel `MessageMetadata`.
- Il Gateway riconosce la presenza di `attachment_path` e:
  1. Bypassa il debounce (il file è già stato scaricato, la risposta deve essere immediata).
  2. Indirizza il file al motore RAG (`RagEngine::ingest_file()`) per indicizzazione.
  3. Passa il path all'agente nel contesto del messaggio.
- In uscita, i canali con `outbound_attachments: true` possono inviare file allegati alla risposta.
- **Canali con `inbound_attachments: true`:** Telegram, Discord, WhatsApp, Email, Web.
- **Canali con `outbound_attachments: true`:** Telegram, Discord, WhatsApp, Email.
- **Edge case e limiti:**
  - CLI: nessun supporto allegati in/out.
  - Slack: nessun supporto allegati in/out (nella capability attuale).
  - Web: allegati in ingresso supportati; allegati in uscita non supportati.
  - Se il download del file fallisce (es. Telegram), il messaggio viene processato senza allegato e il Gateway logga un warning.
  - Il path del file scaricato è temporaneo; la responsabilità della pulizia è del componente che lo consuma (RAG engine o agent context).

### Dettagli Tecnici

- **File coinvolti:** `src/channels/telegram.rs`, `src/channels/email.rs`, `src/channels/discord.rs`, `src/channels/whatsapp.rs`, `src/agent/debounce.rs` (`should_skip_debounce`), `src/bus/queue.rs` (`MessageMetadata.attachment_path`).
- **Flusso dati:**
  1. Canale riceve messaggio con media → download su filesystem locale → path in `MessageMetadata.attachment_path`.
  2. `InboundMessage` con metadata → Gateway.
  3. Gateway: `should_skip_debounce` → true (bypass debounce).
  4. Gateway: `RagEngine::ingest_file(path)` → indicizzazione.
  5. `AgentLoop` riceve il messaggio con il path disponibile nel contesto.
  6. Risposta outbound: se il canale supporta `outbound_attachments`, il loop outbound invia il file allegato.
- **Tabelle DB:** RAG index (vettori embeddings), `rag_sources`, `rag_chunks`.
- **Endpoint API:** dipende dal canale (es. `api.telegram.org/file/bot<token>/<path>`).

### Dipendenze

- **Dipende da:** singoli canali (download), `MessageMetadata.attachment_path`, `RagEngine`, `should_skip_debounce`.
- **Dipendono da questa feature:** `AgentLoop` (usa il path per il contesto), RAG engine (indicizzazione documenti).

---

## Tabella Riepilogativa Capability Canali

| Canale    | Text In | Text Out | Attach In | Attach Out | Proactive | Gruppi | DM  | Thread | Mention | Typing | Markdown |
|-----------|---------|----------|-----------|------------|-----------|--------|-----|--------|---------|--------|----------|
| CLI       | si      | si       | no        | no         | no        | no     | si  | no     | no      | no     | no       |
| Telegram  | si      | si       | si        | si         | si        | si     | si  | no     | si      | si     | si       |
| Discord   | si      | si       | si        | si         | si        | si     | si  | si     | si      | si     | si       |
| Slack     | si      | si       | no        | no         | si        | si     | si  | si     | si      | no     | si       |
| WhatsApp  | si      | si       | si        | si         | si        | si     | si  | no     | si      | si     | no       |
| Email     | si      | si       | si        | si         | si        | no     | si  | si     | no      | no     | si       |
| Web       | si      | si       | si        | no         | si        | no     | si  | no     | no      | si     | si       |
