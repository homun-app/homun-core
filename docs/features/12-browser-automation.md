# Browser Automation

## Panoramica

Il sistema di browser automation di Homun consente all'agente di navigare il web, compilare form, fare screenshot e interagire con pagine complesse in modo autonomo. Si basa su un peer MCP persistente verso `@playwright/mcp`, con un unico tool unificato `browser` che espone 21 azioni. L'architettura include isolamento per sessione (tab per conversazione), memoria per-sito con fingerprinting strutturale, un guard unificato per loop detection / allowlist / rate limiting, e anti-bot stealth injection.

Configurazione minima in `config.toml`:

```toml
[browser]
enabled = true
headless = true
```

---

### 1. MCP Playwright Bridge

#### Comportamento Atteso

- Il bridge traduce la sezione `[browser]` del config in una `McpServerConfig` virtuale per `@playwright/mcp`, evitando all'utente di configurare manualmente `[mcp.servers.playwright]`.
- Il `BrowserPool` gestisce un peer MCP per profilo browser, avviato lazily al primo utilizzo. Il peer del profilo di default viene iniettato eagerly all'avvio del gateway via `set_default_peer()`.
- Il comando MCP generato e `npx -y @playwright/mcp@latest` con flag calcolati dal config: `--headless`, `--browser={type}`, `--user-data-dir={path}`, `--viewport-size={w},{h}`, `--executable-path={path}`, `--proxy-server={proxy}`.
- Viewport di default: 1280x720. Browser di default: chromium (il flag `--browser` viene omesso se chromium).
- La variabile d'ambiente `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` viene settata per usare il browser di sistema.
- All'avvio del gateway, `cleanup_orphan_playwright_processes()` cerca e uccide processi Playwright orfani dalla sessione precedente, identificandoli tramite il marker `.homun/browser-profiles` nella command line (solo Unix).
- Supporto multi-profilo: ogni profilo ha la propria directory `user-data-dir` per isolamento cookie/sessione. Override per-profilo di browser_type, headless, proxy, viewport.
- Switch runtime headless/visible: `restart_visible()` e `restart_headless()` riavviano il processo MCP con/senza `--headless`, preservando cookie e user data (stessa `user_data_dir`).

#### Dettagli Tecnici

- **Moduli**: `src/browser/mcp_bridge.rs`, `src/browser/mod.rs`
- **Struttura**: `BrowserPool` contiene `peers: RwLock<HashMap<String, Arc<McpPeer>>>`, `config: Arc<RwLock<Config>>`, `headless_overrides: RwLock<HashMap<String, bool>>`
- **Costante**: `BROWSER_MCP_SERVER_NAME = "playwright"` — i tool MCP vengono registrati come `playwright__browser_*`
- **Flusso dati**: `BrowserConfig` -> `browser_mcp_server_config_with_override()` -> `McpServerConfig` -> `McpManager::connect_peer()` -> `McpPeer`
- **Race condition**: `get_or_start()` usa double-check locking — se un altro task ha vinto la race, il peer duplicato viene fatto shutdown

#### Dipendenze

- Dipende da: `crate::tools::mcp::McpPeer`, `crate::config::BrowserConfig`, `@playwright/mcp` (npm)
- Dipendono da questo: `BrowserTool`, `BrowserSession`, agent loop (per peer swap durante show/hide)

---

### 2. Azioni Browser (21 azioni)

#### Comportamento Atteso

L'utente interagisce con un singolo tool `browser` passando un parametro `action`. Le 21 azioni disponibili:

| Azione | Parametri | Descrizione |
|--------|-----------|-------------|
| `navigate` | `url` | Naviga a URL, auto-snapshot dopo stabilizzazione |
| `snapshot` | - | Snapshot accessibilita compattato |
| `screenshot` | - | Screenshot analizzato da modello vision |
| `click` | `ref` | Click su elemento, auto-snapshot dopo 500ms |
| `type` | `ref`, `text` | Clear + type con `slowly: true`, detect autocomplete |
| `fill` | `ref`, `text` | Fill diretto via `browser_fill_form`, fallback a click+type |
| `fill_form` | `fields: [{ref, value}]` | Fill multiplo in una sola chiamata MCP |
| `select_option` | `ref`, `value` | Seleziona opzione da dropdown |
| `press_key` | `text` | Premi tasto (es. "Enter", "Tab") |
| `hover` | `ref` | Hover su elemento |
| `scroll` | `direction`, `amount`, `ref` (opt) | Scroll con PageUp/Down o Arrow, auto-snapshot |
| `drag` | `ref`, `end_ref` | Drag da un elemento a un altro |
| `click_coordinates` | `x`, `y` | Click a coordinate pixel (per canvas, SVG, CAPTCHA) |
| `hold_click` | `ref`/`x,y`, `duration_ms` | Press-and-hold per CAPTCHA PerimeterX (default 15s, max 30s) |
| `evaluate` | `expression` | Esegui JS (solo lettura, DOM manipulation bloccata) |
| `wait` | `seconds` | Attendi (max 30s) |
| `show` | - | Switch a modalita visibile (riavvia MCP senza --headless) |
| `hide` | - | Switch a modalita headless |
| `block_resources` | - | Blocca risorse non essenziali (immagini, font) |
| `unblock_resources` | - | Ripristina caricamento risorse |
| `close` | - | Chiudi il tab della conversazione corrente |

Parametro opzionale `profile` per tutte le azioni: se specificato, l'azione viene eseguita su un peer MCP dedicato al profilo (cookie/sessione isolati).

- **navigate**: inietta stealth scripts prima della prima navigazione, attende stabilizzazione pagina con `wait_for_stable_snapshot()`, annota ordine visuale dei form, detect elementi cursor-interactive senza ARIA, detect CAPTCHA e pagine errore.
- **type**: prima click + Ctrl+A per pulire il campo, poi type con `slowly: true` per triggerare autocomplete. Auto-snapshot dopo 500ms per rilevare dropdown suggerimenti.
- **fill**: usa `browser_fill_form` (1 chiamata MCP), con fallback a click+selectAll+type (3 chiamate) se fallisce.
- **evaluate**: blocca pattern DOM-manipolanti (`.click()`, `.focus()`, `.remove()`, `.innerHTML`, `scrollTo()`, ecc.). Output troncato a 2000 caratteri.
- **show/hide**: riavviano il processo MCP, rinavigano all'ultimo URL, re-iniettano stealth scripts.

#### Dettagli Tecnici

- **Modulo**: `src/tools/browser.rs` (~3500 righe, grandfathered)
- **Struct**: `BrowserTool` con `pool: Option<Arc<BrowserPool>>`, `stealth_injected: AtomicBool`, `session: Arc<BrowserSession>`, `tab_manager`, `operation_mutex`
- **Tool trait**: implementa `name()` -> `"browser"`, `description()`, `parameters()` (JSON Schema), `execute()`
- **Flusso execute**: `args.action` -> match -> `action_{name}()` -> `call_mcp_on_tab()` -> `McpPeer::call_tool()`
- **Concorrenza**: `operation_mutex` protegge la coppia atomica tab_select + action. Acquisito brevemente per ogni chiamata MCP, non per l'intero execute.
- **Consecutive snapshot guard**: `tab.last_was_snapshot` (AtomicBool) impedisce snapshot consecutivi senza azioni intermedie.

#### Dipendenze

- Dipende da: `BrowserPool`, `TabSessionManager`, `McpPeer`, `provider/one_shot.rs` (per vision), `BrowserSession`
- Dipendono da questo: agent loop (registra il tool), cognition (seleziona il tool)

---

### 3. Tab Session Management

#### Comportamento Atteso

- Ogni conversazione ottiene il proprio tab browser per isolamento. La chiave sessione e `"{channel}:{chat_id}"`.
- `TabSessionManager` mappa chiavi sessione a `TabSession`, gestendo il lifecycle dei tab: create, select, close, index adjustment.
- Alla prima azione browser di una conversazione, viene aperto un nuovo tab via `browser_tabs(new)`. Il tab index viene estratto dal response (`parse_new_tab_index`, prende l'indice piu alto).
- Alla chiusura di un tab, tutti gli indici superiori vengono decrementati (`adjust_indices_after_close`).
- L'ultimo tab non viene mai chiuso (Playwright richiede almeno un tab attivo).
- Tab idle vengono chiusi automaticamente dopo il timeout configurabile (default 300 secondi = 5 minuti, config `browser.idle_timeout_secs`).
- Continuation hint: se una conversazione ha un tab attivo con URL, viene generato un messaggio per l'LLM: "Browser is still open on: {url}".

#### Dettagli Tecnici

- **Modulo**: `src/browser/tab_session.rs`
- **Struct `TabSession`**: `tab_index: RwLock<Option<usize>>`, `last_url: RwLock<Option<String>>`, `last_action_at: RwLock<Option<Instant>>`, `last_was_snapshot: AtomicBool`
- **Struct `TabSessionManager`**: `sessions: RwLock<HashMap<String, Arc<TabSession>>>`
- **Struct `BrowserSession`** (in `tools/browser.rs`): wrapper thread-safe che espone `tab_manager`, `peer` (swappable), `operation_mutex`, `seen_results`, `pending_mode_switch`
- **Timeout check**: `is_idle(timeout: Duration)` confronta `last_action_at.elapsed()` con il timeout
- **Cleanup**: `close_idle_tabs()` invocato periodicamente dall'agent loop

#### Dipendenze

- Dipende da: `McpPeer` (per tab create/close via MCP)
- Dipendono da questo: `BrowserTool` (per isolamento per conversazione), agent loop (per cleanup e continuation hints)

---

### 4. Site Memory

#### Comportamento Atteso

- Memorizza conoscenza per-dominio in file markdown con YAML frontmatter, stessa struttura di `SKILL.md`.
- Path: `~/.homun/brain/sites/{domain}.md` (globale) o `~/.homun/brain/profiles/{profile}/sites/{domain}.md` (per-profilo). Il path per-profilo ha priorita.
- Contenuto memorizzato: `fingerprint` (SHA-256 troncato), `last_verified` (ISO 8601), `form_fields` (array di `{name, role, behavior}`), sezioni markdown "Navigation" e "User Preferences".
- **Fingerprinting strutturale**: hash SHA-256 (troncato a 16 hex chars / 64 bit) degli elementi interattivi della pagina (ruoli ARIA + nomi, ordinati). Insensibile a cambi di contenuto (prezzi, orari) — solo cambi strutturali (nuovi campi, rinominati) alterano il fingerprint.
- **Ruoli interattivi tracciati** (costante `INTERACTIVE_ROLES`): button, checkbox, combobox, link, listbox, menuitem, option, radio, searchbox, select, slider, spinbutton, switch, tab, textbox.
- **Invalidazione**: quando il fingerprint cambia, `invalidate_stale_sections()` cancella navigation notes e form_fields ma preserva user preferences.
- **Scoperta form fields** (`extract_form_fields()`): analizza lo snapshot per elementi form e inferisce il comportamento dal ruolo e dal nome:
  - combobox con "dat"/"date"/"when" -> `datepicker`, altrimenti `autocomplete`
  - checkbox/radio/switch -> `toggle`
  - slider/spinbutton -> `numeric`
  - searchbox -> `autocomplete`
  - textbox -> `free_text`
- **Context injection**: `format_memory_for_context()` produce un testo compatto con form fields, navigation notes e user preferences, iniettato nel prompt dell'agente.

#### Dettagli Tecnici

- **Modulo**: `src/browser/site_memory.rs`
- **Struct**: `SiteMemory` con domain, fingerprint, last_verified, form_fields, navigation_notes, user_preferences
- **Enum**: `FingerprintStatus` con varianti `Match`, `Changed{old, new}`, `NoFingerprint`
- **Parsing**: usa `gray_matter::Matter<YAML>` per frontmatter, stesso pattern di `skills/loader.rs`
- **I/O**: `load_site_memory()` / `save_site_memory()` — async, gestiscono creazione directory
- **Hashing**: `compute_structural_fingerprint()` usa `sha2::Sha256`, tronca a 8 byte (16 hex chars)

#### Dipendenze

- Dipende da: `gray_matter` (parsing), `sha2` (hashing), `chrono` (timestamp)
- Dipendono da questo: agent loop (per context injection), `BrowserTool` (per verifica fingerprint), API browser_sites (per lettura/cancellazione)

---

### 5. Browser Task Plan

#### Comportamento Atteso

- Guard unificato per tutte le decisioni sulle azioni browser: allowlist, mode switching, rate limiting, loop detection, retry budget.
- Inizializzato dal `CognitionResult` via `from_cognition()`. Classifica il task in 4 categorie:
  - `StaticLookup` — nessun tool browser richiesto
  - `InteractiveWeb` — navigazione interattiva generica
  - `FormBooking` — prenotazione/biglietti (keyword: book, prenot, ticket, bigliett)
  - `MultiSourceCompare` — confronto tra piu fonti (keyword: compar, confront nelle constraints)
- **Allowlist check** (`check_navigate()`): ogni navigazione viene verificata contro la cache `allowed_sites` (dominio -> modo). Siti non in lista producono `SiteNotAllowed` — l'agent loop invia un choice block all'utente. URL interni (`about:`, `chrome://`) sempre consentiti. Se l'allowlist non e ancora caricata dal DB, fail-open.
- **Mode switching**: se un sito ha modo `"visible"` e il browser e headless (o viceversa), `check_action()` restituisce `Allow { mode_switch: Some("visible") }`. L'agent loop esegue lo switch prima dell'azione.
- **Rate limiting**: rileva 429/rate limit nell'output del tool. Backoff esponenziale: `30s * 2^count` (min 60s, max 240s). Blocca azioni fino alla scadenza.
- **Retry budget**: per-ref, massimo 2 fallimenti per click. Dopo 2 timeout/errori sullo stesso ref, l'azione viene bloccata con suggerimento di usare screenshot o provare un elemento diverso.
- **Loop detection**: finestra scorrevole di 20 azioni recenti (`RECENT_ACTION_WINDOW = 20`). Conta azioni consecutive identiche (stessa action + stesso target + stesso output hash). Soglia: `LOOP_THRESHOLD = 6` azioni identiche.
  - **Action-aware cycle detection (2026-04)**: oltre al conteggio di azioni consecutive identiche, il detector rileva ora anche **pattern alternati A→B→A→B** e A→B→C→A→B→C nelle ultime N azioni — cattura i cicli reali in cui il modello rimbalza tra due stati (es. `click next` → `snapshot` → `click next` → `snapshot`), pattern che il match "consecutive identical" non vedeva. Integra quello che `IterationBudgetState` fa per i tool non-browser, ma qui operando sul dominio browser-specifico.
  - **Escalation**:
    - Livello 0 -> 1: "usa screenshot per diagnosticare" (blocca azioni interattive finche non viene fatto screenshot)
    - Livello 1 -> 2: auto-switch a modalita visibile (solo per siti in modo `"auto"`)
    - Livello 2 -> 3: give up — informa l'utente
  - **Distinzione loop reali vs ripetizioni legittime**: confronta anche l'hash dell'output (`hash_output_sample()`). Se l'output cambia (es. click "mese successivo" nel calendario, ogni volta mostra un mese diverso), nessuna escalation.
  - **Screenshot soddisfa il veto**: uno screenshot/snapshot a livello > 0 setta `veto_satisfied = true`, permettendo la prossima azione interattiva. Ma il livello NON si resetta — ulteriori azioni identiche continuano a escalare.
  - **Budget extension utente (2026-04)**: quando il livello raggiunge il limite, il tool emette un `ChoiceBlock` "Extend budget" / "Stop" che permette all'utente di concedere manualmente iterazioni aggiuntive senza abortire il task.
  - Navigate resetta il livello a 0 (nuova pagina = fresh start).
- **Azioni read-only** (snapshot, screenshot, wait, close): sempre permesse indipendentemente dallo stato.
- **Runtime message**: costruisce contesto per l'LLM con obiettivo, dominio corrente, e profilo utente compatto (sezioni Identity/Contacts da USER.md) per form filling.

#### Dettagli Tecnici

- **Modulo**: `src/agent/browser_task_plan.rs`
- **Struct**: `BrowserTaskPlanState` con ~15 campi di stato
- **Enum**: `BrowserActionDecision` con varianti `Allow{mode_switch}`, `Blocked{reason}`, `SiteNotAllowed{domain}`, `GiveUp`
- **Entry point**: `check_action(action, arguments)` — singolo punto di controllo, restituisce una decisione
- **Post-azione**: `note_result(action, output, arguments)` — aggiorna stato interno (loop detection, rate limit, failed refs, domain tracking)
- **Output hash**: `hash_output_sample()` usa `std::hash::DefaultHasher` su tutto l'output

#### Dipendenze

- Dipende da: `CognitionResult`, `action_policy::find_site_mode()`, `action_policy::extract_domain()`, `utils::text::truncate_str`
- Dipendono da questo: agent loop (invoca `check_action()` prima di ogni azione browser), `BrowserSession` (per mode switch pending)

---

### 6. Action Policy

#### Comportamento Atteso

- Sistema di regole allow/deny basate su categorie di azioni, configurabile in `BrowserPolicyConfig`.
- Ogni azione browser viene mappata a una categoria:
  - `navigate` -> "navigate"
  - `click`, `click_coordinates`, `hold_click` -> "click"
  - `type`, `fill`, `fill_form`, `select_option`, `press_key` -> "fill"
  - `snapshot`, `screenshot` -> "observe"
  - `hover`, `scroll`, `drag` -> "interact"
  - `evaluate` -> "eval"
  - `tab_list`, `tab_new`, `tab_select`, `tab_close` -> "tabs"
  - `block_resources`, `unblock_resources` -> "network"
  - `close`, `wait` -> "_internal" (sempre consentito)
- **Modalita**: `default = "allow"` (tutto consentito tranne deny list) o `default = "deny"` (tutto bloccato tranne allow list).
- **URL filtering**: `blocked_urls` (sempre bloccati, glob-style con `*.evil.com`) e `allowed_urls` (whitelist in deny mode).
- **Pattern matching URL**: `*.evil.com` matcha host che terminano con `.evil.com` o sono esattamente `evil.com`. Pattern senza wildcard -> substring match.
- **Utilities dominio**: `extract_domain(url)` estrae il dominio registrabile (strip www, gestisce TLD a 2 parti come `co.uk`, `com.au`). `url_matches_domain(url, domain)` verifica match esatto o sottodominio. `find_site_mode(url, allowlist)` cerca il modo rendering dall'allowlist cache.

#### Dettagli Tecnici

- **Modulo**: `src/browser/action_policy.rs`
- **Funzione principale**: `check_browser_policy(policy, action, args)` -> `Option<String>` (Some = deny con motivo, None = allow)
- **Funzione**: `action_category(action)` -> categoria statica
- **TLD a 2 parti gestiti**: co.uk, com.au, com.br, co.jp, co.kr, co.nz, co.za, com.ar, com.mx, com.tr, org.uk, net.au
- **Config struct**: `BrowserPolicyConfig` con `enabled`, `default`, `allow: Vec<String>`, `deny: Vec<String>`, `blocked_urls`, `allowed_urls`

#### Dipendenze

- Dipende da: `crate::config::BrowserPolicyConfig`
- Dipendono da questo: `BrowserTaskPlanState` (usa `find_site_mode()` e `extract_domain()`), agent loop (invoca `check_browser_policy()`)

---

### 7. CAPTCHA Handling

#### Comportamento Atteso

- Detection basata su vision: il modello vision analizza screenshot e identifica challenge visivamente, non tramite keyword matching.
- 4 tipi di CAPTCHA riconosciuti (`CaptchaKind`):
  - `HoldToVerify` — PerimeterX / HUMAN Security "press and hold". Recovery: `hold_click(ref, duration_ms=3000)` sul bottone.
  - `CloudflareTurnstile` — Cloudflare challenge. Recovery: `wait(seconds=5)` poi snapshot (spesso si auto-risolve con fingerprint browser corretto).
  - `VisualChallenge` — hCaptcha, reCAPTCHA con selezione immagini. Recovery: informa l'utente che deve completarlo manualmente.
  - `Blocked` — Rate limit / access denied. Recovery: attendere almeno 30 secondi.
- `captcha_hint(kind)` restituisce istruzioni actionable per l'agente.
- Detection aggiuntiva nello snapshot (`detect_captcha_sparse_page()`): su pagine con meno di 15 elementi interattivi, cerca segnali di CAPTCHA nell'albero accessibilita.
- **hold_click**: azione dedicata per CAPTCHA "hold to verify". Auto-detect del bottone PerimeterX via JS (cerca `#px-captcha`, class patterns, o div grandi clickabili centrati). Durata default 15s, max 30s. Dopo il rilascio attende 3s per il redirect, poi snapshot.
- **Vision prompt**: il prompt di `describe_screenshot()` include istruzioni specifiche per identificare e classificare CAPTCHA: CAPTCHA_HOLD, CAPTCHA_CHALLENGE, CAPTCHA_VISUAL, BLOCKED.

#### Dettagli Tecnici

- **Modulo**: `src/browser/captcha.rs` (tipi e hint), `src/tools/browser.rs` (action_hold_click, find_captcha_button, describe_screenshot)
- **Enum**: `CaptchaKind` con 4 varianti
- **JS detection** (in `find_captcha_button()`): 3 strategie — ID `px-captcha`, selettori pattern, euristica geometrica (div grande centrato con cursor:pointer o border)
- **Hold click flow**: `page.mouse.move(x,y)` -> `page.mouse.down()` -> `page.waitForTimeout(duration)` -> `page.mouse.up()` -> wait 3s -> snapshot

#### Dipendenze

- Dipende da: `McpPeer` (per JS evaluation e screenshot), `provider/one_shot.rs` (per vision model)
- Dipendono da questo: agent loop (usa i hint per guidare le azioni), `BrowserTool` (implementa le azioni)

---

### 8. Auto-Snapshot

#### Comportamento Atteso

- Dopo ogni azione interattiva (navigate, click, type, fill, fill_form, scroll), il tool prende automaticamente uno snapshot dell'albero accessibilita per fornire ref freschi al modello.
- **navigate**: attende stabilizzazione con `wait_for_stable_snapshot()`, poi snapshot compattato + annotazione form + cursor-interactive detection.
- **click**: attende 500ms per DOM settle, poi auto-snapshot con fresh refs. Rileva navigazione inattesa (redirect a pagina bianca o home).
- **type**: attende 500ms, auto-snapshot per rilevare dropdown autocomplete. Se trovati suggerimenti (`option "..." [ref=eN]`), li formatta come lista.
- **fill**: attende 300ms, auto-snapshot per verifica valore inserito.
- **fill_form**: attende 400ms, auto-snapshot per stato form aggiornato.
- **scroll**: attende 300ms, auto-snapshot per contenuto nuovo.
- **Auto visual check** (`auto_visual_check()`): dopo click e navigate, se un `vision_model` e configurato, prende uno screenshot e lo descrive brevemente (1-2 frasi, max 150 token) per dare al modello una vista "umana" della pagina.

#### Dettagli Tecnici

- **Modulo**: `src/tools/browser.rs` (metodi `action_*`)
- **`wait_for_stable_snapshot()`** (2026-04, perf tuning): finestra di attesa complessiva ridotta da **~13.5s a ~5.3s** per accelerare il loop su siti reattivi. Retry con delay crescenti più stretti; la soglia minima `MIN_INTERACTIVE = 5` elementi e il criterio di stabilità (count non cresce più o ultimo tentativo) restano invariati. La perf è misurabile sul loop browser "typico" — 5 step → ~40s di wait saved per task.
- **Guard consecutive snapshot**: `tab.last_was_snapshot` (AtomicBool) — impedisce snapshot consecutivi. Resettato da ogni azione non-snapshot.
- **Auto-snapshot path**: azioni interattive -> wait -> `call_mcp_on_tab("browser_snapshot")` -> `compact_browser_snapshot_staged()` -> append al risultato tool

#### Dipendenze

- Dipende da: `McpPeer`, `compact_browser_snapshot_staged()`, `provider/one_shot.rs` (per visual check)
- Dipendono da questo: agent loop (riceve snapshot nel tool result)

---

### 9. Snapshot Compaction

#### Comportamento Atteso

- Lo snapshot raw di Playwright puo essere molto grande (migliaia di righe). La compaction riduce drasticamente la dimensione mantenendo le informazioni rilevanti.
- **Algoritmo** (`compact_tree_lines()`): ispirato ad agent-browser (Vercel Labs):
  1. Mantiene linee con `[ref=` (elementi interattivi)
  2. Mantiene linee con valori (`": "` pattern — es. `textbox: "hello"`)
  3. Mantiene ruoli contenuto: heading, listitem, cell, gridcell, columnheader, rowheader, option
  4. Per ogni linea mantenuta, marca anche tutti gli antenati (walkback per indent decrescente) per preservare la gerarchia dell'albero
- **Output**: header (URL, titolo), sommario (`(N interactive elements)`), albero compattato, hint stage-aware.
- **Blank page detection**: se meno di 3 ref e meno di 200 chars, avviso "NEAR-BLANK PAGE".
- **CAPTCHA detection**: su pagine sparse (< 15 ref), `detect_captcha_in_sparse_page()` cerca segnali nell'albero completo.
- **Page stage hints**: `page_stage_hint()` classifica lo stadio della pagina (form, risultati, dettaglio) e suggerisce il prossimo step.
- **Limite output**: `HOMUN_BROWSER_MAX_OUTPUT` env var, default 80000 caratteri. Troncamento UTF-8 safe.
- **Supersession**: `supersede_stale_browser_context()` in `browser_context.rs` sostituisce tutti gli snapshot precedenti con un sommario di una riga `[Previous snapshot superseded — page: {url}, N interactive elements]`, mantenendo solo l'ultimo snapshot completo. Rimuove anche screenshot temporanei e policy follow-up stali.

#### Dettagli Tecnici

- **Moduli**: `src/tools/browser.rs` (funzioni `compact_*`), `src/agent/browser_context.rs` (supersession)
- **Funzioni chiave**:
  - `compact_browser_snapshot_staged(output, seen_results)` -> String compattata
  - `compact_tree_lines(lines)` -> albero filtrato
  - `compact_action_short(output, prefix)` -> conferma breve per azioni semplici
  - `tree_indent(line)` -> livello indent (2 spazi per livello)
  - `split_browser_output(output)` -> (header_lines, tree_lines)
  - `supersede_stale_browser_context(messages)` -> modifica in-place il vec di messaggi

#### Dipendenze

- Dipende da: `utils::text::truncate_utf8_in_place`
- Dipendono da questo: tutte le action_* del BrowserTool, agent loop (per context cleanup)

---

### 10. Allowed Sites (Whitelist)

#### Comportamento Atteso

- Tabella DB `browser_allowed_sites` controlla quali siti l'agente puo visitare autonomamente.
- Ogni entry ha: `domain` (PK), `mode` (headless/visible/auto), `added_by` (user/system/agent), `created_at`, `notes`.
- Siti non in tabella richiedono approvazione utente prima della navigazione (via choice block).
- **Seed di default** (migration): google.com, google.it, bing.com, duckduckgo.com, wikipedia.org, github.com — tutti in modo headless, aggiunti da "system".
- **Modi rendering**:
  - `headless` — browser invisibile, massima performance
  - `visible` — browser visibile su schermo (per siti con anti-bot aggressivo)
  - `auto` — parte headless, auto-switch a visible se loop detection rileva problemi
- **Approvazione mid-run**: quando l'utente approva un sito durante una sessione, `note_site_approved()` aggiorna la cache in-memory del `BrowserTaskPlanState`.
- **Normalizzazione dominio**: strip scheme, www., trailing slash, prendi solo l'host (prima di qualsiasi path), lowercase.
- **API REST** per gestione CRUD:
  - `GET /v1/browser/allowed-sites` — lista tutti i siti
  - `POST /v1/browser/allowed-sites` — aggiungi/aggiorna (body: `{domain, mode, notes}`)
  - `DELETE /v1/browser/allowed-sites/{domain}` — rimuovi

#### Dettagli Tecnici

- **Migration**: `migrations/047_browser_allowed_sites.sql`
- **Tabella**: `browser_allowed_sites` con constraint `CHECK(mode IN ('headless', 'visible', 'auto'))`
- **Modulo API**: `src/web/api/browser_sites.rs`
- **DB operations**: `list_browser_allowed_sites()`, `upsert_browser_allowed_site()`, `delete_browser_allowed_site()` in `storage/db.rs`
- **Cache runtime**: `BrowserTaskPlanState.allowed_sites: HashMap<String, String>` — popolata dall'agent loop dopo il load dal DB via `set_allowed_sites()`

#### Dipendenze

- Dipende da: `storage/db.rs` (operazioni SQLite), `sqlx` (migrations)
- Dipendono da questo: `BrowserTaskPlanState` (allowlist check), API browser_sites, Web UI pagina browser

---

### 11. Form Plan e Annotazione Form

#### Comportamento Atteso

- Quando uno snapshot contiene campi form, `annotate_form_order()` inietta un header "VISUAL FORM ORDER" che elenca i campi nell'ordine visuale (top-to-bottom, left-to-right) invece dell'ordine DOM.
- **JS injection**: una singola chiamata `browser_evaluate` trova tutti gli `input:not([type=hidden])`, `select`, `textarea`, `[role=combobox]`, `[role=searchbox]`, `[role=spinbutton]`, `[contenteditable=true]` visibili, legge le loro bounding box, li ordina per posizione visiva (righe da 40px), e restituisce `[{label, y, x, tag, type}]`.
- **Label resolution**: aria-label > placeholder > name > closest label > label[for=id] > title.
- **Label max length**: 40 caratteri.
- **Soglia minima**: se meno di 2 campi trovati, nessuna annotazione (non serve riordinare un campo solo).
- L'annotazione viene preposta prima dell'albero accessibilita nello snapshot output.
- **Form follow-up policy** (`browser_follow_up_instruction()` in `browser_context.rs`): dopo azioni su form, genera checklist di promemoria:
  - Se suggerimenti visibili o combobox aperta: "seleziona esplicitamente l'opzione visibile"
  - Se date picker aperto: "scegli la data richiesta dal picker"
  - Se time picker aperto: "seleziona orario esplicitamente"
  - Se submit bloccato: "non tentare submit finche tutti i campi richiesti non sono confermati"
  - Sempre: "dopo ogni cambio campo, ispeziona lo snapshot aggiornato"

#### Dettagli Tecnici

- **Modulo**: `src/tools/browser.rs` (`annotate_form_order()`), `src/agent/browser_context.rs` (`browser_follow_up_instruction()`)
- **Sorting**: `Math.floor(y / 40)` per raggruppare in righe visive, poi sort per x all'interno della riga
- **Detection form**: `has_form_fields(snapshot)` — cerca linee con ruoli textbox, combobox, searchbox, spinbutton nell'albero
- **Form map screenshot**: screenshot persistente con overlay numerati dei campi — resta nel context fino a navigazione (a differenza degli screenshot temporanei, cancellati ad ogni turno LLM)

#### Dipendenze

- Dipende da: `McpPeer` (per JS evaluate), snapshot compattato
- Dipendono da questo: azioni navigate e snapshot (invocano `annotate_form_order()`), agent loop (inietta follow-up policy)

---

### 12. Ref Normalization

#### Comportamento Atteso

- I modelli LLM spesso inviano riferimenti malformati. `normalize_ref()` corregge i casi piu comuni:
  - `"ref=e42"` -> `"e42"` (strip del prefisso "ref=")
  - `"ref:e42"` -> `"e42"` (strip del prefisso "ref:")
  - `"42"` -> `"e42"` (aggiunge il prefisso "e" se solo numerico)
  - `"e42"` -> `"e42"` (gia corretto, nessun cambiamento)
- Applicato a tutte le azioni che richiedono un parametro `ref`: click, type, fill, select_option, hover, scroll (se ref fornito), drag, click_coordinates (se ref fornito), hold_click (se ref fornito).
- Se il parametro `ref` e assente quando richiesto, restituisce errore: `"'ref' parameter is required for this action"`.

#### Dettagli Tecnici

- **Modulo**: `src/tools/browser.rs`, metodo `BrowserTool::normalize_ref(args)`
- **Logica**: `raw.trim().trim_start_matches("ref=").trim_start_matches("ref:")` -> se inizia con 'e' ok, se tutto numerico -> prepend 'e', altrimenti usa cosi com'e.

#### Dipendenze

- Dipende da: nulla (funzione pura)
- Dipendono da questo: tutte le azioni che usano ref (click, type, fill, hover, scroll, drag, hold_click)

---

### 13. Execution Discipline (universale, non solo browser)

#### Comportamento Atteso

- Il sistema di execution discipline e integrato in `ExecutionPlanState` e si applica a **tutti i tool**, non solo browser. Traccia il progresso rispetto al piano cognitivo con checkpoint, strategy rotation e give-up anticipato.
- **Checkpoint system**: ogni `CHECKPOINT_INTERVAL = 6` iterazioni di tool, o quando lo step corrente supera `MAX_ITERATIONS_PER_STEP = 8` iterazioni:
  1. Per browser: compatta snapshot stale via `supersede_stale_browser_context()`
  2. Per tutti: compatta contesto vecchio via `auto_compact_context()`
  3. Inietta un riassunto strutturato del progresso (step completati, corrente, rimanenti, approcci falliti)
  4. Emette `"plan"` event alla UI per aggiornare il counter "N su M"
- **Strategy rotation**: quando uno step e bloccato per `MAX_ITERATIONS_PER_STEP` iterazioni, inietta un prompt tool-agnostico che forza il modello a cambiare approccio. Massimo `MAX_STRATEGY_ROTATIONS = 2` rotazioni per step.
- **Give-up anticipato**: dopo aver esaurito tutte le rotazioni su uno step, lo step viene marcato `Skipped` e il piano passa al successivo. Se non ci sono piu step pendenti, genera un report con `PlanAction::GiveUp`.
- **Auto-avanzamento semantico** (`try_semantic_advance`): euristica per tool+keyword che avanza automaticamente lo step corrente:
  - `web_search` → step "cerca/search/find"
  - `web_fetch` → step "estrai/extract/leggi/read"
  - `write_file` → step "salva/save/crea/create/genera/csv/file"
  - `shell` → step "esegui/execute/run"
  - `browser navigate` → step "naviga/vai/go to/open"
  - `browser` con risultati → step "cerca/search/find"
- **Progress status streaming**: dopo ogni tool, emette un `"status"` event alla UI (es. "Step 2/5: Estraendo dati dal sito...").
- **Ortogonale a BrowserTaskPlanState**: il guard browser (loop detection, allowlist, rate-limit) e separato e non toccato.
- **Contract `PlanAction`**: il metodo `note_iteration()` ritorna un enum che l'agent loop deve seguire:
  - `Continue` — nessuna azione
  - `Checkpoint { summary }` — compatta + inietta summary
  - `StrategyRotation { prompt }` — cambia approccio
  - `GiveUp { report }` — abbandona con report

#### Dettagli Tecnici

- **Modulo**: `src/agent/execution_plan.rs` (fuso nel sistema di plan esistente, non modulo separato)
- **Enum**: `PlanAction` con 4 varianti, `StepStatus` esteso con `Skipped`
- **Costanti**: `MAX_ITERATIONS_PER_STEP = 8`, `CHECKPOINT_INTERVAL = 6`, `MAX_STRATEGY_ROTATIONS = 2`
- **Entry point**: `note_iteration(tool_name, output)` — chiamato per OGNI tool result dall'agent loop
- **Progress**: `progress_status()` — genera messaggio user-facing con dedup
- **Integrazione agent_loop.rs**: dopo `execution_plan.note_tool_result()` e `auto_advance_explicit_steps()`, l'agent loop chiama `note_iteration()` e reagisce al `PlanAction`

#### Dipendenze

- Dipende da: nessuna dipendenza esterna (usa solo la logica interna di `ExecutionPlanState`)
- Dipendono da questo: agent loop (invoca `note_iteration()` dopo ogni risultato tool e reagisce al `PlanAction`)

---

### 14. Web Fetch → Browser Auto-Escalate (2026-04)

#### Comportamento Atteso

- Entry point esterno al dominio browser: quando `web_fetch` incontra una SPA JS-rendered (rilevata via `looks_like_js_required()`), **l'agent loop sostituisce automaticamente** il fallimento testuale con una pipeline browser (`navigate` + `snapshot`), senza chiedere all'LLM di ri-prompat-are.
- Dal punto di vista del BrowserTaskPlan: l'azione arriva come una normale `navigate` generata dall'agent loop — passa per `check_navigate()` (allowlist), può triggerare mode switching, e viene tracciata nella finestra di cycle detection.
- **Perché qui**: documentato in questo doc perché il punto di atterraggio effettivo è la pipeline browser. La logica di rilevamento è in `tools/web.rs`, ma l'orchestrazione (sostituzione del tool call) è nell'agent loop.
- **Rimandi**: vedi `04-strumenti.md#feature-web-tool` per il detection side e `02-agente-cognizione.md#feature-web-fetch-auto-escalate-to-browser-2026-04` per il meccanismo di sostituzione.

#### Dettagli Tecnici

- File: `src/tools/web.rs` (detection `looks_like_js_required`), `src/agent/agent_loop.rs` (sostituzione)
- Pre-requisito: `config.browser.enabled = true` — altrimenti fallback al vecchio errore testuale
- Interazione con allowlist: l'URL deve superare `check_navigate()` del `BrowserTaskPlanState`; se non è in `browser_allowed_sites`, viene emesso un choice block all'utente per autorizzarlo una tantum (flow standard siti non in whitelist)
- Sicurezza: l'escalate **non** bypassa il contact perimeter — se l'URL è esclusa dal perimeter dell'interlocutore, niente escalate
- Tabelle DB: nessuna nuova; riusa `browser_allowed_sites`

#### Dipendenze

- Dipende da: `BrowserTool`, `BrowserTaskPlanState`, `tools::web::WebFetchTool`, `agent::agent_loop`
- Dipendono da questo: nessuno direttamente — è trasparente per l'LLM

---

### Appendice: Stealth Mode

Il `BrowserTool` inietta 10 patch anti-detection via `addInitScript` di Playwright prima della prima navigazione:

1. `navigator.webdriver = false` — flag primario bot detection
2. `window.chrome` runtime — identity check Chrome
3. `navigator.plugins` — lista plugin realistica (3 plugin = Chrome normale)
4. `navigator.permissions.query` — consistency notifiche
5. `navigator.languages` — `['en-US', 'en', 'it']`
6. `navigator.hardwareConcurrency = 4`, `navigator.deviceMemory = 8` — valori laptop realistici
7. `navigator.maxTouchPoints = 0` — desktop, no touch
8. `window.outerWidth/outerHeight` — consistency viewport
9. Cross-frame `window.chrome` patching per iframe
10. Canvas fingerprint — shift deterministico (non random) del primo pixel

Configurabile: `browser.stealth = true/false` (default true). Dopo show/hide, re-injection automatica sul nuovo processo.

### Appendice: Cursor-Interactive Detection

Su pagine con ARIA tree sparso (meno di `CURSOR_DETECT_MAX_REFS = 5` elementi con ref), viene iniettato un JS snippet (`CURSOR_INTERACTIVE_JS`) che cerca elementi DOM interattivi per stile (cursor:pointer, onclick, tabindex) ma senza ruoli ARIA. Restituisce fino a 15 elementi con `{text, tag, hints}`. I risultati vengono aggiunti come sezione separata nello snapshot output.

### Appendice: Browser API Endpoints

**Profili browser** (`src/web/api/browser.rs`, sotto feature gate `browser`):

| Endpoint | Metodo | Descrizione |
|----------|--------|-------------|
| `/v1/browser/test` | POST | Test disponibilita browser |
| `/v1/browser/profiles` | GET | Lista profili con health info |
| `/v1/browser/profiles` | POST | Crea nuovo profilo |
| `/v1/browser/profiles/{name}` | PUT | Aggiorna profilo |
| `/v1/browser/profiles/{name}` | DELETE | Cancella dati profilo (directory) |
| `/v1/browser/profiles/{name}/fix-permissions` | POST | Fix ownership file (chown) |
| `/v1/browser/profiles/{name}/set-default` | POST | Imposta come profilo di default |
| `/v1/browser/profiles/{name}/delete` | POST | Cancella profilo da config + dati |

**Siti consentiti e site memory** (`src/web/api/browser_sites.rs`):

| Endpoint | Metodo | Descrizione |
|----------|--------|-------------|
| `/v1/browser/allowed-sites` | GET | Lista siti consentiti |
| `/v1/browser/allowed-sites` | POST | Aggiungi/aggiorna sito |
| `/v1/browser/allowed-sites/{domain}` | DELETE | Rimuovi sito |
| `/v1/browser/site-memory/{domain}` | GET | Leggi site memory |
| `/v1/browser/site-memory/{domain}` | DELETE | Cancella site memory |
