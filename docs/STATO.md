# Stato - Homun (documento vivo)

> **Ultimo aggiornamento: 2026-08-14 (capability corpus materialization extraction in progress).**
>
> Hub: [`README.md`](README.md). Mappa codice: [`architecture/`](architecture/).
> Archive stantia: [`archive/2026-07-31-doc-reset/`](archive/2026-07-31-doc-reset/).
> Prompt lungo storico: [`HANDOFF-2026-07-31.md`](HANDOFF-2026-07-31.md).

## Identita Git

| Campo | Valore |
| --- | --- |
| Repo | `/Users/fabio/Projects/Homun/app` |
| Worktree corrente | `/Users/fabio/Projects/Homun/app` |
| Branch | `fabio/capability-materialization-contracts` da `main` |
| PR | #108-#116, #118, #119 e #120 mergeate in `main`; #117 browser draft separata |
| HEAD codice verificato | `88ee847e` (`Merge pull request #120 from homun-app/fabio/capability-registry-contracts`) |

## Dove siamo

Homun = gateway Rust + Electron/React + sidecar. Il refactor Runtime V2 ha
portato il perimetro chat/runtime/UI su una proiezione canonica:

```text
turn_events + runtime_plans + execution_effect_receipts + agent_runs + HITL
  -> task-runtime reducer
  -> gateway KernelThreadProjection
  -> desktop presenter/runtimeViewModel
```

Il contratto as-built vive in
[`architecture/kernel-v2-contract.md`](architecture/kernel-v2-contract.md). Il
contratto budget/azioni vive in
[`architecture/action-budget-contract.md`](architecture/action-budget-contract.md). La
matrice owner/gate vive in
[`testing/kernel-contract-matrix.md`](testing/kernel-contract-matrix.md). Il
protocollo anti-regressione vive in
[`testing/anti-regression-protocol.md`](testing/anti-regression-protocol.md).

## Runtime V2 - chiuso su main

Piano completato:
[`superpowers/plans/2026-08-11-homun-unified-kernel-ui-plugin-convergence.md`](superpowers/plans/2026-08-11-homun-unified-kernel-ui-plugin-convergence.md).

Slice Runtime V2 recenti:

- `TaskStore::project_kernel_thread` e DTO `KernelThreadProjection`;
- endpoint gateway `GET /api/chat/threads/{thread_id}/kernel-projection`;
- presenter desktop puro `kernelProjectionPresenter`;
- `useChatActivityProjection` migrato alla proiezione kernel;
- client desktop migrato via `fetchKernelThreadProjection` senza export
  `fetchThreadActivity`;
- stato browser tipizzato in `KernelBrowserView`;
- stato plugin/skill/MCP/connector in `KernelCapabilityRuntimeView`;
- marker transcript quarantinati dietro legacy adapter;
- marker transcript non proiettano piu' plan/activity nell'isola runtime; lo
  storico resta compatibile solo nel rendering transcript;
- `ChatView` ridotto a presenter shell via `runtimeViewModel`;
- automazioni/background run allineati alla stessa proiezione;
- smoke deterministico `/kernel-projection` dentro kernel/pre-release gate.
- `browserActivityLifecycle` non possiede piu' la scelta del piano:
  `deriveConversationPlan` e' stato rimosso, il piano passa dal presenter kernel.
- `TaskStore::project_kernel_thread` non esporta step `doing`/`in_progress`
  quando il turno e' terminale: la projection UI mostra lo step corrente come
  `blocked` e rigenera il markdown dallo stesso stato proiettato.
- PR #109 `Preserve grounded browser timeout results`: il browser read-only che
  arriva a risultati osservati prima del timeout non viene degradato a fallback
  generico.
- PR #110 `Preserve grounded browser fallback evidence`: la risposta finale
  conserva evidenza, fonti e stato grounded quando il browser ha visto risultati
  utili ma non chiude semanticamente tutto il task.
- PR #111 `Pin browser projection fallback contract`: fixture
  `browser_grounded_partial_terminal` protegge il caso terminale browser
  grounded/fallback lato projection UI.
- Rimozione fallback legacy HITL: rimosso il fallback `threadTailAwaits*`
  che faceva derivare lifecycle/composer mode dai marker HITL del transcript
  prima del load della projection.
- Estrazione `gateway_plan_stall`: il budget cross-turn del piano non vive piu'
  nel monolite `main.rs`; `check_gateway_main_contract.py` ne impedisce il
  rientro.
- Estrazione `chat-runtime/planSteps`: parsing/normalizzazione dei passi UI
  passano da `kernelProjectionPresenter`; `useChatActivityProjection` non
  ricalcola piu' goal/progresso con un secondo owner locale.
- Estrazione `gateway_tool_budget`: budget round normali e live-set
  tool progressiva escono dal monolite `main.rs`; browser budget resta owner
  separato in `gateway_browser_tools`.
- Estrazione `gateway_capability_registry`: schema `find_capability` e
  `suggest_capabilities`, corpus `CapabilityEntry`, source labels, BM25,
  proiezione MCP/connector e search toolkit-aware Composio escono dal monolite
  `main.rs`; il routing semantico workflow resta fuori da questa slice.
- Slice successiva `gateway_capability_registry`: la materializzazione per-turno
  del corpus capability (`deferred_tools`, MCP schemas, skill abilitate e policy
  obiettivo) viene spostata nello stesso owner, lasciando a `main.rs` solo lo
  snapshot degli input del turno.

## Invarianti ora protetti

- Un turno terminale non lascia liveness UI attiva.
- Un turno terminale non lascia step di piano attivi nella projection UI.
- Piano e progresso vengono da `runtime_plans`/`turn_events`, non da marker.
- `browser_done` chiude il lavoro browser; snapshot visibile senza done resta
  `active`/`unknown`.
- Browser grounded partial terminale resta leggibile: risposta finale e fonti
  osservate sopravvivono al fallback invece di mostrare solo una risposta
  generica o vuota.
- La fixture `browser_grounded_partial_terminal` mantiene goal/piano visibili,
  browser `done`, nessun attention item e nessuna liveness attiva.
- Receipt `Read` incerta non genera card di verifica utente.
- Receipt `ExternalWrite` incerta genera attention item.
- Tool/plugin/MCP caricati non cambiano liveness.
- Automazioni e proactive run usano lo stesso vocabolario del kernel.
- Il workspace plan UI viene proiettato da `kernelProjectionPresenter` usando
  `chat-runtime/planSteps`; l'hook activity fa fetch/replay e non possiede piu'
  parsing o normalizzazione del piano.
- Marker legacy possono renderizzare storico, ma non riaprire lifecycle corrente,
  non forzano composer mode e non alimentano piu' plan/activity dell'isola.

## Gate verificati

Baseline Runtime V2 su PR #108:

```bash
python3 scripts/kernel_regression_gate.py
python3 scripts/pre_release_gate.py
make test
```

Esito: verde prima del merge.

Slice browser/projection successive:

- PR #109 mergeata il 2026-08-12, merge commit `5b5f27f0`.
- PR #110 mergeata il 2026-08-12, merge commit `8be33808`; gate locale
  `python3 scripts/kernel_regression_gate.py` verde.
- PR #111 mergeata il 2026-08-13, merge commit `41777852`; gate locale
  `python3 scripts/kernel_regression_gate.py` verde e CI verde su Backend,
  Frontend, Landlock, Release readiness, build Linux/macOS/Windows.
- PR #112 mergeata il 2026-08-13, merge commit `3eb69e2b`; gate locale
  `python3 scripts/kernel_regression_gate.py` verde e CI verde su Backend,
  Frontend, Landlock, Release readiness, build Linux/macOS/Windows.
- PR #113 mergeata il 2026-08-13, merge commit `74735bb6`; gate locale
  `python3 scripts/kernel_regression_gate.py` verde e CI verde su Backend,
  Frontend, Landlock, Release readiness, build Linux/macOS/Windows.
- PR #114, #115, #116 mergeate in `main`; `main` osservato a `a688c991`.
- PR #118 mergeata il 2026-08-14, merge commit `29435a4b`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #119 mergeata il 2026-08-14, merge commit `7aec200d`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #120 mergeata il 2026-08-14, merge commit `88ee847e`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- Slice `fabio/app-action-budget-contracts` verificata localmente con:
  `python3 scripts/check_gateway_main_contract.py`, `cargo fmt --check`,
  `cargo test -p local-first-desktop-gateway plan_stall -- --nocapture`,
  `cargo test -p local-first-desktop-gateway block_stalled_step -- --nocapture`,
  `cargo test -p local-first-desktop-gateway runtime_plan_control_store_owns_stall_bookkeeping -- --nocapture`,
  `cd apps/desktop && npm test`, `cd apps/desktop && npm run test:ui-contract`,
  `cd apps/desktop && npm run build`, `python3 scripts/kernel_regression_gate.py`
  verde con voce `gateway plan stall`.
- Slice `fabio/plugin-tool-budget-contracts` verificata localmente con:
  `cargo fmt --check`, `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway gateway_tool_budget -- --nocapture`,
  `git diff --check`, `python3 scripts/kernel_regression_gate.py` verde con
  voce `gateway tool budget`.
- Slice `fabio/capability-registry-contracts` verificata localmente: RED del contract
  `check_gateway_main_contract.py` osservato prima dell'estrazione; GREEN
  mirati con `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_capability_registry -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway capability -- --nocapture`,
  `cargo test -p local-first-desktop-gateway gateway_capability_registry -- --nocapture`,
  `cargo test -p local-first-desktop-gateway gateway_tool_budget -- --nocapture`,
  `cargo fmt --check`, `git diff --check` e
  `python3 scripts/kernel_regression_gate.py` verde con voce
  `gateway capability registry`.

## PR / CI

PR mergeate:

- #108 `Settle terminal plan projection states`:
  `https://github.com/homun-app/homun-core/pull/108`.
- #109 `Preserve grounded browser timeout results`:
  `https://github.com/homun-app/homun-core/pull/109`.
- #110 `Preserve grounded browser fallback evidence`:
  `https://github.com/homun-app/homun-core/pull/110`.
- #111 `Pin browser projection fallback contract`:
  `https://github.com/homun-app/homun-core/pull/111`.
- #112 `Update Runtime V2 status after browser projection contracts`:
  `https://github.com/homun-app/homun-core/pull/112`.
- #113 `Remove legacy HITL liveness fallback`:
  `https://github.com/homun-app/homun-core/pull/113`.
- #114 `Update status after Runtime V2 projection work`:
  `https://github.com/homun-app/homun-core/pull/114`.
- #115 `Fix browser timeout diagnostics and time input fallback`:
  `https://github.com/homun-app/homun-core/pull/115`.
- #116 `Fix browser smoke completion contract`:
  `https://github.com/homun-app/homun-core/pull/116`.
- #118 `Extract plan stall budget owner`:
  `https://github.com/homun-app/homun-core/pull/118`.
- #119 `Extract gateway tool budget owner`:
  `https://github.com/homun-app/homun-core/pull/119`.

Branch corrente:

- `fabio/capability-materialization-contracts`: sposta nello stesso owner
  `gateway_capability_registry` la materializzazione per-turno del corpus
  capability/plugin/MCP; PR non ancora aperta.

## Debito residuo

- Smoke Electron reale su `main` pulito: chat, plan progress, browser read
  research, Activity/browser island, composer mode, nessuna card di verifica per
  azioni browser read-only.
- Aggiornare eventuali note release/RC dopo smoke visuale reale.
- `ThreadActivityProjection` e la route backend compat
  `GET /api/chat/threads/{thread_id}/activity` sono stati rimossi nella cleanup
  backend 2026-08-12; il read model canonico e' `KernelThreadProjection`.
- `legacyMarkerProjection` e' stato rimosso da `useChatActivityProjection`; in
  assenza di `KernelThreadProjection` l'isola runtime resta vuota invece di
  ricostruire plan/activity dai marker.
- `threadTailAwaits*` e' stato rimosso da lifecycle/composer routing; i marker
  HITL del transcript restano display-only e non possono piu' creare liveness o
  modalita' reply prima del load della projection.
- Continuare la rimozione dei fallback `legacy*` solo con fixture owner-level e
  gate kernel verde.
- `main.rs` e `ChatView.tsx` restano grandi, ma non vanno tagliati senza owner
  contract RED e Kill List esplicita.

## Prossimo lavoro

1. Chiudere la slice `gateway_capability_registry` materialization: gate
   completo, commit, PR e merge se CI verde.
2. Prossima slice backend/kernel senza browser: timeout tool specifici,
   separando policy dichiarata dai plugin da budget deciso dal runner.
3. Sessione browser dedicata dopo il refactor kernel: smoke Electron reale su
   goal/plan/progress e treni Milano-Roma read-only.

## Prompt di ripartenza

```text
Continuo Homun Runtime V2. Repo: /Users/fabio/Projects/Homun/app,
branch main, HEAD atteso 88ee847e o successivo.
Leggi docs/STATO.md, docs/architecture/kernel-v2-contract.md e
docs/testing/kernel-contract-matrix.md.
Regola: codice = verita; ogni modifica deve avere owner canonico, Kill List,
fixture/gate e rimozione del fallback non piu' necessario.
```
