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
| Gateway main ownership | `scripts/check_gateway_main_contract.py`, `crates/desktop-gateway/src/main.rs` | startup owner delegation, forbidden extracted boot snippets | startup orchestration only | `python3 scripts/check_gateway_main_contract.py`; `python3 scripts/kernel_regression_gate.py` |
| Gateway paths | `crates/desktop-gateway/src/gateway_paths.rs` | `HOMUN_DATA_DIR`, `HOMUN_DESKTOP_GATEWAY_DB`, store-specific DB overrides | boot stores / migrations / logs | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_paths`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway file security | `crates/desktop-gateway/src/gateway_file_security.rs` | 0600 private file writes, top-level data-store hardening | generated local secrets / data-at-rest repair | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_file_security`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway vault key | `crates/desktop-gateway/src/gateway_vault_key.rs` | `HOMUN_VAULT_WRAP_KEY`, macOS keychain, `vault-wrap-key` fallback | vault unlock / local secret persistence | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_vault_key`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway identity scope | `crates/desktop-gateway/src/gateway_identity.rs` | `HOMUN_USER_ID`, `HOMUN_WORKSPACE_ID`, active workspace, memory workspace override | task/chat/memory/capability scoping | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_identity`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway secrets | `crates/desktop-gateway/src/gateway_secrets.rs` | `secret-key`, `secrets.json`, `browser-checkpoint-secrets.json` | provider API keys / browser checkpoint secrets | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_secrets`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway legacy data dir | `crates/desktop-gateway/src/gateway_legacy_data.rs` | old `~/.local-first-personal-assistant`, new `~/.homun` | startup migration before store open | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_legacy_data`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway bind address | `crates/desktop-gateway/src/gateway_bind.rs` | `HOMUN_DESKTOP_GATEWAY_HOST`, `HOMUN_DESKTOP_GATEWAY_PORT`, fallback `PORT` | Electron/gateway process boundary | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_bind`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway task executor config | `crates/desktop-gateway/src/gateway_task_executor_config.rs` | `HOMUN_TASK_EXECUTOR_WORKER`, `HOMUN_TASK_WORKER_COUNT`, stable worker ids | task executor startup/status | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_task_executor_config`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway model timeouts | `crates/desktop-gateway/src/gateway_model_timeouts.rs` | `HOMUN_MODEL_TIMEOUT_SECS`, `HOMUN_MODEL_HEADERS_TIMEOUT_SECS`, `HOMUN_MODEL_IDLE_TIMEOUT_SECS`, `HOMUN_MODEL_FIRST_TOKEN_SECS` | model transport timeout policy | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_model_timeouts`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway DB unification | `crates/desktop-gateway/src/gateway_db_unify.rs`, `crates/desktop-gateway/src/db_migrate.rs` | legacy `desktop-gateway.sqlite`, legacy `task-runtime.sqlite`, unified `homun.sqlite` | startup before store open | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_db_unify`; `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway db_migrate`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway HTTP client | `crates/desktop-gateway/src/gateway_http_client.rs` | `HOMUN_HTTP_CONNECT_TIMEOUT_SECS` | outbound model/embedding/privacy/channel HTTP connect policy | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_http_client`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway store integrity sweep | `crates/desktop-gateway/src/gateway_store_integrity.rs`, `crates/desktop-gateway/src/store_integrity.rs` | recovered store names for `/api/health`, store DB paths | startup before store open | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_store_integrity`; `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway store_integrity`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway boot maintenance | `crates/desktop-gateway/src/gateway_boot_maintenance.rs` | active workspace, skills, stale tasks, contacts, mentions, owner identity, retired Homun check-ins | startup after `AppState` open and before recovery/worker | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_boot_maintenance`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway turn recovery | `crates/desktop-gateway/src/gateway_turn_recovery.rs`, `crates/desktop-gateway/src/projection_worker.rs`, `crates/task-runtime/src/broker.rs` | process generation, agent journal retention, projection outbox, recovered chat tasks, assistant message delivery state | startup before background maintenance, VACUUM, and task workers | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_turn_recovery`; `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway steering`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway background startup | `crates/desktop-gateway/src/gateway_background_startup.rs` | stale suggestion sweep, graph sweep, VACUUM, task worker, memory jobs, browser reapers, connector poller, proactivity review, computer live publisher | startup after turn recovery and before route assembly | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_background_startup`; `python3 scripts/check_gateway_main_contract.py`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway route assembly | `crates/desktop-gateway/src/gateway_routes.rs` | protected chat/API routes, public WS/noVNC/logo routes, web fallback, CORS | gateway HTTP surface before bind | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_routes`; `python3 scripts/check_gateway_main_contract.py`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway prompt build | `crates/desktop-gateway/src/gateway_prompt.rs`, `crates/desktop-gateway/src/lib.rs` | `/api/chat/build_prompt`, `BuildPromptRequest`, `BuildPromptResponse` | composer prompt assembly | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_prompt`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway Bearer auth | `crates/desktop-gateway/src/gateway_auth.rs` | `HOMUN_DESKTOP_GATEWAY_TOKEN`, `desktop-gateway-token`, `Authorization: Bearer <token>` | `apps/desktop/src/lib/gatewayConfig.ts` | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_auth`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway CORS | `crates/desktop-gateway/src/gateway_cors.rs` | `Origin`, `Access-Control-*`, `x-effective-model` | desktop renderer fetch | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_cors`; `cd apps/desktop && npm run test:ui-contract` |
| Gateway health | `crates/desktop-gateway/src/gateway_health.rs` | `/api/health`, recovered store list, projection worker health | Electron watchdog / startup liveness | `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_health`; `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway health_stays_live_while_a_store_lock_is_held`; `cd apps/desktop && npm run test:ui-contract` |

## Smoke Live

`scripts/kernel_live_smoke.py` crea un thread fresco, invia un prompt che forza
il browser su `https://www.selenium.dev`, aspetta il run terminale e verifica che
la risposta finale contenga `Selenium` senza marker di reasoning/tool activity.

Questo smoke non sostituisce lo smoke visuale Electron per regressioni di layout,
ma intercetta le regressioni in cui il modello e' selezionato correttamente e il
gateway parte, pero' il browser fallisce solo al primo uso reale.
