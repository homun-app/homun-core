# Agent Runtime V2 Scenario Gate

Date: 2026-08-10
Status: Active once wired into `scripts/kernel_regression_gate.py`.

This document defines goal-level fixtures for the Runtime v2 refactor. These
scenarios test system invariants, not one-off bugs.

## Global Rules

- Every scenario records canonical turn state, projected task state, assistant
  message state, plan state, and UI/read-model expectation.
- Every scenario has a Kill List entry in the implementation slice that changes
  runtime behavior.
- Passing a scenario by adding a guard while leaving the old owner active is not
  sufficient.

## Scenario 1: Build App Complex

Prompt:

```text
Crea una piccola applicazione web locale per gestire viaggi in treno.
React + TypeScript, CRUD, filtri, riepilogo, localStorage, test unitari, build finale.
Non usare browser o internet.
```

Required invariant:

- a runnable open plan cannot reduce to `Completed`;
- tests/build observations are evidence for final plan steps;
- failed turns show visible failure text.

First automated owner:

- `crates/task-runtime/src/turn_reducer.rs`
- `scripts/audit_turn_consistency.py`
  (`terminal_task_with_active_runtime_plan` when `runtime_plans` still has a
  runnable open step after a terminal task)

## Scenario 2: Plan Read-Only

Prompt:

```text
Analizza questo codice e proponi un piano, senza modificare file.
```

Required invariant:

- `AgentProfile=plan` cannot execute write actions;
- any denied action is an observation, not a hidden terminal state.

First automated owner:

- RFC Phase 4 `AgentProfile` slice, outside this first slice.

## Scenario 3: Browser Train Search

Prompt:

```text
Mi trovi un treno da Milano a Roma per il 25 agosto alle 8 del mattino.
```

Required invariant:

- browser returns `found`, `partial`, `needs_user`, `failed`, or `no_result`;
- parent turn cannot remain active after a terminal browser result is projected.

First automated owner:

- RFC Phase 5 `BrowserResult` slice, outside this first slice.

## Scenario 4: Open Plan Stall

Prompt:

```text
Completa una task multi-step ma il modello continua a dire che prosegue senza azioni utili.
```

Required invariant:

- repeated no-progress is bounded;
- terminal failure has visible text;
- plan remains open with an owning blocked reason.

First automated owner:

- `crates/task-runtime/src/turn_reducer.rs`
- Runtime v2 engine budget slice, outside this first slice.

## Scenario 5: Failure Visibility

Prompt:

```text
Forza un errore runtime o tool.
```

Required invariant:

- `TurnFailed`, `tasks.status=failed`, terminal `error`, agent run terminal state,
  and assistant message failure text agree.

First automated owner:

- `scripts/audit_turn_consistency.py`

## Scenario 6: User Wait and Resume

Prompt:

```text
Esegui una task che richiede una scelta utente o approvazione.
```

Required invariant:

- waiting-user state stops model work UI;
- resume does not duplicate assistant identity;
- successor revision is traceable.

First automated owner:

- Runtime v2 reducer revision/wake slice, outside this first slice.

## Scenario 7: Crash/Restart Recovery

Prompt:

```text
Interrompi una task attiva e riavvia il gateway.
```

Required invariant:

- no terminal task has a running agent run;
- projection retry cannot hide terminality;
- UI read model agrees after replay.

First automated owner:

- `scripts/audit_turn_consistency.py`
