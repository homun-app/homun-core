# Action Budget Contract

Verificato 2026-08-14 sul branch `fabio/app-action-budget-contracts`.

Questo documento separa i budget di azione dal bug browser corrente. Il browser
avra' una sessione dedicata; il contratto generale dell'app deve invece restare
unico per chat, tool, plugin, automazioni, sub-agent e UI.

## Baseline esterna letta nel codice

Checkout locali sotto `/Users/fabio/Projects/Homun/agent-system-research`:

| Sistema | File letti | Contratto osservato |
| --- | --- | --- |
| opencode | `packages/core/src/session/runner/llm.ts`, `packages/core/src/session/runner/max-steps.ts`, `packages/core/src/session/run-coordinator.ts`, `packages/core/src/tool/registry.ts` | Il limite primario e' `agent.info.steps`: all'ultimo step i tool non vengono materializzati, `toolChoice` diventa `none`, e un prompt esplicito forza una risposta testuale di riepilogo. La UI/sessione proietta eventi del runner, non decide il budget. |
| openai/codex | `codex-rs/core/src/rollout_budget.rs`, `codex-rs/core/src/session/token_budget.rs`, `codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs`, `codex-rs/core/src/tools/context.rs` | I budget sono owner tipizzati: token/rollout budget condiviso, reminder in contesto, timeout tool clampati, cancellation token e truncation policy sugli output. La UI riceve stato/turn item, non inventa liveness o progresso. |

In entrambi i casi il budget non vive nella UI. Il loop/sessione decide se i
tool sono ancora disponibili, i tool runtime rispettano timeout/permessi, la
UI mostra lo stato prodotto.

## Tassonomia Homun

| Budget | Owner attuale | Stato canonico | UI |
| --- | --- | --- | --- |
| Round per turno | `crates/engine/src/config.rs::TurnConfig`, `agent_loop.rs` | `TurnOutcome.stop`, eventi journal | mostra terminal/sospeso dalla projection |
| Progresso dentro uno step | `LoopState.progress_anchor_round` e `ToolEffects.reset_stall_guards` | `PlanStepAdvanced`, `runtime_plans` | renderizza step proiettati |
| Stall cross-turn del piano | `crates/desktop-gateway/src/gateway_plan_stall.rs` | `runtime_plans.stall_turns`, `last_resume_done` | non calcola il budget |
| Risorse concorrenti | `crates/task-runtime/src/resources.rs::ResourceGovernor` | `TaskStatus::WaitingResource` | mostra coda/waiting dal read model |
| Contesto/token | `agent_loop.rs` + `ContextCompactor`, catalog model context window | compaction event + messages compattati | puo' mostrare usage, non decidere stop |
| Tool/plugin/action timeout | tool runtime specifici + gateway policy | `ToolOutcome`, receipt/eventi | mostra call/result/approval |
| Browser | `BrowserBudget` + browser sidecar result | `BrowserProgress`, `BrowserDone`, typed failure reason | sessione dedicata, non in questo slice |

## Regole di refactor

1. Ogni nuovo limite deve avere un solo owner Rust/TS nominato e testato.
2. Un budget esaurito produce un outcome tipizzato, non solo testo da parsare.
3. La UI puo' mostrare budget/liveness solo da `KernelThreadProjection`,
   `TaskUiReadModel` o eventi runtime gia' canonici.
4. I plugin non possiedono budget di conversazione: possono dichiarare policy,
   timeout e permessi, ma il runner decide disponibilita' e stop.
5. Le soglie possono essere configurabili; la decisione deve essere risolta una
   volta per turno/task e passata all'owner, non letta da punti diversi.
6. I fallback legacy possono restare solo come compatibilita' di rendering o
   migrazione dati, mai come fonte di progresso/liveness.

## Prossimi tagli

1. Estrarre altri budget/proiezioni ancora dentro `main.rs` in owner piccoli,
   aggiungendo ogni volta una voce al gate `check_gateway_main_contract.py`.
2. Portare la UI a leggere ogni stato di lavoro da un solo presenter
   (`runtimeViewModel` / `kernelProjectionPresenter`) e rimuovere alias locali
   che ricostruiscono "sta lavorando".
3. Allineare plugin/MCP/skill tool runtime: timeout e permessi sono tool policy,
   ma progresso, piano e terminalita' restano del kernel.
4. Solo dopo, riaprire il browser: il suo budget dovra' essere una specializzazione
   del contratto generale, non un secondo motore.
