# Settings: lingue es/fr/de + factory reset — design

Data: 2026-07-19 · Stato: **Design approvato da Fabio** (reset = factory reset TOTALE). Feedback dall'app: mancano le traduzioni es/fr/de; "Delete local data" non pulisce nulla.

## Problema

1. **Lingue**: il gateway supporta già `en/it/es/fr/de` (`SUPPORTED_LANGUAGES`, main.rs:27063), quindi il
   picker in Settings le offre — ma esistono solo i file di traduzione **UI** `en`/`it`. Selezionando
   es/fr/de l'app cade in **fallback su inglese** (`fallbackLng:"en"`). Mancano i JSON es/fr/de.
2. **Delete local data**: il bottone in `SettingsView` è **DISABILITATO** (`disabled title="availableSoon"`)
   — un placeholder mai implementato. Serve un vero **factory reset** che pulisca tutto per ripartire da zero.

## Task A — Lingue es/fr/de (solo UI, offline)

Puramente meccanico: creare i cataloghi tradotti + registrarli. Nessuna modifica al gateway (già
lingua-agnostico: `response_language_instruction` chiede di rispondere nella lingua dell'utente).

**Creare (traduzione COMPLETA e professionale, nomi propri come "Homun"/brand invariati):**
- `apps/desktop/src/i18n/locales/{es,fr,de}.json` — dal catalogo main `en.json` (1277 chiavi leaf).
- `apps/desktop/src/plugins/presentations/locales/{es,fr,de}.json` — da `en.json` (49 chiavi).
- `apps/desktop/src/plugins/proattivita/locales/{es,fr,de}.json` — da `en.json` (20 chiavi).

**Registrare:**
- `apps/desktop/src/i18n/index.ts`: import `es/fr/de` + aggiungerli a `resources` (`es:{translation:es}`, …).
- `apps/desktop/src/plugins/presentations/index.tsx` e `.../proattivita/index.tsx`: `addResourceBundle`
  per `es`/`fr`/`de` (namespace del plugin), accanto ai due esistenti.

**Struttura chiavi = identica a `en.json`** (stesse chiavi, valori tradotti). `fallbackLng:"en"` copre
eventuali buchi senza crash. `returnNull:false` già impostato.

## Task B — Factory reset totale (Electron-main-orchestrated)

### Chi orchestra

L'**Electron main** possiede il lifecycle (spawn/kill del gateway, restart dell'app); il gateway tiene i
SQLite di `~/.homun` **aperti** e non può auto-cancellarsi. Quindi il reset vive nel main.

### Flusso (nuovo IPC `lfpa:factory-reset`)

1. **`isResetting = true`** — un flag modulo (accanto a `isQuitting`) che impedisce il **respawn** del gateway
   (main.cjs ha un respawn-on-exit: `if (!isQuitting && !gatewayProcess) spawnGateway()` → aggiungere
   `&& !isResetting`).
2. **Kill del gateway** (`gatewayProcess.kill()`), attesa dell'uscita (i file `~/.homun` si liberano). Se il
   processo non c'è, prosegui.
3. **`rm -rf ~/.homun`** (`fs.promises.rm(join(os.homedir(), ".homun"), {recursive:true, force:true})`) — rimuove
   homun.sqlite (chat/thread/routing bindings), memory.sqlite, il **vault SQLite** (tabella
   `vault_local_keyring` = master key wrapped → il vault diventa irrecuperabile), brand kit, sessioni
   canali, prefs (lingua/provider). ⚠️ È lo step **critico** del reset.
4. **Keychain best-effort**: se il vault ha una syskey OS-keychain, cancellarla (l'implementer verifica in
   `crates/vault`/`crates/secrets`; se la syskey è machine-derived o non presente, saltare). **Non-critico**:
   una syskey orfana è innocua senza la wrapped-key (già cancellata al passo 3). Fail-open.
5. **Clear localStorage UI**: `session.defaultSession.clearStorageData({ storages: ["localstorage"] })` —
   azzera il mirror UI (lingua/tema/settings in `lfpa.settings.*`). L'**onboarding riappare da solo**: è
   guidato dal gateway (`status.needs_setup`, che ridiventa true con `~/.homun` vuoto), non da un flag UI.
6. **Relaunch**: `app.relaunch(); app.exit(0);` → al riavvio gateway + stores si ricreano puliti → onboarding.

Handler robusto: ogni passo in try/catch, si logga e si prosegue (il reset non deve bloccarsi a metà). Il
worst-case (un passo fallisce) lascia comunque `~/.homun` cancellato = reset effettivo.

### Wiring UI

- **`electron/preload.cjs`**: esporre `factoryReset: () => ipcRenderer.invoke("lfpa:factory-reset")` in
  `localFirstDesktop`.
- **`apps/desktop/src/lib/coreBridge.ts`**: wrapper `factoryReset()` (via `window.localFirstDesktop`),
  no-op sicuro su web (`IS_DESKTOP` false).
- **`SettingsView.tsx`**: togliere `disabled`; al click aprire un **dialog di conferma** (irreversibile,
  cancella anche le chiavi API, riavvia l'app) — conferma singola esplicita (lo scope "totale" è già stato
  deciso; niente doppio-step). Su conferma → `factoryReset()`.
- **i18n**: `deleteLocalData`/`deleteLocalDataDesc`/`deleteData` esistono; aggiornare la desc per riflettere
  "cancella TUTTO incl. chiavi API, riavvia l'app da zero"; aggiungere le stringhe del dialog di conferma
  (titolo/corpo/annulla/conferma) in **tutte le 5 lingue** (coerente con Task A).

## Invarianti / coerenza

- **Local-first**: il reset è interamente locale (nessuna rete); le lingue sono bundled (nessun fetch).
- **Fail-open**: il reset prosegue anche se un passo secondario (keychain) fallisce; le lingue mancanti →
  fallback en.
- **Converge**: le lingue riusano la struttura chiavi di `en.json`; il reset riusa il pattern IPC esistente
  (`ipcMain.handle("lfpa:…")` + preload + coreBridge).
- **Sicurezza**: reset dietro conferma esplicita; è l'unica azione che cancella il vault → il dialog lo dice
  chiaramente.

## Test

- Task A: `npm run build` (tsc valida i JSON importati) + un check che ogni catalogo es/fr/de abbia lo
  **stesso set di chiavi** di en.json (script/test anti-drift) + `test:ui-contract`/`test:electron` verdi.
- Task B: `npm run build` + `test:electron` (il wiring IPC/preload/coreBridge compila e non rompe i test
  esistenti). Il reset end-to-end (kill+wipe+relaunch) è **distruttivo** → validazione a schermo di Fabio
  (non computer-verify); l'handler è strutturato in passi try/catch loggati.
- Gate: `cargo test -p local-first-desktop-gateway` (non toccato) + `pre_release_gate.py`.

## Esclusioni (YAGNI)

- Traduzione di stringhe generate dal modello/gateway a runtime (già lingua-agnostiche via reply-language).
- Reset selettivo / granulare (solo chat, solo memoria) — fuori scope, è "totale".
- Reset del container Docker (`homun-cc` si ricrea da sé) o della userData Electron oltre il localStorage
  (window geometry cosmetica).
- Doppio-step di conferma (scope già deciso "totale"; conferma singola esplicita basta).

## Rischi

- **Kill+relaunch su Electron dev vs packaged**: `app.relaunch()` si comporta diversamente in `electron .`
  dev vs app firmata; testare in packaged. In dev, il relaunch potrebbe non ripartire pulito — documentare.
- **Volume traduzioni**: 1346 chiavi × 3 lingue ≈ 4000 stringhe → parallelizzare su subagent per qualità +
  test anti-drift che garantisce parità di chiavi con en.
- **Timing kill→wipe**: cancellare `~/.homun` mentre il gateway ha ancora un handle aperto (kill async non
  ancora completato) può fallire su Windows (file lock). Attendere l'evento `exit`/`close` del processo
  prima del `rm` (o retry breve).
