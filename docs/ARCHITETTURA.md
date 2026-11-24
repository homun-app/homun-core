# Architettura — la mappa

Uno stesso eseguibile Electron, due modalità (src/main/mode.ts: `--homun-daemon`); la UI è un client sottile del daemon.

## I processi

- **main (Electron, senza flag)** — finestra, tray, deep link, updater; gira nel processo `src/main/index.ts`. Serva la UI col protocollo `homun://app/` e fa da client del daemon.
- **daemon (`--homun-daemon`)** — stesso eseguibile, niente finestre (activation accessory): loop degli agenti, coda durevole, scheduler/routine, sandbox, MCP, memoria, modello locale (`src/daemon/runtime.ts`). Vive anche a finestra chiusa; il main lo spawna e lo sorveglia (`src/main/daemon-client.ts`).
- **renderer** — React (src/renderer), pagina in `homun://app/`, sandbox: true, nessuna rete del bot.

Canali (chi → chi, come):

- **renderer → main**: IPC Electron (`ipcRenderer.invoke` via preload; canali `agents:*`, `chat:send`…). Le RPC sono inoltrate 1:1 al daemon (`src/main/ipc.ts`); restano locali solo finestre/dialoghi. Eventi push dal main sul canale `sandbot:event`.
- **main ↔ daemon**: WebSocket su **127.0.0.1, porta casuale**; token in file 0600 nella dir dati, hello obbligatorio entro 5 s (`src/daemon/ws-server.ts`, `src/main/ws-client.ts`). RPC in **entrambe** le direzioni: il daemon chiama la UI per le API host (notifiche, safeStorage, screen — `src/daemon/host-bridge.ts`; senza UI degrada: osascript, vault bloccato).
- **stessa porta HTTP del WS**: `GET /screen/<capability>` e `/term/<capability>` (vista dal vivo e terminale del box, noVNC/xterm) con capability base64url a 32 byte; `POST /hooks/<routineId>` per i webhook delle routine.
- **daemon → box**: spawn della CLI del motore scelto (`src/main/sandbox/engine.ts`): `docker` (docker-engine.ts) o Apple `container` (apple-container-engine.ts, macOS ≥ 26); argv costruiti da funzioni pure (docker-argv.ts, apple-container-argv.ts).
- **daemon → llama-server**: processo figlio affiancato di proprietà del daemon (bundle in `vendor/llama`, scaricato da `scripts/fetch-llama.mjs`); HTTP OpenAI-compatible su 127.0.0.1 porta libera, chiave casuale nell'env `LLAMA_API_KEY` (mai in argv); spegnimento dopo 10 min di inattività (`src/daemon/local-model-server.ts`).
- **Engramma (memoria)**: non è un processo — modulo nativo N-API `.node` (vendor/engramma, preparato da `scripts/prepare-engramma.mjs`, verificato via SHA256 da engramma.lock.json) caricato **in-process** dal daemon: `Engine.open` su `<data>/memory`, celle `bot-<id>` (`src/main/memory/engine.ts`).
- **daemon → internet**: solo i canali deliberati — provider LLM configurati, ricerca web (limiti in `src/shared/web-limits.ts`), Composio e registro npm per i connettori.

## Dove sta cosa

- `src/main/` — il main Electron: IPC, finestre/tray, `store/` (SQLite + migrazioni), `sandbox/` (box), `agent/` (loop e tool del bot), `connectors/` (app/MCP/marketplace), `mcp/`, `memory/` (Engramma), `vault.ts`, `permissions.ts`.
- `src/daemon/` — il runtime del daemon: ws-server, scheduler, run-job/worker, keychain, master-keys, local-model, presence, outbox.
- `src/renderer/` — la UI React (bot, chat, impostazioni); `src/preload/` — il bridge contextBridge (unica superficie API del renderer); `src/shared/` — tipi e moduli puri condivisi; `src/types/` — ambient d.ts.
- **DB**: SQLite via `node:sqlite` in `<dataDir>/sandbot.db` (WAL, secure_delete). `dataDir` = `<userData>/data`, dove userData è **`~/Library/Application Support/sandbot`** (minuscolo, storico — `src/main/paths.ts`); override con `--data`, `SANDBOT_DATA_DIR`, `SANDBOT_TEST_USER_DATA`.
- **Tabelle principali** (`src/main/store/db.ts` + DDL importate): `agents` (i bot, con archiviazione morbida), `entries` (transcript event-sourced), `settings` (chiave/valore), `grants` (permessi concessi, per bot e con scadenza), `approvals` (indice delle richieste pendenti + registro delle decisioni), `routines` (scheduler/trigger), `outbox`, `tasks`, `model_usage` (token/costi), `jobs`, `routine_runs`, `groups` + `group_members/group_messages/group_cursors/group_turns`, `shell_jobs`, `subagents`, `library_items`, `computer_actions`, `tool_use`.
- **File dell'utente** in Application Support/sandbot: `data/sandbot.db` (+ WAL), `data/keys.json` (0600 — chiavi master cifrate con safeStorage), `data/models/` (GGUF), `data/memory/` (Engramma), `logs/` (daemon, lifecycle, llama-server a rotazione). **Cassaforte**: voci cifrate AES-256-GCM nel setting `vault.secrets`, chiave master in `data/keys.json` avvolta da safeStorage/Keychain (`src/main/vault.ts`, `src/daemon/master-keys.ts`).

## Gli invarianti

- **Migrazioni DB solo additive**: `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN` solo se la colonna manca (guardia su `pragma_table_info`), mai DROP/RENAME — si legge in `src/main/store/db.ts` e nei moduli mirati (`mcp-migrations.ts`, `settings-migrations.ts`, `skills-migrations.ts`); i test delle migrazioni creano DB vecchi e verificano che sopravvivano.
- **Chiavi**: mai in chiaro su disco, mai nell'argv di un processo (`LLAMA_API_KEY` in env; comandi `security -i` da stdin). Una chiave master **non si rigenera mai** sopra dati sigillati o voci illeggibili (K1 in `master-keys.ts`). SAFEStorage è il backend iniettabile: nei test `SANDBOT_TEST_FAKE_KEYCHAIN`/`FAKE_SAFESTORAGE`, mai il vero.
- **Cosa non esce dalla macchina**: dati e chiavi non lasciano l'host se non verso i provider/configurazioni scelti dall'utente; i valori dei segreti non finiscono mai in transcript/entry/log; i comandi del box Apple non escono in rete (rete `--internal`), Docker bridge sì via NAT (`box-egress.ts`); i tool dei connettori sono proposti solo nei turni nati da un messaggio diretto dell'utente (`connectors-policy.ts`).
- **Nessun Docker/container vero nei test**: gli argv sono funzioni pure confrontate senza spawn (`docker-argv.test.ts`); `src/test-setup.ts` punta `HOMUN_CONTAINER_PATH` su un percorso inesistente (la CLI reale risponde ENOENT); `SANDBOT_DATA_DIR` sempre su una temporanea; `test-tmp-guard.ts` (globalSetup) fallisce la corsa se resta una cartella `sandbot-*`.

## I comandi

- **Sviluppo**: `npm run dev` (electron-vite; predev prepara wasm + Engramma) · `npm test` (vitest) · `npm run test:ci-sim` (come la CI: macOS 15 finto, modelli locali assenti) · `npm run typecheck` · `npm run build` · `node scripts/fatto.mjs [--sonde <nomi>]` (chiude una fase: passi uno alla volta, esito in `fatto-esito.md`, controllo di temporanee e processi residui).
- **Sonde**: `node scripts/fase-<nome>-probe.mjs` — l'app vera (`out/`) su dati temporanei, con modello finto OpenAI-compatible su 127.0.0.1 e flussi UI via CDP; rete solo su 127.0.0.1. Variabili dell'ambiente finto (`SANDBOT_TEST_*`, le più usate):

  - `SANDBOT_TEST_USER_DATA` — sposta l'intera cartella dati dell'app (override di userData): le prove non toccano mai i dati veri.
  - `SANDBOT_TEST_FAKE_KEYCHAIN` — file che sostituisce il Keychain (runner `security` finto).
  - `SANDBOT_TEST_FAKE_SAFESTORAGE` — backend safeStorage finto per le chiavi master.
  - `SANDBOT_TEST_TMP_BASE` — base delle mkdtemp dei test (deve esistere; la usano ci-sim e il guard).
  - `SANDBOT_TEST_NO_LOCAL_MODELS` — toglie i modelli locali dal catalogo (condizione della CI).
  - `SANDBOT_TEST_FAKE_MACOS_MAJOR` — versione di macOS finta (decide il motore del box).
  - `SANDBOT_TEST_FAKE_BROWSER_MCP` / `SANDBOT_TEST_FAKE_BROWSER` — server MCP del browser finto / browser del bot finto.
  - `SANDBOT_TEST_COMPOSIO_MCP_URL` — punta il gateway Composio su un MCP di prova.
  - `SANDBOT_TEST_MCP_URLS` — mappa JSON id→url che sposta voci del catalogo connettori.
  - `SANDBOT_TEST_CONTAINER_LOG` / `SANDBOT_TEST_CONTAINER_MODE` — log e comportamento della CLI `container` finta (scripts/fake-container.mjs).
  - `SANDBOT_TEST_APP_CONNECT_TIMEOUT_MS` — accorcia il timeout del «Connetti» app.
