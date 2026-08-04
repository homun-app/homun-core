# Chat Lifecycle Consolidation QA

Date: 2026-08-03
Branch: `fabio/chat-lifecycle-consolidation`

## Automated Gate

Da `/Users/fabio/Projects/Homun/app/.worktrees/chat-lifecycle-consolidation`:

```bash
python3 scripts/kernel_regression_gate.py
```

Il gate sopra e' ora il wrapper canonico per i controlli sotto.

```bash
cargo fmt --check
cargo test -p local-first-task-runtime turn_lifecycle
cargo test -p local-first-task-runtime active_chat_turn
cargo test -p local-first-task-runtime finalizing
cargo test -p local-first-task-runtime enqueue_
cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway steering
```

Esito: PASS.

Dettaglio osservato:

- `turn_lifecycle`: 6 passed.
- `active_chat_turn`: 5 passed.
- `finalizing`: 6 passed.
- `enqueue_`: 10 passed.
- gateway `steering`: 18 passed.

Da `apps/desktop`:

```bash
npm run test:cursor-grammar
npm run test:ui-contract
npm run build
```

Esito: PASS.

Dettaglio osservato:

- `test:cursor-grammar`: 98 passed.
- `test:ui-contract`: passed.
- `build`: TypeScript + Vite production build passed.

## Renderer Smoke

Le porte standard `1420` e `18765` erano occupate da una sessione dev del
worktree principale (`/Users/fabio/Projects/Homun/app`). Per non chiuderla, il
renderer del branch e' stato servito separatamente su `127.0.0.1:1421` e
collegato al gateway dev esistente.

Comando:

```bash
cd apps/desktop
VITE_HOMUN_DESKTOP_GATEWAY_URL=http://127.0.0.1:18765 \
  npx vite --host 127.0.0.1 --port 1421
```

Controlli DOM/CSS via Playwright:

| Controllo | Esito |
| --- | --- |
| `.chat-message-user-band` presente | PASS |
| Messaggio utente allineato a destra | PASS (`align-self: flex-end`) |
| Messaggio utente senza bordo | PASS (`border-top-width: 0px`) |
| Messaggio utente senza fondo | PASS (`background-color: rgba(0, 0, 0, 0)`) |
| Editor inline presente dopo click edit | PASS |
| Editor inline multilinea | PASS (`min-height: 96px`) |
| Editor inline non microscopico | PASS (`min-width: min(420px, 100%)`) |
| Dock computer/browser nascosto con isola aperta | PASS (`display: none`) |

Questo e' uno smoke renderer, non uno smoke Electron completo: una seconda
istanza Electron avrebbe usato lo stesso single-instance lock del profilo Homun
gia' aperto.

## Electron Smoke

La sessione dev principale e' stata chiusa, poi Vite e' stato avviato dal
branch su `127.0.0.1:1420`. Electron e' stato lanciato via Playwright dal
worktree `fabio/chat-lifecycle-consolidation`, usando il gateway binario
compilato e `HOMUN_WORKSPACE_ROOT` puntato al worktree.

Esito iniziale: lo smoke ha trovato due regressioni ancora aperte:

- il footer mostrava `Runtime & Context` come testo del bottone invece della
  sola icona;
- il bottone modello mostrava `Unavailable` anche se `/api/runtime/model`
  riportava `deepseek-v4-flash` e il runtime context del thread riportava
  `deepseek-v4-pro`.

Fix applicato nello stesso branch:

- `ComposerShell` usa `modelButtonLabel` per il bottone modello e mantiene
  `effectiveModelLabel` separato come provenienza messaggio;
- il trigger runtime e' icon-only con `aria-label` e `title`;
- `RuntimeContextPanel` mostra usage bar, percentuale, token usati/window e
  legenda contributi prima dei dettagli runtime.

Controlli Electron reali post-fix:

| Controllo | Esito |
| --- | --- |
| Footer model label | PASS (`deepseek-v4-pro`, non `Unavailable`) |
| Runtime trigger icon-only | PASS (`innerText=""`, `aria-label="Runtime & Context"`) |
| Runtime panel con progressbar | PASS (`aria-valuenow=25`) |
| Runtime panel con legenda contributi | PASS (5 righe + 5 swatch) |
| Messaggio utente senza bubble | PASS (`border-top-width: 0px`, background trasparente) |
| Editor inline multilinea | PASS (`min-height: 96px`, `min-width: min(420px, 100%)`) |
| Activity island aperta | PASS |
| Dock computer/browser nascosto con island aperta | PASS (`display: none`) |
| Marker reasoning/tool visibili nella transcript | PASS (nessun match per `<think`, `REASONING`, `tool_call`) |
| Steering stale su HITL corrente | PASS (`Waiting for you` resta visibile, nessuna card `Applying`) |

## Browser Smoke

Root cause osservata prima del fix dev-runtime:

- `browse` veniva attivato dal modello, ma `browser_navigate` falliva con
  `Navigation failed: sidecar:sidecar closed unexpectedly`.
- Riproduzione diretta da `runtimes/browser-automation`:
  `npm run start` falliva per assenza di
  `node_modules/tsx/dist/cli.mjs`.

Fix applicato:

- `apps/desktop/scripts/browser-runtime.mjs` prepara il runtime browser dev con
  `npm ci` se manca l'entrypoint `tsx`;
- `apps/desktop/scripts/electron-dev.mjs` passa `HOMUN_BROWSER_AUTOMATION_DIR`
  al gateway, evitando dipendenza dal path compilato nel binario Rust.

Smoke fresco via broker reale:

| Controllo | Esito |
| --- | --- |
| Thread fresco | PASS (`thread_1785758748_1785758748855732000`) |
| Turn fresco | PASS (`turn_chat_stream_1785758761_smoke_browser_20260803`) |
| Browser live durante il turno | PASS (`active=true`, thread corretto) |
| Turn terminale | PASS (`status=completed`, `canonical_completed`) |
| Risposta finale | PASS (`document.title` = `Selenium`) |
| Prova CDP | PASS (tab `https://www.selenium.dev/`, title `Selenium`) |

Lo smoke e' stato reso rieseguibile con:

```bash
HOMUN_RUN_KERNEL_LIVE_SMOKE=1 python3 scripts/kernel_regression_gate.py
```
