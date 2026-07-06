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

## Slice 2 — terminal failure recurrence parity

Acceptance:

- [x] Test red conferma che un task ricorrente terminalmente fallito in
  `TaskRuntime` non inseriva la prossima occorrenza.
- [x] Il retry intermedio resta invariato: `WaitingTime`, nessuna prossima
  occorrenza.
- [x] Su terminal `Failed`, `TaskRuntime` inserisce la prossima occorrenza
  `Queued`, mantenendo `recurrence` e `not_before > now`.
- [x] Suite gateway/build/desktop verdi.

Verification:

- Red/green focused test:
  `cargo test -p local-first-task-runtime task_runtime_materializes_next_recurrence_after_terminal_failure`
  - Red: missing `daily@occ@...` after terminal failure.
  - Green: 1 passed.
- Broader checks:
  - `cargo test -p local-first-task-runtime` → green.
  - `cargo test -p local-first-desktop-gateway` → 162 passed, 1 ignored.
  - `cargo build -p local-first-desktop-gateway` → green.
  - `npm run build` in `apps/desktop` → green.
  - `git diff --check` → clean.

Implementation:

- Add `task_runtime_materializes_next_recurrence_after_terminal_failure`.
- Add `TaskRuntime::record_failure_and_insert_next_if_terminal`.
- Use it for both `ExecutorResult::RetryableFailure` and executor errors.

## Next slices

## Slice 3 — scheduled/proactive prompt gate

Acceptance:

- [x] A scheduled automation materializes a visible `proactive_prompt` task with
  `automation_id`, recurrence, first `not_before`, approval policy, and retry
  policy.
- [x] Recurring occurrence ids (`root@occ@...`) resolve to one stable
  `scheduled` channel thread.

Verification:

- `cargo test -p local-first-desktop-gateway scheduled_` → green.

Implementation:

- Extracted `scheduled_thread_sender_for_task_id` and `scheduled_thread_title`.
- Added `scheduled_automation_materializes_visible_proactive_task`.
- Added `scheduled_occurrences_reuse_one_visible_thread`.

## Slice 4 — proactive review surface/dedup verification

Acceptance:

- [x] Decline/noise cases produce no card.
- [x] Cards preserve proposed actions and closed-choice quick replies.
- [x] Fuzzy dedup blocks paraphrases without collapsing unrelated cards.
- [x] Suggestion read model preserves durable dedup keys for downstream memory.

Verification:

- Existing tests:
  `proactive_parse_declines_cleanly`, `proactive_parse_builds_card`,
  `proactive_parse_extracts_choices`, `proactive_fuzzy_dedup_blocks_paraphrases`,
  `suggestions_dedup_list_and_act`.
- New test: `suggestion_lookup_preserves_durable_dedup_key`.

## WS6.4 — proactive action memory write-back

Acceptance:

- [x] Accepting or snoozing a proactive card writes an `open_loop`.
- [x] Dismissing a proactive card writes a `decision`.
- [x] Memory metadata keeps suggestion id/scope/kind/title/status/feedback/note/
  dedup/proposed_action.
- [x] Write-back is auto-confirmed in the suggestion scope.

Verification:

- `proactive_action_memory_writeback_maps_statuses` → green.
- `suggestion_lookup_preserves_durable_dedup_key` → green.

Implementation:

- `ChatStore::suggestion(id)` retrieves the durable card row.
- `suggestion_act` calls `write_proactive_action_memory` after a successful
  status update.
- `proactive_memory_request_for_suggestion_action` maps
  `accepted|snoozed → open_loop`, `dismissed → decision`.

## WS6 closure

WS6 is locally closed. Final gate:

- `cargo test -p local-first-task-runtime` → green.
- `cargo test -p local-first-desktop-gateway` → 166 passed, 1 ignored.
- `cargo build -p local-first-desktop-gateway` → green.
- `npm run build` in `apps/desktop` → green.
- `git diff --check` → clean.

Final publish should still do a quick in-app smoke test of a real scheduled
automation appearing in the `scheduled` thread.
