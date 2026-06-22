# Task Progress Checkpoints

## Scope

- Scrivere checkpoint/eventi intermedi durante l'esecuzione dei task.
- Rendere visibile in timeline cosa sta accadendo senza disturbare la risposta.
- Mantenere l'ultimo checkpoint come risultato finale del task.

## Non-Scope

- Sintesi LLM dei risultati browser.
- Azioni browser write/click/submit.
- Nuova UI per il dettaglio task.

## Files

- `crates/desktop-gateway/src/main.rs`
- `docs/work-memory.md`
- `docs/roadmap.md`

## Acceptance Criteria

- Il task scrive `execution_started` appena preso in carico.
- Il browser task scrive eventi per runtime, fonte iniziata, fonte completata
  o fallita, e sintesi avviata.
- Il task finale conserva `latest_checkpoint.kind = browser_read_only`.
- La timeline Computer espone eventi intermedi redatti.

## Verification

- Smoke gateway: task treno approvato, worker automatico, timeline con
  `browser_source_*`, risultato finale in chat.
- `cargo test -p local-first-desktop-gateway`
- `npm run typecheck`
- `npm run test:ui-contract`
- `npm run build`
- `git diff --check`
