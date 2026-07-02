# Codex come benchmark di produzione — gap analysis per Homun

> Documento **complementare** a [confronto-zcode-vs-homun.md](confronto-zcode-vs-homun.md):
> quello copre la *struttura* (motore separato, memoria off-path, tool nel motore); questo
> copre la **production-readiness** — cosa serve perché Homun sia un prodotto installabile,
> osservabile, sicuro e aggiornabile da utenti veri. Benchmark: il bundle distribuito di
> **Codex.app** (OpenAI), reverse-engineered.
>
> **Data di verifica: 2026-07-02.**
> Sorgenti:
> - **Codex** = `/Users/fabio/Projects/codex/Contents` — app.asar estratto (Electron 42,
>   `openai-codex-electron` v26.623.81905), binario Rust `codex` (codex-cli 0.142.5,
>   238MB), `codex_chronicle`, `cua_node/` (Node 24 + Playwright/OCR), 7 plugin bundled,
>   Info.plist + provisioning profile + Sparkle 2.9.1.
> - **Homun** = sorgente `/Users/fabio/Projects/Homun/app` @ v0.1.x (audit 2026-07-02:
>   packaging, sicurezza Electron, osservabilità, CI, test, approvals, data layer).
>
> ⚠️ Di Codex vedo stringhe/config/manifest, non la logica fine. Le affermazioni sotto
> citano l'evidenza trovata (nomi di canali IPC, chiavi di config, moduli bundle).

---

## TL;DR — dove si decide "producibile"

| Dimensione | Codex | Homun oggi | Gap |
|---|---|---|---|
| **Crash reporting** | Sentry main+renderer (`@sentry/electron` 7.5, `get-sentry-init-options`, `captureException` con phase tag) | **Nulla** (niente panic hook Rust, niente crashReporter) | 🔴 critico |
| **Log persistenti** | `file-based-logger` + `feedback-desktop-log-archive` (l'utente allega i log al feedback) + `trace-recording-upload` | **stderr scartato** nel packaged (`stdio: ignore`) | 🔴 critico |
| **Recovery stato** | Rileva `state_5.sqlite` corrotto → backup + recovery modal pre-avvio | Nulla: DB corrotto = app rotta | 🔴 critico |
| **Sandbox agente** | 3 modi imposti dal motore (`read-only`/`workspace-write`/`danger-full-access`) + 4 approval policy (`untrusted`/`on-failure`/`on-request`/`never`) in `config.toml` | Approval per-task (task-runtime) + policy gates capability; **nessun enforcement OS-level** su shell/file | 🟠 alto |
| **Firma/aggiornamenti** | Sparkle 2.9.1, chiave EdDSA **pinnata** in package.json, appcast su CDN; installer DMG staged (ditto→move atomico→relaunch, 25 retry) | macOS firmato+notarizzato+electron-updater ✅; **Windows/Linux unsigned, solo download** | 🟠 alto |
| **Hardening Electron** | contextIsolation+sandbox ovunque, `setWindowOpenHandler→deny`, CSP tag, devTools off in prod, fuses, sandbox policy **per-finestra** | contextIsolation+sandbox+nodeIntegration:false+deny link ✅; mancano CSP, fuses, devTools policy | 🟡 medio |
| **Deep link / OS** | `codex://` (OAuth callback, pluginInstall, thread), risoluzione workspace via git origin, single-instance, dock plugin, usage-strings privacy complete | **Nessun protocol handler, nessun single-instance lock** | 🟡 medio |
| **Plugin packaging** | `plugin.json` (+ `interface`: displayName, category, brandColor, privacyPolicyURL) + `skills/` YAML+MD + `.mcp.json`; 7 plugin bundled; marketplace | Skills = path filesystem canonico; registry unificato; **nessun formato manifest installabile** | 🟡 medio (= roadmap plugin F0–F3) |
| **E2E test** | (non osservabile dal bundle, ma `playwright-electron-agent-cdp` negli script dev) | 423 unit Rust ✅; **zero e2e UI↔gateway, zero test JS** | 🟡 medio |
| **Telemetria prodotto** | Rollout metrics interni (`fast-mode-rollout-metrics`), esperimenti | Solo telemetria locale per learning (floor→`tool_trace`) — coerente coi capisaldi | 🟢 scelta, non gap |

**La sintesi in una riga:** Homun ha già un'igiene Electron sopra la media e un motore più
ambizioso; quello che manca per la produzione non è *features*, è **osservabilità,
resilienza e enforcement** — le tre cose che rendono sopportabile il primo utente che non
sei tu.

---

## 1. Osservabilità — il gap più costoso (🔴 P0)

**Cosa fa Codex.** Tre meccanismi distinti, tutti visibili nel bundle:
1. **Sentry** su main e renderer: il preload chiede `get-sentry-init-options` al main
   (stesso `codexAppSessionId` per correlare), `captureException` taggata per fase
   (es. "Desktop bootstrap failed to start the main app").
2. **Logger su file** (`file-based-logger-*.js`) — i log sopravvivono al processo.
3. **Feedback con log allegati** (`feedback-desktop-log-archive-*.js`): quando l'utente
   segnala un problema, l'app impacchetta l'archivio log. Il bug report arriva *con* la
   diagnosi.

**Cosa fa Homun.** In dev stdio inherited; nel packaged `stdio: ignore` → **ogni riga di
log del gateway è persa**. Nessun panic hook: un panic Rust = processo morto senza
traccia. Il post-mortem di un bug utente è impossibile per costruzione.

**Cosa adottare (compatibile col caposaldo #3 local-first):**
- **Log su file SEMPRE** (`~/.homun/logs/gateway.log`, rotazione: `tracing-appender` con
  daily rotation è lo standard Rust; il gateway usa già `tracing` in alcuni crate).
  Idem per il main Electron (`~/.homun/logs/desktop.log`).
- **Panic hook Rust** (`std::panic::set_hook`) che scrive il backtrace nel log + ultimo
  evento in un file `crash-marker`, così al riavvio l'app sa che è morta male e può dirlo.
- **Crash reporting opt-in**: Sentry (o `crashpad` minimale) SOLO dietro consenso
  esplicito, default off — local-first non vieta la diagnostica, vieta il default
  invasivo. In alternativa 100% locale: il pulsante "Segnala un problema" che impacchetta
  log+versione+specs in uno zip che l'UTENTE manda (il pattern feedback-archive di Codex,
  senza vendor).
- **Health/liveness del gateway nel main**: oggi c'è solo l'health-check all'avvio;
  serve watchdog (respawn con backoff + notifica utente, marker di crash-loop).

## 2. Resilienza runtime (🔴 P0)

**Cosa fa Codex:**
- **Recovery del DB di stato**: rileva corruzione, fa backup in `codexHome`, ripristina
  pulito, mostra finestra di conferma non bloccante *prima* dell'avvio app.
- **Installer DMG staged**: rileva l'avvio da DMG → copia con `ditto` in cartella temp
  nascosta → move atomico in /Applications → relaunch, con retry (25×250ms) e fallback
  Trash. Più warning Intel vs Apple Silicon.
- **Single-instance lock** con queueing degli argomenti alla prima istanza.
- **Self-heal servizi**: lifecycle serializzato per il servizio computer-use
  (`ensureServicePid`/`invalidateServicePid`), reconnect con backoff per device HID.

**Cosa manca a Homun:**
- **Niente single-instance lock** (`app.requestSingleInstanceLock()`): due istanze = due
  gateway sulla stessa porta/DB SQLite → contention non deterministica. *Fix da 10 righe,
  priorità immediata.*
- **Niente recovery per `~/.homun/*.sqlite`**: un `SQLITE_CORRUPT` oggi è fatale e muto.
  Minimo vitale: `PRAGMA quick_check` all'avvio → backup + ricrea + informa. (Homun ha
  GIÀ il pattern self-heal giusto nel browser: `browser_response_indicates_cdp_wedge` →
  recycle throttlato. Stessa filosofia, applicata allo store.)
- **Niente move-to-Applications**: avvio da DMG = auto-update rotto silenziosamente.

## 3. Sandboxing e approvals — da cooperazione a enforcement (🟠 P1)

**Cosa fa Codex.** Il *motore* (non la UI) impone la policy: sandbox
`read-only`/`workspace-write`/`danger-full-access` (su macOS via Seatbelt/`sandbox-exec`,
su Linux Landlock — è nel codex CLI open-source) + approval policy a 4 livelli in
`~/.codex/config.toml`. La UI mostra le richieste; il recinto sta nel processo che esegue.
Le skill dichiarano *confirmation policies* dichiarative (deletion, financial, medical,
sensitive-data) nel loro SKILL.md.

**Dove sta Homun.** L'approval flow c'è (`task-runtime/approval.rs`, card UI, persistenza,
resume server-side — WS6) e i policy gates capability pure (`CapabilityPolicy::tool_access`,
deny-by-default su Composio). Ma: (a) la shell eseguita dai task non ha recinto OS; (b) il
file-access non è enforced sul workspace root a livello di processo; (c) i livelli di
approvazione non sono una **policy unica dichiarata** — sono gate sparsi per capability.

**Cosa adottare:**
- **Un enum di sandbox-mode a livello di sessione/workspace** (stessa terminologia a 3
  livelli — è ormai un vocabolario condiviso: Codex, Claude Code e ZCode convergono lì)
  che il *gateway* impone quando esegue shell/file tool: su macOS `sandbox-exec` con
  profilo generato (workspace-write = scrivi solo sotto il workspace root + tmp).
- **Approval policy come configurazione unica** (`untrusted`/`on-failure`/`on-request`/
  `never`) al posto dei gate impliciti per-capability — la policy diventa leggibile,
  testabile e mostrabile in Settings.
- **Confirmation policies dichiarative nelle skill** (il pattern SKILL.md di Codex):
  categorie sensibili dichiarate nel manifest → l'harness chiede conferma senza fidarsi
  del giudizio del modello. Coerente col caposaldo #2 (il control-flow è dell'harness).

## 4. Distribuzione e aggiornamenti (🟠 P1)

- Homun su macOS è già allo standard (firmato, notarizzato, electron-updater, versioning
  da tag CI, publish-gate sui secret). Il gap è **Windows/Linux**: unsigned e solo
  download manuale. Minimo per produzione: firma Windows (Azure Trusted Signing è oggi la
  via più economica per indie) e checksum/firma per AppImage; poi auto-update pieno.
- **Nota già appresa** ([release-publish-gotcha]): il draft→published resta un passo
  manuale — automatizzarlo nel workflow di release evita utenti bloccati.
- Il pattern Sparkle di Codex (chiave pubblica pinnata nel client, appcast su CDN) su
  Electron equivale a: electron-updater con firma verificata — già ok su macOS; il punto
  è estendere la catena di fiducia alle altre piattaforme.

## 5. Hardening Electron residuo (🟡 P2)

Homun ha già il quartetto giusto (contextIsolation, sandbox, nodeIntegration:false,
window-open→openExternal). Restano, tutti economici:
- **CSP** sul renderer packaged (Codex ha il tag CSP nel template HTML).
- **Fuses** (`@electron/fuses`): disabilitare `runAsNode`, `nodeCliInspect` nel packaged —
  chiude i vettori "lancia l'app con ELECTRON_RUN_AS_NODE".
- **DevTools off** nel packaged (webPreferences `devTools:false` salvo flag sviluppatore).
- **Permission handler**: già whitelist-only (solo `media`) ✅.
- **Token gateway**: oggi Bearer in env del processo — su loopback va bene, ma il passo
  SOTA è **Unix domain socket** (il default di Codex: `app-server --listen unix://`) →
  niente porta TCP, niente token nell'environ, ACL del filesystem. Si sposa con la mossa
  strutturale "stacca il loop dal gateway" del doc gemello.

## 6. Deep link, istanza unica, integrazione OS (🟡 P2)

- **`homun://`** protocol handler: serve *già ora* per OAuth callback dei connettori
  (Composio/MCP remoti) e in prospettiva per install di plugin e "apri conversazione".
  Codex instrada: `connectorOAuthCallback`, `pluginInstall`, `localConversation`,
  `settings` — con risoluzione del workspace target via git origin.
- **Single-instance lock** (vedi §2) + routing della seconda istanza sulla prima.
- **Usage descriptions macOS complete** (camera/mic/desktop/Apple Events): Homun ne avrà
  bisogno appena il computer-use locale esce dal container (oggi il contained-computer
  evita il problema; il giorno che tocchi lo schermo dell'utente, servono).

## 7. Plugin e skills — il formato che manca alla roadmap F0–F3 (🟡 P2, prodotto)

Il formato Codex è la versione "spedibile" di ciò che la roadmap plugin di Homun
([roadmap.md] F0–F3, north star Manus) descrive:

```
plugin/
├── .codex-plugin/plugin.json   # name, version, mcpServers, skills, apps
│   └── interface: displayName, category, capabilities, brandColor,
│       logo, privacyPolicyURL, termsOfServiceURL   ← metadata da marketplace
├── skills/<nome>/SKILL.md      # YAML frontmatter (name, description) + prosa
└── .mcp.json                   # server MCP del plugin
```

Tre proprietà da copiare: (1) **un solo formato** per skill-prosa + MCP + app UI — non tre
sistemi; (2) i **metadata di marketplace nel manifest** dal giorno uno (categoria, brand,
privacy policy) — rendono il catalogo possibile senza rework; (3) le skill dichiarano
**fallback chain** ("preferisci l'API dedicata, poi UI automation") e confirmation
policies. Homun ha già il registry unico (caposaldo #7) e le skill filesystem: il gap è il
**manifest installabile** e il ciclo install/update/remove.

**Idea da rubare interamente:** il plugin `record-and-replay` (chronicle + event-stream
MCP) *genera skill dalle dimostrazioni dell'utente* — registra 30 min di
click/tastiera/accessibility-diff e ne distilla una skill riusabile. Homun ha già le
tabelle `routines`/`automation_candidates` (pattern→automazione appresa): è la stessa
idea, ma Codex chiude il cerchio trasformando il pattern in **skill eseguibile**. È la
convergenza naturale di memoria (differenziatore #1) + plugin roadmap.

## 8. Test ed evidenza (🟡 P2)

- Unit Rust: buona base (423 verdi). Mancano: **e2e** (Playwright può pilotare Electron —
  Codex ha `playwright-electron-agent-cdp` negli script), **test JS** (zero oggi), e un
  **contract-test UI↔gateway** (gli eventi NDJSON tipizzati di ChatEventPart sono il posto
  giusto: uno snapshot-test del protocollo previene le regressioni marker/parts).
- La validazione oggi è *live manuale* (curl-driving, app reale) — ottima per scoprire,
  non ripetibile. Ogni bug validato live merita il suo test di contratto.

## 9. Cosa NON copiare da Codex

- **`NSAllowsArbitraryLoads=true`** (ATS disattivato): scorciatoia insicura, Homun non ne
  ha bisogno.
- **Cloud-lock**: il fallback routing server-side sui modelli è l'antitesi del caposaldo
  #3; il motore cross-modello di Homun è il differenziatore, non un gap.
- **Manifest policy da 7.690 righe** (template Chromium enterprise): rumore ereditato, non
  design.
- **Telemetria di esperimento sempre-on**: per Homun la diagnostica è opt-in o locale
  (vedi §1), è una scelta di prodotto, non un ritardo.

---

## Piano d'azione proposto (ordine di ROI, effort ≈ S/M/L)

**P0 — igiene di produzione (senza questo, ogni bug utente è cieco): ✅ FATTO (2026-07-02, branch
`feat/p0-production-hygiene`). Dettaglio in [architecture/desktop-shell.md](architecture/desktop-shell.md).**
1. ✅ (S) Single-instance lock + second-instance routing (focus della prima finestra; guardia in
   `whenReady`). `main.cjs`, commit `5146a524`.
2. ✅ (M) Log su file con rotazione (`electron/lib/logging.cjs`, 5×5MB) per gateway e main Electron;
   panic hook Rust (`panic_log.rs`) con backtrace + crash-marker (file 0600); stdio del gateway NON
   più `ignore` ma piped→`~/.homun/logs/gateway.log`. Commit `8a240350`/`60f4c1af`, `cf4bda15`/`362b8ad7`.
   (Scelta: cattura stdio invece di `tracing-appender` — è il punto di leva minimo finché il motore
   non è separato; vedi doc gemello §strutturale.)
3. ✅ (S) "Segnala un problema" = tar.gz locale di **soli** log + report.json (versioni/specs), mai i
   `.sqlite` (caposaldo #3), copia symlink-safe. Commit `c7bc4e50`/`6383646e`.
4. ✅ (M) Recovery SQLite: `PRAGMA quick_check` all'avvio, quarantena (mai delete) dei **soli** DB
   davvero corrotti — busy/locked = inconclusive → non toccato (evita il data-loss), esito in
   `/api/health`; watchdog respawn gateway con backoff 1s→5s→15s + give-up dopo 3 crash/5min.
   Commit `0625634f`/`d470b1b3`, `6b0940d1`/`4188f653`.

**P1 — enforcement e fiducia:**
5. ⏳ (M) Sandbox-mode a 3 livelli imposto dal gateway sull'esecuzione shell/file
   (sandbox-exec su macOS), + approval policy unica a 4 livelli in Settings. **In attesa:** va
   progettato con la separazione motore/gateway (il punto di enforcement si sposta).
6. ⏳ (M) Firma Windows + integrità Linux; publish automatico del draft release. **Bloccato su
   input utente:** firma = certificati/segreti (Azure Trusted Signing); auto-publish = decisione di
   processo (ribalta il gate draft deliberato di `build.yml`).
7. ✅ (S) Fuses + CSP + devTools off nel packaged (2026-07-02, branch `feat/p1-hardening`, commit
   `3811b46b`+`39d3cc8e`; vedi [architecture/desktop-shell.md](architecture/desktop-shell.md)).

**P2 — prodotto e piattaforma:**
8. (M) `homun://` protocol handler (OAuth callback prima, plugin install poi).
9. (L) Manifest plugin installabile (formato §7) sopra il registry esistente.
10. (M) E2E Playwright-Electron smoke (avvio→chat→risposta→artifact) in CI.
11. (L) Gateway su Unix domain socket (insieme alla separazione motore/gateway del doc gemello).

**P3 — differenziazione:**
12. (L) Routine→skill: chiudere il cerchio `automation_candidates` → skill eseguibile
    (la versione Homun, memoria-centrica, del record-and-replay di Codex).

> Nota di metodo: P0 è quasi tutto *ortogonale* alla convergenza architetturale in corso
> (ADR 0021/0022) — si può fare subito senza toccare il motore. P1.5 (sandbox) e P2.11
> (UDS) invece si progettano insieme alla separazione del motore, per non farli due volte.

---

## Fonti / evidenza

- Codex main bundle: `.vite/build/main-CNod9zFW.js` (sparkleManager, sandboxPolicy,
  state reconciliation `state_5.sqlite`, SSH bootstrap app-server), `preload.js` (canali
  `codex_desktop:*`), `sandbox-preload.js` (origin whitelist `web-sandbox.oaistatic.com`),
  `file-based-logger-*.js`, `feedback-desktop-log-archive-*.js`, `trace-recording-upload-*.js`.
- Codex package.json: `codexSparkleFeedUrl`/`codexSparklePublicKey`, `@sentry/electron`,
  `@electron/fuses`, better-sqlite3/node-pty/objc-js, workspace pkgs `app-server-types`/
  `protocol`/`commands`.
- Binari: `codex` (codex-cli 0.142.5; subcommand `app-server`/`sandbox`/`mcp`/`plugin`;
  approval/sandbox strings), `codex_chronicle` (sparse screen-memory capture),
  `cua_node/` (Node 24.14, playwright-core, tesseract.js, sharp).
- Plugin bundled: `Resources/plugins/openai-bundled/` — computer-use, record-and-replay,
  browser, chrome, sites, latex, marketplace (manifest `.codex-plugin/plugin.json`).
- Info.plist: `codex://`, usage descriptions, Sparkle 2.9.1, min macOS 12; provisioning
  profile team 2DC432GLL2, keychain-access-groups.
- Homun: `apps/desktop/electron/main.cjs` (webPreferences, spawn gateway, health check,
  `stdio: ignore`), `apps/desktop/package.json`, `.github/workflows/{build,ci}.yml`,
  `crates/task-runtime/src/approval.rs`, `crates/capabilities/src/policy.rs`,
  entitlements `build/entitlements.mac.plist`.
