# Stato - Homun (documento vivo)

> **Ultimo aggiornamento: 2026-08-19 (gateway agent output completion locale).**
>
> Hub: [`README.md`](README.md). Mappa codice: [`architecture/`](architecture/).
> Archive stantia: [`archive/2026-07-31-doc-reset/`](archive/2026-07-31-doc-reset/).
> Prompt lungo storico: [`HANDOFF-2026-07-31.md`](HANDOFF-2026-07-31.md).

## Identita Git

| Campo | Valore |
| --- | --- |
| Repo | `/Users/fabio/Projects/Homun/app` |
| Worktree corrente | `/Users/fabio/Projects/Homun/app/.worktrees/gateway-agent-output-completion-owner` |
| Branch | `fabio/gateway-agent-output-completion-owner` |
| PR | #108-#116, #118-#186 mergeate in `main`; #117 browser draft separata; slice `gateway_agent_output_completion` locale non ancora in PR |
| HEAD codice verificato | branch `fabio/gateway-agent-output-completion-owner` sopra `main` aggiornato a #186 |

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

## Runtime V2 - chiuso su main

Piano completato:
[`superpowers/plans/2026-08-11-homun-unified-kernel-ui-plugin-convergence.md`](superpowers/plans/2026-08-11-homun-unified-kernel-ui-plugin-convergence.md).

Slice Runtime V2 recenti:

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
- Estrazione locale `gateway_write_tool_allowlist`: persistenza e matching
  "always allow" per write-tool Composio/MCP escono dal monolite `main.rs`;
  il file storico `composio-tool-allow.json` resta invariato per compatibilita',
  mentre list/revoke e marker MCP server-level vivono nello stesso owner.
- Estrazione locale `gateway_vault_routes`: route `/api/vault/*`, DTO PIN,
  record/payment approval, storage/reveal/update/dedup/search Vault e rewrite
  della payment card approvata escono dal monolite `main.rs`; browser action
  enforcement e claim finale pagamento restano owner separato.
- Estrazione locale `gateway_local_authorization_routes`: route/DTO e marker
  locali per filesystem authorization, sandbox escalation, read-only card e
  connect-suggestion mark escono dal monolite `main.rs`.
- Estrazione mergeata `gateway_composio_routes`: route/DTO Composio per connect,
  toolkits/auth/link/connections/disconnect/logo, catalogo chat-tool,
  classificazione read/write e suggest capability escono dal monolite
  `main.rs`; `composio_execute_tool`, payment approval claim e remote approval
  dispatch restano owner separati.
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
- Estrazione mergeata `gateway_model_routing`: DTO `RoutingDecision`, lettura
  `routing-decisions.json` e writer ring-buffer capped escono dal monolite
  `main.rs`; la surface HTTP `/api/routing-decisions` resta in
  `gateway_model_routes`, mentre `now_epoch_secs` resta nel root perche'
  condiviso da runtime, memory, browser e workspace.
- Estrazione mergeata `gateway_model_routing`: resolver API key inference,
  fallback env, factory `ModelRouter` da provider/ruolo e router legacy da env
  escono dal monolite `main.rs`; `resolve_role_for_task` e il wrapper browser
  restano fuori da questa slice.
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
  monolite `main.rs`; `now_epoch_secs` resta nel root perche' condiviso da
  runtime, memory, browser e workspace.
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
  `runtime_plans`, proiezione memoria/graph degli step e port engine
  `GatewayPlanProgress` escono dal monolite `main.rs`; tool schema, stall
  budget, prompt packet e dispatch tool restano owner separati.
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
- Estrazione mergeata `gateway_brain_runtime`: flag di abilitazione Brain, adapter
  `GatewayBrainMemory` e budget orchestrator scalati sul context window escono
  dal monolite `main.rs`; materializzazione durable dei task, capability facade,
  routing workflow e loop agente restano owner separati.
- Estrazione mergeata `gateway_context_compactor`: adapter port `GatewayContextCompactor`
  esce dal monolite `main.rs` e vive nell'owner `gateway_model_routing`, accanto
  alle policy di compaction visibili al modello; `GatewayTurnPolicy`,
  `GatewayTurnCompletionJudge` e il loop agente restano owner separati.
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
- Slice corrente `gateway_agent_output_completion`: la policy
  `agent_output_incomplete_reason` per classificare risposte agente vuote o
  plan-marker incompleti esce dal monolite `main.rs` e vive in
  `gateway_model_routing`, accanto al completion judge no-plan; `GatewayTurnPolicy`,
  `GatewayPlanProgress` e il loop agente restano owner separati.
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
  memory e full user-data export escono dal monolite `main.rs`; MemoryBench,
  memory graph build/mutation e storage semantics del `MemoryFacade` restano
  separati.
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
  `main.rs` a `gateway_capability_registry`; la route HTTP resta thin adapter e
  il registry capability diventa l'unico owner della projection connections/tool
  usata dalla UI. Verifiche verdi: `cargo fmt --check`,
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
- #143-#186: slice owner-level successive mergeate in `main`, fino a
  `gateway_composio_transport`; `main` verificato e riallineato a #186
  prima della slice corrente.

PR aperte:

- #117 browser draft separata, fuori dal lavoro non-browser corrente.

Branch corrente:

- `fabio/gateway-agent-output-completion-owner`: branch sopra `main` aggiornato
  a #186; contiene solo la slice `agent_output_incomplete_reason`.

## Debito residuo

- Smoke Electron reale su `main` pulito: chat, plan progress, browser read
  research, Activity/browser island, composer mode, nessuna card di verifica per
  azioni browser read-only.
- Aggiornare eventuali note release/RC dopo smoke visuale reale.
- `ThreadActivityProjection` e la route backend compat
  `GET /api/chat/threads/{thread_id}/activity` sono stati rimossi nella cleanup
  backend 2026-08-12; il read model canonico e' `KernelThreadProjection`.
- `legacyMarkerProjection` e' stato rimosso da `useChatActivityProjection`; in
  assenza di `KernelThreadProjection` l'isola runtime resta vuota invece di
  ricostruire plan/activity dai marker.
- `threadTailAwaits*` e' stato rimosso da lifecycle/composer routing; i marker
  HITL del transcript restano display-only e non possono piu' creare liveness o
  modalita' reply prima del load della projection.
- Continuare la rimozione dei fallback `legacy*` solo con fixture owner-level e
  gate kernel verde.
- `main.rs` e `ChatView.tsx` restano grandi, ma non vanno tagliati senza owner
  contract RED e Kill List esplicita.

## Prossimo lavoro

1. Completare gate, commit e PR piccola per `gateway_agent_output_completion`.
2. Dopo merge gateway agent output completion, aggiornare `main` e riprendere la
   prossima slice non-browser solo dopo nuova lettura owner-level di `main.rs`.
3. Sessione browser dedicata dopo il refactor kernel: smoke Electron reale su
   goal/plan/progress e treni Milano-Roma read-only.

## Prompt di ripartenza

```text
Continuo Homun Runtime V2. Repo: /Users/fabio/Projects/Homun/app,
branch fabio/gateway-agent-output-completion-owner se la slice agent output completion e' ancora da aprire o e' aperta;
altrimenti main aggiornato a #186/#successive e scegli la prossima slice non-browser owner-level.
Leggi docs/STATO.md, docs/architecture/kernel-v2-contract.md e
docs/testing/kernel-contract-matrix.md.
Regola: codice = verita; ogni modifica deve avere owner canonico, Kill List,
fixture/gate e rimozione del fallback non piu' necessario.
```
