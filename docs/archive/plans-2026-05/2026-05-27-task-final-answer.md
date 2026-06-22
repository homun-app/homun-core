# Task Final Answer

## Scope

- Separare dati tecnici raccolti dal browser dalla risposta finale in chat.
- Produrre una risposta finale breve, leggibile e orientata all'utente.
- Tenere screenshot, snapshot ed errori tecnici nel checkpoint/Computer locale.

## Non-Scope

- Sintesi LLM live sui contenuti browser.
- Estrazione affidabile di prezzi/orari da form interattivi.
- Azioni browser write.

## Files

- `crates/desktop-gateway/src/main.rs`
- `docs/work-memory.md`
- `docs/roadmap.md`

## Acceptance Criteria

- La chat non contiene dump ` ```text ` degli snapshot browser.
- La chat non espone sequenze ANSI o errori sidecar dettagliati.
- La risposta finale include risultato, fonti, limiti e prossimo passo.
- Il checkpoint finale conserva fonti e artifact screenshot.

## Verification

- Unit test `browser_final_answer_keeps_snapshot_dump_out_of_chat`.
- Smoke gateway con task treno.
- `cargo test -p local-first-desktop-gateway`
- `npm run typecheck`
- `npm run test:ui-contract`
- `npm run build`
- `git diff --check`
