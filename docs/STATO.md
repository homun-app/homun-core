# Stato — Homun (documento vivo)

> Aggiornato a OGNI sessione (vedi [METHODOLOGY.md](METHODOLOGY.md) §6). Resta **conciso**: è
> uno *stato*, non un changelog (lo storico va in `archive/`). Da qui si riparte dopo una
> compattazione o a inizio sessione.
> **Ultimo aggiornamento: 2026-06-28.**

## Dove siamo

- **Linea attiva:** *convergenza dalle fondamenta* →
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
- ⏳ **F3.3** instradare `stream_chat_via_openai` sul `drive` dietro `HOMUN_ORCHESTRATED_CHAT`, validare
  flag-ON vs motore #1 (**il pezzo rischioso sul path VIVO**, non ancora fatto). ⏳ **F3.4** ritirare
  `merge_plan` per-titolo + prompt-prosa di control-flow. ⏳ scope agentico oltre read/gather (scritture).

Mappe: [registry](architecture/capability-registry.md), [skills](architecture/skills.md),
[connectors](architecture/connectors-composio.md), [browser](architecture/browser.md), [mcp](architecture/mcp.md).
NB live-validation (CORRETTO 2026-06-28, sessione 4): **Ollama È installato e gira** (`127.0.0.1:11434`)
con `gemma4:latest` (8B) + `gemma4:12b` — il vecchio "non Ollama" era STANTIO. Quindi la eval
bi-popolazione (caposaldo #2) È eseguibile qui: `python3 scripts/eval_suite.py gemma4:latest`. Modello
chat di default = deepseek-v4-pro:cloud (Z.ai, tier **Balanced**); Composio non configurato.

## Cosa è stato fatto (rolling, conciso)

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

CONTESTO: il sistema ha due implementazioni per ogni sottosistema, la canonica dormiente
(caposaldo #5 violato) → instabilità. Stiamo CONVERGENDO dalle fondamenta (bottom-up):
F0 normalizzazione modello → F1 capability unica → F2 loop tier-adattivo (ADR 0018) →
F3 un motore (ADR 0016/0020). Niente cerotti, niente terza implementazione: si cabla la
canonica e si ritira il parallelo; si rimuove il codice morto toccato; si splittano i file
grossi; si commenta il perché; ogni modifica aggiorna la pagina architecture/ + cita il
caposaldo + porta un test.

PROSSIMO PASSO: F3.3 — INSTRADARE IL TURNO sul driver di motore #2 (il pezzo rischioso, sul path
VIVO). La FONDAZIONE di F3 è già costruita e validata su gemma4 (driver in-turn + arg-fill, vedi
sotto): NON ripartire da lì. Leggi PRIMA docs/decisions/0020-*.md + 0016-*.md +
docs/architecture/agent-loop.md (sezione "Il driver in-turn" + "I DUE motori").

OBIETTIVO: instradare `stream_chat_via_openai` sul `OrchestratorBrain::drive` dietro
`HOMUN_ORCHESTRATED_CHAT`, ritirando il loop prompt-prosa di motore #1 e `merge_plan` per-TITOLO
(identità = `step_id`, mai dal testo — caposaldo #6). 3 invarianti: monotonìa, limitatezza, identità
non inferita (tutte già garantite dal driver per costruzione).

GIÀ FATTO E VALIDATO SU GEMMA4 (non ripartire da qui):
- F3-planner: F1.d (browser nel registry), risoluzione tollerante tool_name (#11), enum tool nello
  schema planner (#6). Test: `orchestrated_planner_sees_browser_on_gemma4` (ignored).
- **F3.1 driver** (`crates/orchestrator/src/driver.rs` `drive_plan`): control-flow dell'harness, passo
  avanti su piano topologico (`validate_plan`), `StepExecutor`/`StepVerifier` iniettati, done dopo
  verify, 3 invarianti per costruzione. 7 unit-test puri. Commit `b705289a`.
- **F3.2 esecuzione per-step + arg-fill** (`step_executor.rs` `CapabilityStepExecutor<R>`, `Brain::drive`):
  args vuoti del piano-seme → il modello li riempie vincolato allo schema del tool (ADR 0016 P3) →
  `CapabilityFacade::call_tool`. Commit `3ce99c67`. Test: `orchestrated_brain_drives_plan_on_gemma4`
  (plan→driver→arg-fill→execute→done).
- **F3.2c esecutore agentico** (`agentic.rs` `run_agentic_step`): modalità *agent* ADR 0016 P2, loop
  bounded read/gather, due fasi/round (scelta tool enum + `fill_arguments`). Commit `3027abe4`. Test:
  `orchestrated_subagent_gathers_on_gemma4` (gemma4 raccoglie e sintetizza).

SCOPERTA CHIAVE (de-rischia F3.3): la facade del gateway ha GIÀ un `CapabilityProvider` browser reale
(main.rs ~`call_shared_browser_sidecar`) → `drive`→`call_tool` riusa gli esecutori durabili canonici.
NIENTE terzo dispatch: la `chat_browser_call` inline di `stream_chat_via_openai` (un grosso match
inline, NON un seam estraibile) è la PARALLELA da ritirare, non da replicare.

INCREMENTI RIMASTI (gated dietro flag, verde a ogni passo, validati su gemma4): **F3.3** instrada il
turno sul `drive` (quando non c'è piano da riprendere E flag ON: pianifica via `orchestrator_plan_for_chat`
→ `drive` invece di seminare il loop), streama progresso + sintesi finale, valida flag-ON vs motore #1
zero-regressioni; **F3.4** ritira `merge_plan` per-titolo + prompt-prosa; estendi lo scope agentico
oltre read/gather (scritture single-threaded+approval).

⚠️ **F3.3 RICHIEDE L'APP IN ESECUZIONE** (decisione 2026-06-28 sessione 5): è integrazione sul path
streaming VIVO, non validabile coi test ignored. Due entanglement da osservare dal vivo: (1) `drive`
esegue sulla **facade reale** (provider browser→**sidecar condiviso** ~`call_shared_browser_sidecar`),
mentre il loop di chat usa `chat_browser_call` (**sessione per-thread**) → **rischio collisione** a metà
turno se entrambi toccano il browser. **De-risk consigliato PRIMA di F3.3:** convergere i due path
browser su uno solo (caposaldo #5; `chat_browser_call` è la parallela da ritirare). (2) `drive` produce
esiti per-step, NON la risposta NL finale → serve una sintesi finale (riusa il path sintesi del loop).
Partire da piani semplici (all-CapabilityCall) con fallback a motore #1. Debug: `HOMUN_DEBUG=1
HOMUN_ORCHESTRATED_CHAT=1 npm run electron:dev`.

AMBIENTE: Ollama gira con gemma4:latest/12b → eval bi-popolazione e validazione live SONO possibili
qui (`python3 scripts/eval_suite.py gemma4:latest` = gate di regressione caposaldo #2). Modello chat
default = deepseek-v4-pro:cloud (Balanced). `adaptive_floor` = "shadow" (telemetria F2.1 attiva). Non
accendere il floor a "on" senza eval bi-popolazione. NB: i file:line di main.rs sono sfasati — usa i
nomi di funzione.

Fatto finora: F0 (L0 completo) + F1 COMPLETO+testato + F2 (meccanismo costruito, validato
bi-popolazione) + F3-planner + **F3.1/F3.2/F3.2c: driver in-turn + arg-fill + executor agentico
read/gather, tutti validati su gemma4**. Prossimo = F3.3 (instradamento live).

A fine sessione aggiorna docs/STATO.md.
```
