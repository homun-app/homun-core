# WS6.3 Scheduler / ricorrenza + proactive review

**Goal:** rendere affidabile il ciclo ricorrente/proattivo: un task schedulato
deve eseguire, materializzare la prossima occorrenza, consegnare nel thread
corretto e non duplicare/silenziare le proposte.

## Scope

- Contratto ricorrenza tra `TaskScheduler`, `TaskRuntime` standalone e worker
  desktop gateway.
- Proactive prompt / scheduled thread delivery.
- Failure/retry policy per task ricorrenti.
- Gate in-app dopo i test headless.

## Non-scope

- Nuova UI complessa per configurare limiti risorsa.
- Pubblicazione, tag o release.
- Nuove skill deliverable WS7.
- Write-back memoria proattiva WS6.4.

## Slice 1 — runtime recurrence materialization

Acceptance:

- [x] Test red conferma che `TaskRuntime::run_ready_once` completa un task
  ricorrente ma non inserisce la prossima occorrenza.
- [x] Dopo completion, `TaskRuntime` usa `TaskScheduler::next_recurrence` e
  inserisce il clone `Queued`.
- [x] La prossima occorrenza mantiene `recurrence`, ha `not_before > now` e id
  bounded `root@occ@<unix>`.
- [x] Suite runtime/gateway/build verdi.

Verification:

- Red/green focused test:
  `cargo test -p local-first-task-runtime task_runtime_materializes_next_recurrence_after_completion`
  - Red: missing `daily@occ@...`.
  - Green: 1 passed.
- Broader checks:
  - `cargo test -p local-first-task-runtime` → green.
  - `cargo test -p local-first-desktop-gateway` → 162 passed, 1 ignored.
  - `cargo build -p local-first-desktop-gateway` → green.
  - `npm run build` in `apps/desktop` → green.
  - `git diff --check` → clean.

Implementation:

- Add `task_runtime_materializes_next_recurrence_after_completion`.
- Add `TaskRuntime::insert_next_recurrence` and call it only after
  `ExecutorResult::Completed`.

## Next slices

- Slice 2: failure/retry recurrence parity between runtime and gateway.
- Slice 3: in-app scheduled/proactive prompt gate.
- Slice 4: proactive review card surface/dedup verification.
