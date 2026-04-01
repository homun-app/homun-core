# Agente e Cognizione

## Panoramica

Il dominio "Agente e Cognizione" è il cuore computazionale di Homun. Implementa un ciclo ReAct (Reason → Act → Observe) a quattro fasi per ogni richiesta utente:

1. **INGRESS** — preparazione del turno (allegati, selezione modello)
2. **COGNITION** — mini-loop ReAct con discovery tools analizza l'intent dell'utente e produce un piano mirato, una selezione di tool/skill/memoria/RAG rilevanti, e dei vincoli estratti dal linguaggio naturale. In caso di fallimento, si ricade in modalità full-tools.
3. **EXECUTION** — loop ReAct principale (reason → act → observe) con LLM + tool calling, budget iterazioni dinamico
4. **POST-PROCESSING** — consolidamento memoria, tracciamento utilizzo token

L'architettura è implementata in Rust con asincronia `tokio`. I moduli principali sono:
- `src/agent/agent_loop.rs` — struttura `AgentLoop`, entry point delle richieste
- `src/agent/cognition/` — fase di pre-processing (engine, discovery tools, types)
- `src/agent/orchestrator/` — classificazione intent e orchestrazione multi-agente
- `src/agent/prompt/` — assemblaggio system prompt modulare
- `src/agent/iteration_budget.rs` — gestione budget iterazioni
- `src/agent/llm_caller.rs` — invocazione LLM con fallback
- `src/agent/context_compactor.rs` — compressione contesto

---

## Feature: Agent Loop

### Comportamento Atteso

- L'utente invia un messaggio; il sistema risponde dopo aver ragionato, usato tool se necessario, e osservato i risultati.
- Input: testo utente, session key, channel, chat_id, tool bloccati, flag thinking.
- Output: stringa di risposta finale (testo), con eventi di streaming opzionali (piano, delta testo).
- Stati:
  - **Vuoto**: nessun messaggio in corso
  - **INGRESS**: preparazione turno, selezione modello
  - **COGNITION**: analisi intent in corso (emette evento `cognition_start`)
  - **EXECUTION**: loop ReAct attivo, iterazioni LLM + tool
  - **POST-PROCESSING**: consolidamento memoria, tracking usage
  - **Errore**: provider non raggiungibile, budget esaurito, stop forzato dall'utente
  - **Successo**: risposta finale prodotta
- Edge case:
  - Stop forzato dall'utente durante una tool call (flag atomico `stop`)
  - Modello che non supporta native tool calling (auto-detect → XML dispatch)
  - Provider che cambia modello a runtime (rebuild lazy del provider)
  - Budget iterazioni esaurito prima del completamento
  - Loop rilevato (stall detection, cycle detection)

### Dettagli Tecnici

- Moduli: `src/agent/agent_loop.rs`
- La struttura `AgentLoop` mantiene: `provider` (RwLock per swap a runtime), `config`, `context` (ContextBuilder), `session_manager`, `tool_registry` (Arc<RwLock>), `memory`, `skill_registry`, `memory_searcher`, `rag_engine`, `use_xml_dispatch` (AtomicBool), `db`, `agent_id`, `agent_instructions`, `allowed_tools`, `allowed_skills`
- Flusso dati per richiesta:
  1. `process_message` / `process_message_streaming_with_options` riceve la richiesta
  2. Fase INGRESS: selezione modello, preparazione allegati
  3. Fase COGNITION: chiamata a `cognition::run_cognition()` → `CognitionResult`
  4. Fase EXECUTION: loop `for iteration in 0..active_budget` → `llm_caller::call_llm_with_fallback()` → dispatch tool calls → observe results
  5. Check stop flag (`AtomicBool`) ad ogni iterazione e durante le tool call
  6. `iteration_budget::maybe_extend_iteration_budget()` valutato ad ogni iterazione
  7. `execution_plan::note_iteration()` dopo ogni tool result → `PlanAction` (checkpoint/rotation/give-up)
  8. Persist checkpoint su DB per crash recovery (`task_checkpoints` table)
  9. Fase POST-PROCESSING: `memory::MemoryConsolidator`, token usage su DB, cleanup checkpoint
- Tabelle DB: `token_usage` (tracking consumo), `memories` (consolidamento), `task_checkpoints` (crash recovery)
- Endpoint API: nessuno diretto; esposto tramite Gateway (canali)

### Dipendenze

- Da cosa dipende: `cognition`, `llm_caller`, `iteration_budget`, `context_compactor`, `prompt::builder`, `tool_registry`, `skill_registry`, `session_manager`, `provider`
- Cosa dipende da questa feature: `orchestrator` (chiama `process_message`), Gateway (routing canali)

---

## Feature: Cognition-First

### Comportamento Atteso

- Prima di eseguire qualsiasi tool, il sistema analizza l'intent dell'utente con un LLM dedicato (cognition model), producendo comprensione, piano, vincoli e tool selezionati.
- Input: prompt utente, storico conversazione recente (tail 10 messaggi), lista nomi tool/skill/MCP disponibili, contact summary, channel, agent_id.
- Output: `CognitionResult` con understanding, complexity, plan, constraints, tools selezionati, skills, MCP, memory_context, rag_context, intent_type, success_criteria.
- Stati:
  - **In corso**: emette evento streaming `cognition_start` ("Analyzing request...")
  - **Successo**: `CognitionResult` valido prodotto
  - **Fallback**: in caso di errore provider o timeout → `fallback_full_context()` con tutti i tool
  - **Direct answer**: per richieste semplici (saluti, orario, fatti), risposta diretta senza execution loop
- Edge case:
  - Provider non disponibile per il cognition model: retry fino a `MAX_CALL_RETRIES` (3)
  - Timeout per call singola: 60s (standard) / 120s (provider locali tipo Ollama)
  - Modello che restituisce tool come array di stringhe invece di oggetti (deserializzazione flessibile)
  - Tool/skill non esistenti nella risposta LLM: validazione con `validate_cognition_result()`
  - `answer_directly = true` senza `direct_answer`: segnalato come errore di validazione

### Dettagli Tecnici

- Moduli: `src/agent/cognition/engine.rs`, `src/agent/cognition/mod.rs`
- Approccio "plan-first": il modello riceve la lista dei nomi tool nel system prompt e solo `plan_execution` come tool chiamabile. Produce il piano in una singola chiamata LLM (~800 token input, max 1500 output, temperature 0.2)
- Flusso dati:
  1. Raccolta nomi tool/skill/MCP (`collect_known_tool_names`, `collect_known_skill_names`, `collect_mcp_tool_names`)
  2. Build system prompt cognition con `build_cognition_prompt_plan_first()`
  3. Inject storico recente (ultimi `COGNITION_HISTORY_TAIL = 10` messaggi)
  4. Ciclo retry: fino a `max_retries`, con timeout `per_call_timeout`
  5. Parsing risposta: estrazione `plan_execution` tool call → deserializzazione in `CognitionResult`
  6. Validazione con `validate_cognition_result()`
  7. In caso di fallback: `CognitionResult::fallback_full()` con analisi euristica del prompt
- Tabelle DB: nessuna diretta (usa registries in-memory)
- Endpoint API: nessuno diretto

### Dipendenze

- Da cosa dipende: `provider::factory`, `ToolRegistry`, `SkillRegistry`, `discovery` (per raccolta nomi), `types::plan_execution_tool_definition`
- Cosa dipende da questa feature: `agent_loop` (consuma `CognitionResult`), `build_selective_tool_defs`, assemblaggio system prompt

---

## Feature: Discovery Tools

### Comportamento Atteso

- Il modulo discovery espone funzioni read-only che la fase di cognizione usa per trovare risorse rilevanti: tool, skill, servizi MCP, memoria, knowledge base.
- Le funzioni raccolgono nomi da iniettare nel system prompt cognition (non come tool chiamabili direttamente nel loop).
- Input: query testuale, registries (tool, skill), parametri di filtraggio (profilo attivo, perimeter, namespace).
- Output: JSON serializzato con liste di `ToolEntry`, `SkillEntry`, `McpEntry`, `MemoryEntry`, `KnowledgeEntry`.
- Stati:
  - **Successo**: lista JSON di risultati (potenzialmente vuota `[]`)
  - **No match**: restituzione lista completa come fallback (per `discover_tools`)
  - **Registry non disponibile**: stringa `"[]"` (per `discover_skills` senza registry)
- Edge case:
  - Query senza match: `discover_tools` restituisce l'intera lista tool
  - Skill per-profilo: visibili solo se corrispondono al profilo attivo; skill globali (profile_slug=None) sempre visibili
  - Contact perimeter: se `allowed_skills` non è vuoto, solo le skill nell'allow list sono visibili
  - Score minimo parola: solo parole di 3+ caratteri contribuiscono al match

### Dettagli Tecnici

- Moduli: `src/agent/cognition/discovery.rs`
- Funzioni principali:
  - `discover_tools(query, tool_registry)`: substring matching pesato (exact name +10, partial +5, word-level +2 per parola >=3 char); top 7 risultati; fallback a lista completa se no match
  - `discover_skills(query, skill_registry, active_profile_slug, allowed_skills)`: stessa logica di scoring; filtraggio per profilo e perimeter
  - `discover_mcp(query, tool_registry)`: ricerca tra tool MCP registrati
  - `search_memory(query, memory_searcher)`: ricerca vettoriale/ibrida nelle memorie (feature `embeddings`)
  - `search_knowledge(query, rag_engine, allowed_namespaces)`: ricerca RAG nella knowledge base (feature `embeddings`)
- Flusso dati: lettura read-only dei registry tramite `RwLock::read()`, scoring, sort, truncate, serializzazione JSON
- Tabelle DB: nessuna diretta (accede a `memories` e `knowledge` tramite `MemorySearcher` e `RagEngine`)
- Endpoint API: nessuno diretto

### Dipendenze

- Da cosa dipende: `ToolRegistry`, `SkillRegistry`, `MemorySearcher` (feature `embeddings`), `RagEngine` (feature `embeddings`)
- Cosa dipende da questa feature: `cognition::engine` (raccolta nomi per system prompt)

---

## Feature: CognitionResult

### Comportamento Atteso

- `CognitionResult` è il contratto tra la fase di cognizione e il loop di esecuzione principale.
- Prodotto dal LLM chiamando il tool `plan_execution` con schema JSON strutturato.
- Campi obbligatori: `understanding`, `complexity`, `answer_directly`, `intent_type`, `success_criteria`.
- Campi opzionali: `direct_answer`, `tools`, `skills`, `mcp_tools`, `memory_context`, `rag_context`, `plan`, `constraints`, `autonomy_override`.
- Complexity: `simple` (nessun tool), `standard` (1-2 tool), `complex` (multi-step).
- IntentType: `informational`, `transactional`, `navigational`, `creative`.
- Autonomy: `automatic` (esegui senza conferma), `assisted` (chiedi prima di azioni con side-effect).
- Edge case:
  - Modelli che restituiscono tool/skill come stringhe invece di oggetti: deserializzatore flessibile (`visit_str` + `visit_map`)
  - `answer_directly = true` senza `direct_answer`: rilevato da `validate_cognition_result()`
  - Tool non esistenti nel registry: segnalati come `ValidationIssue` (soft warning, non bloccante)
  - `intent_type` non impostato per task non-triviali: soft warning

### Dettagli Tecnici

- Moduli: `src/agent/cognition/types.rs`
- Schema JSON esposto come tool definition (`plan_execution_tool_definition()`) con JSON Schema completo per forzare struttura output LLM
- Metodi costruttori:
  - `CognitionResult::direct(answer)`: per risposte dirette senza execution loop
  - `CognitionResult::fallback_full(all_tool_names, user_prompt)`: costruisce risultato con tutti i tool + analisi euristica del prompt per `intent_type` e `constraints` (bilingue IT/EN)
- Validazione: `validate_cognition_result(result, known_tools, known_skills)` → `Vec<ValidationIssue>`
- Serializzazione: `serde` con `rename_all = "snake_case"` per enum, `#[serde(default)]` per campi opzionali
- Tabelle DB: nessuna
- Endpoint API: nessuno

### Dipendenze

- Da cosa dipende: nessuna dipendenza esterna (solo `serde`, `crate::provider::ToolDefinition`)
- Cosa dipende da questa feature: `cognition::engine` (produce), `agent_loop` (consuma), `build_selective_tool_defs` (legge `tools` e `skills`), assemblaggio system prompt (legge `understanding`, `plan`, `constraints`, `intent_type`, `success_criteria`)

---

## Feature: Selective Tool Loading

### Comportamento Atteso

- Invece di passare tutti i tool disponibili al loop di esecuzione, vengono caricati solo i tool identificati dalla fase di cognizione, più un set di tool sempre disponibili.
- Tool sempre disponibili: `send_message`, `remember`, `approval`, `vault`.
- Regole implicite di associazione tool: se `web_search` o `brave-search__brave_web_search` è selezionato → aggiunge automaticamente `browser` e `web_fetch`; se `browser` → aggiunge `web_fetch`; se `read_email_inbox` → aggiunge `send_message`; se `knowledge` → aggiunge `send_message`.
- Input: lista `DiscoveredTool`, lista `DiscoveredSkill`, tool bloccati, flag xml_mode.
- Output: `ToolDefinitionSet` con definizioni filtrate e metadata.
- Edge case:
  - Tool bloccati (per agent o perimeter): esclusi anche se selezionati dalla cognizione
  - Skill: aggiunta come pseudo-tool con schema `{query: string}`
  - XML mode: genera `ToolInfo` per iniezione nel system prompt invece di native tool calling
  - Nessun tool selezionato: `has_tools = false`, lista vuota

### Dettagli Tecnici

- Moduli: `src/agent/cognition/mod.rs` (funzione `build_selective_tool_defs`)
- Flusso dati:
  1. Build `selected_names` da `discovered_tools` + `always_available`
  2. `apply_implicit_tools()`: aggiunge tool companion in base a regole hardcoded
  3. Lettura `tool_registry.read().get_definitions()` → filter per `selected_names` e `blocked_tools`
  4. Se `skill_registry` presente: aggiunge skill selezionate come `ToolDefinition` sintetiche
  5. In XML mode: crea `Vec<ToolInfo>` per iniezione nel system prompt
  6. Costruisce `ToolDefinitionSet` con `defs`, `tool_infos`, `available_names`, `has_tools`
- Tabelle DB: nessuna
- Endpoint API: nessuno

### Dipendenze

- Da cosa dipende: `CognitionResult` (lista `tools` e `skills`), `ToolRegistry`, `SkillRegistry`
- Cosa dipende da questa feature: `agent_loop` (usa `ToolDefinitionSet` per le chiamate LLM nel loop di esecuzione)

---

## Feature: System Prompt Assembly

### Comportamento Atteso

- Il system prompt viene composto da sezioni modulari, ciascuna implementa il trait `PromptSection`.
- Le sezioni vengono incluse/escluse in base al `PromptMode` (Full, Minimal, None).
- La fase di cognizione inietta nel system prompt: understanding, plan steps, constraints, intent_type, success_criteria.
- Utente finale: vede un agente che risponde in modo contestualizzato e con un piano già elaborato.
- Input: `PromptContext` con tutti i dati di contesto (workspace, model, tools, skills, memoria, RAG, canale, contact, persona, profilo, istruzioni agente, dati cognizione).
- Output: stringa system prompt completa.
- Edge case:
  - Sezioni vuote vengono silenziosamente omesse dal builder
  - Modalità Minimal: saltate le sezioni non essenziali per subagenti
  - Modalità None: solo identità minimale ("You are Homun, a personal AI assistant.")
  - Tool injected come XML quando `xml_mode = true` (sezione ToolsSection)
  - Cognition non disponibile o fallita: campi cognition nel context sono stringhe vuote/slice vuote

### Dettagli Tecnici

- Moduli: `src/agent/prompt/mod.rs`, `src/agent/prompt/builder.rs`, `src/agent/prompt/sections.rs`
- Sezioni standard (in ordine nel builder):
  1. `IdentitySection` — identità Homun, approccio reasoning, bootstrap files (SOUL.md, AGENTS.md, ecc.)
  2. `PersonaSection` — prefisso persona da persona resolver
  3. `ProfileSection` — contesto profilo attivo (linguistica, personalità, capacità)
  4. `AgentInstructionsSection` — istruzioni per-agent da `AgentDefinition`
  5. `ToolsSection` — definizioni tool in XML (solo XML mode) + regole routing
  6. `SafetySection` — regole sicurezza (SEC-7, SEC-13, ecc.)
  7. `SkillsSection` — riepilogo skill disponibili
  8. `BusinessSection` — contesto business utente
  9. `MemorySection` — memoria a lungo termine (MEMORY.md) + memorie rilevanti da vector search
  10. `ContactsSection` — profilo contact del mittente corrente
  11. `WorkspaceSection` — directory workspace
  12. `RuntimeSection` — info runtime: data/ora corrente, canale, dati cognizione (understanding, plan, constraints, intent, success_criteria)
- `PromptContext` contiene campi dedicati per cognition: `cognition_understanding`, `cognition_plan`, `cognition_constraints`, `cognition_intent`, `cognition_success_criteria`
- Tabelle DB: nessuna diretta
- Endpoint API: nessuno

### Dipendenze

- Da cosa dipende: `CognitionResult` (per iniezione dati cognition), `ContextBuilder`, tool/skill registries, bootstrap files, memory, RAG
- Cosa dipende da questa feature: `agent_loop` (chiama `build_system_prompt()` ad ogni iterazione)

---

## Feature: Iteration Budget

### Comportamento Atteso

- Il budget di iterazioni limita il numero massimo di chiamate LLM nel loop di esecuzione per singola richiesta.
- Il budget è dinamico: si estende quando il modello fa progressi reali (tool call utili e non ripetute), si contrae in caso di stallo o cicli.
- Stall detection: se le ultime 4+ iterazioni non producono tool call utili o nuove, il budget viene contratto a `iteration + 2`.
- Cycle detection: rileva cicli di periodo 1, 2, 3 nelle firme delle tool call (exact match e fuzzy match per `web_search`/`web_fetch`).
- Budget extension: +10 per browser-heavy, +4 per search-heavy, +3 altrimenti; limitato da `hard_max_iterations`.
- Edge case:
  - Tool browser: hanno il proprio loop detector in `BrowserTaskPlanState`; stall/cycle tracking disabilitato qui per evitare doppio conteggio
  - Firma vuota (nessuna tool call): incrementa `stall_streak` senza aggiornare `last_signature`
  - Ciclo rilevato ma stall basso: solo warning, budget non contratto
  - Firma identica ma risultato diverso: trattato come ripetizione (no extension)

### Dettagli Tecnici

- Moduli: `src/agent/iteration_budget.rs`
- Struttura `IterationBudgetState`: `last_signature`, `stall_streak` (u8), `extensions_used` (u8), `recent_signatures` (Vec<String>, finestra rolling), `cycle_detected` (Option<usize>)
- `tool_call_signature(tool_name, arguments)`: genera firma deterministica `"name:json_args"` per singola tool call; le call multiple per iterazione vengono unite con `|`
- `maybe_extend_iteration_budget(active_budget, hard_max, base_max, iteration, tool_summaries, state, window)`: logica principale
- `detect_cycle(signatures)`: controlla periodi 1/2/3 su finestra rolling; `normalize_signature_for_cycle`: collassa `web_search`/`web_fetch` al solo nome tool per fuzzy detection
- Tabelle DB: nessuna
- Endpoint API: nessuno

### Dipendenze

- Da cosa dipende: `browser::is_browser_tool` (per esclusione tool browser dal tracking)
- Cosa dipende da questa feature: `agent_loop` (chiama `maybe_extend_iteration_budget` ad ogni iterazione e usa `IterationBudgetState`)

---

## Feature: LLM Caller

### Comportamento Atteso

- Incapsula la logica di invocazione del provider LLM con strategie di fallback automatiche.
- Strategie in ordine: (1) streaming, (2) fallback non-streaming se streaming fallisce, (3) XML dispatch se il modello rifiuta il native tool calling.
- Rispetta il flag di stop utente: interrompe la chiamata se `stop::is_stop_requested()` durante streaming o non-streaming.
- Input: `LlmCallParams` (provider, model, max_tokens, temperature, think, tool_defs, xml_mode, has_tools, iteration, xml_fallback_delay_ms), messaggi, stream_tx opzionale.
- Output: `LlmCallResult::Success(ChatResponse)` o `LlmCallResult::Stopped`.
- Edge case:
  - XML fallback auto-detect: solo al primo errore (iteration == 1), solo se ha tool, solo se non già in XML mode; keywords: "tool", "function", "not supported", "no endpoints", "invalid"
  - Stop durante chiamata: restituisce `Stopped` senza errore
  - Streaming fallisce: tenta non-streaming sulla stessa request
  - Non-streaming fallisce dopo streaming: errore propagato

### Dettagli Tecnici

- Moduli: `src/agent/llm_caller.rs`
- Enum `LlmCallResult`: `Success(ChatResponse)`, `Stopped`
- Struct `LlmCallParams`: configurazione per una singola chiamata
- Funzione principale: `call_llm_with_fallback(params, messages, stream_tx)`
- Flusso: `tokio::select!` tra `provider.chat_stream()` e `stop::wait_for_stop()` (path streaming) o `provider.chat()` e `stop::wait_for_stop()` (path non-streaming)
- `should_try_xml_fallback(error, params)`: condizioni per attivare XML dispatch
- Tabelle DB: nessuna
- Endpoint API: nessuno; il provider espone interfacce `Provider::chat()` e `Provider::chat_stream()`

### Dipendenze

- Da cosa dipende: `provider::Provider` trait, `agent::stop` (flag globale stop), provider factory
- Cosa dipende da questa feature: `agent_loop` (usa `call_llm_with_fallback` ad ogni iterazione del loop di esecuzione)

---

## Feature: Multi-Agent Orchestrator

### Comportamento Atteso

- L'orchestratore classifica l'intent dell'utente e decide se instradare la richiesta direttamente al loop ReAct (simple) o decomporre in sottotask paralleli (orchestrated).
- Classificazione intent: LLM call veloce (modello classificatore) con risposta JSON `{complexity, intent, needs_browser, multi_source, entities, reasoning}`.
- "orchestrated" usato solo quando l'utente necessita dati da più sorgenti indipendenti confrontati/combinati.
- Messaggi brevi (<8 parole): fast-path, classificati direttamente come `Simple` senza LLM call.
- Task browser-heavy: forzati a `Simple` anche se classificati `orchestrated` (browser ha il proprio loop detector).
- Fail-open design: qualsiasi errore nella classificazione → fallback a `Simple`.
- Input: testo utente, config, session key, channel, chat_id, tool bloccati.
- Output: stringa di risposta finale.
- Stati:
  - **Disabilitato**: se `config.agent.orchestrator_enabled = false` → passthrough diretto
  - **Simple**: passthrough a `process_message` / `process_message_streaming_with_options`
  - **Orchestrated**: planning → emit piano all'UI → execute subtask → synthesize → risposta finale
  - **Errore nel planning**: fallback a passthrough diretto con warning
  - **Errore nella sintesi**: concatenazione raw risultati subtask riusciti
- Edge case:
  - Tutti i subtask falliscono e synthesizer fallisce: errore propagato al chiamante
  - Classifier restituisce JSON con markdown code fence: gestito da `try_json_parse`
  - Classifier restituisce testo libero invece di JSON: `parse_from_text` estrae complexity da keywords

### Dettagli Tecnici

- Moduli: `src/agent/orchestrator/mod.rs`, `src/agent/orchestrator/intent.rs`, più `planner`, `executor`, `synthesizer` (submoduli)
- `TaskOrchestrator::handle()`: entry point, chiama `intent::should_skip()` → `intent::classify()` → routing
- `intent::classify()`: usa `llm_one_shot` con timeout 8s, max 192 token, temperature 0.0; model: `config.routing.classifier_model` o fallback a `config.agent.model`
- `parse_response()`: multi-strategy: (1) JSON diretto, (2) JSON embedded in testo, (3) keywords in testo libero
- Path orchestrated: `planner::plan()` → `executor::execute()` → `synthesizer::synthesize()`
- Emit streaming: `emit_plan_snapshot()` invia eventi `plan` al frontend nelle fasi "planning", "executing", "synthesizing"
- Tabelle DB: nessuna diretta
- Endpoint API: nessuno diretto; chiamato dal Gateway

### Dipendenze

- Da cosa dipende: `AgentLoop::process_message*`, `provider::one_shot::llm_one_shot`, `config` (orchestrator_enabled, classifier_model)
- Cosa dipende da questa feature: Gateway (canali), nessun altro modulo interno

---

## Feature: Context Compaction

### Comportamento Atteso

- Previene l'overflow della context window durante sessioni lunghe (browser, workflow multi-step).
- Soglia: 150.000 caratteri totali nella lista messaggi.
- Strategia di compressione: preserva messaggi system e user; preserva gli ultimi 6 messaggi (active context); tronca tool result > 500 char → mantiene primi 200 char + "[compacted]"; rimuove `content_parts` (immagini) da messaggi non recenti.
- Etichettatura source (SEC-7): wrappa output tool con `[SOURCE: tool — label]\n...\n[END SOURCE]` per distinguere contenuto trusted da untrusted.
- Scan injection (SEC-13): scansiona output tool per pattern di prompt injection; aggiunge warning `⚠️ INJECTION DETECTED` se rilevato.
- Edge case:
  - Output tool < 100 char: skip labeling (overhead non giustificato)
  - Tool con formattazione propria (`vault`, `remember`, `approval`, `automation`, `workflow`, `spawn`): skip labeling
  - Feature `embeddings` disabilitata: scan injection non eseguito

### Dettagli Tecnici

- Moduli: `src/agent/context_compactor.rs`
- Funzioni principali:
  - `tool_result_for_model_context(tool_name, output)`: formatta output tool con source label e scan injection; label specifiche per: `web_fetch`/`web_search` (untrusted web), `read_email_inbox` (email untrusted), `shell` (command output untrusted), file tools (file content), `knowledge_search` (knowledge base untrusted), browser tools (page content untrusted), default (tool output untrusted)
  - `auto_compact_context(messages)`: compressione automatica; costanti: `THRESHOLD_CHARS=150_000`, `PROTECT_RECENT=6`, `TRUNCATE_MIN_LEN=500`, `TRUNCATE_KEEP=200`
  - `scan_tool_for_injection(text)`: delega a `crate::rag::sensitive::detect_injection()` (feature `embeddings`)
- Tabelle DB: nessuna
- Endpoint API: nessuno

### Dipendenze

- Da cosa dipende: `provider::ChatMessage`, `rag::sensitive::detect_injection` (feature `embeddings`), `browser::is_browser_tool`
- Cosa dipende da questa feature: `agent_loop` (chiama `auto_compact_context` quando la context window supera soglia, e `tool_result_for_model_context` per ogni tool result)

---

## Feature: Fallback (Cognition Failure)

### Comportamento Atteso

- Quando la fase di cognizione fallisce (errore provider, timeout dopo tutti i retry, risposta non parsabile), il sistema non si blocca ma degrada gracefully.
- Il fallback produce un `CognitionResult` che include TUTTI i tool registrati, consentendo al loop di esecuzione di operare normalmente.
- Il fallback analizza il prompt utente con euristiche keyword-based (bilingue IT/EN) per inferire `intent_type` e `constraints` significativi.
- L'execution loop non sa la differenza: riceve sempre un `CognitionResult` valido.
- Edge case:
  - Prompt vuoto: `intent_type = Informational`, `constraints = []`, `understanding = ""`
  - Prompt con keyword di booking + data numerica: aggiunge constraints per date/time sensitivity E multi-step forms
  - Prompt lungo >200 char: `understanding` viene troncato a 200 char + "…"
  - Constraints cap: massimo 6 constraints inferite
  - `complexity` sempre `Complex` in fallback (worst-case assumption)

### Dettagli Tecnici

- Moduli: `src/agent/cognition/mod.rs` (`fallback_full_context`), `src/agent/cognition/types.rs` (`CognitionResult::fallback_full`)
- `fallback_full_context(tool_registry, user_prompt)`: funzione async, legge tutti i nomi tool dal registry, chiama `CognitionResult::fallback_full()`
- `CognitionResult::fallback_full(all_tool_names, user_prompt)`:
  - `tools`: tutti i tool con `reason = "Cognition unavailable — full tool set provided"`
  - `skills`: lista vuota (non disponibile senza registry)
  - `intent_type`: inferito da keyword matching (transactional > creative > navigational > informational)
  - `constraints`: `infer_fallback_constraints()` — controlla: date/time sensitivity, vincoli numerici, form/booking, confronto multi-opzione
  - `complexity`: sempre `Complex`
  - `answer_directly`: sempre `false`
- Tabelle DB: nessuna
- Endpoint API: nessuno

### Dipendenze

- Da cosa dipende: `ToolRegistry` (per lista nomi), `CognitionResult::fallback_full`
- Cosa dipende da questa feature: `agent_loop` (chiama `cognition::fallback_full_context()` in caso di `Err` da `run_cognition()`)

---

## Feature: Execution Discipline

### Comportamento Atteso

- Dopo ogni tool result (qualsiasi tool, non solo browser), `ExecutionPlanState::note_iteration()` valuta il progresso e decide l'azione successiva.
- Ritorna `PlanAction`: `Continue` (nessuna azione), `Checkpoint` (compatta contesto + inietta summary), `StrategyRotation` (cambia approccio), `GiveUp` (report finale).
- **Checkpoint**: ogni `CHECKPOINT_INTERVAL = 6` iterazioni di tool, compatta il contesto vecchio e inietta un riassunto strutturato del progresso (step completati/corrente/rimanenti).
- **Strategy rotation**: quando uno step e bloccato per `MAX_ITERATIONS_PER_STEP = 8` iterazioni, inietta un prompt tool-agnostico che forza il modello a cambiare approccio. Massimo `MAX_STRATEGY_ROTATIONS = 2` per step.
- **Give-up**: dopo aver esaurito tutte le rotazioni, lo step viene marcato `Skipped` e il piano passa al successivo. Se tutti gli step sono risolti, genera un report dettagliato.
- **Auto-avanzamento semantico**: euristica keyword che avanza automaticamente lo step corrente quando un tool result indica completamento (web_search → "cerca", write_file → "salva/crea", browser navigate → "naviga/vai", etc.).
- **Progress status**: emette `"status"` stream event dopo ogni tool con messaggio user-facing ("Step 2/5: Estraendo dati...").
- Attivo solo quando esiste un piano esplicito (`has_explicit_plan()`).
- Ortogonale a `BrowserTaskPlanState` (guard azione-level) e `IterationBudgetState` (budget-level).

### Dettagli Tecnici

- Modulo: `src/agent/execution_plan.rs`
- Enum: `PlanAction` con 4 varianti, `StepStatus::Skipped`
- Costanti: `MAX_ITERATIONS_PER_STEP = 8`, `CHECKPOINT_INTERVAL = 6`, `MAX_STRATEGY_ROTATIONS = 2`
- Entry point: `note_iteration(tool_name, output)` chiamato per ogni tool result
- Integrazione: dopo `auto_advance_explicit_steps()` nell'agent loop

### Dipendenze

- Da cosa dipende: nulla (logica interna a `ExecutionPlanState`)
- Cosa dipende da questa feature: `agent_loop` (reagisce a `PlanAction`)

---

## Feature: Task Persistence & Resume

### Comportamento Atteso

- A ogni checkpoint, lo stato del piano viene persistito nella tabella `task_checkpoints`.
- Su stop esplicito (utente clicca stop): checkpoint salvato con `status = 'paused'`.
- Su completamento: checkpoint eliminato (cleanup).
- Al riavvio del server o reconnect WebSocket: se esistono task interrotti per la sessione, viene inviato un `ChoiceBlock` con opzioni "Resume" / "Cancel".
- Resume costruisce un prompt con: richiesta originale, step completati/interrotti, file creati, dati raccolti. Il modello riprende da dove si era fermato.
- Cleanup periodico al gateway startup: elimina checkpoint `completed/cancelled` e `running` piu vecchi di 7 giorni (orfani da crash).

### Dettagli Tecnici

- Modulo: `src/agent/execution_plan.rs` (`TaskCheckpoint`, `to_checkpoint()`, `build_resume_prompt()`)
- Migration: `migrations/051_task_checkpoints.sql`
- DB operations: `storage/db.rs` (`upsert_task_checkpoint`, `load_interrupted_tasks`, `delete_task_checkpoint`, `cleanup_stale_task_checkpoints`)
- Agent loop: persist ai checkpoint + cleanup post-processing
- WebSocket: check al connect + ChoiceBlock resume
- Gateway: cleanup al startup

### Dipendenze

- Da cosa dipende: `ExecutionPlanState` (serializzazione), `storage/db.rs` (CRUD), `approval_gate` (ChoiceBlock pattern)
- Cosa dipende da questa feature: `ws.rs` (resume check), `gateway.rs` (startup cleanup)
