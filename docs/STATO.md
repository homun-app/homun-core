# Stato - Homun (documento vivo)

> **Ultimo aggiornamento: 2026-08-11 (Runtime V2 kernel projection convergence).**
>
> Hub: [`README.md`](README.md). Mappa codice: [`architecture/`](architecture/).
> Archive stantia: [`archive/2026-07-31-doc-reset/`](archive/2026-07-31-doc-reset/).
> Prompt lungo storico: [`HANDOFF-2026-07-31.md`](HANDOFF-2026-07-31.md).

## Identita Git

| Campo | Valore |
| --- | --- |
| Repo | `/Users/fabio/Projects/Homun/app` |
| Worktree corrente | `/Users/fabio/Projects/Homun/app/.worktrees/runtime-v2-first-slice` |
| Branch | `fabio/runtime-v2-first-slice` |
| PR | `https://github.com/homun-app/homun-core/pull/108` |
| HEAD codice verificato | `01b2ecf7` |

## Dove siamo

Homun = gateway Rust + Electron/React + sidecar. Il refactor Runtime V2 ha
portato il perimetro chat/runtime/UI su una proiezione canonica:

```text
turn_events + runtime_plans + execution_effect_receipts + agent_runs + HITL
  -> task-runtime reducer
  -> gateway KernelThreadProjection
  -> desktop presenter/runtimeViewModel
```

Il contratto as-built vive in
[`architecture/kernel-v2-contract.md`](architecture/kernel-v2-contract.md). La
matrice owner/gate vive in
[`testing/kernel-contract-matrix.md`](testing/kernel-contract-matrix.md). Il
protocollo anti-regressione vive in
[`testing/anti-regression-protocol.md`](testing/anti-regression-protocol.md).

## Runtime V2 - chiuso in questa slice

Piano completato:
[`superpowers/plans/2026-08-11-homun-unified-kernel-ui-plugin-convergence.md`](superpowers/plans/2026-08-11-homun-unified-kernel-ui-plugin-convergence.md).

Slice chiuse sul branch:

- `TaskStore::project_kernel_thread` e DTO `KernelThreadProjection`;
- endpoint gateway `GET /api/chat/threads/{thread_id}/kernel-projection`;
- presenter desktop puro `kernelProjectionPresenter`;
- `useChatActivityProjection` migrato alla proiezione kernel;
- stato browser tipizzato in `KernelBrowserView`;
- stato plugin/skill/MCP/connector in `KernelCapabilityRuntimeView`;
- marker transcript quarantinati dietro legacy adapter;
- `ChatView` ridotto a presenter shell via `runtimeViewModel`;
- automazioni/background run allineati alla stessa proiezione;
- smoke deterministico `/kernel-projection` dentro kernel/pre-release gate.

## Invarianti ora protetti

- Un turno terminale non lascia liveness UI attiva.
- Piano e progresso vengono da `runtime_plans`/`turn_events`, non da marker.
- `browser_done` chiude il lavoro browser; snapshot visibile senza done resta
  `active`/`unknown`.
- Receipt `Read` incerta non genera card di verifica utente.
- Receipt `ExternalWrite` incerta genera attention item.
- Tool/plugin/MCP caricati non cambiano liveness.
- Automazioni e proactive run usano lo stesso vocabolario del kernel.
- Marker legacy possono renderizzare storico, ma non riaprire lifecycle corrente.

## Gate verificati localmente

Su `01b2ecf7`:

```bash
python3 scripts/kernel_regression_gate.py
python3 scripts/pre_release_gate.py
make test
```

Esito: verde.

## PR / CI

PR draft: `https://github.com/homun-app/homun-core/pull/108`.

Check GitHub verdi:

- Backend (build + gateway tests)
- Frontend (typecheck + build)
- Landlock fence validation (ubuntu-24.04)
- Release readiness
- Build installers: Linux, macOS, Windows

Merge state GitHub: `CLEAN`.

## Debito residuo

- Smoke Electron reale su build/dev pulita: chat, plan progress, browser read
  research, Activity/browser island, composer mode.
- Aggiornare eventuali note release/RC dopo merge della PR.
- Tenere `ThreadActivityProjection` solo come compat endpoint finche' non resta
  nessun consumer non legacy.
- Continuare la rimozione dei fallback `legacy*` solo con fixture owner-level e
  gate kernel verde.
- `main.rs` e `ChatView.tsx` restano grandi, ma non vanno tagliati senza owner
  contract RED e Kill List esplicita.

## Prossimo lavoro

1. Merge/review della PR #108 quando il draft viene promosso.
2. Smoke Electron su checkout pulito della PR: riprodurre i due bug iniziali
   (goal/plan/progress e browser treni Milano-Roma read-only).
3. Solo dopo smoke reale, aprire la prossima slice: rimuovere un fallback
   `legacy*` ancora tracciato oppure chiudere il compat endpoint `/activity`.

## Prompt di ripartenza

```text
Continuo Homun Runtime V2. Repo: /Users/fabio/Projects/Homun/app,
branch fabio/runtime-v2-first-slice, PR #108.
Leggi docs/STATO.md, docs/architecture/kernel-v2-contract.md e
docs/testing/kernel-contract-matrix.md.
Regola: codice = verita; ogni modifica deve avere owner canonico, Kill List,
fixture/gate e rimozione del fallback non piu' necessario.
```
