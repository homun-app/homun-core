# Runtime Diagnostics UI

## Scope

- Rendere la sezione Settings -> Runtime locale utile per test reali:
  - stato sintetico gateway/Gemma;
  - PID, porta, memoria, CPU e duplicati;
  - azioni avvia/riavvia/ferma gia' collegate al gateway;
  - log runtime redatti quando Gemma e' gestito dal gateway;
  - copia diagnostica redatta.

## Non Scope

- Packaging produzione Electron.
- Log streaming persistenti su disco con retention.
- Nuovi comandi nativi Electron.
- UI completa del Process Manager multi-processo.

## Files

- `apps/desktop/src/components/SettingsView.tsx`
- `apps/desktop/src/styles.css`
- `apps/desktop/src/types.ts`
- `apps/desktop/src/App.tsx`
- `apps/desktop/scripts/check-ui-contract.mjs`
- `crates/desktop-gateway/src/main.rs`
- `crates/process-manager/src/manager.rs`
- `docs/work-memory.md`
- `docs/roadmap.md`

## Acceptance Criteria

- La pagina Runtime mostra stato leggibile senza aprire console.
- Le metriche sono leggibili su desktop e mobile.
- La diagnostica copiabile non contiene raw prompt o segreti.
- Il pannello log non espone errori interni o segreti.
- Le azioni runtime restano quelle del gateway locale.
- TypeScript, contratto UI e build passano.

## Verification

- `npm run typecheck`
- `npm run test:ui-contract`
- `npm run build`
- `cargo test -p local-first-process-manager -p local-first-desktop-gateway`
- Playwright snapshot desktop e mobile su `http://127.0.0.1:1420/`
