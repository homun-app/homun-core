# Sicurezza

## Panoramica

Il dominio sicurezza di Homun implementa un modello defense-in-depth con 12 sottosistemi interconnessi: storage cifrato (vault), autenticazione web, API keys, 2FA, pairing canali, emergency stop, exfiltration guard, vault leak detection, trusted devices, sandbox execution, skill security scanning e permission system. Tutti i segreti sono cifrati con AES-256-GCM, la master key risiede nel keychain OS (con fallback su file), e la memoria zeroizzata dopo l'uso impedisce leak residui.

---

### 1. Vault (Storage Cifrato)

#### Comportamento Atteso
- L'utente (o l'LLM tramite il tool `vault`) puo memorizzare segreti (password, token, API key, codici personali) in un vault cifrato.
- I segreti vengono salvati in `~/.homun/secrets.enc` come JSON cifrato.
- La master key viene conservata nel keychain OS (macOS Keychain, Linux Secret Service, Windows Credential Manager) oppure in un file `~/.homun/master.key` con permessi `0600` come fallback per ambienti headless.
- Ogni operazione di cifratura usa un nonce casuale unico (mai riutilizzato).
- La memoria contenente chiavi e segreti viene azzerata dopo l'uso tramite il crate `zeroize`.
- Nel contesto dell'agente e nei file di memoria, i segreti appaiono solo come riferimenti opachi `vault://nome_chiave`, mai come valori in chiaro.
- I segreti sono organizzati per profilo: profilo default usa prefisso `vault.`, altri profili usano `vault.p:{slug}.`.
- 5 azioni disponibili via tool: `store`, `retrieve`, `list`, `delete`, `confirm` (per 2FA).
- Ogni accesso al vault viene registrato nel log di audit (tabella `vault_access_log`).

#### Dettagli Tecnici
- **Moduli/file coinvolti**: `src/storage/secrets.rs` (cifratura), `src/tools/vault.rs` (tool LLM), `src/web/api/vault.rs` (API REST)
- **Algoritmo**: AES-256-GCM via `ring::aead` con nonce 12 byte casuale per operazione
- **Master key**: 32 byte generati con `ring::rand::SystemRandom`, codificati Base64
- **Backend chiave**: `KeyBackend::Keychain` (via `keyring::Entry::new("dev.homun.secrets", "master")`) oppure `KeyBackend::File`
- **Formato file**: JSON con campi `version`, `nonce` (Base64), `ciphertext` (Base64, include authentication tag)
- **Struct principali**: `EncryptedSecrets`, `SecretKey` (con factory methods: `provider_api_key()`, `channel_token()`, `gateway_token()`, `custom()`)
- **Funzione globale**: `global_secrets()` restituisce `Arc<EncryptedSecrets>` lazy-initialized
- **Metodi**: `save()`, `load()`, `get()`, `set()`, `delete()`, `list_keys()`, `encrypt_data()`, `decrypt_data()`
- **Scrittura atomica**: scrivi su `.tmp`, poi `rename()`
- **File runtime**: `~/.homun/secrets.enc`, `~/.homun/master.key` (fallback)
- **Tabella DB**: `vault_access_log` (via `db.insert_vault_access()`), con `profile_id` (migration 050) per isolamento per profilo
- **Endpoint API**:
  - `GET /api/v1/vault` — lista chiavi (filtrabili per profilo)
  - `POST /api/v1/vault` — salva segreto (richiede admin)
  - `POST /api/v1/vault/{key}/reveal` — rivela valore (con supporto 2FA)
  - `DELETE /api/v1/vault/{key}` — elimina segreto (richiede admin)
  - `GET /api/v1/vault/audit?profile=slug` — log audit accessi, filtrabile per profilo

#### Dipendenze
- **Da cosa dipende**: `ring` (AEAD), `keyring` (keychain OS), `zeroize`, `base64`, `serde_json`
- **Cosa dipende da questa feature**: Tool vault, 2FA (usa `encrypt_data()`/`decrypt_data()` per `2fa.enc`), session signing key, exfiltration guard, vault leak detection

---

### 2. Autenticazione Web

#### Comportamento Atteso
- L'utente accede alla Web UI tramite username e password.
- La password viene hashata con PBKDF2-HMAC-SHA256 a 600.000 iterazioni con salt casuale di 16 byte.
- Al login viene creata una sessione in memoria con TTL di 24 ore (default, configurabile).
- Il cookie di sessione (`homun_session`) viene firmato con HMAC-SHA256 (chiave persistita nel vault).
- Ogni sessione include un token CSRF generato casualmente.
- Il middleware CSRF protegge tutte le richieste state-changing (POST/PUT/PATCH/DELETE) tramite header `X-CSRF-Token`.
- Binding di sessione: IP e User-Agent vengono registrati alla creazione e monitorati per variazioni sospette (warning nel log).
- Al primo avvio (nessun utente con password), redirect automatico a onboarding.

#### Dettagli Tecnici
- **Moduli/file coinvolti**: `src/web/auth.rs`
- **Costanti**: `PBKDF2_ITERATIONS = 600_000`, `SALT_LEN = 16`, `CREDENTIAL_LEN = 32`, `SESSION_COOKIE_NAME = "homun_session"`, `DEFAULT_SESSION_TTL_SECS = 86400`, `SESSION_ID_LEN = 32`
- **Algoritmo password**: `ring::pbkdf2::PBKDF2_HMAC_SHA256`, formato storage: `base64(salt):base64(hash)`
- **Funzioni**: `hash_password()`, `verify_password()`
- **Struct sessione**: `WebSession` con campi `user_id`, `username`, `roles`, `created_at`, `ttl`, `csrf_token`, `client_ip`, `user_agent`
- **Session store**: `SessionStore` con `RwLock<HashMap<String, WebSession>>` e `hmac::Key` per firma cookie
- **Signing key**: persistita nel vault come `web.session.signing_key`, generata se assente
- **Firma cookie**: `sign_cookie()` produce `"{session_id}.{hmac_signature}"`, `verify_cookie()` valida
- **Middleware**: `auth_middleware()` (cookie + Bearer), `csrf_guard_middleware()` (protezione CSRF), `auth_rate_limit_middleware()`, `api_rate_limit_middleware()`
- **Struct auth**: `AuthUser` con `AuthMethod::Session` o `AuthMethod::BearerToken { scope }`, metodi `can_write()`, `is_admin()`, `can_emergency_stop()`
- **Guard functions**: `require_write()`, `require_admin()`, `check_write()`, `check_admin()`, `require_emergency_stop()`
- **IP extraction**: `extract_client_ip()` supporta `X-Forwarded-For` quando `trust_x_forwarded_for = true`

#### Dipendenze
- **Da cosa dipende**: Vault (per signing key), `ring` (PBKDF2, HMAC, RNG), `axum` (middleware), database (utenti)
- **Cosa dipende da questa feature**: Tutte le pagine Web UI, tutti gli endpoint API, CSRF protection, trusted devices

---

### 3. API Keys

#### Comportamento Atteso
- L'utente admin puo creare token API (webhook tokens) dal pannello Account.
- I token hanno formato `wh_{uuid}` e vengono mostrati in chiaro solo al momento della creazione.
- Ogni token ha: nome, scope (`read`, `write`, `admin`), flag enabled, data di scadenza opzionale (`7d`, `30d`, `90d`), campo `last_used`.
- Nelle liste, il token viene mascherato: `wh_****...{ultimi 4 char}`.
- Il `token_id` sono i primi 16 caratteri del token (usati per operazioni di delete/toggle).
- I token Bearer vengono validati nel middleware auth con controllo scadenza e rate limiting per-token.
- Token mobile (`hm_mobile_*`) aggiornano `last_seen` del dispositivo associato.
- Scope `mobile_stop` abilita solo l'emergency stop da remoto.

#### Dettagli Tecnici
- **Moduli/file coinvolti**: `src/web/api/account.rs` (CRUD), `src/web/auth.rs` (validazione middleware)
- **Tabelle DB**: `webhook_tokens` (via `db.create_webhook_token()`, `db.load_webhook_tokens()`, `db.load_webhook_token()`, `db.delete_webhook_token()`, `db.toggle_webhook_token()`, `db.touch_webhook_token()`, `db.find_token_by_prefix()`, `db.lookup_user_by_webhook_token()`)
- **Endpoint API**:
  - `GET /api/v1/account/tokens` — lista token mascherati
  - `POST /api/v1/account/tokens` — crea token (richiede admin)
  - `DELETE /api/v1/account/tokens/{token_id}` — elimina token (richiede admin)
  - `POST /api/v1/account/tokens/{token_id}` — toggle enable/disable (richiede admin)
- **Rate limiting per-token**: `state.token_rate_limiter` (istanza `RateLimiter<String>`)
- **Controllo scadenza**: `expires_at` RFC3339, confronto con `chrono::Utc::now()`

#### Dipendenze
- **Da cosa dipende**: Database (tabella `webhook_tokens`), autenticazione web (middleware)
- **Cosa dipende da questa feature**: Accesso API programmatico, app mobile, emergency stop remoto

---

### 4. 2FA (TOTP)

#### Comportamento Atteso
- L'utente puo abilitare la Two-Factor Authentication dalla pagina Vault nella Web UI.
- Il setup genera un QR code (otpauth://) compatibile con Google Authenticator, Authy, 1Password, Bitwarden.
- Vengono generati 10 recovery codes nel formato `XXXX-XXXX` (hex).
- Dopo il setup, ogni accesso al vault `retrieve` richiede un codice TOTP a 6 cifre o un `session_id` valido.
- La verifica TOTP accetta codici con finestra di +-1 periodo (90 secondi totali).
- Dopo 5 tentativi falliti: lockout di 5 minuti.
- Le sessioni 2FA scadono dopo 5 minuti (default, configurabile 60-3600 secondi).
- Il 2FA e protetto da feature flag `vault-2fa`.
- La configurazione 2FA viene cifrata con la stessa master key del vault e salvata in `~/.homun/2fa.enc`.
- Supporta migrazione trasparente da formato legacy (JSON plaintext) a formato cifrato.

#### Dettagli Tecnici
- **Moduli/file coinvolti**: `src/security/totp.rs` (gestione TOTP), `src/security/two_factor.rs` (config + sessioni), `src/web/api/vault.rs` (API 2FA), `src/tools/vault.rs` (integrazione tool)
- **Costanti**: `MAX_FAILED_ATTEMPTS = 5`, `LOCKOUT_DURATION_SECS = 300`, `DEFAULT_SESSION_TIMEOUT_SECS = 300`
- **Algoritmo TOTP**: RFC 6238, SHA-1, 6 cifre, periodo 30 secondi, skew +-1
- **Crate**: `totp_rs` con `Algorithm::SHA1`, issuer `"Homun"`
- **Struct**: `TotpManager` (genera/verifica codici), `TwoFactorConfig` (configurazione persistente), `TwoFactorSession` (sessione in-memory), `TwoFactorSessionManager` (gestione sessioni), `TwoFactorStorage` (I/O file)
- **Recovery codes**: `generate_recovery_codes()` produce 10 codici, `use_recovery_code()` li consuma (one-time use)
- **Sessione globale**: `global_session_manager()` via `OnceLock<Arc<TwoFactorSessionManager>>`
- **File runtime**: `~/.homun/2fa.enc` (cifrato con `EncryptedSecrets::encrypt_data()`)
- **Endpoint API** (tutti sotto `/api/v1/vault/2fa/`):
  - `GET /v1/vault/2fa/status` — stato 2FA (enabled, recovery codes rimanenti)
  - `POST /v1/vault/2fa/setup` — genera secret + QR code
  - `POST /v1/vault/2fa/confirm` — conferma setup con primo codice
  - `POST /v1/vault/2fa/verify` — verifica codice, crea sessione
  - `POST /v1/vault/2fa/disable` — disabilita 2FA (richiede codice)
  - `POST /v1/vault/2fa/recovery` — mostra recovery codes (richiede sessione)
  - `PATCH /v1/vault/2fa/settings` — aggiorna timeout sessione (richiede sessione)
- **Setup flow pendente**: `PENDING_2FA_SETUP` (`Mutex<Option<Pending2FaSetup>>`) per il flusso setup -> conferma

#### Dipendenze
- **Da cosa dipende**: Vault (cifratura `2fa.enc`), `totp_rs`, `ring` (RNG)
- **Cosa dipende da questa feature**: Vault retrieve (gating), API reveal secret

---

### 5. Pairing Canali

#### Comportamento Atteso
- Quando `pairing_required = true` su un canale, i mittenti sconosciuti (non in `allow_from` e non in `user_identities`) ricevono un codice OTP a 6 cifre via DM.
- L'utente deve rispondere con il codice entro 5 minuti per essere registrato come utente trusted.
- Massimo 3 tentativi per codice; al superamento, viene emesso un nuovo codice.
- Se il codice scade, un nuovo codice viene generato automaticamente al messaggio successivo.
- Dopo verifica, viene creato un utente nel database e collegata l'identita del canale.

#### Dettagli Tecnici
- **Moduli/file coinvolti**: `src/security/pairing.rs`
- **Costanti**: `CODE_TTL_SECS = 300` (5 minuti), `MAX_ATTEMPTS = 3`
- **Struct**: `PairingManager` con `UserManager` e `pending: RwLock<HashMap<String, PairingRequest>>` (chiave: `"{channel}:{sender_id}"`)
- **Struct interna**: `PairingRequest` con `code`, `display_name`, `created_at`, `attempts`
- **Funzioni principali**: `check_sender()` (entry point), `verify_code()`, `issue_code()`, `cleanup_expired()`
- **Generazione codice**: `generate_code()` con `rand::thread_rng().gen_range(100_000..1_000_000)`
- **Flusso**: messaggio arriva -> `check_sender()` -> se sconosciuto: emette codice -> se codice: verifica -> se valido: `user_manager.create_user()` + `link_identity()` -> `Ok(None)` (procedi normalmente)
- **Tabelle DB**: `users`, `user_identities` (via `UserManager`)

#### Dipendenze
- **Da cosa dipende**: `UserManager`, database, configurazione canale (`pairing_required`, `allow_from`)
- **Cosa dipende da questa feature**: Gateway (autenticazione mittenti sconosciuti)

---

### 6. Emergency Stop (E-Stop)

#### Comportamento Atteso
- Un kill switch globale che ferma istantaneamente tutta l'attivita dell'agente.
- Attivabile via endpoint API (anche da token mobile con scope `mobile_stop`).
- Azioni eseguite in sequenza: (1) flag stop globale, (2) rete offline, (3) chiusura browser, (4) shutdown server MCP, (5) cancellazione subagent.
- Dopo l'attivazione, l'agente non puo piu processare messaggi ne fare richieste di rete.
- Il resume ripristina il flag stop e riporta la rete online.

#### Dettagli Tecnici
- **Moduli/file coinvolti**: `src/security/estop.rs`
- **Struct**: `EStopHandles` (con `browser_session`, `mcp_manager`, `subagent_manager` — tutti `Option<Arc<...>>`, popolati al gateway startup)
- **Struct report**: `EStopReport` con `stop_requested`, `network_offline`, `browser_closed`, `mcp_shutdown`, `subagents_cancelled`
- **Funzioni**: `emergency_stop(handles: &RwLock<EStopHandles>) -> EStopReport`, `resume()`
- **Meccanismo stop**: `stop::request_stop()` (flag atomico globale), `retry::set_network_online(false)` (previene retry di rete)
- **Feature gates**: `#[cfg(feature = "browser")]` per browser, `#[cfg(feature = "mcp")]` per MCP
- **Endpoint API**:
  - `POST /api/v1/emergency-stop` — attiva E-Stop (richiede `can_emergency_stop()`)
  - `POST /api/v1/resume` — ripristina dopo E-Stop

#### Dipendenze
- **Da cosa dipende**: `agent/stop.rs` (flag globale), `utils/retry.rs` (stato rete), browser session, MCP manager, subagent manager
- **Cosa dipende da questa feature**: Agent loop (controlla flag stop), retry logic (controlla stato rete)

---

### 7. Exfiltration Guard

#### Comportamento Atteso
- Scansiona automaticamente l'output dell'LLM prima che raggiunga l'utente.
- Rileva pattern di segreti comuni: chiavi OpenAI (`sk-*`), Anthropic (`sk-ant-*`), OpenRouter (`sk-or-*`), AWS (`AKIA*`), Telegram bot token, Discord bot token, GitHub PAT, JWT, PEM private key, connection string, Bearer token, OAuth token, e pattern generici ad alta entropia.
- I segreti rilevati vengono redatti automaticamente con placeholder specifici (es. `[REDACTED_OPENAI_KEY]`, `[REDACTED_AWS_KEY]`).
- Supporta pattern custom via configurazione.
- I placeholder come `YOUR_API_KEY_HERE`, `xxx`, `dummy`, `fake`, `mock` vengono riconosciuti come non-segreti e ignorati.
- Due modalita: `redact` (default, sostituisce e lascia passare) o `block` (blocca l'intero output).
- Ogni rilevamento viene loggato con severita (Critical, High, Medium, Low) e posizione nel testo.

#### Dettagli Tecnici
- **Moduli/file coinvolti**: `src/security/exfiltration.rs`
- **Pattern built-in**: 16 pattern regex compilati in `builtin_patterns()` — `openai_api_key`, `anthropic_api_key`, `openrouter_api_key`, `deepseek_api_key`, `high_entropy_hex`, `aws_access_key`, `aws_secret_key`, `api_key_in_text`, `private_key_pem`, `telegram_bot_token`, `discord_bot_token`, `github_pat`, `github_token`, `oauth_token`, `bearer_token`, `jwt_token`, `connection_string`
- **Struct**: `ExfilFilter` (istanza globale via `OnceLock`), `ExfilConfig`, `Detection`, `ScanResult`, `SecretPattern`
- **Enum severita**: `Severity::Critical`, `High`, `Medium`, `Low`
- **Config**: `ExfilConfig` con `enabled`, `block_on_detection`, `log_attempts`, `custom_patterns`
- **Funzioni pubbliche**: `global_filter()`, `init_global_filter()`, `scan()`, `redact()`, `ExfilFilter::redact_vault_values()`
- **Metodo placeholder**: `is_placeholder()` controlla indicatori (`placeholder`, `your_`, `xxx`, `dummy`, `fake`, `mock`, `<`, `>`, `[your`, `{your`) e caratteri ripetuti
- **Troncamento log**: `truncate_for_log()` mostra solo i primi 8 caratteri del segreto

#### Dipendenze
- **Da cosa dipende**: `regex` (pattern matching)
- **Cosa dipende da questa feature**: Agent loop (scansione output prima dell'invio), vault leak detection

---

### 8. Vault Leak Detection

#### Comportamento Atteso
- Scansiona testo (output LLM, file di memoria, consolidamenti) alla ricerca di valori effettivamente presenti nel vault.
- Sostituisce le occorrenze trovate con riferimenti `vault://nome_chiave`.
- Usa word-boundary matching per evitare corruzione di parole parziali (es. `"pass"` nel vault non corrompe la parola `"compass"`).
- Valori vuoti o molto corti (< 3 caratteri) vengono ignorati.
- Funzione inversa: `resolve_vault_references()` sostituisce i placeholder `vault://key` con i valori reali quando l'LLM li produce nel suo output.

#### Dettagli Tecnici
- **Moduli/file coinvolti**: `src/security/vault_leak.rs`
- **Funzioni**: `redact_vault_values(text, vault_entries)`, `resolve_vault_references(text, vault_entries)`
- **Funzione interna**: `replace_whole_match()` — sostituzione con boundary check (`is_word_char()`: alfanumerico o `_`)
- **Input**: `vault_entries: &[(String, String)]` — coppie `(chiave, valore)` dal vault
- **Output**: testo con valori sostituiti da `vault://key` (redact) oppure `vault://key` sostituiti con valori reali (resolve)
- **Integrazione**: usata nel consolidamento memorie, nell'agent loop prima dell'output, nella funzione `ExfilFilter::redact_vault_values()` (versione senza boundary check in `exfiltration.rs`)

#### Dipendenze
- **Da cosa dipende**: Vault (`global_secrets().load()` per ottenere le entry)
- **Cosa dipende da questa feature**: Memory consolidation, agent loop output pipeline

---

### 9. Trusted Devices

#### Comportamento Atteso
- I dispositivi che accedono alla Web UI vengono tracciati tramite fingerprint (SHA-256 di `user_id:User-Agent`, troncato a 16 hex char).
- Un dispositivo puo essere approvato o revocato dall'admin.
- I token mobile (`hm_mobile_*`) aggiornano automaticamente `last_seen` del dispositivo associato ad ogni richiesta API.

#### Dettagli Tecnici
- **Moduli/file coinvolti**: `src/web/api/devices.rs`, `src/web/auth.rs` (fingerprinting)
- **Funzione fingerprint**: `device_fingerprint(user_id, user_agent)` in `auth.rs` — SHA-256 troncato a 64 bit (16 hex char), non basato su IP
- **Tabelle DB**: `trusted_devices` (via `db.load_trusted_devices()`, `db.approve_trusted_device()`, `db.delete_trusted_device()`, `db.touch_mobile_device_by_token()`)
- **Endpoint API**:
  - `GET /api/v1/devices` — lista dispositivi dell'utente corrente
  - `POST /api/v1/devices/{id}/approve` — approva dispositivo (richiede admin)
  - `DELETE /api/v1/devices/{id}` — revoca dispositivo (richiede admin)

#### Dipendenze
- **Da cosa dipende**: Database, autenticazione web
- **Cosa dipende da questa feature**: App mobile (tracking dispositivi)

---

### 10. Sandbox Execution

#### Comportamento Atteso
- L'esecuzione di comandi shell, skill, e server MCP puo avvenire in ambiente isolato (sandboxed).
- 5 backend supportati: **Docker**, **Linux Native** (Bubblewrap), **macOS Seatbelt** (`sandbox-exec`), **Windows Native** (Job Objects), **None** (nativo, fallback).
- Auto-detection del backend migliore in modalita `auto`: preferenza per il backend nativo della piattaforma (Linux -> Bubblewrap, macOS -> Seatbelt, Windows -> Job Objects), poi Docker, poi fallback nativo.
- Modalita `strict`: se il backend richiesto non e disponibile, l'esecuzione fallisce (nessun fallback).
- Ogni evento sandbox (prepared, rejected) viene loggato con dettagli completi.
- Sanitizzazione environment: solo variabili safe (`PATH`, `HOME`, `LANG`, etc.) + variabili extra esplicite.
- Docker: supporta limitazione memoria (`docker_memory_mb`), rete (`docker_network: "none"`/`"bridge"`/`"host"`), mount workspace.
- Bubblewrap (Linux): `--clearenv`, `--unshare-user`, `--unshare-net`, bind read-only del filesystem, `prlimit` per limiti memoria.
- Seatbelt (macOS): profilo SBPL generato dinamicamente, workspace writable, rete bloccabile, process fork/exec consentiti.
- Runtime image management: parsing reference Docker, policy `pinned`/`floating`, drift detection.

#### Dettagli Tecnici
- **Moduli/file coinvolti**: `src/tools/sandbox/mod.rs` (orchestrazione), `src/tools/sandbox/resolve.rs` (risoluzione backend), `src/tools/sandbox/backends/` (implementazioni), `src/tools/sandbox/env.rs` (sanitizzazione env), `src/tools/sandbox/events.rs` (logging), `src/tools/sandbox/runtime_image.rs` (gestione immagini), `src/tools/sandbox/types.rs` (tipi)
- **Struct config**: `ExecutionSandboxConfig` (in `src/config/schema.rs`) con campi `enabled`, `backend`, `strict`, `docker_image`, `docker_network`, `docker_memory_mb`, `docker_mount_workspace`
- **Enum backend**: `ResolvedSandboxBackend::None`, `Docker`, `LinuxNative`, `WindowsNative`, `MacosSeatbelt`
- **Struct disponibilita**: `SandboxBackendAvailability` con metodi `detect()`, `is_available()`, `preferred_auto_backend()`, `capabilities()`
- **Funzione principale**: `build_process_command()` — risolve backend, costruisce `Command`, logga evento
- **Risoluzione**: `resolve_sandbox_backend()` -> `resolve_sandbox_backend_with_capabilities()` con chain di fallback
- **Probe funzioni**: `docker_available()` (cached via `OnceLock`), `docker_available_live()` (non-cached), `linux_native_runtime_support()`, `macos_seatbelt_runtime_support()`
- **Struct probe**: `BackendProbe { available, reason }`, `LinuxNativeRuntimeSupport` (bubblewrap, user_namespace, network_namespace, prlimit, cgroup_v2), `MacosSeatbeltRuntimeSupport` (sandbox_exec)
- **Env safe keys**: `SAFE_ENV_KEYS` in `env.rs`
- **File stato runtime**: gestiti da `events.rs` in directory configurabile via `HOMUN_SANDBOX_STATE_DIR`

#### Dipendenze
- **Da cosa dipende**: Docker CLI, `bwrap` (Bubblewrap), `/usr/bin/sandbox-exec` (macOS), `prlimit` (Linux), configurazione `[execution_sandbox]` in TOML
- **Cosa dipende da questa feature**: Shell tool, skill executor, MCP server startup

---

### 11. Skill Security Scanning

#### Comportamento Atteso
- Prima dell'installazione di una skill, il package viene analizzato staticamente per rilevare pattern pericolosi.
- Risk score da 0 (pulito) a 100 (altamente rischioso). Soglia di blocco: 65.
- Tre livelli di severita: `Critical` (55 punti, blocca), `Warning` (18 punti), `Info` (6 punti).
- 8 categorie di warning: `Destructive`, `PrivilegeEscalation`, `SecretAccess`, `RemoteExecution`, `Obfuscation`, `NetworkActivity`, `Reputation`, `PromptInjection`.
- Due tipi di scansione: substring match (case-insensitive) e regex match.
- Pattern rilevati: `rm -rf /`, `chmod 777`, `sudo`, `eval()`, `exec()`, base64 decode sospetto, reverse shell, obfuscazione, e molti altri.
- Rilevamento attivita di rete non dichiarata negli script (requests, httpx, urllib, reqwest, fetch, axios, curl, wget).
- Integrazione opzionale con VirusTotal (max 4 lookup per package, via `VIRUSTOTAL_API_KEY`).
- Cache locale dei risultati: per package hash (24h TTL) e per reputazione (7 giorni TTL).
- File scansionati: max 256 KB per file, solo testo e script.

#### Dettagli Tecnici
- **Moduli/file coinvolti**: `src/skills/security.rs`
- **Costanti**: `BLOCK_THRESHOLD = 65`, `PACKAGE_CACHE_TTL_SECS = 86400`, `REPUTATION_CACHE_TTL_SECS = 604800`, `MAX_SCANNED_FILE_BYTES = 262144`, `MAX_VIRUSTOTAL_LOOKUPS = 4`, `CACHE_FILENAME = "skill-security-cache.json"`
- **Struct report**: `SecurityReport` con `score` (0.0-1.0), `risk_score` (0-100), `blocked`, `warnings`, `scanned_files`, `cache_hit`, `reputation_checked`, `reputation_hits`
- **Struct warning**: `SecurityWarning` con `severity`, `category`, `pattern`, `description`, `file`, `line`, `source` (`StaticAnalysis`/`VirusTotal`/`ReputationCache`)
- **Funzioni**: `scan_skill_content()` (scansione SKILL.md raw), `scan_skill_package()` (scansione package completo con VirusTotal)
- **Regole statiche**: `STATIC_SUBSTRING_RULES` (pattern substring), `STATIC_REGEX_RULES` (pattern regex), `NETWORK_ACTIVITY` (regex per attivita di rete non dichiarata)
- **Cache**: `SecurityCache` in `~/.homun/skill-security-cache.json`
- **Package hash**: SHA-256 di tutti i file path + hash contenuto
- **File runtime**: `~/.homun/skill-security-cache.json`

#### Dipendenze
- **Da cosa dipende**: `sha2` (hashing), `regex` (pattern matching), VirusTotal API (opzionale)
- **Cosa dipende da questa feature**: Skill installer (`skills/installer.rs`), skill loader

---

### 12. Permission System

#### Comportamento Atteso
- Controlla l'accesso dell'agente a file e directory tramite un sistema ACL configurabile.
- Tre operazioni controllate: `read`, `write`, `delete`.
- Tre risultati possibili: `Allowed`, `Denied(reason)`, `NeedsConfirmation(reason)`.
- Modalita configurabile: `Acl` (regole esplicite) con default configurabili per operazione.
- Tre preset disponibili:
  - **Developer**: accesso completo alla home, conferma su delete.
  - **Restricted**: solo workspace, brain, e memory.
  - **Paranoid**: deny-all, solo brain con conferma.
- Le regole ACL supportano glob pattern (es. `~/**`, `~/.homun/workspace/**`).
- Directory browser integrato per selezionare path nelle regole.
- Test path integrato: verifica se un path e consentito per un'operazione.

#### Dettagli Tecnici
- **Moduli/file coinvolti**: `src/web/api/permissions.rs` (API), `src/config/schema.rs` (struct config), `src/tools/file.rs` (`check_path_permission()`)
- **Struct config**: `PermissionsConfig` con `mode` (`PermissionMode::Acl`), `default` (`DefaultPermissions`), `acl` (`Vec<AclEntry>`)
- **Struct ACL**: `AclEntry` con `path` (glob), `entry_type` (`"allow"`/`"deny"`), `permissions` (`PathPermissions` con `read`, `write`, `delete` come `PermissionValue::Bool(bool)` o `PermissionValue::Confirm`)
- **Enum risultato**: `PermissionResult::Allowed`, `Denied(String)`, `NeedsConfirmation(String)`
- **Funzione check**: `check_path_permission(path, op, permissions, profile)` in `src/tools/file.rs`
- **Endpoint API**:
  - `GET /api/v1/permissions` — configurazione corrente
  - `PUT /api/v1/permissions` — aggiorna configurazione completa
  - `POST /api/v1/permissions/acl` — aggiungi regola ACL
  - `DELETE /api/v1/permissions/acl/{idx}` — rimuovi regola per indice
  - `POST /api/v1/permissions/test` — testa permesso su path+operazione
  - `GET /api/v1/permissions/presets` — preset disponibili
  - `GET /api/v1/permissions/browse` — browser directory per path picker
- **Persistenza**: `config.toml` sezione `[permissions]`

#### Dipendenze
- **Da cosa dipende**: Configurazione TOML, file tool (`src/tools/file.rs`)
- **Cosa dipende da questa feature**: File tool (read/write/edit/delete), shell tool (working directory)

---

### Rate Limiting

#### Comportamento Atteso
- Tre livelli di rate limiting indipendenti:
  - **Auth endpoints** (login, setup): 5 richieste/minuto per IP.
  - **API endpoints**: 60 richieste/minuto per IP (sessioni Web UI esenti).
  - **Per-token**: rate limiting individuale per ogni Bearer token.
- Sliding window con cleanup periodico delle entry scadute.
- Header `X-RateLimit-Remaining` nella risposta.
- Risposta `429 Too Many Requests` con header `Retry-After` e corpo JSON con `retry_after_secs`.

#### Dettagli Tecnici
- **Moduli/file coinvolti**: `src/web/auth.rs`
- **Struct**: `RateLimiter<K>` generico — `RateLimiter<IpAddr>` per IP, `RateLimiter<String>` per token
- **Stato**: `RwLock<HashMap<K, (u32, Instant)>>` con `max_requests` e `window`
- **Metodi**: `check(key)` -> `Ok(remaining)` o `Err(retry_after)`, `cleanup()`
- **Istanze**: `state.auth_rate_limiter` (IP, auth), `state.api_rate_limiter` (IP, API), `state.token_rate_limiter` (String, per-token)
- **Esenzione**: richieste con cookie di sessione valido bypassano il rate limiting API (utente legittimo nella Web UI)
