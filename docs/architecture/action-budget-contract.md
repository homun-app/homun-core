# Action Budget Contract

Verificato 2026-08-14 su `main` a `169d2fd0`.

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
| Budget/live-set tool normali | `crates/desktop-gateway/src/gateway_tool_budget.rs` | `TurnConfig.max_rounds`, `TurnConfig.hard_round_ceiling`, live/deferred split | non decide quali tool sono disponibili |
| Registry capability/plugin/tool | `crates/desktop-gateway/src/gateway_capability_registry.rs` | `CapabilityEntry`, `CapabilitySource`, BM25 corpus, materializzazione per-turno del corpus, MCP/connector projection, `find_capability`/`suggest_capabilities` schemas | mostra solo `KernelCapabilityRuntimeView`, non decide discovery o live-set |
| MCP chat tool catalogue | `crates/desktop-gateway/src/gateway_mcp_chat_tools.rs` | namespaced `mcp__{server}__{tool}` names, inverse parser, cached schema catalogue and write-set | consuma schema/write-set proiettati; non decide esecuzione o budget |
| MCP runtime execution | `crates/desktop-gateway/src/gateway_mcp_runtime.rs` | metadata stdio/http, secret header migration, transport build, discovery/cache, `run_mcp_chat_tool` | non possiede route HTTP, budget round o UI confirmation copy |
| MCP connection routes | `crates/desktop-gateway/src/gateway_mcp_connections.rs` | connect/registry/connected/disconnect HTTP surface, provider registry lifecycle and HTTP secret cleanup | non possiede execute, timeout, round budget o confirmation rewrite |
| MCP execution route | `crates/desktop-gateway/src/gateway_mcp_execution.rs` | confirm-card HTTP execution endpoint, exact persisted source claim, server-level allow marker derivation and terminal resume/rewrite orchestration | non possiede transport MCP, timeout policy, confirmation parser o UI copy |
| Write-tool allow-list | `crates/desktop-gateway/src/gateway_write_tool_allowlist.rs` | persistenza delle scelte "always allow", matching esatto tool e marker MCP `mcp__server__*`, route list/revoke | non esegue tool, non decide approval routing e non possiede confirmation card |
| Thread linked files | `crates/desktop-gateway/src/gateway_thread_files.rs` | cartella collegata per thread, precedenza workspace attivo, search/read `@ file`, anti path traversal e limiti lettura | non possiede workspace registry, project write tools o prompt assembly |
| Chat transcription | `crates/desktop-gateway/src/gateway_transcription.rs` | route dictation, validazione audio base64 e bridge Whisper contained-computer | non possiede browser, UI composer o model routing |
| Usage/budget routes | `crates/desktop-gateway/src/gateway_usage_routes.rs` | finestre usage, summary/daily/models/providers/processes, snapshot account provider, policy budget manuale e suggerimenti modello | non possiede recorder usage, model registry o pricing store |
| Risorse concorrenti | `crates/task-runtime/src/resources.rs::ResourceGovernor` | `TaskStatus::WaitingResource` | mostra coda/waiting dal read model |
| Contesto/token | `agent_loop.rs` + `ContextCompactor`, catalog model context window | compaction event + messages compattati | puo' mostrare usage, non decidere stop |
| Tool/plugin/action timeout | `crates/desktop-gateway/src/gateway_tool_timeouts.rs` + tool runtime specifici | `ToolOutcome`, receipt/eventi | mostra call/result/approval |
| Action confirmations | `crates/desktop-gateway/src/gateway_action_confirmations.rs` | marker di conferma, exact-card provenance, rewrite terminale MCP | mostra card/action status; non decide autorizzazione |
| Browser | `BrowserBudget` + browser sidecar result | `BrowserProgress`, `BrowserDone`, typed failure reason | sessione dedicata, non in questo slice |

## Owner UI del piano

La UI non possiede budget o avanzamento del piano. Il presenter
`apps/desktop/src/lib/chat-runtime/kernelProjectionPresenter.mjs` e' l'owner
del read model per goal e passi del workspace; la normalizzazione/parsing
riutilizzabile vive in `apps/desktop/src/lib/chat-runtime/planSteps.mjs`.
`useChatActivityProjection` fa fetch/replay della `KernelThreadProjection` e
passa il risultato del presenter, senza ricostruire `PlanStep[]` o goal.

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
   Completato: `gateway_plan_stall`, `gateway_tool_budget`,
   `gateway_capability_registry`, `gateway_tool_timeouts`,
   `gateway_action_confirmations`, `gateway_mcp_chat_tools`,
   `gateway_mcp_runtime`, `gateway_mcp_connections`,
   `gateway_mcp_execution`, `gateway_write_tool_allowlist`,
   `gateway_thread_files`, `gateway_transcription` e `gateway_usage_routes`.
2. Continuare a portare la UI a leggere ogni stato di lavoro da un solo
   presenter (`runtimeViewModel` / `kernelProjectionPresenter`) e rimuovere
   alias locali che ricostruiscono "sta lavorando".
3. Allineare plugin/MCP/skill tool runtime: timeout e permessi sono tool policy,
   ma progresso, piano e terminalita' restano del kernel.
4. Solo dopo, riaprire il browser: il suo budget dovra' essere una specializzazione
   del contratto generale, non un secondo motore.
