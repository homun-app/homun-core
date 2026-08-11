# Anti-Regression Protocol

Verificato 2026-08-11 sul branch `fabio/runtime-v2-first-slice`.

Questo protocollo e' il gate minimo prima di dichiarare risolta una regressione
su chat, turno, reasoning, steering, composer, runtime/context o overlay
browser/activity.

## Regola

Ogni fix deve lasciare una fixture nel livello owner:

- stato durable o enqueue: Rust in `crates/task-runtime`;
- proiezione gateway, HITL o cleanup steering: Rust in `crates/desktop-gateway`;
- regressioni cross-owner su goal, piano, browser, plugin/capability,
  automazioni o liveness UI: fixture persistita in
  `scripts/fixtures/kernel_projection/` piu' owner-level test;
- thinking/composer/steering UI: pure module in `apps/desktop/src/lib/chat-runtime`
  o `apps/desktop/src/lib/chatSteeringState.*`;
- testo risposta/reasoning: `apps/desktop/src/lib/chat-rendering` o compat
  `apps/desktop/src/lib/chatVisibleContent.*`;
- layout desktop: `apps/desktop/tests/cursor-grammar-ui.test.mjs` o
  `apps/desktop/tests/adaptive-workspace-island-ui.test.mjs`.

Un controllo visuale senza fixture non basta: e' valido solo come smoke finale.

## Gate Rapido

Da `app/`:

```bash
python3 scripts/kernel_regression_gate.py
```

Il comando sopra e' il gate unico per il perimetro kernel/chat/runtime. Esegue
gli stessi controlli minimi elencati sotto e si ferma al primo errore. Per
includere uno smoke reale gateway+browser:

```bash
HOMUN_RUN_KERNEL_LIVE_SMOKE=1 python3 scripts/kernel_regression_gate.py
```

Componenti deterministici del gate:

```bash
cargo fmt --check
python3 scripts/smoke_kernel_projection.py
cargo test -p local-first-task-runtime turn_lifecycle
cargo test -p local-first-task-runtime active_chat_turn
cargo test -p local-first-task-runtime finalizing
cargo test -p local-first-task-runtime enqueue_
cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway steering
```

Da `apps/desktop/`:

```bash
npm run test:cursor-grammar
npm run test:ui-contract
npm run build
```

## Regressioni Coperte

| Regressione | Fixture/owner |
| --- | --- |
| Thinking visibile a turno terminale | `chat-runtime/lifecycle.test.mjs` |
| Waiting-user mostrato come lavoro modello | `chat-runtime/lifecycle.test.mjs` |
| Composer che apre steering quando serve un nuovo turno | `chat-runtime/composerMode.test.mjs` |
| Steering promosso o stale visibile/bloccante a riposo | `chatSteeringState` test via `npm run test:cursor-grammar` |
| `finalizing` trattato come turno attivo | `turn_lifecycle.rs`, `active_chat_turn` e `finalizing` tests |
| Steering non chiuso dopo terminale | `close_unsettled_turn_steering` tests e gateway `steering` tests |
| Reasoning/tool-call prose nella risposta | `chat-rendering/visibleContent` tests via `npm run test:cursor-grammar` |
| Prompt utente inviato con bubble frame | `cursor-grammar-ui.test.mjs` |
| Editor messaggio troppo piccolo | `cursor-grammar-ui.test.mjs` |
| Browser/activity overlay sovrapposti | `adaptive-workspace-island-ui.test.mjs` |
| Goal/piano non visibili dopo reload | `scripts/smoke_kernel_projection.py`, `turn_reducer_contract`, `deriveConversationPlan` |
| Progress del piano non avanza | `runtime_plans` + `step_advance` owner tests, `scripts/smoke_kernel_projection.py` |
| Browser bloccato senza `browser_done` | `browser_done_closes_browser_state_even_with_read_uncertainty`, `scripts/smoke_kernel_projection.py` |
| Verifica richiesta per read incerta | `scripts/smoke_kernel_projection.py`, `kernelProjectionPresenter.test.mjs` |
| Verifica richiesta per write incerta | `scripts/smoke_kernel_projection.py`, effect receipt owner tests |
| Tool/plugin MCP cambiano liveness | `capability_runtime_projects_plugin_tool_state_without_liveness`, `scripts/smoke_kernel_projection.py` |
| Automazione/proactive run usa stato separato | `automation_projection_uses_kernel_contract_for_waiting_and_completed_turns`, `automationRunProjection.test.mjs` |
| Marker legacy riapre lifecycle corrente | `kernelProjectionPresenter.test.mjs`, `useChatActivityProjection.test.mjs`, `scripts/smoke_kernel_projection.py` |

## Smoke Visuale Electron

Il gate rapido non sostituisce uno smoke reale quando la regressione e'
visiva o dipende dal runtime desktop.

Da `apps/desktop/`:

```bash
npm run electron:dev
```

Verifiche manuali minime:

- inviare un messaggio utente e confermare che resta allineato a destra senza
  bordo/fondo;
- editare un messaggio e confermare che il textarea e' multilinea e leggibile;
- aprire Activity mentre c'e' un live computer/browser preview e confermare che
  non si sovrappone all'isola workspace;
- completare un turno e confermare che thinking/stop non restano appesi;
- usare un prompt che produce reasoning o marker e confermare che non appare
  nella risposta principale.

Annotare sempre se lo smoke e' stato fatto su `electron:dev`, app installata o
build firmata.
