# Background Task Worker

## Scope

- Avviare un worker locale nel Desktop Gateway che osserva la coda task e
  consuma automaticamente task approvati.
- Mantenere lease e resource governance gia' introdotti.
- Esporre stato executor UI-safe.
- Evitare che la UI debba chiamare manualmente `/api/tasks/run_next` dopo
  approval.

## Non-Scope

- Click, submit, login, pagamento o write browser automatici.
- Pianificazione multi-step complessa del Brain.
- Auto-apprendimento dagli eventi PC.

## Files

- `crates/desktop-gateway/src/main.rs`
- `apps/desktop/src/lib/coreBridge.ts`
- `apps/desktop/src/App.tsx`
- `apps/desktop/scripts/check-ui-contract.mjs`
- `docs/roadmap.md`
- `docs/work-memory.md`

## Acceptance Criteria

- Il gateway avvia un worker background locale.
- Un task approvato passa a running/completed senza chiamare manualmente
  `/api/tasks/run_next`.
- Il worker non esegue due volte lo stesso task grazie al lease.
- Le risorse vengono rilasciate a completamento o fallimento.
- La UI aggiorna queue, detail, chat e Computer session tramite polling locale.
- Endpoint `/api/tasks/executor` espone stato sintetico.

## Verification

- `npm run test:ui-contract` deve fallire prima del codice per il nuovo
  contratto executor.
- `cargo fmt`
- `cargo check -p local-first-desktop-gateway`
- `cargo test -p local-first-desktop-gateway`
- `npm run typecheck`
- `npm run test:ui-contract`
- `npm run build`
- Smoke gateway: crea task browser, approve, attende completamento senza
  chiamare `/api/tasks/run_next`.
- `git diff --check`
