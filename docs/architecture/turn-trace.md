# turn_trace — osservabilità leggibile per-turno

Data: 2026-07-03 (design) · **atterrato sulla linea presentabile 2026-07-09** (`da802b70`).
`turn_trace` è un **log strutturato per-turno** che registra *cosa ha fatto* un turno del motore,
per diagnosticare i comportamenti (in particolare i "passi indietro": nudge/reconcile/forced-synthesis
che l'utente vede come loop o regressioni).

## Perché esiste — e cosa NON è

Distinto dal **trace-dump di parità** (ADR 0024, `HOMUN_TRACE_DUMP`), che cattura snapshot strutturali
per validare l'estrazione motore. `turn_trace` è **osservabilità di prodotto**: un diario leggibile degli
eventi di lifecycle del turno + flag derivati sulla risposta finale. Uno **non** sostituisce l'altro.

## Dove vive — sink sui seam, nessun cambio di control-flow

Il modulo è nel crate motore (`crates/engine/src/turn_trace.rs`) perché i suoi eventi in-loop nascono
dentro `engine::agent_loop::run_turn`. È passato a `run_turn` come **handle-sink** (`&TurnTrace`, con
`TurnTrace::disabled()` come no-op): ogni `record()` **solo scrive**, non muove/gate/riordina alcuna
istruzione del loop. **Invariante verificato:** gli 81 test del motore (incl. `run_turn` happy-path)
restano verdi *senza modifiche alle aspettative* → il comportamento è preservato. Il sub-turno `browse`
riceve `TurnTrace::disabled()` (i sotto-turni non sporcano la traccia).

## Eventi (`TurnEvent`)

`TurnReceived` · `TurnStart` (setup) · `Round` (per giro: indice, finish_reason, nomi tool-call) ·
`Plan` (da `execute_chat_tool`/`update_plan`) · `Nudge` (per `plan_nudges += 1`) · `Reconcile`
(reconcile-on-delivery + reconcile finale) · `ForcedSynthesis` (risposta vuota + `!final_done` post-loop) ·
`TurnEnd` (con i flag derivati). Gli eventi in-loop nascono nell'engine; setup/Plan/TurnEnd lato gateway.

Il `TurnEnd` usa i flag puri `answer_signals`/`has_markdown_table`/`count_sources`/`derive_flags` sulla
risposta finale, più `final_plan` — esposto in modo additivo su `TurnOutcome` perché il piano vive nel
`LoopState` consumato da `run_turn` (unico modo per farlo arrivare al gateway post-return).

## Attivazione

**ON di default** (locale, bounded). `HOMUN_TURN_TRACE=0|off` per opt-out; `HOMUN_TURN_TRACE_MAX_BYTES`
per la soglia di rotazione del `turn-trace.jsonl`. Best-effort: un dir non scrivibile è un no-op silenzioso,
mai un panic.
