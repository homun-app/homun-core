# Kernel V2 Contract

Verificato 2026-08-11 sul branch `fabio/runtime-v2-first-slice`.

Questo documento rende operativo ADR 0021/0025/0026 dopo le regressioni osservate
su piano, progresso, browser e UI liveness. Non introduce un secondo motore: fissa
quali owner possono mutare lo stato canonico del turno e quali componenti possono
solo proiettarlo.

## Baseline esterna letta nel codice

Checkout locali sotto `/Users/fabio/Projects/Homun/agent-system-research`:

| Sistema | Commit letto | File rilevanti | Contratto osservato |
| --- | --- | --- | --- |
| opencode | `d041eee55c4b669f583fcbe0eb73e78d53393ae8` | `packages/opencode/src/session/processor.ts`, `packages/opencode/src/session/tools.ts`, `packages/llm/src/protocols/utils/tool-stream.ts`, `packages/codemode/src/tool-runtime.ts` | Parser provider, tool registry, permission e session processor sono owner separati. Il processor crea/aggiorna/completa parti tipizzate; il tool runtime produce output e hook, non decide la conversazione. |
| openai/codex | `41ece455b7fa7166f4fc38522952afdaa2604e18` | `codex-rs/core/src/session/turn.rs`, `codex-rs/core/src/state/turn.rs`, `codex-rs/core/src/tools/parallel.rs` | `run_turn` possiede il sampling loop. I tool vengono eseguiti da `ToolCallRuntime` e rientrano come output del prossimo sampling request. `TurnState` tiene pending approval/input/tool metadata, non la UI. |
| aider | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | `aider/coders/base_coder.py`, `aider/coders/architect_coder.py`, `aider/commands.py` | Loop CLI semplice ma stabile: messaggio, risposta, apply edits, auto-commit/checkpoint, lint/test, reflection. Ogni transizione significativa passa da un ciclo fisso. |

L'invariante comune non e' la tecnologia: e' la separazione degli owner. Il
provider stream produce eventi, il tool runtime produce risultati, il loop decide
se continuare, la persistenza registra lo stato canonico, la UI lo proietta.

## Owner canonici in Homun

| Stato | Owner canonico | Persistenza/proiezione | Non owner |
| --- | --- | --- | --- |
| Control flow del turno | `crates/engine/src/agent_loop.rs` + `LoopState` | `TurnOutcome.stop` | UI, browser sidecar, model prose |
| Piano in-turn | `crates/engine/src/plan.rs` su `LoopState.plan` | `runtime_plans`, `turn_events` `plan_update`/`step_advance` | marker testuali non ridotti, renderer |
| Liveness durable | `crates/task-runtime/src/turn_lifecycle.rs`, `broker.rs`, `store.rs` | `tasks`, `turn_events`, `agent_runs.terminal_reason` | spinner, activity text |
| Effect receipts | `crates/desktop-gateway/src/effect_host.rs` + `crates/task-runtime/src/execution_store.rs` | `execution_effect_receipts` | tool result prose, UI card |
| Browser action outcome | `gateway_browser_tools.rs`, `gateway_tool_execution.rs`, browser sidecar result | receipt + `ToolOutcomeHint` + `browser_done`/`BrowseResult` | "activity observed" alone |
| Desktop projection | `apps/desktop/src/lib/chat-runtime/*`, `chatEventParts.ts`, `appCoreMappers.ts` | API/WS payloads from gateway | local inference that creates canonical progress |

## Kernel event contract

Ogni mutazione rilevante del turno deve attraversare una delle seguenti classi di
evento. Un evento non presente qui e' diagnostica, non control flow.

| Evento | Input minimo | Effetto canonico |
| --- | --- | --- |
| `ModelTextDelta` | `turn_id`, `message_id`, delta sanificato | Solo transcript/prosa. Non chiude turni e non avanza piani. |
| `ToolCallStarted` | `turn_id`, `call_id`, `tool_name`, input validato | Apre un tool call in stato `running`; registra l'id come occupato per il turno. |
| `ToolCallSettled` | `turn_id`, `call_id`, `tool_name`, `ToolOutcome` | Applica `ToolEffects` a `LoopState`, produce eventuale tool output per il modello. |
| `PlanUpdated` | `turn_id`, plan canonico `{goal?, steps[]}` | Sostituisce il piano dopo normalizzazione, persiste `runtime_plans`, emette `plan_update`. |
| `PlanStepAdvanced` | `turn_id`, `step_id`, `from`, `to`, `reason` | Aggiorna una sola transizione step, emette `step_advance`, resetta stall guard se c'e' progresso reale. |
| `EffectPrepared` | `turn_id`, `call_id`, `effect_class`, `receipt_ref` | Crea receipt idempotente. Nessun replay automatico se la receipt diventa `uncertain`. |
| `EffectSettled` | `receipt_ref`, `completed|failed|uncertain|compensated` | Decide se il turno continua, sospende su resolution, o riusa un risultato certo. |
| `BrowserProgress` | `turn_id`, `call_id`, `outcome_hint`, `source?` | Reset dei budget solo se il segnale e' progresso reale, non mera attivita'. |
| `BrowserDone` | `turn_id`, `call_id`, `BrowseResult` validato | Chiude il bisogno informativo browser; il manager decide piano/finale. |
| `TurnStopped` | `turn_id`, `TurnStop`, `terminal_reason` | Unico punto che rende il turno terminale/sospeso/fallito per task-runtime e UI. |

## Invarianti non negoziabili

1. Un turno ha un solo loop owner: `engine::agent_loop::run_turn`.
2. Il piano puo' avanzare solo da `PlanUpdated` o `PlanStepAdvanced`.
3. `runtime_plans` e `turn_events` devono essere coerenti: se un piano visibile
   avanza, esiste un evento `step_advance`; se il piano sparisce in UI, la
   projection deve poter spiegare quale evento lo ha chiuso o sostituito.
4. Uno stesso `call_id` logico non puo' identificare due tool call diverse nello
   stesso turno. Gli id sintetici o duplicati del provider vanno normalizzati
   prima di receipts, pruning browser e tool output.
5. Le receipt `Read` restano durabili ma non chiedono verifica utente. Le receipt
   `ExternalWrite` chiedono verifica solo quando l'outcome remoto e' realmente
   incerto.
6. Un browser action timeout con risultati gia' visibili non autorizza replay
   cieco. Prima si riconciliano sidecar result, receipt, `runtime_plans`,
   checkpoint e dedupe.
7. `browser_activity_observed` non equivale a `BrowserDone` e non equivale a
   progresso piano.
8. La UI non puo' creare liveness canonica da "thinking", activity labels o
   stream aperti. Proietta solo task/run/turn terminal state, pending HITL,
   pending effect resolution e active tool calls.
9. Un final answer non-HITL non puo' essere terminale mentre rimangono step
   `todo`/`doing` runnable nel piano canonico.
10. Ogni fix in questo perimetro deve aggiungere una fixture nell'owner canonico,
    poi passare `python3 scripts/kernel_regression_gate.py`; per browser reale,
    anche `HOMUN_RUN_KERNEL_LIVE_SMOKE=1 python3 scripts/kernel_regression_gate.py`.

## Gap attuale da chiudere

Le patch recenti hanno risolto sintomi puntuali, ma hanno anche mostrato il
debito strutturale:

- il piano puo' esistere in `LoopState.plan`, `runtime_plans`, marker testuali,
  eventi WS e projection UI senza un reducer unico esplicito;
- la classificazione browser/receipt e' distribuita tra tool execution, effect
  host, sidecar outcome e UI attention;
- il progresso piano e' ancora recuperato in parte da riconciliazioni tardive;
- la UI deve comporre stato da stream live + durable projection e quindi puo'
  mostrare "sta lavorando" quando il backend e' terminale o sospeso.

La chiusura di questi gap e' tracciata nel piano dedicato
`docs/superpowers/plans/2026-08-11-kernel-v2-stability.md`, non in questa mappa
as-built.
