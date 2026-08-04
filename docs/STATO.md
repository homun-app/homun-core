# Stato — Homun (documento vivo)

> **Ultimo aggiornamento: 2026-08-04 (gateway ownership/main.rs consolidation).**
>
> Hub: [`README.md`](README.md). Mappa codice: [`architecture/`](architecture/).
> Archive stantia: [`archive/2026-07-31-doc-reset/`](archive/2026-07-31-doc-reset/).
> Prompt lungo: [`HANDOFF-2026-07-31.md`](HANDOFF-2026-07-31.md).

## Identità Git

| Campo | Valore |
| --- | --- |
| Repo | `/Users/fabio/Projects/Homun/app` |
| Branch | `fabio/chat-lifecycle-consolidation` |
| HEAD base P0 | `75418ba8` (+ commit smoke/STATO successivi) |
| Versione | `0.1.1094` |

## Dove siamo

Homun = gateway Rust + Electron/React + sidecar. Contratto unico
`ExecutionContract → execute → ExecutionOutcome`. Loop unico
`engine::agent_loop::run_turn`. Vedi [`architecture/overview.md`](architecture/overview.md).

### Consolidamento chat lifecycle/rendering — branch `fabio/chat-lifecycle-consolidation`

Obiettivo corrente: consolidare contratti esistenti, non aggiungere feature.
I contratti vivi sono in [`architecture/chat-lifecycle.md`](architecture/chat-lifecycle.md);
il gate anti-regressione e' in
[`testing/anti-regression-protocol.md`](testing/anti-regression-protocol.md).
L'evidenza QA della slice e' in
[`testing/chat-lifecycle-consolidation-qa.md`](testing/chat-lifecycle-consolidation-qa.md).

Slice completate nel branch:

- view model frontend per lifecycle/composer in `apps/desktop/src/lib/chat-runtime`;
- filtro visible content condiviso per streaming/persistito;
- classifier Rust `crates/task-runtime/src/turn_lifecycle.rs`;
- cleanup durable di steering non settled a fine turno;
- contratti CSS/test per prompt utente senza frame, editor multilinea e
  overlay workspace/browser non sovrapposti.
- gate unico `scripts/kernel_regression_gate.py` con smoke live opzionale
  `scripts/kernel_live_smoke.py` per modello/gateway/browser/reasoning.
- estrazione gateway `gateway_turn_broker.rs` per enqueue/resume/cancel/eventi,
  stream, activity projection e steering.
- estrazione gateway `gateway_task_executor.rs` per queue task, approval,
  acquire/lease/finalizzazione, worker, progress checkpoint e sync sessione.
- contratto ownership in
  [`testing/gateway-ownership-contracts.md`](testing/gateway-ownership-contracts.md),
  coperto da `execution_ownership_inventory.rs`,
  `scripts/check_gateway_main_contract.py` e gate kernel.

### P0 — fatto

**Gate deterministici (ALL GREEN)** su `75418ba8` (+ wasmtime 46.0.2):

- `cargo fmt` / `clippy -D warnings` / `pre_release_gate.py` **ALL GREEN**
- `cargo audit` verde; `npm audit --audit-level=high` 0 vuln
- Mappe `contained-computer` / `host-computer-control` ripristinate as-built

**`scripts/production_smoke.py`** migrato al broker (`POST /api/chat/threads` +
`/api/chat/turns` + poll events).

**Live `electron:dev` (1420 / 18765):**

| Check | Esito |
| --- | --- |
| Health / cancel / concurrent / restart | PASS (incluso SIGKILL → watchdog) |
| S1, S2, S6, S7 | PASS (broker smoke) |
| Runtime sandbox | `workspace-write` |
| Uncertain effects API | 200 |
| **Vault PIN setup** | PASS — PIN QA sintetico `246810` sul profilo locale |
| **Vault seed CF + targa** | PASS via `/api/vault/proposals/accept` |
| **Vault list redacted** | PASS — no CF/targa in plaintext |
| **Vault reveal + PIN** | PASS corretto; **FAIL chiuso** su PIN sbagliato (`invalid_vault_pin`) |
| Smoke S3/S4 (marker dal modello) | **FAIL** — modello locale non emette `VAULT_REVEAL`/`VAULT_PROPOSE`; contratto API Vault comunque verde |
| **Browser crash sidecar** | PASS (vedi sotto) |
| **Sandbox write allow/deny** | PASS fence+config (vedi sotto); chat model-driven **PARTIAL** |

### Browser crash sidecar — evidenza

| Gate | Esito |
| --- | --- |
| `crash_recovery_stdio.test.ts` | PASS — restore `adopted_live_page` + stale generation rejected |
| `effect_host::tests::browser_action_process_loss_becomes_uncertain_and_never_executes_again` | PASS — process loss → `Uncertain`, no second execute |
| Live SIGKILL sotto gateway | PASS — kill `npm run start` durante browse; turn completed; no Uncertain card mid-act |

### Sandbox write allow/deny — evidenza

| Gate | Esito |
| --- | --- |
| `seatbelt_fence_allows_in_root_denies_out_of_root` | PASS — `sandbox-exec` scrive in-root; fuori (`$HOME`) → `Operation not permitted`, file assente |
| `seatbelt_fence_allows_per_project_extra_writable_folder` | PASS |
| `tool_safety::tests` (26) incluso `write_under_workspace_write_allows_only_inside_roots` | PASS |
| `project_path_jail_blocks_escapes` / `absolute_jail_accepts_nested…` | PASS |
| Live `GET /api/runtime/settings` | PASS — `sandbox_mode=workspace-write` |
| Live workspace + policy | PASS — create folder workspace, `POST …/policy` → `workspace-write` |
| Live thread folder bind | PASS — `POST /api/chat/threads/{id}/folder` |
| Live chat `write_file` allow/deny | **PARTIAL** — allow turn stuck senza eventi (~6 min, poi cancel); deny completed senza creare file fuori root ma il modello ha risposto “no write_file tool” (non ha esercitato il fence via tool) |

Autorità del residuo: **fence OS + jail + shadow policy + config live**. Il path agent/chat resta model-dependent (stessa classe di S3/S4).

### Residuo live

- Approval + resolve `Uncertain` applicato (`applied` / `not_applied`)
- Presentazioni template + automazioni `pending_verification`
- Smoke UI (menu/sidebar/temi)
- (Opzionale) S3/S4 / write chat con modello più capace

### Debito noto

- `main.rs` ~30.3k sul branch `fabio/chat-lifecycle-consolidation`; ulteriori
  tagli solo con owner contract RED e gate completo.
- `ChatView.tsx` ~10k
- `HOMUN_MEMORY_SERVICE` default OFF; `OrchestratorBrain` ancora materializza task
- Profilo locale ora ha PIN Vault QA e due record sintetici (CF + targa) — solo metadata in list
- Workspace QA `sandbox-write-probe` creati in temp durante collaudo (pulibili)

## Prossimo lavoro

1. Residuo live: uncertain resolve / presentazioni-automazioni / UI smoke.
2. P1 rifinitura UI.
3. RC draft dopo evidenza sullo stesso SHA.

## Prompt di ripartenza

```text
Continuo Homun. Repo: /Users/fabio/Projects/Homun/app, branch fabio/chat-lifecycle-consolidation.
Leggi docs/STATO.md e docs/testing/gateway-ownership-contracts.md.
Branch corrente: fabio/chat-lifecycle-consolidation. Obiettivo: consolidamento,
non nuove feature. main.rs e' ~30.3k; nuovi tagli solo con test RED in
execution_ownership_inventory.rs, check_gateway_main_contract.py e
kernel_regression_gate.py. Non pubblicare.
```
