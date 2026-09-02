# Stato - Homun (documento vivo)

> **Ultimo aggiornamento: 2026-08-26 (PR #406 RC readiness verde: preflight temporale, bootstrap piano prima dei tool complessi, recovery sidebar fuori chat e fingerprint semantico browser verificati localmente; CI, release readiness e build installer macOS/Linux/Windows verdi; smoke live gateway/UI eseguiti su `electron:dev`).**
>
> Hub: [`README.md`](README.md). Mappa codice: [`architecture/`](architecture/).
> Archive stantia: [`archive/2026-07-31-doc-reset/`](archive/2026-07-31-doc-reset/).
> Prompt lungo storico: [`HANDOFF-2026-07-31.md`](HANDOFF-2026-07-31.md).

## Identita Git

| Campo | Valore |
| --- | --- |
| Repo | `/Users/fabio/Projects/Homun/app` |
| Worktree corrente | `/Users/fabio/Projects/Homun/app` |
| Branch | `fabio/rc-readiness-2026-08-26` candidato RC; `main` dopo merge #406 |
| PR | #108-#116, #118-#283, #285-#286 e #288-#405 mergeate in `main`; #406 RC readiness validata in PR; #117 browser draft separata; #284 e #372 chiuse non mergeate dopo retarget stack |
| HEAD codice verificato | base `main` aggiornata a #405 (`b76fe0d2`), PR #406 verificata localmente e in CI |

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
[`architecture/kernel-v2-contract.md`](architecture/kernel-v2-contract.md). Il
contratto budget/azioni vive in
[`architecture/action-budget-contract.md`](architecture/action-budget-contract.md). La
matrice owner/gate vive in
[`testing/kernel-contract-matrix.md`](testing/kernel-contract-matrix.md). Il
protocollo anti-regressione vive in
[`testing/anti-regression-protocol.md`](testing/anti-regression-protocol.md).

## Lifecycle Integrity - 2026-08-31

Slice locale su `fabio/lifecycle-integrity-audit`: l'audit read-only del core
ora copre anche stati lifecycle impossibili prima visibili solo nelle chat reali:

- `scripts/audit_homun_state.py` segnala run `running` senza task attivo,
  messaggi assistant `streaming`/`retrying` senza run attivo, task completati con
  `browser_budget_exceeded` e task `waiting_user_approval` senza approval/HITL
  canonico;
- `crates/task-runtime/src/store.rs::audit_runtime_integrity` espone la stessa
  proiezione strutturata per il runtime;
- `/api/integrity/audit` restituisce anche `runtime`, oltre a `memory`, `vault`
  e `graphs`, senza includere contenuto sensibile del task.

Evidenza locale:

- `python3 -m unittest scripts.test_audit_homun_state -v`
- `cargo test -p local-first-task-runtime runtime_integrity_audit_reports_lifecycle_contradictions -- --nocapture`
- `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway integrity_audit -- --nocapture`
- `python3 scripts/kernel_regression_gate.py` -> `ALL GREEN`

Audit read-only sul profilo reale/default del 2026-08-31: `python3
scripts/audit_homun_state.py` torna `ok=false` con 51 errori e 217 warning.
I codici principali osservati sono `completed_task_with_browser_budget_exceeded`
(37), `streaming_assistant_without_active_run` (2),
`waiting_approval_task_without_canonical_approval` (4),
`log_contains_sensitive_plaintext` (8), piu' debito storico warning su HITL,
memoria senza evidence e `agent_run_missing_model_attribution`. La slice e'
diagnostica/read-only: non ripara ancora il profilo reale.

## Automation Dry Run - 2026-08-31

Slice locale su `fabio/automation-dry-run`: le automation ora hanno un endpoint
di validazione non mutante per scenario lab e UI. `POST
/api/automations/dry-run` riusa il validatore canonico delle recurrence, ma non
persiste la rule e non materializza task. La risposta e' metadata-only
(`valid`, workspace, tipo trigger, approval/source, `next_run` e se verrebbe
creato il driving task), senza ritornare titolo, prompt o trigger completo.

Evidenza locale:

- `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway automation_dry_run -- --nocapture`
- `python3 -m unittest scripts.test_production_smoke -v`

## Browser Island PiP - 2026-08-31

Slice locale su `fabio/browser-island-pip-direct`: il click Browser nella
workspace island resta una richiesta PiP/dock, non una apertura della colonna
inspector. La logica pura ora espone anche `browserDockRequested`, il rail
Browser mantiene la side island chiusa e `ChatView` chiude l'inspector per
lasciare visibile il dock del browser gia' montato nella chat.

Evidenza locale:

- `cd apps/desktop && node --test src/lib/workspaceIslandSections.test.mjs`
- `cd apps/desktop && npm run build`

## Gateway Token Packaged App - 2026-08-31

Slice locale su `fabio/packaged-gateway-token-file`: Electron usa lo stesso
contratto token in dev e packaged. Se `HOMUN_DESKTOP_GATEWAY_TOKEN` e' esplicito
vince l'env; altrimenti l'app riusa o crea `~/.homun/desktop-gateway-token` con
permessi privati. Questo rende eseguibili gli smoke CLI contro l'app installata
reale invece di lasciare il gateway packaged con un bearer token random solo in
memoria.

Evidenza locale:

- `cd apps/desktop && node --test tests/gateway-token.test.mjs`
- `cd apps/desktop && node --test tests/electron-gateway-startup.test.mjs tests/electron-main-names.test.mjs tests/gateway-token.test.mjs`

## Package Cargo Target Dir - 2026-08-31

Slice locale su `fabio/package-cargo-target-dir`: `prepare-package.mjs` non
assume piu' `repoRoot/target/release`, ma copia gateway e channel bridge dal
`target_directory` risolto da `cargo metadata`. Questo chiude il rischio di
staging/release con binari vecchi quando Cargo usa un target dir esterno.

Evidenza locale:

- `cd apps/desktop && node --test tests/release-workflow.test.mjs`
- `cargo build -p local-first-desktop-gateway --release`
- `python3 scripts/production_smoke.py --profile extended --scenario X5 --gateway-base http://127.0.0.1:18766` -> `PASS X5`

## Browser Smoke Semantic Failure - 2026-08-31

Slice locale su `fabio/browser-smoke-semantic-failure`: gli smoke S5/S9 non
accettano piu' come successo una risposta browser che include numerazione o
fonti ma dichiara timeout/fallimento operativo (`non ho dati verificati`,
`ricerca non andata a buon fine`, `andata in timeout`). Il caso nasce da S9 live
che aveva terminalizzato `completed` pur rispondendo che la ricerca treni non
aveva prodotto dati verificati.

Evidenza locale:

- `python3 -m unittest scripts.test_production_smoke -v`
- `python3 scripts/production_smoke.py --profile all --scenario S9 --gateway-base http://127.0.0.1:18766` -> `PASS S9` con criterio piu' severo

## Smoke Thread Cleanup - 2026-08-31

Slice locale su `fabio/smoke-thread-cleanup`: `production_smoke.py` elimina il
thread chat creato da uno scenario passato e conserva invece il thread quando lo
scenario fallisce, cosi' il profilo reale resta piu' pulito senza perdere
evidenza diagnostica sui fail.

Evidenza locale:

- `python3 -m unittest scripts.test_production_smoke -v`
- `python3 scripts/production_smoke.py --profile all --scenario S1 --gateway-base http://127.0.0.1:18766` -> `PASS S1`, conteggio `smoke S1` invariato a 0

## Subagent Runtime Audit - 2026-08-31

Audit read-only con subagente: Homun ha queue, lease, retry e checkpoint per
`subagent.*`, ma non e' ancora affidabile quanto Codex sui task lunghi. I punti
da chiudere sono: delega broker-owned e fail-visible, proiezione parent/child
con id/checkpoint/result, e consegna risultato idempotente via outbox invece di
append sincrono dopo `mark_task_completed`.

## Model Selector Clarity - 2026-08-31

Slice locale su `fabio/model-selector-clarity`: il composer mantiene la
semantica next-turn (`Auto` non e' l'ultimo modello assistant) ma, quando il
runtime context contiene la rotta effettiva, la label del bottone modello puo'
mostrare `Auto -> role -> provider/model` e il titolo nativo conserva la stringa
completa anche quando il bottone tronca visivamente.

Evidenza locale:

- `cd apps/desktop && node --test src/lib/composerTurnContract.test.mjs`
- `cd apps/desktop && npm run build`

## Core Observability Audit - 2026-09-01

Slice locale su `main`: `scripts/audit_homun_state.py` ora produce anche una
sezione `observability` read-only. La sezione costruisce timeline redatte per i
turni chat recenti unendo `tasks`, `agent_runs`, `agent_run_events` e
`turn_events`. Il report runtime esposto da `/api/integrity/audit` espone lo
stesso nucleo di gap diagnostici per la dashboard: run terminali senza
`terminal_reason`, run senza role/provider/model, run senza journal
round/tool/model e turn non pendenti senza `turn_events`.
Settings -> Runtime mostra ora un riquadro "Core diagnostics" alimentato dallo
stesso endpoint, con contatore e codici dei gap senza esporre ref di run/turn.
Nel composer, lo stato modello `Auto` senza risoluzione osservata viene mostrato
come `Auto (unresolved)` invece di sembrare una route gia' funzionante.
Il percorso normale di generazione chat ora fa backfill di `model/provider`
sulla `agent_runs` canonica appena la route effettiva e' risolta; i gap storici
restano diagnosticabili, ma le nuove run non dovrebbero piu' nascere mute.
Lo script diagnostico supporta ora anche `--data-dir` per auditare un profilo
Homun completo e include `paths.data_dir`/`paths.sources` nel JSON, cosi' un
report distingue default `~/.homun`, env e override CLI invece di confondere
profili diversi.
L'audit memoria distingue inoltre `legacy_memory_without_evidence` dai record
moderni con `metadata.admission` ma senza link: sul profilo reale i record senza
provenance risultano legacy, mentre un nuovo `memory_without_evidence` resta una
regressione della pipeline attuale.

La timeline non include testo utente/assistant o payload raw; riporta solo fasi,
status, id tecnici, modello effettivo e piccoli campi diagnostici consentiti
(`status`, `code`, `error_code`, `tool`, `tool_name`, `terminal_reason`,
`tool_calls`) con detector privacy applicato.
Le timeline sono inoltre bounded per default: ogni turno riporta
`events_total`/`events_omitted` e stampa solo un campione testa+coda degli
eventi, cosi' un browser/task rumoroso non rende inutilizzabile il report CLI
ma conserva comunque la coda terminale per capire come si e' chiuso il turno.

Evidenza locale:

- `python3 -m unittest scripts.test_audit_homun_state -v`
- `python3 scripts/audit_homun_state.py --max-findings-per-code 3 --max-timeline-events 20`
  sul profilo reale -> report bounded con timeline campionate
- `python3 scripts/audit_homun_state.py --data-dir "$tmp" --max-findings-per-code 0`
  -> `paths.sources.data_dir=--data-dir`
- `python3 scripts/audit_homun_state.py --max-findings-per-code 0` sul profilo
  reale -> `legacy_memory_without_evidence=100`, nessun
  `memory_without_evidence`
- Packaged smoke su gateway `http://127.0.0.1:18766`:
  `X5` automation scoped lifecycle -> `PASS X5: 0.0s`,
  `X6` MCP stdio scoped lifecycle -> `PASS X6: 0.8s`,
  `X7` long business checkpoint -> `PASS X7: 74.9s`,
  `S8` payment approval browser fixture -> `PASS S8: 61.7s`
- Smoke reale `S8` ha scoperto un residuo runtime: la cancellazione del thread
  passava ma lasciava il relativo `chat_turn` in `waiting_user_approval` senza
  approval/HITL canonico. Fix locale: `DELETE /api/chat/threads/{thread_id}`
  ora purga anche i `chat_turn` runtime scoped al thread; con binario release
  aggiornato `S8` resta `PASS S8: 65.7s` e il conteggio orphan non aumenta.
  I 3 residui creati dai run precedenti sono stati chiusi via
  `/api/integrity/repair/apply` con backup runtime `392896512` bytes; audit CLI
  successivo -> `ok=true`.
  Durante la verifica e' emerso anche che `package:smoke` poteva riusare un
  release binary stale perche' forzava `--skip-build`; ora `package:smoke`
  ricostruisce il package, mentre `package:smoke:fast` conserva il path rapido
  esplicito per chi vuole riusare binari gia' preparati. Il gateway dello smoke
  package usa inoltre `127.0.0.1:18768`, non `18766`/`18767`, per non collidere
  con i sidecar WhatsApp/Telegram quando si testa un profilo reale.
  L'audit reale successivo ha scoperto 2 `chat_turn` storici in `waiting_time`
  senza alcuna `execution_wake` pending: ora CLI e `/api/integrity/audit`
  segnalano `waiting_time_task_without_pending_wake`, e
  `/api/integrity/repair/apply` supporta
  `fail_waiting_time_without_pending_wake` con backup/token per fallire solo i
  timer senza sveglia canonica ancora presenti.
- `cargo test -p local-first-task-runtime runtime_integrity_audit_exposes_observability_gaps_without_task_content -- --nocapture`
- `cargo test -p local-first-task-runtime runtime_integrity_repair_fails_waiting_time_without_pending_wake -- --nocapture`
- `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway integrity_repair_apply_fails_waiting_time_without_pending_wake_without_exposing_paths -- --nocapture`
- `cargo test -p local-first-task-runtime thread_chat_turn_purge_deletes_owned_runtime_rows_only -- --nocapture`
- `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway delete_chat_thread_purges_its_execution_journal -- --nocapture`
- `cd apps/desktop && node --test tests/release-workflow.test.mjs`
- `cd apps/desktop && npm run test:ui-contract`
- `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway integrity_audit_reports_runtime_lifecycle_findings_without_content -- --nocapture`
- `cd apps/desktop && node --test src/lib/runtimeContext.test.mjs`
- `cd apps/desktop && node --test src/lib/composerTurnContract.test.mjs src/lib/runtimeContext.test.mjs`
- `cd apps/desktop && npm run build`
- `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway agent_run_api_tests -- --nocapture`
- `python3 scripts/check_gateway_main_contract.py`
- `cargo fmt --all -- --check`
- `python3 -m py_compile scripts/audit_homun_state.py scripts/test_audit_homun_state.py`
- `python3 scripts/audit_homun_state.py --max-findings-per-code 0` sul profilo
  reale, prima del detector plan finale -> `ok=true`, `errors=0`,
  `warnings=218`, `observability.timelines=20`,
  `observability.diagnostic_gaps=100`

## Packaged Production Smoke - 2026-09-01

Slice locale su `main`: il package smoke e' stato ricostruito e rieseguito sul
profilo reale con gateway dedicato `http://127.0.0.1:18768`, separato dai
sidecar WhatsApp/Telegram. La matrice smoke ora fallisce se uno scenario richiesto
non appartiene al profilo selezionato, evitando falsi verdi tipo
`--scenario X5` senza `--profile all`.

Risultati osservati sul package ricostruito:

- `X5` automation API lifecycle -> `PASS X5: 0.0s`
- `X6` MCP stdio API lifecycle -> `PASS X6: 0.0s`
- `X2` skill/tool selection -> `PASS X2: 16.0s`
- `X4` code workspace routing -> `PASS X4: 40.6s`
- `X7` long business process checkpoint -> `PASS X7: 40.5s`
- `X1` automation via chat -> `PASS X1: 49.0s`
- `X3` memory/privacy -> `PASS X3: 23.7s`
- `S1` chat semplice -> `PASS S1: 11.5s`
- `S2` operational prompt -> `PASS S2: 9.9s`
- `S3` chat lunga con piano -> `PASS S3: 67.3s`
- `S4` modello/route semplice -> `PASS S4: 11.4s`
- `S5` browser base -> `PASS S5: 90.8s`
- `S6` browser form-fill -> `PASS S6: 137.6s`
- `S7` dead URL plan settles -> `PASS S7: 68.7s`
- `S8` payment approval browser fixture -> `PASS S8: 56.5s`
- `S9` Italian locale web discovery -> `PASS S9: 155.6s`

Il fallimento iniziale di `S9` non era un problema di risposta finale: la chat
aveva prodotto tre risultati numerati con fonti, ma l'ultimo `plan_update`
restava con uno step aperto. `scripts/audit_homun_state.py` ora segnala
`completed_turn_with_incomplete_plan` e il runtime chiude correttamente anche i
report numerati con link sorgente, non solo le tabelle.

Evidenza locale aggiunta:

- `python3 -m unittest scripts.test_production_smoke -v`
- `python3 scripts/production_smoke.py --gateway-base http://127.0.0.1:18768 --scenario X5`
  -> exit `2`, scenario non selezionato dal profilo `baseline`
- `python3 scripts/production_smoke.py --gateway-base http://127.0.0.1:18768 --profile all --scenario X5 --scenario X6`
  -> `PASS X5`, `PASS X6`
- `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway reconcile_final_plan_marker_closes_numbered_report_with_source_link -- --nocapture`
- `python3 -m unittest scripts.test_audit_homun_state -v`
- `cargo fmt --all -- --check`
- `python3 scripts/pre_release_gate.py`
- `cd runtimes/browser-automation && npm audit --audit-level=high`
  -> `found 0 vulnerabilities`
- `cd apps/desktop && npm run package:prepare`; poi
  `cd apps/desktop/.package/resources/browser-automation && npm audit --audit-level=high`
  -> `found 0 vulnerabilities`, `nanoid=3.3.18`

Stato profilo reale dopo la classificazione del piano finale:

- `scripts/audit_homun_state.py --max-findings-per-code 3 --max-timeline-events 20`
  -> `ok=true`, `errors=0`, `warnings=151`
- I vecchi `completed_turn_with_incomplete_plan` con risposta consegnata sono
  ora classificati come
  `completed_turn_with_unreconciled_delivered_plan=28` solo quando anche
  l'ultimo `runtime_plans` del thread e' ancora `open` con step aperti. I marker
  storici su thread senza piano runtime corrente o gia' `settled` non sono piu'
  conteggiati come bug corrente.
- La delivery reconciliation ora copre due casi moderni osservati negli smoke
  reali: risposta breve ma verificata con source (es. form Selenium compilato) e
  failure terminale browser/DNS, che blocca l'ultimo step invece di lasciarlo
  `doing`.
- I vecchi `agent_run_missing_model_attribution` con `prompt_snapshot` che
  contiene gia' `model` e `provider` non sono piu' contati come gap
  diagnostici: Auto/Unavailable e' spiegabile dagli eventi canonici anche se la
  riga storica non era backfillata. Restano 23 run storiche davvero non
  attribuibili perche' prive di ruolo o prive di snapshot modello/provider.
- I vecchi `resolved_hitl_without_followup_run` senza alcuna `agent_run` nel
  thread non sono piu' contati come gap HITL moderno: sono conversazioni di
  luglio precedenti alla strumentazione `agent_runs`, con evidenza runtime in
  `turn_events` ma senza owner osservabile per la run.
- Warning: `agent_run_missing_model_attribution=23`,
  `legacy_memory_without_evidence=100`,
  `completed_turn_with_unreconciled_delivered_plan=28`.

Blocchi residui prima di dichiarare una release production-grade:

- attendere CI verde sull'ultimo commit di `main` prima di taggare una nuova
  release;
- se si taglia una build pubblica, verificare artefatti, checksum,
  signing/notarization e smoke sull'app installata, non solo sul sorgente.

## RC readiness - 2026-08-26

Branch candidato: `fabio/rc-readiness-2026-08-26`, PR #406, su base `main`
#405 (`b76fe0d2`). Questa slice stabilizza i regressi osservati nelle chat
reali senza introdurre un nuovo owner parallelo:

- `crates/desktop-gateway/src/gateway_temporal_preflight.rs` intercetta richieste
  operative con slot assoluto gia' nel passato prima di creare task eseguibili o
  riservare il browser; il broker persiste user+assistant e un evento terminale
  `done`.
- `crates/engine/src/agent_loop.rs` crea un piano canonico minimo prima del primo
  tool di lavoro complesso quando il modello non ha ancora prodotto un piano; il
  piano viene persistito ed emesso come `plan_update`, non come finta prosa
  assistant.
- `crates/task-runtime/src/store.rs` chiude gli step `doing` come `done` solo per
  terminali `canonical_completed`; gli altri terminali espongono lo step come
  `blocked`.
- `crates/desktop-gateway/src/gateway_tool_execution.rs` confronta snapshot
  browser con fingerprint semantico stabile, ignorando churn di ref e page stats,
  cosi' una SPA non viene scambiata per progresso reale.
- `apps/desktop/src/components/Shell.tsx` espone i controlli di riapertura
  sidebar anche nelle viste non-chat, dove `ChatTopbar` non e' presente.

Evidenza locale sul branch:

- `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_temporal_preflight -- --nocapture`
- `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway broker_temporal_preflight -- --nocapture`
- `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway browser_snapshot_semantic_fingerprint -- --nocapture`
- `cargo test -p local-first-engine plan_gate_ -- --nocapture`
- `cargo test -p local-first-task-runtime kernel_thread_projection_terminal_turn -- --nocapture`
- `npm run test:cursor-grammar`
- `python3 scripts/kernel_regression_gate.py` -> `ALL GREEN`
- `python3 scripts/pre_release_gate.py` -> `ALL GREEN`
- PR #406 CI: frontend, backend, Landlock, release readiness, build installer
  macOS/Linux/Windows -> green

Smoke live su `npm run electron:dev`:

- preflight temporale reale: richiesta treno Milano-Roma 25 agosto 2026 ore 8
  rifiutata con testo "gia' nel passato", un solo evento terminale, proiezione
  `idle`, nessuna attesa utente;
- `scripts/production_smoke.py --scenario S1`: chat semplice terminale
  `canonical_completed`;
- `scripts/kernel_live_smoke.py`: browser reale su `https://www.selenium.dev`,
  titolo `Selenium`, terminale `canonical_completed`;
- `scripts/production_smoke.py --scenario S6`: browser form-fill Selenium
  terminale `canonical_completed`; eventi: `plan_update` prima dell'apertura
  browser;
- `scripts/production_smoke.py --scenario S7`: URL `.invalid` termina con
  diagnosi esplicita e piano bloccato, non resta in thinking;
- smoke UI Playwright su `http://127.0.0.1:1420/`: Automations -> Collapse
  sidebar mostra `Expand sidebar` e `Search`; `Expand sidebar` ripristina il
  menu principale.

Limite non chiuso da questa slice: siti web complessi come Trenitalia/Trainline
restano una sessione browser dedicata e non sono un claim production-grade per
la RC.

## Runtime V2 - chiuso su main

Piano completato:
[`superpowers/plans/2026-08-11-homun-unified-kernel-ui-plugin-convergence.md`](superpowers/plans/2026-08-11-homun-unified-kernel-ui-plugin-convergence.md).

- Slice doc composer-mode owner cleanup mergeata #381: `chat-lifecycle` e
  `anti-regression-protocol` non devono piu' citare il vecchio owner rimosso
  `composerMode.{mjs,ts}` o `composerMode.test.mjs`; la modalita' composer resta
  owner del presenter (`runtimeViewModel.composerMode`) e di
  `routeComposerSubmission`.
- Slice App mock transcript seed mergeata #386: `App` non importa piu'
  `mockData` per inizializzare la transcript del thread di default,
  `messageCount` parte da zero e `mockData` non deve piu' esportare
  `chatMessages`; la transcript iniziale resta vuota finche' il read model
  canonico del gateway non la popola.
- Slice capability mock fallback mergeata #388: `useCapabilityController` non
  inizializza piu' le connessioni da `mockData`, non ripiega piu' su
  `connections` quando il gateway restituisce uno snapshot vuoto e `mockData`
  non deve piu' esportare `connections`; la pagina Settings > Connections segue
  solo il read model capability canonico del gateway.
- Cleanup unused mock runtime exports: `mockData` non esporta piu'
  `computerSession`, `tasks`, `approvals`, `runtimeHealth`, `memorySummary`,
  `drawerTasks` o `drawerProjects`; i read model runtime devono arrivare dai
  rispettivi owner gateway/controller.
- Slice mock data owner split mergeata #392: il file misto
  `apps/desktop/src/data/mockData.ts` e' stato rimosso; nav/settings vivono in
  `navigationConfig.ts`, le superfici demo Learning/Brain in
  `demoWorkspaceData.ts` e nessun controller runtime deve importare un owner
  mock ambiguo.
- Slice preview thread fallback mergeata #395: `useChatThreadCreation` non crea piu'
  thread sintetici `thread_preview_*` quando la creazione fallisce; il fallback
  locale residuo resta confinato nell'owner `chatApi`, da rimuovere in una slice
  separata quando il contratto preview/local sara' chiaro.
- Slice initial thread loader starter fallback mergeata #397: `useInitialChatThreadsLoader`
  non importa piu' `starterMessages` e non semina messaggi locali quando
  `chatMessages` non risponde; il loader iniziale resta consumatore del read
  model gateway/chatApi e non owner del transcript.
- Slice read-model starter helper mergeata #399: `useChatReadModelController`
  non importa piu' `starterMessages`, `appCoreMappers` non lo esporta piu' e il
  transcript attivo resta vuoto finche' `threadMessages` non contiene messaggi
  canonici.
- Slice local chat ready seed mergeata #400: il fallback local-only di `chatApi`
  conserva la modalita' offline/dev, ma non crea piu' `electron_ready`, non
  semina messaggi assistant canned e inizializza i thread locali con
  `message_count: 0`.
- Slice empty hero subtitle mergeata #401: i cataloghi i18n non esportano piu'
  `chat.emptyHeroSub`; l'empty hero usa solo il greeting del presenter e resta
  protetto da `chatGreeting.test.mjs`, `statusDocCurrent.test.mjs`, typecheck,
  `npm test` e matrice release/installer verde.
- Slice thread preview readiness copy mergeata #402: il placeholder thread iniziale
  e `updateThreadPreview` non devono piu' mostrare copy statiche di readiness
  (`Local session ready`, `Local chat ready`) quando il transcript e' vuoto; la
  sidebar deve restare vuota finche' il read model canonico o un messaggio reale
  non fornisce preview.
- Slice localSessionReady i18n key mergeata #403: dopo #402 la key
  `chat.localSessionReady` non aveva piu' consumer UI; i cataloghi non devono
  conservarla come copy morta di readiness locale.
- Slice chatApi static local subtitles mergeata #404: il fallback local-only di
  `chatApi` resta confinato come modalita' offline/dev, ma non deve esporre
  subtitle statiche `Local chat` o `Local model`; i thread locali partono con
  subtitle vuota e, dopo messaggi reali, la preview deriva dall'ultimo messaggio.
- Audit finale non-browser post-#404 completato: le occorrenze residue
  `Local model` in `useChatTurnSubmission`/`useChatStreamResume`/`coreBridge`
  sono provenance message-scoped del modello che produce una risposta; il
  `Local chat` residuo in `coreBridge` resta browser/local-computer scoped e va
  trattato nella sessione browser dedicata, non nel refactor non-browser.
- Slice task queue canonical empty mergeata #384: `useTaskQueueController` non
  inizializza piu' task/approval da `mockData` e `taskQueueProjection` conserva
  le lane canoniche vuote del kernel come vuote; `fallbackTasks` non deve
  tornare come seconda sorgente di busy state.
- Slice retired selected task projection mergeata #383: rimossi
  `selectedTaskProjection.{mjs,ts}` e il test dedicato; `App` resta vincolata a
  non reimportare lo stato selected-task ritirato.
- Slice UI composer-mode presenter contract mergeata #379: `kernelProjectionPresenter`
  possiede anche il fallback `composerMode` per lo streaming locale prima che la
  projection kernel sia caricata; `routeComposerSubmission` consuma solo il
  `runtimeViewModel.composerMode` normalizzato e non branchia piu' su
  `projectionLoaded`. Kill List completata: rimossi `composerMode.{mjs,ts}` e il test
  legacy dedicato al fallback locale.
- Slice runtimeViewModel turn contract mergeata #377: `kernelProjectionPresenter`
  espone anche `runtimeViewModel.turnUiState.status`; `ChatView`,
  `useChatBrowserActivityLifecycle` e `useChatActivityProjection` non esportano
  piu' `projectedActiveTurn`/`projectedTurnStatus` come contratti paralleli.
- Slice UI lifecycle cleanup mergeata #375: il vecchio owner desktop
  `apps/desktop/src/lib/chat-runtime/lifecycle.{mjs,ts}` e' stato rimosso dopo
  #374; `kernelProjectionPresenter`/`runtimeViewModel.turnUiState` restano la
  sola fonte UI per liveness, terminalita' e stato attesa utente.
- Slice UI submission route mergeata #374: `useChatTurnSubmission` riceve
  `runtimeViewModel` e `routeComposerSubmission` consuma
  `runtimeViewModel.turnUiState`/`composerMode`; `ChatView` non passa piu'
  `composerMode`, `projectedActiveTurn` e `projectedTurnStatus` come contratti
  separati per decidere se il composer deve steerare il turno o aprirne uno
  nuovo.
- Slice UI turn-status mergeata #373: `useChatTurnStatus` consuma il turno attivo
  da `runtimeViewModel.activeTurn`, non da un prop `projectedActiveTurn`
  parallelo passato da `ChatView`; il timer, attempt e blocked reason del
  composer restano quindi agganciati allo stesso read model del presenter.
- Slice UI work-state mergeata #371: `kernelProjectionPresenter` espone anche
  `activeTurn` come read model del turno attivo; `useChatActivityProjection`
  non ricostruisce piu' localmente `active_turn_id`/status/blocked reason dal
  raw projection, riducendo una seconda fonte di liveness per status pill,
  replay e timer.
- Estrazione mergeata `gateway_agent_turn_config`: `AgentTurnConfigRuntimeScope`
  porta in `run_agent_rounds` la configurazione/budget runtime del turno come
  scope unico (`TurnConfig` risolta una volta dal config owner); il root non
  passa piu' un `TurnConfig` scalare al loop, mentre risoluzione budget,
  HITL guard, loop engine, browser e capability executor restano owner separati.
- Estrazione mergeata `gateway_turn_trace`: `AgentTurnTraceRuntimeScope` porta in
  `run_agent_rounds` la proiezione runtime di osservabilita' del turno
  (`trace_dir` e `turn_trace`) come contratto unico; il root non passa piu' la
  directory dump e il sink trace come parametri concorrenti del loop, mentre
  trace bootstrap, trace dump, loop engine, capability executor e browser
  restano owner separati.
- Estrazione mergeata `gateway_chat_toolset`: `AgentTurnToolRuntimeScope` porta in
  `run_agent_rounds` la proiezione runtime di tool/capability del turno
  (`composio_writes`, `catalog_index`, `capability_corpus` e
  `capability_route`) come contratto unico; il root non passa piu' quattro
  parametri concorrenti al loop, mentre toolset assembly, capability routing,
  dispatch tool e browser executor restano owner separati.
- Estrazione mergeata `gateway_agent_turn_tail`: `AgentTurnActorScope` resta typed
  dal tail-context pre-loop fino a `run_agent_rounds`; il root non passa piu'
  `automation_user_id` e `automation_workspace_id` come parametri concorrenti
  del loop, mentre tail snapshot, usage context, model steering e capability
  executor derivano user/workspace dalla stessa proiezione.
- Estrazione mergeata `gateway_agent_turn_loop_seed`: `AgentTurnLoopSeed` resta
  typed dalla creazione pre-loop fino a `run_agent_rounds`; il root non passa
  piu' `LoopState`, `memory_answer`, `last_model_error` e `browse_sources` come
  parametri concorrenti del loop, mentre il bordo engine continua a ricevere i
  campi scalari solo dentro `run_agent_rounds`.
- Estrazione mergeata `gateway_agent_turn_tail`: `AgentTurnTailInput` riceve
  `&AgentTurnExecutionIdentity` e deriva `canonical_broker_turn` internamente
  per la legacy HITL projection post-loop; `stream_chat_via_openai` non passa
  piu' un booleano broker separato alla coda, mentre outcome publication,
  memory learn, project graph refresh, browser e loop agente restano owner
  separati.
- Estrazione mergeata `gateway_agent_turn_identity`: `AgentTurnExecutionIdentity`
  resta typed dalla risoluzione pre-loop fino a `run_agent_rounds`; il root non
  spacchetta piu' `execution_journal`/`effect_run_id`/`effect_turn_id` come
  parametri concorrenti del loop.
- Estrazione mergeata `gateway_chat_plan_resume`/`gateway_agent_turn_plan_seed`:
  `ChatPlanResume` resta typed dal resume/stall owner fino al seed piano del
  loop; il root non spacchetta piu' `resume_plan`/`resume_goal` come contratti
  scalari concorrenti prima di inizializzare `LoopState.plan`.
- Estrazione mergeata `gateway_agent_turn_plan_seed`: `AgentTurnPlanSeed` resta
  typed dalla semina piano pre-loop fino a `run_agent_rounds`; il root non
  spacchetta piu' `final_done`/`plan_nudges`/`turn_used_tools` come parametri
  concorrenti del loop, mentre `agent_loop::run_turn` continua a ricevere i
  campi scalari solo al bordo engine.
- Estrazione mergeata `gateway_chat_turn_context`/`gateway_tool_execution`:
  `channel_owner` viene incapsulato in `ChatChannelContext` typed dal setup del
  turno fino al capability executor; il root non passa piu' un booleano scalare
  al loop/capability owner, mentre il browser resta esplicitamente fuori da
  questo refactor e consuma solo il bordo `chat_channel.owner`.
- Estrazione locale `gateway_chat_turn_context`: `prepare_chat_turn_context`
  riceve i raw `mode`/`tool_policy` del turno e restituisce anche
  `ChatTurnPolicy` e `ContactMemoryPerimeter` typed; `stream_chat_via_openai`
  non richiama piu' resolver separati di policy/perimetro dopo il setup
  workspace/contact/activity.
- Cleanup mergeato `gateway_memory_briefing`: `MemoryIntentExecutionContext`
  conserva solo `MemoryIntent` typed e `MemoryInjectionPolicy`, rimuovendo la
  copia scalare morta `memory_recall_allowed`; toolset, prompt runtime e
  capability executor derivano la disponibilita' recall dal typed intent nei
  rispettivi owner.
- Estrazione mergeata `gateway_prompt_instructions`: `ChatRuntimePromptInput`
  trasporta `&MemoryIntent` typed e deriva internamente la disponibilita' del
  blocco memoria/recall nel runtime prompt; `stream_chat_via_openai` non passa
  piu' un flag scalare `memory_recall_allowed` al prompt runtime, mentre memory
  briefing, workspace prompt, toolset, capability executor, browser executor e
  loop agente restano owner separati.
- Estrazione mergeata `gateway_chat_toolset`: `ChatToolsetInput` trasporta
  `&MemoryIntent` typed e deriva internamente la disponibilita' del tool
  `recall_memory`; `stream_chat_via_openai` non passa piu' un flag scalare
  `memory_recall_allowed` al toolset, mentre prompt runtime, memory briefing,
  capability executor, browser executor e loop agente restano owner separati.
- Estrazione mergeata `gateway_tool_execution`: `GatewayCapabilityExecutor` e
  `ChatToolCtx` trasportano `MemoryIntent` typed invece di ricevere/conservare
  copie scalari `memory_recall_allowed`/`vault_value_requested`; disponibilita'
  `recall_memory` e reveal Vault derivano la decisione dal memory intent.
- Estrazione mergeata `gateway_tool_execution`: `GatewayCapabilityExecutor` e
  `ChatToolCtx` trasportano anche `&ChatTurnPolicy` typed invece di conservare
  copie scalari `read_only`/`autonomous`; dispatch chat, approval policy e
  wrapper capability derivano i flag solo localmente dalla policy del turno.
- Estrazione mergeata `gateway_tool_execution`: `GatewayCapabilityExecutor` e
  `ChatToolCtx` trasportano `ContactMemoryPerimeter` typed invece di ricreare
  copie scalari `contact_only`/`can_see_contacts`/`can_see_calendar`/
  `can_use_project_memory`; dispatch `recall_memory`, discovery capability e
  guardie connector derivano i flag solo localmente dal perimetro.
- Estrazione mergeata `gateway_memory_sources`/`gateway_chat_workspace_prompt_context`/
  `gateway_tool_execution`:
  la decisione `memory_perimeter_allows_recall` riceve `&ContactMemoryPerimeter`
  invece di tre flag scalari `contact_only`/`can_see_contacts`/
  `can_use_project_memory`; workspace prompt e dispatch `recall_memory` passano
  il perimetro typed al memory-source owner e restano responsabili solo dei
  rispettivi layer prompt/tool.
- Estrazione mergeata `gateway_chat_toolset`: la costruzione dei manager tool
  iniziali riceve `&ChatTurnPolicy` e `&ContactMemoryPerimeter` invece di copie
  scalari `read_only`/`contact_only`; il toolset conserva una sola proiezione
  typed per base schema, pruning e corpus capability, mentre le definizioni
  schema, browser execution e loop agente restano owner separati.
- Estrazione mergeata `gateway_capability_registry`: `CapabilityCorpusMaterializationInput`
  riceve `&ChatTurnPolicy` e deriva internamente il filtro read-only delle
  capability mutating; `gateway_chat_toolset` non passa piu' un `read_only`
  scalare al registry, mentre toolset base, routing/pruning, dispatch tool,
  browser e loop agente restano owner separati.
- Estrazione mergeata `gateway_agent_turn_tool_seed`: `seed_agent_turn_tool_schemas`
  riceve `&ChatTurnPolicy` e deriva internamente il clear dei tool in ask mode;
  `stream_chat_via_openai` non passa piu' il `mode` scalare al seed tool schema,
  mentre toolset assembly, perimetro contatti, tool execution, browser e
  subagent restano owner separati.
- Estrazione mergeata `gateway_turn_trace`: `ChatTurnStartTraceInput` riceve
  `&ChatTurnPolicy` e deriva internamente il `mode` dell'evento `turn_start`;
  `stream_chat_via_openai` non passa piu' un `mode` scalare al trace start,
  mentre bootstrap trace, model tier osservazionale, loop agente e plan progress
  restano owner separati.
- Estrazione mergeata `gateway_prompt_instructions`: `ChatRuntimePromptInput`
  riceve `&ChatTurnPolicy` e deriva internamente il `mode` per le istruzioni
  plan/ask/debug; `stream_chat_via_openai` non passa piu' un `mode` scalare al
  prompt runtime, mentre runtime prompt control puro, prompt packets e loop
  agente restano owner separati.
- Estrazione mergeata `gateway_chat_toolset`: `ChatToolsetInput` riceve anche
  `ContactMemoryPerimeter` typed e deriva internamente `contact_only`;
  `stream_chat_via_openai` non passa piu' un flag scalare al toolset, mentre
  capability executor, browser executor e loop agente restano owner separati.
- Estrazione mergeata `gateway_tool_execution`: `GatewayCapabilityExecutorInput`
  riceve anche `ContactMemoryPerimeter` typed e il factory deriva internamente
  `contact_only`/`can_see_*`; `run_agent_rounds` non passa piu' quattro flag
  scalari concorrenti al capability executor, mentre tool dispatch, browser
  executor e loop agente restano owner separati.
- Estrazione mergeata `gateway_tool_execution`: `GatewayCapabilityExecutorInput`
  riceve `&ChatTurnPolicy`; `run_agent_rounds` non passa piu' due flag scalari
  concorrenti al capability executor e il contesto tool chat mantiene la policy
  typed fino ai punti di decisione, mentre contact perimeter, browser executor e
  loop agente restano owner separati.
- Estrazione mergeata `gateway_agent_turn_tail`: `AgentTurnTailInput` riceve
  `&ChatTurnPolicy` e deriva `read_only` internamente per memory learn e project
  graph refresh post-loop; `stream_chat_via_openai` non passa piu' un booleano
  tail separato, mentre HITL projection, stream outcome, browser e loop agente
  restano owner separati.
- Estrazione mergeata `gateway_chat_toolset`: `ChatToolsetInput` riceve
  `&ChatTurnPolicy` e deriva internamente `read_only`, evitando un secondo
  contratto scalare tra setup turno e tool assembly; prompt/tool pruning,
  capability corpus, dispatch tool, browser executor e loop agente restano
  owner separati.
- Estrazione mergeata `gateway_chat_turn_context`: `ChatTurnPolicy` ora resta la
  proiezione tipizzata dal setup del turno fino a toolset, loop agente e tail;
  `stream_chat_via_openai` non crea piu' contratti concorrenti
  `read_only`/`autonomous`, mentre la policy engine route-aware resta owner
  separato in `gateway_capability_routing`.
- Estrazione mergeata `gateway_skill_runtime`: `SkillPromptCatalog` espone anche
  `has_skills`, derivato dopo il filtro workspace/HomunCoder; il root non
  ricalcola piu' `!enabled_skills.is_empty()` e consuma una proiezione skill
  completa per prompt layers e toolset, mentre route skill, seed default,
  dispatch tool, routing capability e browser restano owner separati.
- Estrazione mergeata `gateway_turn_trace`: la risoluzione osservazionale del
  model tier per `turn_start` (`load_provider_registry().tier_for_model`) passa
  al trace owner; `stream_chat_via_openai` registra setup-complete passando solo
  prompt/mode/model, mentre model routing, loop agente, budget, plan progress,
  tool execution e browser restano owner separati.
- Estrazione mergeata `gateway_chat_turn_context`: il perimetro memoria contatto
  resta una proiezione typed (`ContactMemoryPerimeter`) dal setup del turno fino
  a workspace prompt e loop/capability executor; `stream_chat_via_openai` non
  spacchetta piu' `contact_only`/`can_see_*` in contratti scalari concorrenti,
  mentre prompt memoria, toolset, dispatch tool, browser e loop agente restano
  owner separati.
- Estrazione mergeata `gateway_prompt_instructions`: il bootstrap del core
  operating prompt chat (`prepare_chat_core_operating_prompt`: data/ora runtime,
  home utente, lingua effettiva e discovery browser gia' risolta) esce da
  `stream_chat_via_openai`; il root passa solo il browser discovery snippet e
  conserva l'ordine dei layer prompt, mentre code-map, connected services,
  workspace prompt, runtime prompt, packet composition, loop agente e browser
  restano owner separati.
- Estrazione mergeata `gateway_privacy_preflight`: la risoluzione della localita'
  orchestrator per Privacy Guard (`chat_privacy_orchestrator_is_local`: endpoint
  locale e modello non `:cloud`) esce da `stream_chat_via_openai`; il root passa
  solo `base_url` e `model`, mentre failure policy, prompt privacy, transport
  stream, loop agente, checkpoint e browser restano owner separati.
- Estrazione mergeata `gateway_turn_trace`: il bootstrap iniziale del trace chat
  (`begin_chat_turn_trace`: input turno, opt-out `HOMUN_TURN_TRACE`, log dir e
  byte budget) esce da `stream_chat_via_openai`; `main.rs` passa solo request id,
  prompt, mode e model, mentre trace events, loop agente, budget, plan progress,
  tool execution e browser restano owner separati.
- Estrazione mergeata `gateway_agent_turn_loop_seed`: la costruzione dei messaggi
  iniziali del turno agente (`prepare_agent_turn_initial_messages`: ruolo
  `system` e ruolo `user` con user-content gia' risolto dagli attachment)
  esce da `stream_chat_via_openai`; `main.rs` conserva solo il consumo del
  vettore iniziale, mentre prompt packet, attachment user-content, recall,
  plan/tool/model/recovery seed, browser executor, loop agente e subagent
  restano owner separati.
- Estrazione mergeata `gateway_tool_execution`/`gateway_memory_briefing`: il
  contesto objective execution del turno chat
  (`prepare_chat_objective_execution_context`: active objective contract,
  semantic contract, objective effect policy, catalogo connesso gia' filtrato e
  memory-intent context typed) esce da `stream_chat_via_openai`; `main.rs`
  consuma solo la proiezione e la passa a runtime prompt, workspace prompt,
  toolset e loop agente, mentre prompt wording, memory briefing, toolset
  assembly, loop agente e browser restano owner separati.
- Estrazione mergeata `gateway_artifacts`: il lookup delle destinazioni artifact
  usate dal turno chat (`prepare_chat_artifact_destinations`) passa all'owner
  artifact; `main.rs` consuma solo lo snapshot typed e lo passa a prompt layers
  e toolset `save_artifact`, mentre storage/routes artifact, rendering prompt,
  tool schema, loop agente e browser restano owner separati.
- Estrazione mergeata `gateway_skill_runtime`: il caricamento per-turno del
  catalogo prompt skill (`prepare_skill_prompt_catalog`: manifest HomunCoder,
  skill abilitate e filtro project/personal workspace) esce da
  `stream_chat_via_openai`; `main.rs` consuma solo `enabled_skills`,
  `homuncoder`, `is_project` e il flag owner-derived `has_skills`, mentre route
  skill, seed default, prompt layer, toolset, dispatch tool e browser restano
  owner separati.
- Estrazione mergeata `gateway_process_bootstrap`: il bootstrap di processo
  (`install_gateway_process_bootstrap`: tracing subscriber, panic log, umask
  owner-only e migrazione data dir legacy) esce da `async fn main`; `main.rs`
  conserva store integrity, AppState, memory service, boot/recovery/background,
  router e listener come composition root separati.
- Estrazione mergeata `gateway_chat_workspace_prompt_context`: il contesto
  workspace/thread del prompt chat (`prepare_chat_workspace_prompt_context`:
  contact-only history, perimeter denied recall, briefing, thread episode,
  goal-propose affordance, RAG prompt-specifico e anti-rewrite code context)
  esce da `stream_chat_via_openai`; `main.rs` consuma solo workspace prompt e
  recall payload typed, mentre memory store/service, prompt packet, toolset,
  loop agente, plan resume e browser restano owner separati.
- Estrazione mergeata `gateway_capability_routing`: il piano per-turno del routing
  workflow (`resolve_chat_workflow_routing_plan`: binding thread-scoped,
  capability route, workflow route, deny-tools e forced tool) esce dal root;
  `main.rs` consuma solo l'outcome typed, mentre toolset, pruning, tool
  execution, model client, loop agente e browser restano owner separati.
- Estrazione mergeata `gateway_prompt_instructions`: il wrapper typed del prompt
  runtime-control del turno chat (`prepare_chat_runtime_prompt`) esce dal root;
  `main.rs` passa solo policy recall, istruzione capability-route, mode e
  objective contract, mentre prompt packet, capability routing, store objective,
  toolset, loop agente e browser restano owner separati.
- Estrazione mergeata `gateway_turn_trace`: la registrazione `turn_start`
  setup-complete esce da `stream_chat_via_openai` e passa a
  `record_chat_turn_start_trace(ChatTurnStartTraceInput)`, accanto al bootstrap
  `turn_received`; il trace owner possiede anche il tier osservazionale del
  modello, mentre il root conserva solo l'orchestrazione del turno e loop
  agente, budget, plan progress, tool execution e browser restano owner separati.
- Estrazione mergeata `gateway_privacy_preflight`: la selezione del prompt Privacy
  Guard per nuovo input vs replay/checkpoint (`evaluate_chat_privacy_guard_preflight`)
  esce da `stream_chat_via_openai`; il root passa il prompt originale e consuma
  solo l'outcome typed, mentre transport stream, cleanup registry, loop agente,
  checkpoint recovery e browser restano owner separati.
- Estrazione mergeata `attachments`: ingestion allegati, persistenza/ricostruzione
  del working set per thread e garanzia dei file del turno senza thread o con
  persistenza fallita escono da `stream_chat_via_openai`; `main.rs` delega a
  `prepare_chat_attachment_working_set` e conserva solo il consumo di
  `new_files`/`working` per costruire lo user-content. Vision preflight/fallback,
  prompt packet, loop agente, memory recall, browser e routing restano owner
  separati.
- Estrazione mergeata `gateway_chat_prompt_layers`: la composizione runtime dei
  layer prompt gia' risolti (`append_chat_prompt_layers`: contact
  persona/privacy, installed skills, choice/booking/resume HITL e destinazioni
  artifact autorizzate) esce da `stream_chat_via_openai`; discovery skill,
  wording prompt, artifact storage/routes, HITL state, toolset, loop agente e
  browser restano owner separati.
- Estrazione mergeata `gateway_chat_connected_prompt`: la composizione runtime
  della guidance connected-service/MCP (`append_chat_connected_prompt_instructions`:
  filesystem MCP, connected tools e servizi scaduti) esce da
  `stream_chat_via_openai`; catalog discovery, toolset, wording prompt, loop
  agente e browser restano owner separati.
- Estrazione mergeata `gateway_chat_code_map_prompt`: la composizione runtime
  della guidance code-map (`append_chat_code_map_prompt_instruction`:
  `has_code_map` e append instruction) esce da `stream_chat_via_openai`;
  read-model code-map, wording prompt, toolset, query code graph, browser e loop
  agente restano owner separati.
- Estrazione mergeata `gateway_chat_vision_recovery`: la mutation post-loop del
  seed fallback vision (`recover_chat_vision_fallback_seed`: raccolta immagini,
  descrizione via ruolo vision e sostituzione nel replay seed) esce da
  `run_agent_rounds`; il retry `run_turn`, la preflight vision, la delivery
  image rejection, browser e subagent restano owner separati.
- Estrazione mergeata `gateway_agent_turn_outcomes`: la consegna terminale della
  image rejection (`deliver_image_rejection`: evento `Done` e outcome
  completato) esce dai rami duplicati di `run_agent_rounds`; recovery post-loop,
  loop agente, stream chat/fanout e browser execution restano owner separati.
- Estrazione mergeata core seam factory: la costruzione dei port engine
  `GatewayModelClient` e `GatewayCapabilityExecutor` esce dai costruttori
  diretti in `run_agent_rounds` e passa ai factory dei rispettivi owner; i
  vecchi costruttori `new` non usati sono rimossi.
- Estrazione mergeata non-browser seam factory: la costruzione dei port engine
  `GatewayPlanProgress`, `GatewayContextCompactor`, `GatewayTurnPolicy` e
  `GatewayTurnCompletionJudge` esce dai costruttori diretti in
  `run_agent_rounds` e passa ai factory dei rispettivi owner; i vecchi
  costruttori `new` non usati sono rimossi.
- Estrazione mergeata `gateway_chat_vision_preflight`: lo snapshot del seed di
  replay per fallback vision (`snapshot_chat_vision_fallback_seed`) esce dal
  blocco inline di `run_agent_rounds`; la recovery post-loop, stream transport,
  toolset, loop agente, browser executor e subagent restano owner separati.
- Estrazione mergeata `gateway_agent_turn_tail`: lo snapshot dei valori necessari
  alla coda post-loop (`snapshot_agent_turn_tail`: state, thread id, fence ids,
  user message, assistant precedente e turn id) esce dal setup inline di
  `stream_chat_via_openai`; effetti tail, stream setup, loop agente, browser
  executor e subagent restano owner separati.
- Estrazione mergeata `gateway_agent_turn_trace_dump`: la risoluzione opzionale
  della cartella trace dump (`resolve_agent_turn_trace_dump_dir`) esce dal
  setup inline di `stream_chat_via_openai`; eventi turn trace, stream setup,
  loop agente, browser executor e subagent restano owner separati.
- Estrazione mergeata `gateway_agent_turn_loop_seed`: l'inizializzazione
  pre-loop di `LoopState` (`prompt_packets`, `messages`) e dei buffer terminali
  del turno (`memory_answer`, `last_model_error`, `browse_sources`, reset
  terminale) esce dal setup inline di `stream_chat_via_openai`; recall,
  sensitive confirmations, route trace, plan/tool/model/recovery seed, config,
  browser executor, loop agente e subagent restano owner separati.
- Estrazione mergeata `gateway_agent_turn_hitl_resume`: la proiezione del resume
  HITL gia' selezionato (`resolved_hitl_guard_for_turn`: `HitlResumeTurnContext`
  -> `local_first_engine::hitl::ResolvedHitlGuard`) esce dal setup inline di
  `stream_chat_via_openai`; stash lookup, prompt harness text, browser liveness,
  loop agente e subagent restano owner separati.
- Estrazione mergeata `gateway_agent_turn_config`: la config turn-costante del
  loop agente (`resolve_agent_turn_config`: budget round, context-window,
  forced tool, HITL resume gia' risolto e flag engine) esce dal setup inline di
  `stream_chat_via_openai`; routing, HITL resolution, loop agente, browser
  executor e subagent restano owner separati.
- Estrazione mergeata `gateway_agent_turn_model_seed`: la semina pre-loop del
  provider modello (`seed_agent_turn_model_provider`: warm capability provider e
  `LoopState.provider`) esce dal setup inline di `stream_chat_via_openai`;
  model routing, provider binding construction, model client, loop agente,
  browser e subagent restano owner separati.
- Estrazione mergeata `gateway_agent_turn_recovery_seed`: il consumo pre-loop del
  recovery checkpoint validato (`seed_agent_turn_recovery_checkpoint`:
  checkpoint input dall'ultimo messaggio e apply su `LoopState`) esce dal setup
  inline di `stream_chat_via_openai`; validazione checkpoint, outcome helper,
  loop agente, browser e subagent restano owner separati.
- Estrazione mergeata `gateway_agent_turn_tool_seed`: la semina pre-loop degli
  schema tool (`seed_agent_turn_tool_schemas`: `LoopState.tool_schemas`, mode
  ask e perimetro contatto) esce dal setup inline di
  `stream_chat_via_openai`; assemblaggio toolset, tool perimeter contract,
  execution, browser e subagent restano owner separati.
- Estrazione mergeata `gateway_agent_turn_plan_seed`: la semina pre-loop dello
  stato piano (`seed_agent_turn_plan_state`: `LoopState.plan`,
  `step_messages_start` e contatori iniziali del loop) esce dal setup inline di
  `stream_chat_via_openai`; plan resume, plan stall, runtime-plan shape, browser
  e subagent restano owner separati.
- Estrazione mergeata `gateway_agent_turn_recall_seed`: la semina pre-loop della
  recall automatica (`seed_agent_turn_recall`: seed in `LoopState.memory_reads`
  ed evento stream `Recall`) esce dal setup inline di `stream_chat_via_openai`;
  retrieval/merge recall, recall tool, memory learning, browser e subagent
  restano owner separati.
- Estrazione mergeata `gateway_agent_turn_route_trace`: la pubblicazione pre-loop
  della traccia capability-route (`publish_agent_turn_route_trace`: push in
  `LoopState.tool_trace` e delta ACT) esce dal setup inline di
  `stream_chat_via_openai`; route selection, tool perimeter, loop agente,
  browser e subagent restano owner separati.
- Estrazione mergeata `gateway_agent_turn_sensitive`: la semina pre-loop delle
  conferme sensitive del turno (`seed_agent_turn_sensitive_confirmations`) esce
  dal setup inline di `stream_chat_via_openai`; `main.rs` consuma solo l'owner,
  mentre policy approval, tool execution, loop agente, browser e subagent
  restano owner separati.
- Estrazione mergeata `gateway_agent_turn_identity`: l'identita' esecuzione del
  turno agente (`resolve_agent_turn_execution_identity`: journal, `effect_run_id`,
  `effect_turn_id` broker e flag canonical broker) esce dal setup inline di
  `stream_chat_via_openai`; `main.rs` consuma solo la proiezione identitaria,
  mentre stream setup, loop agente, tail, browser e subagent restano owner
  separati.
- Estrazione mergeata `gateway_agent_turn_tail`: la preparazione degli input della
  coda post-loop (`prepare_agent_turn_tail_context`: user/workspace fence,
  messaggio utente per memory learn e assistant precedente) esce dal setup
  inline di `stream_chat_via_openai`; `main.rs` consuma solo il contesto
  proiettato, mentre stream setup, loop agente, piano, browser e subagent
  restano owner separati.
- Estrazione mergeata `gateway_chat_streams`: la costruzione del client HTTP
  dedicato allo streaming (`chat_streaming_http_client`) esce dal setup inline
  di `stream_chat_via_openai`; `main.rs` consuma solo il client, mentre policy
  transport HTTP/1/no-idle-pool, response NDJSON, registry/replay stream e loop
  agente restano owner separati.
- Estrazione mergeata `gateway_chat_turn_context`: la proiezione del perimetro
  memoria contatto (`resolve_contact_memory_perimeter`) esce dal setup inline di
  `stream_chat_via_openai`; `main.rs` consuma solo la proiezione typed
  `ContactMemoryPerimeter`, mentre prompt memoria, tool perimeter, dispatch
  tool, browser e loop agente restano owner separati.
- Estrazione mergeata `gateway_chat_turn_context`: la risoluzione della policy
  per-turno (`resolve_chat_turn_policy`) esce dal setup inline di
  `stream_chat_via_openai`; `main.rs` consuma la policy typed fino a toolset,
  loop agente e tail, mentre prompt packet, browser e automazioni restano owner
  separati.
- Estrazione mergeata `gateway_prompt_instructions`: il rendering del blocco
  prompt per destinazioni artefatto autorizzate (`artifact_destination_prompt_block`)
  esce dal setup inline di `stream_chat_via_openai`; `main.rs` conserva solo il
  caricamento runtime delle destinazioni, mentre storage/routes artifact,
  schema `save_artifact`, prompt packet e loop agente restano owner separati.
- Estrazione mergeata `gateway_thread_model_context`: la risoluzione della
  context window modello del turno (`model_context_window_for_turn`) esce dal
  setup inline di `stream_chat_via_openai`; registry provider, prompt modello,
  prompt packet e loop agente restano owner separati.
- Estrazione mergeata `gateway_chat_toolset`: la proiezione per-turno del
  catalogo tool connessi (`prepare_connected_tool_catalog`), inclusi indice
  discovery Composio/MCP, write-set di conferma e istruzione filesystem MCP,
  esce dal setup inline di `stream_chat_via_openai`; schema provider,
  capability routing, execution MCP/Composio e loop agente restano owner
  separati.
- Estrazione mergeata `gateway_thread_model_context`: il setup del prompt
  modello del turno (`prepare_chat_model_prompt`), inclusa la scelta fra input
  checkpoint e prompt runtime con context-window budget, esce dal setup inline di
  `stream_chat_via_openai`; prompt packet, allegati, toolset e loop agente
  restano owner separati.
- Estrazione mergeata `attachments`: la costruzione del contenuto utente
  multimodale del turno chat (`prepare_chat_attachment_user_content`) esce dal
  setup inline di `stream_chat_via_openai`; `main.rs` delega la scelta fra
  working set persistito e contesto checkpoint, mentre vision preflight/fallback,
  prompt packet, loop agente e routing restano owner separati.
- Estrazione mergeata `gateway_prompt_instructions`: la composizione finale del
  prompt runtime-control (`runtime_prompt_control_instructions`) esce dal setup
  inline di `stream_chat_via_openai`; `main.rs` passa solo policy recall,
  istruzione capability-route, mode e objective contract gia' caricato, evitando
  una seconda lettura del contratto e lasciando prompt snippets, prompt packet,
  capability routing, store objective e loop agente su owner separati.
- Estrazione mergeata `gateway_skill_runtime`: il filtro catalogo prompt
  HomunCoder per workspace (`skill_prompt_catalog_for_workspace`) esce dal setup
  inline di `stream_chat_via_openai`; `main.rs` conserva solo la decisione
  runtime di appendere il blocco prompt installed-skills, mentre discovery skill,
  filtro metodologia, rendering prompt skill, schema tool e loop agente restano
  owner separati.
- Estrazione mergeata `gateway_memory_prompt_context`: il read-model di presenza
  code-map (`project_has_code_map`) esce dal setup inline di
  `stream_chat_via_openai`; `main.rs` conserva solo la decisione runtime di
  appendere l'istruzione code-map al prompt, mentre query memoria, prompt context,
  code graph runtime e loop agente restano owner separati.
- Estrazione mergeata `gateway_contacts`: il blocco prompt contact-only history
  (`HISTORY WITH THIS CONTACT`) esce dal setup inline di
  `stream_chat_via_openai` e vive accanto agli helper memoria/handle/date dei
  contatti; `main.rs` conserva solo la decisione runtime di recuperare la
  history contact-only, mentre perimetri, profile, relationships, prompt statici
  e loop agente restano owner separati.
- Estrazione mergeata `gateway_prompt_instructions`: il contratto prompt
  `GOAL_PROPOSE` esce dal setup inline di `stream_chat_via_openai`; `main.rs`
  conserva solo la decisione runtime workspace/mode per proporre il goal,
  mentre goal store, cards UI, prompt packet e loop agente restano owner
  separati.
- Estrazione mergeata `gateway_prompt_instructions`: il contratto prompt
  `DESTINATION FOLDERS` per `save_artifact(file, destination)` esce dal setup
  inline di `stream_chat_via_openai`; `main.rs` conserva solo il caricamento
  runtime delle destinazioni disponibili, mentre route artifact, salvataggio
  autorizzato, DTO e workflow artefatti restano owner separati.
- Estrazione mergeata `gateway_prompt_instructions`: il rendering del blocco prompt
  channel-contact/persona/privacy (`REQUESTED TONE`, `PERSONA INSTRUCTIONS`,
  relazioni note e guardrail privacy contatti/calendario) esce dal setup inline
  di `stream_chat_via_openai`; `main.rs` conserva solo la decisione runtime
  `contact_ctx`, mentre contact/channel context, perimetri, profile binding e
  loop agente restano owner separati.
- Estrazione mergeata `gateway_prompt_instructions`: i contratti prompt statici
  per connected-service tools e servizi collegati scaduti escono dal setup
  inline di `stream_chat_via_openai`; `main.rs` conserva solo le decisioni
  runtime `has_composio` e lista `catalog.inactive`, mentre schema tool,
  capability discovery, confirmation card, Composio/MCP runtime e loop agente
  restano owner separati.
- Estrazione mergeata `gateway_prompt_instructions`: i contratti prompt statici
  del core operating prompt dell'orchestratore escono dal setup inline di
  `stream_chat_via_openai`; `main.rs` conserva solo i valori runtime
  `now`/home/lingua/browser-discovery, mentre tool schema, browser runtime,
  capability routing, automazioni, allegati e loop agente restano owner separati.
- Estrazione mergeata `gateway_prompt_instructions`: i contratti prompt statici
  per marker interattivi `CHOICES`/`CLARIFY` escono dal setup inline di
  `stream_chat_via_openai`; `main.rs` conserva solo la composizione, mentre
  HITL resume, UI card rendering, schema tool e loop agente restano owner
  separati.
- Estrazione mergeata `gateway_prompt_instructions`: i contratti prompt statici
  di freshness/verifica corrente (`FRESHNESS / VERIFICATION`) escono dal setup
  inline di `stream_chat_via_openai`; `main.rs` conserva solo la composizione,
  mentre browser runtime, model routing, prompt packet e loop agente restano
  owner separati.
- Estrazione mergeata `gateway_prompt_instructions`: i contratti prompt statici
  dell'objective contract (`OBJECTIVE CONTRACT`) escono dal setup inline di
  `stream_chat_via_openai`; `main.rs` conserva solo la decisione runtime
  `objective_contract_for_execution`, mentre store objective, policy effetti,
  runtime plan e loop agente restano owner separati.
- Estrazione mergeata `gateway_prompt_instructions`: i contratti prompt statici
  di verifica esecuzione (`EXECUTION / VERIFICATION`) escono dal setup inline
  di `stream_chat_via_openai`; `main.rs` conserva solo la composizione, mentre
  tool schema, sandbox execution, build/test runner e loop agente restano owner
  separati.
- Estrazione mergeata `gateway_prompt_instructions`: i contratti prompt statici
  per code-map disponibile (`CODE MAP`) escono dal setup inline di
  `stream_chat_via_openai`; la composizione runtime `has_code_map` + append
  guidance ora vive in `gateway_chat_code_map_prompt`, mentre read-model
  code-map, code graph runtime, tool schema e loop agente restano owner
  separati.
- Estrazione mergeata `gateway_prompt_instructions`: i contratti prompt statici
  per lingua utente (`LANGUAGE`) escono dal setup inline di
  `stream_chat_via_openai`; `main.rs` conserva solo la composizione, mentre
  prompt assembly, mode, memoria, toolset e loop agente restano owner separati.
- Estrazione mergeata `gateway_prompt_instructions`: i contratti prompt statici
  per composer mode `plan`/`ask`/`debug` escono dal match inline di
  `stream_chat_via_openai`; `main.rs` conserva solo la scelta del mode, mentre
  toolset, runtime plan, debug flow e loop agente restano owner separati.
- Estrazione mergeata `gateway_prompt_instructions`: il contratto prompt statico
  memoria/recall/Vault (`MEMORY`, `RECALL-BEFORE-ASKING`,
  `SENSITIVE VAULT`, scope restricted senza `recall_memory`) esce dal setup
  inline di `stream_chat_via_openai`; `main.rs` conserva solo la composizione,
  mentre recall service, prompt packet, toolset e loop agente restano owner
  separati e derivano la disponibilita' memoria dal typed intent.
- Estrazione mergeata `gateway_skill_runtime`: il rendering del blocco prompt
  `INSTALLED SKILLS` / metodologia HomunCoder esce dal setup inline di
  `stream_chat_via_openai` e vive accanto a discovery, progressive disclosure
  e schema tool degli skill; `main.rs` conserva solo snapshot, filtro progetto
  e append del blocco gia' renderizzato.
- Estrazione mergeata `gateway_thread_model_context`: la scelta del contesto
  modello effettivo per il prompt (`thread_context_for_model` quando esiste un
  thread, `request.context` solo per turni senza thread) esce dal setup inline
  di `stream_chat_via_openai`; prompt assembly, loop agente e browser restano
  owner separati.
- `TaskStore::project_kernel_thread` e DTO `KernelThreadProjection`;
- endpoint gateway `GET /api/chat/threads/{thread_id}/kernel-projection`;
- presenter desktop puro `kernelProjectionPresenter`;
- `useChatActivityProjection` migrato alla proiezione kernel;
- client desktop migrato via `fetchKernelThreadProjection` senza export
  `fetchThreadActivity`;
- stato browser tipizzato in `KernelBrowserView`;
- stato plugin/skill/MCP/connector in `KernelCapabilityRuntimeView`;
- marker transcript quarantinati dietro legacy adapter;
- marker transcript non proiettano piu' plan/activity nell'isola runtime; lo
  storico resta compatibile solo nel rendering transcript;
- `ChatView` ridotto a presenter shell via `runtimeViewModel`;
- automazioni/background run allineati alla stessa proiezione;
- smoke deterministico `/kernel-projection` dentro kernel/pre-release gate.
- `browserActivityLifecycle` non possiede piu' la scelta del piano:
  `deriveConversationPlan` e' stato rimosso, il piano passa dal presenter kernel.
- `TaskStore::project_kernel_thread` non esporta step `doing`/`in_progress`
  quando il turno e' terminale: la projection UI mostra lo step corrente come
  `blocked` e rigenera il markdown dallo stesso stato proiettato.
- PR #109 `Preserve grounded browser timeout results`: il browser read-only che
  arriva a risultati osservati prima del timeout non viene degradato a fallback
  generico.
- PR #110 `Preserve grounded browser fallback evidence`: la risposta finale
  conserva evidenza, fonti e stato grounded quando il browser ha visto risultati
  utili ma non chiude semanticamente tutto il task.
- PR #111 `Pin browser projection fallback contract`: fixture
  `browser_grounded_partial_terminal` protegge il caso terminale browser
  grounded/fallback lato projection UI.
- Rimozione fallback legacy HITL: rimosso il fallback `threadTailAwaits*`
  che faceva derivare lifecycle/composer mode dai marker HITL del transcript
  prima del load della projection.
- Estrazione mergeata `gateway_hitl_waits`: persistenza Free-HITL da
  `TurnOutcome.awaiting_user` e payload/open-work snapshot escono dal monolite
  `main.rs`; stream drain, projection, browser runtime e loop agente restano
  owner separati.
- Estrazione `gateway_plan_stall`: il budget cross-turn del piano non vive piu'
  nel monolite `main.rs`; `check_gateway_main_contract.py` ne impedisce il
  rientro.
- Estrazione `chat-runtime/planSteps`: parsing/normalizzazione dei passi UI
  passano da `kernelProjectionPresenter`; `useChatActivityProjection` non
  ricalcola piu' goal/progresso con un secondo owner locale.
- Estrazione `gateway_tool_budget`: budget round normali e live-set
  tool progressiva escono dal monolite `main.rs`; browser budget resta owner
  separato in `gateway_browser_tools`.
- Estrazione `gateway_capability_registry`: schema `find_capability` e
  `suggest_capabilities`, corpus `CapabilityEntry`, source labels, BM25,
  proiezione MCP/connector e search toolkit-aware Composio escono dal monolite
  `main.rs`; il routing semantico workflow resta fuori da questa slice.
- Slice successiva `gateway_capability_registry`: la materializzazione per-turno
  del corpus capability (`deferred_tools`, MCP schemas, skill abilitate e policy
  obiettivo) viene spostata nello stesso owner, lasciando a `main.rs` solo lo
  snapshot degli input del turno.
- Estrazione `gateway_tool_timeouts`: la policy timeout MCP/plugin viene
  separata da `gateway_browser_tools`, cosi' browser, round budget e tool runtime
  non condividono owner impliciti.
- Estrazione `gateway_action_confirmations`: parsing marker conferma,
  exact-card provenance MCP e rewrite terminale MCP escono dal monolite
  `main.rs`, mentre endpoint e dispatch restano sugli owner esistenti.
- Estrazione `gateway_mcp_chat_tools`: naming/parse e catalogo schema
  MCP cached escono dal monolite `main.rs`; l'esecuzione MCP resta separata per
  una slice successiva.
- Estrazione `gateway_mcp_runtime`: transport stdio/http, metadata
  connect<->execute, migrazione header secret, discovery/cache e
  `run_mcp_chat_tool` escono dal monolite `main.rs`; route HTTP e DTO restano
  composition/orchestration.
- Estrazione `gateway_mcp_connections`: route/DTO HTTP MCP per
  `connect`, registry search, connected list e disconnect escono dal monolite
  `main.rs`; l'execute MCP e' stato tenuto in una slice separata perche'
  dipende da conferme, timeout, allow-list e rewrite terminale.
- Estrazione `gateway_mcp_execution`: route/DTO HTTP MCP per `execute` escono
  dal monolite `main.rs`; il modulo orchestra confirmation-card claim, marker
  allow-server e resume/rewrite terminale delegando runtime, timeout e parser
  conferme agli owner gia' estratti.
- Estrazione mergeata `gateway_composio_confirmation`: marker, matching esatto e
  rewrite terminale della confirmation card Composio escono dal monolite
  `main.rs` e si affiancano ai marker MCP in `gateway_action_confirmations`;
  `composio_execute_tool`, payment approval e remote approval restano fuori
  dallo scope.
- Estrazione mergeata `gateway_remote_approval_control`: creazione approvazioni
  remote, scadenza, controllo pending, parsing risposte OK/NO e testo
  progresso escono dal monolite `main.rs` e vivono in
  `gateway_remote_approval`; execute pending, dispatch remoto, payment approval
  e browser restano fuori dallo scope.
- Estrazione mergeata `gateway_remote_approval_continuation`: status thread,
  target formatter, source-user lookup e prompt/input continuation
  post-approval escono dal monolite `main.rs` e vivono in
  `gateway_remote_approval`; actionable source resolution, execute pending,
  dispatch remoto, payment approval e browser restano fuori dallo scope.
- Estrazione mergeata `gateway_remote_approval_dispatch`: richiesta effect receipt e
  dispatch canale Telegram/WhatsApp delle approval remote escono dal monolite
  `main.rs` e vivono in `gateway_remote_approval`; actionable source
  resolution, execute pending, payment approval e browser restano fuori dallo
  scope.
- Estrazione mergeata `gateway_remote_approval_cancel`: cancellazione pending remote
  approval da reply canale esce dal monolite `main.rs` e vive in
  `gateway_remote_approval`; actionable source resolution, execute pending,
  payment approval e browser restano fuori dallo scope.
- Estrazione mergeata `gateway_remote_approval_execution`: consumo del codice
  approvato, claim source-card, dispatch esecuzione MCP/Composio/send_message,
  rilevamento fallimento connector, risoluzione terminale e resume del thread
  post-execute escono dal monolite `main.rs`; creazione/dispatch/cancel remote
  approval, payment approval e browser restano owner separati.
- Estrazione mergeata `gateway_actionable_source`: `ActionableSourceResolution`,
  claim/rewrite terminale, `claim_actionable_source`,
  `resolve_actionable_source`, terminal formatter e rilascio source-card su
  errore terminale executor escono dal monolite `main.rs` e vivono in
  `gateway_actionable_source`; execute pending, payment approval, remote
  approval dispatch/cancel e browser restano fuori dallo scope.
- Estrazione mergeata `gateway_channels`: helper invio bottoni channel,
  schema pseudo-tool `send_message` ed executor sidecar WhatsApp/Telegram
  escono dal monolite `main.rs`; `composio_execute_tool`, pending approval,
  payment approval e browser restano owner separati.
- Estrazione locale `gateway_write_tool_allowlist`: persistenza e matching
  "always allow" per write-tool Composio/MCP escono dal monolite `main.rs`;
  il file storico `composio-tool-allow.json` resta invariato per compatibilita',
  mentre list/revoke e marker MCP server-level vivono nello stesso owner.
- Estrazione locale `gateway_vault_routes`: route `/api/vault/*`, DTO PIN,
  record/payment approval, storage/reveal/update/dedup/search Vault e rewrite
  della payment card approvata escono dal monolite `main.rs`; browser action
  enforcement e claim finale pagamento restano owner separato.
- Estrazione mergeata `gateway_vault_routes`: fallback Vault per memory recall,
  policy termini sensibili e costruzione reveal-card metadata-only escono dal
  monolite `main.rs`; `recall_memory` e il servizio memoria restano fuori dallo
  scope.
- Estrazione mergeata `gateway_payment_approval`: grant payment approval,
  sostituzione CVV one-shot, reject-before-claim, claim/validazione finale e
  lock stato payment escono dal monolite `main.rs`; route Vault, marker payment
  card, browser enforcement e remote approval restano owner separati.
- Estrazione mergeata `attachments`: contesto prompt bounded degli allegati
  persistiti e user-content multimodale del turno chat
  (`append_thread_attachment_context`, `prepare_chat_attachment_user_content`,
  budget testo/immagini e separazione extraction issues) escono dal monolite
  `main.rs`; ingestion file resta nello stesso owner, mentre loop chat, memory
  recall, prompt packet, vision preflight/fallback e routing agente restano fuori
  dallo scope.
- Estrazione mergeata `gateway_recall_context`: formatter delle entry recall
  (`format_recall_entry`) esce dal monolite `main.rs` e resta accanto agli
  helper di recall prompt/status/effect; `recall_memory`, artifact/workflow
  read-model e loop agente restano fuori dallo scope.
- Estrazione mergeata `gateway_memory_prompt_context`: read-model bounded per
  provenance artifact, qualita' artifact e stato workflow da memoria canonica
  escono dal monolite `main.rs`; `recall_memory`, learning inline, prompt
  packet, artifact persistence e loop agente restano owner separati.
- Estrazione mergeata `gateway_memory_prompt_context`: contesto push per
  decisioni di file (`decisions_for_path`) e anti-rewrite code-map
  (`relevant_code_components_for_prompt`) escono dal monolite `main.rs` e
  restano nello stesso owner bounded; `recall_memory`, tool execution, prompt
  packet e loop agente restano owner separati.
- Estrazione mergeata `gateway_text_safety`: helper condivisi di redazione testo
  sensibile, strip terminal controls, task goal summary e truncation escono dal
  monolite `main.rs`; task execution, JSON checkpoint shaping, agent stream,
  browser e memory recall restano owner separati.
- Estrazione locale `gateway_local_authorization_routes`: route/DTO e marker
  locali per filesystem authorization, sandbox escalation, read-only card e
  connect-suggestion mark escono dal monolite `main.rs`.
- Estrazione mergeata `gateway_composio_routes`: route/DTO Composio per connect,
  toolkits/auth/link/connections/disconnect/logo, catalogo chat-tool,
  classificazione read/write e suggest capability escono dal monolite
  `main.rs`; `composio_execute_tool`, payment approval claim e remote approval
  dispatch restano owner separati.
- Estrazione mergeata `gateway_composio_execution`: dispatcher
  `composio_execute_tool`, DTO/route `/api/composio/execute`, claim source-card,
  allow-once/always, rilevamento `successful:false`, rewrite terminale e resume
  post-execute escono dal monolite `main.rs`; payment approval, pending remote
  approval, browser e connection/catalog Composio restano owner separati.
- Estrazione mergeata `gateway_connector_errors`: classificazione errori connector,
  hint azionabili Composio/MCP, audit log esecuzioni connector e rilevamento
  `successful:false` Composio escono dal monolite `main.rs`; dispatch execute,
  confirmation card, payment approval, remote approval e browser restano owner
  separati.
- Estrazione mergeata `gateway_image_generation`: config provider OpenAI-compatible
  per image generation, env/default locali, timeout immagine, prompt immagini
  deck e fetch/decode PNG escono dal monolite `main.rs`; orchestrazione
  deliverable, artifact persistence, embedding, model routing testuale e browser
  restano owner separati.
- Estrazione mergeata `gateway_task_executor_config`: worker manuale e poll interval
  del task executor escono dal monolite `main.rs` e si aggiungono ai worker id
  stabili e alla configurazione env gia' posseduti dall'owner; route queue,
  lease/acquire, execution adapter e finalizzazione task restano owner separati.
- Estrazione mergeata `gateway_task_executor`: label `ResourceClass` per la queue
  executor esce dal monolite `main.rs` e resta accanto alla proiezione risorse
  del task executor; browser, execution adapter e loop agente restano owner
  separati.
- Estrazione mergeata `gateway_runtime_flags`: il flag diagnostico `HOMUN_DEBUG`
  (`verbose_debug`) esce dal monolite `main.rs` e vive accanto agli altri flag
  runtime env-backed; loop agente, tool execution e route Composio restano solo
  consumatori del flag.
- Estrazione mergeata `gateway_automation_formatting`: helper puri per sender root
  e titolo dei thread schedulati (`scheduled_thread_sender_for_task_id`,
  `scheduled_thread_title`) escono dal monolite `main.rs`; route automation,
  executor proattivo e scope durable restano owner separati.
- Estrazione mergeata `gateway_proactive_threads`: piano thread proattivo
  (`ProactiveThreadPlan`), derivazione `thread_id`/workspace/source/channel/title
  e scope schedulato stabile escono dal monolite `main.rs`; persistenza visible
  turn, executor proattivo, automazioni e browser restano owner separati.
- Estrazione mergeata `gateway_proactive_execution`: bootstrap del turno visibile
  task-scoped per `proactive_prompt`, policy autonomia/read-only/full,
  interruzione runtime, mapping `TurnStop` -> wake e finalizzazione
  complete/suspend/fail escono dal monolite `main.rs`; planning thread, visible
  turn generico, fanout broker, capability/browser/subagent executor restano
  owner separati.
- Estrazione mergeata `gateway_visible_turns`: `VisibleConversationTurn`,
  `thread_turn_started_event`, retry SQLite transiente e
  `start_visible_conversation_turn` escono dal monolite `main.rs`; broker,
  stream draining, finalizzazione messaggio ed executor proattivo restano owner
  separati.
- Estrazione mergeata `gateway_state_access`: `GatewayError`, lock helper degli
  store gateway, accessor `memory_facade`, `lock_capability_registry`,
  `vacuum_all_stores` e mapping `IntoResponse` escono dal monolite `main.rs`;
  loop agente, executor proattivo, subagent e browser restano owner separati.
- Estrazione mergeata `gateway_thread_model_context`: filtro server-side dei
  messaggi storici, esclusione placeholder/current prompt e bound degli ultimi
  16 `ChatContextMessage` escono dal monolite `main.rs`; visible turn,
  finalizzazione stream, recall tool e loop agente restano owner separati.
- Estrazione mergeata `gateway_agent_wake`: mapping `TurnStop` ->
  `WakeCondition` per i turni agente esce dal monolite `main.rs`, preservando
  il riferimento approval action-specific; drain stream, HITL wait e browser
  restano owner separati.
- Estrazione mergeata `gateway_agent_stream_events`: parser delta/done,
  redazione user text da evento `done` e mapping raw stream -> `TurnEventKind`
  escono dal monolite `main.rs`; drain, fanout, persistenza HITL/recall e
  browser restano owner separati.
- Estrazione mergeata `gateway_agent_stream_persistence`: update/finalizzazione
  assistant message, persistenza recall/redacted user text da stream e fanout
  raw stream -> `turn_events` escono dal monolite `main.rs`; drain stream,
  HITL wait e browser restano owner separati.
- Estrazione mergeata `gateway_agent_stream_drain`: drain async dello stream
  agente verso assistant message e fanout durable/live broker escono dal
  monolite `main.rs`; parser, persistence helpers, HITL wait e browser restano
  owner separati.
- Estrazione locale `gateway_agent_turn_runner`: wrapper
  `run_agent_turn_into_message*` per avviare uno stream agente e drenarlo nel
  messaggio assistente visibile escono dal monolite `main.rs`; il loop
  `stream_chat_via_openai`/`run_agent_rounds`, stream registry/drain, broker,
  proactive execution e browser restano owner separati.
- Estrazione locale `gateway_agent_checkpoints`: parsing/validazione
  `LoopCheckpoint`, mapping errore `agent_checkpoint_invalid` e calcolo
  `applies_new_input` escono dal monolite `main.rs`; apply checkpoint, stream
  chat, loop agente e browser restano owner separati.
- Estrazione locale `gateway_privacy_preflight`: decisione pre-loop Privacy
  Guard, fallback local-only/block remote, errore `privacy_guard_unavailable` e
  risposta anticipata Vault proposal escono dal monolite `main.rs`; transport
  stream, checkpoint, loop agente e browser restano owner separati.
- Estrazione locale `gateway_chat_turn_context`: setup stateful pre-prompt del
  turno chat (workspace memoria del thread, contesto contact/channel e
  real-idle activity) esce dal monolite `main.rs`; prompt, stream, loop agente,
  browser e subagent restano owner separati.
- Estrazione locale `gateway_chat_toolset`: assemblaggio per-turno del toolset
  manager, split live/deferred, pruning objective/workflow, MCP small
  always-load, Composio pre-retrieve e corpus `find_capability` escono dal
  monolite `main.rs`; schema tool, routing semantico, dispatch, browser e loop
  agente restano owner separati.
- Estrazione mergeata `gateway_chat_plan_resume`: seed pre-loop del piano chat da
  `runtime_plans` canonico o marker legacy e applicazione del guard cross-turn
  `gateway_plan_stall` escono dal monolite `main.rs`; shape runtime plan,
  budget stall, loop agente, browser e toolset restano owner separati.
- Estrazione mergeata `gateway_chat_vision_preflight`: decisione pre-loop per
  allegati immagine (inline, fallback, delega al ruolo vision o risposta
  anticipata) esce dal monolite `main.rs`; recovery post-loop image rejection,
  trasporto stream, browser, toolset e loop agente restano owner separati.
- Estrazione mergeata `gateway_chat_tool_perimeter`: filtro contact/channel
  allow/deny sul toolset gia' assemblato esce dal monolite `main.rs`;
  assemblaggio toolset, harness control tools, browser, loop agente e subagent
  restano owner separati.
- Estrazione locale `gateway_chat_streams`: costruzione request id stream per
  turni agente/channel e broker (`agentturn-*`, `broker-*`) esce dal monolite
  `main.rs` e vive accanto a registry/replay/abort stream; loop agente, drain
  e browser restano owner separati.
- Estrazione locale `gateway_chat_streams`: setup transport stream chat
  (`mpsc`, broadcast, registry entry) e response HTTP NDJSON escono dal
  monolite `main.rs`; early response preflight, loop agente, drain persistenza,
  browser e subagent restano owner separati.
- Estrazione mergeata `gateway_turn_broker`: fence terminale
  `finalize_turn_steering` per chiudere steering pending/held su turni conclusi
  esce dal monolite `main.rs`; store `turn_steering`, pubblicazione eventi e
  route steering restano nello stesso owner broker, mentre loop agente,
  stream drain e browser restano owner separati.
- Estrazione locale `gateway_capability_execution`: dispatch autonomo
  non-browser `capability.*`, re-check policy Managed/Composio, presentation
  capability e mapping condiviso `ExecutorResult` -> `ExecutionOutcome` escono
  dal monolite `main.rs`; browser capability, queue runner e loop agente restano
  owner separati.
- Estrazione mergeata `gateway_subagent_execution`: dispatch `subagent.*`,
  selezione router orchestrator e mapping `ExecutorResult` -> `ExecutionOutcome`
  escono dal monolite `main.rs`; browser capability, executor proattivo,
  queue runner e loop agente restano owner separati.
- Estrazione mergeata `gateway_agent_turn_outcomes`: restore checkpoint agente e
  outcome terminale per image rejection gia' consegnata escono dal monolite
  `main.rs`; loop agente, stream chat/fanout e browser execution restano owner
  separati.
- Estrazione mergeata `gateway_time`: helper condiviso `now_epoch_secs` esce dal
  monolite `main.rs` e resta re-exportato dal root per compatibilita' dei moduli
  esistenti; execution loop, browser e route non entrano nell'owner time.
- Estrazione mergeata `gateway_shell_tasks`: executor shell read-only,
  wrapper comando consentito e shaping/redazione JSON output task escono dal
  monolite `main.rs`; execution runtime, task executor, browser e sandbox
  restano owner separati.
- Estrazione mergeata `gateway_model_routing`: DTO `RoutingDecision`, lettura
  `routing-decisions.json` e writer ring-buffer capped escono dal monolite
  `main.rs`; la surface HTTP `/api/routing-decisions` resta in
  `gateway_model_routes`, mentre il tempo condiviso passa da `gateway_time`.
- Estrazione mergeata `gateway_model_routing`: resolver API key inference,
  fallback env, factory `ModelRouter` da provider/ruolo e router legacy da env
  escono dal monolite `main.rs`; il wrapper browser resta fuori da questa
  slice.
- Estrazione mergeata `gateway_model_routing`: classificazione local/cloud
  inference, provider id per usage recording e transport OpenAI-compatible
  registrato (`recorded_openai_value`) escono dal monolite `main.rs`; routing
  browser, turn policy, plan progress e loop agente restano fuori dallo scope.
- Estrazione mergeata `gateway_memory_query_embeddings` /
  `gateway_memory_clients`: config embedding memoria, transport HTTP Ollama,
  cache/timing query embedding e backfill embedding escono dal monolite
  `main.rs`; `recall_memory`, learning inline e consolidamento restano fuori
  dallo scope.
- Estrazione mergeata `gateway_memory_json`: transport JSON OpenAI-compatible per
  task memoria/proattivita', parsing fence JSON e usage context
  `MemoryExtraction` escono dal monolite `main.rs`; `recall_memory`, learning
  inline e consolidamento restano owner separati.
- Estrazione mergeata `gateway_memory_recall_tool`: tool-result `recall_memory`,
  `RecallOutcome` e payload recall UI costruito dagli stessi hit autorizzati
  escono dal monolite `main.rs`; learning inline, consolidamento, automation
  tombstone e subagent plan-step memory restano owner separati.
- Estrazione mergeata `local_first_memory::recall`: `MemoryCandidate`,
  `hybrid_memory_score` e `memory_age_days` non hanno piu' copie test-only in
  `main.rs`; i test gateway importano lo scoring dal crate memoria, che resta
  l'owner canonico del ranking recall.
- Estrazione mergeata `local_first_memory::learn`: `memory_auto_confirmable` diventa
  l'owner canonico della policy di auto-confirm memoria; il gateway non mantiene
  piu' una copia test-only e le memorie legacy sensibili senza admission metadata
  restano `Candidate` invece di essere promosse solo per confidenza alta.
- Estrazione mergeata `gateway_task_inputs`: `task_effective_goal` esce dal monolite
  `main.rs`; la policy "prompt_redacted prevale su goal" resta riutilizzabile
  da task executor/browser approval senza assorbire browser runtime o loop agente.
- Estrazione mergeata `chatTurnStatus`: il pill del turno attivo del composer deriva
  da `runtimeViewModel.turnUiState`, stream title/detail e blocked reason in un
  owner puro testato; `ChatView` non mantiene piu' una seconda derivazione di
  "Waiting for you"/"Still working".
- Slice locale `useChatTurnStatus`: timer elapsed, traduzioni e chiamata a
  `chatTurnStatus` escono da `ChatView` e vivono in un hook UI dedicato; il
  guardrail `cursor-grammar-ui` impedisce a `ChatView` di reimportare
  `deriveChatTurnStatus` o `useChatActiveTurnElapsed`.
- Estrazione mergeata `gateway_memory_reuse`: `StreamMemoryReuseCollector` e
  `memory_reuse_envelope_from_read_set` escono dal monolite `main.rs`; l'owner
  attesta recall/actionable/approval stream parts e produce il
  `MemoryReuseEnvelope`, mentre finalizzazione messaggio, persistence HITL e
  parser action card restano owner separati.
- Estrazione mergeata `gateway_memory_learning`: apprendimento post-turno via
  service/inline e consolidamento scope in tre fasi Send-safe escono dal
  monolite `main.rs`; recall tool, automation tombstone e subagent plan-step
  memory restano owner separati.
- Estrazione mergeata `gateway_automation_routes` memory tombstone: cancellazione
  record memoria collegati all'automazione passa nell'owner CRUD automazioni;
  learning/consolidate e subagent plan-step memory restano owner separati.
- Estrazione mergeata `gateway_boot_maintenance`: risoluzione sorgente default skills,
  copy ricorsivo, hash skill-tree e seed default skills escono dal monolite
  `main.rs`; route skill e runtime skill restano owner separati.
- Estrazione locale `gateway_thread_files`: cartella collegata per thread,
  precedenza workspace attivo e route `@ file` search/read escono dal monolite
  `main.rs`; `path_within` viene portato nell'owner condiviso
  `gateway_file_security`, perche' e' usato anche da artifact e memoria.
- Estrazione locale `gateway_transcription`: route dictation
  `/api/chat/transcribe`, validazione audio base64 e bridge Whisper
  contained-computer escono dal monolite `main.rs`.
- Estrazione locale `gateway_usage_routes`: route usage ledger, snapshot
  account provider, policy budget manuale e model-usage suggestions escono dal
  monolite `main.rs`; il tempo condiviso passa da `gateway_time`.
- Estrazione locale `gateway_usage_runtime`: bootstrap ledger usage, cleanup
  attempt orfani, rebuild rollup, recorder buffered e pricing snapshot escono
  dal monolite `main.rs`; le route usage e il model registry restano owner
  separati.
- Estrazione locale `gateway_usage_runtime`: costruzione del
  `UsageContext::ChatResponse` scoped per user/workspace/thread/turn/run esce
  dal loop agente in `main.rs`; model client, loop agente, browser e routing
  restano owner separati.
- Estrazione locale `model_client`: costruzione del `GatewaySteeringContext`
  per thread/turn/run esce da `run_agent_rounds`; il loop agente passa solo gli
  identificativi del turno, mentre steering persistence e model transport
  restano dentro il model client.
- Estrazione locale `model_client`: costruzione del port engine
  `GatewayModelClient` passa da struct literal in `run_agent_rounds` a
  `gateway_model_client`; HTTP, stream sink, usage recorder e steering
  binding restano owner del model client.
- Estrazione locale `model_client`: costruzione del `ProviderBinding` iniziale
  del turno passa da struct literal in `stream_chat_via_openai` a
  `gateway_provider_binding`; fallback provider mid-round e transport restano
  nello stesso owner modello.
- Estrazione locale `gateway_model_routing`: warm-up delle capability modello
  del turno passa dal branch inline `is_ollama_base` in `stream_chat_via_openai`
  a `warm_turn_provider_capabilities`; parsing/caching Ollama e policy provider
  restano nello stesso owner routing modello.
- Estrazione locale `gateway_tool_execution`: lookup del
  `ValidatedExecutionContract` del turno esce da `run_agent_rounds`; capability
  executor e browser executor ricevono lo stesso contratto caricato dall'owner
  dei tool, mentre il loop resta composition del turno.
- Estrazione locale `gateway_tool_execution`: costruzione del port
  `GatewayCapabilityExecutor` passa da struct literal in `run_agent_rounds` a
  `gateway_capability_executor(GatewayCapabilityExecutorInput)`; browser
  executor, plan progress, context compactor e model client restano owner
  separati.
- Estrazione locale `gateway_turn_trace`: bootstrap del trace leggibile
  `turn_received`, registrazione `turn_start`, opt-out e fallback no-log-dir
  escono dal monolite `main.rs`; il trace resta pura osservabilita' e non
  possiede loop agente, budget o avanzamento piano.
- Estrazione locale `gateway_update_routes`: route update/redeploy webhook e
  DTO di stato escono dal monolite `main.rs`; startup, packaging e CI installer
  restano fuori owner.
- Estrazione locale `gateway_project_access`: grant accesso progetto,
  persistenza `project-access`, route access/upsert/remove e resolver policy
  condiviso da channels/automazioni escono dal monolite `main.rs`.
- Estrazione locale `gateway_skill_routes`: route skills locali, enable/disable,
  catalogo ClawHub, preview/install e registry GitHub escono dal monolite
  `main.rs`; scanner/catalog/security engine e seed default restano separati.
- Estrazione mergeata `gateway_skill_runtime`: directory skill condivisa,
  normalizzazione id, creazione skill, discovery prompt, caricamento
  progressive-disclosure/adattamento SKILL.md e schemi `use_skill` /
  `run_in_sandbox` escono dal monolite `main.rs`; route skill, seed default a
  boot, dispatch tool e routing capability restano owner separati.
- Estrazione mergeata `gateway_runtime_plan_state`: shape canonica del runtime plan,
  bridge `ExecutionPlan`, merge/reconcile delivery, lettura/scrittura
  `runtime_plans`, proiezione memoria/graph degli step, memoria subagent
  plan-step e port engine `GatewayPlanProgress` escono dal monolite `main.rs`;
  tool schema, stall budget, prompt packet e dispatch tool restano owner
  separati.
- Estrazione locale `gateway_runtime_plan_state`: costruzione del port engine
  `GatewayPlanProgress` passa dal costruttore diretto in `run_agent_rounds` al
  factory `gateway_plan_progress`, mantenendo il loop agente come sola
  composition del turno.
- Estrazione locale `audit_runtime_plan_state`: `scripts/audit_turn_consistency.py`
  legge `runtime_plans` e segnala piani open/runnable che sopravvivono a task
  terminali; non ripara righe e non diventa owner runtime, ma rende visibile la
  contraddizione fra piano durable, reducer e UI projection.
- Estrazione mergeata `gateway_thread_episodes`: workspace riservato `__threads__`,
  persistenza episodi conversazionali, projection del blocco prompt per thread
  corrente e matching esatto thread/workspace escono dal monolite `main.rs`;
  recall generale, memory service, graph/wiki e prompt packet restano owner
  separati.
- Estrazione mergeata `gateway_prompt_packets`: lettura bounded delle istruzioni
  progetto (`AGENTS.md`, `.homun/instructions.md`) e composizione dei packet
  core/workspace/project/thread/runtime escono dal monolite `main.rs`; prompt
  instructions, policy memoria, runtime plan, routing decision e loop agente
  restano owner separati.
- Estrazione `gateway_prompt_instructions`: il contratto prompt operativo del
  piano (`OPERATIONAL PLAN`, `update_plan`, `step_advance`, goal e ripresa
  piani in corso) esce dal monolite `main.rs`; `gateway_plan_tools` resta owner
  degli schema tool, `gateway_runtime_plan_state` resta owner dello stato
  runtime e `gateway_plan_stall` resta owner del budget cross-turn.
- Estrazione mergeata `gateway_brain_runtime`: flag di abilitazione Brain, adapter
  `GatewayBrainMemory` e budget orchestrator scalati sul context window escono
  dal monolite `main.rs`; materializzazione durable dei task, capability facade,
  routing workflow e loop agente restano owner separati.
- Estrazione mergeata `gateway_brain_materialization`: materializzazione durable
  dei task via Orchestrator Brain, policy context read/draft, provider cached,
  linking task->thread e progress totale della sessione aggregata escono dal
  monolite `main.rs`; config Brain, chat task route, worker executor, browser e
  loop agente restano owner separati.
- Estrazione mergeata `gateway_context_compactor`: adapter port `GatewayContextCompactor`
  esce dal monolite `main.rs` e vive nell'owner `gateway_model_routing`, accanto
  alle policy di compaction visibili al modello; `GatewayTurnPolicy`,
  `GatewayTurnCompletionJudge` e il loop agente restano owner separati.
- Estrazione locale `gateway_context_compactor`: costruzione del port engine
  `GatewayContextCompactor` passa dal costruttore diretto in `run_agent_rounds`
  al factory `gateway_context_compactor`, mantenendo state/thread binding
  nell'owner model routing.
- Estrazione mergeata `gateway_turn_policy`: adapter port `GatewayTurnPolicy`
  esce dal monolite `main.rs` e vive nell'owner `gateway_capability_routing`,
  accanto alla decisione `CapabilityRouteDecision` e al blocco workflow
  one-shot; `GatewayTurnCompletionJudge`, `GatewayContextCompactor` e il loop
  agente restano owner separati.
- Estrazione mergeata `gateway_turn_completion_judge`: adapter port
  `GatewayTurnCompletionJudge` esce dal monolite `main.rs` e vive nell'owner
  `gateway_model_routing`, accanto a `task_appears_incomplete` e alle decisioni
  visibili al modello per i turni senza piano; `GatewayTurnPolicy`,
  `GatewayPlanProgress` e il loop agente restano owner separati.
- Estrazione mergeata `gateway_composio_transport`: il trasporto HTTP concreto
  `GatewayComposioTransport` esce dal monolite `main.rs` e vive nell'owner
  `gateway_composio_routes`, accanto a connect/catalog/auth/link/connections;
  `composio_execute_tool`, payment approval claim, remote approval dispatch e
  browser restano owner separati.
- Estrazione mergeata `gateway_agent_output_completion`: la policy
  `agent_output_incomplete_reason` per classificare risposte agente vuote o
  plan-marker incompleti esce dal monolite `main.rs` e vive in
  `gateway_model_routing`, accanto al completion judge no-plan; `GatewayTurnPolicy`,
  `GatewayPlanProgress` e il loop agente restano owner separati.
- Estrazione mergeata `gateway_role_resolution`: la risoluzione semantica
  `resolve_role_for_task` esce dal monolite `main.rs` e vive in
  `gateway_model_routing`, accanto a `router_for_role` e al log delle decisioni
  routing; wrapper browser, `GatewayTurnPolicy`, `GatewayPlanProgress` e loop
  agente restano owner separati.
- Estrazione locale `gateway_memory_publications`: route memory publication
  create/get/edit/approve/reject, DTO request, mapping errori facade e
  validazione owned-scope escono dal monolite `main.rs`; source grant
  management, registry workspace e semantica `MemoryFacade` restano separati.
- Estrazione locale `gateway_memory_sources`: route linked-memory source grant
  list/upsert/revoke/candidates, DTO request/query, validazione policy e
  proiezioni grant/candidate escono dal monolite `main.rs`; persistenza
  workspace generale e storage semantics del `MemoryFacade` restano separati.
- Estrazione locale `gateway_system_status`: route `/api/system/status`, DTO
  diagnostici Docker/gateway e parser memoria container escono dal monolite
  `main.rs`; le route di controllo browser restano fuori da questa slice.
- Estrazione locale `gateway_workspaces`: registry `workspaces.json`,
  CRUD/policy workspace, selezione workspace attivo a boot e purge retry-safe
  su delete escono dal monolite `main.rs`.
- Estrazione locale `gateway_memory_bench`: adapter HTTP opt-in MemoryBench,
  DTO benchmark, materializzazione workspace benchmark, ingest governato,
  status e search escono dal monolite `main.rs`; dashboard/export memory e
  registry workspace generale restano separati.
- Estrazione locale `gateway_memory_ui_routes`: route read-only dashboard/export/items
  memory, access request dashboard e full user-data export escono dal monolite
  `main.rs`; MemoryBench, memory graph build/mutation e storage semantics del
  `MemoryFacade` restano separati.
- Estrazione locale `gateway_memory_graph_routes`: route `/api/memory/graph`,
  merge entity graph e adapter import Graphify escono dal monolite `main.rs`;
  maintenance/reconcile, persistence graph e relation helper restano owner
  separati.
- Estrazione locale `gateway_memory_wiki`: route `/api/memory/wiki` read/save e
  `/api/memory/consolidate` escono dal monolite `main.rs`; lo stesso owner
  mantiene registry edit manuali e rebuild delle pagine wiki derivate.
- Estrazione locale `gateway_memory_hygiene`: route `/api/memory/hygiene/suggestions`
  esce dal monolite `main.rs` e resta accanto alla normalizzazione entity-name e
  al calcolo suggerimenti merge person.
- Estrazione locale `gateway_memory_goals`: route `/api/memory/goals`,
  `/api/memory/project-briefing` e mutazioni goals add/promote/suggest escono dal
  monolite `main.rs`; wiki rebuild e turn-context restano negli owner dedicati.
- Estrazione locale `gateway_memory_tools`: la route `/api/memory/decide`
  conferma/rifiuta/cancella/edita candidati accanto ai tool schema
  recall/decision/forget; dashboard/export, graph projection e wiki restano owner
  separati.
- Estrazione locale `gateway_contacts`: route core rubrica
  `/api/memory/contacts*`, DTO `ContactView`, CRUD, merge, identity add/remove
  e helper memoria/handle/date condivisi escono dal monolite `main.rs`;
  perimetri, relationship, fact profile e named profile CRUD restano owner
  separati.
- Estrazione locale `gateway_contact_profile`: route
  `/api/memory/contacts/profile` e `/api/memory/contacts/profile/refresh`,
  distillazione facts contatto e lettura fact via graph escono dal monolite
  `main.rs`; CRUD contatti, relationship e profili globali restano separati.
- Estrazione locale `gateway_contact_profiles`: route `/api/profiles*`,
  DTO named persona e binding profilo su contatto/canale escono dal monolite
  `main.rs`; CRUD contatti, perimetri, relationship e fact profile restano
  owner separati.
- `/api/health` non esegue piu' probe Docker nel percorso watchdog: lo stato
  contained-computer letto dall'health handler arriva dal coordinator in memoria,
  mentre le verifiche Docker restano negli owner setup/browser dedicati.
- Estrazione locale `gateway_browser_runtime`: DTO/route live Local Computer,
  readiness CDP/noVNC, start/stop contained computer e publisher WS
  `computer.live` escono dal monolite `main.rs` e restano accanto a sessioni,
  preview artifact, sidecar browser e activity runtime.
- Estrazione locale `gateway_system_status`: route `/api/system/status`, DTO
  diagnostici Docker/gateway, memoria processo/container e parser `docker stats`
  escono dal monolite `main.rs`; route di controllo browser e lifecycle runtime
  restano negli owner dedicati.
- Estrazione locale `gateway_chat_utility_routes`: route improve prompt,
  suggestions, autotitle, seed assistant e proactive answer escono dal monolite
  `main.rs`; loop agente, streaming, proactivity review e memory recall inline
  restano negli owner dedicati.
- Estrazione locale `gateway_proactivity_routes`: route dashboard
  `/api/tools/runs`, `/api/suggestions`, `/api/suggestions/{id}/act` e trigger
  manuale `/api/proactivity/review-now` escono dal monolite `main.rs`; lo stesso
  owner mantiene il write-back memoria delle azioni sulle card, mentre il motore
  supervisor resta in `gateway_proactivity`.
- Estrazione locale `gateway_vault_routes`: route `/api/vault/*`, DTO PIN/record,
  save/reveal/update/dedup/search dei record Vault e approvazione payment card
  escono dal monolite `main.rs`; il claim/enforcement delle azioni browser
  payment resta fuori da questa slice.

## Invarianti ora protetti

- Un turno terminale non lascia liveness UI attiva.
- Un turno terminale non lascia step di piano attivi nella projection UI.
- Piano e progresso vengono da `runtime_plans`/`turn_events`, non da marker.
- `browser_done` chiude il lavoro browser; snapshot visibile senza done resta
  `active`/`unknown`.
- Browser grounded partial terminale resta leggibile: risposta finale e fonti
  osservate sopravvivono al fallback invece di mostrare solo una risposta
  generica o vuota.
- La fixture `browser_grounded_partial_terminal` mantiene goal/piano visibili,
  browser `done`, nessun attention item e nessuna liveness attiva.
- Receipt `Read` incerta non genera card di verifica utente.
- Receipt `ExternalWrite` incerta genera attention item.
- Tool/plugin/MCP caricati non cambiano liveness.
- Automazioni e proactive run usano lo stesso vocabolario del kernel.
- `/api/health` resta un probe di liveness veloce: niente lock store e niente
  shell-out Docker nel percorso di risposta.
- Il workspace plan UI viene proiettato da `kernelProjectionPresenter` usando
  `chat-runtime/planSteps`; l'hook activity fa fetch/replay e non possiede piu'
  parsing o normalizzazione del piano.
- Marker legacy possono renderizzare storico, ma non riaprire lifecycle corrente,
  non forzano composer mode e non alimentano piu' plan/activity dell'isola.

## Gate verificati

Baseline Runtime V2 su PR #108:

```bash
python3 scripts/kernel_regression_gate.py
python3 scripts/pre_release_gate.py
make test
```

Esito: verde prima del merge.

Slice browser/projection successive:

- PR #109 mergeata il 2026-08-12, merge commit `5b5f27f0`.
- PR #110 mergeata il 2026-08-12, merge commit `8be33808`; gate locale
  `python3 scripts/kernel_regression_gate.py` verde.
- PR #111 mergeata il 2026-08-13, merge commit `41777852`; gate locale
  `python3 scripts/kernel_regression_gate.py` verde e CI verde su Backend,
  Frontend, Landlock, Release readiness, build Linux/macOS/Windows.
- PR #112 mergeata il 2026-08-13, merge commit `3eb69e2b`; gate locale
  `python3 scripts/kernel_regression_gate.py` verde e CI verde su Backend,
  Frontend, Landlock, Release readiness, build Linux/macOS/Windows.
- PR #113 mergeata il 2026-08-13, merge commit `74735bb6`; gate locale
  `python3 scripts/kernel_regression_gate.py` verde e CI verde su Backend,
  Frontend, Landlock, Release readiness, build Linux/macOS/Windows.
- PR #114, #115, #116 mergeate in `main`; `main` osservato a `a688c991`.
- PR #118 mergeata il 2026-08-14, merge commit `29435a4b`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #119 mergeata il 2026-08-14, merge commit `7aec200d`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #120 mergeata il 2026-08-14, merge commit `88ee847e`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #121 mergeata il 2026-08-14, merge commit `169d2fd0`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #122 mergeata il 2026-08-14, merge commit `e0c1d610`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #123 mergeata il 2026-08-14, merge commit `3401578b`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #124 mergeata il 2026-08-14, merge commit `e9947b74`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #125 mergeata il 2026-08-14, merge commit `4f792bfb`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #126 mergeata il 2026-08-14, merge commit `8c4fadfd`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #127 mergeata il 2026-08-14, merge commit `97040858`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #128 mergeata il 2026-08-14, merge commit `33d6e7e4`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #129 mergeata il 2026-08-14, merge commit `a554a1ef`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #131 mergeata il 2026-08-17, merge commit `ba4dc0a8`; CI verde su
  Release readiness, Frontend, Backend, Landlock e build installer
  Linux/macOS/Windows.
- PR #210 mergeata il 2026-08-19, merge commit `96a1e309`; gate locale
  `python3 scripts/kernel_regression_gate.py` verde e CI verde su Backend,
  Frontend, Landlock, Release readiness e build installer Linux/macOS/Windows.
- PR #211 mergeata il 2026-08-19, merge commit `373eca7c`; gate locale
  `python3 scripts/kernel_regression_gate.py` verde e CI verde su Backend,
  Frontend, Landlock, Release readiness e build installer Linux/macOS/Windows.
- Slice `fabio/app-action-budget-contracts` verificata localmente con:
  `python3 scripts/check_gateway_main_contract.py`, `cargo fmt --check`,
  `cargo test -p local-first-desktop-gateway plan_stall -- --nocapture`,
  `cargo test -p local-first-desktop-gateway block_stalled_step -- --nocapture`,
  `cargo test -p local-first-desktop-gateway runtime_plan_control_store_owns_stall_bookkeeping -- --nocapture`,
  `cd apps/desktop && npm test`, `cd apps/desktop && npm run test:ui-contract`,
  `cd apps/desktop && npm run build`, `python3 scripts/kernel_regression_gate.py`
  verde con voce `gateway plan stall`.
- Slice `fabio/plugin-tool-budget-contracts` verificata localmente con:
  `cargo fmt --check`, `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway gateway_tool_budget -- --nocapture`,
  `git diff --check`, `python3 scripts/kernel_regression_gate.py` verde con
  voce `gateway tool budget`.
- Slice `fabio/tool-timeout-contracts` verificata localmente con:
  `cargo fmt --check`, `python3 scripts/check_gateway_main_contract.py`,
  `git diff --check`,
  `cargo test -p local-first-desktop-gateway gateway_tool_timeouts -- --nocapture`
  e `python3 scripts/kernel_regression_gate.py` verde con voce
  `gateway tool timeouts`.
- Slice `fabio/action-confirmation-contracts` in verifica locale: owner-level
  `cargo test -p local-first-desktop-gateway gateway_action_confirmations -- --nocapture`
  verde; contract `python3 scripts/check_gateway_main_contract.py` verde;
  `python3 scripts/kernel_regression_gate.py` verde con voce
  `gateway action confirmations`.
- Slice `fabio/gateway-workspaces-owner` verificata localmente con:
  `cargo fmt --check`, `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway workspace -- --nocapture`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`
  e `python3 scripts/kernel_regression_gate.py` verde con voce
  `gateway workspaces`.
- Slice `fabio/gateway-memory-bench-owner` verificata localmente con:
  `cargo fmt --check`, `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway memorybench`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`
  e `python3 scripts/kernel_regression_gate.py` verde con voce
  `gateway memory bench`.
- Slice `fabio/gateway-memory-ui-routes-owner` verificata localmente con:
  `cargo fmt --check`, `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_memory_ui_routes -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_health -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway health_stays_live_while_a_store_lock_is_held -- --nocapture`,
  `HOMUN_WORKSPACE_ID=project-b cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway workspace -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway -- --nocapture`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cd apps/desktop && npm run test:ui-contract`,
  `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py` verdi.
- Slice `fabio/gateway-memory-decide-route-owner` verificata localmente con:
  `cargo fmt --check`, `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_memory_tools -- --nocapture`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cd apps/desktop && npm run test:ui-contract`,
  `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py` verdi.
- Slice `fabio/gateway-contact-profile-owner` verificata localmente con:
  RED `python3 scripts/check_gateway_main_contract.py`, poi
  `cargo fmt --check`, `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_contact_profile -- --nocapture`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cd apps/desktop && npm run test:ui-contract`,
  `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py` verdi.
- Slice `fabio/gateway-contact-relationships-owner` verificata localmente con:
  `cargo fmt --check`, `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_contact_relationships -- --nocapture`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cd apps/desktop && npm run test:ui-contract`,
  `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py` verdi.
- Slice `fabio/gateway-contact-perimeter-owner` verificata localmente con:
  `cargo fmt --check`, `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_contact_perimeter -- --nocapture`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cd apps/desktop && npm run test:ui-contract`,
  `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py` verdi.
- Slice `fabio/gateway-contact-profiles-owner` verificata localmente: owner
  `/api/profiles*` e `/api/memory/contacts/assign-profile` spostato in
  `gateway_contact_profiles`; verificata localmente con `cargo fmt --check`,
  `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_contact_profiles -- --nocapture`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cd apps/desktop && npm run test:ui-contract`,
  `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py` verdi.
- Slice `fabio/gateway-contacts-owner` verificata localmente: owner core rubrica
  `/api/memory/contacts*`, DTO `ContactView` e helper condivisi spostati in
  `gateway_contacts`; verificata localmente con `cargo fmt --check`,
  `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_contacts -- --nocapture`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cd apps/desktop && npm run test:ui-contract`,
  `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py` verdi.
- Slice `fabio/gateway-model-routes-owner` verificata localmente: surface HTTP
  runtime model/provider/roles spostata in `gateway_model_routes`, mentre
  `gateway_model_routing` resta owner di registry, routing e policy modello.
  Verificata localmente con `cargo fmt --check`,
  `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_model_routes -- --nocapture`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cd apps/desktop && npm run test:ui-contract`,
  `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py` verdi.
- Slice `fabio/gateway-project-graph-owner` verificata localmente: fingerprint
  sorgenti, refresh Graphify, route `/api/memory/project-graph/*` e route
  integrity/repair spostati in `gateway_project_graph_routes`; `main.rs` resta
  solo consumer del refresh dopo modifiche codice. Verifiche verdi:
  `cargo fmt --check`,
  `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_project_graph_routes -- --nocapture`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway project_graph -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway project_change_fingerprint -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway integrity_ -- --nocapture`,
  `cd apps/desktop && npm run test:ui-contract`,
  `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py`.
- Slice `fabio/gateway-capability-routing-owner` verificata localmente:
  definizioni native workflow/atomic, registry semantico, decisione semantica
  turn/steering, binding deterministico plugin, forced tool e pruning per route
  spostati in `gateway_capability_routing`; `gateway_capability_registry` resta
  owner del corpus discovery generico e `gateway_tool_execution` resta owner del
  dispatch tool. Gate verdi: `cargo fmt --check`,
  `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_capability_routing -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway semantic_decision -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway workflow_route -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway forced_tool_for_turn -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway native_atomic -- --nocapture`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cd apps/desktop && npm run test:ui-contract`,
  `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py`.
- Slice `fabio/gateway-task-executor-read-model-owner` verificata localmente:
  DTO/status executor, queue/detail read model mapping, projection uncertain
  effects e label/filter task user-facing spostati in `gateway_task_executor`;
  `main.rs` resta solo consumatore del tipo `TaskExecutorStatus` nello stato
  applicativo e non possiede piu' il read model della coda. Verifiche verdi:
  `cargo fmt --check`,
  `python3 scripts/check_gateway_main_contract.py`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_task_executor -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway task_queue_response -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway queue_hides_internal_subtasks_and_humanizes_kinds -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway uncertain_effect_projection_is_bounded_and_metadata_only -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway task_queue_scope_retains_only_matching_uncertain_effects -- --nocapture`,
  `cd apps/desktop && npm run test:ui-contract`,
  `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py`.
- Slice `fabio/capability-snapshot-read-model-owner` verificata localmente:
  DTO e mapping dello snapshot `/api/capabilities/snapshot` spostati da
  `main.rs` a `gateway_capability_registry`; la route HTTP e' stata poi spostata
  nello stesso owner, rendendo il registry capability l'unico owner della
  projection connections/tool usata dalla UI. Verifiche verdi: `cargo fmt --check`,
  `python3 scripts/check_gateway_main_contract.py`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_capability_registry -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_task_executor -- --nocapture`,
  `cd apps/desktop && npm run test:ui-contract`,
  `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py`.
- Slice `fabio/capability-registry-bootstrap-owner` verificata localmente:
  apertura seeded del registry capability, seed provider browser e materializzazione
  dei tool browser cacheati spostati da `main.rs` a `gateway_capability_registry`;
  il root resta consumer del registry pronto e non possiede piu' il bootstrap.
  Verifiche verdi: `cargo fmt --check`,
  `python3 scripts/check_gateway_main_contract.py`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_capability_registry -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway browser_registry_tools -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway seed_browser_provider -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway seeded_browser_tools -- --nocapture`,
  `cd apps/desktop && npm run test:ui-contract`,
  `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py`.
- Slice `fabio/local-computer-read-model-owner` verificata localmente:
  DTO preview artifact e route/read-model `/api/local-computer/session/*` e
  `/api/local-computer/session/*/artifact/*/preview` spostati da `main.rs` a
  `gateway_browser_runtime`; il root resta solo composition/consumer delle route.
  Verifiche verdi: `cargo fmt --check`,
  `python3 scripts/check_gateway_main_contract.py`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_browser_runtime -- --nocapture`,
  `cd apps/desktop && npm run test:ui-contract`.
- Slice `fabio/capability-registry-contracts` verificata localmente: RED del contract
  `check_gateway_main_contract.py` osservato prima dell'estrazione; GREEN
  mirati con `python3 scripts/check_gateway_main_contract.py`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_capability_registry -- --nocapture`,
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway capability -- --nocapture`,
  `cargo test -p local-first-desktop-gateway gateway_capability_registry -- --nocapture`,
  `cargo test -p local-first-desktop-gateway gateway_tool_budget -- --nocapture`,
  `cargo fmt --check`, `git diff --check` e
  `python3 scripts/kernel_regression_gate.py` verde con voce
  `gateway capability registry`.
- Slice `fabio/mcp-chat-tools-contracts` verificata localmente: owner-level
  `cargo test -p local-first-desktop-gateway gateway_mcp_chat_tools -- --nocapture`
  verde; test compat MCP
  `cargo test -p local-first-desktop-gateway mcp_chat -- --nocapture` verde;
  test corpus MCP
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway mcp_tool -- --nocapture`
  verde; contract `python3 scripts/check_gateway_main_contract.py` verde;
  `cargo fmt --check`, `git diff --check` e
  `python3 scripts/kernel_regression_gate.py` verdi.
- Slice `fabio/mcp-runtime-contracts` verificata localmente: nuovo owner
  `gateway_mcp_runtime` con transport stdio/http, metadata, secret migration,
  discovery/cache e `run_mcp_chat_tool`; owner-level
  `cargo test -p local-first-desktop-gateway gateway_mcp_runtime -- --nocapture`
  verde; compat MCP `mcp_chat`, `mcp_tool`, `mcp_http` verdi; contract
  `python3 scripts/check_gateway_main_contract.py`, `cargo fmt --check`,
  `git diff --check` e `python3 scripts/kernel_regression_gate.py` verdi.
- Slice `fabio/mcp-connection-routes-contracts` verificata localmente: nuovo owner
  `gateway_mcp_connections` per connect/registry/connected/disconnect MCP;
  owner-level `cargo test -p local-first-desktop-gateway gateway_mcp_connections -- --nocapture`
  verde; contract `python3 scripts/check_gateway_main_contract.py`, `cargo fmt --check`,
  `cargo clippy --workspace --all-targets --locked -- -D warnings`, `git diff --check`
  e `python3 scripts/kernel_regression_gate.py` verdi.
- Slice `fabio/mcp-execution-route-contracts` verificata localmente: nuovo owner
  `gateway_mcp_execution` per endpoint confirm-card MCP execute, marker
  allow-server e orchestration terminale; owner-level
  `cargo test -p local-first-desktop-gateway gateway_mcp_execution -- --nocapture`
  verde; compat MCP confinanti `mcp_chat`, `gateway_mcp_runtime`,
  `gateway_mcp_connections`, `gateway_action_confirmations`,
  `gateway_tool_timeouts` e `mcp_http` verdi; contract
  `python3 scripts/check_gateway_main_contract.py`, `cargo fmt --check`,
  `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  `git diff --check` e `python3 scripts/kernel_regression_gate.py` verdi.
- Slice `fabio/write-tool-allowlist-owner` verificata localmente: nuovo owner
  `gateway_write_tool_allowlist` per persistenza/list/revoke/matching
  always-allow write-tool Composio/MCP; owner-level
  `cargo test -p local-first-desktop-gateway gateway_write_tool_allowlist -- --nocapture`
  verde; compat dispatcher
  `cargo test -p local-first-desktop-gateway gateway_tool_execution -- --nocapture`
  verde; compat confinanti `gateway_mcp_execution`, `mcp_chat`, `composio` e
  `gateway_action_confirmations` verdi; contract
  `python3 scripts/check_gateway_main_contract.py`, `cargo fmt --check`,
  `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  `git diff --check` e `python3 scripts/kernel_regression_gate.py` verdi.
- Slice locale `gateway_thread_files` verificata sul branch
  `fabio/write-tool-allowlist-contracts`: nuovo owner per persistenza cartella
  thread, precedenza workspace attivo, search/read `@ file`; `path_within`
  spostato in `gateway_file_security`; owner-level
  `cargo test -p local-first-desktop-gateway gateway_thread_files -- --nocapture`
  e `cargo test -p local-first-desktop-gateway gateway_file_security -- --nocapture`
  verdi; compat confinanti `gateway_artifacts` e `gateway_artifact_memory`
  verdi; contract `python3 scripts/check_gateway_main_contract.py`,
  `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  `git diff --check` e `python3 scripts/kernel_regression_gate.py` verdi.
- Slice locale `gateway_transcription` verificata sul branch
  `fabio/write-tool-allowlist-contracts`: nuovo owner per route dictation,
  validazione audio base64 e bridge Whisper contained-computer; owner-level
  `cargo test -p local-first-desktop-gateway gateway_transcription -- --nocapture`
  verde; contract `python3 scripts/check_gateway_main_contract.py`,
  `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  `git diff --check` e `python3 scripts/kernel_regression_gate.py` verdi.
- Slice locale `gateway_usage_routes` verificata sul branch
  `fabio/write-tool-allowlist-contracts`: nuovo owner per route usage ledger,
  provider account snapshot, policy budget manuale e model-usage suggestions;
  owner-level
  `cargo test -p local-first-desktop-gateway gateway_usage_routes -- --nocapture`
  verde; compat usage
  `cargo test -p local-first-desktop-gateway usage -- --nocapture` verde;
  contract `python3 scripts/check_gateway_main_contract.py`,
  `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  `git diff --check` e `python3 scripts/kernel_regression_gate.py` verdi.
- Slice locale `gateway_update_routes` verificata sul branch
  `fabio/gateway-update-routes-owner`: nuovo owner per update webhook,
  `/api/update/info` e `/api/update/trigger`; owner-level
  `cargo test -p local-first-desktop-gateway gateway_update_routes -- --nocapture`
  verde; contract `python3 scripts/check_gateway_main_contract.py`,
  `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  `git diff --check` e `python3 scripts/kernel_regression_gate.py` verdi.
- Slice locale `gateway_project_access` verificata sul branch
  `fabio/gateway-project-access-owner`: nuovo owner per grant accesso progetto,
  persistenza, route access/upsert/remove e resolver policy condiviso da
  channels/automazioni; owner-level
  `cargo test -p local-first-desktop-gateway project_access -- --nocapture`
  verde; contract `python3 scripts/check_gateway_main_contract.py`,
  `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  `git diff --check` e `python3 scripts/kernel_regression_gate.py` verdi.
- Slice locale `gateway_skill_routes` verificata sul branch
  `fabio/gateway-skill-routes-owner`: nuovo owner per route skills locali,
  enable/disable, catalogo ClawHub, preview/install e registry GitHub;
  owner-level `cargo test -p local-first-desktop-gateway gateway_skill_routes -- --nocapture`
  verde; contract `python3 scripts/check_gateway_main_contract.py`,
  `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  `git diff --check` e `python3 scripts/kernel_regression_gate.py` verdi.
- Slice locale `gateway_skill_runtime` verificata sul branch
  `fabio/gateway-skill-runtime-owner`: nuovo owner per directory skill
  condivisa, normalizzazione id, creazione skill, discovery prompt,
  caricamento progressive-disclosure/adattamento SKILL.md e schemi
  `use_skill` / `run_in_sandbox`; RED del contract
  `check_gateway_main_contract.py` osservato prima dell'estrazione; owner-level
  `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway gateway_skill_runtime -- --nocapture`
  verde; compat confinanti `gateway_skill_routes`, `gateway_tool_execution` e
  `gateway_capability_routing` verdi; `cargo fmt --all -- --check`,
  `python3 scripts/check_gateway_main_contract.py`,
  `cargo check -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `git diff --check`, `python3 scripts/kernel_regression_gate.py` e
  `python3 scripts/pre_release_gate.py` verdi.
- Slice locale `gateway_memory_publications` verificata sul branch
  `fabio/gateway-memory-publications-owner`: nuovo owner per route
  publication create/get/edit/approve/reject, DTO request, mapping errori e
  validazione owned-scope; owner-level
  `cargo test -p local-first-desktop-gateway memory_publication -- --nocapture`
  verde; contract `python3 scripts/check_gateway_main_contract.py`,
  `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  `git diff --check` e `python3 scripts/kernel_regression_gate.py` verdi.
- Slice locale `gateway_memory_sources` verificata localmente sul branch
  `fabio/gateway-memory-sources-owner`: nuovo owner per route source grant
  list/upsert/revoke/candidates, DTO request/query, validazione policy e
  proiezioni grant/candidate; owner-level
  `cargo test -p local-first-desktop-gateway memory_source -- --nocapture`
  verde; contract `python3 scripts/check_gateway_main_contract.py`,
  `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  `git diff --check` e `python3 scripts/kernel_regression_gate.py` verdi.

## PR / CI

PR mergeate:

- #108 `Settle terminal plan projection states`:
  `https://github.com/homun-app/homun-core/pull/108`.
- #109 `Preserve grounded browser timeout results`:
  `https://github.com/homun-app/homun-core/pull/109`.
- #110 `Preserve grounded browser fallback evidence`:
  `https://github.com/homun-app/homun-core/pull/110`.
- #111 `Pin browser projection fallback contract`:
  `https://github.com/homun-app/homun-core/pull/111`.
- #112 `Update Runtime V2 status after browser projection contracts`:
  `https://github.com/homun-app/homun-core/pull/112`.
- #113 `Remove legacy HITL liveness fallback`:
  `https://github.com/homun-app/homun-core/pull/113`.
- #114 `Update status after Runtime V2 projection work`:
  `https://github.com/homun-app/homun-core/pull/114`.
- #115 `Fix browser timeout diagnostics and time input fallback`:
  `https://github.com/homun-app/homun-core/pull/115`.
- #116 `Fix browser smoke completion contract`:
  `https://github.com/homun-app/homun-core/pull/116`.
- #118 `Extract plan stall budget owner`:
  `https://github.com/homun-app/homun-core/pull/118`.
- #119 `Extract gateway tool budget owner`:
  `https://github.com/homun-app/homun-core/pull/119`.
- #120 `Extract capability registry owner`:
  `https://github.com/homun-app/homun-core/pull/120`.
- #121 `Extract capability corpus materialization`:
  `https://github.com/homun-app/homun-core/pull/121`.
- #122 `Update status after capability materialization merge`:
  `https://github.com/homun-app/homun-core/pull/122`.
- #123 `Extract gateway tool timeout owner`:
  `https://github.com/homun-app/homun-core/pull/123`.
- #124 `Update status after tool timeout merge`:
  `https://github.com/homun-app/homun-core/pull/124`.
- #125 `Extract action confirmation owner`:
  `https://github.com/homun-app/homun-core/pull/125`.
- #126 `Update status after action confirmations merge`:
  `https://github.com/homun-app/homun-core/pull/126`.
- #127 `Extract MCP chat tools owner`:
  `https://github.com/homun-app/homun-core/pull/127`.
- #128 `Update status after MCP chat tools merge`:
  `https://github.com/homun-app/homun-core/pull/128`.
- #129 `Extract MCP runtime owner`:
  `https://github.com/homun-app/homun-core/pull/129`.
- #130 `Update status after MCP runtime merge`:
  `https://github.com/homun-app/homun-core/pull/130`.
- #131 `Extract MCP connection route owner`:
  `https://github.com/homun-app/homun-core/pull/131`.
- #132 `Update status after MCP connections merge`:
  `https://github.com/homun-app/homun-core/pull/132`.
- #133 `Extract MCP execution route owner`:
  `https://github.com/homun-app/homun-core/pull/133`.
- #134 `Extract write-tool allow-list owner`:
  `https://github.com/homun-app/homun-core/pull/134`.
- #135 `Extract thread linked-file owner`:
  `https://github.com/homun-app/homun-core/pull/135`.
- #136 `Extract chat transcription owner`:
  `https://github.com/homun-app/homun-core/pull/136`.
- #137 `Extract usage route owner`:
  `https://github.com/homun-app/homun-core/pull/137`.
- #138 `Extract gateway tags owner`:
  `https://github.com/homun-app/homun-core/pull/138`.
- #139 `Extract gateway update routes owner`:
  `https://github.com/homun-app/homun-core/pull/139`.
- #140 `Extract gateway project access owner`:
  `https://github.com/homun-app/homun-core/pull/140`.
- #141 `Extract gateway skill routes owner`:
  `https://github.com/homun-app/homun-core/pull/141`.
- #142 `Extract gateway memory publications owner`:
  `https://github.com/homun-app/homun-core/pull/142`.
- #143-#283, #285-#286, #288-#404: slice owner-level successive mergeate in
  `main`, fino a `mock data owner split` e relativo riallineamento di stato;
  `main` verificato e riallineato a #404.

PR aperte:

- #117 browser draft separata, fuori dal lavoro non-browser corrente.
- #406 `Stabilize RC chat planning and browser flow`: PR RC validata con CI e
  build installer verdi; se non ancora mergeata, e' pronta per `main`.

Baseline corrente:

- `main` a #405 (`b76fe0d2`); audit finale non-browser post-#404 completato.
- Diff RC #406 verificato il 2026-08-26 con gate kernel, pre-release gate, CI
  GitHub, build installer macOS/Linux/Windows e smoke reali gateway/UI su
  `electron:dev`.

## Debito residuo

- Se #406 non e' ancora mergeata, mergearla in `main` dopo la verifica finale
  dello stato PR.
- Eseguire profilo upgrade isolato su build installata, non sul profilo reale
  dell'utente.
- Decidere il claim pubblico del browser: Selenium/stable browser smoke e'
  coperto; Trenitalia/Trainline restano limitazione nota o sessione hardening
  separata prima di promettere web automation complessa.
- `ThreadActivityProjection` e la route backend compat
  `GET /api/chat/threads/{thread_id}/activity` sono stati rimossi nella cleanup
  backend 2026-08-12; il read model canonico e' `KernelThreadProjection`.
- `legacyMarkerProjection` e' stato rimosso da `useChatActivityProjection`; in
  assenza di `KernelThreadProjection` l'isola runtime resta vuota invece di
  ricostruire plan/activity dai marker.
- `threadTailAwaits*` e' stato rimosso da lifecycle/composer routing; i marker
  HITL del transcript restano display-only e non possono piu' creare liveness o
  modalita' reply prima del load della projection.
- `apps/desktop/src/lib/chat-runtime/lifecycle.{mjs,ts}` e' stato rimosso nella
  cleanup UI 2026-08-24; il lifecycle UI e' proiettato solo da
  `kernelProjectionPresenter` dentro `runtimeViewModel.turnUiState`.
- `projectedActiveTurn` e `projectedTurnStatus` non devono piu' tornare come
  props/return value UI paralleli: active turn e status passano da
  `runtimeViewModel.activeTurn` e `runtimeViewModel.turnUiState.status`.
- `routeComposerSubmission` non deve piu' derivare localmente il composer mode
  da `turnUiState`/`projectionLoaded`; la modalita' arriva dal presenter via
  `runtimeViewModel.composerMode`.
- `apps/desktop/src/lib/selectedTaskProjection.{mjs,ts}` e il relativo test
  sono stati rimossi; la selected-task projection non deve tornare come stato UI
  parallelo.
- `taskQueueProjection` non deve piu' ricevere `fallbackTasks` e
  `useTaskQueueController` non deve piu' importare `mockData` per inizializzare
  task/approval: la task queue UI segue solo lo snapshot canonico del kernel.
- `App` non deve piu' importare `mockData` per inizializzare la transcript e
  `mockData` non deve piu' esportare `chatMessages`: il thread iniziale mostra
  l'empty hero finche' il read model canonico del gateway non restituisce
  messaggi reali.
- `useCapabilityController` non deve piu' importare `mockData` o ripiegare su
  `connections`; `mockData` non deve piu' esportare `connections`: la pagina
  Settings > Connections segue solo lo snapshot capability canonico del gateway,
  anche quando e' vuoto.
- `mockData` non deve tornare a esportare seed runtime ritirati
  (`computerSession`, `tasks`, `approvals`, `runtimeHealth`, `memorySummary`,
  `drawerTasks`, `drawerProjects`); se una superficie ha un owner canonico, deve
  consumare il read model gateway/controller o restare vuota.
- `apps/desktop/src/data/mockData.ts` non deve essere ricreato: nav/settings
  restano in `navigationConfig.ts`, mentre le fixture demo senza owner runtime
  stanno in `demoWorkspaceData.ts`.
- `useChatThreadCreation` non deve tornare a creare thread sintetici
  `thread_preview_*` o a importare `starterMessages`: la UI non deve possedere
  fallback locale di creazione thread oltre all'owner `chatApi`.
- `useInitialChatThreadsLoader` non deve importare `starterMessages` o seminare
  fallback locali del transcript: all'avvio deve applicare i messaggi restituiti
  dal read model oppure lasciare il transcript vuoto.
- `useChatReadModelController` non deve importare `starterMessages` e
  `appCoreMappers` non deve esportarlo: il transcript attivo deve arrivare da
  `threadMessages` oppure restare vuoto finche' il read model canonico non
  restituisce messaggi.
- `chatApi` puo' conservare il fallback local-only quando il gateway non
  risponde, ma non deve seminare messaggi assistant canned o `message_count: 1`:
  i thread locali devono partire con transcript vuota come il read model
  canonico.
- I cataloghi i18n non devono reintrodurre `chat.emptyHeroSub`: il fixed subtitle
  dell'empty hero e' stato ritirato e la UI deve usare i greeting selezionati dal
  presenter, non copy statico che promette risposte locali.
- `defaultChatThread` e `updateThreadPreview` non devono reintrodurre subtitle
  statiche di readiness locale (`Local session ready`, `Local chat ready`) per
  transcript vuote: la preview sidebar deve arrivare da messaggi/read model reali
  oppure restare vuota.
- I cataloghi i18n non devono reintrodurre `chat.localSessionReady`: la key e'
  stata ritirata dopo la rimozione dei consumer UI e non deve restare come copy
  morta di readiness locale.
- `chatApi` non deve reintrodurre subtitle statiche `Local chat` o
  `Local model`: il fallback locale puo' esistere solo come modalita'
  offline/dev, con preview vuota all'avvio e derivata dall'ultimo messaggio reale
  dopo l'interazione.
- `Local model` residuo e' provenance message-scoped per le risposte locali e
  non deve essere confuso con preview/sidebar readiness copy.
- `Local chat` residuo in `coreBridge` resta browser/local-computer scoped e va
  trattato nella sessione browser dedicata, non come residuo non-browser.
- Continuare la rimozione dei fallback `legacy*` solo con fixture owner-level e
  gate kernel verde.
- `main.rs` e `ChatView.tsx` restano grandi, ma non vanno tagliati senza owner
  contract RED e Kill List esplicita.

## Prossimo lavoro

1. Se #406 non e' ancora mergeata, mergearla in `main` e riallineare il
   worktree locale.
2. Scaricare/installare gli artifact RC prodotti dalla matrice e validare il
   profilo upgrade isolato secondo `docs/testing/release-candidate-matrix.md`.
3. Prima della produzione pubblica, eseguire QA su build installata con profilo
   isolato e registrare limiti/known issues del browser complesso.

## Prompt di ripartenza

```text
Continuo Homun RC readiness. Repo: /Users/fabio/Projects/Homun/app,
branch `fabio/rc-readiness-2026-08-26` su base main #405 (`b76fe0d2`),
PR #406 verde su CI, release readiness e build installer macOS/Linux/Windows.
Prossimo passo: se #406 non e' ancora mergeata, mergearla in main; poi QA su
build installata con profilo isolato. I gate locali `kernel_regression_gate.py`
e `pre_release_gate.py` erano verdi il 2026-08-26.
Leggi docs/STATO.md, docs/architecture/kernel-v2-contract.md e
docs/testing/kernel-contract-matrix.md.
Regola: codice = verita; ogni modifica deve avere owner canonico, Kill List,
fixture/gate e rimozione del fallback non piu' necessario.
```
