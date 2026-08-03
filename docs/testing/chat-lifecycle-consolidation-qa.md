# Chat Lifecycle Consolidation QA

Date: 2026-08-03
Branch: `fabio/chat-lifecycle-consolidation`

## Automated Gate

Da `/Users/fabio/Projects/Homun/app/.worktrees/chat-lifecycle-consolidation`:

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

- `test:cursor-grammar`: 97 passed.
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
