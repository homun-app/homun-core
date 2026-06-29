# Stato — Homun (documento vivo)

> Aggiornato a OGNI sessione (vedi [METHODOLOGY.md](METHODOLOGY.md) §6). Resta **conciso**: è
> uno *stato*, non un changelog (lo storico va in `archive/`). Da qui si riparte dopo una
> compattazione o a inizio sessione.
> **Ultimo aggiornamento: 2026-06-29.**

## Dove siamo

- **DECISIONE D'ARCHITETTURA (ADR 0021, 2026-06-29):** convergere su **UN loop guardato** (motore #1,
  ReAct + native tool-calling), piano come *tool*, NON un secondo motore plan-execute. Supersede la
  direzione 0020, emenda 0016. Browse instradato a motore #1 (`plan_is_browse_only`). Basata su 3 cluster
  di ricerca + prova empirica. Vedi [decisions/0021](decisions/0021-single-guarded-loop-planning-as-tool.md)
  e [[homun-single-loop-evidence-verdict]].
- **Linea pratica corrente (sessione 5g):** batch di fix chat-UX/funzionali nell'app reale (vedi rolling in
  fondo) — risolti "bloccato" (self-heal CDP del path motore #1), "continua"/autonomia (final-round per
  progresso), reasoning collassato, isola live+persistente, F1/F2/planner. **In coda:** F4 (ripresa-piano),
  form-fill, #3/#5 UI.
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
- ◑ **F2.2 il piano traccia il lavoro** (parziale, gated) — l'over-running guard è stato estratto
  in `answer_concludes_plan` (puro, testato; refactor behavior-preserving) e, quando ACCETTA la
  risposta con l'ultimo step aperto, ora riconcilia quello step a `done` + persiste (riusa il path
  canonico mark-done→`runtime_execution_plan`→`upsert_runtime_plan_memory_from_state`), così il
  turno DOPO non riprende il piano a vuoto. Gated `HOMUN_PLAN_RECONCILE` (default off, hot-path non
  validabile live qui). La sintesi forzata NON riconcilia (lì il lavoro è incompiuto, il piano DEVE
  restare aperto). Resta: validare on; eventuale "done dopo verify" più stretto; il caso sintesi.
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
- **In coda (prossimi):** **F4** (ripresa-piano cross-turno che cicla — il contatore F2/budget è per-turno),
  **form-fill** (`browser_act kind=fill → ERROR` visto nei log), **#3** (espansione pannello computer),
  **#5** (formattazione progressiva — sembra già live ma da verificare), **F3-deep** (modello che a volte
  non produce risposta per cutoff). NB: doc stantii da sistemare (ADR 0006 ha già il banner stale).

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
- **F2.2 (parziale, gated)** over-running guard estratto in `answer_concludes_plan` (puro/testato,
  refactor behavior-preserving); quando accetta la risposta con l'ultimo step aperto, riconcilia
  quello step a `done` + persiste → il turno dopo non riprende il piano a vuoto. Gated
  `HOMUN_PLAN_RECONCILE` (default off). La sintesi forzata non riconcilia (lavoro incompiuto). +1 test.

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

PROSSIMO PASSO (in coda, scegli con l'utente — l'utente lavora a fix concreti chat-UX/funzionali nell'app):
- **F4 — ripresa-piano cross-turno che cicla:** i contatori di recovery (F2 navigate-fail, budget round)
  sono PER-TURNO; un piano RIPRESO (channel/resume) può riavviare lo stesso step fallito all'infinito.
  Serve memoria cross-turno dei fallimenti per-step + stop/abort. Lega a [[homun-longhorizon-engine]].
- **form-fill:** `browser_act kind=fill → ERROR` visto nei log; affidabilità riempimento campi (tecniche
  del lineage che funziona: ref/index-by-element, batch-fill-then-verify, dropdown/autocomplete handler).
- **#3** espansione pannello computer; **#5** formattazione progressiva (sembra già live — verificare);
  **F3-deep** (modello che a volte non produce la risposta per cutoff/budget — diverso dal display).

GIÀ FATTO sessione 5g (NON ripartire; tutto su `main`, validato live nell'app Electron):
- ADR 0021 (decisione single-loop) + banner stale su 0020/0016.
- F1 typo tool browser → no Composio/404 (`f34a399e`); #1 titolo isola live (`f34a399e`).
- reasoning collassato live (anche `<think>` inline) + label EN + strip marker canali (`85e19dc3`+`bf85c2ed`).
- #2 isola persistente (`bf85c2ed`); planner `confidence` tollerante (`ea5d169e`); F2 pivot-su-ricerca (`7bd46495`).
- **SELF-HEAL CDP-wedge nel path di MOTORE #1** — era il "bloccato": `connectOverCDP timeout` su container
  stantio (HTTP ok, ws hung), `browser_cdp_ok` non lo vede; ora la navigate di motore #1 lo rileva
  (`cdp_wedge_signature`) e ricicla (`force_recycle_contained_computer`, throttlato) (`6609441c`).
- liveness pannello Computer "· Xs" + stall ambra (`b5745b2c`).
- **AUTONOMIA / fine "continua"** (`86c0e435`): `is_final_round` ora da `rounds_since_progress` (non dal
  round TOTALE) → un piano lungo ma in avanzamento NON viene più forzato a sintetizzare a metà; va fino in
  fondo (tetto duro 600 round).
GIÀ FATTO prima (5b–5f): F3.1/3.2/3.2c driver+arg-fill+agentic (gemma4); F3.3 routing drive dietro
`HOMUN_DRIVE_CHAT` (default OFF, con ADR 0021 NON è più il target); Increment A pannello drive; B.1 prune
snapshot agentico. Il drive resta default-OFF e NON va esteso.

SCOPERTE/STRUMENTI CONCRETI da riusare:
- Ruoli modello in `~/.homun/providers.json`: `browser`=minimax-m3 (debole), `orchestrator`=deepseek
  (capace). `chat` default = deepseek-v4-pro:cloud.
- DEBUG senza GUI: avvia il gateway STANDALONE (`./target/debug/local-first-desktop-gateway`, con
  `HOMUN_DEBUG=1 HOMUN_DRIVE_CHAT=1`) e pilotalo via `curl -s -X POST :18765/api/chat/generate_stream`
  (header `Authorization: Bearer $(cat ~/.homun/desktop-gateway-token)`, body
  `{request_id,prompt,thread_id,max_tokens,temperature,wait_if_busy:true}`). Leggi i log `[agentic]`/
  `[drive]` (gated HOMUN_DEBUG). ⚠️ electron in dev CRASHA se il `cargo run` del gateway ricompila oltre
  il timeout health-check → PRE-COMPILA con `cargo build -p local-first-desktop-gateway --bin
  local-first-desktop-gateway` PRIMA di lanciare `npm run electron:dev`.
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
