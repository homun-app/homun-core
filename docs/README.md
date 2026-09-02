# Homun — documentazione di engineering

> **Regola:** il codice è la verità. Questi file descrivono solo ciò che è stato
> **verificato** nel tree. Se una frase non cita crate/simbolo, va trattata come
> sospetta. Data del reset: **2026-07-31**.

## Da leggere

| Documento | Ruolo |
| --- | --- |
| [`STATO.md`](STATO.md) | **Stato vivo** — dove siamo, prossimo lavoro, prompt di ripartenza |
| [`CAPISALDI.md`](CAPISALDI.md) | Principi vincolanti (non la mappa del codice) |
| [`architecture/`](architecture/) | Mappa as-built dei sottosistemi (riscritta dal codice) |
| [`architecture/action-budget-contract.md`](architecture/action-budget-contract.md) | Contratto unico per budget azioni, loop, tool/plugin e UI |
| [`production-readiness-roadmap.md`](production-readiness-roadmap.md) | Checklist unica production-grade: blocchi aperti, owner, done e verifiche |
| [`decisions/`](decisions/) | ADR immutabili — il “perché” storico, non lo stato corrente |
| [`testing/anti-regression-protocol.md`](testing/anti-regression-protocol.md) | Gate minimo per non far rientrare regressioni chat/runtime/UI |
| [`testing/kernel-contract-matrix.md`](testing/kernel-contract-matrix.md) | Matrix owner/test/smoke dei contratti kernel vivi |
| [`testing/system-risk-matrix.md`](testing/system-risk-matrix.md) | Matrice domini rischio + audit DB/log + scenari live complessi |
| [`testing/agentic-platform-readiness.md`](testing/agentic-platform-readiness.md) | Benchmark Manus/OpenClaw/Codex/OpenCode e slice prioritarie per portare Homun a piattaforma agentica business |
| [`testing/usage-scenarios.md`](testing/usage-scenarios.md) | Catalogo scenari d'uso baseline/extended per smoke live |
| [`testing/gateway-ownership-contracts.md`](testing/gateway-ownership-contracts.md) | Confini owner del gateway e regole per non far rientrare il monolite |
| [`testing/release-candidate-matrix.md`](testing/release-candidate-matrix.md) | Gate release installata |
| [`distribution.md`](distribution.md) · [`release-macos.md`](release-macos.md) · [`windows-signing.md`](windows-signing.md) | Distribuzione / firma |
| [`HANDOFF-2026-07-31.md`](HANDOFF-2026-07-31.md) | Prompt lungo per un altro agent (opzionale) |

## Non usare come specifica

Tutto ciò che è finito in
[`archive/2026-07-31-doc-reset/`](archive/2026-07-31-doc-reset/)
(vecchie `architecture/`, `DEVELOPMENT`, `METHODOLOGY`, `superpowers/`, piani,
confronti, roadmap, …) e gli altri file in `archive/`. Utile solo come storia.

## Comandi (verificati nei script / package.json)

```bash
# da app/
cargo test --workspace
cargo test -p local-first-desktop-gateway -- --nocapture
python3 scripts/kernel_regression_gate.py
python3 scripts/pre_release_gate.py

# da apps/desktop/
npm run electron:dev    # prova locale — niente bump versione
npm run test:ui-contract
npm run build
```

Gateway di default: `127.0.0.1:18765`. Vite: `127.0.0.1:1420`.
Versione desktop: vedi `apps/desktop/package.json` (non inventarla).
