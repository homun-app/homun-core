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

Mappe: [registry](architecture/capability-registry.md), [skills](architecture/skills.md),
[connectors](architecture/connectors-composio.md), [browser](architecture/browser.md), [mcp](architecture/mcp.md).
NB live-validation: setup attuale = deepseek-v4-pro:cloud (Z.ai), non Ollama; Composio non configurato.

## Cosa è stato fatto (rolling, conciso)

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
  `HOMUN_PLAN_RECONCILE` (default off, non validabile live qui). La sintesi forzata non riconcilia
  (lavoro incompiuto). +1 test. Gate gateway **360 pass / 1 ambientale (soffice)**.

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
- `~/.homun/runtime-settings.json` → `adaptive_floor: "off"` (tenere off finché F2 non lo realizza).
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

PROSSIMO PASSO — decisione su due fronti (F2 è "costruito ma gated", il resto serve un ambiente
live). Lo stato: il MECCANISMO di F2 è in piedi — floor adattivo cablato (scaffold_for + workflow_bias
+ verify_depth sotto `adaptive_floor=on`), F2.1 telemetria floor→tool_trace FATTO, F2.2 plan-reconcile
on-delivery FATTO ma gated `HOMUN_PLAN_RECONCILE`. Ciò che MANCA è quasi tutto **validazione su
ambiente live** (Ollama/gemma4 + `scripts/eval_suite.py`), non codice:
 (a) accendere il floor `shadow→on` + manopola `slot` (F2.3) — richiede eval bi-popolazione;
 (b) validare `HOMUN_PLAN_RECONCILE=1` sul loop reale prima di renderlo default;
 (c) eventuale done-dopo-verify più stretto / caso sintesi forzata.
Due strade: (1) se hai un ambiente con Ollama+gemma4, VALIDA e accendi F2 (shadow→on, reconcile→default).
(2) altrimenti avvia **F3 — ADR 0020** (instradare il turno chat su `OrchestratorBrain` come driver DAG
reale, planner chat-tool-aware ora che il browser è nel registry, ritirare `merge_plan` per-titolo):
leggi docs/decisions/0020-*.md + agent-loop.md; ha pezzi puri costruibili qui anche se il giro
end-to-end resta da validare live.
Fatto: F0 (L0) + F1 COMPLETO + F2.1 + F2.2(gated). NB: i file:line di main.rs sono sfasati dopo gli
edit F1/F2 — usa i nomi di funzione.

A fine sessione aggiorna docs/STATO.md.
```
