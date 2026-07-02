# Stato — Homun (documento vivo)

> Aggiornato a OGNI sessione (vedi [METHODOLOGY.md](METHODOLOGY.md) §6). Resta **conciso**: è
> uno *stato*, non un changelog (lo storico va in `archive/`). Da qui si riparte dopo una
> compattazione o a inizio sessione.
> **Ultimo aggiornamento: 2026-07-01.**

## Dove siamo

- **DECISIONE D'ARCHITETTURA (ADR 0021, 2026-06-29):** convergere su **UN loop guardato** (motore #1,
  ReAct + native tool-calling), piano come *tool*, NON un secondo motore plan-execute. Supersede la
  direzione 0020, emenda 0016. Browse instradato a motore #1 (`plan_is_browse_only`). Basata su 3 cluster
  di ricerca + prova empirica. Vedi [decisions/0021](decisions/0021-single-guarded-loop-planning-as-tool.md)
  e [[homun-single-loop-evidence-verdict]].
- **MEMORIA FLUIDA — ADR 0022, Tappa 1 completata (2026-07-01):** introdotto il trait
  `MemoryRecallService` (`brief`/`recall`/`learn`) in `crates/memory/src/service.rs` con tipi
  contratto tipizzati (`BriefingPack`/`RecallPack`/`Exchange`). Impl `InProcessMemoryRecallService`
  nel gateway che **delega** alle funzioni esistenti (zero behaviour change). Instradamento dietro
  feature flag `HOMUN_MEMORY_SERVICE` (default OFF). Parità verificata: ordine canonico dei blocchi,
  shape snella `brief(Personal)` (invariant P1), object-safety (`Arc<dyn>`). **Frontend:** payload di
  `ChatEventPart` tipizzati (B2) + nuovo type `recall` (A1, non ancora renderizzato — A2/A3 next).
  **Invariants rispettati:** cross-chat solo progetti; isolamento Personale↔Progetto preservato;
  briefing sempre always-on; nessuna funzione migrata nel crate (quello è Tappa 4). **Resta:**
  Tappa 1.5 (cache briefing), 2 (pool/WAL), 3 (recall on-demand via tool), 4 (migrazione monolite) +
  UI A2 (fase recalling), A3 (memory badge), A5 (Project context panel), A4 (MemoryView al nav).
  Vedi [roadmap](roadmap-fluidita-memoria.md), [ADR 0022](decisions/0022-memory-as-out-of-path-service.md),
  [kickoff](../prompts/kickoff-memory-service.md).
- **MEMORIA FLUIDA — ADR 0022, Tappa 1.5 completata (2026-07-01):** cache/snapshot del briefing
  always-on, per renderlo fluido senza spostarlo off-path. Turni consecutivi nella stessa chat
  pagano ~zero (cache hit); nuova chat o turno dopo una scrittura paga un rebuild. **Invalidazione
  via generation counter** nel `MemoryFacade` (crate memoria): ogni scrittura mutante
  (`upsert_memory`/`create_memory_candidate`/`confirm_memory`/`merge_memories`/`delete_memory`/
  wiki/project) incrementa la generation dello scope; la cache del briefing hit solo se generation
  AND `prompt_fingerprint` (i blocchi profile/open-loops sono prompt-dipendenti) combaciano.
  Copre automaticamente tutti i ~25 call site del gateway senza toccarli. **`recent_work_block`
  escluso dalla cache** (dipende da git log, non memoria → ricalcolato fresco ogni `brief()`).
  Cache process-global via `OnceLock` + `BriefingCache` (bounded, `HOMUN_BRIEFING_CACHE_MAX`).
  Dietro lo stesso flag `HOMUN_MEMORY_SERVICE`. **Parità Tappa 1 preservata** (la cache non cambia
  output, solo costo) + test cache hit/miss/eviction/invalidazione. **Resta:** 2 (pool/WAL), 3
  (recall on-demand), 4 (migrazione monolite) + UI A2/A3/A5/A4.
- **MEMORIA FLUIDA — ADR 0022, Tappa 2 completata (2026-07-01):** pool reader/writer WAL nello store,
  per rimuovere la serializzazione globale `Mutex<MemoryFacade>` → `Connection`. In WAL mode i read
  concorrenti non bloccano il writer, e consolidation/backfill in background non bloccano più il
  recall del turno. **Pool custom interno** (nessuna nuova dipendenza): `SQLiteMemoryStore` detiene
  `Connections` enum — `Single(Mutex<Connection>)` (legacy, flag OFF, invariato) o `Pooled`
  (writer `Mutex<Connection>` + N reader round-robin, WAL mode, flag ON). Trasparente a
  facade/gateway (stessa API `&self`). ~40 metodi migrati a `read_conn()`/`write_conn()`; gli ibridi
  (`import_graphify_batch`, `init`, `upsert_memory`+FTS) hanno varianti `*_on(&Connection)` per
  evitare re-entrancy/deadlock. **Bug trovato e fixato dai test:** `is_tombstoned` re-lockava il
  Mutex Single quando chiamato da metodi che già tenevano il guard → deadlock; fix con
  `is_tombstoned_on`. Dietro flag `HOMUN_MEMORY_POOL` (default OFF), ortogonale a `HOMUN_MEMORY_SERVICE`.
  **Test:** parità single-vs-pool (read/FTS), concorrenza WAL (4 reader + 1 writer, stato coerente),
  `import_graphify_batch` in pool, embeddings roundtrip — tutti verdi. WAL richiede DB su disco
  (in-memory cada su Single per i test). **Resta:** 3 (recall on-demand), 4 (migrazione monolite) + UI.
- **MEMORIA FLUIDA — ADR 0022, Tappa 4 (recall+learn) completata (2026-07-01):** l'orchestrazione
  memoria **migrata dal monolite nel crate**. `recall` e `learn` (i due metodi core del trait
  `MemoryRecallService`) ora vivono in `crates/memory/` (`recall.rs` + `learn.rs`) e sono orchestrate
  — non più delegate al gateway. `main.rs` conserva solo le chiamate `service.recall()`/`brief()`/
  `learn()`; ~609 righe di orchestration rimosse dal monolite (relevant_memory_for_prompt +
  learn_from_exchange cancellate; entrambi i flag path ON e OFF usano ora le fn del crate).
  **Capability trait** (`EmbeddingClient`, `LlmClient`) nel crate: il crate resta puro (no reqwest/
  tokio), il gateway impl i trait (HTTP embedding + LLM estrattore). Pattern = `MemoryVectorIndex`.
  **Scope autoritativo**: `recall(query, scope)` usa l'argomento scope, non più la globale gateway
  (chiude il debito "isolation-by-construction" della Tappa 1). **Send-safe**: 3 fasi (sync lock →
  capability await off-lock → sync re-lock) così il MutexGuard non attraversa l'await. **Testabile in
  isolation**: recall/learn testabili con mock embedding/LLM deterministici (32 test crate, incluso
  recall che trova una decisione via FTS su facade in-memory, no HTTP). Parità preservata (brief/cache
  gateway test verdi). **Smoke runtime ON** pulito. **Tappa 4 COMPLETATA (final):** consolidate
  (`consolidate_scope`, LLM curatore + wiki rebuild, 3 fasi Send-safe) e backfill (`backfill_embeddings`,
  3 fasi) migrati nel crate (`consolidate.rs` + `embedding.rs`). Wiki rebuilder
  (`rebuild_decisions/status/project_brief`) + `deduplicate_open_loops` pure-facade nel crate.
  **Tutta l'orchestrazione memoria è ora nel crate** (recall+learn+consolidate+backfill):
  `main.rs` conserva solo chiamate/wrapper; ~600 righe di corpi spostate. 34 test crate + parità
  gateway verdi. Smoke tutti-flag-ON pulito. **Resta:** pulizia residua (fn gateway morte nei test,
  follow-up meccanico) + Tappa 3 (recall on-demand via tool) + UI A2/A3/A5/A4.
- **MEMORIA VISIBILE — Piano UI A2/A3/A4 + U1 completati (2026-07-01):** la memoria è ora
  VISIBILE end-to-end (differenziatore P3). **U1 (backend):** nuovo evento stream `Recall`
  strutturato (variante `GenerateStreamEvent::Recall` + `RecallStreamPayload`{query,hits,score,scope}),
  emesso quando il tool `recall_memory` gira — il modello riceve la stringa, la UI riceve i dati.
  `recall_memory` ritorna `RecallOutcome { response, hits, scope }`. **A2 (fase recalling):** nuova
  fase `recalling` in `ChatStreamPhase` + "Sto controllando la memoria…" / "Checking memory…" con
  count hits, mostrata live quando arriva l'evento. **A3 (memory badge):** badge "📝 Ha richiamato N
  ricordi" nel footer del messaggio assistant, derivato dalle `eventParts` recall (hover = testi).
  **A4 (MemoryView al nav):** MemoryView (440 righe) ora ha voce di nav top-level (oltre a
  Impostazioni). i18n en+it. Typecheck pulito. Smoke ON pulito + evento `recall` verificato nello
  stream. **Resta:** A5 (Project context panel, solo progetti) + pulizia residua.
- **PIANO UI COMPLETATO (2026-07-01):** tutte le priorità A/B/C/D del piano UI sono fatte.
  **A5 (Project context panel ⭐):** nuovo endpoint `/api/memory/project-briefing` + provenance
  cross-chat (thread_id stampato sui record durevoli in learn) + `ProjectContextPanel` (collapsible,
  objective/brief/open-loops/decisions con "appreso in un'altra chat", solo progetti). **B1/B3
  (marker consolidation):** 31 regex in `lib/markers.ts` unico + `RichMessage` consuma `eventParts`
  (structured primary, regex fallback). **C1/C2/C4 (jank ⭐):** memo separation (`conversationArtifacts`
  ecc. dipendono da messaggi persisted, non streaming — il vero cut su thread lunghi) + `AssistantMessageBody`
  in `React.memo` (i messaggi finalizzati NON re-renderizzano durante lo stream altrui). **C3** confermato
  (no virtualizzazione message list). **D1 (activity signal):** verb-tense + timer elapsed + detail/count.
  **D2** confermato (approval inline card, già fatto). **D3 (DiffPart):** nuovo event type `diff` + marker
  `‹‹DIFF››` + `DiffCard` inline (DiffView old-vs-new). **C5 (WebSocket) differito** (HTTP NDJSON funziona,
  WS è dead code; follow-up). 6 commit, tsc + cargo check verdi ad ogni step.
- **Linea pratica corrente (sessione 5g):** batch di fix chat-UX/funzionali nell'app reale (dettagli nel
  rolling in fondo) — risolti "bloccato" (self-heal CDP motore #1), "continua"/autonomia, reasoning
  collassato, isola live+persistente, F1/F2/planner; **form-fill `kind=fill`** (contratto schema-piatto↔
  sidecar, `a62cfba9`); **#5/#3 UI** verificati GIÀ FATTI; **F4 loop ripresa-piano** (guard cross-turno +
  settled-termination + blocked-sticky, gated `HOMUN_PLAN_STALL_ABORT`, `cfd270c9`); **F3-deep risposta
  vuota** (body-vuoto/solo-reasoning → sintesi forzata, `7fddd545`); **bug "Continue"** (validato live,
  2 cause): backend = trace `‹‹REASONING››` rientrava nel contesto modello (`strip_display_markers`,
  `df65d0b0`) + frontend = auto-continue su risposta completa (`isLikelyIncompleteMessage`, `f31e3f48`).
  **Validazione live (gateway dev riavviato col codice nuovo):** puzzle Einstein ora 1 sola risposta pulita
  (1 blocco reasoning, 0 frasi "il testo è già completo"). **Validazioni 2026-06-29:** form-fill OK su
  form pubblico Selenium (`browser-step[done]: fill`, valore `Fabio Test` nello snapshot); F3-deep OK con
  override debug `HOMUN_DEBUG_MAIN_LOOP_MAX_TOKENS=1` → log `[answer] empty answer body (finish_reason=stop)
  → forced synthesis` e risposta finale prodotta dalla sintesi. **F4 NON promosso:** il tentativo live con
  URL `.invalid` non ha raggiunto il log F4; ha invece esposto contaminazione/sostituzione del runtime-plan
  ripreso con un piano non correlato da memoria/recall. Tenere `HOMUN_PLAN_STALL_ABORT` gated finché
  l'identità/perimetro del piano ripreso non è chiusa. **Follow-up live 16:20:** piano `.invalid` consegnato
  ma UI rimasta 1/2 perché lo step finale era ancora `doing` nello store; F2.2 promosso default-on
  (`HOMUN_PLAN_RECONCILE=0/off` resta opt-out). Browser research: per news/ricerche aperte il prompt ora
  impone discovery-first (search/news discovery) prima di scegliere le fonti, evitando il salto diretto a
  una singola testata tipo ANSA se non nominata dall'utente. Computer dock: la freccia su nel card compatto
  apre direttamente la vista fullscreen live.
- **Linea attiva (fondamenta):** *convergenza dalle fondamenta* →
  [plans/2026-06-27-foundations-up-convergence.md](plans/2026-06-27-foundations-up-convergence.md).
- **Scoperta che guida tutto:** ogni sottosistema ha **due implementazioni**, la canonica è
  **dormiente** (caposaldo #5 violato system-wide). È la causa dell'instabilità (piano che
  parte o no, stesso prompt esiti diversi). Le mappe accurate sono in [architecture/](architecture/).
- **F0 COMPLETO (L0 — normalizzazione modello) — punto fermo, coda esaurita:**
  - ✅ **inc.1** `assistant_response` — builder canonico risposta + reasoning-fallback, cablato
    nei due collector (inline cancellato, `model_normalize` ora WIRED, 3 test).
  - ✅ **inc.1b** Ollama `message.thinking` — `process_ollama_line` accumula il reasoning trace
    (Ollama LO espone separato dal content) → fallback uniforme anche su Ollama.
  - ✅ **inc.1c** `ollama_tool_call` — normalizzazione tool-call Ollama (id sintetico + args
    oggetto→stringa) canonica + **testata** (2 test); inline cancellato. **Verificato vs fonte
    Ollama ufficiale + context7**: tool_calls completi per-chunk, accumulo `extend`, args oggetto,
    niente id — la nostra impl combacia.
  - ✅ **inc.2** `split_reasoning_from_content` — estrae `<think>…</think>` da content→reasoning
    nel builder. Verifica ha scoperto: `message.thinking` Ollama si popola solo con `think:true`
    (non lo mandiamo) → i reasoning model emettono `<think>` inline che `sanitize` cancellava
    (risposta vuota se tutto nel think). Ora estratti+preservati per il fallback. 2 test.
  - ✅ **inc.3a/3b** Profilo capacità Ollama — `warm_ollama_capabilities` (`/api/show`, cache
    per-modello) estrae `OllamaCapabilities { thinking, tools, vision, context_length }`. 2 test.
  - ✅ **inc.3c** CONSUMATO il profilo (tutti fail-safe, None/cloud → invariato): `think:true` solo
    ai thinking; `tools` (non offre tool a chi non li fa); `vision` (screenshot solo ai vision-model,
    altrimenti nota testo).
  - ✅ **inc.3d** CONVERGENZA su `model_registry::ModelEntry` (catalogo utente = fonte unica,
    caposaldo #5): il profilo si legge dal catalogo (`registry_model_capabilities`); `/api/show`
    arricchisce E **auto-compila** l'entry (`autofill_model_entry_capabilities` → aggiorna
    vision/tools/reasoning/context_window + salva). Niente più store parallelo `OllamaCapabilities`
    (ora è solo cache runtime sorgentata dal registry). Risolve la duplicazione che avevo introdotto.
    `context_length`: letto per l'auto-fill; usarlo per BUDGET prompt = follow-up validato.
  - ✅ **inc.4** `sanitize_model_text` (+ `strip_tag_blocks`/`strip_fullwidth_bar_tokens`) spostato
    in `model_normalize` → **tutta la normalizzazione testo nel modulo canonico**. 1 test. Call site
    aggiornati a `model_normalize::sanitize_model_text`.
  - ✅ **inc.5** `parse_text_tool_calls` + `synthesize_tool_calls` (+ helper `xml_attr_value`,
    `parse_xml_parameters`) spostati in `model_normalize` → **anche il tool-as-text** (Hermes/Qwen
    `<tool_call>`, Claude/MiniMax `<invoke>`) è ora canonico. Il "blocco" annotato era illusorio:
    `xml_attr_value` è condiviso solo *dentro* il cluster → tutto migra insieme. La rimozione cura
    anche un doc orfano lasciato da inc.4 (riattacca il doc di `prune_browser_history`). 4 test.
    Commit `8d9aad72`. **La frontiera canonica (ADR 0019) possiede ora OGNI forma di tool-call**
    (strutturata o trapelata-come-testo) → caposaldo #6/#11.

  - ✅ **inc.6** schema-downgrade floor (F0.6) — la costruzione del `response_format` (strict
    `json_schema` → degrade `json_object`) era hand-rolled in 3 punti (`build_request_body`
    inference, `generate_deck_content` + `orchestration_judge_response_format` gateway). Convergiuta
    in `local_first_inference::structured_response_format(name, schema)`; i 3 siti la chiamano.
    Behavior-preserving (test giudice + provider come guardia). Resta per-sito solo il control-flow
    di trasporto. Commit `b29fa4a3`. Caposaldo #5/ADR 0016.
  - ✅ **inc.7** `context_length` nel budget prompt (F0.7) — `chat_context_budget_chars` ora budgeta
    sulla finestra REALE del modello (catalogo `ModelEntry.context_window`, auto-filled F0.3d) via
    `registry_model_capabilities`, non più un flat 32k. Precedenza env-override > catalogo > 32k;
    policy pura `resolve_context_budget_chars` (1 test, 6 casi). Commit `7cd44e22`. Caposaldo #6.

**L0 (model-io) — PUNTO FERMO COMPLETO.** Normalizzazione risposta (builder canonico +
reasoning-fallback, `<think>`, tool-call Ollama + tool-as-text, sanitize, profilo capacità) tutta in
`model_normalize`; floor structured-output in una sola `structured_response_format`; budget prompt
sulla finestra reale. Testato e verificato sulla fonte. **Coda L0 esaurita.**

**F1 — capability unica (COMPLETO).** Tutte e quattro le convergenze fatte. Vedi
[piano](plans/2026-06-27-foundations-up-convergence.md):
- ✅ **(b) skill** (F1.b) — ritirato il `SkillCapabilityProvider` tipato dormiente (errore di
  categoria: skill = prosa, non tool chiamabile); path filesystem = canonica. Metadati skill/plugin
  tenuti (fondazione WS9). Commit `7b1fcecb`.
- ✅ **(c) Composio** (F1.c) — convergiuto sul path **v3** unico; ritirato il provider crate pre-v3
  (`composio.rs` cancellato). Era anche un **bug latente** (list_tools pre-v3 vs API v3 → run autonome
  rotte). Gate deny-by-default preservato in `authorize_managed_capability_tool` (riusa
  `CapabilityPolicy::tool_access`), 1 unit-test. Commit `4bb88afb`. **Non validato live** (no account Composio).
- ✅ **(a) motore di ricerca unico** (F1.a) — convergiuto su **un solo** ranker BM25 condiviso:
  l'Okapi `bm25_rank` (chat) è stato promosso a `local_first_capabilities::search` (`tokenize` +
  `bm25_rank_indices` su testo pre-tokenizzato → indici). La chat lo chiama via `bm25_rank`
  (wrapper, comportamento identico → test esistenti come guardia); l'orchestratore via il nuovo
  `ToolCorpus` in memoria (`crates/orchestrator/src/tool_corpus.rs`). **Ritirato** l'`FTS5
  ToolSearchIndexStore` (`tool_index.rs` cancellato): era SEMPRE `open_in_memory` + rebuild ogni
  turno → macchina FTS5 peso morto, e il `term*`-prefix divergeva dall'Okapi. Stesso algoritmo +
  stessa tokenizzazione su entrambi i lati → **niente più drift** chat↔planner (divergenza #3 chiusa).
  Constructor `OrchestratorBrain::new` non prende più l'indice (4 call-site aggiornati). Caposaldo #5.
- ✅ **(d) browser dentro il registry** (F1.d) — `seed_default_capabilities` ora semina i **veri**
  sei tool di chat (`browser_navigate`/`_snapshot`/`_act`/`_tabs`/`_screenshot`/`_dialog`, underscore,
  **schemi reali**) via `browser_registry_cached_tools()`, derivati dalle stesse
  `browser_*_tool_schema()` (niente terza copia). `clear_cached_tools` (nuovo, in `registry.rs`)
  rimuove i vecchi `browser.*` placeholder dai DB esistenti. Il planner indicizza i `cached_tools` →
  ora **vede il browser** coi nomi che il loop esegue (set ombra chiuso → sblocca ADR 0020). Test:
  i tool seminati combaciano coi tool di chat + sono recuperabili dal `ToolCorpus` (lo stesso ranker
  del planner). **Residuo F3:** i micro-tool di chat sono ancora cablati in `base_tools` (sorgentarli
  dal registry è F3). `BrowserCapabilityProvider` (dot-named, mai istanziato) **CANCELLATO** (cleanup
  2026-06-28): l'esecutore durable reale pilota il sidecar condiviso direttamente, non serviva il
  provider tipato. Caposaldo #5/#7.

**F2 — loop tier-adattivo / ADR 0018 (IN CORSO).** Stato reale (verificato sul codice, ≠ "non
implementato"): il meccanismo del floor È già cablato — `scaffold_for(turn_tier)` deriva le manopole,
**workflow_bias** rilassa la rotta (`relax_route_for_tier`) e **verify_depth** modula il gate F2,
entrambe sotto `adaptive_floor=on`; `format` MOOT; `slot` observe-only. Default **off**: accenderlo
richiede eval bi-popolazione (gemma4 vs capace) **non eseguibile in questo ambiente**.
- ✅ **F2.1 telemetria floor → `tool_trace`** — la decisione `{tier, profilo, mode}` è persistita
  nel `tool_trace` (→ estrattore memoria/learning) in `shadow`|`on`, non più solo `eprintln`
  (`scaffold::floor_trace_line`/`floor_trace_for_mode`, formato stabile testato). È il prerequisito
  ADR Fase-1 per validare il floor prima di accenderlo. Pulizia: tolto l'`#![allow(dead_code)]`
  stantio in `scaffold.rs`; rimossa la variante `VerifyDepth::Off` mai costruita (l'ADR vieta il
  "no-verify" per i capaci). +2 test scaffold. Caposaldo #2/#12, ADR 0018.
- ✅ **F2.2 il piano traccia il lavoro** (default-on, opt-out) — l'over-running guard è stato estratto
  in `answer_concludes_plan` (puro, testato; refactor behavior-preserving) e, quando ACCETTA la
  risposta con l'ultimo step aperto, riconcilia quello step a `done` + persiste (riusa il path
  canonico mark-done→`upsert_runtime_plan_memory_from_state`), così il turno DOPO non riprende il
  piano a vuoto. Promosso dopo evidenza live: risposta `.invalid` corretta ma Plan panel 1/2 perché
  lo step "registrare il fallimento" era rimasto `doing`. `HOMUN_PLAN_RECONCILE=0/off` resta opt-out
  diagnostico. La sintesi forzata NON riconcilia (lì il lavoro è incompiuto, il piano DEVE restare aperto).
  Resta: eventuale "done dopo verify" più stretto; il caso sintesi.
- ⏳ **F2.3 floor `shadow→on` + manopola `slot`** — richiede la eval bi-popolazione → differito a
  quando l'ambiente ha Ollama/gemma4.

**F3 — un motore / driver in-turn (ADR 0020 — IN CORSO, fondazione costruita+validata su gemma4).**
Il pezzo mancante "l'harness possiede il control-flow" ora ESISTE come motore #2 sincrono, testato.
Commit `b705289a` (driver+executor) + `3ce99c67` (arg-fill). Vedi [agent-loop](architecture/agent-loop.md) "Il driver in-turn".
- ✅ **F3.1 driver deterministico** — `crates/orchestrator/src/driver.rs` `drive_plan(plan, executor,
  verifier)`: un solo passaggio in avanti su piano già topologico (`validate_plan`), `StepExecutor`
  iniettato per step, `done` assegnato dal runtime SOLO dopo `StepVerifier`. Le 3 invarianti per
  costruzione (monotonìa/limitatezza/identità=`step_id`). Puro → 7 unit-test con fake, niente
  modello/SQLite (caposaldo #2). Seam `StepExecutor`/`StepVerifier` esportati.
- ✅ **F3.2 esecuzione per-step + arg-fill (model-fills-slot)** — `step_executor.rs`
  `CapabilityStepExecutor<R: JsonRuntime>` (UN solo executor, args-concreti e arg-fill convergiuti,
  caposaldo #5): risolve il tool come `validate_plan` (parità #11 validate↔execute); se gli `arguments`
  sono vuoti (forma piano-seme, il planner possiede la forma non gli args) il **modello li riempie
  vincolato allo schema del tool** (ADR 0016 Pilastro 3), poi esegue su `CapabilityFacade::call_tool`
  canonico. `Brain::drive(request, plan)` lo cabla (borrow disgiunti). `SubagentTask` falliscono
  rumorosamente (path agentico = F3.2c). **Validato end-to-end su gemma4**
  (`orchestrated_brain_drives_plan_on_gemma4`, ignored): plan→driver→arg-fill→execute→done, 1/1.
  +7 test orchestrator. **Scoperta:** la facade del gateway ha GIÀ un `CapabilityProvider` browser
  reale (sidecar condiviso) → `drive`→`call_tool` riusa gli esecutori durabili canonici; la
  `chat_browser_call` inline di motore #1 è la **parallela da ritirare**, non da replicare. NESSUN
  terzo dispatch.
- ✅ **F3.2c esecutore agentico** (`agentic.rs` `run_agentic_step`) — modalità *agent* di ADR 0016
  Pilastro 2: loop bounded (`MAX_AGENTIC_ROUNDS`, ultimo round forza sintesi) dove il modello sterza
  (sceglie tool read/gather o conclude) e l'harness possiede l'envelope. **Due fasi per round** (cura
  il fallimento "invalid arguments" su gemma4): scelta tool vincolata all'enum (#6) + `fill_arguments`
  riusato per gli args vincolati allo schema del tool (caposaldo #5). Scope solo read/gather (Read/Draft;
  scritture fuori). NON è un terzo runner: il `run_generate_json` durabile è la modalità *workflow*.
  **Validato su gemma4** (`orchestrated_subagent_gathers_on_gemma4`): gemma4 sceglie il tool, raccoglie,
  sintetizza (`evidence=[gather:web_search]`). +4 test agentic. Commit `3027abe4`.
- ✅ **F3.3 routing live — FATTO e VALIDATO NELL'APP REALE** (dietro nuovo flag `HOMUN_DRIVE_CHAT`,
  default off; fail-open a motore #1). Il turno di chat ora passa per `orchestrator_drive_for_chat`
  (main.rs): plan → `drive_plan` con `ChatDriveStepExecutor` (impl del seam `StepExecutor`, tiene
  `&AppState`) → esegue i browser-step via l'esecutore durabile esistente `call_shared_browser_sidecar`
  (`TaskRecord` sintetico — riuso, NIENTE terzo dispatch) → sintesi finale col **modello di chat** (non
  il browser-role) streamata → risposta. Hook in cima al task spawnato di `stream_chat_via_openai`
  (return early, coda post-turn memoria+cleanup rispecchiata). **Validato dal vivo:** prompt browse
  Wikipedia → piano 2 step (navigate+snapshot) → contenuto reale → risposta corretta in italiano, con
  il **pannello "Plan" visibile** (marker ‹‹PLAN›› + status). Commit `d84a1a0b`+`5334d35f`(planner
  tollerante)+`6d619de4`(snapshot content-preserving+budget 20k)+`8ae9c9ce`(plan-visibility). Fix
  emersi dal vivo: deser planner tollerante (`lenient_string`/`lenient_opt_string`), snapshot
  content-preserving (`browser_chat_snapshot_params`, riuso F0), budget gathered 20k.
- ✅ **F3.3 polish — UX live + BROWSE AGENTICO (validati live via curl-driving):** (a) azioni live
  per-step (canale `tokio::mpsc` sync→async → ‹‹ACT›› deltas: "🌐 Apro…/👁️ Leggo…"); (b) pannello
  **Plan** visibile (marker ‹‹PLAN›› + status per-step); (c) **browse agentico FUNZIONANTE**: il
  `SubagentTask` instrada al loop agentico via sidecar (`run_agentic_step` iniettabile, una loop due
  superfici #5) — naviga, clicca, digita, usa motori di ricerca, sintesi onesta. **Bug radice trovato
  e risolto** (diagnosi via curl-driving, log `[agentic]` gated HOMUN_DEBUG): il prompt agentico non
  descriveva il FORMATO output → `action=None` ogni round → vuoto. Aggiunto formato+esempi (come il
  planner). **Leva capace:** il drive usa ora il ruolo **"orchestrator" (deepseek)** non "browser"
  (minimax-m3) → args coerenti. Planner nudge: info live→`subagent_task` browse (eval ALL GREEN).
  Commit `7a472488`.
- ◑ **REGRESSIONE BROWSE del drive vs motore #1 — DIAGNOSI CORRETTA + 2 cause su 3 risolte (sess. 5e):**
  La diagnosi 5c era **parzialmente sbagliata sul meccanismo** (giusta sulla direzione). Verificato in
  codice + dal vivo (curl-driving, container `homun-cc`), sono **TRE cause indipendenti**, non una:
  1. ✅ **Pannello Computer assente** = il drive non cablava `begin_browser_activity`/`push_browser_step`/
     `end_browser_activity` (chat-loop only). NON era "headless/conflitto CDP": entrambi i path passano per
     lo **stesso** `browser_sidecar_env_with_headless` che setta `USER_CDP_ENDPOINT` identico → si
     attaccano allo **stesso** Chromium :9222 visibile. **FATTO** (`orchestrator_drive_for_chat` ora chiama
     begin/end + `thread_id` per bindare il pannello; `run_browser_tool` chiama push_browser_step).
     **Validato dal vivo**: `/api/local-computer/live` → `active:true`, steps, novnc_url.
  2. ✅ **connectOverCDP timeout (il "browser non funziona")** = wedge del container (CDP HTTP `/json/version`
     risponde MA il ws handshake si impianta su targets stantii dopo ore di uptime). `browser_cdp_ok`
     (solo HTTP) **non lo vede** → gap di **entrambi** i motori; il drive in più fa blind-retry. **FATTO**:
     self-heal nel surface condiviso `call_shared_browser_sidecar` — `browser_response_indicates_cdp_wedge`
     + recycle container throttlato (once/90s, no `docker rm -f` thrash) → SidecarLost → respawn fresh.
     +1 unit-test (matcher conservativo). Su container fresco il drive **funziona**: navigate→snapshot→act
     sul browser **user visibile**, 6–20k char raccolti.
  3. ⏳ **Form-fill / wandering** = NON "schema non imposto" (lo è, `fill_arguments`+`json_schema`): è il
     loop agentico (`run_agentic_step`) — digest 4k tronca i `ref` dei campi profondi + `generate_json`
     non-enforced su Ollama, contro il **native tool-calling** di motore #1. **= Increment B** (sotto).
- ◑ **Increment B.1 (FATTO, +test):** tolto il troncamento 4k del loop agentico — `render_history` tiene
  l'ULTIMO snapshot pieno (16k) e stubba i vecchi (mirror di `prune_browser_history`), così il modello
  VEDE i campi del form. Commit `3c70dbc8`. Validato live: il prune compare nel gathered; il self-heal CDP
  ha anche recuperato dal vivo (round 0 wedge→recycle→round 1 ok).
- ✅ **RISOLTO — browse instradato a motore #1 (commit `8c427e18`).** Prova empirica decisiva (drive ON):
  il loop agentico del drive è PEGGIORE di motore #1 — 16 round × 2 chiamate cloud (~5 min), vaga
  (scroll/scroll, `action=None`), **risposta VUOTA**; riproducibile (Tokyo, notizie tech). Causa
  ARCHITETTURALE, non un patch mancante: un motore plan-execute separato con loop `generate_json` è il
  design sbagliato per uno strumento osserva→agisci. Fix: `plan_is_browse_only` → `Ok(None)` → fallback a
  motore #1 (path fail-open esistente). **Validato live:** stessa query notizie tech → instradata a motore
  #1 (0 righe `[agentic]`) → risposta vera, formattata, con fonte. Il drive resta per piani multi-capability.
  **Validato nell'app Electron reale (drive flag ON):** sia la ricerca/browse sia una chiamata MCP
  funzionano → il browse va a motore #1, la capability MCP la esegue il drive. Comportamento corretto.
- 🧭 **EVIDENZA SOTA (3 ricerche citate, [[homun-single-loop-evidence-verdict]]):** il campo (2025) usa UN
  loop ReAct guardato col piano come *tool* (Claude Code TodoWrite, Manus todo.md), NON un planner+executor
  separato. browser-use ha RIMOSSO il suo planner. Forzare JSON sui modelli deboli DANNEGGIA il ragionamento
  ("Format Tax": il degrado entra dal prompt, non dal decoder). → motore #1 è il design corretto; il drive
  (due motori) è l'errore architetturale. ADR 0016 (slot-filling) emendato, ADR 0020 (convergere
  nell'orchestrator) **invertito** → convergere nel loop di chat unico. **Da fissare in un ADR.**
- ⏳ Altri residui: flicker reasoning della sintesi (collector → reasoning alla work-island); accendere
  il drive di default solo DOPO la convergenza browser.
- ⏳ **F3.4** ritirare `merge_plan` per-titolo + prompt-prosa (solo quando il drive è il default).
  ⏳ scope agentico oltre read/gather (scritture single-threaded+approval).

Mappe: [registry](architecture/capability-registry.md), [skills](architecture/skills.md),
[connectors](architecture/connectors-composio.md), [browser](architecture/browser.md), [mcp](architecture/mcp.md).
NB live-validation (CORRETTO 2026-06-28, sessione 4): **Ollama È installato e gira** (`127.0.0.1:11434`)
con `gemma4:latest` (8B) + `gemma4:12b` — il vecchio "non Ollama" era STANTIO. Quindi la eval
bi-popolazione (caposaldo #2) È eseguibile qui: `python3 scripts/eval_suite.py gemma4:latest`. Modello
chat di default = deepseek-v4-pro:cloud (Z.ai, tier **Balanced**); Composio non configurato.

## Cosa è stato fatto (rolling, conciso)

**Sessione 2026-07-02 — gap analysis production-readiness vs Codex.app (bundle reverse-engineered):**
Analizzato il bundle distribuito di Codex (`/Users/fabio/Projects/codex/Contents`: asar estratto,
binario `codex` 0.142.5, chronicle, cua_node, 7 plugin) e auditata Homun v0.1.x sulle dimensioni di
produzione. Risultato in [confronto-codex-produzione.md](confronto-codex-produzione.md) (complementare
al confronto strutturale): gap 🔴 = osservabilità (zero log persistenti nel packaged, zero panic
hook/crash report) + resilienza (no single-instance lock, no recovery SQLite corrotto); 🟠 =
sandbox-enforcement (approvals cooperativi vs recinto OS-level 3-livelli di Codex) + firma
Windows/Linux; 🟡 = CSP/fuses/devTools, `homun://`, manifest plugin installabile (formato
plugin.json+SKILL.md+.mcp.json = la formalizzazione che manca a F0–F3), e2e. Piano P0–P3 nel doc;
P0 è ortogonale alla convergenza ADR 0021/0022 (fattibile subito). Idea da rubare: record-and-replay
→ skill (chiude il cerchio con `routines`/`automation_candidates`, memoria-centrico in Homun).

**Sessione 2026-06-29 (5g) — ADR 0021 (single-loop) + batch fix chat-UX/funzionali (validati live nell'app):**
La sessione è passata dalla diagnosi browse all'azione: scritto l'**ADR 0021** (un loop guardato + piano
come tool; supersede direzione 0020, emenda 0016 — [[homun-single-loop-evidence-verdict]]) e poi una serie
di fix concreti, ciascuno committato + buildato + (dove possibile) validato live via curl/app Electron:
- **F1 — typo tool browser → no Composio 404** (`f34a399e`): `resolve_browser_chat_tool_name` canonicalizza
  `browser_tavigate`→`browser_navigate` (edit-distance ≤2) prima del dispatch; mai più su Composio. +1 test.
- **#1 — titolo isola live** (`f34a399e`): l'headline preferisce i segnali reali (plan/‹‹ACT››) al label di
  fase, così il titolo compare subito durante il turno.
- **Reasoning collassato** (`85e19dc3`+`bf85c2ed`): builder emette `‹‹REASONING››…‹‹/REASONING››` (non più
  fold-into-content che lo spacciava per risposta; preserva il fallback weak-model `<think>`-empty-content);
  frontend lo rende **collassato** e gestisce anche `<think>` inline **dal vivo** (deepseek lo strema in
  chiaro); label "Reasoning"; canali ripuliti dai marker (`strip_chat_markers`). +test.
- **#2 — isola persistente** (`bf85c2ed`): latch per-thread, resta (collassata) dopo il turno.
- **Planner deser tollerante** (`ea5d169e`): `confidence:"high"` (o assente) non fa più fallire il piano
  (`lenient_confidence`); era una causa del "non segue il piano". +test.
- **F2 — pivot su ricerca dopo navigate falliti** (`7bd46495`): hint di recovery (STOP+cerca su Google al 2°
  fallimento dello stesso URL). +test. *(NB: contatore per-turno → non frena il loop di ripresa-piano F4.)*
- **Self-heal CDP-wedge nel path di motore #1** (`6609441c`): ERA il "bloccato". `connectOverCDP timeout`
  (container stantio, HTTP ok ma ws hung) — il self-heal stava SOLO nel path drive; ora anche la navigate di
  motore #1 lo rileva (`cdp_wedge_signature`) e ricicla (`force_recycle_contained_computer`, throttlato).
  Validato: navigate→done + risposta vera su container fresco.
- **Liveness pannello Computer** (`b5745b2c`): "· Xs" dall'ultima attività + avviso ambra "may be stuck" a
  45s → si capisce se avanza o è fermo.
- **Autonomia / fine del "continua"** (`86c0e435`): BUG — `is_final_round` usava il round TOTALE invece di
  `rounds_since_progress`, così un piano lungo ma in avanzamento veniva forzato a sintetizzare a metà (round
  32) → turno incompleto → l'utente doveva digitare "continua". Ora misurato dall'ultimo progresso → il
  task multi-step va fino in fondo da solo (tetto duro 600 round).
- **form-fill `kind=fill`** (`a62cfba9`): root-cause = mismatch di CONTRATTO (backend, non UI). Lo schema
  chat `browser_act` è PIATTO (`{kind,ref,text}`, una micro-azione), ma il `case "fill"` del sidecar TS
  iterava `action.fields` (forma array di `fill_form`); la forma piatta non porta `fields` → `for…of
  undefined` → `BROWSER_ACTION_FAILED` silenzioso. Quindi `kind=fill` non ha MAI funzionato dalla chat,
  `kind=type` sì. Fix: `resolveFillFields` (`actions.ts`) accetta entrambe le forme convergendole (#5);
  `ref` senza valore → `BROWSER_INVALID_REQUEST` esplicito. +1 test fixture (flat fill), 24/24 verdi.
- **#5 / #3 (UI)**: #5 formattazione progressiva è live — il messaggio
  in streaming rende `RichMessage streaming` → `RichMessageRenderer` streaming-aware (code-fence aperti,
  mermaid differito); #3 il pannello computer ha i tre stati `bar`(320px)→`expanded`(620px)→`full`
  (overlay `4vh/4vw`, ESC+scrim). Dopo screenshot live 16:19 la freccia su del card compatto è stata
  promossa ad apertura `full`; il thumbnail resta il gesto per l'`expanded` inline. Contract UI copre
  questa regressione.
- **F4 — loop ripresa-piano** (`cfd270c9`, backend): root-cause = contatori recovery PER-TURNO
  (`nav_failures`/`rounds_since_progress` `let mut` nel turno) → piano ripreso riavvia lo step fallito a
  ogni resume. Fix: segnale cross-turno persistito sul piano (`stall_turns`/`last_resume_done`, preservati
  negli upsert mid-turno) conta i resume senza nuovi `done`; dopo cap=3 l'harness `block_stalled_step`.
  Terminazione su **`settled`** (done|blocked), non solo `complete`, + `blocked` sticky in `merge_plan`
  (evita il re-arm). Puri testati (`next_plan_stall`/`plan_is_settled`/`block_stalled_step`), wiring gated
  `HOMUN_PLAN_STALL_ABORT` (non validabile live qui, come `HOMUN_PLAN_RECONCILE`). +5 test, 33/33 piano verdi.
- **F3-deep — risposta vuota per cutoff/budget** (`7fddd545`, backend): root-cause = un modello di
  ragionamento spende tutto il budget token a pensare (`finish_reason:length`, content vuoto) →
  `assistant_response` emette `‹‹REASONING››…‹‹/REASONING››` con body VUOTO e il loop lo committava come
  risposta finale → bolla vuota/solo-reasoning. Fix: prima del commit, se `answer_body_is_empty(&content)`
  (`strip_chat_markers` non lascia prosa) e niente accumulato, `break` SENZA `final_done` → scatta la
  sintesi forzata esistente (`!final_done`: no-tools, budget fresco, "scrivi la risposta ORA" + fallback).
  `break` esce dal loop → sintesi una volta sola, niente spin. Riuso (#5), non terzo path. +1 test.
- **Marker display-only nel contesto modello** (`df65d0b0`, backend): scoperto dal test live dell'utente
  (puzzle Einstein → modello confuso "il testo che hai incollato è già completo"). Root-cause: il binario
  in esecuzione era **vecchio** (processo avviato prima dei commit; un processo non ricarica il binario
  ricompilato) → comportamento pre-fix. Ma ha rivelato un bug reale separato: `build_chat_runtime_prompt`
  (lib.rs) rendeva la history dell'assistant **coi marker `‹‹REASONING››`** → su follow-up/Continue il
  modello rileggeva il proprio trace come testo incollato. Fix: `strip_display_markers` canonico in lib
  (gestisce trace non chiuso da cutoff), usato in `normalize_context_text`; `strip_chat_markers` del
  gateway converge (#5/#13). +3 test. Resume non toccato (legge `request.context`, non il prompt).
- **Auto-continue su risposta completa** (`f31e3f48`, frontend): la prova live ha mostrato che il
  marker-leak era risolto MA restava un residuo: `isLikelyIncompleteMessage` (ChatView) ritornava
  `true` appena `generationTokens ≥ 96% maxTokens` → su un reasoning model che brucia il budget a
  *pensare* (trace all'inizio, risposta alla fine) falso-positivo → auto-continue ×2 → rifeed di una
  risposta completa → "il testo è già completo". Fix: near-max conta come incompleto SOLO se il testo
  finisce anche a metà (niente punteggiatura/fence/riga-tabella di chiusura). HMR-live.
- **In coda (prossimi):** coda fix-sessione **esaurita**. Form-fill e F3-deep sono validati live; F4 resta
  gated e va ripreso dal nuovo finding su identità/perimetro del runtime-plan ripreso (piano `.invalid`
  sostituito da piano FIFA non correlato). Poi eventualmente: scope agentico oltre read/gather, accensione
  drive solo dopo convergenza. NB: doc stantii (ADR 0006 ha già il banner).

**Sessione 2026-06-29 (5e) — REGRESSIONE BROWSE: diagnosi corretta dall'evidenza + 2/3 cause risolte:**
- **Investigazione (3 deep-dive paralleli + verifica in codice/dal vivo):** la diagnosi 5c era
  parzialmente errata sul MECCANISMO. Le tre cause sono INDIPENDENTI (non "una sola"): (1) pannello assente
  = drive non cabla `begin/push/end_browser_activity` (NON "headless/conflitto CDP": stesso env builder,
  stesso `USER_CDP_ENDPOINT`, stesso :9222 visibile); (2) `connectOverCDP` timeout = wedge del container
  (HTTP ok, ws hung), `browser_cdp_ok` non lo vede → gap di ENTRAMBI i motori; (3) form-fill = digest 4k +
  `generate_json` del loop agentico, NON "schema non imposto".
- **OpenClaw:** NON abbiamo perso fedeltà. Motore #1 (granular tools + native tool-calling + osserva→agisci)
  È il port fedele; il drive ha **rianimato** il `generate_json` loop (`RuntimeBrowserLoopPlanner`) che il
  codebase aveva già RITIRATO. ADR 0006 + i due `2026-05-28-openclaw-*` descrivono ancora quel loop ritirato
  → **stale**.
- **Increment A (FATTO, validato live):** pannello Computer per il drive — `orchestrator_drive_for_chat`
  chiama begin/end activity (+ `thread_id`), `run_browser_tool` chiama `push_browser_step`.
  `/api/local-computer/live` → `active:true` + steps + novnc.
- **Self-heal CDP-wedge (FATTO, +1 test):** nel surface condiviso `call_shared_browser_sidecar`,
  `browser_response_indicates_cdp_wedge` + recycle throttlato (once/90s) → respawn fresh. Beneficia drive
  E task durabili. Su container fresco il drive naviga/snapshot/agisce sul browser **user visibile**
  (navigate→done, 6–20k char). Healthy-path ri-validato: nessun recycle spurio.
- **Engine (dubbio dell'utente):** parzialmente validato, NON marcio. Errore di categoria in F3: "harness
  possiede il control-flow" letto come "harness ri-esegue il tool via JSON loop" → sbagliato per uno
  strumento osserva→agisci. Vedi [[homun-browser-drive-regression-diagnosis]]. **Prossimo = Increment B.**

**Sessione 2026-06-28 (5d) — REGRESSIONE BROWSE individuata (lezione di architettura):**
- L'utente: col drive il browse è REGREDITO vs motore #1 (che apriva il browser visibile, compilava
  form, prendeva treni/voli, mostrava il pannello Computer). Il drive: invisibile + form non affidabili
  + pannello assente.
- **Lezione:** il drive deve possedere il CONTROL-FLOW (piano/identità — funziona) ma DELEGARE
  l'esecuzione tool (browser soprattutto) al path MATURO del motore #1 (per-thread visibile + native
  tool-calling), NON reimplementarlo con loop agentico + sidecar condiviso. Il loop agentico
  (`agentic.rs`) era la strada sbagliata per l'esecuzione browser. → prossimo passo = convergenza
  F3.3-pre ridefinita (vedi prompt di ripartenza). NON spegnere il flag (default OFF: l'app normale usa
  già il motore #1 funzionante); il fix è in avanti.

**Sessione 2026-06-28 (5c) — F3.3 polish: UX live + browse agentico funzionante (curl-driving):**
- Live per-step UX (‹‹ACT›› via canale sync→async) + pannello Plan (‹‹PLAN›› marker). Commit `8ae9c9ce`.
- **Browse agentico**: `run_agentic_step` reso iniettabile (gather tools + execute closure) → gateway
  via sidecar, orchestrator via facade (una loop, due superfici #5). Planner nudge: info live→browse
  subagent_task (eval ALL GREEN). Commit `e0eb9f0c`+`7a472488`.
- **Bug radice del browse agentico TROVATO+RISOLTO** pilotando io il gateway via curl (`/api/chat/
  generate_stream`) e leggendo i log `[agentic]` (gated HOMUN_DEBUG): prompt senza formato output →
  `action=None` sempre → vuoto. Fix: formato+esempi nel prompt. **Leva:** drive ora sul ruolo
  "orchestrator" (deepseek) non "browser" (minimax-m3). Ora naviga/clicca/digita/cerca davvero.
- Onesto: estrarre dati live precisi da booking JS = difficile (efficacia, non bug); motore #1 vince
  lì → convergenza F3.3-pre. NB: per debug usato il **gateway standalone** (`./target/debug/...`) per
  pilotare via curl senza GUI; electron in dev può crashare se il `cargo run` del gateway ricompila
  oltre il timeout health-check (pre-compilare con `cargo build`).

**Sessione 2026-06-28 (5b) — F3.3 routing LIVE nell'app reale (motore #2 guida un turno di chat):**
- Cablato `orchestrator_drive_for_chat` + `ChatDriveStepExecutor` (impl `StepExecutor`, tiene `&AppState`,
  browser via `call_shared_browser_sidecar`+`TaskRecord` sintetico) + hook in `stream_chat_via_openai`
  dietro `HOMUN_DRIVE_CHAT` (fail-open). Sintesi col modello di chat (streamata) + marker ‹‹PLAN››.
- **Validato dal vivo** (electron, browser sidecar reale): browse Wikipedia → drive 2 step → risposta
  corretta in italiano + pannello Plan visibile. Fix iterati dal vivo: planner deser tollerante,
  snapshot content-preserving (riuso F0), budget gathered 20k, chat-model synthesis. Commit
  `d84a1a0b`/`5334d35f`/`6d619de4`/`8ae9c9ce`. Residuo: UX live per-step, browse agentico (form-fill),
  accensione default.

**Sessione 2026-06-28 (5) — F3 fondazione: driver in-turn + arg-fill + executor agentico, validati su gemma4:**
- **F3.2c** `agentic.rs` `run_agentic_step` — modalità *agent* (ADR 0016 P2): loop bounded read/gather,
  due fasi/round (scelta tool enum #6 + `fill_arguments` vincolato allo schema, riuso). Cura il
  fallimento gemma4 "invalid arguments". Validato live (`orchestrated_subagent_gathers_on_gemma4`:
  gemma4 raccoglie e sintetizza). +4 test. Commit `3027abe4`.
- **F3.1** `driver.rs` `drive_plan` — control-flow posseduto dall'harness: passo avanti su piano
  topologico, `StepExecutor`/`StepVerifier` iniettati, `done` solo dopo verify, 3 invarianti per
  costruzione. 7 unit-test puri. Commit `b705289a`.
- **F3.2** `step_executor.rs` `CapabilityStepExecutor<R>` — UN executor: args concreti → esegue;
  args vuoti (piano-seme) → il modello li riempie vincolato allo schema del tool (ADR 0016 P3) →
  `CapabilityFacade::call_tool`. `Brain::drive` lo cabla. `SubagentTask` falliscono (F3.2c). Commit
  `3ce99c67`. +7 test orchestrator.
- **Validazione live gemma4**: `orchestrated_brain_drives_plan_on_gemma4` (ignored) → plan→driver→
  arg-fill→execute→done, 1/1 step ripetibile. Verticale di motore #2 regge sul tier debole.
- **Scoperte/correzioni**: la facade gateway ha già un provider browser reale (sidecar) → niente
  terzo dispatch, la `chat_browser_call` inline è la parallela da ritirare; corretta agent-loop.md
  ("execute_plan ignora depends_on" era impreciso: validate_plan impone l'ordine topologico,
  enqueue_step cabla gli archi durabili — il gap era il driver sincrono assente, ora colmato).

**Sessione 2026-06-28 — chiusura L0 (F0.5–F0.7) + avvio F1 (b, c):**
- **F0.5** tool-as-text (`parse_text_tool_calls`/`synthesize_tool_calls` + helper) → `model_normalize`;
  doc orfano curato; 4 test. Commit `8d9aad72`.
- **F0.6** floor structured-output convergiuto in `structured_response_format` (1 def, 3 call-site);
  behavior-preserving. Commit `b29fa4a3`.
- **F0.7** budget prompt sulla finestra reale del modello (catalogo); policy pura testata. Commit `7cd44e22`.
- **L0 = punto fermo completo; coda esaurita.**
- **F1.b** ritirato `SkillCapabilityProvider` dormiente (skill = prosa, non tool). Commit `7b1fcecb`.
- **F1.c** Composio convergiuto su v3, provider crate pre-v3 cancellato (era anche un bug latente);
  gate preservato + testato. Commit `4bb88afb`.

**Sessione 2026-06-28 (2) — chiusura F1 (a search-engine + d browser-in-registry, accoppiati):**
- **F1.a** un solo ranker BM25: Okapi promosso a `local_first_capabilities::search` (shared
  `tokenize` + `bm25_rank_indices`); chat via wrapper `bm25_rank`, orchestratore via nuovo
  `ToolCorpus` in-memory. **Ritirato** l'FTS5 `ToolSearchIndexStore`/`tool_index.rs` (sempre
  in-memory + rebuild-per-turno → peso morto; ranking divergente). `OrchestratorBrain::new` senza
  più param indice (4 call-site). Niente drift chat↔planner. Caposaldo #5.
- **F1.d** browser reale nel registry: `browser_registry_cached_tools()` semina i 6 tool di chat
  (schemi reali, derivati dalle `browser_*_tool_schema()`); `registry.clear_cached_tools` toglie i
  vecchi `browser.*` placeholder. Planner ora vede il browser (sblocca ADR 0020). `BrowserCapabilityProvider`
  morto → flaggato. Caposaldo #5/#7.
- Test: 6 unit shared-ranker + 2 `ToolCorpus` + 2 gateway browser-seed.
- **Giro di chiusura F1 (contract-test, il bar del piano "args → output/errore tipizzato"):** +2
  test gateway — (1) seed idempotente + migrazione (`clear_cached_tools` droppa i `browser.*`
  stantii, re-seed non duplica → esattamente 6 underscore); (2) i 6 tool browser passano per il
  **vero `CapabilityFacade`** (policy → visible/executable, `validate_arguments`): args mancanti →
  `SchemaValidationFailed` tipizzato, args validi → validazione passa (esecutore planning-only
  rifiuta con `ProviderUnavailable`). F1.a resta coperto dal ranker condiviso (un'unica funzione,
  niente test "stesso risultato" fittizio: i due lati indicizzano testo diverso, condividono
  l'algoritmo). Gate gateway **357 pass / 1 fallimento ambientale atteso (soffice)**.
  **F1 = PUNTO FERMO TESTATO → prossimo F2 (loop tier-adattivo, ADR 0018).**
- **F1.d cleanup** cancellato il gemello dormiente `BrowserCapabilityProvider` (`browser_provider.rs`
  + il suo test + l'export in `lib.rs`): mai istanziato, era il terzo sorgente dot-named dei tool
  browser. Verificato prima che l'esecutore durable reale (`execute_capability_browser_task` →
  `execute_persistent_browser_capability`) piloti il sidecar condiviso **direttamente** via
  `BrowserAutomationClient`/`BrowserMethod` + `browser_method_for_capability_tool` (gemello vivo del
  `method_for_tool` del provider): il worker path non aveva e non ha bisogno del provider tipato.
  L'enum `CapabilityProviderKind::Browser` resta (lo usano registry/orchestratore/bridge). Stesso
  pattern di ritiro di F1.b/F1.c. Caposaldo #5. `cargo check --workspace` verde.

**Sessione 2026-06-28 (3) — avvio F2 (F2.1 telemetria floor):**
- Scoperta verificando il codice: ADR 0018 NON è "non implementato" — `scaffold_for` è cablato,
  workflow_bias + verify_depth modulano sotto `adaptive_floor=on`; manca solo `slot` (observe-only) e
  l'accensione del floor (gated su eval bi-popolazione non eseguibile qui).
- **F2.1** la decisione del floor `{tier, profilo, mode}` ora è **persistita nel `tool_trace`**
  (→ memoria/learning) in `shadow`|`on` via `scaffold::floor_trace_for_mode`, non più solo stderr —
  telemetria Fase-1 prerequisito per accendere il floor con dati. Tolto `#![allow(dead_code)]`
  stantio + rimossa `VerifyDepth::Off` mai costruita. +2 test scaffold.
- **F2.2 (promosso default-on)** over-running guard estratto in `answer_concludes_plan` (puro/testato,
  refactor behavior-preserving); quando accetta la risposta con l'ultimo step aperto, riconcilia
  quello step a `done` + persiste → il turno dopo non riprende il piano a vuoto. Opt-out diagnostico
  `HOMUN_PLAN_RECONCILE=0/off`. La sintesi forzata non riconcilia (lavoro incompiuto). +2 test.

**Sessione 2026-06-28 (4) — VALIDAZIONE F2 (scoperto: Ollama+gemma4 ci SONO):**
- **Correzione di realtà:** Ollama gira (`127.0.0.1:11434`) con `gemma4:latest`+`gemma4:12b` → la eval
  bi-popolazione È eseguibile. STATO "non Ollama" era stantio (fixato).
- **`scripts/eval_suite.py gemma4:latest` = ALL GREEN** (deck/document/plan/decision+why/open_loop+why,
  tutti schema-valid sul tier debole, 63–105s/check). È il gate di regressione ADR 0018 / caposaldo #2:
  l'orchestrazione strutturata regge su gemma4 dopo F0–F2.
- **Tier reali pinnati (test):** `gemma4:*`→Fast (il caso che il floor protegge), `deepseek-v4-pro:cloud`
  →Balanced, `deepseek-r1:cloud`→Reasoning — gli input del floor classificano giusto e monotòni.
- **Coperto:** foundation (eval) + input tier (test) + manopole/telemetria/reconcile (unit). **NON
  fatto:** un turno live attraverso il gateway (telemetria floor che emette in shadow su un turno reale,
  reconcile che scatta) — invasivo sul `~/.homun` reale; il path organico è `adaptive_floor:"shadow"`
  in runtime-settings, che fa fluire la telemetria F2.1 durante l'uso normale.
- **`adaptive_floor` FLIPPATO a `shadow`** in `~/.homun/runtime-settings.json` (reversibile): la
  telemetria F2.1 ora fluisce durante l'uso normale.

**Sessione 2026-06-28 (4b) — ON-RAMP F3 validato su gemma4 (ADR 0020):**
- **Payoff di F1.d CONFERMATO end-to-end:** un test `#[ignore]` (`orchestrated_planner_sees_browser_on_gemma4`,
  hits Ollama) costruisce la brain come `orchestrator_plan_for_chat` su registry seminato (browser reale)
  e fa girare il planner su gemma4. Risultato: **piano browser a 5 step** (navigate→act→snapshot→scroll→
  snapshot) — il vecchio "0 step perché il planner non vede il browser" è MORTO. Il planner vede e pianifica.
- **Primo blocco F3 trovato E risolto (caposaldo #11):** gemma4 stipa gli argomenti nel campo `tool_name`
  (`"browser_navigate.url: https://…"`) → `tool_for_step` (exact match) lo rifiutava `tool_not_loaded`.
  Aggiunta **risoluzione tollerante** (`tool_name_resolves`: il nome caricato è il token iniziale del
  richiesto, con boundary) → exact-match vince sempre, il fallback recupera i nomi stipati. +1 test;
  ri-validato live: il piano a 5 step ORA valida. Commit dopo questa nota.
- **Planner vincolato (caposaldo #6) — FATTO:** `planner_schema(loaded_tool_names)` ora inietta un
  **enum** dei nomi-tool caricati sul campo `tool_name` (era stringa libera → per questo gemma4 ci
  stipava gli argomenti). `call_planner` passa i nomi da `loaded_tools` + nudge nel prompt ("tool_name
  = ESATTAMENTE un nome caricato; gli input vanno in arguments"). Ollama applica lo schema (la eval lo
  prova). **Ri-validato live:** stesso prompt → ora `tool_name="browser_navigate"` PULITO (prima
  `"browser_navigate.url: https://…"`). +2 test planner. Enum (cura a monte) + risoluzione tollerante
  (rete di sicurezza) = la coppia canonica #6/#11.
- **`arguments` vuoto dal planner = BY DESIGN, non un bug:** `execution_plan_to_canonical_steps` usa solo
  `goal`/`tool_name`/`contract` per i titoli del piano-seed (ADR 0020 P1); gli argomenti reali li riempie
  il loop di chat all'ESECUZIONE. Quindi il planner produce la FORMA del piano, non gli args. Nessun
  per-tool argument schema da costruire (evitato over-engineering).
- **Prossimo F3:** il vero passo grosso resta instradare il turno chat sul Brain come driver (oggi
  `orchestrator_plan_for_chat` fa solo `plan_only`→seed); + ritirare `merge_plan` per-titolo. Da fare con
  scoping dedicato.

**Sessione 2026-06-27 — diagnosi + fix sintomo + analisi strutturale + metodologia:**
- **Fix agentic-loop validati e pushati** (default flag-off, migliorano il model-loop):
  anti-churn `‹‹PLAN››`, compaction data-preserving, grounding calibrato, snapshot browser
  content-preserving + attesa, fonti pulite, wander-cap, sintesi-finale, **resume-from-store**
  (risolve "il piano riparta"), recovery `browser_act` malformato. Commit `bccf7706`, `ddeeb633`,
  `0f4c686d`.
- **Analisi strutturale (4 assi)** → il control-flow è del **modello**, non dell'harness; due
  motori. **ADR 0020** (convergenza) + **Fase 1 increment 1a** (planner deterministico dietro
  `HOMUN_ORCHESTRATED_CHAT`, flag-off): `ec28d5c4`, `cf817896`. *Gap trovato:* il planner
  orchestrator non vede i tool chat (browser) → torna 0 step per la ricerca → serve planner
  **chat-tool-aware** (F3).
- **Reverse-engineering completo dei sottosistemi** → 9 mappe accurate con Mermaid in
  `architecture/` (agent-loop, model-io, browser, mcp, skills, connectors-composio,
  contacts-channels, capability-registry, memory) + **il piano foundations-up** + hub aggiornato.
  Commit `941664ac`.
- **Metodologia + stato** (questo file + METHODOLOGY.md) istituiti per la continuità.

**Nota storica:** `crates/desktop-gateway/src/model_normalize.rs` è ora **tracciato e cablato**
(F0.1–F0.5). Il vecchio workaround sul `mod model_normalize;` untracked non serve più.

## Vincoli (NON violare)

- Commit diretti su `main`; **no** trailer `Co-Authored-By`. Release = commit + tag `vX.Y.Z` → CI
  builda draft (NON pubblicata). **NON pubblicare** finché l'agentic loop non è a posto.
- `model_normalize.rs` è tracciato (niente più workaround sul `mod` untracked).
- `find_italian.py` non è in CI (gate locale); italiano per input-parsing è intenzionale.
- Gate locale: `cargo test -p local-first-desktop-gateway` ha 1 fallimento ambientale atteso
  (`import_pptx_template_pack…` richiede `soffice`/LibreOffice assente in dev) — non è una regressione.

## Ambiente di debug

- Dev: `cd apps/desktop && HOMUN_DEBUG=1 [HOMUN_ORCHESTRATED_CHAT=1] npm run electron:dev` sul
  `~/.homun` reale. Gateway `cargo run` su `:18765` con log **visibili** (l'app pacchettizzata ha
  `stdio:ignore` → niente log). Diagnostica `[plan]`/`[browser_act]` gated su `HOMUN_DEBUG`.
- Thread/risposte: `~/.homun/desktop-gateway.sqlite` (`chat_threads`, `chat_messages`).
- `~/.homun/runtime-settings.json` → `adaptive_floor: "shadow"` (telemetria F2.1 attiva, NON agisce;
  tenere lontano da "on" finché la eval bi-popolazione non valida il flip). Ollama+gemma4 disponibili.
- Build gateway: `cargo build -p local-first-desktop-gateway --bin local-first-desktop-gateway`.

## Prompt di ripartenza (copia questo per una sessione nuova)

```
Continuo Homun (assistente agentic local-first). Repo: /Users/fabio/Projects/Homun/app, branch main.

PRIMA leggi, in ordine: docs/CAPISALDI.md (principi), docs/METHODOLOGY.md (come si lavora),
docs/STATO.md (dove siamo), docs/plans/2026-06-27-foundations-up-convergence.md (il piano),
e le mappe in docs/architecture/ del sottosistema su cui lavoriamo.

CONTESTO + DECISIONE (ADR 0021, 2026-06-29): il sistema aveva DUE motori (chat-loop "motore #1" +
drive/orchestrator "motore #2"). Decisione, basata su 3 cluster di ricerca su sistemi reali + prova
empirica: convergere su UN loop guardato (motore #1: ReAct + native tool-calling + osserva→agisci, il
port fedele di OpenClaw), col PIANO COME *TOOL* — NON estendere il drive plan-execute (è l'anti-pattern;
il suo unico vantaggio, esecutore più economico, non esiste per un target locale). ADR 0021 supersede la
DIREZIONE della 0020 ed emenda la 0016 (obiettivo ok, meccanismo no: niente slot-filling JSON sull'intero
turno — danneggia il ragionamento dei modelli deboli). Il browse è GIÀ instradato a motore #1
(`plan_is_browse_only`). **NON investire più nel drive come motore di esecuzione.** Metodo invariato:
niente terza impl, rimuovi il morto toccato, commenta il perché, ogni fix porta un test + aggiorna
architecture/. Leggi [[homun-single-loop-evidence-verdict]] + decisions/0021.

PROSSIMO PASSO (scegli con l'utente — la coda di fix chat-UX/funzionali di sessione è ESAURITA; restano
F4 + backlog più profondo):
- **F4 resta gated / NON default-ON.** Validazione live con URL `.invalid` + `continua` non ha prodotto il
  log atteso `[plan] F4: blocked stalled step after 3 …`; aveva esposto contaminazione da runtime-plan
  non correlati recuperati nel briefing memoria (piano `.invalid` → piano FIFA). Fix testato: le memorie
  `source=runtime_plan` restano caricabili solo dal loader per-thread e non entrano più negli `OPEN LOOPS`
  generici. Riprova live 2026-06-30 con binario fresco + `HOMUN_PLAN_STALL_ABORT=1`: niente contaminazione
  osservata, ma niente log F4 perché i turni si chiudono/re-sintetizzano prima di accumulare tre resume
  no-progress. Prossimo passo: test deterministico che forza un runtime-plan non-settled cross-turno, poi
  nuova validazione live prima di promuovere default-ON.
- **Già validati live:** form-fill `kind=fill` su `https://www.selenium.dev/selenium/web/web-form.html`
  (`browser-step[done]: fill`, valore `Fabio Test` nello snapshot); F3-deep con
  `HOMUN_DEBUG_MAIN_LOOP_MAX_TOKENS=1` sul solo loop principale → log `[answer] empty answer body
  (finish_reason=stop) → forced synthesis` e risposta finale prodotta dalla sintesi.
- **Backlog più profondo (con scoping dedicato):** scope agentico oltre read/gather (scritture single-
  threaded+approval); ritirare `merge_plan` per-titolo + prompt-prosa di control-flow (solo se/quando il
  piano-come-tool della 0021 prende forma); doc stantii (ADR 0006 / i due `2026-05-28-openclaw-*` hanno già
  il banner stale, ma andrebbero allineati).

GIÀ FATTO sessione 5g (NON ripartire; tutto su `main`):
- ADR 0021 (decisione single-loop) + banner stale su 0020/0016.
- F1 typo tool browser → no Composio/404 (`f34a399e`); #1 titolo isola live; reasoning collassato live
  (anche `<think>` inline, `85e19dc3`+`bf85c2ed`); #2 isola persistente; planner `confidence` tollerante
  (`ea5d169e`); F2 pivot-su-ricerca (`7bd46495`); SELF-HEAL CDP-wedge nel path motore #1 (era il
  "bloccato", `6609441c`); liveness pannello Computer (`b5745b2c`); autonomia/fine "continua"
  (`is_final_round` da `rounds_since_progress`, `86c0e435`).
- **form-fill `kind=fill`** (`a62cfba9`, sidecar TS): contratto schema-piatto chat `{kind,ref,text}` vs
  `case "fill"` che iterava `action.fields` → `resolveFillFields` accetta entrambe (#5). +1 test.
- **#5 / #3 UI**: #5 formattazione progressiva è streaming-aware; #3 il pannello computer ha bar/
  expanded/full e la freccia su del compatto apre `full` (il thumbnail apre `expanded`).
- **F4 loop ripresa-piano** (`cfd270c9`, backend, GATED `HOMUN_PLAN_STALL_ABORT`): contatori recovery
  per-turno → segnale cross-turno (`stall_turns`/`last_resume_done` sulla memoria del piano, preservati
  negli upsert mid-turno); dopo cap=3 `block_stalled_step`; terminazione su **`settled`** (done|blocked)
  non solo `complete`; `blocked` sticky in `merge_plan`. Puri testati, +5 test, 33/33 piano verdi.
- **F3-deep risposta vuota** (`7fddd545`, backend; validato live in questa sessione): body-vuoto/
  solo-reasoning non più committato → `break` senza `final_done` → sintesi forzata esistente recupera
  (riuso, no terzo path). La variante debug `HOMUN_DEBUG_MAIN_LOOP_MAX_TOKENS` abbassa solo il budget
  del loop principale e lascia la sintesi forzata col budget normale.
- **F2.2 promosso + search discovery + Computer fullscreen** (2026-06-29, follow-up live): il DB della
  chat mostrava runtime-plan `.invalid` con `done_count=1/2`, `s2=doing`, mentre la risposta aveva già
  registrato onestamente il fallimento. `plan_reconcile_on_delivery_enabled` è ora default-on con opt-out
  `HOMUN_PLAN_RECONCILE=0/off`; aggiunto test sul flag. Il system prompt browser ora dice che per news/
  ricerche aperte senza sito nominato deve partire da search/discovery e poi scegliere fonti, invece di
  saltare direttamente a una testata. La freccia del Computer dock da `bar` apre `full`; contract UI verde.
- **Follow-up screenshot 16:39 — streaming/browser recovery:** la query news ora parte correttamente da
  Google News in italiano (`hl=it&gl=IT`), ma sono emersi 3 bug: (1) il renderer mostrava marker
  `‹‹/REASONING››` stray/malformati durante lo streaming → `RichMessage` ora rimuove
  `STRAY_REASONING_MARKER_RE` (+ contract UI); (2) su `BROWSER_STALE_REF` il modello ripeteva lo stesso
  ref → il recovery message ora dice esplicitamente `Do NOT retry e...` e impone un nuovo ref dallo snapshot
  (+ test); (3) F2.2 aggiornava lo store runtime ma lasciava il `‹‹PLAN››` della risposta finale con ultimo
  step `[ ]` → `replace_latest_plan_marker` riscrive il marker consegnato dopo il reconcile (+ test).
- **Follow-up Computer dock:** il bottone compatto usava una chevron su (simbolo sbagliato per "espandi")
  e il dock era dentro `.chat-status-stack { pointer-events:none }` senza riabilitare gli eventi → click
  non affidabile/non funzionante. Fix: icona compatta `Maximize2`, click `bar→full`, `.cc-dock/.cc-scrim`
  `pointer-events:auto`; contract UI + build desktop verdi.
- **Follow-up Computer full + prenotazioni:** il `full` era `position: fixed` sull'intera viewport, quindi
  poteva espandersi sotto la sidebar e restare visivamente stretto; ora resta dentro `.chat-status-stack`
  con larghezza `min(980px, calc(100vw - 390px))`, quindi si apre nella posizione operativa del dock ed è
  molto più grande. Per prenotazioni/acquisti, se manca un parametro critico e il modello ha solo un default
  probabile dal contesto, il system prompt ora impone stop + `CHOICES` (conferma default / scelta libera)
  prima di procedere. Contract UI, test backend mirato, build desktop e build gateway verdi.
- **Spec Vault + acquisti approvati** (`docs/superpowers/specs/2026-06-29-vault-purchase-approval-design.md`):
  direzione MVP approvata con Vault separato dalla memoria, classificatore sensibile + redaction,
  categorie interne (`payments`, `identity`, `health`, `vehicles`, `credentials`, `private_notes`),
  carta salvabile senza CVV, PIN locale + CVV one-shot per autorizzare il pagamento, click finale solo
  dopo `Payment Approval Card` e invalidazione se merchant/importo/prodotto/metodo cambiano.
- **Piano + primi slice Vault** (`docs/superpowers/plans/2026-06-29-vault-purchase-approval-implementation.md`):
  creata crate `local-first-vault` con classifier/redactor deterministico per carte, CVV one-shot,
  codice fiscale, targhe, salute e credenziali; `local-first-memory` ora redige questi valori prima
  della persistenza normale; aggiunto skeleton `VaultRecord`/`InMemoryVaultStore` con metadati separati
  da `SecretRef` e rifiuto esplicito di CVV/CV2 nei metadati.
- **Vault MVP foundation completata**: aggiunti `VAULT_PROPOSE` backend/frontend, policy
  `PaymentApprovalSnapshot` con invalidazione su checkout mutato, variante browser safety
  `high_risk_reason_with_payment_approval` che sblocca solo final payment click con
  `payment_approval_id` combaciante; mappa `docs/architecture/vault.md` creata e linkata da memoria/browser.
- **Vault proposal accept/dismiss**: `local-first-vault` ora ha store SQLite metadata-only,
  il gateway apre `~/.homun/vault.sqlite` e espone `/api/vault/proposals/accept|dismiss`;
  la card `VAULT_PROPOSE` in chat salva o scarta esplicitamente. Il record conserva solo
  categoria/label/preview redatta + `SecretRef`, non il valore sensibile ne' CVV/CV2.
- **Vault PIN locale**: aggiunto `LocalPinVerifier` con salt/hash iterato, persistenza
  metadata-only in `vault_local_pin`, endpoint gateway `/api/vault/pin/status|setup|verify`
  e bridge frontend. Aggiunta sezione Settings separata `Vault` per configurare/verificare
  il PIN, fuori da Memory. Corretto il bypass: se il PIN e' gia' configurato, cambiarlo
  richiede `current_pin` valido; non basta avere accesso al computer e impostarne uno nuovo.
- **Vault crypto locale**: aggiunta master key Vault cifrata dal PIN in `vault_local_keyring`;
  primo setup PIN crea la key, cambio PIN autorizzato la re-cifra sotto il nuovo PIN. Aggiunta
  `vault_secret_material` cifrata con la master key: `/api/vault/proposals/accept` puo' ora
  salvare `secret_value` solo con PIN valido, lasciando nel record solo metadati redatti. Le
  card chat correnti non trasportano raw secret, quindi restano metadata-only; i valori raw
  entrano dal form dedicato in Settings > Vault. Migrazione legacy: se un PIN esisteva gia' senza keyring, il primo
  salvataggio Vault con PIN valido crea la master key; anche il primo cambio PIN verificato la crea e la re-cifra
  sotto il nuovo PIN.
- **Vault input dedicato**: Settings > Vault ora include un form separato dalla chat per salvare
  manualmente dati sensibili raw. Il renderer invia `secret_value` solo insieme al PIN locale
  sull'accept path gia' cifrato del gateway, poi svuota valore e PIN dallo stato UI. Questo chiude
  il buco pratico del secret-store: le card chat restano metadata-only, mentre i valori reali si
  inseriscono da una superficie dedicata fuori dal transcript.
- **Vault UI polish**: aggiunto gap dedicato tra le card del pannello Vault e rimosso il mix di lingue
  introdotto dall'input manuale. Il pannello Vault e le sue label di navigazione passano ora da i18n
  (`it`/`en`), inclusi badge/status/errori/placeholder.
- **Vault tab layout**: il pannello Vault ora segue il pattern segmented-tabs dei Connectors, con
  schede separate `Dati sensibili` e `PIN locale`. Il salvataggio dei secret resta il default operativo,
  mentre setup/verifica PIN e relativi messaggi sono isolati nella seconda scheda.
- **Vault record list/delete**: aggiunto read-model metadata-only `GET /api/vault/records` e
  delete `DELETE /api/vault/records/{id}`. Settings > Vault > Dati sensibili mostra i record salvati
  con categoria/label/preview redatta, ricarica dopo salvataggio e consente eliminarli. Il delete
  cancella anche l'eventuale `vault_secret_material`, evitando secret cifrati orfani.
- **Vault record edit metadata-only**: aggiunto `PATCH /api/vault/records/{id}` e bridge/UI per modificare
  categoria + label dei record salvati da Settings > Vault > Dati sensibili. L'edit preserva
  `SecretRef`, `redacted_preview` e materiale cifrato; corretta anche la regressione per cui la lista dei
  record era finita nella scheda PIN invece che in `Dati sensibili`.
- **Vault lista-first + Add modale**: la scheda `Dati sensibili` ora apre prima la lista dei record salvati
  con azioni `Add`/`Refresh`; l'inserimento raw si fa in una modale themed (`set-modal`) e chiusura/salvataggio
  svuotano valore e PIN dallo stato renderer.
- **Vault edit con unlock PIN**: aggiunto reveal dedicato `POST /api/vault/records/{id}/reveal` e update
  secret opzionale su `PATCH /api/vault/records/{id}`. L'edit inline continua a mostrare solo metadati; per
  vedere/correggere il valore cifrato richiede PIN locale, poi riscrive il secret cifrato e svuota lo stato
  alla chiusura/salvataggio.
- **Vault edit save CORS**: corretto il blocco browser su `PATCH /api/vault/records/{id}`. Il gateway
  accettava la route, ma il CORS dichiarava solo `GET,POST,DELETE,OPTIONS`, quindi Chromium falliva il
  preflight e la UI mostrava il generico `Failed to fetch`. Aggiunto test di preflight `PATCH`.
- **Privacy Guard pre-turn per Vault**: aggiunto gate prima del loop chat. Il guard prova il ruolo
  modellistico locale `privacy_guard` (solo endpoint loopback e modello non `:cloud`), valida che i
  secret siano sottostringhe esatte del prompt e altrimenti usa il classifier deterministico come safety
  net. Se rileva dati sensibili, non chiama il modello chat: lo stream `Done` porta `redacted_user_text`,
  il frontend committa il messaggio utente redatto e l'assistant mostra solo `VAULT_PROPOSE` con
  `pending_id`. Il raw resta nel sidecar volatile.
- **Vault proposal UX/policy fix**: la card `VAULT_PROPOSE` ora usa i token tema (niente card chiara
  hardcoded), non chiede PIN per salvare e si compatta dopo save/dismiss. L'accept salva un record
  metadata-only con `pending_id`; il PIN serve quando l'utente fa reveal/edit, momento in cui il gateway
  materializza il pending, lo cifra in `vault_secret_material` e consuma il sidecar.
- **Vault lookup nel loop chat**: corretto il caso "qual e' il mio codice fiscale?" dopo salvataggio
  Vault. Il modello prima poteva consultare solo memoria normale e quindi negava il dato; ora `recall_memory`
  prova internamente il Vault solo se la memoria non trova righe pertinenti. Il fallback cerca solo metadati
  redatti (`id`, `category`, `label`, `redacted_preview`) e istruisce il modello a dire che il record esiste
  nel Vault e richiede PIN locale per reveal/edit, senza esporre o inferire il valore. Il Vault non viene
  presentato come MCP/tool autonomo.
- **Vault reveal in chat**: aggiunto marker `VAULT_REVEAL` e card renderer PIN-gated. Quando il fallback
  Vault di `recall_memory` trova un record e l'utente chiede il valore, il modello puo' emettere la card:
  la UI chiede il PIN locale, chiama `/api/vault/records/{id}/reveal` e mostra il valore solo nello stato
  locale del componente, senza riscriverlo nel transcript.
- **Payment Approval runtime MVP**: aggiunto marker `PAYMENT_APPROVAL`, card chat con
  riepilogo merchant/dominio/importo/prodotto/metodo, endpoint
  `/api/vault/payment-approvals/approve` con PIN locale + CVV/CV2 one-shot, grant volatile
  TTL 300s e rewrite del messaggio sorgente per lasciare nel transcript solo
  `payment_approval_id` (mai PIN/CVV). `browser_act` ora accetta
  `vault_secret:"cvv_one_shot"` con `payment_approval_id`: il gateway inserisce localmente
  il CVV nel browser e lo consuma una sola volta. Il click finale resta dietro
  `high_risk_reason_with_payment_approval`.
- **Checkout controllato Vault**: aggiunto test end-to-end di gateway per il flusso payment approval
  (messaggio con `PAYMENT_APPROVAL` → PIN/CVV → grant volatile → rewrite transcript → final-click
  bloccato/sbloccato → CVV one-shot consumato). Nel farlo emerso e corretto un bug di
  `ChatStore::message`: il select non includeva `attachments_json`, quindi ogni lookup singolo via
  `message_from_row` falliva con `InvalidColumnIndex(10)` e poteva impedire i rewrite delle card.
- **Roadmap produzione Homun**: creata `docs/superpowers/plans/2026-06-30-homun-production-roadmap.md`
  come piano operativo per non buttare il lavoro fatto e avvicinare il prodotto alla beta:
  baseline/smoke, hot-path memoria, retrieval vettoriale indicizzato, structured chat events,
  browser reliability, Vault/payment production slice, readiness release e modularizzazione mirata
  del gateway. Prossimo passo raccomandato: Fase 0 + Fase 1 (baseline e misure memoria), non refactor
  globale.
- **Roadmap produzione avviata (Fase 0/1)**: aggiunto `scripts/production_smoke.py` con gli 8 scenari
  baseline (chat, memoria, Vault reveal/propose, browse, form-fill, URL morto, payment approval) e
  flag opzionale `HOMUN_RUN_PRODUCTION_SMOKE=1` dentro `scripts/pre_release_gate.py`. Aggiunto anche
  timing redatto della recall memoria (`[memory] memory recall: ...`) sotto `HOMUN_DEBUG=1`: misura
  lock wait, FTS, embedding query, vector scan, graph context, candidate count e stato degraded senza
  loggare prompt o memoria. Smoke live dopo restart gateway: S1 passato in 6.7s con
  `query_embedding_ms=1477`, lock/FTS/vector ~0; S3 Vault reveal passato in 61s con
  `VAULT_REVEAL` e plaintext vietato assente, recall `query_embedding_ms=224`, `fts_ms=2`, lock 0.
  Prossimo passo tecnico: cache/budget query embedding, poi spike indice vettoriale.
- **Memory hot-path cache/budget**: aggiunta cache in-process LRU/TTL per embedding query della recall,
  keyed su endpoint embedding, modello, workspace e query normalizzata (`HOMUN_MEMORY_QUERY_EMBED_CACHE_MAX`,
  `HOMUN_MEMORY_QUERY_EMBED_CACHE_TTL_SECS`). Aggiunto budget `HOMUN_MEMORY_QUERY_EMBED_TIMEOUT_MS`
  (default 700 ms): se l'embedding della query fallisce o va in timeout, la recall degrada a FTS +
  briefing sempre-attivo invece di bloccare il turno; il log redatto espone ora `query_embedding_cache_hit`
  e `query_embedding_timed_out`. Test verdi: `memory_recall`, `memory_query_embedding_cache`, `vault_`,
  `scripts.test_pre_release_gate`, `scripts.test_production_smoke`, `test:ui-contract`, build gateway.
  Smoke live dopo restart gateway: S1 primo giro PASS 7.8s (`query_embedding_ms=163`, cache miss),
  secondo giro PASS 3.2s (`query_embedding_ms=0`, `query_embedding_cache_hit=true`). Prossimo passo:
  spike indice vettoriale `sqlite-vec`/`usearch` senza cambiare la semantica RRF.
- **Memory vector index contract (Fase 2 slice 1)**: aggiunto `crates/memory/src/vector_index.rs`
  con trait `MemoryVectorIndex`, `VectorHit` e backend `ExactMemoryVectorIndex`. `MemoryFacade` espone
  ora `search_embeddings`; `SQLiteMemoryStore` costruisce una proiezione exact dagli embedding canonici
  SQLite e il gateway usa questa API nel pass semantico della recall, applicando ancora floor 0.5/top 8.
  Nessuna dipendenza ANN ancora: e' un taglio di confine testato per poter sostituire il backend con
  `sqlite-vec`/`usearch` senza cambiare RRF o prompt. Test verdi: `local-first-memory exact_index`,
  `facade_searches_embeddings_through_vector_index_contract`, `memory_recall_timing_trace_is_stable...`,
  `memory_query_embedding_cache`, build gateway. Smoke live dopo restart gateway: S1 PASS 9.3s anche con
  `query_embedding_timed_out=true`/`degraded=true` (`vector_scan_ms=none`), confermando il fallback
  FTS + briefing senza blocco turno. Prossimo passo: spike backend ANN persistente e packaging macOS.
- **Memory vector index cache**: `MemoryFacade::search_embeddings` ora costruisce lazy e riusa
  l'indice vettoriale per scope user/workspace; `upsert_embedding` aggiorna la cache se gia'
  materializzata. Questo non cambia ranking/RRF e toglie la ricostruzione dell'indice a ogni
  recall caldo. Aggiunto test `facade_vector_index_cache_updates_after_embedding_upsert`;
  build gateway verde.
- **Spike ANN memoria**: provato `sqlite-vec 0.1.10-alpha.4` come feature opzionale, ma il crate
  pubblicato su crates.io non compila su macOS ARM (`sqlite-vec.c` include `sqlite-vec-diskann.c`,
  file assente nel pacchetto). La feature e la dipendenza NON sono state introdotte. Decisione
  operativa: non usare `sqlite-vec` finche' il pacchetto pubblicato non e' buildabile; prossimo
  candidato dietro lo stesso `MemoryVectorIndex` = `usearch`, oppure vendoring `sqlite-vec` solo con
  ADR esplicita.
- **Memory ANN default / usearch**: `local-first-memory` abilita ora di default la feature
  `usearch-index`; `MemoryFacade` usa `MemoryVectorIndexCache`, che materializza
  `UsearchMemoryVectorIndex` per gli scope con embedding e resta `usearch-pending` se lo scope
  e' vuoto fino al primo upsert. `ExactMemoryVectorIndex` rimane fallback compilabile con
  `--no-default-features`. Test verdi: `facade_uses_usearch_as_default_vector_index_backend`,
  `cargo test -p local-first-memory`, fallback `--no-default-features` su exact + facade search.
  Idea aperta: Postgres/pgvector e graph DB Docker hanno senso come backend remoto/dev-benchmark
  dietro adapter, non come sostituzione immediata dello store SQLite local-first canonico.
- **ChatStreamEvent canonico (migrazione ampia, primo taglio)**: introdotto il contratto
  `GenerateStreamEvent`/`CoreChatStreamEvent` con `delta`, `reasoning`, `activity`,
  `plan_update`, `choice_prompt`, `vault_propose`, `vault_reveal`, `payment_approval`,
  `tool_result`, `done`, `error`. Il gateway espande centralmente i vecchi delta marker
  (`ACT/PLAN/REASONING/CHOICES/VAULT/PAYMENT`) in eventi NDJSON tipizzati prima del delta legacy;
  `listenChatStreamDelta` resta wrapper/filtro compat. I nuovi messaggi salvano anche
  `chat_messages.event_parts_json` derivato dai marker, così il rendering storico non dipende
  solo dal testo. Secondo taglio: `ChatView` ascolta `listenChatStreamEvent`, conserva
  `eventParts` live per messaggio e usa i payload tipizzati per Choice/Vault/Payment/Plan prima
  del fallback marker. Terzo taglio: l'API messaggi espone `event_parts` e il frontend li idrata
  su reload/storico. Quarto taglio: rimosso il ponte live `eventParts`→marker; il testo streaming
  resta solo prosa e anche il pannello Piano legge `plan_update` strutturato prima dei marker
  legacy. Quinto taglio: `seedAssistantMessage` accetta `event_parts` espliciti e le nuove choice
  card di proattività salvano `choice_prompt` strutturato senza `‹‹CHOICES››` nel testo. Restano
  fallback marker solo per chat vecchie/non migrate. Sesto taglio: `ChatView` scarta i delta-marker
  legacy completi quando sono già arrivati come eventi strutturati, così la prosa live non si
  contamina con token display. Settimo taglio: il gateway non emette più il delta-marker legacy
  per default quando un marker è convertibile in evento strutturato; compat esterna opt-in con
  `HOMUN_STREAM_LEGACY_MARKER_DELTAS=1`.
- **Structured events / choice scope / stop stream**: chiusa la regressione live del 2026-07-01 dove
  una choice card generica ("Confermo") riprendeva un open-loop globale del treno: le risposte brevi
  da choice non iniettano piu' `OPEN LOOPS` globali e devono essere interpretate dalla cronologia del
  thread corrente. Il frontend ora conserva `event_parts` strutturati anche nel messaggio finale
  restituito dal gateway, evitando che Plan/Choice/Work island spariscano dopo `done`. `cancelChatPromptStream`
  non e' piu' no-op: chiude il WebSocket dello stream per `request_id`. Resta da validare live se serve
  anche una cancellazione backend/provider hard per task browser gia' in corso dopo chiusura socket.
  Il prompt di sistema forza inoltre le richieste esplicite di piano verso `update_plan`/`PLAN_PROPOSE`
  invece di piani liberi in prosa.
- **Live follow-up structured events**: il test reale ha mostrato due buchi residui: (1) la choice
  standalone "Fammi scegliere tra Confermo e Cambio idea..." veniva ancora contaminata da RAG/memoria
  cross-thread e proponeva il vecchio treno; ora le richieste standalone/meta di choice card saltano
  sia open-loop globali sia `relevant_memory_for_prompt`, mentre un task concreto che chiede una card
  mantiene la memoria. (2) il piano test ha prodotto solo marker (`PLAN`/`ARTIFACT`) + risultato dentro
  `REASONING`; ora il guard F3 forza la sintesi quando il corpo visibile combinato e' vuoto anche se
  `accumulated` contiene marker. `example.com` nel test concorrente ha completato e scritto risposta
  nel DB; se la UI resta bloccata, il prossimo taglio e' stato stream/render o cancellazione backend hard.
- **Live follow-up 2 (concorrenza choice/plan/example)**: `example.com` continua a completare nel DB.
  La choice era ancora contaminata perche' il profilo personale always-on nelle chat personali iniettava
  fatti episodici/open-loop anche senza RAG; ora per richieste standalone/meta di choice-card il profilo
  personale e' limitato alle preferenze. Il piano mostrava anche una card falsa: `chat_store` derivava
  `choice_prompt` da un marker `CHOICES` citato dentro `REASONING`; ora i marker annidati nel reasoning
  non producono card/eventi persistiti.
- **Live follow-up 3 (click su choice card)**: la richiesta standalone di choice ora e' pulita, ma il
  click `Confermo` riapriva comunque memoria/profile globali tramite un gate diverso da quello degli
  open-loop. Consolidato il gate cross-thread: conferme/choice brevi (`Confermo`, `cambio idea`, `ok`,
  `procedi`, ecc.) saltano sia open-loop sia RAG `relevant_memory_for_prompt`, e il profilo personale
  resta in modalita' sole preferenze. Test verdi:
  `cargo test -p local-first-desktop-gateway short_choice_replies_do_not_inject_global_open_loops -- --nocapture`,
  `cargo test -p local-first-desktop-gateway standalone_choice_card_requests_do_not_inject_cross_thread_memory -- --nocapture`,
  `cargo build -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `npm --prefix apps/desktop run test:ui-contract`.
- **Live follow-up 4 (due chat avviate insieme)**: evidenza DB/endpoint: il piano ha completato,
  mentre il secondo thread era rimasto con solo `ready` ma compariva ancora in `/api/chat/active_streams`.
  Root cause osservata: lo stream registry viene creato prima del primo evento/commit; se una richiesta
  resta muta in preflight, la UI vede un busy fantasma. Ora gli stream senza alcun evento scadono dal
  busy dopo 30s, separati dagli stream con attivita' reale che mantengono il timeout lungo 180s. Test
  verdi: `cargo test -p local-first-desktop-gateway silent_stream_entry_counts_as_stale_for_activity -- --nocapture`,
  `cargo test -p local-first-desktop-gateway idle_stream_entry_counts_as_stale_for_activity -- --nocapture`,
  `cargo build -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `npm --prefix apps/desktop run test:ui-contract`.
- **Live follow-up 5 (rilancio doppio dopo fix)**: choice standalone + click `Confermo` validati live:
  nessuna contaminazione con treni/preventivi, risposta scoped al test della card. Il thread piano ha
  completato dopo ~35s e `active_streams` e' tornato vuoto, quindi il busy fantasma non resta appeso.
  Bug residuo trovato: il testo finale diceva completato ma il marker `PLAN` persistito restava 1/2
  perche' il ramo di sintesi/fallback collassava il piano senza riapplicare la riconciliazione
  dell'ultimo step aperto. Ora il `Done` finale riconcilia il marker anche in risposta normale e
  forced-synthesis. Test verdi:
  `cargo test -p local-first-desktop-gateway reconcile_final_plan_marker_closes_last_open_step_on_delivery -- --nocapture`,
  `cargo test -p local-first-desktop-gateway replace_latest_plan_marker_updates_delivered_plan_status -- --nocapture`,
  `cargo test -p local-first-desktop-gateway short_choice_replies_do_not_inject_global_open_loops -- --nocapture`,
  `cargo build -p local-first-desktop-gateway --bin local-first-desktop-gateway`,
  `npm --prefix apps/desktop run test:ui-contract`.
- **Browser live panel / espansione**: il dock `ChatComputerPanel` in modalità full ora esce dallo
  status stack e si ancora `fixed` dentro l'area chat, a destra della sidebar; il compact expand usa
  `Maximize2` e il pannello full è più largo (`min(1040px, ...)`) senza scivolare sotto il drawer.
  Aggiornato `test:ui-contract` per bloccare la regressione. Verifiche verdi:
  `npm --prefix apps/desktop run test:ui-contract`, `npm --prefix apps/desktop run build`.
- **Electron dev liveness**: fixato crash/uscita dopo pochi secondi del dev shell: `BrowserWindow`
  ora è trattenuta in una `Set` main-process e rilasciata solo su `closed`, evitando GC/chiusura
  silenziosa che faceva terminare Electron e quindi anche il gateway. Contratto UI aggiornato.
- **Browser discovery locale**: rafforzata `browser_open_research_discovery_instruction`: per news
  correnti/ricerche web aperte senza sito esplicito il loop deve partire da search/discovery, non
  da una singola fonte, e deve allineare lingua del prompt + locale browser (`hl=`/`gl=` quando
  usa URL di ricerca/news). Test verde:
  `cargo test -p local-first-desktop-gateway browser_method_guides_open_ended_news_through_discovery_first`.
- **Production smoke S9**: aggiunto scenario dichiarativo `Italian locale web discovery` a
  `scripts/production_smoke.py` per rendere esplicita la regressione vista live (news tech IT deve
  partire da discovery/search e non da una singola testata). Test verdi:
  `python3 -m unittest scripts.test_production_smoke`, `python3 scripts/production_smoke.py --list`.
- **bug "Continue" (validato live nell'app — puzzle Einstein ora 1 risposta pulita):** 2 cause distinte —
  (1) backend `df65d0b0`: il trace `‹‹REASONING››` rientrava nel contesto modello via
  `build_chat_runtime_prompt` → `strip_display_markers` canonico in lib.rs usato in `normalize_context_text`,
  `strip_chat_markers` del gateway converge (#5/#13); (2) frontend `f31e3f48`: `isLikelyIncompleteMessage`
  marcava incompleto su `gen≥96% maxTokens` (falso positivo su reasoning model) → ora near-max conta solo
  se il testo finisce anche a metà.
GIÀ FATTO prima (5b–5f): F3.1/3.2/3.2c driver+arg-fill+agentic (gemma4); F3.3 routing drive dietro
`HOMUN_DRIVE_CHAT` (default OFF, con ADR 0021 NON è più il target). Il drive resta default-OFF e NON va esteso.

SCOPERTE/STRUMENTI CONCRETI da riusare:
- Ruoli modello in `~/.homun/providers.json`: `browser`=minimax-m3 (debole), `orchestrator`=deepseek
  (capace). `chat` default = deepseek-v4-pro:cloud.
- ⚠️ **GOTCHA-CHIAVE (sessione 5g): un PROCESSO IN ESECUZIONE non ricarica un binario ricompilato.** Se
  l'`electron:dev` gira da prima di un commit Rust, sta eseguendo il vecchio codice in memoria anche dopo
  `cargo build` — i fix NON sono attivi finché non si RIAVVIA. Sintomo: il test mostra comportamento pre-fix.
  Verifica: `ps -o lstart` del PID gateway vs orario commit; `pgrep -f target/debug/local-first-desktop-gateway`.
  Per testare i fix Rust: chiudi l'albero (`pkill -f scripts/electron-dev.mjs; pkill -f electron/dist/Electron;
  pkill -f target/debug/local-first-desktop-gateway`), `cargo build`, poi rilancia. I fix FRONTEND invece
  arrivano via **Vite HMR** senza riavviare (cerca `[vite] (client) hmr update` nel log).
- **LOG SU FILE (per leggerli senza GUI/terminale dell'utente):** lancia `npm run electron:dev` in background
  redirezionando: `HOMUN_DEBUG=1 HOMUN_PLAN_STALL_ABORT=1 npm run electron:dev > <logfile> 2>&1`. Il gateway
  in dev ha `stdio:inherit` → i suoi log `[plan]`/`[answer]`/`[browser]` finiscono nel file. Diagnosi senza
  GUI = leggere ANCHE il DB `~/.homun/desktop-gateway.sqlite` (`chat_messages.text` GREZZO coi marker:
  conta i blocchi `‹‹REASONING››`, cerca frasi-sintomo). Questa coppia (log-file + DB) ha chiuso il bug Continue.
- DEBUG via curl (gateway standalone): `./target/debug/local-first-desktop-gateway` con `HOMUN_DEBUG=1` +
  `curl -s -X POST :18765/api/chat/generate_stream` (header `Authorization: Bearer
  $(cat ~/.homun/desktop-gateway-token)`, body `{request_id,prompt,thread_id,max_tokens,temperature,wait_if_busy:true}`).
  ⚠️ electron in dev CRASHA se il `cargo run` del gateway ricompila oltre il timeout health-check →
  PRE-COMPILA con `cargo build -p local-first-desktop-gateway --bin local-first-desktop-gateway` PRIMA.
  Per forzare F3-deep: aggiungi `HOMUN_DEBUG_MAIN_LOOP_MAX_TOKENS=1` al gateway; non usarlo per lavoro reale.
- Browser: `browser_act_tool_schema()` ha parametri PIATTI `{kind, ref, text, ...}` (kind include
  scroll); `input_schema` cablato = `function.parameters` (piatto). `browser_method_for_chat_tool`
  mappa i nomi underscore → `BrowserMethod`. `normalize_browser_call` fa il managed-tab. La visibilità
  dipende da `BROWSER_AUTOMATION_USER_CDP_ENDPOINT` = `contained_computer_cdp_endpoint()` (connessione
  al Chromium visibile :9222) vs headless. Il chat-loop spawna `spawn_browser_sidecar_for_chat`
  (per-thread), il drive `call_shared_browser_sidecar`→`spawn_browser_sidecar_for_task` (condiviso).

LEGGI PRIMA: docs/decisions/0021-single-guarded-loop-planning-as-tool.md (la decisione corrente),
docs/architecture/agent-loop.md, e le note in memoria [[homun-single-loop-evidence-verdict]] +
[[homun-browser-drive-regression-diagnosis]] + [[homun-longhorizon-engine]].

AMBIENTE: Ollama gira con gemma4 → `python3 scripts/eval_suite.py gemma4:latest` = gate caposaldo #2
(ALL GREEN dopo tutte le modifiche F3). Container browser `homun-cc` (Docker) up: CDP :9222, noVNC
:6080. `adaptive_floor`="shadow". I file:line di main.rs (52k righe) sono sfasati → usa i nomi di
funzione.

A fine sessione aggiorna docs/STATO.md.
```
