# Audit del motore Homun rispetto a Hermes — 27 settembre 2026

## Verdetto

**La parità funzionale completa non è raggiunta, anche escludendo l'interfaccia.** Sono presenti molti sottosistemi utili, ma diverse righe dichiarate verificate coprono solo helper, contratti o simulazioni iniettate nei test. Ci sono lacune locali e falsi successi riprodotti che l'aggiunta di credenziali non risolve.

- Homun: `39a485fd`, branch main, checkout pulito all'inizio e alla verifica finale.
- Riferimento Hermes: checkout locale `.audit-hermes-ref`, commit verificato `c9dca726514b709cf6e677d236a79fc8d0627f37`.
- Non è un confronto con le eventuali versioni Hermes successive.
- Ambito: tutti gli ID originali H01–H46; nessun ID rinominato o requisito escluso per comodità. L'assenza di schermate non è stata usata come prova di un gap del motore.
- Metodo: ispezione sorgente/callsite e confronto con il riferimento; suite mirate e probe isolati. Non è una certificazione esaustiva di ogni caso limite o servizio remoto.
- Nessuna modifica al sorgente o ai documenti del repository. Rapporti salvati in /tmp. Nessun invio esterno o servizio a pagamento; la suite browser ha letto example.com e usato fixture di pagina.

## Cosa esiste realmente

Homun possiede un ciclo agente persistente con transcript canonico, proposte e approvazioni, recupero da errori e contesto eccessivo, materiali, modifica file approvata, terminale Docker/local/SSH, browser privato, MCP, memoria persistente e output revisionabili. Queste parti hanno prove utili. Il problema è l'equivalenza dell'intero comportamento richiesto, non l'assenza di qualsiasi implementazione.

## Gap principali, indipendenti dalla UI

1. **H21/H22 — Delegazione:** il tool effettua una sola chiamata sincrona al modello; gli strumenti e il limite turni del figlio non guidano un loop agente. Restituisce “running/background” dopo avere già ottenuto il risultato. Non c'è un child in-flight durevole da recuperare o annullare.
2. **H25–H29 — Obiettivi e automazioni:** valutazione degli obiettivi e scansione degli heartbeat non collegate al runtime; loop non risvegliati a sessione inattiva. Probe: job evento eleggibile senza evento e stessa scadenza cron rivendicabile due volte. La proposta cron in attesa di approvazione viene registrata come esecuzione riuscita.
3. **H08 — Chiarimenti strutturati:** il tool registrato richiede un callback che il runtime non configura. La chiamata ordinaria restituisce unavailable. Non confondere il vecchio ask_user, funzionante, con la nuova capacità completa.
4. **H01/H05/H07 — Ciclo nativo:** richiesta modello con stream=false; tool ordinari eseguiti uno alla volta; micro-compaction presente ma non attivata dai run ordinari; configurazione dei toolset non propagata e nomi readonly non corrispondenti a strumenti effettivi.
5. **H09/H11/H12/H15/H16 — Ambiente operativo:** emulatore PTY, restore/diff e alcune azioni browser presenti come helper ma non collegati al percorso eseguibile; LSP esplicitamente assente; computer-use incompleto oltre ai permessi OS.
6. **H35/H39/H40 — Falsi successi:** adapter Codex/Relay e prompt ACP possono riportare completamento senza reale esecuzione. Il ledger generico di approvazione marca eseguito senza executor. Le approvazioni canoniche del terminale/workspace sono percorsi distinti e non vengono dichiarate tutte difettose.
7. **H32/H33/H42 — Canali/consegne:** parser inbound senza listener produttivo; allegati Telegram non caricati dal send testuale; consegna fallita indicizzata come consegnata, con allegato escluso dal tentativo successivo.
8. **H17–H20/H30/H31/H36–H38/H41/H43–H46 — Capacità parziali:** learning/skill hub, sessioni collegate alla vera cronologia, OAuth interattivo/elicitation, provider/plugin, media/voce, integrazioni specifiche, daemon, eval e cataloghi richiedono ulteriore collegamento o implementazione. Dettaglio per ID nelle sezioni sotto.

## Blocchi esterni separati

Account/token e spend gate cloud, credenziali canali/provider, CLI autenticata, permessi TCC e ambienti OS restano necessari per alcune prove positive live. Questi prerequisiti non spiegano i gap locali sopra. Un adapter configurabile o una risposta di rifiuto corretta non dimostra che il percorso positivo sia completo.

## Verifiche effettuate in questo audit

| Gruppo | Esito | Limite |
|---|---|---|
| H01–H08: run API, bridge, contesto e controlli | 60 passati | Fixture/provider simulati e contratti; probe negativi separati |
| H09–H16/H40: terminale, file, browser, sicurezza | 77 passati | Misto di processi locali, Chrome reale e adapter simulati |
| H17–H31: memoria, skill, delegazione, automazioni, sessioni | 59 passati | Soprattutto manager/helper e modelli fixture |
| H32–H46 assegnati alle integrazioni | 23 passati | Fixture e helper; ACP stdio locale reale |

Le suite verdi non contraddicono i gap: molte verificano un helper isolato o accettano la semantica incompleta. Probe riprodotti: clarify unavailable, flag API scartati, readonly incompleto, trasporto nativo non streaming, cron evento senza evento/doppio claim, get/resume sessione di altro workspace a livello SessionManager, Codex/Relay sintetici, consegna fallita marcata consegnata. Le affermazioni basate solo sul sorgente sono indicate come tali nelle sezioni.

## Ordine di completamento proposto

1. Eliminare falsi successi e correggere isolamento/registrazione effetti: runtime sintetici, approvazioni generiche, delivery, cron e sessioni.
2. Collegare le capacità al ciclo agente reale: clarify, sotto-agenti durevoli, obiettivi e scheduler idle, policy strumenti e cancellazione.
3. Completare ambiente operativo e conoscenza: LSP/PTY/browser, restore, memoria/skill e sessioni canoniche.
4. Completare backend/plugin/provider/media/canali e cataloghi mancanti, mantenendo un elenco separato delle prove live esterne.
5. Riclassificare ogni requisito solo con scenario di accettazione eseguibile dal motore, inclusi errori e restart. Non dichiarare una percentuale globale da conteggi di file o test.

L'integrazione UI esistente non deve essere cancellata. Per rispettare la decisione di completare prima il motore, sospendere l'espansione di superfici che promettono le capacità ancora incomplete.

## Evidenze dettagliate H01–H46

I percorsi relativi nelle sezioni seguenti sono relativi a `/Users/fabio/Projects/Homun/homun2`. Le sezioni degli audit paralleli mantengono i dettagli tecnici originali; “partial” riguarda l'intera riga, non nega i sottocomportamenti verificati. H03 non ha mostrato un nuovo blocco nelle prove mirate: questo non lo estende automaticamente a certificazione di ogni caso limite.

## H01–H08: nucleo agente

Revisione Homun: `39a485fd`; upstream locale `.audit-hermes-ref` verificato al commit `c9dca726514b709cf6e677d236a79fc8d0627f37`. Verifica del motore, indipendente dalla UI. Nessuna chiamata a provider esterno nelle prove di questa sezione.

| ID | Valutazione | Implementazione concreta e limite |
|---|---|---|
| H01 | Parziale | Il ciclo nativo persiste transcript e risultati; i test del run passano. Il percorso `agent_run_execution._decision` chiama `models.complete_tools`, che usa `native_transport._complete` con `stream=False` (native_transport.py:57). Le chiamate tool pendenti vengono scelte una alla volta (`agent_native.py:21-24`, `advance` esegue al massimo una decisione). Esiste streaming testuale separato, ma non dimostra streaming/cancellazione del ciclo strumenti o batch concorrenti. Hermes ha `execute_tool_calls_concurrent` in agent/tool_executor.py:1504. |
| H02 | Parziale | Pausa/ripresa/steering/cancellazione durevoli e stop dei job terminale sono presenti e testati. Il trasporto nativo del modello non riceve una callback di cancellazione; il cancel_check testato appartiene al percorso stream testuale distinto. Non verificata propagazione fisica a tutte le classi di IO; il codice Python figlio presenta il limite riportato in H13. |
| H03 | Implementazione e prove mirate presenti; nessun nuovo blocco riprodotto | `agent_side_questions.py:59` espone domanda su snapshot e attribuzione uso senza mutare il transcript; test HTTP incluso nella suite eseguita. Non certificata in questo audit l'intera semantica di concorrenza e accounting durante fault. |
| H04 | Parziale rispetto al comportamento progressivo | Assemblaggio iniziale, precedenza, riferimenti e scoperta annidata presenti. `prompt_assembler.py:119` scopre ricorsivamente fino a profondita 3 all'avvio tramite `native_prompt.py:32`; non emerge un percorso di caricamento al successivo accesso a una directory. Hermes `agent/subdirectory_hints.py:1-5` inserisce istruzioni nei risultati degli strumenti quando l'agente naviga. Non equiparare una scansione iniziale al caricamento progressivo. |
| H05 | Parziale; micro-compaction non attivata dai run ordinari | Compattazione/checkpoint reali e testati. `agent_context.py:46` applica micro-compaction solo con `_context_policy.micro_compaction`; `agent_runs.py:200-201` crea soltanto context_window e max_output_tokens e non esiste setter produttivo del flag. Probe RunRequest conferma che micro_compaction viene ignorato. Prompt caching e flush memoria non dimostrati nel percorso nativo. |
| H06 | Recupero sostanziale verificato; parita integrale non dimostrata | Sono testati retry durevoli, overflow e fallback al provider secondario. Questo non verifica refresh credenziali, rotazione o riparazioni specifiche per ogni provider. Il failover cambia `_context_policy` nello snapshot (`agent_run_execution.py:187`), ma il blocco di persistenza (`:232-246`) copia connection_id/recovery e non tale policy: il run successivo conserva i limiti precedenti. Rischio rilevato dal sorgente, non riprodotto in questo audit. |
| H07 | Parziale; configurazione non propagata e classificazione readonly incompleta | `RunRequest` elimina surface/toolset/allowed_tools; `propose` non li conserva. Il filtro esiste, ma i test gli passano manualmente questi campi. Inoltre WRITE_TOOL_NAMES usa write_file/patch_file/terminal_exec invece dei nomi effettivi write_workspace_file/patch_workspace_file/terminal_execute. Probe diretto: tutti e tre sono consentiti con toolset=readonly. Le approvazioni specifiche restano separate: questo non prova un loro bypass. |
| H08 | Parziale; tool strutturato non collegato al canale umano | Parser e gestione batch esistono. Il tool `clarify` legge `_clarify_callback` oppure `_clarify_answers` (`clarify_tools.py:231-246`), che non hanno assegnazioni nel codice produttivo. Il dispatch ordinario senza questi valori restituisce `Clarify tool is not available in this execution context.` senza creare un'attesa umana. Il vecchio `ask_user` ha invece un percorso dedicato: la sua presenza non certifica clarify strutturato. Hermes collega agent.clarify_callback tramite agent/inline_tool_executors.py:252. |

### Prove eseguite

```
PYTHONPATH=engine/src engine/.venv/bin/python -m pytest \
 engine/tests/test_agent_runs_api.py engine/tests/test_agent_tool_bridge.py \
 engine/tests/test_agent_context.py engine/tests/test_agent_controls.py -q
```

Esito: **60 passed in 4.59s**. Log: `/tmp/homun-parity-core-audit.log`.

Probe locali isolati: `/tmp/homun-parity-core-probes-20260927.json`.
- Validazione della richiesta elimina toolset/surface/allowed_tools/micro_compaction.
- Chiamata reale della funzione execute di clarify, senza callback artificiale: errore unavailable.
- Filtro readonly accetta write_workspace_file, patch_workspace_file e terminal_execute.
- Trasporto nativo con provider fixture, senza rete: payload stream=false.

Questi controlli non sostituiscono un'accettazione esaustiva di ogni sottorequisito, ma dimostrano limiti locali sufficienti a respingere la dichiarazione di parita completa.


---

# Homun execution parity audit — 2026-09-27

Read-only audit at Homun `39a485fd` against Hermes `c9dca726514b709cf6e677d236a79fc8d0627f37` in `.audit-hermes-ref`. Repository remained clean. Paths below are relative to `engine/src/homun/` unless prefixed otherwise. Scope: H09–H16 and H40, engine behavior, excluding UI gaps.

## Per-ID classification

### H09 — Partial; verified subset

Durable terminal proposal/approval, background polling, stdin and PTY query path exist. `application/terminal_jobs.py:233` uses `PtyQueryResponder`, whose cursor reply is hardcoded home (`execution/pty_queries.py:20`); `VirtualTerminalScreen` at line 77 has no production references. Probe feeding cursor movement to row 12/column 34 followed by query returns `ESC[1;1R`.

Correction from subsequent direct upstream inspection: pinned `tools/pty_query_responder.py:44-55` explicitly uses the same home-cursor response and says Hermes does not emulate a screen. Therefore the fixed cursor response is **not itself a Hermes parity gap**. The unused Homun screen helper and its fragmented-input defect are separate Homun implementation/claim issues; they must not be used as proof that pinned Hermes has a full emulator. Concurrent reply ownership and restart-safe PTY operation still need their own operational evidence.

Independent deadline enforcement absent: `application/terminal_watchdog.py:1-4` explicitly depends on running engine; reconciliation entry is `runtime/dispatcher.py:22-23`. This is missing independent execution behavior, not missing credentials. Hermes process ownership/poll/wait implementation is `.audit-hermes-ref/tools/process_registry.py`, including wait at line 1992 and owned process kill logic around 997–1065; this audit does not claim Hermes itself has a separate daemon timer.

### H10 — Partial; cloud live verification external-blocked

Actual backend selection in `application/terminal_jobs.py:22-76` includes Docker/local/SSH and optional adapters. Local and SSH proposals explicitly reject stdin/PTY (`terminal_jobs.py:96-106`), so interactive backend equivalence is missing code, not credentials. Cloud adapter tests passed, but cross-backend real fixture/cwd/cleanup was not executed; Modal requires installed SDK, credentials and live gate (`execution/cloud_backends.py:94-115`). Upstream backend inventory: `.audit-hermes-ref/tools/environments/` and `agent/terminal_env_provider.py`.

### H11 — Partial; verified subset

Guarded edits, read/search and Python/JSON/TOML syntax delta covered by passing tests. No LSP implementation: `execution/file_syntax.py:45-56` always returns `lsp=unavailable`; TS/JS/Go/Rust unchecked.

XLSX/PPTX implemented but unwired for workspace reading: `materials/extract.py:134,178` have extractors, while `execution/file_documents.py:23-25` expressly refuses those formats. This is a workspace tool-path gap, not complete absence of XLSX/PPTX extraction in Homun. Direct probe confirms XLSX unavailable.

Hermes actually connects file edits to LSP (`.audit-hermes-ref/tools/file_operations_lint.py:207-269`).

### H12 — Partial; verified infrastructure subset

Approved workspace writes call checkpoint infrastructure (`application/workspace_file_edits.py:7`). Selective restore and diff pass direct helper tests. However `get_workspace_working_diff`, `plan_workspace_restore`, `restore_workspace_checkpoint` at `application/workspace_checkpoints.py:72,85,90` have no production callers. These functions exist and work in direct tests; missing usable engine restore/diff route is distinct from a UI gap.

Worktree create/cleanup is wired into delegation (`application/delegation_tools.py:93,110,120`). Upstream behavior anchors: `.audit-hermes-ref/tools/checkpoint_manager.py`, `tools/working_diff.py`, `tools/subagent_worktree.py`.

### H13 — Partial; verified RPC subset

Registered via `application/agent_tool_registry.py:95-100`; real child interpreter/RPC tests pass, including tool allowlist/budget/timeout.

Cancellation/process ownership gap: `application/code_execution_tool.py:123-140` blocks in `communicate`, kills only its direct process on timeout, supplies no cancellation callback/process group. Agent control only stops registered terminal jobs (`application/agent_control.py:114-126`). Child Python inherits host environment and can perform direct filesystem/network operations independently of RPC tool allowlist (`code_execution_tool.py:123-130`). This is a source-proven integration concern, not a claim that a malicious exploit was performed.

Upstream anchors: `.audit-hermes-ref/tools/code_execution_tool.py`, `tools/code_execution_rpc.py`, `tools/code_execution_env.py`.

### H14 — Partial; selected provider live calls external-blocked

Search/cache/rescue/public-page tests pass. Missing adapters cannot be solved with credentials: `execution/web_providers.py:194-198` returns unavailable for configured Perplexity/xAI. Direct probe with dummy Perplexity key confirms “credentials configured but live adapter not yet connected,” without making a request. Additional pinned upstream plugins (`keenable`, `openai_native`, `parallel`) have no equivalent adapter here. Brave/Tavily/Exa/Firecrawl/SearXNG implemented; their real services remain unverified.

Upstream catalog anchors: `.audit-hermes-ref/plugins/web/`, `tools/web_tools*.py`, `tools/web_result_cache.py`, `tools/x_search_tool.py`.

### H15 — Partial; real Chrome subset verified

Actual Chrome tests passed for public page, form, iframe, screenshot, dismissal, and owned-process cleanup. Dialog acceptance and console exist but are unwired: `execution/owned_browser.py:231,253` define helpers without product callers. Active v5 registry exposes only open/snapshot/type/click/press/close/screenshot (`application/browser_form_contracts.py:45-69`); contract explicitly promises dismissal, no acceptance (`:35-43`). These capabilities are implemented at helper level, absent from the model/tool path.

Missing scrolling, images/vision tools, general CDP, recording/profile resume. `execution/browser_sessions.py:1-4` explicitly says restart does not reattach. Hermes exposes scroll/console (`.audit-hermes-ref/tools/browser_tool.py:529,589`) and dialog acceptance (`tools/browser_dialog_tool.py:70,102`); real-profile support is in `tools/browser_tool_real_profile.py:125-189`.

### H16 — Partial; live OS interaction unverified

Mac/Linux bridges actually auto-attach (`application/computer_use_driver.py:67-94`), and desktop API owns a driver (`routes/desktop_api.py:17`). Not merely permissions: macOS scroll explicitly says “CGEvent bridge; not yet wired” (`computer_use_macos_bridge.py:331-336`); key support rejects multi-character names, discards modifiers and sends only final character (`:309-321`). Windows is explicit unavailable (`computer_use_windows_bridge.py:19-28`).

No computer tool is registered in `agent_tool_registry.py`; API exists but autonomous model-to-computer path absent. No OS input performed during audit. This does not mean computer support is wholly absent: native API bridges exist.

Upstream anchors: `.audit-hermes-ref/tools/computer_use/`, `tools/computer_use_tool.py`, `tools/desktop_ui.py`, `tools/read_window_tool.py`, `tools/drive_preview_tool.py`, `tools/project_tools.py`.

### H40 — Partial; verified safety primitives, concrete generic-ledger false completion

Existing terminal/workspace approvals and path protections are real. The following finding concerns the separate generic safety ledger, not those working gates.

Generic safety API invokes `gate.approve_and_execute(action_id)` without executor (`routes/safety_api.py:207-209`). Gate marks `executed=True` and returns `approved_and_executed` even without effect (`application/write_approval_gate.py:183-197`). No production consumer of that gate outside safety API. Thus `test_h40_safety.py` passing does not establish integrated approval execution. Vault/redaction helpers exist; end-to-end all-tool egress/redaction not verified. H13 direct Python effect path is a material integration concern.

Upstream anchors: `.audit-hermes-ref/tools/approval*.py`, `tools/write_approval.py`, `tools/path_security.py`, `tools/url_safety.py`, `agent/vault_store.py`, `agent/secret_scope.py`, `agent/redact.py`.

## Verification

Executed from `/Users/fabio/Projects/Homun/homun2`:

```sh
engine/.venv/bin/python -m pytest -q \
 engine/tests/test_pty_queries.py engine/tests/test_terminal_deadline.py \
 engine/tests/test_workspace_edits.py engine/tests/test_h12_product_wiring.py \
 engine/tests/test_code_execution.py engine/tests/test_h40_safety.py \
 engine/tests/test_h16_desktop.py engine/tests/test_owned_browser.py \
 engine/tests/test_web_pages.py engine/tests/test_h10_cloud_backends.py
```

Result: **77 passed in 24.21s**.

These mix direct real local execution, real Chrome against read-only `https://example.com/` with injected page fixtures, and mocked adapters. They establish the listed subsets, not full parity. Browser fixture tests exercise actual owned Chrome reading, script-injected form/iframe actions, PNG capture, native dialog dismissal and sibling-process preservation. Model-turn input is stubbed where used. No paid services or external mutations invoked.

Safe direct probes:

```python
from homun.execution.file_syntax import delta
from homun.execution.file_documents import extract
from homun.execution.pty_queries import PtyQueryResponder
from homun.application.browser_form_contracts import entries
from homun.execution.web_providers import execute_provider_search
import os
print(delta('a.ts', '', 'const x: ='))
print(extract('a.xlsx', b''))
print(PtyQueryResponder().process(b'\x1b[12;34H\x1b[6n')))
print([e.definition.name for e in entries(lambda *a: None, 5)])
os.environ['PERPLEXITY_API_KEY'] = 'audit-placeholder-no-network'
print(execute_provider_search('perplexity', 'test'))
```

Outputs:

```text
typescript: lsp=unavailable, checked=False; TS diagnostics not available
xlsx: status=unavailable; extraction not available in this workspace read
cursor: (b'\x1b[12;34H', b'\x1b[1;1R')
browser_v5: browser_open, browser_snapshot, browser_type, browser_click,
            browser_press, browser_close, browser_screenshot
perplexity: web_provider_unavailable;
            Provider 'perplexity' is configured with credentials but live adapter is not yet connected.
```

Negative production-call-site findings were checked with repository-wide `rg` under `engine/src/homun`, not inferred from matrix labels. Final `git status --short` was empty.


---

# Bounded engine parity audit H17-H31, 2026-09-27

Audited current Homun tree supplied as 39a485fd against local pinned Hermes `.audit-hermes-ref` c9dca726514b709cf6e677d236a79fc8d0627f37. No repository changes or external effects. Frontend ignored. All local paths below relative to repository. Upstream paths prefixed `.audit-hermes-ref/`. Classifications mean coverage of the WHOLE matrix row, not whether some implementation exists. These are current source inspections plus focused local tests, not real-provider certification.

## Executive findings

The matrix's `verified` labels materially overstate H21/H22 and H25-H29. Synchronous single-completion delegation announces background launch only after completion; goals are persisted but never judged/continued by the real run loop; heartbeat scanning is not called; recurring loops only inject into an already running turn; cron prompt jobs are marked successful when merely staged for approval. Cron event jobs are eligible without an event and cron claims do not reserve anything. These are local implementation gaps, not missing credentials.

Supervised approval for cron proposals is a valid Homun choice. The error is recording an execution `success` and consuming repeat counts before approval/execution, not requiring approval itself.

## Per-ID bounded assessment

### H17 — PARTIAL, local missing behavior

Strength: `memory_tools.py` actually recalls/adds facts through the configured memory port; capacity, deduplication and authorized conversation/date filtering exist. Tests pass. However agent tool surface is recall/remember/session_search only (`engine/src/homun/application/memory_tools.py:31-139`); session search truncates to 200-character excerpts and limits the newest matches without paging (`:125-137`). No automatic background review/learning graph callsites found under engine/src. Upstream `agent/background_review.py:1`, `:1328-1364` has post-turn review threading/settings; this is an additional capability not established by a persistent fact ledger. Do not classify the whole memory/learning row verified. Human approvals in other memory routes were not exhaustively re-audited.

### H18 — PARTIAL / external integration UNVERIFIED

Strength: SQLite authority plus optional dual-write is real (`engine/src/homun/memory/mem0_port.py:302-310`), and missing keys are rejected. But all three external clients inherit identical generic `/memories` and `/memories/search` payloads (`external_vector_backends.py:66-116`), rather than demonstrably conforming provider adapters. Compare upstream Supermemory plugin `plugins/memory/supermemory/__init__.py:180-231` which uses SDK profile/search/memories semantics and container tags. No live provider call was made, so do NOT conclude that obtaining credentials alone completes this row. Context planner is directly imported/called (`application/agent_context.py:7,48`); replaceable context-plugin parity remains unproved.

### H19 — PARTIAL, local missing linked-resource/platform behavior

Strength: discovery, full markdown body, approved-only viewing, quarantine are real (`application/skill_tools.py:21-86`). Domain Skill is only markdown metadata/body/status/revision (`domain/models.py:271-284`); skill_view returns this body and has no linked-file argument/resource loading. Upstream `tools/skills_tool.py:573-639` implements `file_path` access and linked-files inventory, and `:152-168,207` applies activation/platform rules. Homun does not meet the row's linked-script/full-resource requirement through its skill interface.

### H20 — PARTIAL, local missing hub/curator/revert behavior

Strength: staged proposals, domain CRUD/revisions and checksum bundle installation exist (`application/skill_tools.py:88-133`, `application/skill_bundle.py:23,65,90`). Search found no skill-hub update/sync or curator scheduler/rollback implementation under engine/src. Upstream `agent/curator.py:5-6,139` defines scheduled pin/archive/consolidate/patch behavior and recoverable archive invariants. Existing CRUD/bundles should be credited; broader hub/curator parity should not.

### H21 — NOT PARITY, synchronous text completion instead of delegated agent

`application/delegation_tools.py:98-104` makes exactly one blocking `ctx.models.complete` call with two text messages. `tools_include` is a prompt string/record only; `max_turns` is capped/recorded but never drives an execution loop (`:57-80,127-129`); `turns_used` is always 1. No tools passed, no delegated native agent tool loop, no images/project context forwarding. Optional worktree creation at `:89-95` silently falls back on failure and is not passed as child execution cwd. Schema fence stripping is real but is not model-guided bounded schema repair.

Upstream `tools/delegate_tool.py:400-404,442-532,720-745` supports child agents, image forwarding and asynchronous dispatch; `:694` explicitly notes top-level model delegations are always background. Tools / tool limits cannot be certified by prompt text alone.

### H22 — NOT PARITY, false background admission and no in-flight durable child

Delegation result is completed and stored only after blocking model completion (`delegation_tools.py:122-135`), then `run_in_background` returns status `running` and message “launched in background” (`:137-142`). Cancel merely changes the already-created record; there is no owned running child to stop. Parent runtime copies `_delegations` after the tool returns (`agent_run_execution.py:338-339`), so no durable admitted work record exists before child execution. A crash between provider execution and parent commit has no child completion recovery path.

Upstream `tools/async_delegation.py:135-160,188-198,228-281` persists dispatch, completion and abandoned ownership; `:281-305` restores undelivered completions. Homun's persisted completed dictionary is a useful history, not equivalent admission/delivery machinery.

### H23 — PARTIAL, durable board workflow but not demonstrated autonomous worker orchestration

Strength: SQLite board/cards, dependency/review mutations, manual heartbeat/recovery endpoints exist. `kanban_store.py:248-261` claim is get/check/update without one transaction spanning eligibility and write: concurrent callers can both see ready. `recover_crashed_workers` is invoked only by REST endpoint (`routes/kanban_api.py:172`), not the runtime pump, so “automatic crashed worker recovery” is overstated. Worker identity/lease bookkeeping is not evidence of actual subprocess/agent dispatch.

Upstream `hermes_cli/kanban_db_dispatch.py:362-387,443,565` has live worker identity and safe reclaim/termination checks; that execution/ownership machinery is beyond local board CRUD. No concurrency stress test was run, so the read/check/write race is source-based, not a demonstrated double claim.

### H24 — PARTIAL, runtime MoA exists but cadence/cache and trace privacy incomplete

Strength: native run calls actual advisor completion without tools and aggregator with tools (`agent_run_execution.py:153-166`), combines usage. But coordinator is put only on the per-turn snapshot (`:144-151`); `_claim` creates that snapshot with `deepcopy(run)` (`:87`), and completion persistence copies selected state, not `_moa_coordinator`. Search found no other persistence/callsite for coordinator. Each subsequent turn therefore reconstructs it without cached guidance; user_turn/every_n steps that skip advisors lose their cached guidance entirely. `moa_contracts.py:132-152` accepts has_cached_guidance but ignores it, choosing only by iteration index.

Trace writes raw `advisor_outputs` via `a.to_dict()` (`moa_coordinator.py:179-184`) even when privacy_filter full/display is configured; guidance redaction at `moa_contracts.py:167-168` does not redact those records. Compare upstream `agent/moa_loop.py:98-112` redacted trace accounting. Also advisors are called serially (`moa_coordinator.py:103`) versus upstream ThreadPoolExecutor (`agent/moa_loop.py:583`). No live provider test performed.

### H25 — PARTIAL, durable goal model not connected to judging/continuation runtime

Goal tools/store and substantial GoalManager logic exist. Yet repository-wide search finds `evaluate_after_turn` only as the definition (`goal_manager.py:503`), never in runtime. Agent finish always submits artifact and sets completed (`agent_run_execution.py:366-370`) without goal evaluation/continuation. Additionally goals tools key the manager by work_id (`goal_tools.py:20-21`) whereas automation defaults to run_id (`automation_dispatch.py:17-19,62`), so goal precedence in loop injection does not see ordinary goal-tool state.

Upstream `gateway/run_goals.py:297` calls evaluate_after_turn; `hermes_cli/cli_loops_mixin.py:522` resumes lifted wait barriers from idle. Missing local integration does not depend on credentials.

### H26 — PARTIAL, persisted heartbeat/claim mechanics but no idle wake scanner

Heartbeat manager/store and coalescing exist. `find_due_heartbeats` (`heartbeat_manager.py:258`) has no production callsites. Runtime pump (`lifecycle.py:43-68`) drives pending deliveries, routine sync and cron, not heartbeat watches. Injection is only inside `_claim` for queued/running agent runs (`agent_run_execution.py:45,76-83`); completed idle conversations cannot wake. Upstream `gateway/run_heartbeat_restore.py:22-79` restores watches and `hermes_cli/cli_loops_mixin.py:489-519` runs heartbeat watchdog. Unit tests of due state do not establish same-session autonomous heartbeat parity.

### H27 — PARTIAL, loop state/tick helpers but no autonomous recurring run

Same on-claim-only injection issue as H26; finish marks parent run completed and only calls `complete_tick` (`agent_run_execution.py:370-377`). No scheduler resumes/reopens completed run for the next loop due time. Goal-key mismatch described in H25 also breaks precedence for tool-created goals. Upstream `hermes_cli/cli_loops_mixin.py:550-562` idle hook fires due loop ticks while considering goal state. Bounded manager tests pass but don't cover real idle run recurrence.

### H28 — PARTIAL with high-confidence false-success/event bug

Scripts genuinely execute with cwd; SQLite history and parsing/chained text exist. Prompt runner creates a project/conversation/work and proposal then returns exit code 0 describing `pending_approval` (`cron_agent_runner.py:86-103`). `cron_manager.py:540-577` consequently records success, increments run_count and can complete one-shot/repeat-limited jobs. It ignores skills/workdir/provider pin in the staged run; only model pin is copied (`cron_agent_runner.py:90-91`). Supervised staging is appropriate, but must be represented as awaiting approval, not successfully executed.

Event jobs are ALWAYS eligible in timer polling because `claim_job_for_fire` skips due-time check for schedule_kind event (`cron_manager.py:451-459`). Actual in-memory probe demonstrated eligibility absent an event. With lifecycle polling every 0.5s, these can repeatedly create pending proposals without a webhook. Upstream event/scheduled occurrence machinery in `cron/occurrences.py:57-100` retains occurrence identity/ownership rather than treating events as unconditional timer jobs.

### H29 — PARTIAL, missing claim ownership and delivery drain

Claim method is only a read (`cron_manager.py:451-459`): no running flag, atomic compare/update, ownership or lease. Probe claimed same due interval twice successfully. Concurrent REST fire-due and runtime pump can therefore overlap the same job. Durable deliveries are append/list only (`cron_store.py:195-215`, `cron_manager.py:579-586`); production search found no consumer, acknowledgement, transport dispatch or delivery failure/retry path. `trigger_quota_hold` has no production caller. Chronos optional configuration refusal is honest, but says nothing about these local gaps.

Upstream `cron/occurrences.py:57-100` implements pending occurrence owner recovery, and `cron/delivery_queue.py:226-245,279,315-322` provides atomic claim/recovery/drain. This row cannot be described as blocked only on Chronos credentials.

### H30 — PARTIAL / isolated session subsystem

Strength: durable create/fork/rewind/import/export functions exist and tested. But tools instantiate an independent SessionManager namespace based on work_id (`session_tools.py:19`); actual engine turns never call its add_message/record_usage (only methods/import code use those storage methods). Resume only updates timestamps and returns `restored_cwd` (`session_manager.py:174-191`), not agent continuation nor execution cwd update. These session records do not represent the active engine conversation transcript automatically.

Upstream `hermes_state_rewind.py:45-113` rewinds actual durable transcript row identity, including compaction handoff. Generic independent SessionStorage tests do not prove existing engine conversations can resume/fork/rewind faithfully.

### H31 — PARTIAL with demonstrated workspace isolation defect in session API

WAL, FTS triggers, integrity and repair helpers are real in SessionStorage. But SessionManager.get_session simply returns storage lookup by id (`session_manager.py:120-121`); workspace scoped list does not secure direct get/resume/update/export paths. Actual in-memory probe: manager B fetched and resumed a session created by manager A, returning workspace A. Tools expose this same manager without a separate ownership check (`session_tools.py:19,34-42,76-85`). This is an internal API isolation defect; whether an untrusted remote caller can obtain IDs requires route threat-path analysis, not assumed here.

Independent session accounting is also not fed actual engine model usage. Repair adopts all orphan sessions under literal default workspace (`session_storage.py:449-460`), not original profile provenance. Upstream `hermes_state_sessions.py:199-216` explicitly fences profile inheritance. Main Homun repository persistence is separate; this finding does not assert all engine storage lacks WAL or accounting.

## Executed validation

Command from repo root:

```
engine/.venv/bin/python -m pytest engine/tests/test_delegation_tools.py engine/tests/test_goals_and_contracts.py engine/tests/test_heartbeat_manager.py engine/tests/test_loop_manager.py engine/tests/test_cron_dispatcher_and_chronos.py engine/tests/test_sessions_and_storage.py engine/tests/test_skill_tools.py engine/tests/test_memory_tools.py engine/tests/test_h23_kanban.py engine/tests/test_moa.py -q
```

Result: **59 passed in 2.25s**. These focused tests are mostly manager/helper/mock-provider tests. In particular `test_delegation_background_poll_and_cancel` explicitly expects “running” return followed by completed poll despite synchronous stub completion. Green tests preserve the false admission semantics rather than refuting this finding.

Actual safe in-memory probe:

```python
from homun.application.cron_manager import CronManager
from homun.application.cron_store import CronStore
m = CronManager('audit', store=CronStore(':memory:'))
e = m.create_job('on event:build_completed', prompt='event only', now=1000)
i = m.create_job('every 1m', prompt='interval', now=1000)
print(m.claim_job_for_fire(e.id, now=1000) is not None)
print([m.claim_job_for_fire(i.id, now=2000) is not None for _ in range(2)])
from homun.application.session_manager import SessionManager
from homun.application.session_storage import SessionStorage
s = SessionStorage(':memory:')
a, b = SessionManager('A', storage=s), SessionManager('B', storage=s)
sid = a.create_session(cwd='/tmp', title='private A').id
print(b.get_session(sid).title)
print(b.resume_session(sid)['session']['workspace_id'])
```

Observed: `True`; `[True, True]`; `private A`; `A`.

No external memory/model/Chronos request, no production cron script, no real child process and no deployment performed. Current git status remained clean after inspection/tests. Memory quick lookup had no relevant registry matches and no memory facts were used.


---

# Read-only engine integration audit 2026-09-27

Scope H32-H39, H41-H46; Homun working tree at supplied 39a485fd; Hermes pinned c9dca726514b709cf6e677d236a79fc8d0627f37 in `.audit-hermes-ref`. No UI requirement used. All local paths below are relative to repo, and A = `engine/src/homun/application/`, R = `engine/src/homun/routes/`, U = `.audit-hermes-ref/`. Every row is **partial**, not row-wide verified: usable pieces coexist with confirmed missing wiring/semantics. No external service actions were performed.

| ID | Evidence-based assessment |
|---|---|
| H32 | **Partial; local runtime gaps.** Durable pairing/rooms and in-process lease/routing primitives exist. `A/channel_adapters.py:724-777` parses, authorizes, leases, calls an injected handler, sends. `rg dispatch_inbound engine/src/homun` finds only its definition: production ingress does not call this path. It is not a functioning autonomous channel receiver with durable input/completion queues, media streaming and restart recovery. Upstream Telegram actually connects and starts polling: `U/plugins/platforms/telegram/adapter.py:3169-3249`. |
| H33 | **Partial; not credentials-only.** Outbound HTTP adapters and inbound payload parsers exist for a broad named catalog. No runtime listener/receiver wiring found to dispatch_inbound. Telegram `A/channel_adapters.py:113-123` always builds sendMessage text JSON; its media argument is only copied into result metadata, never uploaded. Thus even valid credentials cannot satisfy receive/media/reconnect parity. Upstream has polling/reconnect above and `send_document` at `U/plugins/platforms/telegram/adapter.py:5364`. Positive live sends remain unverified, separately from these local gaps. |
| H34 | **Partial.** Surface session/steering/approval state is available, including durable records; connection registration is metadata only (`A/surface_gateway_manager.py:153-175` stores transport/endpoint in dictionary, no SSH/cloud connection attempt). Full multi-transport runtime parity cannot be inferred from enum values. This finding does not require a particular UI. Upstream implementation roots remain `U/tui_gateway/`, `U/hermes_cli/`, `U/apps/desktop/`; no per-surface runtime fixture executed in this audit. |
| H35 | **Partial with synthetic ACP.** OpenAI-compatible endpoint uses real ModelsPort but completes the whole model call before emitting SSE (`R/openai_api.py:133-165`); this is response chunk formatting, not evidence of streamed tool-driven durable runs. HostedMcpEngineRunner has real stage/run/status bridge (`A/hosted_mcp_runner.py:41-126`). ACP prompt merely sleeps then returns `Homun completed: {text}` (`A/acp_adapter.py:125-157`) with no engine execution. Upstream `U/acp_adapter/server.py:747-868` invokes agent.run_conversation in executor. |
| H36 | **Partial.** Native MCP discovery/tools/resources/prompts and SDK transports exist; app installs sampling callback (`engine/src/homun/app.py:38-49`). Elicitation setter has no production caller (`A/mcp_client.py:41-44`); sessions use default refusal at lines 193-194 and refusal text at 57-63. OAuth broker supports supplied/client-credentials/refresh tokens (`A/mcp_oauth.py:68-198`) but no interactive browser authorization-code PKCE/discovery/persistent token lifecycle comparable to `U/tools/mcp_oauth.py:2-9`. Some configured credential grants may work; elicitation and interactive auth need local implementation, not just credentials. mTLS/resources not live-certified by this audit. |
| H37 | **Partial.** Manifest/lifecycle/registration ledger and plugin tool insertion exist (`A/plugin_manager.py:35-144`; `A/agent_tool_registry.py:101-106`). However provider/platform registrations are stored in private dictionaries only (`A/plugin_manager.py:83-101`), and no production `pre_tool_call` hook caller appears outside the manager itself. `rg get_provider/get_platform/dispatch_hook` finds lifecycle hooks and registry code, not execution policy enforcement. Therefore a tested hook dispatcher or registration ledger does not prove providers/platforms/hooks participate in real engine execution. Upstream comparison scope `U/plugins/plugin_loader.py` plus agent provider/registry modules; full upstream-hook trace not completed. |
| H38 | **Partial.** Seven declarative provider profiles and standalone credential pool/aux router exist. Main ModelsRegistry builds FakeProvider and OpenAICompatibleProvider (`engine/src/homun/models/registry.py:79-90`); connection support extends this later, but new application ProviderRegistry/credential-pool/auxiliary router are not referenced by model registry/agent execution. Search `get_auxiliary_router` finds only its own definition; profile adaptation is called by provider_api and auxiliary_router, not real model port. Catalog/schema fixtures do not establish native Anthropic/Gemini/Bedrock/Vertex/auth flows. Upstream `U/plugins/model-providers/` contains 42 named directories per matrix inventory, plus `U/agent/transports/` native transports. OpenAI-compatible configured providers may be usable; full provider protocol/catalog integration remains local work. |
| H39 | **Partial with confirmed false successes.** Codex adapter only replays supplied event_feed; absent feed it synthesizes success (`A/codex_runtime.py:123-146`). A nonexistent command still succeeds, so no credentials could repair the absent process transport. Relay configured endpoint path similarly returns `{'status':'relayed','data':payload}` without request (`A/relay_runtime.py:94-106`). Copilot ACP has actual stdio transport and three fixture-process tests passed; live Copilot not exercised. Upstream `U/agent/codex_runtime.py:627` explicitly runs app-server subprocess (class workflow starts there). Managed gateway not live-certified. |
| H41 | **Partial; substantive local gaps.** Real Ollama vision and macOS say resolvers exist (`A/media_backends.py:85-206`), but image generation/edit/video/STT routes call coordinators without a backend_dispatcher (`R/media_api.py:98-169`), guaranteeing unavailability irrespective of credentials. STT requires an injected dispatcher (`A/media_stt.py:75-84`). TTS stream_speech_chunks splits text only (`A/media_tts.py:113` onwards). Voice is transcript substring matching plus state transitions, no audio capture/STT/playback cancellation binding (`A/media_voice_mode.py:26-97`). Upstream voice captures sounddevice audio and transcribes/plays (`U/tools/voice_mode.py:3-4,45-46`), plus streaming modules. No microphone or paid provider called. |
| H42 | **Partial with confirmed false delivery/dedup.** Extractor/ledger/dispatcher and gateway send integration exist. Failed outbound sends are recorded by dispatcher (`A/deliverable_dispatcher.py:101-120`) with metadata.status='failed', but ledger hardcodes receipt.status='delivered' and inserts dedup index (`A/deliverable_ledger.py:115-152`). Repeating the failed delivery suppresses the attachment as already delivered. Even positive Telegram text response can misreport attachment delivery because upload is absent (H33). Upstream `U/gateway/delivery.py:165,251` has actual platform delivery, Telegram send_document at :5364. Independent workspace output delivery is outside this assigned row probe and may be sound. |
| H43 | **Partial.** Some HTTP integrations exist, but Google Meet requires injected browser_backend and production default has none (`A/integration_meetings.py:84-117`); Yuanbao groups/members require injected providers (`A/integration_yuanbao.py:38-73`). These are explicit honest errors, not credentials-only ready backends. Full Discord/Feishu/HomeAssistant/Spotify/meeting live fixture not run; don't generalize missing Meet implementation to all integrations. Upstream anchors `U/plugins/google_meet/`, `U/tools/yuanbao_tools.py`, `U/tools/feishu_doc_tool.py`. |
| H44 | **Partial.** Profile/config/doctor/PID management present. Daemon restart only calls stop and returns ready_for_start=True; it does not restart service (`A/daemon_lifecycle.py:123-132`). Upstream gateway lifecycle includes run/start/stop/restart/install/uninstall (`U/hermes_cli/gateway.py:3`) and service-manager new PID expectation (:142). Cross-platform packaging, clean setup/import isolation and updater parity unverified. No daemon stop/restart called. |
| H45 | **Partial; engine executor absent from public batch route.** Batch runner supports injected task executor/concurrency/checkpoints but rejects missing executor (`A/batch_eval_runner.py:71-82`). Route constructs it without executor (`R/research_api.py:35`) and calls run_batch unchanged (:110-118), so default batch endpoint cannot evaluate any dataset. Trajectory record and observability APIs are manually fed; no references from agent* production source found. Upstream `U/batch_runner.py:247` instantiates real AIAgent. Serialization/compression helper tests passing is not integrated evaluation evidence. |
| H46 | **Partial; catalog definitively incomplete.** Companion/achievement/tour/cleanup helpers exist but full behavior not certified. Claimed complete shipped catalog is actually 3 hardcoded packs with 4 one-sentence skills (`A/surface_catalog_packs.py:33-86`); installation writes those short markdown bodies (:120-140). Not equivalent to upstream bundled/optional skills and catalog scripts/assets; representative upstream PDF skill includes real operational instructions/scripts (`U/skills/productivity/pdf/SKILL.md:89`). No reason to label entire catalog verified. |

## Current safe checks

1. `PYTHONDONTWRITEBYTECODE=1 engine/.venv/bin/python -m pytest -q -p no:cacheprovider engine/tests/test_h39_acp_stdio.py engine/tests/test_mcp_oauth.py engine/tests/test_mcp_sampling.py engine/tests/test_h45_research.py engine/tests/test_h41_media.py` → **23 passed in 3.80s**. These are fixture/helper/unit checks, not whole-row certification; ACP fixture runs actual local stdio child. No external service actions.
2. Inline Python probe with TemporaryDirectory outside repo, imports only application helpers:
   - `CodexAppServerAdapter(command='/nonexistent').run_turn([user probe])` → `[Codex App-Server]: Handled 'probe'`.
   - `RelayRuntime(endpoint_url='http://127.0.0.1:1',enabled=True).execute_operation('probe',{})` → success=True, relayed data, without connecting.
   - `BatchEvalRunner(temp/'batch').run_batch([])` → ValueError requiring explicit task_executor.
   - Two deliverable dispatches using base ChannelAdapter (which always refuses transport): first receipt status delivered / metadata failed; second new=[] / already=['/private/tmp/audit-report.pdf']. Temporary ledger only; no external sends. macOS resolves /tmp to /private/tmp, so compare normalized path.
   - Builtin packs count=3; skill count=4.
3. Production-source references traced using rg. Absence statements are scoped to inspected engine/src/homun, not claims that similarly named helpers don't exist anywhere.

No repository source files edited by this agent. Report saved outside repo at user-directed /tmp path. No memory used for conclusions.
