# Kernel Contract Matrix

Verificato 2026-08-03 sul branch `fabio/chat-lifecycle-consolidation`.

Questa matrix e' il punto di ingresso per consolidare il kernel senza nuove
feature. Prima di dichiarare chiusa una regressione in questo perimetro:

```bash
python3 scripts/kernel_regression_gate.py
```

Se la regressione coinvolge browser, modello selezionato, gateway reale o
reasoning visibile dopo streaming:

```bash
HOMUN_RUN_KERNEL_LIVE_SMOKE=1 python3 scripts/kernel_regression_gate.py
```

## Contratti

| Contratto | Owner canonico | Persistenza/API | UI owner | Gate |
| --- | --- | --- | --- | --- |
| Stato durable del turno | `crates/task-runtime/src/turn_lifecycle.rs` | `tasks.status` | `apps/desktop/src/lib/chat-runtime/lifecycle.ts` | `cargo test -p local-first-task-runtime turn_lifecycle` |
| Enqueue e turno attivo chat | `crates/task-runtime/src/broker.rs`, `crates/task-runtime/src/store.rs` | `tasks`, `turn_events` | composer mode | `cargo test -p local-first-task-runtime active_chat_turn`; `cargo test -p local-first-task-runtime enqueue_` |
| Finalizzazione non bloccante | `crates/task-runtime/src/turn_lifecycle.rs` | SQL-only `finalizing` | activity/thinking state | `cargo test -p local-first-task-runtime finalizing` |
| Steering terminale | `crates/task-runtime/src/store.rs`, `crates/desktop-gateway/src/main.rs::finalize_turn_steering` | `turn_steering` | `apps/desktop/src/lib/chat-runtime/steering.ts` | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway steering` |
| Risposta assistente visibile | `apps/desktop/src/lib/chat-rendering/visibleContent.ts` | messages/events text | transcript | `cd apps/desktop && npm run test:cursor-grammar` |
| Composer/runtime footer | `apps/desktop/src/components/ComposerShell.tsx`, `apps/desktop/src/lib/runtimeContext.ts` | `/api/runtime/model`, `/api/chat/threads/{id}/runtime-context` | composer footer | `cd apps/desktop && npm run test:cursor-grammar` |
| Layout chat/browser/activity | `apps/desktop/src/styles/chat.css`, `apps/desktop/src/styles/workspace-island.css` | live computer/browser polling | workspace island / transcript | `cd apps/desktop && npm run test:ui-contract`; `cd apps/desktop && npm run build` |
| Runtime browser dev | `apps/desktop/scripts/browser-runtime.mjs`, `apps/desktop/scripts/electron-dev.mjs` | `HOMUN_BROWSER_AUTOMATION_DIR` | Activity/browser island | `node --test tests/contained-computer-package.test.mjs`; live smoke opt-in |
| Gateway Bearer auth | `crates/desktop-gateway/src/gateway_auth.rs` | `Authorization: Bearer <token>` | `apps/desktop/src/lib/gatewayConfig.ts` | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_auth`; `cd apps/desktop && npm run test:ui-contract` |

## Smoke Live

`scripts/kernel_live_smoke.py` crea un thread fresco, invia un prompt che forza
il browser su `https://www.selenium.dev`, aspetta il run terminale e verifica che
la risposta finale contenga `Selenium` senza marker di reasoning/tool activity.

Questo smoke non sostituisce lo smoke visuale Electron per regressioni di layout,
ma intercetta le regressioni in cui il modello e' selezionato correttamente e il
gateway parte, pero' il browser fallisce solo al primo uso reale.
