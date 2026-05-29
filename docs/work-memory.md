# Work Memory

Questo file e' la memoria operativa del lavoro svolto nel repository. Va aggiornato durante lo sviluppo per conservare non solo cosa e' stato fatto, ma anche perche'.

## 2026-05-29

### VALIDAZIONE LIVE A1.1–A1.3 (gateway acceso, HTTP reale) — PASSATA + 2 bug fixati

Setup: gateway leggero (`--no-default-features`), worker auto OFF (validazione
controllata via `POST /api/tasks/run_next`), `LOCAL_FIRST_BRAIN_MATERIALIZE=1`,
router -> Ollama locale. Ollama CLOUD relay DOWN (tutti i `:cloud` -> "internal
service error"; chiave appena ruotata o outage lato Ollama) -> validato con
`gemma4:latest` LOCALE (modello debole ma sufficiente per il plumbing).

BUG #1 (trovato live): `brain_materialize_tasks` chiamava SEMPRE
`ensure_runtime_available_for_task` (ping/avvio MLX :8765) anche con backend
cloud/router -> MLX spento -> errore -> fallback legacy silenzioso (ack "Ho
capito..." invece di "Ho pianificato N passi"). FIX: gate backend-aware
`brain_planner_uses_local_mlx_runtime()` (solo backend mlx/default-senza-mistralrs
necessitano :8765). BUG #2: lo `.ok().and_then` in `submit_operational_prompt`
inghiottiva l'errore del Brain -> fallimento invisibile. FIX: log esplicito di
ogni esito (no-tasks / failed / join error).

Dopo i fix, catena A1.2/A1.3 validata END-TO-END:
- ack "Ho pianificato 1 passi (Brain)" (planner gemma4 ~28s).
- coda task: `orchestrator_brain_<id>_s1` kind `capability.browser.browser.navigate`
  status queued NELLO STORE CONDIVISO.
- sessione del thread `running 0/1` = `progress_total = N` (seeding aggregante OK).
- `run_next` sul task orchestrator -> dispatch a CapabilityBrowser ->
  `call_shared_browser_sidecar` (superficie unica A1.3): ha ricevuto una RISPOSTA
  browser (`BROWSER_INVALID_REQUEST:target_id is required`), prova che il sidecar
  e' stato raggiunto.
- RISULTATO IN CHAT con `linked_task_id=orchestrator_brain_<id>_s1`: prova diretta
  che `append_task_result_to_chat` ha risolto l'id via la LINK-TABLE FALLBACK A1.2
  (l'id NON e' il task primario del thread). Sessione aggregata correttamente a
  Running 0/1 (1 membro waiting_external).

FOLLOW-UP (non-wiring): lo step navigate aveva `arguments: {}` (gemma4 non ha
riempito l'URL) -> `target_id is required`. E' qualita' piano / contratto
argomenti capability<->sidecar.

### Cloud SBLOCCATO + browser navigate FUNZIONA end-to-end (commit ab5fa9d)

CLOUD: i `:cloud` via relay locale `127.0.0.1:11434` davano 401/internal error
perche' il daemon ollama NON era loggato. `https://ollama.com/v1` col bearer
funzionava. L'utente ha fatto `ollama signin` -> ora il RELAY locale funziona
sui `:cloud` (verificato `/v1` + `response_format json_object`). Setup gateway
validazione: backend=openai, base=`http://127.0.0.1:11434/v1`,
model=`qwen3-vl:235b-cloud`, cloud=1.

PIANO con modello capace (qwen3-vl:235b, planner ~90s): 2 step CORRETTI con
argomenti REALI -> s1 `browser.navigate {"url":"https://www.trenitalia.com"}`,
s2 `browser.act {actions:[fill departure=Napoli, fill arrival=Milano,
fill date=10/06/2026, fill time=09:00, click search-button]}`. Il modello NON e'
piu' il collo di bottiglia.

BLOCCO CONTRATTO TAB (fixato): le capability del sidecar sono tab-scoped
(`navigate`/`act`/`snapshot` richiedono `target_id`), ma il planner non puo'
conoscere un id di tab generato a runtime -> navigate falliva `target_id is
required`. FIX: `normalize_browser_call` nella superficie unica (A1.3) gestisce
UNA tab fissa label "primary": `navigate{url}` -> `open{url,label:"primary"}`
(idempotente: crea+ri-naviga), gli altri metodi tab-scoped ricevono
`target_id:"primary"` iniettato; chiamate con target esplicito intatte. Test
`normalize_browser_call_manages_tab_for_planner_steps`. LIVE: s1 navigate ora
COMPLETATO end-to-end (apre primary + naviga su trenitalia.com).

### Bug act DIAGNOSTICATO + 2 fix sidecar (riga raw catturata)

Probe diretto del sidecar (open about:blank + act con lo shape del modello) ->
`act` rispondeva `{"id":"r2","ok":true}` (22 byte, SENZA `result`). Causa: il
modello manda `{actions:[{field,type,value},...]}`, ma `manager.act` si aspetta
una SINGOLA azione `{kind, ref, ...}` (o `{kind:"batch", actions:[{kind,...}]}`).
Con `action.kind` undefined lo switch di `executeActionUnchecked` (niente
`default`) cadeva a vuoto -> ritornava `undefined` -> `makeSuccessResponse(id,
undefined)` -> `JSON.stringify` DROPPA `result:undefined` -> `{id,ok:true}` ->
il Rust `BrowserResponse::Success` RICHIEDE `result` -> "did not match any
variant" -> il self-heal A1.3 lo scambiava per sidecar morto.

FIX (sidecar TS, 43 test verdi + typecheck):
1. `makeSuccessResponse`: `result: result ?? null` (l'envelope ha SEMPRE result).
2. `executeActionUnchecked`: aggiunto `default` che lancia
   `BROWSER_INVALID_REQUEST: unknown action kind: ...` (niente piu' no-op
   silenzioso riportato come successo).
Verificato col probe: ora act -> `{ok:false, error:{code:BROWSER_INVALID_REQUEST,
message:"unknown action kind: undefined", retryable:false}}` -> deserializza come
Error -> messaggio chiaro in chat.

### VALIDAZIONE LOOP osserva->agisci col modello capace (example trenitalia_live)

Domanda: il loop osserva->agisci + modello capace fa DAVVERO la ricerca? RISPOSTA: SI'.
Run `cargo run --example trenitalia_live` (ollama qwen3-vl:235b-cloud via relay,
headless): iter1 -> type "Napoli Centrale" (ref e106), iter2 -> type "Milano
Centrale" (ref e117). Il loop ref-based naviga, osserva, sceglie i ref giusti e
compila i campi. E' la PROVA che la strada per la prenotazione e' il LOOP, non gli
step act statici.

VINCOLI PRATICI emersi:
- Il timeout del loop planner di DEFAULT e' 20s (`browser_loop_planner_timeout_seconds`,
  env `LOCAL_FIRST_BROWSER_PLANNER_TIMEOUT_SECONDS`): troppo poco per un modello
  cloud capace (~90s/chiamata). Prima run -> TimedOut immediato. Con 180s sblocca.
  -> In produzione il timeout va alzato per backend cloud.
- qwen3-vl:235b sulla snapshot profilo Full di trenitalia (DOM enorme) e'
  IMPRATICABILMENTE LENTO per un loop interattivo; inoltre stallo lato browser
  dopo iter2 (settle/snapshot su autocomplete) -> serve hardening del
  settle/snapshot + un modello capace PIU' VELOCE (o profilo Compact per prompt
  piu' piccoli).

PROSSIMI PASSI per chiudere la prenotazione end-to-end:
1. Modello del loop: capace MA veloce (provare modelli cloud piu' piccoli, o
   forzare BrowserContextProfile::Compact per ridurre il prompt).
2. Hardening settle/snapshot post-azione (timeout) contro stalli del sito.
3. Brain routing (A1.4/A1.5): il Brain ROUTA l'interazione a un subagent
   browser-loop invece di materializzare step `capability.browser.act` statici.

CONCLUSIONE ARCHITETTURALE (prossimo passo per la prenotazione): l'interazione
form (fill+click multi-campo) e' intrinsecamente un loop OSSERVA->AGISCI: i `ref`
vengono da uno snapshot a RUNTIME e i selettori del DOM (Trenitalia) non sono
noti al planner. Un `capability.browser.act` STATICO non puo' funzionare. Il
Brain deve ROUTARE l'interazione browser a un SUBAGENT browser-loop
(snapshot->fill->verify), non materializzare step act statici. Le
`capability.browser.navigate/snapshot` vanno bene (stateless-ish); l'interazione
no. E' il lavoro A1.4/A1.5 (routing) + integrazione del BrowserLoopRunner come
executor di un subagent_task. DA DECIDERE con l'utente.

### A1.3 FATTA (core) — superficie d'esecuzione browser UNICA + self-heal

Obiettivo A1.3: "proprieta' UNICA del sidecar -> una sola superficie
d'esecuzione". Indagine: il registry capability seeda SOLO metadata
(config/grant/connection + cached tools); `BrowserCapabilityProvider` (crate
capabilities) NON e' cablato nel gateway; il facade del Brain usa
`CachedToolProvider` (call_tool -> ProviderUnavailable) + `allowed_actions=[]`.
Quindi l'unica superficie VIVA e' gia' il durable executor
(`execute_capability_browser_task` -> `state.browser_capability_client`). I path
legacy (browser loop / keyword-train) spawnano sidecar effimeri ma sono in
ritiro (A1.5) e girano solo sul route keyword, sequenziali via lease.

Fatto:
1. SELF-HEAL: in `call_shared_browser_sidecar`, se `call_response` ritorna
   `Sidecar`/`InvalidResponse` (pipe rotto / stdout chiuso = processo morto), si
   scarta il client cached (`*client_guard = None`) e si ritorna
   `RetryableFailure` -> il task runtime ritenta e rispawna, invece di fallire
   per sempre contro un sidecar morto. Classificazione in predicato puro
   `browser_error_indicates_dead_sidecar` (testato: Sidecar/InvalidResponse ->
   respawn; InvalidRequest/NavigationBlocked/PrivateNetworkBlocked -> no).
2. PROPRIETA' UNICA: estratto `call_shared_browser_sidecar` come UNICO owner del
   sidecar persistente (lock + get-or-spawn + call + self-heal). Contratto
   documentato: ogni futuro provider read-only live DEVE delegare qui, mai
   spawnare un sidecar concorrente.

Test: `dead_sidecar_errors_trigger_respawn_others_do_not`. Gateway bin 59 verdi.
RESIDUO A1.3 (quando si cableranno provider live): far passare anche il
`call_tool` immediato read-only per lo stesso accessor. Per ora non serve (path
durevole-only). RESIDUO A1: A1.4, A1.5, A1.6.

### A1.2 FATTA — N task del Brain in UNA sessione aggregante (commit f763dae + c0af062)

Problema: un prompt -> N task durevoli (Brain), ma giravano "headless". Il
surfacing sessione/chat del worker (`sync_session_for_task_run`,
`append_task_result_to_chat`) risolve task->thread via
`ChatStore::thread_by_task_id`, che matchava solo il task PRIMARIO del thread:
gli id `orchestrator_<req>_<step>` davano `None` -> niente eventi sessione ne'
risultati in chat.

SCOPERTA CHIAVE: il worker `run_next_task_once` -> `execute_read_only_task` ->
dispatch registry -> `execute_capability_browser_task` E GIA' chiama
`sync_session_for_task_run` + `append_task_result_to_chat`. Mancava SOLO la
risoluzione. Quindi A1.2 si e' ridotta a rendere risolvibili gli id dei member.

Slice 1 (f763dae): tabella additiva `task_thread_links(task_id -> thread_id)`;
`thread_by_task_id` fa fallback alla tabella (match primario vince -> path
single-task intatto); `delete_thread` pulisce i link. `brain_materialize_tasks`
ora prende `thread_id`, collega ogni task e seeda la sessione del thread con
`progress_total = N`. Best-effort: fallimento linkage non perde i task.

Slice 2 (c0af062): `sync_session_for_task_run` riconosce un member (id != task
primario del thread) e ricalcola stato/progresso a livello SESSIONE leggendo lo
stato terminale di TUTTI i member dal task store: current = # completati;
WaitingUser se uno richiede approvazione, altrimenti Failed se tutti terminali
con un fallimento, altrimenti Completed solo quando tutti terminali, altrimenti
Running. Logica pura estratta in `aggregate_session_state_from_counts` (5 casi
unit-testati). Cosi' la sessione non flippa piu' a "Completed" dopo il 1o step.

Test: `member_tasks_resolve_to_owning_thread_without_shadowing_primary`,
`aggregate_session_state_reflects_member_progress`. Gateway lib 23 + bin 57 verdi.

DA VALIDARE LIVE (non bloccante): far girare un prompt con
`LOCAL_FIRST_BRAIN_MATERIALIZE=1` + backend capace e osservare la UI Computer
mostrare 1 sessione che avanza 0..N con i risultati per-step in chat.
RESIDUO A1: A1.3 (provider live / sidecar singolo), A1.4 (convergere il run loop
su TaskRuntime), A1.5 (ritirare routing keyword/train + OperationalPlan->read
model), A1.6 (flag default ON).

### A1.1 VALIDATA end-to-end con modello frontier (qwen3-vl:235b)

Chiave gestita in sicurezza: file 0600 `~/.local-first-personal-assistant/
ollama-api-key`, letto via `LOCAL_FIRST_INFERENCE_API_KEY_FILE` (valore mai in
chat/comandi). Endpoint `https://ollama.com/v1`.

RISULTATO (smoke brain_materialize): qwen3-vl:235b produce un piano CORRETTO a 5
step (navigate->snapshot->act->act->snapshot) e il Brain materializza 5 task
durevoli `capability.browser.*` (0 immediate => durable-only confermato). Catena
Brain->materializza->executor verificata. PRIMA materializzazione reale -> base
per progettare A1.2.

Catena di fix scoperti dal vivo (ognuno sbloccava il successivo):
1. planner schema: `depends_on` tolto dai required (serde-default). 
2. `OpenAiCompatProvider`: `json_schema` ROMPE ollama.com/v1 (400 "unexpected end
   of JSON input"); l'Ollama LOCALE invece lo supporta. -> revert a `json_object`
   universale (capable model + schema-nel-prompt basta).
3. planner timeout 30s fisso -> troppo poco per 235B cloud su prompt grande. ->
   `OrchestratorBudgets.planner_timeout_seconds` (u64, default 120), usato dal
   brain (cast f64). NB: u64 per non rompere il derive Eq di OrchestratorBudgets.
4. IL FIX CHIAVE: il planner prompt diceva "matching the schema" ma NON mostrava
   la struttura; lo schema arrivava solo via json_schema (ignorato da ollama
   cloud) -> anche qwen sbagliava forma (emetteva un bare step con `action`).
   Aggiunto al prompt un blocco OUTPUT FORMAT esplicito + esempio
   {route, steps:[...]} -> ora la forma e' corretta su qualunque backend.
- Debug gated `LOCAL_FIRST_INFERENCE_DEBUG=1` nel provider per stampare
  raw_output su risposta invalida (ha permesso di vedere il bare-step).
- Test: orchestrator 7 brain + altri verdi (soglia prompt test 9k->10.5k per il
  preambolo fisso; aggiunto planner_timeout_seconds ai literal di test),
  inference 23, gateway 23+55. Build default verde.

CONCLUSIONE A1.1: meccanismo VALIDATO con modello capace via router. Il Brain ora
funziona in produzione SE usa un modello capace (TODO A1: brain_materialize_tasks
deve usare il router, non RuntimeClient fisso). Prossimo: A1.2 (sessione/chat per
N task) progettabile su output reale.

### Validazione live A1.1 — findings + 2 fix reali

Smoke `crates/desktop-gateway/examples/brain_materialize_smoke.rs`: costruisce il
Brain come `brain_materialize_tasks` (tool browser cached, policy durable-only,
runtime configurabile MLX o Ollama via router) e stampa piano + task
materializzati. Progressione dei fallimenti (= debug iterativo del planner):
1. Gemma-4-E4B (MLX): `missing required key steps[0].depends_on`.
   -> FIX: `depends_on` rimosso dai `required` dello schema planner
   (`orchestrator/src/planner.rs`); ha gia' `#[serde(default)]`. Robustezza.
2. Gemma-4-E4B: `step_missing_provider:step1` (capability_call senza provider) —
   limite di qualita' del modello, non un bug.
3. gemma4:8b via Ollama: `missing required keys: route, steps` (PEGGIO dell'E4B!).
   CAUSA: `OpenAiCompatProvider` IGNORAVA `request.json_schema` (mandava solo
   `response_format: json_object`), mentre il path MLX passa lo schema al server.
   -> FIX: `OpenAiCompatProvider` ora invia `response_format: json_schema` con lo
   schema quando presente (OpenAI/OpenRouter/Ollama recenti). Alto valore: migliora
   TUTTE le chiamate strutturate cloud (brain/chat/browser). 
4. gemma4:8b + schema enforced: avanza a route+steps presenti, poi
   `missing field query` (round needs_more_tools malformato) — di nuovo qualita'
   del modello debole.

CONCLUSIONE: il Brain e' meccanicamente solido e lo schema-enforcement aiuta
molto, ma E4B/8B NON producono piani completi -> il Brain DEVE usare un modello
capace (conferma la strategia "modello capace via router"). 
- Una materializzazione end-to-end riuscita richiede un modello frontier via
  router (qwen3.5/qwen3-vl su Ollama cloud) -> serve la cloud key (quella vecchia
  e' esposta, da ruotare; non riutilizzata).
- Per A1.2 NON serve un run frontier live: le FORME dei task sono deterministiche
  e gia' verificate compatibili (`capability.<provider>.<tool>` con
  CapabilityTaskPayload -> `execute_capability_browser_task`; `subagent.<agent>`
  -> SubagentTaskExecutor). A1.2 si progetta da queste forme.
- FIX ARCHITETTURALE A1 derivato (TODO): `brain_materialize_tasks` /
  `try_brain_operational_plan` devono usare il ROUTER come runtime del Brain
  (modello capace), non `RuntimeClient` fisso su Gemma.

### A1.1 — Brain materializza task durevoli nel TaskStore condiviso (opt-in)

- `brain_materialize_tasks(state, goal)`: costruisce l'`OrchestratorBrain` con un
  handle `TaskStore::open(gateway_task_database_path)` (STESSO DB del worker) +
  facade `CachedToolProvider` (dai tool in cache) + `NoopMemoryContextProvider`
  + tool index in-memory; `policy_context.allowed_actions = []` -> tool
  visibili-ma-non-executable -> `Brain.run` non chiama mai `call_tool` (Cached
  provider safe) ed enqueue TUTTO come durevole. Ritorna gli id dei task.
- COMPATIBILITA' verificata: il bridge crea `capability.<provider>.<tool>` con
  `CapabilityTaskPayload`, ed `execute_capability_browser_task` parsa esattamente
  `CapabilityTaskPayload` -> la catena Brain->materializza->worker->executor
  browser SI CONNETTE. subagent.* via l'executor gia' de-stubbato.
- Wiring opt-in in `submit_operational_prompt` dietro `LOCAL_FIRST_BRAIN_
  MATERIALIZE` (spawn_blocking per non bloccare il runtime): se materializza,
  ack chat "pianificato N passi, li eseguo" e i task girano via worker (visibili
  in coda task); altrimenti path keyword legacy (default invariato).
- Test: gateway 23+55 verdi; build light e default verdi.
- NON ancora fatto (A1.2): linkage dettagliato sessione/chat/read-model per N
  task (la sessione Local Computer e i risultati per-task in chat). Validazione
  live (Gemma + flow) rimandata. Il path keyword resta default/intatto.

### A4 — chat dal router (streaming OpenAI-compat)

- L'handler `generate_stream` ora, se `LOCAL_FIRST_INFERENCE_BACKEND=openai` +
  `LOCAL_FIRST_INFERENCE_BASE_URL` (Ollama local/cloud, OpenAI, OpenRouter),
  streama da `{base}/chat/completions` con `stream:true` e TRADUCE la SSE nel
  formato NDJSON `GenerateStreamEvent` del gateway (delta/done) — IDENTICO al
  path MLX, quindi la UI consuma entrambi allo stesso modo. Default invariato =
  proxy MLX locale.
- Traduzione async: task spawn legge `bytes_stream`, line-buffer, usa
  `local_first_inference::streaming::parse_openai_sse_line` (gia' unit-tested),
  emette `GenerateStreamEvent::Delta/Done` (di subagents → wire identico a MLX)
  via mpsc → `futures_util::stream::unfold` → `Body::from_stream`.
- Config: `chat_openai_stream_config()`; key via `resolve_inference_api_key`
  (file 0600 preferito). Dep aggiunte: `bytes`, `futures-util`, tokio `sync`.
- Test: gateway 23+55, inference 23 verdi; build light e default verdi.
- NON ancora fatto: streaming Anthropic (schema SSE diverso: event
  content_block_delta) → follow-up. Validazione live chat-via-Ollama rimandata
  (come da decisione "test alla fine"). Il path MLX resta default/intatto.
- Pilastro #5 ADR 0008 (chat dal ModelRouter) avanzato: ora la chat puo' usare
  modelli capaci via OpenAI-compat senza essere hard-coupled a MLX.

### M3 (B1) — conferma combobox deterministica per modelli locali deboli

- CAUSA originale (test live Trenitalia): i campi stazione sono `role=combobox`
  con suggerimenti SOLO via tastiera (nessun ref `option` cliccabile); i modelli
  deboli usavano `fill` (programmatico, niente keystroke) o ri-digitavano senza
  mai confermare.
- FIX deterministico nel sidecar (`runtimes/browser-automation/src/browser/
  actions.ts`): l'azione `type` ora, dopo aver digitato, **auto-conferma** se il
  campo e' un autocomplete combobox (`role=combobox` o `aria-autocomplete=
  list|both`, via `autocompleteCommitMode`): `ArrowDown` + `Enter`. Opzione
  esplicita `commit: "arrow_enter"|"enter"|"none"` per override. I textbox
  normali NON vengono auto-confermati.
- Fixture rappresentativo `tests/fixtures/combobox.html` (suggerimenti
  keyboard-only, niente click) + 2 test (auto-conferma combobox; nessuna
  auto-conferma su textbox normale). Suite sidecar 43/43 verde, nessuna
  regressione (il fixture train usa suggerimenti cliccabili, non combobox).
- Prompt planner (RULE 2): indirizza i modelli deboli a usare `type` (auto
  conferma) e NON `fill` sui campi autocomplete; non aspettarsi un suggerimento
  cliccabile separato. Gateway controller 19/19 verde.
- Gridcell-retention nel profilo compact (altra parte di M3): gia' fatta prima.
- M3 residuo (enhancement, non blocker): B2 stato-piano esplicito nel loop;
  B4 fallback vision quando l'aria-snapshot e' povero.

DECISIONE STRATEGICA (utente, 2026-05-29): con il router inference + delega
cloud, usare un modello piccolo LOCALE e' ormai OPZIONALE e NON piu' vincolante
per il browser (si puo' usare un modello capace via router). Conseguenze:
- B2/B4 (pensati per compensare modelli deboli) -> DEPRIORITIZZATI. B1 resta
  utile (aiuta qualunque modello), ma non si insegue altro per i modelli piccoli.
- Il test live di B1 con modello piccolo locale -> rimandato alla FINE, opzionale.
- Strategia: "modello capace via router" e' il percorso; quindi il valore alto
  e' portare TUTTO (chat + orchestrazione) sul router (A1 closure + A4 chat dal
  router), non ottimizzare i modelli locali deboli.

### M1/A1 #3 — de-stub executor Subagent (GAP 4)

- `subagent.*` non e' piu' uno stub: `execute_subagent_task` usa il vero
  `SubagentTaskExecutor` (trait `TaskExecutor`, solo runtime locale) e ne mappa
  l'`ExecutorResult` con il ponte GIA' ESISTENTE
  `task_execution_outcome_from_executor_result` (lo stesso del path browser
  capability). EVITATO un duplicato: avevo scritto un `executor_result_to_outcome`
  ridondante, poi scoperto il ponte esistente (testato a riga ~7806) e rimosso il
  mio.
- Dispatcher: `GatewayTaskExecutorKind::Subagent -> execute_subagent_task`.
- Browser-as-capability-tool: gia' wired (`execute_capability_browser_task`,
  kind `capability.browser.*`). Resta stub solo `CapabilityGeneric`
  (connettori/MCP vivi).
- Test: gateway 23+55, subagents/capabilities/orchestrator verdi; build light e
  default (mistral.rs) verdi.
- NOTA: il consumatore (Brain che materializza subagent task in produzione) non
  e' ancora wired -> questo de-stub e' davanti al suo consumatore, ma e' un pezzo
  reale/corretto di GAP 4 e prepara la convergenza sul trait. Il pezzo grande
  residuo di #3 e' far materializzare i task al Brain (Brain.run in produzione,
  serve provider VIVI) + convergere il run loop su TaskRuntime (A2-residual).

### M1/A1 — ADR 0008 + Brain LIVE nel path piano (opt-in) + CachedToolProvider

- ADR `docs/decisions/0008-orchestrator-brain-single-planner.md`: stato finale
  definitivo di A1 (5 pilastri: un cervello, una facade, un task runtime,
  ExecutionPlan come modello unico con OperationalPlan->read-model, store
  condivisi in AppState; + A4/A5). Convergenza definitiva = migrare a
  ExecutionPlan (l'adattatore diventa il deriver del read-model). Sequenza
  incrementale documentata.
- Pilastro #2 (shim transitorio): `crates/capabilities/src/cached_provider.rs`
  `CachedToolProvider` — `CapabilityProvider` read-only che espone i tool dalla
  cache registry per la VISIBILITA' di pianificazione; `call_tool` rifiuta
  (`ProviderUnavailable`) -> niente esecuzione finta. 2 test.
- Pilastri #1/#4 (primo wiring live): nel gateway
  `try_brain_operational_plan(state, goal)` assembla un `OrchestratorBrain`
  (RuntimeClient + NoopMemoryContextProvider + CapabilityFacade con
  CachedToolProvider per provider + ToolSearchIndexStore in-memory + TaskStore
  in-memory), chiama `plan_only`, adatta a OperationalPlan. Cablato al punto-piano
  in `execute_browser_loop_read_only_task` come opzione intermedia:
  input_json plan -> Brain (se flag) -> legacy. Gate
  `LOCAL_FIRST_USE_BRAIN_PLANNER` (default OFF: opt-in, fallback su qualunque
  errore). Rimosso `#[allow(dead_code)]` da brain_adapter (ora usato).
- Test: capabilities (CachedToolProvider 2), gateway 23+55, orchestrator brain 7
  verdi. Build light e default (mistral.rs) verdi. Solo warning preesistente.

STATO A1: il Brain ora PUO' girare in produzione (opt-in) e produrre il piano
operativo, con fallback sicuro. CHIUSO lo slice "Brain live nel path piano".
RESTA per A1-full: provider VIVI (call_tool reale, non solo cache) ->
de-hardcodare l'ESECUZIONE (browser-as-capability-tool, executor reali
capability/subagent oggi stub, GAP 4) -> Brain in AppState con store condivisi
(ora costruito per-call) -> default flag ON + ritiro keyword/train -> A4/A5.
NOTA valore: con i CachedToolProvider il call_tool non esegue, quindi finche'
non ci sono provider vivi + executor reali, il piano Brain e' soprattutto
struttura/display; il valore alto e' il prossimo passo (esecuzione).

### M1 — primo incremento (adattatore Brain->OperationalPlan)

- SCOPERTA verificando il codice reale: A2 (dispatcher per task.kind via
  `TaskExecutorRegistry` -> `execute_read_only_task`, con governor/lease/
  scheduler reali) e A3 (worker background `start_task_executor_worker`,
  abilitato di default, polling+spawn_blocking su `run_next_task_once`) sono
  GIA' FATTI. Il report dell'agente su "nessun worker" era datato. Quindi M1
  si riduce ad A1.
- Resta A1 (il piu' rischioso): l'OrchestratorBrain non e' in produzione; il
  routing usa `should_create_operational_task` + `operational_plan_for_goal`/
  `train_search_draft_for_goal` (keyword/treni hardcoded). Executor
  CapabilityGeneric/Subagent sono ancora stub "non collegato".
- Scelta utente per A1: "Adattatore + test prima" (zero rischio) +
  convergenza "Adattatore -> OperationalPlan".
- FATTO questo incremento: `crates/desktop-gateway/src/brain_adapter.rs`
  (`execution_plan_to_operational_plan`): converte l'`ExecutionPlan` del Brain
  nell'`OperationalPlan` del gateway. Mapping: route->intent_type,
  approval/risk->autonomy+approval_gates+stop_conditions, tool_name->tools,
  contract->data_schema, step->operational_step. 3 unit test. Aggiunta dep
  `local-first-orchestrator` al gateway; aggiunto `PartialEq/Eq` a
  OperationalIntentType/Autonomy. Modulo `#[allow(dead_code)]` perche' NON ancora
  cablato nel path live (scelta utente: cablaggio = step successivo).
- NON fatto di proposito: istanziare l'OrchestratorBrain in AppState. Farlo ora,
  inutilizzato, aggiungerebbe la complessita' owned-TaskStore-vs-Mutex +
  MemoryContextProvider + CapabilityFacade senza valore finche' non si cabla.
  Va fatto insieme al wiring.
- Test: gateway 23+55 (light) verdi, default build (mistral.rs+orchestrator)
  verde. Unico warning preesistente.

Secondo incremento A1 (utente: "fallo, non siamo in produzione"): aggiunto il
PRIMITIVO mancante `OrchestratorBrain::plan_only(&request) -> ExecutionPlan`
(`crates/orchestrator/src/brain.rs`): esegue solo la fase di planning
(list_tools -> rebuild index -> load memory -> load tools -> plan_with_retry ->
validate) e ritorna il piano SENZA materializzare task/eseguire step. `run_inner`
intatto (rischio minimo). Test `plan_only_returns_plan_without_materializing_tasks`
(orchestrator brain 7/7).

SCOPERTA che ridimensiona "il wiring": il Brain ha 3 mismatch architetturali col
gateway, quindi il wiring live e' un'integrazione a 3 ponti, NON un wiring
bounded:
1. plan-vs-execute: `run` materializza task (doppioni + colpisce executor stub).
   RISOLTO dal nuovo `plan_only`.
2. capability model: il Brain usa `CapabilityFacade` con provider VIVI
   (`register_provider`, trait a 11 metodi); il gateway legge dalla CACHE della
   registry (`registry.cached_tools`). Serve un `RegistryCacheProvider:
   CapabilityProvider` che serva i tool cache -> facade. NON ancora fatto.
3. ownership: Brain vuole TaskStore/CapabilityFacade/ToolSearchIndexStore owned;
   il gateway li ha dietro Arc<Mutex>. Per plan-only basta costruire una facade
   con RegistryCacheProvider + ToolSearchIndexStore::open_in_memory +
   NoopMemoryContextProvider + RuntimeClient (memory nel Brain = A5, separato).

VALORE IMMEDIATO LIMITATO del wiring al punto-piano: oggi l'`OperationalPlan` e'
soprattutto DISPLAY/step-tracking; l'esecuzione browser reale usa
`browser_targets_for_goal` (keyword). Cablare il Brain al punto-piano cambia il
piano MOSTRATO ma non l'esecuzione -> potenzialmente confondente. Il valore alto
di A1 e' de-hardcodare l'ESECUZIONE (route + browser targets), che e' piu' grande
(gli step CapabilityCall del Brain dovrebbero passare dagli executor reali, oggi
stub - vedi GAP 4).

STATO: 2 primitivi puliti pronti (`plan_only` + `execution_plan_to_operational_plan`,
entrambi testati e verdi). Il wiring live = costruire `RegistryCacheProvider` +
assemblare il Brain + instradare con fallback. A1-full e' un milestone a se',
non un wiring veloce. Decisione utente attesa: costruire il ponte
RegistryCacheProvider come prossimo step discreto, oppure trattare A1-full come
milestone dedicato (de-hardcodare anche l'esecuzione, non solo il display).

### M0 Sicurezza (dal piano di elevazione) — FATTO

- S1 — Auth gateway obbligatoria di default. `resolve_gateway_auth_token()`
  (`desktop-gateway/src/main.rs`): env -> file persistito -> token generato
  (due uuid v4) scritto 0600 in `~/.local-first-personal-assistant/
  desktop-gateway-token`. Mai piu' "auth off": rimosso il bypass in
  `require_gateway_token`, ora fail-closed se il token fosse vuoto. Aggiunta dep
  `uuid` v4 al gateway + helper `gateway_data_dir`/`write_private_file` (cfg unix
  0600, fallback Windows).
- S2 — Gate di sicurezza nel loop browser (path attivo). In
  `parse_browser_loop_decision` aggiunto `browser_action_high_risk_reason`:
  click/submit su controlli con label che matchano pattern
  acquisto/login/prenotazione (EN+IT, `HIGH_RISK_LABEL_PATTERNS`) -> ritorna
  `Blocked` invece di eseguire. Backstop indipendente dal prompt dell'LLM.
  `snapshot_label_for_ref` risale dal ref al testo dell'elemento. "Cerca"/search
  resta permesso.
- S3 — `evaluate` (JS arbitrario) sempre bloccato nel loop (catena
  prompt-injection->esecuzione chiusa).
- S4 (slice) — API key cloud da FILE 0600 preferito all'env
  (`LOCAL_FIRST_INFERENCE_API_KEY_FILE`), `resolve_inference_api_key()`; env
  ancora supportato ma con warning (e' ereditato dai processi figli). NOTA: la
  piena integrazione `local-first-secrets` (secret_ref + store cifrato/keychain)
  resta un task dedicato (S4-full) — farla a meta' sarebbe security theater.
- Test: gateway controller 19 (4 nuovi gate), gateway 52, inference 23,
  browser-automation suite verdi. Build light (`--no-default-features`) e default
  (mistral.rs) verdi. Unico warning preesistente: `browser_loop_decision_prompt`.

### Analisi sistema completa + piano di elevazione + foundation chat-streaming

- Lanciati 5 agenti di analisi (inference/gateway/chat, browser, runtime/
  capability/brain/subagenti, memory/skill/secrets/process, desktop UI).
- Sintesi in `docs/plans/2026-05-29-system-elevation-plan.md`. DIAGNOSI DI FONDO:
  il sistema e' un insieme di librerie ben testate, ma il GATEWAY IN PRODUZIONE
  e' una seconda implementazione parallela che le bypassa (routing a keyword +
  piano treni hardcoded, run loop task re-implementato a mano, memoria usata
  solo in lettura, chat accoppiata a MLX fuori dal router). Leva #1: chiudere il
  gap tra cio' che e' testato e cio' che gira.
- Buchi di sicurezza nel path attivo: auth gateway DISABILITATA di default se
  token vuoto (`main.rs:700/7213`); gate di policy NON applicati nel loop
  browser (`browser_loop.rs:206`); `evaluate` JS arbitrario senza gate; API key
  cloud da env invece che da local-first-secrets.
- Parte A (chat): costruito il MATTONE riutilizzabile e testato
  `crates/inference/src/streaming.rs` (parser streaming OpenAI/SSE -> delta,
  6 test). Il rewiring completo dell'handler chat NON fatto: tocca la fondazione
  (la chat reale passa da `submit_operational_prompt`, flusso operational-first
  via PromptBrain) e richiede prima lo streaming nel trait InferenceProvider +
  router. E' il workstream A4 del piano. Inference: 23 test verdi. Niente rotto,
  MLX intatto.

## 2026-05-28

### Inference provider routing: ADR 0007 + scaffold crates/inference

- Decisione (ADR `docs/decisions/0007-inference-provider-routing.md`): si passa
  da runtime unico MLX a uno strato di routing inferenza. Router + gate privacy
  SEMPRE in Rust (confine di sicurezza); engine pluggable dietro trait. Engine
  locale: mistral.rs (Rust-native, vision, cross-OS, in-process), llama.cpp via
  `llama-cpp-2` come fallback in Rust; MLX retrocede a provider opzionale Apple;
  Python solo provider opzionale per modelli che esistono solo li'. Cloud
  opt-in/gated via due adapter: OpenAI-compatibile (OpenAI/OpenRouter/Together/
  Groq + Ollama locale e cloud su /v1) e Anthropic.
- Scaffold `crates/inference` (fette 1-2 dell'ADR):
  - `provider.rs`: trait `InferenceProvider` + `CapabilityDescriptor`
    (locality, vision, tools, context_window, tps) + `Requirements`.
  - `policy.rs`: `PrivacyPolicy` deny-by-default sul cloud (`local_only` /
    `allowing_cloud`).
  - `router.rs`: `ModelRouter` selezione local-first (locale prima del cloud,
    ordine di inserimento come tie-break), implementa il trait `JsonRuntime`
    gia' consumato da Brain/subagenti/gateway -> drop-in, nessun cambio ai
    chiamanti. Errore `no_provider_available` quando nulla e' eleggibile.
  - `openai_compat.rs`: `OpenAiCompatProvider` su `{base}/chat/completions`
    (copre OpenAI-likes + Ollama local/cloud). Parsing isolato in
    `parse_chat_completion` (puro, testabile senza rete): estrae content,
    unwrap fence markdown, valida required_keys, mappa usage->TokenMetrics.
  - 9 test unit verdi (router selection/policy/vision + parse JSON/missing/
    non-JSON/fenced). Aggiunto ai workspace members.

Perche': "tutto locale sempre" non regge su HW piccoli e OS diversi; serve
local-first per default con delega cloud esplicita. Il trait rende l'engine
sostituibile senza toccare il resto; il router resta in Rust per non spostare
il gate privacy fuori dal Core.

A/B inference path validato live (2026-05-28):
- `ModelRouter` + `OpenAiCompatProvider` puntato a Ollama
  (`http://127.0.0.1:11434/v1`) usato come `JsonRuntime` del
  `RuntimeBrowserLoopPlanner` sul vero loop Trenitalia. 6 iterazioni pulite,
  tutte `observed`, `loop_0` stabile, JSON azione valido a ogni passo →
  il nuovo crate `inference` guida il loop browser end-to-end senza toccare
  Brain/gateway. Path architetturale confermato.
- Harness aggiornato: `examples/trenitalia_live.rs` con
  `INFERENCE_BACKEND=ollama|mlx`, `OLLAMA_MODEL`, `OLLAMA_API_KEY`.
- Reso configurabile il timeout planner via
  `LOCAL_FIRST_BROWSER_PLANNER_TIMEOUT_SECONDS` (default 20s): un 8B a freddo
  con prefill ~2.7k token supera i 20s, backend diversi hanno latenze diverse.
- `OpenAiCompatProvider` ora onora `request_timeout_seconds`.
- Modelli Ollama disponibili: locali `gemma4:latest` (8B), `llama3.1:8b`;
  cloud (opt-in, richiedono auth) `qwen3-vl:235b-cloud` (VISION), `qwen3.5:397b`,
  `deepseek-v3.2:671b`, `glm-4.6:355b`, `kimi-k2.5`, `ministral-3:14b`, ecc.
- BLOCCO cloud: i modelli `:cloud` rispondono `unauthorized` / "internal
  service error": serve `ollama signin` (il daemon tiene la credenziale) oppure
  `OLLAMA_API_KEY` come bearer. Nessuna credenziale Ollama in env qui.
- Nota comportamentale: `gemma4:8b` mostra lo STESSO pattern del 4B MLX
  (clicca/digita stazioni ma non conferma l'autocomplete) → coerente con
  "il blocco e' il loop/combobox, non solo la taglia del modello". La prova
  definitiva (modello frontier completa o no) richiede il modello cloud.

TASK TRENITALIA COMPLETATO end-to-end (2026-05-28) con qwen3-vl:235b via Ollama
Cloud (`https://ollama.com/v1`, bearer key) attraverso il `ModelRouter` +
`OpenAiCompatProvider`. Estratte 3 opzioni reali (Frecciarossa 9734/9736/9738,
09:05-09:25, ~3h40m, €47-52) e stop prima dell'acquisto, esattamente come da
goal. Path: stazioni+conferma autocomplete -> calendario+giorno+ora -> click
ricerca -> handoff cross-dominio a lefrecce.it (loop_0 stabile anche li') ->
estrazione e complete. 11 iterazioni.

Cosa e' servito (in ordine di scoperta):
1. Auth Ollama Cloud: i modelli `:cloud` sul daemon locale danno "internal
   service error"; funziona l'endpoint diretto `https://ollama.com/v1` con
   bearer API key e nome modello SENZA suffisso `-cloud` (es. `qwen3-vl:235b`).
2. Parser robusto nel provider: qwen emetteva JSON valido + token di troppo
   (`...}"}`); `serde_json::from_str` falliva su "trailing characters" e
   uccideva run buoni. Aggiunto `first_json_object` (estrazione primo oggetto
   bilanciato, rispetta stringhe/escape) dietro `repair`. 11 test verdi.
3. Context profile = leva decisiva: col profilo `compact` (pensato per Gemma
   E4B) qwen si auto-bloccava perche' la compattazione TAGLIAVA le celle-giorno
   del calendario ("day 10 not visible in truncated snapshot"). Col profilo
   `full` ha completato. LEZIONE: la compattazione va legata alla
   `context_window` del provider (gia' nel CapabilityDescriptor): modelli a
   contesto ampio -> snapshot full; modelli piccoli -> compact.

SICUREZZA: la API key Ollama e' stata usata solo come env transitoria, mai
scritta su file/codice/commit. E' comparsa in chiaro nella conversazione ->
va considerata esposta e ruotata; in produzione deve stare in
`local-first-secrets` (secret_ref), non in env.

FATTO (a) auto context-profile dalla capability del modello:
- `ModelRouter::active_context_window(requirements)` espone la finestra del
  provider selezionato.
- `BrowserContextProfile::for_context_window(window)`: env override vince
  sempre (ablation/debug); altrimenti window >= 16_384 -> Full, ignota/piccola
  -> Compact. `from_env` refattorizzato su `from_env_override() -> Option`.
- `RuntimeBrowserLoopPlanner::with_context_profile(runtime, profile)` nuovo
  costruttore; `new` invariato (from_env).
- Harness sceglie il profilo dalla finestra del router (ramo Ollama) o None
  (ramo MLX -> Compact). Verificato live: log
  `context_window=Some(32768) -> profile Full` senza flag manuale, comportamento
  corretto. Test: inference 12, gateway controller 14 (incl.
  `context_profile_scales_with_model_context_window`).

FATTO (e) ModelRouter cablato nel gateway reale:
- `JsonRuntimeProvider` (inference): incapsula un `JsonRuntime` esistente (es.
  `RuntimeClient` MLX) come `InferenceProvider`.
- `build_browser_inference_router(gemma_url)` in main.rs: default = MLX locale
  (comportamento invariato); opt-in OpenAI-compat con
  `LOCAL_FIRST_INFERENCE_BACKEND=openai` + `_BASE_URL`/`_MODEL`/`_API_KEY`/
  `_CONTEXT_WINDOW`/`_CLOUD`. Cloud gated dalla privacy policy del router.
- `execute_browser_loop_read_only_task` ora costruisce il router e sceglie il
  profilo via `BrowserContextProfile::for_context_window(active_context_window)`,
  poi `RuntimeBrowserLoopPlanner::with_context_profile`. Rimossi `new`/`from_env`
  ora inutili. Build workspace pulita, test 18 (gateway controller) + 47 + 13.

FATTO (b) LocalProvider mistral.rs (feature-gated, ADR 0007):
- Estratto parser JSON-da-testo condiviso in `inference/src/json_parse.rs`
  (`json_response_from_text`, fence strip, `first_json_object` con repair);
  `openai_compat` ora lo riusa.
- `mistralrs_provider.rs` (cfg feature `local-mistralrs`): `MistralRsProvider`
  in-process, possiede un runtime tokio e fa block_on su
  `ModelBuilder::new(id).with_auto_isq(Four).build()` e
  `model.send_chat_request(TextMessages)`. API verificata sull'esempio ufficiale
  mistral.rs 0.8.1 (`response.choices[0].message.content`, `response.usage`).
- Dep opzionali `mistralrs`/`tokio` dietro feature `local-mistralrs`; build
  DEFAULT non le compila (verificato: mistralrs assente dal cargo tree default,
  13 test verdi). Su Apple Silicon va aggiunta la feature `metal` di mistral.rs.

FATTO: mistral.rs cablato come backbone locale DEFAULT (scelta utente: default
cross-OS, allineato ad ADR 0007). MLX retrocede a fallback/opzione.
- `impl<T: JsonRuntime + ?Sized> JsonRuntime for Arc<T>` in subagents: permette
  di condividere un router (e quindi un modello caricato una volta) tra i target
  clonando l'Arc.
- gateway: feature `default = ["local-mistralrs"]`, con escape hatch
  `--no-default-features` per build leggera MLX-only. `local-mistralrs` inoltra
  alla feature del crate inference.
- `build_browser_inference_router`: selezione backend via
  `LOCAL_FIRST_INFERENCE_BACKEND` = openai | mistralrs | mlx. Default quando la
  feature e' compilata = mistralrs (`try_build_mistralrs_router`); su errore di
  load fa fallback a `build_mlx_router` con warning. Modello default
  `Qwen/Qwen3-4B` (text; override `LOCAL_FIRST_INFERENCE_MODEL`),
  supports_vision=false (il provider fa solo generate_json testuale per ora).
- `execute_browser_loop_read_only_task`: il router e' costruito UNA volta per
  task (Arc) e clonato per ogni target -> il modello mistral.rs si carica una
  sola volta, non per-target. Profilo contesto calcolato una volta dalla
  context_window del router.
- Verificato: build default (feature on) Finished, build `--no-default-features`
  pulito, gateway controller 14 test. UNICO warning = preesistente
  `browser_loop_decision_prompt` (usato solo nei test).

NON ancora validato a runtime: il caricamento/inferenza in-process di mistral.rs
su questa macchina (scaricherebbe il modello da HF e girerebbe CPU-only finche'
non si abilita la feature `metal` di mistralrs). Compile-verificato contro API
0.8.1; il fallback MLX garantisce che l'app resti funzionante se il load fallisce.

Risposta a "abbiamo ancora MLX?": MLX non e' piu' il default forzato. mistral.rs
e' il default cross-OS (quando compilato); MLX e' fallback su errore load e
opzione esplicita (`--no-default-features` o `LOCAL_FIRST_INFERENCE_BACKEND=mlx`).

Piano "ritiro MLX" (scelto: sequenza sicura). MLX NON e' un fallback rimovibile:
alimenta la CHAT (`/api/chat/generate_stream` -> `{gemma}/generate_stream`),
intent, health, cancel, autostart (17 rif. a `gemma_runtime_url`). mistral.rs
oggi fa solo `generate_json` (loop browser), niente streaming chat. Quindi
l'eliminazione e' l'ULTIMO passo. Nessun modello e' stato scaricato da
mistral.rs prima dello smoke; su disco c'erano solo i modelli MLX Gemma
(~10,7 GB: e4b-it-4bit 4,9G, E2B-it-4bit 3,4G, google/gemma-4-E2B-it 2,4G) +
`.venv-mlx` 718M.

FATTO step validazione runtime mistral.rs (smoke
`crates/inference/examples/mistralrs_smoke.rs`, `--features local-mistralrs`):
caricato `Qwen/Qwen3-0.6B`, ISQ Q4K su CPU, `generate_json` -> valid=true,
json `{"ok":true,"engine":"mistralrs"}`. Il parser condiviso ha spacchettato il
fence markdown. CPU: ~1.5 tok/s (scaricato Qwen3-0.6B in HF cache durante lo
smoke). CORRETTEZZA ok; VELOCITA' richiede feature `metal` (MLX fa ~28-32 tok/s).

### Lavoro autonomo notturno (2026-05-28, utente a dormire)

Vincolo dato: andare avanti in autonomia MA non fare azioni distruttive
(niente rimozione MLX / cancellazione modelli), tenere l'albero verde, lasciare
le decisioni a lui.

VALIDAZIONE VELOCITA' METAL (decisiva per il ritiro MLX):
- Aggiunta feature `local-mistralrs-metal = ["local-mistralrs","mistralrs/metal",
  "mistralrs/accelerate"]`. Build Metal OK.
- Smoke su `google/gemma-4-E2B-it` (gia' in cache, nessun download) via Metal:
  **11.4 tok/s** (vs 1.5 su CPU, vs ~28-32 di MLX sull'E4B). Funziona ma e'
  ~2-3x piu' lento di MLX sulla stessa famiglia Gemma, e per giunta su un
  modello PIU' PICCOLO (E2B/2B vs E4B/4B).
- Provato anche con PagedAttention (`with_paged_attn`, fallback grazioso se non
  disponibile): **11.0 tok/s**, invariato sul single-request (il beneficio di
  paged attn e' sul throughput concorrente, non sulla latenza per-token). Dummy
  run piu' rapido (1s vs 26s). paged_attn TENUTO nel provider.
- CONCLUSIONE/RACCOMANDAZIONE (decisione utente): NON rimuovere MLX ovunque.
  Su Apple MLX resta piu' veloce; conviene la strategia PER-PIATTAFORMA
  (mistral.rs cross-OS su Win/Linux, MLX su Apple) gia' prevista. Per questo
  NON ho fatto il refactor async della chat-su-mistral.rs (sarebbe un downgrade
  su Apple) ne' rimosso nulla.

FATTO (c) AnthropicProvider:
- `crates/inference/src/anthropic.rs`: Messages API (`/v1/messages`, header
  `x-api-key`+`anthropic-version`), parsing isolato `parse_anthropic_message`
  (concatena i blocchi text, usage input/output_tokens -> TokenMetrics, riusa
  `json_response_from_text` con repair). 4 unit test.
- Cablato nel gateway: `LOCAL_FIRST_INFERENCE_BACKEND=anthropic` +
  `LOCAL_FIRST_INFERENCE_MODEL` (default `claude-sonnet-4-6`) +
  `LOCAL_FIRST_INFERENCE_API_KEY`. Locality Cloud, policy allowing_cloud.

FATTO (d) parte sicura - ritenzione snapshot nel profilo compact:
- `is_interactive_snapshot_line` ora include `gridcell`, `cell`, `row`,
  `menuitemradio`: le celle-giorno del calendario e le righe risultato
  sopravvivono alla compattazione (era la causa del blocco qwen "day 10 not
  visible in truncated snapshot"). Test `compact_frame_retains_calendar_gridcell`.
- NON fatto (tocca il runner, rischioso overnight): iniezione deterministica
  type->ArrowDown->Enter per combobox. Lasciato come follow-up.

Stato test: inference 17, gateway (light, --no-default-features) 19+48,
controller 15. Albero verde sia light sia default (mistral.rs).

DECISIONI CHE RESTANO A TE (non eseguite di proposito):
1. Strategia backend locale alla luce dei 11.4 tok/s Metal: per-piattaforma
   (consigliata) vs mistral.rs ovunque vs tenere MLX di default su tutto.
2. Se per-piattaforma/mantieni MLX: forse RIVEDERE la scelta "mistral.rs default"
   fatta prima (oggi il gateway prova mistralrs di default quando compilato;
   potrebbe avere senso default=mlx su Apple).
3. Solo se si decide di ritirare MLX su una piattaforma: chat streaming su
   mistral.rs (refactor async + modello in AppState) e POI rimozione MLX +
   cancellazione ~10,7 GB modelli + `.venv-mlx`. NON toccato.
4. Ruotare la API key Ollama incollata in chat (esposta nel transcript).

Altre fette in coda: (f) vision in-process via `VisionModelBuilder` di mistral.rs;
ottimizzare perf mistral.rs (paged_attn, GGUF prequantizzato) se si vuole
avvicinare MLX.

### Tab hygiene sidecar + piano esplicito nel prompt browser

- Risolto il fallimento live `BROWSER_TAB_NOT_FOUND: tab not found: loop_0`.
  Causa: `restartAssistantVisible` (fallback headless->visibile) chiamava
  `stop()` che faceva `pages.clear()` distruggendo la mappa dei tab, e non
  c'era recovery se la pagina moriva a meta' loop (popup/crash/target chiuso).
- `session_manager.ts`: introdotto `closeContext()` (chiude il context ma
  preserva i metadati target) usato dal restart; `stop()` resta il reset totale.
  Aggiunta mappa persistente `targetMeta` (url+label per targetId) e
  `resolvePage()` async auto-recuperante che riapre il target all'ultimo URL
  noto invece di lanciare `BROWSER_TAB_NOT_FOUND`. `closeTab` reso idempotente,
  `open` gestisce un target esistente ma chiuso. Regression test reale in
  `tests/browser_methods.test.ts` (chiude il Page interno e verifica il
  recupero). 41/41 test sidecar verdi.
- `BrowserLoopRequest` ha ora un campo `plan: Vec<String>` (checklist ordinata
  di sotto-obiettivi). Il loop la renderizza come sezione `PLAN:` in cima
  all'action frame; resta agnostico sulla sorgente del piano. Aggiunta RULE 0
  "Follow the PLAN top to bottom, one item per turn, usa Recent actions per
  capire cosa e' fatto".
- Il gateway riempie il piano da `browser_loop_plan_for_source(draft)`
  (cookie -> partenza -> suggerimento -> arrivo -> suggerimento -> data -> ora
  -> Cerca -> estrai opzioni). E' ancora derivato dal draft euristico treno:
  quando l'OrchestratorBrain generera' un OperationalPlan con step browser,
  il piano dovra' arrivare da li' (vedi TODO step #3).
- `last_prompt_*.txt`/`last_response_*.txt` ora dietro
  `LOCAL_FIRST_BROWSER_LOOP_DEBUG=1`, non piu' I/O di debug nel path di prod.

Perche': il loop browser era reattivo puro (snapshot -> 1 azione) e il piano
non arrivava mai al modello; un E4B su una pagina Trenitalia con decine di ref
sceglieva azioni a caso o saltava step. E senza tab hygiene nessun
miglioramento di planning era nemmeno osservabile end-to-end.

Test live Trenitalia (2026-05-28, headless, 14 iter, profilo compact) via
`cargo run -p local-first-desktop-gateway --example trenitalia_live`:
- Tab hygiene CONFERMATA: `loop_0` stabile su tutte le 14 iterazioni, nessun
  `BROWSER_TAB_NOT_FOUND`. Il blocker duro e' risolto.
- Plan injection PARZIALE: il modello segue la struttura (partenza, arrivo,
  data) ma oscilla e non completa. Esce con `max browser loop iterations
  reached`, senza opzioni.
- Causa esatta (da snapshot catturato): i campi stazione sono combobox con
  label "digita la stazione poi selezionala dall'elenco con i tasti frecce e
  conferma con invio". Il listbox dei suggerimenti NON compare come ref `option`
  nello snapshot, quindi la RULE 2 ("clicca il suggerimento") non e'
  applicabile: non c'e' nulla da cliccare. Il modello ri-digita all'infinito
  (la partenza finiva "Napoli CentraleNapoli Centrale", doppia) e non conferma
  mai, non arriva a data/ora/Cerca.

TODO prossimi step (in ordine):
1. Conferma combobox deterministica nel loop: per i campi autocomplete che
   chiedono "conferma con invio", dopo il `type` eseguire `press ArrowDown` +
   `press Enter` invece di aspettare un suggerimento cliccabile. In
   alternativa/aggiunta: primitiva sidecar "seleziona da combobox" e/o cattura
   del listbox dei suggerimenti negli snapshot (gap di coverage del sidecar).
2. Stato di avanzamento esplicito: il loop dovrebbe tracciare quali step del
   piano sono soddisfatti e dire al modello "step corrente = N" invece di farlo
   inferire dalle azioni recenti (con 14 iter perde il filo e ri-compila campi
   gia' pieni).
3. De-hardcodare il draft treno: far generare a Gemma un OperationalPlan
   strutturato a inizio task e alimentare `with_plan` da li' (coerente con la
   nota PROJECT.md "niente regex/keyword nel core").

Note infra test: example `crates/desktop-gateway/examples/trenitalia_live.rs`;
`browser_loop_controller` ora `pub mod` nel lib del gateway per essere
richiamabile da example/harness. Debug prompt/response dietro
`LOCAL_FIRST_BROWSER_LOOP_DEBUG=1`. Runtime MLX: `make server` su :8765.

### Browser context firewall per Gemma 4

- Sostituito il taglio grezzo dello snapshot nel planner browser con una
  action frame compatta: task, pagina, refs, controlli rilevanti, ultimo passo,
  fallimenti recenti e tool ammessi.
- Aggiunto supporto runtime a `LOCAL_FIRST_BROWSER_CONTEXT_PROFILE` con profili
  `full`, `compact` e `minimal` per misurare overload vs over-compression senza
  cambiare modello, quantizzazione o runner.
- Il profilo default resta `compact`: seleziona linee con ref interattivi,
  match col goal, keyword browser e ref coinvolti in errori recenti.
- Aggiunto benchmark operativo
  `docs/benchmarks/gemma4-browser-context-ablation.md` per registrare quando
  il contesto compatto mantiene il piano e quando invece toglie informazioni
  necessarie.
- Eseguito smoke benchmark live
  `output/gemma4-browser-context-smoke-20260528-193119/result.md`:
  `full` 16.177 char medi, `compact` 8.666, `minimal` 4.986; tutti hanno
  prodotto JSON planner valido 4/4, ma `minimal` ha risposte meno grounded.
  La failure comune e' `BROWSER_TAB_NOT_FOUND: tab not found: loop_0`, quindi
  il prossimo collo di bottiglia live e' tab hygiene/target reuse del sidecar,
  non la sola dimensione del contesto.
- Dal post Reddit OpenClaw/Gemma 4 TurboQuant: il problema osservato e'
  coerente con agenti locali su Mac medio che faticano quando l'agente aggiunge
  molto contesto a ogni richiesta; la mitigazione da perseguire qui resta
  context preparation/action frame piccolo prima di ottimizzazioni cache.

Perche': Gemma 4 E4B non regge payload browser troppo grandi. Il problema va
risolto prima del tuning KV/cache: il modello deve scegliere la prossima azione
da un frame piccolo ma sufficiente, non ingerire DOM/snapshot/storia completa.

## 2026-05-22

### OpenHuman come spunto, non copia

- Chiarito in `PROJECT.md` che OpenHuman e' un riferimento di ispirazione gia' considerato.
- Lo useremo per studiare come hanno risolto agenti, memoria, tool, permission flow e UX operativa.
- Non lo useremo come base da copiare, forkare o replicare nello stack.
- Ogni idea presa da OpenHuman dovra' essere adattata alle decisioni gia' validate: local-first, Rust Core, Tauri, runtime Python/MLX con Gemma 4, subagenti auditabili e permessi deny-by-default.

Perche': il progetto deve imparare da implementazioni esistenti senza perdere identita' architetturale e vincoli locali.

## 2026-05-23

### Memory Facade completa

- Creato design `docs/memory/memory-facade-design.md`.
- Creato piano operativo `docs/superpowers/plans/2026-05-23-memory-facade.md`.
- Aggiunto crate `crates/memory`.
- Aggiunti contratti multilingua e multiutente: `MemoryRef`, eventi, memorie, entita', relazioni, evidenze, wiki page e context pack.
- Aggiunto `SQLiteMemoryStore` con CRUD per eventi, memorie, entita', relazioni, evidenze, wiki metadata, audit accessi e tombstone logici.
- Aggiunta policy anti-esfiltrazione per domini privacy, sensibilita', payload raw ed export ampio.
- Aggiunta redaction ricorsiva di segreti.
- Aggiunta crittografia applicativa XChaCha20-Poly1305 per payload sensibili tramite `KeyProvider`.
- Aggiunto graph MVP sopra entita'/relazioni SQLite.
- Aggiunto wiki Markdown adapter con frontmatter refs e blocco di contenuti raw secret.
- Aggiunta `MemoryFacade` per context pack policy-gated, auditati e richiamabili dai subagenti.
- Testato il crate memoria con contratti, SQLite, policy, crypto, graph, wiki e facade.

Perche': la memoria e' un pezzo separato e va completata come componente autonomo. La facade unisce SQLite, grafo e wiki senza fonderli, mantenendo refs stabili, isolamento user/workspace, privacy domains, anti-esfiltrazione, crittografia e audit.

### Graphify come backend grafo

- Confermato che il backend grafo target e' `safishamsi/graphify`.
- Clonato e ispezionato Graphify a commit `990ac706d823bf92275333433fde4ef4782a9139`.
- Verificata la pipeline `detect -> extract -> build_graph -> cluster -> analyze -> report -> export`.
- Verificato che `graph.json` usa formato NetworkX node-link con `nodes` e `links`.
- Verificata l'interfaccia LLM query-first: `graphify query`, `graphify path`, `graphify explain`.
- Aggiornato il design memoria con regole adapter Graphify.
- Aggiornato `PROJECT.md` per chiarire che Graphify e' il motore scelto per memoria tecnica/documentale.
- Aggiunto `metadata` anche a `MemoryRelation`.
- Lo store SQLite salva ora `relations.metadata_json`.
- I test coprono metadati Graphify su edge: `graphify_edge_id`, node ids e path artefatti.
- Aggiunto adapter `GraphifyImport` per importare artifact `graphify-out` nel Memory Core.
- Aggiunto `GraphifyCli` per costruire comandi query/path/explain senza far leggere report interi ai caller.
- Esposto import Graphify da `MemoryFacade`.

Perche': Graphify produce un grafo tecnico/documentale richiamabile (`graph.json`, `GRAPH_REPORT.md`, `graph.html`). Le nostre entita' e relazioni devono poter conservare mapping verso quei nodi/edge senza permettere a Graphify di bypassare policy, privacy domains, multiutente e anti-esfiltrazione.

### Import output MemoryAgent

- Aggiunto contratto `MemoryExtraction`.
- Aggiunti `ExtractedMemory`, `ExtractedEntity`, `ExtractedRelation`.
- Aggiunto `MemoryExtractionSummary`.
- Aggiunto `MemoryFacade::apply_extraction`.
- L'import crea memorie confermate, upserta entita', salva relazioni e collega evidenze.
- Testato che un output JSON del `MemoryAgent` diventi context pack richiamabile con evidence refs.

Perche': il runtime/subagente non deve scrivere direttamente nello store. L'output del `MemoryAgent` deve passare dalla facade, che conserva isolamento user/workspace, refs stabili, policy e auditabilita'.

### Memory UI Read Model

- Aggiunto `MemoryUiReadModel`.
- Aggiunte viste UI-safe per dashboard, lista memorie, dettaglio memoria e privacy overview.
- Aggiunti metodi read-only nello store per entita', relazioni e wiki pages.
- La dashboard espone conteggi per status, privacy domain e sensitivity.
- Il dettaglio memoria espone refs, evidenze, entita', relazioni e wiki pages collegate.
- Le decisioni di visibilita' vengono auditate anche quando negano una memoria.
- I payload raw degli eventi non vengono restituiti dalle viste UI.

Perche': la UI Tauri/React ha bisogno di dati gia' pronti per schermate operative, ma non deve bypassare privacy, anti-esfiltrazione o audit leggendo direttamente tabelle grezze.

### Memory production-ready closure

- Creata spec `docs/superpowers/specs/2026-05-23-production-memory-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-production-memory.md`.
- Aggiunto branch `fabio/production-memory` per isolare la chiusura.
- Aggiunto schema metadata con versione `2` e migrazioni idempotenti.
- Esteso `MemoryRecord` con `created_at`, `updated_at`, `last_seen_at`, `supersedes`, `superseded_by`, `correction_of`.
- Aggiunta API lifecycle auditata sulla facade: create candidate, update, confirm, reject, stale, merge, delete/tombstone.
- Aggiunto SQLite FTS5 per `search_memories`, con filtri policy, status, tipo, ranking deterministico e paginazione.
- Aggiunta wiki correction sync: Markdown modificato -> candidate correction con `correction_of`, senza overwrite silenzioso.
- Aggiunta API Graphify query/path/explain policy-gated con validazione root locale e ritorno di refs scoped.
- Aggiunte operations: health, backup locale, restore locale, maintenance integrity check + FTS rebuild.
- Aggiunto `MemoryError` / `MemoryResult` come boundary error tipizzato per la facade.
- Aggiunto contratto routine inference con `RoutineRecord`, `RoutineInference` e import via `MemoryFacade::apply_routine_inference`.

Perche': per considerare chiusa la memoria non bastava l'MVP. Servivano lifecycle completo, retrieval, sync bidirezionale minima, Graphify query sicura, operabilita' locale, errori tipizzati e copertura del contratto routine previsto dalla Fase 2.

### Principi architetturali confermati

- Il progetto e' language-agnostic e multilingua di default.
- Nessun contratto, agente, memoria o workflow deve assumere una lingua unica.
- L'italiano resta un caso d'uso primario, ma non deve diventare accoppiamento nel core.
- Va mantenuta una buona separazione dei file per dominio, evitando file lunghi da dividere tardi.

Perche': l'assistant deve lavorare su input reali e misti, spesso multilingua, e il core deve rimanere stabile anche se cambiano lingua, UI o runtime modello. Separare presto i file riduce il costo dei refactor man mano che i subagenti crescono.

### Split crate subagenti

- Diviso `crates/subagents/src/lib.rs` in moduli per dominio:
  - `types.rs`
  - `runtime.rs`
  - `runner.rs`
  - `prompt_guard.rs`
  - `agents.rs`
  - `tool_access.rs`
  - `workflow.rs`
  - `permissions.rs`
  - `graph.rs`
  - `orchestrator.rs`
  - `audit.rs`
- `lib.rs` ora resta solo il punto di export pubblico.
- Verificata la suite Rust dopo il refactor.

Perche': il file unico era arrivato a circa 1500 righe. Spezzarlo ora riduce accoppiamento e rende piu' semplice evolvere subagenti, audit, workflow e policy senza creare un monolite difficile da mantenere.

### Analisi mirata OpenHuman

- Clonato OpenHuman in `/tmp/openhuman-reference` solo per lettura.
- Ispezionato commit `934546b2b3ae20271c2cd82b95e8221efb199568`.
- Letti README, flow agent/subagent/tool, delegation policy, memory client reference, prompt injection guard, agent definitions e tool filtering.
- Creato ADR `docs/decisions/0001-openhuman-as-reference.md`.

Pattern da adattare:

- agent definitions data-driven.
- policy direct-first prima della delegazione.
- separazione tra tool visibili al modello e tool realmente eseguibili dal runtime.
- subagent runner isolato dal parent session.
- memory facade unica.
- prompt-injection guard prima di inference/tool loop.
- compressione/sintesi dei risultati grandi.

Perche': OpenHuman e' utile come repertorio di soluzioni concrete, ma ogni idea deve essere adattata ai nostri vincoli: local-first, Rust Core, MLX/Gemma, subagenti auditabili e deny-by-default.

### AgentDefinition registry e direct-first policy

- Aggiunto `AgentDefinition` nel crate subagenti.
- Aggiunti `AgentTier` e `ToolScope`.
- Aggiunto `default_agent_definitions()` per i nostri agenti iniziali.
- Aggiunta validazione della gerarchia: i worker non delegano, i reasoning agent non delegano ad altri reasoning agent.
- Aggiunta `DelegationPolicy` direct-first tramite `DelegationInput` e `DelegationDecision`.

Perche': OpenHuman mostra che hardcodare agenti e deleghe nel runner rende difficile governare tool, limiti e routing. Noi adattiamo il pattern mantenendo contratti piccoli, testati e coerenti con il nostro Rust Core.

### Prompt guard nel runner subagenti

- Aggiunto `guard_prompt`.
- Aggiunti `PromptGuardVerdict` e `PromptGuardResult`.
- Il `SubagentRunner` blocca prompt con pattern di instruction override, prompt exfiltration o secret exfiltration prima di chiamare il runtime.
- Testato che un prompt ostile non raggiunga il runtime finto.

Perche': OpenHuman applica enforcement server-side prima di inference/tool loop. Nel nostro progetto questo controllo deve vivere nel core/orchestratore, non nella UI, per evitare che un task subagente trasformi input non affidabile in tool call operative.

### Tool visibility vs execution

- Aggiunto `ToolDefinition`.
- Aggiunto `ToolAccessPlan`.
- Aggiunto `plan_tool_access`.
- Separata la lista di tool visibili al modello dalla lista di tool realmente eseguibili dal runtime.
- Testato che `ToolAgent` possa vedere un tool di scrittura per preparare un piano, ma possa eseguire solo i tool consentiti da scope, connector, azione e autonomia del task.

Perche': OpenHuman distingue i tool mostrati al modello dai tool che il runtime puo' invocare davvero. Nel nostro progetto questo evita che la capacita' di ragionare su un'azione diventi automaticamente permesso operativo.

### Query AuditStore

- Aggiunto `AuditStore::latest_result`.
- Aggiunto `AuditStore::recent_results_by_status`.
- Aggiunta deserializzazione dei record audit in `SubagentResult`.
- Testato recupero dell'ultimo risultato per task e filtro dei risultati recenti per stato.

Perche': l'audit non deve solo registrare eventi, deve permettere al core e alla futura UI di spiegare cosa e' successo: ultimo esito di un task, errori recenti e stato operativo dei subagenti.

### Review audit dedicate

- Aggiunta tabella SQLite `subagent_reviews`.
- Aggiunto `AuditStore::record_review`.
- Aggiunti `AuditStore::review_count` e `AuditStore::latest_review`.
- Testato che l'ultima review di un task sia recuperabile con reviewer, approvazione, rischio, richiesta approvazione e findings.

Perche': `SubagentReview` e' un oggetto di controllo distinto dal normale output del modello. Salvarlo come record dedicato rendera' piu' semplice costruire viste di approvazione, spiegazioni e blocchi operativi prima di azioni rischiose.

### Bootstrap progetto

- Inizializzato il repository Git.
- Creato ambiente locale `.venv-mlx` con `uv`.
- Aggiunti `pyproject.toml`, `.python-version`, `.gitignore` e `uv.lock`.

Perche': il progetto deve essere riproducibile localmente e non dipendere dalla venv storica usata negli esperimenti iniziali.

### Runtime locale Gemma 4

- Creato `runtimes/mlx-gemma4/server.py`.
- Il server carica una sola volta `mlx-community/gemma-4-e4b-it-4bit`.
- Esposti endpoint locali: `/health`, `/generate`, `/generate_json`, `/tool_call`, `/analyze_image`, `/benchmark`, `/shutdown`.
- Aggiunte metriche per richiesta: token, token/s, memoria peak, tempo.
- Aggiunta validazione JSON e repair attempt locale.

Perche': `PROJECT.md` stabilisce che Gemma 4 deve essere un sidecar Python/MLX persistente, non una CLI lanciata a ogni prompt e non un servizio cloud.

### Runtime locale Gemma 4 production hardening

- Aggiunta `RuntimeConfig` da env.
- `/health` espone configurazione locale, shutdown enabled, busy policy e allowed image roots.
- Aggiunto error payload stabile `{error: {code, message, retryable}}`.
- Aggiunto `RuntimeServiceError` con status HTTP coerente.
- Aggiunti `wait_if_busy` e `request_timeout_seconds` alle richieste.
- Il runtime puo' rifiutare richieste quando e' busy, invece di accodarle implicitamente.
- I deadline scaduti vengono respinti prima della generazione.
- I path immagine possono essere vincolati a root locali consentite.
- `/benchmark` espone summary aggregata delle metriche.
- `/shutdown` e' disabilitato di default e abilitabile via env.

Perche': il runtime e' la dipendenza operativa dei subagenti. Deve fallire in modo tipizzato, rispettare deadline/concorrenza e restare local-first anche su immagini e shutdown.

### Benchmark parity

- Portati nel server i 7 casi validati della suite storica Gemma 4.
- Aggiunto `scripts/gemma4_benchmark.py` per produrre `reports/gemma4_eval.jsonl`.
- `make benchmark` esegue la suite reale con MLX.

Perche': la Fase 1 deve conservare il comportamento gia' validato: JSON rigido, routine inference, memory extraction, tool calling, patch codice e vision/OCR.

### Subagenti

- Aggiornato `PROJECT.md` con `Subagent Manager`, Fase 1.5 e workflow MVP.
- Aggiunti contratti JSON condivisi per `SubagentTask`, `SubagentResult`, `SubagentReview`.
- Creato crate Rust `crates/subagents`.
- Aggiunti tipi base, registry agenti iniziali e validazione permessi deny-by-default.
- Aggiunti tipi per risultato, audit, review, risk level e findings.

Perche': il runtime LLM non deve diventare l'agente. Il coordinamento, i permessi, la memoria accessibile, l'audit e la cancellazione dei task devono vivere nel Rust Core.

### Stato verificato

- `make test`: Python e Rust passano.
- `make benchmark`: suite Gemma reale 7/7 passata.

## 2026-05-26

### Analisi performance rendering chat

- Analizzato il problema di blocchi/lentezza chat con messaggi lunghi,
  streaming token, Markdown/code block e scrollback grande.
- Creato piano `docs/plans/2026-05-26-chat-rendering-performance.md`.
- Creati appunti benchmark `docs/benchmarks/chat-rendering-performance.md`.
- Evidenza locale iniziale: lo stream usa gia' WebSocket locale invece di
  `invoke`; dopo la Fase 64 `ChatView` usa anche
  `@tanstack/react-virtual`, quindi il problema residuo non e' piu' assenza
  totale di virtualizzazione ma validazione della virtualizzazione con righe
  dinamiche.
- Evidenza locale secondaria: lo streaming visibile scrive su text node via
  `requestAnimationFrame`, ma il commit finale passa l'intera risposta a
  Markdown/GFM/sanitize/Mermaid e puo' bloccare su risposte lunghe.
- Ricerca aggiornata al 2026-05-26: Tauri usa WebView2 su Windows, WKWebView su
  macOS e WebKitGTK su Linux; esistono issue Tauri su performance DOM Linux,
  freeze WebView Linux e comportamenti WebView macOS Intel.
- Decisione raccomandata: restare su Tauri, completare l'architettura rendering
  chat con row memoization, cache Markdown, correzione scroll/measurement e
  benchmark UI prima di considerare Electron.
- Electron resta fallback misurato, non prima scelta: Chromium puo' ridurre
  varianza WebKitGTK, ma non risolve DOM/Markdown non limitati.

Perche': il collo di bottiglia piu' probabile e' ora nel rendering frontend
post-virtualizzazione e nel parse/layout finale del Markdown. Cambiare shell
prima di misurare e limitare DOM/render cost rischia di spostare il problema
senza risolverlo.

## Prossimo blocco

### ExecutionGraph subagenti

- Implementato `ExecutionGraph` in `crates/subagents`.
- Aggiunti `TaskNode` e `TaskState`.
- Il grafo calcola i task pronti quando tutte le dipendenze sono `succeeded`.
- Il grafo marca come bloccati i task pendenti con dipendenze `failed` o `cancelled`.
- Il grafo rifiuta dipendenze mancanti al momento dell'inserimento.

Perche': il Subagent Manager deve poter orchestrare workflow sequenziali/paralleli in modo auditabile, prima di introdurre esecuzione async o chiamate reali al runtime.

## Prossimo blocco

### Runtime client Rust

- Aggiunto `RuntimeClient` nel crate subagenti.
- Modellate `GenerateJsonRequest` e `GenerateJsonResponse`.
- La risposta conserva le metriche del runtime Python/MLX tramite `TokenMetrics`.
- Il client costruisce endpoint locali stabili e chiama `/generate_json`.

Perche': il Subagent Manager deve usare il runtime Gemma come primitiva locale HTTP. Il client e' tenuto separato dall'`ExecutionGraph` per non accoppiare scheduling, permessi e trasporto.

## Prossimo blocco

### SubagentRunner

- Aggiunto `JsonRuntime` come trait, implementato da `RuntimeClient`.
- Aggiunto `SubagentRunner` sincrono.
- Il runner valida i permessi del `SubagentTask` prima di chiamare il runtime.
- Il runner costruisce `GenerateJsonRequest` da `task.input`, `task.goal` e `task.budgets`.
- Il runner produce sempre un `SubagentResult` auditabile, anche in caso di permessi invalidi o runtime error.

Perche': questo e' il primo punto in cui i contratti dei subagenti diventano operativi. Il runner resta sincrono e testabile con un runtime finto; cancellazione, retry e parallelismo verranno aggiunti sopra questa base.

### SubagentRunner production hardening

- Aggiunto `SubagentError`.
- Il runner blocca task gia' cancellati prima di chiamare il runtime.
- Il runner marca `timed_out` se `timeout_seconds` e' gia' scaduto.
- `GenerateJsonRequest` porta `wait_if_busy` e `request_timeout_seconds` al runtime.
- I test verificano che timeout/cancel non raggiungano il runtime finto.

Perche': cancellazione e timeout devono essere enforce reali, non solo campi descrittivi nel contratto.

## Prossimo blocco

### SubagentOrchestrator

- Aggiunto `SubagentOrchestrator`.
- L'orchestratore mantiene un `ExecutionGraph`, i `SubagentTask` e un `SubagentRunner`.
- `run_ready_once()` esegue solo i task pronti.
- Lo stato del grafo viene aggiornato a `running`, poi `succeeded`, `failed` o `cancelled`.
- I task dipendenti restano bloccati quando una dipendenza fallisce.

Perche': serve un primo coordinatore deterministicamente testabile prima di introdurre parallelismo, cancellazione reale o integrazione Tauri/Rust Core.

## Prossimo blocco

### Workflow MVP routine startup

- Aggiunto `routine_startup_workflow`.
- Il workflow produce la catena `PlannerAgent -> RiskAgent -> MemoryAgent/ToolAgent -> ReviewAgent`.
- Aggiunto `WorkflowTaskSpec` per associare ogni `SubagentTask` alle sue dipendenze.
- Aggiunto `SubagentOrchestrator::add_workflow`.

Perche': `PROJECT.md` definisce questo workflow come MVP dei subagenti. Averlo come builder testato evita che la forma del grafo venga ricostruita a mano in UI o core.

## Prossimo blocco

### Workflow execution end-to-end

- Aggiunto `SubagentOrchestrator::run_until_blocked`.
- Testato il workflow MVP completo con runtime finto.
- L'orchestratore esegue `routine.plan`, poi `routine.risk`, poi `routine.memory` e `routine.tool`, infine `routine.review`.
- L'esecuzione si ferma quando non ci sono piu' task pronti.

Perche': prima di collegare il runtime reale serve dimostrare che la semantica del workflow e' corretta in memoria, senza dipendere da MLX o HTTP.

## Prossimo blocco

### Workflow smoke reale

- Aggiunto binario Rust `workflow_smoke`.
- Aggiunto target `make workflow-smoke`.
- Il comando usa `RuntimeClient`, `SubagentRunner`, `SubagentOrchestrator` e `routine_startup_workflow`.
- Lo smoke e' separato da `make test`, quindi non richiede Metal o server Python attivo durante i test unitari.
- Eseguito contro il server Python/MLX reale su `127.0.0.1:8765`: 5 task eseguiti, 0 failed, 0 blocked.

Perche': ora esiste una prima prova end-to-end locale: Rust orchestra subagenti, chiama il runtime Gemma via HTTP, riceve JSON validato e conserva metriche/audit per ogni task.

Nota emersa dallo smoke:

- La validazione attuale controlla chiavi richieste e tipi root semplici, ma non applica ancora completamente gli schemi JSON condivisi con vincoli annidati.
- Esempio: `SubagentReview.findings` oggi passa come array, ma il contratto condiviso vorrebbe oggetti `{severity, message}`.

## Prossimo blocco

### Validazione JSON annidata

- Rafforzato il validatore del runtime Python.
- Ora supporta ricorsivamente `type`, `properties`, `items`, `required`, `enum`.
- I workflow Rust passano uno schema minimo nel campo `schema` di `GenerateJsonRequest`.
- `SubagentReview.findings` viene validato come array di oggetti con `severity` e `message`.
- Ripetuto lo smoke reale: workflow Rust + runtime Python/MLX, 5 task, 0 failed, 0 blocked.

Perche': lo smoke precedente aveva mostrato un falso positivo: `findings` era un array di stringhe, mentre il contratto condiviso richiede oggetti. Questa modifica fa rispettare meglio i contratti senza introdurre ancora una dipendenza Python da `jsonschema`.

## Prossimo blocco

### AuditStore SQLite

- Aggiunto `AuditStore` nel crate subagenti.
- Usa SQLite tramite `rusqlite` con feature `bundled`.
- Crea tabella `subagent_results`.
- Salva `task_id`, `agent_id`, `status`, output, errori, metriche e audit JSON.
- Testato con database in-memory.

Perche': audit e ricostruibilita' sono principi centrali del progetto. La prima persistenza riguarda i risultati dei subagenti, per poter spiegare cosa e' stato deciso da quale agente e con quali metriche.

## Prossimo blocco

### AuditStore integrato nell'orchestratore

- Aggiunto `SubagentOrchestrator::run_until_blocked_recording`.
- Ogni `SubagentResult` prodotto dal workflow viene salvato in `AuditStore`.
- Testato con runtime finto e SQLite in-memory.

Perche': l'audit deve essere automatico nel percorso operativo, non un passaggio opzionale lasciato ai caller. Questo prepara il core Rust a ricostruire cosa ha fatto ogni subagente.

### Workflow status production hardening

- Aggiunto `WorkflowRunStatus`.
- Aggiunto `WorkflowRunSummary`.
- `AuditStore` crea e aggiorna `workflow_runs`.
- Aggiunti `start_workflow_run`, `finish_workflow_run`, `workflow_run_status`.
- Aggiunto `SubagentOrchestrator::run_workflow_recording`.
- I risultati possono essere associati a `workflow_run_id`.

Perche': la UI e il core devono sapere lo stato di una run completa, non solo l'ultimo risultato di un task.

### MemoryAgent bridge

- Aggiunto dependency `local-first-memory` in `crates/subagents`.
- Aggiunto `MemoryAgentImport`.
- Aggiunto `MemoryAgentImporter`.
- L'import accetta solo risultati prodotti da `MemoryAgent`.
- L'import applica `MemoryExtraction` e `RoutineInference` passando da `MemoryFacade`.

Perche': il `MemoryAgent` non deve scrivere nello store direttamente. Anche nel flusso subagenti, la memoria resta protetta da facade, policy, refs stabili e contratti production-ready.

## Prossimo blocco

### Capability Layer design

- Analizzato OpenHuman per la parte canali/integrazioni/skill.
- Chiarita la separazione tra `channels`, `integrations`, `skills`, MCP e browser automation.
- Decisione: copiare l'architettura, non il codice.
- Decisione: usare provider esterni tipo Composio/Zapier/Pipedream come acceleratori opzionali, non come dipendenza core.
- Creato design in `docs/superpowers/specs/2026-05-23-capability-layer-design.md`.
- Aggiornato `PROJECT.md` con `Capability Layer`, managed providers opt-in e separazione channels/integrations/skills.

Perche': costruire manualmente decine o centinaia di integrazioni richiederebbe troppo tempo. Il progetto deve scalare usando MCP e provider managed quando l'utente li abilita, mantenendo pero' policy, audit, memoria e subagenti sotto controllo locale.

### Capability Layer first slice

- Creato crate Rust `crates/capabilities`.
- Aggiunti contratti provider-neutral per provider, tool, call, connection, trigger, skill manifest e managed metadata.
- Aggiunto `CapabilityPolicy` con separazione tra tool visibili al modello e tool eseguibili.
- I provider managed/cloud richiedono `allow_managed_cloud`.
- Aggiunto `FakeCapabilityProvider` per test locali senza Composio live.
- Aggiunto `CapabilityFacade` per listare tool policy-gated, chiamare tool, filtrare connessioni per user/workspace e auditare le operazioni.
- Aggiunto audit in-memory con redazione di `access_token`, `refresh_token`, `api_key`, `password`, `secret`.
- Aggiunta validazione minima degli argomenti tool su `type`, `properties` e `required`.
- Aggiunti contratti trigger con enable/disable nel provider fake.
- Aggiunti contratti channel separati: `ChannelProvider`, `ChannelMessage`, `OutboundChannelMessage`, `ChannelCapabilities`, `FakeChannelProvider`.

Perche': questo crea il confine interno prima di integrare MCP o Composio. Subagenti e UI potranno parlare con un layer stabile, mentre provider nativi, MCP, managed, browser e skill restano intercambiabili e policy-gated.

### Subagents capability bridge

- Aggiunta dependency `local-first-capabilities` in `crates/subagents`.
- Aggiunto modulo `capability_bridge`.
- `capability_policy_context_for_task` trasforma `PermissionEnvelope` in `PolicyContext`.
- `plan_capability_access` usa `CapabilityPolicy` e `CapabilityTool` per produrre tool visibili/eseguibili.
- Il vecchio `plan_tool_access` resta disponibile per compatibilita' durante la migrazione.
- I test coprono mapping permessi, separazione visible/executable e blocco managed cloud senza opt-in.

Perche': i subagenti non devono conoscere Composio, MCP o provider specifici. Devono passare dal Capability Layer, che applica permessi, privacy domain, autonomia e boundary cloud in modo uniforme.

### MCP Capability Provider

- Aggiunto `McpTransport` come boundary testabile per JSON-RPC MCP.
- Aggiunto `McpCapabilityProvider`.
- Aggiunto `McpToolPolicy` per assegnare action class, privacy domains e sensitivity ai tool MCP.
- Aggiunto `InMemoryMcpTransport` per test locali senza server MCP esterno.
- `tools/list` viene mappato in `CapabilityTool`.
- `tools/call` viene mappato in `CapabilityCallResult`.
- `initialize` invia poi `notifications/initialized`.
- I trigger MCP non sono ancora supportati e ritornano errore tipizzato.

Perche': MCP e' il primo moltiplicatore locale per evitare di scrivere ogni integrazione a mano. Il transport resta separato cosi' potremo aggiungere stdio persistente o HTTP streamable senza cambiare il contratto del Capability Layer.

### MCP stdio transport

- Aggiunto `McpStdioConfig`.
- Aggiunto `McpStdioTransport`.
- Il transport avvia un processo locale persistente con stdin/stdout piped.
- Ogni request invia JSON-RPC 2.0 newline-delimited con id incrementale.
- Le notification vengono inviate senza attendere risposta.
- Il drop del transport termina il processo figlio.
- Aggiunto binario fixture `fake_mcp_stdio` per testare un processo reale.
- Il test verifica initialize, `tools/list` e `tools/call` sullo stesso processo.

Perche': ora MCP non e' solo un contratto in memoria. Abbiamo il primo transport locale reale, ancora vendor-neutral e senza Composio, pronto per registrare server MCP stdio scelti dall'utente.

### Composio managed provider

- Aggiunto `ComposioTransport` come boundary per chiamate Composio senza legare il core a un client specifico.
- Aggiunto `ComposioCapabilityProvider`.
- Aggiunto `ComposioProviderConfig` user/workspace scoped.
- Aggiunto `ComposioToolPolicy` per action class, privacy domains e sensitivity.
- Aggiunto `InMemoryComposioTransport` per test locali senza API key o chiamate cloud.
- Il provider dichiara `DataBoundary::ManagedCloud` e auth mode `composio_connect_or_api_key`.
- Mappa tool Composio in `CapabilityTool`.
- Mappa connected accounts in `CapabilityConnection`.
- Mappa triggers in `CapabilityTrigger`.
- Esegue tool con payload che include `user_id` e `arguments`.

Perche': Composio serve a scalare rapidamente la copertura integrazioni, ma deve restare un provider managed opt-in dietro policy/audit locali. Questo adapter prepara l'integrazione reale senza rompere il principio local-first di default.

## Prossimo blocco

### Durable Task Runtime come fondamento trasversale

- Rivalutata la roadmap dopo aver chiarito due requisiti:
  - browser automation deve supportare form, prenotazioni, ricerche complesse e operazioni multi-step.
  - i task lunghi di ore o giorni non sono specifici del browser, ma devono valere per tutto il sistema.
- Decisione: introdurre un crate centrale `crates/task-runtime`.
- Il Durable Task Runtime gestira' task indipendenti, workflow, code, priorita', resource governor, lease/heartbeat, checkpoint, retry/backoff, pause/resume/cancel e approval gates.
- Le risorse iniziali da governare sono: `llm_inference`, `browser_session`, `network_io`, `filesystem_io`, `connector_api`, `memory_indexing`, `graph_indexing`, `user_wait`, `background_maintenance`.
- I task multipli potranno essere eseguiti in parallelo solo quando priorita', dipendenze e risorse lo permettono.
- Browser automation restera' un modulo separato, ma usera' il Durable Task Runtime per prenotazioni, compilazione form, monitoraggi e task di giorni.
- Aggiornato `PROJECT.md` con la nuova fase `Durable Task Runtime`, la fase `Browser Automation` separata e la roadmap successiva.
- Aggiornata la spec del Capability Layer per chiarire che provider e capability non possiedono scheduling, retry o checkpoint.
- Aggiornata la spec runtime/subagenti per chiarire che i subagenti restano responsabili degli step, mentre la durata globale passa al task runtime.
- Creati:
  - `docs/superpowers/specs/2026-05-23-durable-task-runtime-design.md`
  - `docs/superpowers/plans/2026-05-23-durable-task-runtime.md`

Perche': senza un task runtime centrale, browser automation, subagenti, connettori e manutenzioni finirebbero per duplicare code, retry, limiti risorse, approvazioni e recovery. Questo blocco va chiuso prima del browser reale.

### Durable Task Runtime first production slice

- Creato crate `crates/task-runtime`.
- Aggiunti contratti core: `TaskRecord`, `TaskStatus`, `TaskPriority`, `ResourceClass`, `ResourceRequirement`, `RetryPolicy`, `TaskId`, `WorkflowId`, `UserId`, `WorkspaceId`.
- Aggiunto `TaskStore` SQLite con migrazioni idempotenti.
- Lo store persiste task, dipendenze workflow, reservation risorse, checkpoint e approval records.
- Aggiunto scheduler deterministico:
  - priorita' `critical > high > normal > low > background`.
  - rispetto di `not_before`.
  - dipendenze completate prima dei task figli.
  - dipendenze terminali marcano i figli come `waiting_external_event`.
- Aggiunto `ResourceGovernor` con limiti per classe risorsa e transizione `waiting_resource` con motivo esplicito.
- Aggiunto `LeaseManager` con acquire, heartbeat e recovery dei lease scaduti.
- La recovery libera le reservation e rimette in coda task running con lease stale.
- Aggiunti checkpoint append-only con payload raw e payload redatto separati.
- Aggiunto `RetryController` con backoff e failure terminale dopo `max_attempts`.
- Aggiunto `ApprovalGate` per request/approve/reject:
  - request porta il task in `waiting_user_approval`.
  - approve rimette il task in coda.
  - reject cancella il task senza esecuzione.
- Aggiunti `TaskExecutor`, `FakeTaskExecutor` e `TaskRuntime` facade.
- `TaskRuntime::run_ready_once` collega scheduler, resource governor, lease, executor, checkpoint, approval e retry.
- Aggiunto `TaskUiReadModel` per snapshot UI-safe: queued, active, blocked, waiting approvals, recent failures, resource usage e detail con checkpoint redatto.
- Aggiornato e marcato completo il piano `docs/superpowers/plans/2026-05-23-durable-task-runtime.md`.
- Ogni slice e' stato sviluppato test-first e committato separatamente.

Perche': ora il progetto ha un fondamento durevole riusabile da subagenti, capability, browser automation, Graphify e manutenzioni. I task lunghi e paralleli non richiedono logica duplicata negli executor.

## Prossimo blocco

### Subagents bridge verso Durable Task Runtime

- Creato design `docs/superpowers/specs/2026-05-23-subagents-task-runtime-bridge-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-subagents-task-runtime-bridge.md`.
- Aggiunta dipendenza `local-first-task-runtime` al crate `crates/subagents`.
- Aggiunto modulo `task_runtime_bridge`.
- `SubagentTaskRuntimeBridge` converte `WorkflowTaskSpec` e `SubagentTask` in `TaskRecord` durevoli.
- Le dipendenze workflow vengono persistite con `TaskStore::add_dependency`.
- Il payload completo del `SubagentTask` viene conservato in `TaskRecord.input_json`.
- Il `PermissionEnvelope` viene conservato in `TaskRecord.permission_context`.
- Ogni task subagente dichiara `ResourceClass::LlmInference` con 1 unita'.
- Aggiunto `SubagentTaskExecutor`, adapter `TaskExecutor` che ricostruisce il `SubagentTask` e chiama `SubagentRunner`.
- I successi diventano `ExecutorResult::Completed` con `SubagentResult` serializzato.
- Failed/timed out/cancelled diventano `ExecutorResult::RetryableFailure`.
- I test coprono enqueue workflow, dipendenze, resource declaration, completamento durable e failure retryable.

Perche': il Subagent Manager ora puo' appoggiarsi al task runtime per code, risorse, lease, retry, checkpoint e recovery invece di restare confinato all'orchestratore in-memory.

### Capability bridge verso Durable Task Runtime

- Creato design `docs/superpowers/specs/2026-05-23-capability-task-runtime-bridge-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-capability-task-runtime-bridge.md`.
- Aggiunta dipendenza `local-first-task-runtime` al crate `crates/capabilities`.
- Aggiunto modulo `task_runtime_bridge`.
- `CapabilityTaskRuntimeBridge` converte `CapabilityCall` + `PolicyContext` in `TaskRecord` durevoli.
- Il payload task conserva `PolicyContext` e `CapabilityCall`.
- `TaskRecord.permission_context` conserva il contesto policy per audit/UI.
- Le risorse vengono assegnate in base al provider kind:
  - native -> `filesystem_io`
  - MCP/managed -> `connector_api`
  - browser -> `browser_session`
  - skill -> `background_maintenance`
- Aggiunto `CapabilityTaskExecutor`, adapter `TaskExecutor` che possiede una `CapabilityFacade` e chiama `call_tool`.
- Successo tool -> `ExecutorResult::Completed`.
- Errore/denial tool -> `ExecutorResult::RetryableFailure`, quindi retry/backoff restano nel task runtime.
- Test coprono enqueue, resource mapping, esecuzione riuscita e denial managed-cloud.

Perche': ora anche connettori, MCP e provider managed possono usare code, lease, limiti risorse e retry comuni, invece di vivere come chiamate immediate fuori dal runtime durevole.

## Prossimo blocco

### Capability provider registry persistente

- Creato design `docs/superpowers/specs/2026-05-23-capability-provider-registry-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-capability-provider-registry.md`.
- Aggiunta `CapabilityRegistryStore` SQLite nel crate `crates/capabilities`.
- La registry salva config provider, tipo provider, metadata managed, hint risorsa e rate limit.
- Aggiunti grant user/workspace con privacy domains, action consentite, autonomia massima, opt-in managed cloud e abilitazione/disabilitazione.
- La registry deriva `PolicyContext` dai grant abilitati e lo usa con `CapabilityFacade`.
- Aggiunte connection config persistenti con `secret_ref` separato: i segreti restano fuori dal DB e i metadata vengono sanitizzati da token/password/api key.
- Aggiunta cache strumenti per provider con schema input, action class, privacy domains, sensitivity e provider kind.
- Test coprono migrazioni idempotenti, config provider, grant policy, managed opt-in, connessioni secret-ref-only, tool cache e integrazione Facade.

Perche': capability, MCP e provider managed non possono restare configurati solo in memoria. Serve una registry locale, multiutente/workspace e policy-aware per abilitare provider, collegare account, mostrare tool alla UI/subagenti e mandare tool call durevoli nel Task Runtime senza dipendere da un vendor.

## Prossimo blocco

### Browser automation design con OpenClaw come riferimento

- Analizzato OpenClaw a commit `bcf756ce36397febcdc92fdbea825824c72d3427`.
- Confermata licenza MIT, quindi possiamo portare/adattare codice mantenendo attribution.
- Confermato il problema Playwright/Rust: Playwright non ha binding Rust ufficiale, quindi non va usato direttamente dal core Rust.
- Decisione: usare un sidecar locale Node/TypeScript con `playwright-core`, supervisionato dal Rust Core.
- Decisione: copiare/adattare il piu' possibile dal modello OpenClaw per browser profile, Playwright/CDP, snapshot/refs, azioni atomiche, tab tracking, navigation guard, artifact roots e manual blockers.
- Decisione: non copiare Gateway/plugin/session/policy OpenClaw; quei ruoli restano in Durable Task Runtime, Capability Layer, Provider Registry e audit locali.
- Creata spec `docs/superpowers/specs/2026-05-23-browser-automation-design.md`.
- Aggiornato `PROJECT.md` con OpenClaw come riferimento browser e con il runtime sidecar Node/TS.

Perche': browser automation e' una capacita' critica per operazioni reali come prenotazioni, compilazione form, ricerche complesse e task di giorni. Serve massima compatibilita' con Playwright ufficiale, ma senza spostare permessi, privacy, scheduling o audit fuori dal Rust Core.

## Prossimo blocco

### Browser automation first production slice

- Creato piano `docs/superpowers/plans/2026-05-23-browser-automation.md`.
- Creato runtime locale `runtimes/browser-automation` in Node/TypeScript con `playwright-core`.
- Aggiunto trasporto stdio JSON lines per evitare una control surface HTTP prematura.
- Aggiunti contratti sidecar per request/response, errori tipizzati, retry e manual action.
- Aggiunti guardrail locali: navigation guard per protocolli e private network, artifact root confinement e upload roots.
- Implementato profilo managed `assistant` con discovery di browser Chromium e launch Playwright.
- Implementati tab label, snapshot/ref loop, invalidazione refs dopo navigazione e azioni atomiche iniziali (`fill`, `type`, `click`, `wait`).
- Aggiunto test fixture reale: open pagina locale, snapshot, fill, submit, resnapshot e stale ref.
- Creato crate Rust `crates/browser-automation` con contratti serde, policy, artifact guard, client e sidecar session wrapper.
- Aggiunto `BrowserCapabilityProvider` nel Capability Layer con tool `browser.health`, `browser.tabs`, `browser.snapshot`, `browser.open`, `browser.navigate`, `browser.act`.
- Aggiunto `BrowserTaskRuntimeBridge` e `BrowserTaskExecutor`: risorsa `browser_session`, snapshot come checkpoint, output come completed, manual blocker come `NeedsApproval`.
- Aggiunti target Makefile `browser-sync`, `browser-test`, `test-browser`; `make test` ora include i test browser.

Perche': questa slice rende il browser automation un componente operativo locale e testato, senza spostare autonomia o permessi nel sidecar. Il lato Node fa solo browser/CDP; Rust conserva policy, capability, durable task, checkpoint e approval.

## Prossimo blocco

### Browser automation production hardening

- Creato piano `docs/superpowers/plans/2026-05-23-browser-automation-production-hardening.md`.
- Esteso il sidecar Node/TypeScript per implementare tutti i metodi browser dichiarati nei contratti.
- Aggiunti artifact reali per screenshot e PDF, sempre dentro artifact root confinata.
- Aggiunto upload reale con file chooser armato e validazione degli upload roots.
- Aggiunto download reale con salvataggio dentro artifact root confinata.
- Aggiunto dialog handling (`accept`/`dismiss`, prompt text opzionale) e console ring buffer per pagina.
- Aggiunta gestione tab `focus` e `close_tab`.
- Aggiunto profilo attach-only `user`: richiede endpoint CDP locale esplicito, altrimenti produce manual-action.
- Corretto il profilo `assistant` default per evitare collisioni di ProcessSingleton tra sidecar paralleli; la persistenza esplicita passa da `BROWSER_AUTOMATION_PROFILE_ROOT`.
- Espanso `BrowserCapabilityProvider` con tutti i tool browser: profiles, console, focus, close_tab, screenshot, pdf, arm_file_chooser, respond_dialog, wait_download oltre ai tool gia' presenti.
- Aggiornato `BrowserTaskExecutor` per checkpoint snapshot redatti con metadata browser utili alla UI.
- Aggiornato `TaskUiReadModel` per esporre metadata browser senza esporre input raw.
- Aggiunti test reali Playwright per artifact, console, dialog, upload, download, profili e tab lifecycle.

Perche': il browser runtime ora ha primitive operative sufficienti per prenotazioni, compilazione form, download/upload e task lunghi orchestrati dal Durable Task Runtime. Il sidecar continua a non possedere autonomia, policy o durata del task: esegue primitive locali controllate, mentre Rust conserva capability, approval, checkpoint e scheduling.

## Prossimo blocco

### Process Manager Rust

- Creato design `docs/superpowers/specs/2026-05-23-process-manager-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-process-manager.md`.
- Aggiunto crate `crates/process-manager` al workspace.
- Aggiunti contratti per `ProcessSpec`, `ProcessKind`, `HealthCheck`, `RestartPolicy`, `ProcessStatus` e `ProcessSnapshot`.
- Aggiunto `ProcessRegistryStore` SQLite con migrazioni idempotenti per specs e latest snapshots.
- Aggiunto `LogBuffer` bounded con stream stdout/stderr.
- Aggiunto health evaluator con `process_alive` e `http_get`, tramite `HealthProbe` iniettabile.
- Aggiunto `ProcessManager` facade con register/start/stop/check_health/detail.
- Aggiunto `FakeProcessSupervisor` per test deterministici.
- Aggiunto `LocalProcessSupervisor` con spawn reale, start idempotente, stop/kill, snapshot exit e capture stdout/stderr.

Perche': LLM runtime, browser sidecar e MCP server non devono essere avviati ad hoc da ogni componente. Serve un boundary comune nel Rust Core che gestisca lifecycle, health, logs e stato UI-safe, lasciando scheduling e retry dei task al Durable Task Runtime.

## Prossimo blocco

### Process sidecar catalog

- Creato piano `docs/superpowers/plans/2026-05-23-process-sidecar-catalog.md`.
- Aggiunto `SidecarProcessCatalog` nel crate `crates/process-manager`.
- Il catalogo genera `ProcessSpec` concrete per:
  - `llm-gemma4-mlx`: `.venv-mlx/bin/python runtimes/mlx-gemma4/server.py`, cwd workspace, health HTTP `127.0.0.1:8765/health`.
  - `browser-automation`: `node node_modules/tsx/dist/cli.mjs src/server.ts`, cwd `runtimes/browser-automation`, health `process_alive`.
  - MCP stdio configurati dall'utente tramite `McpProcessConfig`.
- Aggiunto helper `register_default_sidecars` per registrare Gemma e browser nel `ProcessRegistryStore`.
- Testato che le spec siano stabili, serializzabili e registrabili.

Perche': ora il Process Manager non e' solo un supervisor generico. Ha un catalogo esplicito per i sidecar reali del progetto, ma resta separato dall'esecuzione: registra configurazioni, mentre start/stop/health restano azioni intenzionali del `ProcessManager`.

## Prossimo blocco

### Secrets/Keychain

- Creato piano `docs/superpowers/plans/2026-05-23-secrets-keychain.md`.
- Aggiunto crate Rust `crates/secrets` al workspace.
- Aggiunti contratti `SecretRef`, `SecretMaterial`, `SecretMetadata`, `SecretStatus` e `SecretStore`.
- `SecretRef` e' stabile, parseabile, multiutente/workspace e rifiuta path traversal o riferimenti legacy non strutturati.
- `SecretMaterial` redige il debug e rifiuta la serializzazione JSON per ridurre leak accidentali in log, audit, UI o payload task.
- Aggiunto `InMemorySecretStore` per test deterministici con put/get/delete/list/status e versionamento.
- Aggiunta crittografia XChaCha20Poly1305 con `EncryptedFileSecretStore`: round trip locale, nonce casuale, plaintext non presente su disco e fallimento con chiave errata.
- Aggiunto `DevelopmentSecretKeyProvider` per test/dev locale esplicito.
- Aggiunto `SystemKeychainSecretStore` come boundary OS: su macOS usa il comando `security`, sulle piattaforme non supportate fallisce in modo esplicito e sicuro.
- Integrato `local-first-secrets` nel `CapabilityRegistryStore` con helper `upsert_connection_config_with_secret`.
- La capability registry salva nel DB solo `secret_ref`, rimuove metadata sensibili come token/password/api key/secret e scrive il materiale reale nello store segreti.
- Verifiche eseguite:
  - `cargo test -p local-first-secrets`
  - `cargo test --workspace`
  - `make test`

Perche': i connettori, MCP e provider managed richiedono credenziali, ma il registry locale non deve mai diventare un deposito di token in chiaro. Ora il progetto ha un boundary dedicato per credenziali, testabile in memoria, cifrato su file e agganciabile al keychain di sistema, mantenendo capability e task runtime su `secret_ref` auditabili.

## Prossimo blocco

### Skill/Plugin Registry locale

- Creato design `docs/superpowers/specs/2026-05-23-skill-plugin-registry-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-skill-plugin-registry.md`.
- Esteso `SkillManifest`: i tool non sono piu' stringhe, ma `SkillToolManifest` con nome, descrizione, action, privacy domains, sensitivity e input schema.
- Aggiunti `PluginManifest`, `SkillInstallRecord`, `PluginInstallRecord` e `SkillTrustLevel`.
- Gli install record sono scoped per `user_id` e `workspace_id`, hanno `enabled`, `source_path`, `trust_level`, versioni e `manifest_hash` opzionale.
- Aggiunto `SkillPluginRegistryStore` SQLite in `crates/capabilities/src/skill_plugin.rs`.
- La registry salva manifest globali e installazioni locali, con migrazioni idempotenti.
- La registrazione di un plugin registra anche le skill bundled.
- Aggiunto `SkillCapabilityProvider`: converte skill abilitate in normali `CapabilityTool` con `CapabilityProviderKind::Skill`.
- `SkillCapabilityProvider` e' read-only per ora: `call_tool` restituisce `skill_execution_unavailable:<tool>`, evitando esecuzione di codice non sandboxato.
- La policy resta unica: `CapabilityFacade` filtra i tool skill tramite provider enabled, privacy domains, action e autonomia come per MCP/browser/managed provider.
- Verifiche eseguite:
  - `cargo test -p local-first-capabilities --test skill_plugin_registry`
  - `cargo test --workspace`
  - `make test`

Perche': skill e plugin non possono essere solo file o convenzioni esterne. Ora sono oggetti locali versionati, permission-aware, multiutente/workspace e orchestrabili come capability, ma senza introdurre ancora un runtime di esecuzione insicuro.

## Prossimo blocco

### Skill Runtime Sandbox

- Creato design `docs/superpowers/specs/2026-05-23-skill-runtime-sandbox-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-skill-runtime-sandbox.md`.
- Aggiunto crate Rust `crates/skill-runtime` al workspace.
- Aggiunti contratti `SkillRuntimeRequest`, `SkillRuntimeOutput`, `SkillExecutionTrace`, `SkillRuntimeLimits` e `SkillAccess`.
- Aggiunto `SkillSandboxPolicy` deny-by-default.
- La policy valida tool presente nel manifest, schema JSON base, host network dichiarati e path filesystem dentro root dichiarate.
- La policy ricontrolla anche la trace del runner dopo l'esecuzione e blocca output oltre `max_output_bytes`.
- Aggiunto trait `SkillRunner`, che e' il boundary per adapter futuri WASM/QuickJS/process.
- Aggiunto `InMemorySkillRunner` per handler locali/test deterministici senza accesso OS.
- Aggiunto `SkillRuntime`: valida richiesta, esegue runner, valida trace/output.
- Aggiunto `SkillRuntimeCapabilityProvider`: espone skill eseguibili come provider capability `skill`.
- Verificato il percorso con `CapabilityFacade`: policy/audit capability restano il punto unico di enforcement.
- Verificato il percorso durevole con `CapabilityTaskRuntimeBridge` e `CapabilityTaskExecutor`: una skill tool call viene enqueued e completata come task con risorsa `background_maintenance`.
- Verifiche eseguite:
  - `cargo test -p local-first-skill-runtime`
  - `cargo test --workspace`
  - `make test`

Perche': ora skill/plugin non sono solo manifest installabili. Possono essere eseguiti dietro un boundary locale, permission-aware e orchestrabile, senza aprire esecuzione arbitraria non confinata. Gli adapter reali per codice non trusted devono implementare `SkillRunner` e dimostrare isolamento runtime/OS con test dedicati.

## Prossimo blocco

### Skill Runtime Adapter Hardening

- Creato design `docs/superpowers/specs/2026-05-23-skill-runtime-adapters-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-skill-runtime-adapters.md`.
- Aggiunto `ProcessSkillRunnerConfig` in `crates/skill-runtime/src/process_runner.rs`.
- Il config rifiuta executable fuori dalle root consentite.
- Il config rifiuta working directory fuori dalle root consentite.
- Il config canonicalizza executable, working dir e root prima dell'uso.
- Il config parte con env vuoto e accetta solo env espliciti via `with_env`.
- Aggiunto `ProcessSkillRunner`.
- Il runner avvia executable direttamente con `Command::new`, senza shell.
- Il runner cancella l'ambiente ereditato con `env_clear`.
- Il runner scrive `SkillRuntimeRequest` JSON su stdin.
- Il runner legge `SkillRuntimeOutput` JSON da stdout.
- Il runner cattura stderr e lo trasforma in errore audit-safe su exit non-zero.
- Il runner uccide il processo su timeout.
- Il runner blocca stdout oltre `max_output_bytes`.
- La validazione post-run resta in `SkillRuntime`, quindi trace network/filesystem e output passano dallo stesso boundary gia' usato da `InMemorySkillRunner`.
- Verifiche eseguite:
  - `cargo test -p local-first-skill-runtime`
  - `cargo test --workspace`
  - `make test`

Perche': ora possiamo eseguire handler locali fidati o wrapper controllati come processi esterni senza shell, senza env ereditato e con protocollo JSON stabile. Questo non e' ancora isolamento forte per codice scaricato/non trusted: per quello serve il prossimo adapter WASM/QuickJS o equivalente, con confinement runtime verificabile.

## Prossimo blocco

- Skill Runtime Untrusted Adapter: implementare un adapter WASM/QuickJS per skill non trusted, con test che dimostrano isolamento filesystem/network oltre alla policy contrattuale.

## Prossimo blocco

### Skill Runtime Untrusted Adapter

- Creato design `docs/superpowers/specs/2026-05-23-skill-runtime-untrusted-adapter-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-skill-runtime-untrusted-adapter.md`.
- Aggiunto Wasmtime 45 a `crates/skill-runtime` e `wat` come dev dependency per test deterministici.
- Aggiunto `WasmSkillRunnerConfig` in `crates/skill-runtime/src/wasm_runner.rs`.
- Il config canonicalizza modulo e allowed roots e rifiuta moduli fuori dalle root esplicite.
- Il config compila il modulo con fuel abilitato e rifiuta qualsiasi import host/WASI.
- Aggiunto `WasmSkillRunner`.
- Il runner crea uno store Wasmtime con fuel, istanzia moduli senza import e richiede export `memory` e `run`.
- Protocollo guest: request JSON scritta nella memoria guest a offset 0, call `run(ptr, len) -> i64`, output restituito come pointer/length packed.
- Il runner valida dimensione output prima del parse JSON, controlla i bounds della memoria guest e converte trap/fuel exhaustion in errori auditabili.
- La validazione post-run rimane nel `SkillRuntime`: trace network/filesystem e output passano dallo stesso boundary gia' usato da in-memory e process runner.
- Aggiunti test per root confinement, import rejection, protocollo memoria/run, output troppo grande, fuel exhaustion e export mancanti.
- Verifiche eseguite:
  - `cargo test -p local-first-skill-runtime --test wasm_runner`
  - `cargo test -p local-first-skill-runtime`
  - `cargo test --workspace`
  - `make test`

Perche': ora le skill non trusted possono girare dentro un runtime senza accesso host implicito, invece di essere solo processi hardenizzati. Questo chiude il primo livello production del runtime skill: manifest/policy, task orchestration, process runner trusted e WASM runner non trusted. Restano utili in seguito SDK e host capability WASI controllate, ma non sono piu' prerequisito per avere un confinement forte di base.

## Prossimo blocco

- Assistant Orchestrator Brain: creare il cervello deterministico che decide quando usare memoria, browser, MCP, connettori, skill, subagenti o risposta diretta, generando piani auditabili e task durevoli invece di lasciare il routing solo al prompt del modello.

## Prossimo blocco

### Assistant Orchestrator Brain

- Creato design `docs/superpowers/specs/2026-05-23-assistant-orchestrator-brain-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-assistant-orchestrator-brain.md`.
- Aggiunto crate Rust `crates/orchestrator` al workspace.
- Aggiunti contratti `OrchestratorRequest`, `ExecutionPlan`, `PlanStep`, `OrchestratorOutcome`, `ToolCard` e `OrchestratorAudit`.
- Aggiunto `ToolSearchIndexStore` SQLite FTS5/BM25 per registry tool lazy.
- Le `ToolCard` espongono provider, action, descrizione, privacy domain, sensitivity e schema hash, ma non lo schema input completo.
- Il Brain carica tutti i tool detail solo se il catalogo visibile e' piccolo; con cataloghi grandi carica un subset limitato e consente un solo retry `needs_more_tools`.
- Aggiunto `MemoryContextProvider` con provider noop/statici e adapter per `MemoryFacade`.
- Aggiunto `OrchestratorBrain`: costruisce prompt JSON locale, valida il piano e blocca tool non caricati o inventati dal modello.
- Le risposte dirette non creano task quando non servono capability.
- Le capability `read`/`draft` brevi e locali possono essere eseguite subito via `CapabilityFacade`.
- Write, browser mutativo, managed provider e step non immediati vengono accodati tramite `CapabilityTaskRuntimeBridge`.
- Aggiunta gestione iniziale di DAG: gli step possono dichiarare dipendenze e le dipendenze tra task accodati vengono registrate nel `TaskStore`.
- Verifiche eseguite finora:
  - `cargo test -p local-first-orchestrator`

Perche': il modello non deve vedere tutti i tool e non deve decidere da solo cosa puo' eseguire. Ora il cervello usa un pattern simile a tool search/deferred loading: catalogo compatto, pochi detail caricati, piano JSON validato e enforcement finale nel Rust Core.

## Prossimo blocco

### Assistant Orchestrator Brain Hardening

- Creato design `docs/superpowers/specs/2026-05-23-assistant-orchestrator-brain-hardening-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-assistant-orchestrator-brain-hardening.md`.
- Aggiunto `OrchestratorAuditStore` in `crates/orchestrator/src/audit.rs`.
- Lo store audit usa SQLite locale e migrazioni idempotenti per persistere run Brain riuscite e failure planner.
- Aggiunto `OrchestratorUiReadModel` in `crates/orchestrator/src/ui.rs`.
- Il read model espone route, status, step, tool/agent id, contract, metriche, memory refs e task summary senza raw user message, raw tool arguments o raw tool output.
- Esteso `PlanStep` con campi subagent: `agent_id`, `goal`, `contract`, `allowed_actions`, `requires_user_approval`, `timeout_seconds`, `max_tokens`.
- Esteso `OrchestratorOutcome` con `enqueued_subagent_tasks`.
- Aggiunto `subagent_workflow.rs` per convertire `subagent_task` in `SubagentTask` durevoli tramite `SubagentTaskRuntimeBridge`.
- Le azioni richieste dai subagenti vengono validate contro il `PolicyContext`.
- Le dipendenze tra step subagent e step capability gia' accodati vengono persistite nel `TaskStore`.
- Aggiornato planner prompt/schema per dichiarare esplicitamente i campi subagent.
- Aggiunti test:
  - `crates/orchestrator/tests/audit.rs`
  - `crates/orchestrator/tests/subagent_workflow.rs`
- Verifiche eseguite finora:
  - `cargo test -p local-first-orchestrator`

Perche': ora il Brain non e' solo un router per la singola chiamata. Produce decisioni persistenti e leggibili dalla futura UI, mantenendo separato cio' che serve all'esecuzione raw da cio' che puo' essere mostrato in modo sicuro.

## Prossimo blocco

### UI Tauri V1 operativa

- Creato `apps/desktop` con Tauri 2, React, TypeScript e Vite.
- Aggiunta shell light-first con sidebar sinistra, workspace centrale e inspector destro contestuale.
- Implementata home Chat come prima schermata prodotto, non landing page.
- Implementate viste complete per Chat, Task/Approval center e Settings.
- Aggiunte viste shallow navigabili per Memoria, Connessioni, Automazioni, Browser e Brain Audit.
- Separati i mock TypeScript dai componenti in `src/data/mockData.ts`.
- Allineati i mock ai read model gia' previsti: task queue, task detail redatto, run Brain, memory summary, runtime health e provider/connection list.
- L'inspector mostra Brain plan, task selezionato, approvazioni e runtime health senza esporre raw payload.
- Verificata la direzione visuale Manus light + settings Codex: neutral grays, system blue, radius massimo 8px, niente dotted background permanente e niente card annidate.
- Rifinita la UX dopo review visuale: canvas piu' adattivo su desktop, sidebar principale comprimibile, inspector comprimibile e Settings come modalita' shell dedicata che sostituisce la navigazione principale con menu impostazioni + ritorno all'app.
- Seconda rifinitura ispirata a Manus: inspector nascosto di default e richiamabile da header/activity strip, sidebar ridotta alle voci primarie, impostazioni accessibili dal footer e pagina Plugin/Connettori resa piu' curata con feature card, search e griglia connettori.
- Terza rifinitura layout: composer trattato come overlay ancorato dentro la chat invece che come elemento del flow, conversazione con scroll interno e auto-scroll React, sidebar a griglia con footer ancorato, un solo entry point impostazioni e icone centrate nello stato compresso con slot fissi.
- Aggiunte micro-interazioni non invasive: transizioni su shell/sidebar, feedback active/focus sul composer, ingresso leggero del dock e dei messaggi, rispettando `prefers-reduced-motion`.
- Verifiche eseguite:
  - `npm run typecheck`
  - `npm run build`
  - screenshot browser desktop e mobile su Chat/Settings/Tasks

Perche': la UI e' il primo punto di fiducia del prodotto. Serviva un prototipo operativo abbastanza fedele da giudicare look and feel, densita', privacy/approval flow e layout responsive prima di cablare i Tauri commands reali. In particolare il prompt non deve mai essere spinto fuori dalla chat e la navigazione deve restare stabile anche con altezze ridotte.

## Prossimo blocco

### Local Computer Session e direzione UX Manus

- Navigata e analizzata Manus live dopo login per capire interazioni reali, menu, chat attiva, plugin, pianificazione, activity card e computer panel.
- Confermato che Manus e' un riferimento UX, non una base tecnica da copiare.
- Confermato che il "computer" non e' solo browser: deve includere anche shell/terminale, file/artifact e log.
- Creato ADR `docs/decisions/0002-local-computer-session-ux.md`.
- Creata spec `docs/superpowers/specs/2026-05-23-local-computer-session-ux-design.md`.
- Aggiornato `PROJECT.md` con `Local Computer Session Manager`, superfici Browser/Shell/Artifact/Log, risorse `computer_session` e `shell_process`, Fase 6.5 e nuova direzione UI.
- La chat deve diventare rail/drawer + thread centrale + activity card, con dettagli on demand tramite popover/modal/panel.
- L'inspector non deve essere il default: piano, utilizzo, file, computer e audit devono apparire solo quando l'utente li chiede o quando un task richiede attenzione.
- Il prossimo cablaggio UI non deve collegare direttamente i mock a task/browser: prima serve il read model Local Computer per evitare di cementare una UX sbagliata.

Perche': l'esperienza utente e' parte centrale del prodotto. Se browser e shell restano pannelli tecnici separati, l'assistant sembra grezzo e difficile da fidare. Una sessione computer locale, visibile e redatta, permette di mostrare lavoro reale, approvazioni e takeover senza sacrificare local-first, audit e policy.

## Prossimo blocco

### UI Tauri riallineata alla spec Local Computer

- Scartato il tentativo visuale precedente basato su sidebar densa e inspector.
- Rifatta la shell con rail primaria sempre presente e drawer espandibile on demand.
- Rimossa l'integrazione dell'inspector dal layout e cancellato il componente `Inspector`.
- Rifatta la Chat come active-task thread: topbar minimale, messaggi centrali, timeline inline, Local Computer activity card e composer ancorato al fondo dell'area utile.
- Aggiunto pannello `Computer locale` on demand con tab Browser, Terminale, File e Log.
- Aggiunto mock read model `ComputerSession` con superfici, timeline, artifact e transcript redatto.
- Aggiunto contract test statico `npm run test:ui-contract` per impedire regressioni su rail/drawer, activity card, detail panel, timeline e assenza dell'inspector nella shell.
- Corretto comportamento responsive: su viewport mobile il drawer parte chiuso, su altezze ridotte il thread torna al fondo e il composer resta utilizzabile.
- Rifinito comportamento sidebar: quando il drawer testuale e' aperto la rail di icone sparisce; quando il drawer viene chiuso resta solo la rail compatta.
- Aggiunte azioni persistenti nel drawer aperto per non perdere Notifiche e Impostazioni quando la rail e' nascosta; poi ridotte a sole icone in fondo, allineate a sinistra, senza riga divisoria, e rimossa la card Local Computer dalla sidebar.
- Verifiche eseguite:
  - `npm run test:ui-contract`
  - `npm run typecheck`
  - `npm run build`
  - screenshot browser in-app su desktop, mobile e altezza corta.

Perche': la UI doveva seguire la nuova specifica Manus-inspired senza mantenere compromessi del primo prototipo. Il prodotto deve comunicare subito "sto lavorando sul tuo computer locale" con progress visibile e dettagli controllati, non "sto mostrando pannelli tecnici".

## Prossimo blocco

### Auto-apprendimento come pagina fondativa

- Aggiunta la view `Apprendimento` come sezione di primo livello nella UI desktop.
- Separati i mock in `learningInsights` e `automationProposals`, pronti per essere sostituiti da read model Tauri.
- La pagina mostra cosa il sistema pensa di aver imparato: titolo, dominio privacy, cadenza, confidenza, stato e prove redatte.
- Ogni insight espone controlli espliciti: confermare, correggere o ignorare. Questo evita che l'auto-apprendimento diventi una scatola nera.
- Aggiunta una sezione di automatismi possibili con trigger, azioni previste, livello di autonomia, rischio e stato di attivazione.
- Esteso il contratto statico UI per rendere obbligatori view dedicata, habit card, automation proposal, evidence list, privacy control e layout dedicato.

Perche': l'auto-apprendimento e' una differenza centrale del prodotto, ma deve essere governabile. La UI deve rendere visibile non solo l'automazione proposta, ma anche il motivo per cui il sistema l'ha dedotta e il modo per correggerla prima che diventi comportamento.

## Prossimo blocco

### Allineamento Auto-apprendimento al Memory Core

- Riallineato il comportamento al piano originale del progetto: l'auto-apprendimento non introduce un core separato, ma passa da `Event Log`, `MemoryAgent`, `RoutineRecord`, `automation_candidates` e `MemoryFacade`.
- Cambiato `MemoryFacade::apply_extraction`: le memorie estratte dal `MemoryAgent` ora entrano come `candidate`, non `confirmed`.
- Aggiornato `MemoryFacade::context_pack`: il contesto operativo carica solo memorie `confirmed`; le candidate restano disponibili alla UI di apprendimento/review.
- Aggiunto `MemoryRefKind::Automation`.
- Aggiunti `AutomationCandidateRecord`, `AutomationCandidateCreateRequest`, `AutomationRiskLevel` e `AutomationCandidateStatus`.
- Aggiunta tabella SQLite `automation_candidates` e portata la schema version memoria a `3`.
- Aggiunta API `MemoryFacade::propose_automation`.
- Aggiunto `LearningUiReadModel`, che aggrega memorie candidate/confermate, routine candidate e proposte di automazione applicando privacy domain e sensitivity prima di esporre dati alla UI.
- Aggiunti test TDD:
  - `crates/memory/tests/extraction.rs`: MemoryAgent extraction resta candidate.
  - `crates/memory/tests/learning_ui.rs`: snapshot apprendimento, evidence refs, automation proposals e filtri privacy.
- Verifiche eseguite:
  - `cargo test -p local-first-memory`
  - `cargo test -p local-first-subagents`

Perche': il progetto aveva gia' definito il percorso corretto: osservare eventi, dedurre candidate, mostrare evidenze redatte, lasciare all'utente il controllo e solo poi trasformare pattern ricorrenti in automazioni approvate. Questo evita che la pagina Apprendimento sia un mock scollegato o che l'assistant trasformi inferenze in verita' operative senza review.

## Prossimo blocco

### Tauri Core Bridge V1

- Aggiunto stato applicativo locale in `apps/desktop/src-tauri/src/state.rs`.
- Aggiunti command Tauri in `apps/desktop/src-tauri/src/commands.rs`.
- Separati DTO e mapping in `apps/desktop/src-tauri/src/models.rs`.
- Separato bootstrap seeded locale in `apps/desktop/src-tauri/src/seed.rs`.
- Il bridge inizializza componenti core reali con store locali seeded:
  - `TaskStore` + `TaskUiReadModel`
  - `MemoryFacade` + `MemoryUiReadModel`
  - `ProcessManager` + `SidecarProcessCatalog`
  - `CapabilityRegistryStore`
- Esposti command:
  - `core_bridge_status`
  - `runtime_health_snapshot`
  - `process_check_health`
  - `process_start`
  - `process_stop`
  - `task_queue_snapshot`
  - `task_detail`
  - `memory_dashboard_snapshot`
  - `capability_snapshot`
- Aggiunti DTO serializzabili e redatti per evitare di esporre raw input, `secret_ref`, env, log raw o payload sensibili.
- Aggiunto wrapper TypeScript `apps/desktop/src/lib/coreBridge.ts` separato dai componenti React.
- Aggiornato `PROJECT.md` con lo stato reale del bridge.
- Verifiche eseguite:
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - `npm run typecheck`
  - `npm run build`
  - `cargo test --workspace`

Perche': prima di cablare l'auto-apprendimento serve un confine stabile tra UI e Rust Core. La UI deve poter leggere task, approvals, memoria, processi e capability da command reali, ma l'apprendimento resta ultimo perche' deve basarsi su eventi reali generati da browser, shell, task runtime e osservazione desktop.

## Prossimo blocco

### Local Computer Session Core

- Aggiunto crate `crates/local-computer-session`.
- Implementati contratti per:
  - sessione computer
  - superfici Browser/Shell/Files/Logs
  - eventi append-only
  - artifact
  - timeline UI
  - approval state
  - takeover state
- Implementato `LocalComputerSessionStore` SQLite con schema version, sessioni, eventi e artifact.
- Implementato `LocalComputerSessionManager` per creare sessioni, avviare superfici, aggiungere eventi, terminal output, artifact, richieste approval e takeover.
- Implementato `LocalComputerReadModel` con redazione prima della UI:
  - URL senza query o frammenti
  - terminal excerpt redatto
  - artifact senza path raw
  - timeline senza payload raw
  - errori redatti
- Implementata `ShellCommandPolicy` per classificare comandi read-only, write, network/install e destructive.
- Esteso `TaskRuntime::ResourceClass` con `computer_session` e `shell_process`, inclusi in Resource Governor e Task UI read model.
- Collegato il bridge Tauri con `local_computer_session_snapshot`.
- Aggiornato `apps/desktop/src/lib/coreBridge.ts` con il tipo snapshot Local Computer.
- Aggiornato `PROJECT.md`.
- Verifiche eseguite:
  - RED: `cargo test -p local-first-local-computer-session` falliva per API mancanti.
  - RED: `cargo test -p local-first-task-runtime --test contracts` falliva per risorse mancanti.
  - GREEN: `cargo test -p local-first-local-computer-session`
  - GREEN: `cargo test -p local-first-task-runtime`
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - GREEN: `npm run typecheck`
  - GREEN: `npm run build`

Perche': la UI non deve cablare browser, shell e artifact come pannelli separati. Serve un read model unico, persistente e redatto che rappresenti il lavoro reale del computer locale durante task lunghi, con approval e takeover governabili.

## Prossimo blocco

### UI Chat collegata alla Local Computer Session

- La Chat non riceve piu' `computerSession` mock da `App`.
- Aggiunto mapper `apps/desktop/src/lib/localComputerViewModel.ts` per trasformare `CoreComputerSessionSnapshot` nel view model React `ComputerSession`.
- Il mapper conserva il contratto privacy:
  - usa `current_url_redacted`
  - usa `terminal_excerpt_redacted`
  - mostra artifact senza path raw
  - considera la timeline valida solo con `payload_redacted`
- `ChatView` carica `coreBridge.localComputerSession("computer_train_search")` e aggiorna la card ogni 4 secondi.
- In anteprima web senza Tauri viene mostrato un fallback esplicito, non un errore tecnico.
- Il detail panel Computer continua a usare tab Browser, Terminale, File e Log, ma ora legge superfici, timeline, artifact e terminal excerpt dal read model core.
- Aggiornato il contratto UI statico per impedire regressioni verso mock passati da `App`.
- Verifiche eseguite:
  - RED: `npm run test:ui-contract` falliva per cablaggio Tauri mancante.
  - GREEN: `npm run test:ui-contract`
  - GREEN: `npm run typecheck`
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - GREEN: `npm run build`
- Verifica browser:
  - viewport desktop 1440x900
  - activity card visibile
  - composer resta ancorato
  - panel Computer apribile senza cambiare route
  - fallback web chiaro quando il bridge Tauri non e' presente

Perche': questo e' il primo punto in cui la UI legge una sessione operativa reale dal Rust Core invece di affidarsi al mock. In Tauri l'utente puo' vedere il read model seeded e redatto; nel browser resta disponibile solo la preview grafica con messaggio esplicito.

## Prossimo blocco

### Local Computer Smoke Test reale da UI

- Aggiunto command Tauri `local_computer_run_smoke_test`.
- Il command esegue un percorso locale reale e controllato:
  - chiama il sidecar Browser Automation via stdio con `browser.health`;
  - esegue il comando shell read-only `date '+%Y-%m-%d %H:%M:%S %Z'`;
  - scrive eventi nella `LocalComputerSessionManager`;
  - aggiunge output terminale redatto;
  - registra artifact metadata `local-smoke-transcript.txt` senza path raw.
- Aggiunto bottone `Test reale` nella Local Computer activity card.
- Il bottone richiama `coreBridge.runLocalComputerSmokeTest(...)` e aggiorna subito la card con lo snapshot reale.
- Aggiunto test Rust `local_computer_smoke_test_records_real_shell_output`.
- Aggiornato il contratto UI per imporre che la Chat esponga un'azione reale e non solo il polling dello snapshot.
- Rigenerata la app Tauri debug apribile da:
  - `apps/desktop/src-tauri/target/debug/bundle/macos/Local First Assistant.app`
- Verifiche eseguite:
  - RED: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml local_computer_smoke_test_records_real_shell_output` falliva per metodo mancante.
  - RED: `npm run test:ui-contract` falliva per azione UI mancante.
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - GREEN: `npm run test:ui-contract`
  - GREEN: `npm run typecheck`
  - GREEN: `npm run build`
  - GREEN: `npm run tauri -- build --debug --bundles app --no-sign`

Perche': ora l'utente puo' fare un test reale end-to-end dentro la app Tauri: non e' ancora una prenotazione/browser task complesso, ma attraversa UI -> Tauri command -> runtime browser locale -> shell locale -> Local Computer read model -> UI.

## Prossimo blocco

### Composer cablato al Tauri Core

- Aggiunto modulo `apps/desktop/src-tauri/src/prompt_submission.rs`.
- Aggiunto command Tauri `submit_user_prompt`.
- Il composer React ora invia il prompt a `coreBridge.submitUserPrompt(...)`.
- La UI aggiunge il messaggio utente localmente e riceve dal core una risposta assistant.
- Il core non salva il prompt raw nel read model:
  - registra evento `user_prompt_received`;
  - payload UI sempre redatto;
  - conserva solo conteggio caratteri e metadati operativi.
- Primo handler deterministico reale storico:
  - in questo step iniziale il core riconosceva ora/data prima del Brain;
  - questo comportamento e' stato sostituito nel blocco "Composer compreso dal Brain".
- Aggiunto test Rust `submit_user_prompt_runs_local_time_request_without_storing_raw_prompt`.
- Aggiornato il contratto UI per imporre che il composer usi il command Tauri reale.
- Rigenerata e aperta la app Tauri debug.
- Verifiche eseguite:
  - RED: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_user_prompt_runs_local_time_request_without_storing_raw_prompt` falliva per metodo mancante.
  - RED: `npm run test:ui-contract` falliva per command UI mancante.
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - GREEN: `npm run typecheck`
  - GREEN: `npm run test:ui-contract`
  - GREEN: `npm run build`
  - GREEN: `npm run tauri -- build --debug --bundles app --no-sign`

Perche': ora l'utente puo' digitare davvero un prompt nella app. Non e' ancora il Brain completo, ma il circuito UI -> Tauri Core -> shell locale -> Local Computer Session -> chat e' reale e testabile.

## Prossimo blocco

### Fix sessione attiva non coerente con il prompt

- Rimosso il seed "treni Napoli-Milano" dal percorso chat di default.
- La sessione attiva e' ora `computer_active_prompt`, collegata al task `task_prompt_session`.
- Il task attivo seeded e' neutro: `local_prompt`, risorsa `shell_process`, rischio `low`.
- La chat iniziale ora mostra stato pronto per prompt locali, non una richiesta treni.
- La drawer mostra `Prompt locale`, non `Treni Napoli-Milano`.
- Il test `local_computer_snapshot_is_redacted_for_ui` verifica che lo snapshot default non contenga riferimenti treni/Napoli/Milano.
- Rigenerata e aperta la app Tauri debug.
- Verifiche eseguite:
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - `npm run typecheck`
  - `npm run test:ui-contract`
  - `npm run build`
  - `npm run tauri -- build --debug --bundles app --no-sign`

Perche': il composer reale funzionava, ma la UX era contaminata da dati seeded della vecchia demo treni. Questo rendeva la timeline incoerente con prompt come "che ore sono?". Il percorso default deve essere neutro e solo i task effettivamente avviati devono aggiungere contesto specifico.

## Prossimo blocco

### Fix prompt locali e timeline chat

- Aggiunto handler locale per aritmetica binaria semplice nel command `submit_user_prompt`.
- `quanto fa 6*3` ora risponde `6 * 3 fa 18.` senza cadere nel placeholder `prompt_pending_brain`.
- Il calcolo registra evento `local_calculation_completed` nel read model con payload redatto.
- La timeline `InlineTimeline` non viene piu' renderizzata sotto ogni messaggio assistant; ora appare una sola volta nel thread prima della card Computer.
- Aggiunto test Rust `submit_user_prompt_answers_simple_arithmetic_locally`.
- Aggiornato contratto UI statico per impedire che la timeline venga reintrodotta come elemento ripetuto per ogni messaggio.
- Rigenerata e aperta la app Tauri debug.
- Verifiche eseguite:
  - RED: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_user_prompt_answers_simple_arithmetic_locally` falliva per fallback Brain.
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - GREEN: `npm run test:ui-contract`
  - GREEN: `npm run typecheck`
  - GREEN: `npm run build`
  - GREEN: `npm run tauri -- build --debug --bundles app --no-sign`

Perche': il composer non deve sembrare rotto per prompt banali. Questo e' stato lo step intermedio prima del collegamento al Brain; la UI inoltre non deve duplicare la timeline sotto ogni risposta.

## Prossimo blocco

### Composer compreso dal Brain

- Introdotto il trait `PromptBrain` nel Tauri Core.
- Introdotto `BrainUnderstanding`, JSON strutturato e validato con route:
  - `direct_answer`
  - `local_time`
  - `local_calculation`
  - `needs_planning`
  - `ask_clarification`
  - `refuse`
- Introdotto `RuntimePromptBrain`, che chiama il runtime locale Gemma 4 via `JsonRuntime` su `http://127.0.0.1:8765/generate_json`.
- `submit_user_prompt` non interpreta piu' semanticamente il prompt con regole testuali locali.
- Ora/data e calcoli vengono eseguiti solo dopo che il Brain ha restituito una route strutturata.
- I test usano un Brain finto per provare il contratto senza dipendere dal runtime MLX live:
  - prompt inglese `what time is it?` classificato come `local_time`;
  - prompt inglese in parole `what is six times three?` classificato come `local_calculation`.
- Se il Brain locale non e' raggiungibile, il core registra `brain_understanding_failed` e risponde chiedendo di avviare Gemma 4, senza tornare a riconoscimenti euristici nascosti.
- Dopo test live su Gemma, i campi di calcolo sono stati rinominati da `left/operator/right` a `calculation_left/calculation_operator/calculation_right`: `left/right` venivano interpretati dal modello come origine/destinazione in prompt di viaggio.
- Verifica live su `http://127.0.0.1:8765/generate_json` con modello gia' caricato:
  - `che ore sono?` -> `local_time`
  - `what time is it?` -> `local_time`
  - `quanto fa 6*3?` -> `local_calculation` con `6 * 3`
  - `what is six times three?` -> `local_calculation` con `6 * 3`
  - `quanto fa sette per otto?` -> `local_calculation` con `7 * 8`
  - `cerca un treno da Napoli a Milano per il 10 giugno` -> `needs_planning`
  - `send an email to Marco tomorrow morning with the meeting summary` -> `needs_planning`
  - `spiegami in una frase cos'e' una sessione computer locale` -> `direct_answer`
- Verifiche eseguite:
  - RED: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml prompt_submission::tests::english_time_request_is_understood_by_brain_not_prompt_text_rules` falliva per trait/tipi mancanti.
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml prompt_submission::tests`
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Perche': la comprensione deve essere language-agnostic e centralizzata. Regex o keyword nel composer creano casi incoerenti tra italiano, inglese e richieste naturali; il core deve invece chiedere al Brain un'intenzione strutturata, validarla e poi eseguire solo azioni locali/policy-safe.

## Prossimo blocco

### Planner operativo per task da prompt

- `needs_planning` non resta piu' solo `prompt_pending_brain`.
- Aggiunto `PromptTaskPlanner` nel Tauri Core.
- Aggiunto `RuntimePromptTaskPlanner`, che usa Gemma locale via `/generate_json` per produrre un piano operativo strutturato.
- Aggiunti contratti UI-safe:
  - `PromptExecutionPlan`
  - `PromptPlanStep`
  - `title`, `summary`, `risk_level`
  - step con `surface`, `action_kind`, `requires_user_approval`
- `submit_user_prompt` ora:
  - comprende la richiesta con `PromptBrain`;
  - se la route e' `needs_planning`, chiede un piano al planner;
  - registra `operational_plan_created` nella Local Computer Session;
  - registra gli step come `operational_plan_step_ready`;
  - avvia la surface Browser se almeno uno step usa `surface=browser`.
- `DesktopCoreState` materializza il piano nel Durable Task Runtime:
  - un task per ogni step;
  - checkpoint redatto per ogni task;
  - resource class coerente con la surface (`browser_session`, `shell_process`, `filesystem_io`, `background_maintenance`);
  - approval gate reale via `ApprovalGate` per step con `requires_user_approval=true`.
- Aggiornato il type bridge TypeScript con `CorePromptExecutionPlan`.
- Test live con Gemma su richiesta:
  - `Prenota un treno da Napoli a Milano il 10 giugno 2026 alle 08:30, preferibilmente alta velocità, senza completare il pagamento senza conferma.`
  - output valido: piano da 5 step con ricerca browser, confronto opzioni, conferma selezione, booking draft e approval finale prima del pagamento.
- Verifiche eseguite:
  - RED/GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml planning`
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - GREEN: `npm run test:ui-contract`
  - GREEN: `npm run typecheck`

Perche': capire la richiesta non basta. Per essere utile il sistema deve trasformare una richiesta naturale in lavoro persistente, visibile e governato: piano, task, risorse e approval. Il primo livello non completa ancora una prenotazione reale, ma crea task durevoli e blocchi di sicurezza reali che il runtime browser potra' eseguire nel layer successivo.

## Prossimo blocco

### Timeline Computer collapsabile

- La timeline `InlineTimeline` della Chat ora e' collapsabile e parte chiusa di default.
- In stato compatto mostra solo gli ultimi due eventi, mantenendo visibile lo stato operativo senza occupare troppo spazio nel thread.
- Il toggle espone `aria-expanded` e permette di mostrare/nascondere i dettagli senza aprire il pannello Computer.
- Aggiunti hook CSS dedicati (`timeline-collapsed`, `timeline-header`, `timeline-toggle`) per mantenere la UX sobria e non tecnica.
- Aggiornato il contratto UI statico per rendere obbligatoria la timeline collapsabile e impedire regressioni verso timeline sempre aperta o duplicata.
- Verifiche eseguite:
  - RED: `npm run test:ui-contract` falliva per stato collapse mancante.
  - GREEN: `npm run test:ui-contract`
  - GREEN: `npm run typecheck`
  - GREEN: `npm run build`

Perche': la timeline e' utile per fiducia e audit, ma non deve diventare rumore visivo nella chat. Il default compatto segue la direzione Manus: informazioni progressive, dettagli disponibili on demand e canvas centrale piu' leggibile.

## Prossimo blocco

### Gestione chat e thread operativi

- Aggiunto il concetto di chat thread nel Tauri Core.
- Ogni thread ha:
  - `thread_id`
  - titolo/sottotitolo UI-safe
  - `computer_session_id`
  - `task_id`
  - contatore messaggi
  - timestamp aggiornamento
- Il thread default resta `thread_active_prompt` collegato a `computer_active_prompt`.
- `create_chat_thread` crea una nuova chat pulita e una nuova Local Computer Session isolata, senza ereditare terminal output o eventi prompt precedenti.
- La UI React tiene i messaggi separati per thread e il bottone `Nuovo compito` crea/seleziona il nuovo thread.
- La sidebar mostra i thread reali invece della lista mock dei task.
- Il titolo del thread viene aggiornato localmente dal primo messaggio utente, cosi' la lista resta leggibile senza esporre payload raw nel core.
- Decisione architetturale: la chat non decide tool, MCP o browser. Passa prompt + thread/session context al Core; il Brain produce intenzione e piano, poi il Capability Layer/Task Runtime scegliera' uno o piu' strumenti.

Perche': prima di eseguire task reali serve separare bene le conversazioni. Senza thread isolati, test su ora, calcoli, treni e browser si contaminano nella stessa timeline e rendono difficile capire se il sistema sta agendo sul contesto giusto.

## Prossimo blocco

### Fase 1 - Prompt Plan Executor V1, primo slice

- Implementato `DesktopCoreState::run_prompt_plan_next_step`.
- Esposto command Tauri `prompt_plan_run_next_step`.
- Aggiunto bridge TypeScript `coreBridge.runPromptPlanNextStep`.
- Aggiunto bottone UI `Esegui step` nella Local Computer card.
- L'executor:
  - usa `TaskScheduler::ready_tasks` per selezionare task pronti;
  - filtra task `prompt_plan.*` della chat/sessione attiva;
  - usa `ResourceGovernor::conservative_defaults`;
  - mette il task in `waiting_resource` se la risorsa e' occupata;
  - non seleziona step in `waiting_user_approval`;
  - riserva risorse prima dell'esecuzione;
  - registra checkpoint `started`, `completed` o `waiting_resource`;
  - rilascia risorse dopo completion;
  - aggiorna Local Computer Session con eventi `prompt_plan_step_started`, `prompt_plan_step_completed` e `prompt_plan_step_waiting_resource`.
- Questo primo slice esegue gli step in modalita read-only controllata (`read_only_step_recorded`), senza ancora guidare il browser reale o fare azioni mutative.
- Test aggiunti:
  - esecuzione del primo step `prompt_plan.research`;
  - blocco `waiting_resource` quando `browser_session` e' occupata;
  - garanzia che uno step solo-approval non venga eseguito.
- Verifiche eseguite:
  - RED: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml prompt_plan_executor -- --nocapture` falliva per metodo mancante;
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml prompt_plan_executor -- --nocapture`;
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - GREEN: `npm run typecheck`;
  - GREEN: `npm run test:ui-contract`;
  - GREEN: `npm run build`;
  - Playwright su `http://127.0.0.1:1420/`: bottone `Esegui step` visibile nella Local Computer card, senza overlap.

Perche': prima di collegare browser/shell reali serve provare il percorso governato end-to-end: task pronto -> risorse -> checkpoint -> Local Computer -> UI. Questo evita di far partire tool direttamente dal frontend o dal Brain bypassando Resource Governor e Approval Gate.

## Prossimo blocco

### Fase 2 - Tasks/Approvals reali, primo slice

- Collegata `App.tsx` a `coreBridge.taskQueue`.
- La UI ora mappa dal read model reale:
  - `active`;
  - `queued`;
  - `blocked`;
  - `recent_failures`;
  - `waiting_approvals`;
  - `resource_usage`.
- `TasksView` riceve `resourceUsage` e mostra un pannello risorse runtime.
- `ChatView` usa il numero approval reale per la Local Computer card.
- La voce di navigazione `Pianificato` apre la vista task/approval reale invece
  della vecchia vista shallow automazioni.
- Aggiornato `check-ui-contract.mjs` per rendere obbligatorio:
  - `coreBridge.runPromptPlanNextStep` nella chat;
  - `coreBridge.taskQueue` in App;
  - `resourceUsage` in TasksView.
  - navigazione `Pianificato` verso `tasks`.
- Verifiche eseguite:
  - RED: `npm run test:ui-contract` falliva per `coreBridge.taskQueue` mancante;
  - GREEN: `npm run test:ui-contract`;
  - GREEN: `npm run typecheck`;
  - GREEN: `npm run build`;
  - Playwright su `http://127.0.0.1:1420/`: `Pianificato` apre `Task e approvazioni` su desktop e mobile, senza overlap.

Perche': dopo aver creato l'executor, l'utente deve vedere lo stato reale del runtime: task attivi, in coda, approval e risorse. Questo e' necessario prima di aumentare autonomia e tool reali.

## Prossimo blocco

### Fase 2 - Dettaglio task e Approval Gate cablati

- Aggiunti command Tauri:
  - `approval_approve`;
  - `approval_reject`.
- `DesktopCoreState` ora approva/rifiuta tramite `ApprovalGate`, valida
  user/workspace dell'approval e ritorna lo snapshot coda aggiornato.
- Ogni decisione approval registra un checkpoint redatto sul task interessato.
- `coreBridge` espone `approveApproval`, `rejectApproval` e usa `taskDetail`.
- `TasksView` mostra:
  - dettaglio task selezionato;
  - stato e priorita';
  - sintesi checkpoint/metadata redatta;
  - conferma esplicita che il payload raw non e' esposto;
  - bottoni approval collegati ai command reali.
- L'anteprima web senza bridge Tauri mostra un fallback redatto, mentre l'app
  desktop usa `task_detail` reale.
- Aggiornato `check-ui-contract.mjs` per rendere obbligatori detail e azioni
  approval nel percorso UI.
- Test aggiunti:
  - approve approval -> task torna `queued`, approval rimossa, checkpoint redatto;
  - reject approval -> task `cancelled`, reason redatta, approval rimossa.
- Verifiche eseguite:
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml approval_`;
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - GREEN: `npm run typecheck`;
  - GREEN: `npm run test:ui-contract`;
  - GREEN: `npm run build`;
  - Playwright su `http://127.0.0.1:1420/`: detail redatto, approval actions e risorse visibili su desktop/mobile senza overlap.

Perche': la coda e' utile solo se l'utente puo' capire e governare cosa sta accadendo. Approval e detail devono restare nel Core, non nella UI, cosi' policy, audit e multiutente non vengono bypassati.

## Prossimo blocco

### Fase 3 - Local Computer browser preview smoke

- Esteso `local_computer_smoke.rs`.
- Il smoke Local Computer ora:
  - avvia il sidecar browser locale via stdio;
  - verifica `browser.health`;
  - apre una tab `about:blank` governata dal sidecar;
  - produce uno screenshot reale con `browser.screenshot`;
  - registra lo screenshot come artifact `local_smoke_browser_preview`;
  - espone `preview_ref` e `current_url_redacted` nel read model Local Computer;
  - mantiene il comando shell read-only `date` e il transcript redatto.
- Gli artifact browser sono scritti sotto `target/local-computer-artifacts`,
  quindi restano locali e ignorati da git.
- Se il browser sidecar non riesce a partire, il smoke registra un evento
  redatto di failure e continua comunque il test shell.
- Verifiche eseguite:
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml local_computer_smoke_test_records_real_shell_output -- --nocapture`;
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - GREEN: `npm run test:ui-contract`;
  - GREEN: `npm run build`.

Perche': il Local Computer deve diventare la superficie di fiducia: non basta dire che il browser ha lavorato, serve un artifact/preview verificabile e legato alla stessa sessione, senza esporre payload raw.

## Prossimo blocco

### Fase 3 - Controlli Local Computer cablati

- Aggiunti a `LocalComputerSessionManager`:
  - `pause_session`;
  - `resume_session`.
- Collegato `request_takeover` gia' presente nel manager alla UI desktop.
- Aggiunti command Tauri:
  - `local_computer_request_takeover`;
  - `local_computer_pause_session`;
  - `local_computer_resume_session`.
- `coreBridge` espone i tre command e `ChatView` li usa nel pannello Computer.
- Il bottone `Pausa` cambia in `Riprendi` quando la sessione e' paused.
- Gli stati vengono persistiti nel read model Local Computer e registrano eventi
  redatti:
  - `computer_session_paused`;
  - `computer_session_resumed`;
  - `computer_takeover_requested`.
- Aggiornato `check-ui-contract.mjs` per impedire regressioni verso pulsanti
  solo visuali.
- Test aggiunto: `local_computer_controls_are_persisted_in_read_model`.
- Verifiche eseguite:
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml local_computer_controls -- --nocapture`;
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - GREEN: `npm run typecheck`;
  - GREEN: `npm run test:ui-contract`;
  - GREEN: `npm run build`;
  - Playwright su `http://127.0.0.1:1420/`: pannello Computer aperto, bottoni `Pausa` e `Prendi controllo` visibili senza overlap.

Perche': il Local Computer non deve essere solo una preview. L'utente deve poter fermare il runtime o chiedere controllo manuale da una UI che passa dal Core, cosi' l'audit e gli stati restano affidabili.

## Prossimo blocco

### Fase 4 - Browser automation read-only dal Prompt Plan Executor

- Aggiunto `local-first-browser-automation` come dipendenza del Tauri Core.
- Esteso `BrowserSidecarSession`:
  - supporta `current_dir`;
  - supporta env dedicate;
  - implementa `BrowserTransport`;
  - mantiene stdin/stdout persistenti per chiamate JSON-line multiple.
- `PromptPlanExecutor` ora, per step `surface=browser`:
  - riserva `browser_session` tramite Resource Governor;
  - avvia il sidecar Playwright locale;
  - chiama `browser.health`;
  - apre una tab sicura `about:blank`;
  - produce screenshot con `browser.screenshot`;
  - registra artifact `browser_preview_*` nella Local Computer Session;
  - salva checkpoint redatto `browser_read_only_completed`;
  - aggiorna timeline con `browser_read_only_artifact_ready`;
  - rilascia la risorsa browser anche dopo l'esecuzione.
- Gli artifact browser del task vengono scritti sotto
  `target/browser-task-artifacts`, quindi restano locali e ignorati da git.
- Test rafforzato:
  - `prompt_plan_executor_runs_first_research_step_and_records_checkpoint`
    verifica ora checkpoint browser, artifact screenshot e preview ref.
- Verifiche eseguite:
  - GREEN: `cargo test --manifest-path crates/browser-automation/Cargo.toml`;
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml prompt_plan_executor_runs_first_research_step_and_records_checkpoint -- --nocapture`;
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - GREEN: `npm run test:ui-contract`;
  - GREEN: `npm run build`.

Perche': questo chiude il primo passaggio da "piano visualizzato" a "azione browser locale reale". Resta read-only per non introdurre mutazioni web prima di policy form/submit/manual blocker complete.

## Prossimo blocco

### Fase 4 - Browser form draft senza submit

- Esteso il smoke Local Computer browser.
- Il smoke ora avvia un server HTTP locale effimero su `127.0.0.1` con una
  fixture di form.
- Il sidecar browser viene avviato con private-network opt-in solo per questo
  test locale controllato.
- Flusso eseguito:
  - `browser.health`;
  - `browser.open` sulla fixture locale;
  - `browser.snapshot` per ottenere ref accessibili;
  - `browser.act` con `kind=fill` sul campo `Name`;
  - `browser.screenshot`;
  - `browser.stop`.
- Non viene eseguito click su submit o azioni mutative.
- La timeline registra `browser_form_draft_completed` con `submitted=false`.
- Il test verifica che il read model non contenga il valore compilato ne' il
  risultato `Submitted`.
- Verifiche eseguite:
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml local_computer_smoke_test_records_real_shell_output -- --nocapture`;
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - GREEN: `npm run test:ui-contract`;
  - GREEN: `npm run build`.

Perche': dopo navigazione e screenshot, il prossimo comportamento fondamentale del browser e' compilare bozze senza inviare. Questo abilita casi come prenotazioni e form web mantenendo il blocco prima di submit/login/pagamento.

## Prossimo blocco

### Roadmap finale dettagliata

- Creato `docs/architecture/final-roadmap.md`.
- La roadmap trasforma la system map in 13 fasi operative:
  - Fase 0: mappa e contratti;
  - Fase 1: Prompt Plan Executor V1;
  - Fase 2: UI Tasks/Queue/Risorse/Approval reali;
  - Fase 3: Local Computer live;
  - Fase 4: Browser automation end-to-end;
  - Fase 5: Orchestrator Brain completo;
  - Fase 6: Capability, MCP, connettori e skill;
  - Fase 7: subagenti operativi;
  - Fase 8: memoria nel ciclo operativo;
  - Fase 9: persistenza, resume e task di giorni;
  - Fase 10: auto-apprendimento;
  - Fase 11: UI finale e qualita' esperienza;
  - Fase 12: production hardening e packaging.
- Ogni fase contiene obiettivo, componenti, deliverable, test minimi e gate di chiusura.
- Milestone prodotto:
  - A: test reale locale governato;
  - B: browser reale utile;
  - C: tool orchestration reale;
  - D: assistente personale contestuale;
  - E: prodotto installabile.
- Decisione: la prossima azione resta Fase 1, Prompt Plan Executor V1, con primo slice read-only e governato da Task Runtime + Resource Governor + Approval Gate.

Perche': ora abbiamo una sequenza verificabile fino all'obiettivo finale. Questo evita di anticipare auto-apprendimento, connettori o UI finale prima che esecuzione task, risorse e Local Computer siano realmente funzionanti.

## Prossimo blocco

### Mappa di sistema e focus progetto

- Creato `docs/architecture/system-map.md` come documento guida operativo.
- Il documento esplicita:
  - scopo prodotto;
  - flusso principale utente -> UI -> Core -> Brain -> Task Runtime -> tool -> Local Computer;
  - responsabilita' e non-responsabilita' di ogni componente;
  - stato attuale per UI, thread, Brain, task runtime, resource governor, capability, browser, Local Computer, memoria, subagenti, process manager e learning;
  - sequenza aggiornata di implementazione;
  - regole architetturali da non violare;
  - cosa e' base production-ready e cosa non e' ancora end-to-end production-ready.
- Decisione: `docs/architecture/system-map.md` e `docs/work-memory.md` devono restare allineati. Ogni blocco futuro deve aggiornare la memoria lavoro e, se cambia architettura o ordine, anche la system map.
- Decisione: i prossimi lavori devono dichiarare quale parte della mappa stanno chiudendo. Questo evita di saltare tra UI, Brain, browser e learning senza completare i pezzi base.

Perche': il progetto ha molti componenti separati ma interdipendenti. Senza una mappa stabile rischiamo di implementare feature isolate senza arrivare al comportamento finale: assistente locale che capisce, pianifica, usa strumenti, governa risorse, mostra il Local Computer e impara in modo controllato.

## Prossimo blocco

- Collegare Tasks/Approvals ai command `task_queue_snapshot` e `task_detail`.
- Collegare Connections/Settings ai command capability/runtime esistenti.
- Collegare il Browser Automation Runtime alla `LocalComputerSessionManager`, cosi' le azioni reali producono eventi, artifact e preview nella stessa card.
- Collegare `needs_planning` del composer al planner OrchestratorBrain completo per trasformare prompt generici in piani/tool/task invece dell'attuale stato di attesa `prompt_pending_brain`.
- Lasciare `LearningUiReadModel` e azioni di feedback utente per la fine, quando gli eventi PC reali saranno disponibili.

### Fase 4 - Browser action policy mutative

- Aggiunta `BrowserActionDecision` nel crate `browser-automation`.
- `BrowserPolicy::classify_tool_call` distingue gli atti browser prima
  dell'invio al sidecar:
  - `fill` e bozze non submit restano consentite;
  - `click`, `close` e `type` con `submit=true` richiedono approval;
  - gli altri metodi browser non mutativi restano consentiti.
- `BrowserTaskExecutor` applica la policy prima di chiamare Playwright:
  quando serve approval restituisce `ExecutorResult::NeedsApproval` e non
  invia alcun request al sidecar.
- Il mapping dei manual blocker emessi dal sidecar resta attivo per i casi in
  cui il blocker viene rilevato durante un'azione consentita.
- Test aggiunti/aggiornati:
  - policy su fill draft, click e submit;
  - executor che blocca click prima del sidecar;
  - executor che continua a mappare manual blockers del sidecar.
- Verifica mirata eseguita:
  - GREEN: `cargo test --manifest-path crates/browser-automation/Cargo.toml`.

Perche': la browser automation deve poter compilare bozze, ma non deve mai
cliccare, chiudere o inviare form senza un passaggio esplicito di approval. Il
blocco deve stare nel runtime, non solo nella UI, cosi' Brain, MCP e subagenti
non possono bypassarlo.

## Prossimo blocco

- Collegare il flusso approval -> resume per azioni browser mutative.
- Rendere visibile nella UI il motivo del blocco browser senza mostrare payload
  raw.
- Integrare il Brain planner reale sopra capability registry e task runtime,
  cosi' i prompt non dipendono da euristiche o regex.

### Fase 4 - Browser approval resume

- `BrowserTaskExecutor` ora legge il checkpoint precedente ricevuto dal Task
  Runtime.
- Se il checkpoint contiene una decisione `approved` per
  `browser.manual_action`, la policy mutativa non riblocca la stessa esecuzione
  e la chiamata viene inoltrata al sidecar.
- Il bypass e' ristretto all'action browser manuale approvata: un checkpoint di
  altra approval non basta.
- Aggiunto test `executor_runs_click_after_browser_action_approval_checkpoint`:
  una `browser.act` di tipo `click` viene prima bloccata normalmente, ma con
  checkpoint approvato viene eseguita e invia una sola request al transport.
- Verifica mirata eseguita:
  - GREEN: `cargo test --manifest-path crates/browser-automation/Cargo.toml`.

Perche': il sistema deve fermarsi davanti ad azioni web rischiose, ma dopo la
decisione esplicita dell'utente deve poter riprendere il task senza entrare in
un loop infinito di approval. Il resume resta governato dai checkpoint del Task
Runtime, quindi e' auditabile.

## Prossimo blocco

- Portare il blocker browser nella UI come stato leggibile e azionabile.
- Creare una demo locale end-to-end: form draft -> richiesta approval -> resume
  click simulato -> completion redatta.

### Fase 4 - Browser approval resume end-to-end locale

- Aggiunto test `browser_form_submit_waits_for_approval_then_resumes` nel
  Tauri Core.
- Il test usa componenti reali, non mock:
  - server HTTP locale effimero su `127.0.0.1`;
  - sidecar Playwright `runtimes/browser-automation`;
  - `BrowserTaskExecutor`;
  - `BrowserTaskRuntimeBridge`;
  - checkpoint di approval del Task Runtime.
- Flusso verificato:
  - `browser.open` apre la fixture locale;
  - `browser.snapshot` ricava il ref del bottone `Submit`;
  - `browser.act` con `kind=click` viene bloccato da policy e restituisce
    `NeedsApproval`;
  - dopo checkpoint `approved` per `browser.manual_action`, lo stesso task viene
    eseguito dal sidecar;
  - uno snapshot finale verifica che la pagina contiene `Submitted`.
- Il test usa artifact sotto `target/browser-approval-resume-artifacts`, quindi
  resta locale e fuori da git.
- Verifica mirata eseguita:
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml browser_form_submit_waits_for_approval_then_resumes -- --nocapture`.

Perche': questo e' il primo loop reale completo della browser automation
mutativa controllata: il sistema puo' preparare una bozza, fermarsi, ricevere
approval e riprendere l'azione senza bypassare policy o sidecar.

## Prossimo blocco

- Rendere il blocker browser piu' chiaro nella UI Tasks/Approval Center.
- Collegare il planner Brain ai task browser reali invece di fermarsi al piano
  visualizzato.

### Fase 4 - UI approval blocker leggibile

- Aggiornata la vista Tasks/Approval Center.
- Le approval ora portano nel view-model anche:
  - action tecnica;
  - data boundary;
  - task richiedente.
- Le approval `browser.manual_action` vengono tradotte in testo leggibile:
  - click browser;
  - close browser;
  - type/submit.
- La card mostra un'etichetta `Browser`, il confine dati e il task collegato,
  senza mostrare raw payload.
- Aggiunto stato vuoto per il centro approval.
- Aggiornato il contratto UI per verificare che i browser blockers abbiano
  label dedicata e mapping user-readable.
- Verifica visiva eseguita su `http://127.0.0.1:1420/` viewport `1440x960`,
  pagina `Pianificato`: nessun overlap rilevato nella card approval.
- Verifiche eseguite:
  - GREEN: `npm run test:ui-contract`;
  - GREEN: `npm run build`.

Perche': quando il browser si ferma prima di un click/submit, l'utente deve
capire rapidamente che non e' un errore ma una richiesta di controllo. Il
messaggio deve essere leggibile e redatto, perche' questa sara' una delle
interazioni piu' frequenti durante task web reali.

## Prossimo blocco

- Collegare il planner Brain ai task browser reali.
- Fare in modo che una richiesta naturale complessa generi ed esegua step
  browser/task usando il runtime invece di restare solo nel piano visualizzato.

### Fase 5 - Target URL sicura per step browser del Brain planner

- Esteso `PromptPlanStep` con `target_url` opzionale.
- Aggiornato il prompt JSON del planner:
  - per step browser puo' indicare una pagina di partenza;
  - deve usare homepage/start URL;
  - non deve usare search URL con query o raw user text.
- Aggiornata la validazione del piano:
  - `about:blank` consentito;
  - `http://` e `https://` consentiti;
  - query string e fragment bloccati;
  - URL troppo lunghe bloccate.
- `DesktopCoreState::enqueue_prompt_plan` salva `target_url` nell'input task,
  ma nel checkpoint redatto espone solo l'origine redatta
  (`target_url_origin`).
- `PromptPlanExecutor` usa `target_url` quando apre lo step browser; se assente
  resta su `about:blank`.
- Test aggiunti/aggiornati:
  - il piano treno espone una start URL sicura;
  - le query URL vengono rifiutate;
  - il task enqueue conserva solo origine redatta nel checkpoint UI.
- Verifica eseguita:
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.

Perche': per passare da piano visualizzato a browser task reale serve una
destinazione di partenza. Allo stesso tempo, una URL di ricerca con tutto il
prompt dentro sarebbe esfiltrazione verso un sito esterno. La regola start URL
consente esecuzione browser controllata senza leak del testo utente.

## Prossimo blocco

- Integrare Capability/Tool Registry nel planner operativo della UI, cosi' il
  Brain sceglie tool reali invece di soli `action_kind`.
- Mappare step browser pianificati a task `browser_automation` quando sono
  atomici, mantenendo `prompt_plan.*` per workflow multi-step.

### Fase 5 - Mapping Brain planner verso task browser reali

- Aggiunto `browser.open` al tool cache seed del Capability Registry.
- `DesktopCoreState::enqueue_prompt_plan` ora distingue gli step:
  - step browser atomici con `target_url` -> task `browser_automation`;
  - step senza destinazione eseguibile o non browser -> task `prompt_plan.*`;
  - step di approval restano governati da `ApprovalGate`.
- I task browser creati dal planner:
  - usano `BrowserTaskRuntimeBridge`;
  - hanno `method=browser.open`;
  - mantengono `session_id`, `step_id`, `action_kind` e origine URL redatta;
  - non espongono prompt raw nei checkpoint UI.
- `prompt_plan_run_next_step` ora esegue prima task `browser_automation`
  associati alla sessione corrente:
  - riserva `browser_session`;
  - usa `BrowserTaskExecutor`;
  - registra checkpoint redatti;
  - aggiorna Local Computer con eventi `browser_automation_task_started`,
    `browser_automation_task_completed`, `browser_automation_waiting_resource`
    o `browser_automation_waiting_approval`.
- Aggiornati i test:
  - il prompt di prenotazione treno enqueuea un task `browser_automation`;
  - il primo run completa quel task tramite executor browser;
  - il blocco risorse ora si applica al task browser reale;
  - i checkpoint continuano a non contenere raw prompt.
- Verifica eseguita:
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.

Perche': questo e' il passaggio da piano visualizzato a esecuzione tool reale.
Il Brain resta responsabile di pianificare, ma l'esecuzione avviene tramite task
typed, resource governor, BrowserTaskExecutor e Local Computer audit.

## Prossimo blocco

- Estendere il mapping ad altri tool del Capability Registry, partendo da
  `browser.snapshot` e `browser.screenshot`.
- Aggiungere un run sequenziale di piu' task del piano, non solo il prossimo
  step.

### Fase 5 - Browser task readback con snapshot e screenshot

- Aggiunto `browser.screenshot` al tool cache seed del Capability Registry.
- Gli step browser atomici creati dal Brain planner ora marcano il task con
  `read_after_open=true`.
- `prompt_plan_run_next_step`, quando esegue un task `browser_automation` con
  `read_after_open`, mantiene una singola sessione sidecar Playwright e chiama:
  - `browser.health`;
  - `browser.open`;
  - `browser.snapshot`;
  - `browser.screenshot`;
  - `browser.stop`.
- Il checkpoint del task resta redatto:
  - stato `completed`;
  - metodo `browser.open`;
  - origine URL redatta;
  - sole chiavi di output (`opened`, `snapshot`, `screenshot`), non payload raw.
- La Local Computer Session riceve:
  - evento `browser_automation_preview_ready`;
  - artifact screenshot con `preview_ref`;
  - evento `browser_automation_task_completed`.
- Test aggiornato:
  - `prompt_plan_executor_runs_first_research_step_and_records_checkpoint`
    verifica output keys `snapshot` e `screenshot`, evento preview e artifact.
- Verifica mirata eseguita:
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.

Perche': aprire una pagina non basta per un assistente operativo. Il sistema
deve anche leggere una snapshot strutturata e produrre una preview visiva, ma
farlo nello stesso sidecar evita di perdere lo stato della pagina tra processi.

## Prossimo blocco

- Aggiungere run sequenziale controllato di piu' step del piano.
- Portare nel read model UI il fatto che un task browser ha prodotto snapshot e
  preview, senza leggere il payload raw.

### Fase 5 - Batch runner controllato per step pronti

- Aggiunto `PromptPlanBatchRunResult` come DTO Core/UI per esporre:
  - stato batch;
  - numero di step completati;
  - motivo di stop;
  - risultati redatti dei singoli step.
- Aggiunto `DesktopCoreState::run_prompt_plan_ready_steps`:
  - esegue fino a `max_steps` step pronti;
  - limita il batch a 8 step massimo per non saturare il runtime;
  - si ferma su `idle`, `waiting_resource`, `waiting_user_approval` o `error`;
  - non bypassa Approval Gate e Resource Governor.
- Aggiunto comando Tauri `prompt_plan_run_ready_steps`.
- Aggiornato il bridge React con `coreBridge.runPromptPlanReadySteps`.
- La Chat ora espone il comando `Esegui piano`, che lancia fino a 4 step pronti
  e mostra un riepilogo leggibile invece di richiedere un click per ogni step.
- Test aggiunto:
  - richiesta treno -> esecuzione batch;
  - completa il task browser readback;
  - completa lo step read-only successivo;
  - si ferma in idle lasciando l'approval pagamento in attesa;
  - verifica evento `browser_automation_preview_ready`.
- Verifica eseguita:
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - GREEN: `npm run test:ui-contract` in `apps/desktop`;
  - GREEN: `npm run build` in `apps/desktop`;
  - GREEN: `cargo test --manifest-path crates/browser-automation/Cargo.toml`.

Perche': un assistente operativo non puo' richiedere un click manuale per ogni
micro-step, ma non puo' neanche procedere senza limiti. Questo batch runner e'
il primo loop controllato: avanza sugli step locali pronti, registra risultati
redatti e si ferma appena incontra risorse occupate, approval o assenza di
lavoro.

## Prossimo blocco

- Portare nel read model UI un riepilogo batch/task piu' chiaro, includendo
  preview browser e stato di stop senza payload raw.
- Rafforzare le dipendenze tra step quando il Brain produce piani multi-step
  piu' lunghi.
- Preparare il passaggio dal runner batch locale al loop orchestrato con task
  durevoli persistenti.

### Fase 5 - Preview artifact locale nel Computer UI

- Aggiunto DTO `ComputerArtifactPreview` nel Tauri Core.
- Aggiunto metodo `DesktopCoreState::local_computer_artifact_preview`:
  - cerca l'artifact solo dentro la sessione, utente e workspace correnti;
  - accetta solo artifact con `preview_ref`;
  - limita la preview a 5 MB;
  - accetta solo immagini `png`, `jpg/jpeg`, `webp`;
  - restituisce un `data_url` locale e non espone path raw nel payload UI.
- Aggiunto comando Tauri `local_computer_artifact_preview`.
- Aggiornato `coreBridge.localComputerArtifactPreview`.
- Aggiornato `mapCoreComputerSession` per individuare l'ultimo artifact con
  preview redatta.
- La Chat ora carica la preview artifact quando disponibile e la mostra:
  - come thumbnail nella card `Computer locale`;
  - come immagine grande nel pannello Browser del Computer.
- Aggiunto test TDD:
  - prima RED: metodo non presente;
  - poi GREEN: artifact screenshot di sessione -> `data:image/png;base64,...`;
  - verifica che il data URL non contenga il path locale.
- Verifica eseguita:
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - GREEN: `npm run test:ui-contract` in `apps/desktop`;
  - GREEN: `npm run build` in `apps/desktop`;
  - GREEN: `cargo test --manifest-path crates/browser-automation/Cargo.toml`;
  - GREEN: browser locale `http://127.0.0.1:1420/` desktop 1440x900 senza
    errori console e senza overlap evidente.

Perche': Manus rende forte l'esperienza perche' mostra cosa sta facendo il
computer, non solo log. Questo blocco rende visibile la preview browser reale
prodotta dal runtime, mantenendo il confine local-first: il browser web vede
solo un data URL generato dal Core per un artifact gia' registrato e redatto.

## Prossimo blocco

- Rendere il riepilogo batch piu' operativo nella UI Tasks/Computer: ultimo
  stop, step completati, approval pendenti e task bloccanti.
- Iniziare a rendere persistenti thread/task/sessioni, cosi' il test reale non
  dipende piu' solo da store in-memory.

### Fase 9 - Persistenza desktop locale V1

- Il bootstrap desktop ora usa storage locale persistente in
  `.local-first/desktop-state/`:
  - `task-runtime.sqlite`;
  - `memory.sqlite`;
  - `process-registry.sqlite`;
  - `capability-registry.sqlite`;
  - `local-computer.sqlite`;
  - `chat-threads.json`.
- Aggiunta modalità `seeded_in_memory` per i test, così la suite resta isolata.
- Il seed di task e memoria ora viene eseguito solo se lo scope locale è vuoto,
  per non resettare stato, approval, checkpoint o dati utente a ogni avvio.
- La sessione `computer_active_prompt` viene creata solo se manca già.
- `ChatThreadStore` ora può caricare/salvare su JSON locale:
  - `create_chat_thread` persiste subito il nuovo thread;
  - `touch_thread_for_session` aggiorna `active_thread_id`, timestamp e
    contatore messaggi su disco.
- `.local-first/` è stato aggiunto a `.gitignore`.
- Test aggiunto:
  - crea stato persistente su directory temporanea;
  - crea una nuova chat;
  - riapre `DesktopCoreState` dalla stessa directory;
  - verifica thread attivo, sessione computer e task runtime seed persistiti.
- Verifica eseguita:
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - GREEN: `npm run test:ui-contract` in `apps/desktop`;
  - GREEN: `npm run build` in `apps/desktop`.

Perche': per test reali e task lunghi non possiamo dipendere da store
in-memory. Questo primo blocco rende persistenti le fondamenta desktop senza
ancora promettere resume completo dei task running: thread, coda, checkpoint,
memoria, capability, process registry e Local Computer sono ora su file locali.

## Prossimo blocco

- Implementare recovery/lease all'avvio: task `running` o risorse prenotate da
  una sessione morta devono tornare in stato retryable o waiting_resource
  coerente.
- Rendere approval pending e batch summary più visibili nella UI dopo restart.

### Fase 9 - Recovery runtime all'avvio

- Aggiunto `recover_desktop_runtime_state` nel bootstrap desktop.
- A ogni avvio il Core ispeziona i task persistenti dello scope locale:
  - lascia invariato `local_prompt`, che rappresenta la sessione chat attiva;
  - rilascia risorse rimaste associate a task terminali
    (`completed`, `failed`, `cancelled`, `expired`);
  - per task `running` o `waiting_resource` non di sessione chat:
    - rilascia le risorse prenotate;
    - resetta `lease_owner`, `lease_expires_at`, `last_heartbeat_at`;
    - riporta il task a `queued`;
    - imposta `blocked_reason=recovered after desktop restart`;
    - aggiunge checkpoint redatto `desktop_recovery`.
- Test TDD aggiunto:
  - crea store persistente;
  - inserisce task browser `running` con risorsa `browser_session` prenotata;
  - riapre lo stato desktop;
  - verifica task `queued`, lease azzerato, risorsa rilasciata e checkpoint
    redatto senza raw payload.
- Verifica eseguita:
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - GREEN: `npm run test:ui-contract` in `apps/desktop`;
  - GREEN: `npm run build` in `apps/desktop`;
  - GREEN: `cargo test --manifest-path crates/browser-automation/Cargo.toml`.

Perche': dopo un crash o riavvio non vogliamo risorse fantasma che bloccano il
browser o task marcati running senza worker vivo. Questo recovery rende il
runtime riavviabile: il lavoro non viene perso, ma torna in coda con audit
esplicito e redatto.

## Prossimo blocco

- Esporre nella UI Tasks/Computer il fatto che un task e' stato recuperato dopo
  restart, con messaggio comprensibile e senza payload raw.
- Verificare che approval pending sopravviva a restart e resti azionabile dalla
  UI.

### Fase 9 - UI recovery e approval post-restart

- Aggiunto `humanizeTaskBlockedReason` nel frontend:
  - `recovered after desktop restart` diventa
    `Recuperato dopo riavvio: risorse locali rilasciate, task rimesso in coda.`;
  - blocchi risorsa diventano testo utente;
  - approval required diventa conferma utente.
- `summarizeSafeValue` riconosce checkpoint `desktop_recovery` e mostra
  `Recuperato dopo riavvio · risorse rilasciate` invece di un JSON generico.
- Aggiornato il contratto UI per impedire regressioni sul testo recovery.
- Aggiunto test persistente per approval:
  - crea stato persistente;
  - legge approval pending seed;
  - riapre lo stato;
  - verifica che l'approval sia ancora presente;
  - approva dopo restart;
  - verifica task `queued` e checkpoint approval redatto.
- Verifica eseguita:
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - GREEN: `npm run test:ui-contract` in `apps/desktop`;
  - GREEN: `npm run build` in `apps/desktop`;
  - GREEN: `cargo test --manifest-path crates/browser-automation/Cargo.toml`.

Perche': la recovery tecnica serve solo se l'utente la capisce. La UI ora
spiega quando un task e' stato rimesso in coda dopo restart e le approval
persistenti restano operative anche dopo riapertura dell'app.

## Prossimo blocco

- Chiudere un test reale end-to-end da UI: nuova chat -> prompt complesso ->
  piano -> batch -> preview browser -> approval visibile.
- Valutare se spostare chat thread storage da JSON a SQLite per allinearlo agli
  altri store persistenti prima dei task di giorni.

### Fase 11 - Computer locale collassabile nella chat

- Reso il card `Computer locale` collassabile nella chat operativa.
- Stato UX:
  - di default resta compatto, come barra da 44px circa;
  - quando parte un test reale o l'esecuzione del piano si espande per mostrare
    preview, step e azioni;
  - quando arriva una risposta finale dal core si richiude, cosi' la risposta
    torna a essere il contenuto primario.
- La barra compatta conserva solo le informazioni utili:
  - titolo della sessione;
  - superficie attiva (`Browser`, `Terminale`, `Computer`);
  - avanzamento e numero approval;
  - bottone di disclosure accessibile con `aria-expanded`.
- Aggiornato il contract test UI per impedire regressioni su collapse del
  Computer locale e styling compatto.
- Verifica visiva su `http://127.0.0.1:1420/`:
  - collassato: card `local-computer-card collapsed`, altezza 44px, nessun
    overflow pagina;
  - espanso: altezza 169px, nessun overlap con il composer;
  - la preview browser resta disponibile solo nel dettaglio/expanded state, non
    compete con la risposta.

Perche': il Computer locale deve dare contezza di cosa sta succedendo, ma non
deve diventare il protagonista quando il sistema ha gia' prodotto la risposta.
Questo allinea la UI alla regola di prodotto: risposta al centro, esecuzione
locale come contesto progressivo e richiudibile.

### Fase 11 - Chat lifecycle persistente

- Spostata la cronologia chat dal solo stato React al Core locale.
- Aggiunti read model/command Tauri:
  - `chat_messages_snapshot(thread_id)` per caricare i messaggi persistenti di
    un thread;
  - `select_chat_thread(thread_id)` per aggiornare il thread attivo nel Core.
- Esteso `ChatThreadStore`:
  - ora contiene messaggi per thread in una mappa separata;
  - crea uno starter message isolato per ogni nuova chat;
  - persiste thread, active thread e messaggi in `chat-threads.json`;
  - migra store vecchi senza messaggi aggiungendo starter message.
- `submit_user_prompt` continua a non includere il raw prompt nel
  `PromptSubmissionResult` e nei payload del Local Computer, ma registra il
  testo utente nella cronologia chat locale: e' contenuto di conversazione, non
  payload operativo o dato esfiltrabile verso tool.
- Dopo il primo prompt:
  - il titolo del thread diventa il primo prompt troncato;
  - il subtitle diventa la risposta assistant troncata;
  - il conteggio messaggi viene calcolato dalla cronologia reale;
  - il thread diventa attivo nel Core.
- La UI desktop ora:
  - idrata i messaggi da `coreBridge.chatMessages`;
  - seleziona thread tramite `coreBridge.selectChatThread`;
  - crea nuove chat caricando subito i messaggi dal Core;
  - conserva fallback web per anteprima senza bridge Tauri.
- Aggiornati `docs/architecture/system-map.md` e contract UI per fissare il
  confine: thread e messaggi sono read model del Core, non solo stato frontend.
- Verifica TDD:
  - RED: i test fallivano per assenza di `select_chat_thread` e
    `chat_messages_snapshot`;
  - GREEN: test su selezione thread, isolamento messaggi, preview thread dopo
    prompt e persistenza post-restart.

Perche': prima potevamo creare thread separati, ma la cronologia visibile era
ancora fragile per reload/switch e dipendeva dai mock. Ora nuova chat, switch e
riapertura hanno una fonte di verita' locale unica, necessaria prima di testare
orchestrazione tool piu' complessa.

### Fase 11 - Refresh operativo immediato da chat

- Aggiunto callback `onRuntimeChanged` da `ChatView` verso `App`:
  - dopo submit prompt;
  - dopo `Esegui piano`;
  - dopo smoke test reale.
- `App` ora chiama `refreshRuntimeReadModels` per ricaricare subito task queue,
  approval e task detail dopo mutazioni operative, senza aspettare il polling.
- Aggiunto callback `onThreadChanged`:
  - dopo submit prompt la UI rilegge thread e messaggi dal Core;
  - dopo batch del piano la UI rilegge il system message persistito dal Core;
  - React mantiene solo lo stato ottimistico durante l'invio, poi torna al read
    model locale reale.
- `run_prompt_plan_ready_steps` ora aggiunge alla cronologia chat un messaggio
  system persistente, ad esempio `Eseguiti 2 step locali...`, invece di lasciare
  l'avanzamento solo in memoria frontend.
- Aggiornato il contract UI per imporre refresh immediato di runtime e chat
  dopo mutazioni.
- Verifica TDD:
  - RED: `prompt_plan_batch_runner_executes_ready_steps_until_idle` falliva
    per assenza del messaggio system persistito;
  - GREEN: batch plan persiste il messaggio, refresh UI compila e contract passa.

Perche': per test reali l'utente deve vedere subito task, approval e stato
chat coerenti. Il polling resta utile come safety net, ma la chat non deve
aspettare secondi ne' perdere messaggi di avanzamento dopo reload.

### Fase 11 - Flusso piano/approval piu' testabile dalla UI

- Reso il `Computer locale` collassato piu' operativo:
  - se non ci sono approval pendenti mostra `Continua`, che esegue il batch
    degli step pronti senza dover espandere il pannello;
  - se ci sono approval pendenti mostra `Approval`, che porta direttamente alla
    vista Task/Approval;
  - nello stato espanso resta disponibile anche `Apri approval`.
- Cambiata l'azione primaria dell'Approval Center in `Approva e continua`.
- Dopo approval, `App`:
  - approva tramite `approval_approve`;
  - se l'approval appartiene al thread attivo, lancia
    `prompt_plan_run_ready_steps` sulla sessione Computer del thread;
  - ricarica task queue, approval, task detail, thread e messaggi.
- Aggiornato il contract UI:
  - la chat deve esporre un'azione diretta `Continua`/`Approval`;
  - l'approval deve dichiarare esplicitamente che continua il flusso;
  - il resume post-approval deve chiamare il batch runner del prompt plan.
- Verifica visuale su `http://127.0.0.1:1420/`:
  - card Computer resta collassato a 44px;
  - azione compatta larga 72px, senza overflow;
  - composer stabile;
  - nessun overflow pagina.

Perche': il percorso precedente richiedeva di sapere che bisognava espandere il
Computer o andare nella vista task. Ora il flusso e' leggibile: risposta al
centro, Computer come barra di stato, azione esplicita per continuare o sbloccare
approval.

### Fase 11 - Prova reale del flusso approval/resume

- Aggiunta prova automatica `approved_prompt_plan_gate_resumes_and_persists_progress_message`.
- Scenario coperto:
  - prompt complesso produce piano con step che richiede approval;
  - prima dell'approvazione `run_prompt_plan_next_step` non esegue lo step;
  - `approve_task_approval` rimuove l'approval del task del piano;
  - `run_prompt_plan_ready_steps` consuma lo step approvato;
  - la chat riceve un system message persistente `Eseguiti 1 step locali...`.
- Durante la prova e' emerso che lo stato seed contiene un'approval dimostrativa
  separata: il test ora verifica l'approval specifica del prompt plan invece di
  pretendere coda approval globale vuota.
- Verifica eseguita:
  - `approved_prompt_plan_gate_resumes_and_persists_progress_message`;
  - `browser_form_submit_waits_for_approval_then_resumes`;
  - `prompt_plan_batch_runner_executes_ready_steps_until_idle`;
  - `npm run test:ui-contract`;
  - `npm run build`;
  - suite completa `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
    con 31 test verdi.

Perche': questo conferma che `Approva e continua` non e' solo un'etichetta UI:
il Core sa riprendere il piano dopo un gate utente e persiste l'avanzamento
nella cronologia chat locale.

### Fase 12 - Ottimizzazione chiamata Gemma per intent routing

- Aggiunto endpoint runtime locale `POST /classify_intent` in
  `runtimes/mlx-gemma4/server.py`.
- Il nuovo endpoint:
  - incapsula prompt e schema di classificazione lato runtime;
  - riceve dal Core solo testo, locale opzionale, token budget e timeout;
  - usa `max_tokens` breve di default;
  - non usa JSON repair;
  - normalizza a `null` i campi `calculation_*` mancanti per route non
    matematiche, evitando una seconda generazione inutile.
- `crates/subagents` ora espone `IntentClassifyRequest` e `IntentRuntime`.
- `RuntimeClient` chiama `/classify_intent`; il planner continua a usare
  `/generate_json` per piani piu' ricchi.
- `RuntimePromptBrain` nel Tauri Core usa il nuovo endpoint:
  - timeout intent routing 8s;
  - `max_tokens` 96;
  - niente schema e niente repair nel payload client.
- Migliorati i fallback del prompt:
  - runtime non raggiungibile;
  - contratto Brain non valido;
  - planner non raggiungibile;
  - piano non valido.
- Misure live su Gemma 4 MLX dopo warm-up:
  - vecchio `/generate_json` per richiesta treno: ~7.99s, 394 prompt token,
    `repaired=true`;
  - nuovo `/classify_intent` su `quanto fa 6*3`: ~1.75s, 220 prompt token,
    `repaired=false`;
  - nuovo `/classify_intent` su richiesta treno: ~2.13s, 240 prompt token,
    `repaired=false`.
- Verifica TDD:
  - RED: endpoint `/classify_intent`, tipo Rust `IntentClassifyRequest` e
    `RuntimePromptBrain` su endpoint compatto mancavano;
  - GREEN: test Python e Rust passano e il runtime live produce JSON valido
    senza repair.

Perche': tutto continua a passare dal Brain Gemma, ma l'intent routing non usa
piu' il contratto generico pesante. La latenza percepita per richieste semplici
scende senza introdurre routing nel frontend o regex nel composer.

### Fase 12 - Runtime Control Center per Gemma e sidecar

- Aggiunto control layer in `crates/process-manager`:
  - `RuntimeDiscoveryProbe` per scoprire processi esterni;
  - `LocalRuntimeDiscovery` basato su `lsof`, `ps` e `sysctl`;
  - `DiscoveredProcess`, `RuntimeResourceSnapshot`,
    `RuntimeControlSnapshot`, `RuntimeControlStatus`;
  - `ProcessManager::runtime_control_snapshot`;
  - `ProcessManager::restart`.
- Il control snapshot rileva:
  - processo gestito dal nostro supervisor;
  - processo esterno gia' in ascolto sulla porta del runtime;
  - duplicati del server Gemma;
  - porta, pid, memoria processo, CPU processo e memoria totale quando
    disponibili.
- Aggiunti test TDD:
  - runtime Gemma esterno su porta `8765` senza snapshot gestito;
  - conflitto duplicati quando piu' processi Gemma sono presenti;
  - restart del processo gestito.
- Esteso il read model Tauri:
  - `RuntimeHealthSnapshot` ora include `controls`;
  - comando `process_restart`;
  - pagina Settings/Runtime mostra stato control, porta, pid, memoria, CPU,
    duplicati e azioni `Avvia`, `Riavvia`, `Ferma`.
- Verifiche eseguite:
  - `cargo test -p local-first-process-manager`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime_snapshot_lists_default_sidecars_without_env`;
  - `npm run build`.

Perche': prima potevamo controllare solo processi avviati dal nostro supervisor.
Ora possiamo capire se Gemma e' gia' attivo esternamente, se ci sono duplicati,
quali risorse sta usando e abbiamo un'azione di restart esplicita dal Core/UI.

### Fase 12 - Verifica runtime e blocker Tauri nativo

- Verifiche automatiche fresche eseguite il 2026-05-24:
  - `python3 -m unittest tests.test_mlx_gemma4_server`: 18 test verdi;
  - `cargo test -p local-first-subagents --test runtime_client`: 3 test verdi;
  - `cargo test -p local-first-process-manager`: suite verde;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: 32 test
    verdi;
  - `npm run build` in `apps/desktop`: build Vite verde.
- Test live con `./.venv-mlx/bin/python runtimes/mlx-gemma4/server.py`:
  - `/health` risponde in ~0.01s prima del load modello;
  - primo `/classify_intent` include cold load e wall time ~7.20s;
  - warm `quanto fa 6*3`: ~1.84s, route `local_calculation`,
    `repaired=false`;
  - warm `che ore sono?`: ~1.17s, route `local_time`, `repaired=false`;
  - warm `what is 12 times 7?`: ~1.76s, route `local_calculation`,
    `repaired=false`;
  - warm richiesta treno Napoli-Milano: ~1.75s, route `needs_planning`,
    `repaired=false`.
- Verifica controllo processi su runtime reale:
  - porta `127.0.0.1:8765` in ascolto;
  - processo rilevato come `./.venv-mlx/bin/python
    runtimes/mlx-gemma4/server.py`;
  - RSS osservato ~5.8GB dopo load Gemma.
- Verifica UI:
  - versione browser `http://127.0.0.1:1420/` renderizza e non mostra overflow
    verticale a 1280x720;
  - finestra Tauri nativa `Local First Assistant` resta bianca anche se Vite
    serve correttamente la UI.

Perche': il core locale e il runtime Gemma sono verificabili, ma il test utente
reale deve passare dall'app Tauri nativa. Il prossimo intervento deve quindi
risolvere la finestra bianca Tauri prima di continuare con test manuali
end-to-end.

### Fase 12 - Auto-start runtime Gemma con Tauri

- Aggiunto `ProcessManager::ensure_runtime_started`.
- Il metodo:
  - avvia il runtime se e' `configured`, `stopped` o `unhealthy`;
  - non avvia duplicati se trova un processo esterno gia' in ascolto sulla
    porta;
  - non riavvia un processo gia' gestito o healthy;
  - non interviene in caso di conflitto duplicati, lasciando visibile il
    problema al Runtime Control Center.
- Tauri chiama `DesktopCoreState::ensure_required_runtimes_started()` durante
  il bootstrap dell'app.
- Per ora il runtime obbligatorio auto-avviato e' `llm-gemma4-mlx`.
- Test TDD aggiunti:
  - auto-start quando Gemma non e' disponibile;
  - riuso di un listener Gemma esterno senza spawn duplicato.
- Verifica live:
  - riavvio pulito Tauri;
  - processo `runtimes/mlx-gemma4/server.py` avviato automaticamente;
  - porta `127.0.0.1:8765` in ascolto.
- Verifiche eseguite:
  - `cargo test -p local-first-process-manager`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `npm run build` in `apps/desktop`.

Perche': l'utente non deve sapere che Gemma e' un sidecar separato. Se apre
l'app e Gemma e' spento, il runtime locale deve partire automaticamente; se
Gemma e' gia' acceso, l'app deve agganciarsi senza creare processi doppi.

### Fase 12 - Chiarezza UX per piani e approval in chat

- Problema osservato: la richiesta "trova/prenota un treno" esponeva troppo il
  workflow interno:
  - approval comprensibile solo aprendo Tasks;
  - bottone generico `Approval`/`Continua`;
  - messaggi tecnici in chat come "Nessuno step prompt_plan pronto".
- Aggiornata la chat:
  - le approval della sessione attiva compaiono inline nella conversazione;
  - la scheda spiega cosa si sta approvando, cosa fara' il prossimo step e cosa
    resta bloccato;
  - pulsanti diretti `Rifiuta` e `Approva e continua`;
  - label `Conferma richiesta` al posto di `Approval`;
  - l'azione `Continua` viene disabilitata quando non ci sono step in attesa
    secondo il read model visibile.
- Aggiornato `mapCoreApproval`:
  - `prompt_plan.approve_step` diventa `Conferma piano operativo`;
  - copy piu' chiaro: non autorizza acquisti, login, invii o pagamenti
    automatici.
- Aggiornato `run_prompt_plan_ready_steps`:
  - non scrive piu' in chat messaggi idle quando non e' stato eseguito niente;
  - quando completa step e poi si ferma, usa una frase orientata all'utente.
- Verifiche:
  - `npm run build` in `apps/desktop`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml prompt_plan`.

Perche': la chat deve restare centrata sulla risposta e sul prossimo passo
comprensibile. Timeline, task runtime e approval sono utili, ma non devono
sembrare comandi interni da decifrare.

### Fase 13 - Stop, reset del criterio prodotto e Product Loop

- Decisione presa dopo revisione critica: il progetto stava procedendo dal
  sistema verso l'utente, mostrando troppa infrastruttura nella UX.
- Nuovo criterio guida:
  - prima chat Gemma semplice e stabile;
  - poi strumenti assistiti;
  - infine orchestrazione avanzata visibile solo quando serve.
- Creato `docs/PRODUCT_LOOP.md`.
- Il documento definisce cinque flussi obbligatori:
  - domanda semplice;
  - calcolo o risposta breve;
  - richiesta informativa senza azione;
  - richiesta con strumento visibile;
  - richiesta rischiosa con approval.
- Aggiornato `PROJECT.md` con riferimento esplicito al Product Loop.
- Processi dev spenti per evitare di continuare debugging UI senza prima
  riallineare il prodotto:
  - Tauri dev;
  - Vite;
  - Gemma runtime.

Perche': abbiamo gia' molti moduli, ma non un'esperienza base usabile. Da ora
una modifica e' utile solo se rende uno dei cinque flussi piu' chiaro, veloce o
affidabile senza peggiorare gli altri.

### Fase 13 - Chat Gemma semplice come percorso base

- Aggiunto supporto client Rust per il runtime `/generate`:
  - `GenerateRequest`;
  - `GenerateResponse`;
  - trait `TextRuntime`;
  - `RuntimeClient::generate`.
- Aggiunto percorso Tauri separato per chat semplice:
  - `PromptChatResponder`;
  - `RuntimePromptChatResponder`;
  - `prompt_submission::submit_chat_prompt`;
  - `DesktopCoreState::submit_chat_prompt`;
  - command Tauri `submit_chat_prompt`.
- Il composer React ora usa `coreBridge.submitChatPrompt(...)` come percorso
  base, non `submit_user_prompt(...)`.
- Il vecchio `submit_user_prompt` con Brain/planner/task resta disponibile nel
  Core, ma non e' piu' il comportamento base della chat.
- La chat semplice:
  - non crea piani;
  - non crea task `prompt_plan`;
  - non mostra timeline/computer locale se non c'e' attivita' operativa reale;
  - non mostra messaggi di bootstrap sul computer locale;
  - apre con "Sono pronto. Scrivimi pure: rispondo con Gemma locale."
- Test aggiunto:
  - `submit_chat_prompt_uses_plain_gemma_answer_without_creating_plan_or_tasks`.
- Verifiche automatiche:
  - `cargo test -p local-first-subagents --test runtime_client`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `npm run build` in `apps/desktop`.
- Test live `/generate` su Gemma:
  - `Ciao, chi sei?`: primo giro con cold load ~5.9s wall, generazione ~1.3s;
  - domanda su mutuo: ~2.0s wall;
  - bozza mail breve: ~3.9s wall.

Perche': il Product Loop ora ha un primo percorso coerente: scrivi in chat,
Gemma risponde, nessuna orchestrazione visibile viene attivata per default.

### Fase 13 - Pulizia UX chat base

- Dopo test manuale e screenshot, corretti altri residui tecnici nel loop base:
  - nascosta la Local Computer card nella chat semplice anche se la sessione ha
    timeline/artifact storici;
  - rimosso il chip `Computer locale` dal composer base;
  - aggiunto messaggio inline `Gemma sta rispondendo` con indicatore testuale,
    al posto di un feedback generico da loading;
  - nascosti dalla UI i metadati tecnici `Tauri core locale`, `Inviato al core
    locale` e `Non salvato come payload raw`, anche per thread vecchi;
  - badge assistant cambiato da `Local` a `Gemma`;
  - le nuove user message non persistono piu' metadata tecnici;
  - le risposte assistant usano `white-space: pre-wrap` per non comprimere
    email/testi multilinea in un blocco sporco;
  - prompt chat aggiornato per evitare markdown salvo richiesta esplicita.
- Verifiche:
  - `npm run build` in `apps/desktop`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
    submit_chat_prompt_uses_plain`.
- Stato residuo dichiarato: manca ancora streaming reale token-by-token. Per
  farlo bene serve un endpoint streaming nel runtime Gemma e un bridge Tauri
  event/channel dedicato.

Perche': la chat base deve apparire come una chat pulita anche su thread con
storia sporca salvata dai test precedenti.

### Fase 13 - Timestamp e invio rapido chat

- Aggiunta formattazione oraria `HH:mm` nella chat desktop per i timestamp
  numerici salvati dal core.
- I nuovi messaggi utente creati in UI usano timestamp Unix in secondi invece
  di `ora`.
- Il core Tauri salva timestamp reali per:
  - messaggi utente;
  - risposte assistant;
  - messaggi system;
  - messaggio iniziale dei nuovi thread.
- Il composer ora invia con `Enter`.
- `Shift+Enter` resta disponibile per inserire una nuova riga nel prompt.
- Verifiche:
  - `npm run build` in `apps/desktop`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
    submit_chat_prompt_uses_plain`.
- Tauri dev ha ricompilato automaticamente e il browser locale carica ancora
  composer e pulsante invio.

Perche': la chat deve comportarsi come una chat normale. L'utente non deve
cliccare sempre il pulsante e deve vedere quando una risposta e' arrivata.

### Fase 13 - Streaming risposte Gemma

- Aggiunto endpoint runtime locale `POST /generate_stream`.
- Il runtime usa `mlx_vlm.generate.stream_generate`, quindi emette delta reali
  durante la generazione invece di simulare lo streaming dopo la risposta.
- Il formato stream e' NDJSON locale:
  - `{"type":"delta","text":"..."}`;
  - `{"type":"done","text":"...","metrics":{...}}`.
- Le metriche finali restano disponibili:
  - `prompt_tokens`;
  - `generation_tokens`;
  - `prompt_tps`;
  - `generation_tps`;
  - `peak_memory_gb`;
  - `elapsed_seconds`.
- `crates/subagents` ora deserializza `GenerateStreamEvent` e il
  `RuntimeClient` legge `/generate_stream` riga per riga.
- Tauri espone `submit_chat_prompt_stream` e inoltra i delta alla UI con evento
  `chat_stream_delta`.
- La chat React:
  - crea subito il messaggio assistant;
  - mostra `Gemma sta iniziando a rispondere...` finche' non arriva il primo
    delta;
  - aggiorna il testo progressivamente mentre arrivano chunk;
  - salva/sostituisce il messaggio finale con quello persistito dal Core.
- Riavviato il runtime Gemma locale per caricare il nuovo endpoint.
- Verifica live:
  - `curl -sN /generate_stream` ha prodotto un evento `delta` e un evento
    `done` con metriche reali.
- Verifiche automatiche:
  - `python3 -m unittest tests.test_mlx_gemma4_server`;
  - `cargo test -p local-first-subagents --test runtime_client`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
    submit_chat_prompt`;
  - `npm run build` in `apps/desktop`.

Perche': la chat non deve attendere un blocco finale prima di dare feedback. Lo
streaming e' il primo passo per far percepire Gemma come un assistente
interattivo e non come una chiamata batch.

### Fase 14 - Azioni contestuali sulle chat

- Aggiunte azioni di gestione thread:
  - `Pin in alto` / `Rimuovi pin`;
  - `Archivia`;
  - `Elimina`.
- Le azioni sono accessibili con tasto destro sulla chat nella sidebar.
- Il pin e' persistito nel core e riordina i thread pinnati sopra gli altri.
- L'archiviazione sposta la chat nella sezione `Archiviati` e conserva messaggi
  e stato locale.
- L'eliminazione rimuove thread e messaggi dalla persistenza locale.
- Se l'azione riguarda la chat attiva, il core seleziona automaticamente la
  prossima chat attiva disponibile.
- Protezione temporanea: non si puo' archiviare o eliminare l'ultima chat
  attiva.
- Verifiche:
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
    chat_thread`;
  - `npm run build` in `apps/desktop`.

Perche': la lista chat deve diventare gestibile senza introdurre ancora una
pagina archivio completa. Il menu contestuale mantiene la sidebar pulita e
aggiunge solo azioni quando servono.

### Fase 15 - Sidebar pulita, ricerca e archivi

- Rimossi i controlli finestra finti da drawer e rail; Tauri fornisce gia' i
  controlli nativi della finestra.
- La sidebar ora separa chiaramente:
  - `Nuovo compito` come azione primaria;
  - `Cerca` come modale di ricerca chat;
  - `Progetti`;
  - `Tutti i compiti`;
  - `Archiviati`, visibile quando esistono thread archiviati.
- `Progetti`, `Tutti i compiti` e `Archiviati` sono collassabili.
- I pulsanti della sidebar sono tornati a superficie trasparente di default:
  testo/icona puliti, hover grigio chiaro e stato attivo discreto.
- `Elimina` ora apre una conferma esplicita prima di cancellare la chat.
- Nel core Tauri gli snapshot includono anche i thread archiviati; il vincolo
  `non eliminare l'ultima chat attiva` vale solo per thread attivi, quindi una
  chat archiviata puo' essere eliminata anche se resta una sola chat attiva.
- Le chat archiviate possono essere ripristinate con `Rimuovi dall'archivio`
  dal menu contestuale, tornando in `Tutti i compiti` senza perdere messaggi.
- La modale `Cerca chat` mostra titolo chat, progetto a destra e shortcut
  visivi, senza esporre payload interni.
- La stessa modale si apre sia dalla sidebar estesa sia dalla rail collassata.
- Verifiche:
  - `npm run build` in `apps/desktop`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chat_thread`;
  - verifica browser su `http://127.0.0.1:1420/` per layout sidebar, modale
    ricerca e conferma eliminazione.

Perche': la gestione chat deve essere ovvia e poco rumorosa. Le azioni
distruttive richiedono conferma, gli archivi restano recuperabili, e la sidebar
mantiene la stessa grammatica visiva in tutti gli stati.

### Fase 16 - Rendering ricco dei messaggi chat

- Analizzata la documentazione assistant-ui CLI:
  - utile come riferimento per pattern `Thread`, composer e message renderer;
  - non adottata via CLI perche' porta shadcn/Tailwind e una grammatica UI
    diversa dalla nostra shell custom Tauri.
- Aggiunto renderer locale `RichMessage` ispirato al pattern assistant-ui:
  - Markdown;
  - GitHub Flavored Markdown;
  - link esterni sicuri;
  - tabelle;
  - liste;
  - blockquote;
  - codice inline;
  - blocchi codice con header lingua e pulsante copia;
  - blocchi Mermaid renderizzati come diagrammi.
- Aggiunte dipendenze desktop:
  - `react-markdown`;
  - `remark-gfm`;
  - `rehype-sanitize`;
  - `mermaid`.
- Mermaid e' caricato con import dinamico solo quando compare un blocco
  `mermaid`, cosi' il bundle principale resta piu' leggero.
- Il renderer usa `rehype-sanitize` per evitare HTML arbitrario nei messaggi.
- `ChatView` ora usa `RichMessage` per user, assistant e system message,
  mantenendo il fallback typing durante lo streaming.
- Verifiche:
  - `npm run build` in `apps/desktop`;
  - `git diff --check`.

Perche': la chat non puo' essere solo testo semplice. Risposte reali di un
assistente includono codice, markdown, tabelle e diagrammi; il rendering deve
essere una superficie dedicata e sostituibile, non logica sparsa dentro
`ChatView`.

### Fase 17 - Chat Experience Foundation in roadmap

- Aggiunto assistant-ui come riferimento architetturale, non come CLI/theme da
  importare automaticamente.
- Creato `docs/decisions/0003-assistant-ui-chat-reference.md`.
- Aggiornato `docs/PRODUCT_LOOP.md` con `Chat Experience Foundation`.
- Aggiornato `docs/architecture/final-roadmap.md`:
  - nuova Fase 0.5 prima del cablaggio avanzato degli executor/tool;
  - la chat complessa non e' piu' relegata a UI polish finale;
  - definiti deliverable per renderer, composer, attachments, message actions,
    suggestions e activity rendering.
- Aggiornato `docs/architecture/system-map.md`:
  - Desktop UI deve renderizzare contenuti complessi;
  - Chat Thread segue external-store pattern con Tauri Core owner dello stato.
- Aggiornato `PROJECT.md`:
  - la chat experience e' fondazione, non rifinitura finale;
  - assistant-ui e' riferimento per thread, composer, attachments, actions,
    suggestions, tool activity ed external-store runtime.

Decisione operativa:

- Prima chiudere la Chat Experience Foundation abbastanza da testare bene:
  - Markdown/codice/tabelle/Mermaid;
  - composer avanzato;
  - cancel streaming;
  - allegati/artifact;
  - azioni messaggio;
  - suggestions;
  - activity Local Computer collassata e leggibile.
- Poi riprendere il cablaggio delle funzioni operative complesse:
  - executor task browser/shell;
  - Brain tool orchestration;
  - connettori/MCP;
  - subagenti;
  - memoria nel ciclo Brain.

Perche': se cabliamo funzioni complesse prima che la chat sappia mostrarle, ogni
test reale sembrera' confuso. La UI chat deve diventare il banco di prova
stabile, mentre il routing/tool execution resta nel Core.

### Fase 18 - Chat rendering streaming-safe e azioni messaggio

- Aggiornato il contratto UI automatico per il flusso streaming reale:
  - il composer deve usare `submitChatPromptStream`;
  - `RichMessage` deve ricevere stato streaming;
  - Mermaid non deve renderizzare durante una risposta incompleta;
  - i messaggi devono esporre almeno un'azione contestuale leggera.
- `RichMessage` ora crea i componenti Markdown in base allo stato streaming.
- I blocchi `mermaid` restano in forma codice mentre la risposta e' in corso e
  vengono renderizzati solo a risposta completa.
- Aggiunta azione messaggio `Copia`, visibile solo su hover/focus per non
  sporcare la gerarchia della risposta.
- Verifiche:
  - `npm run test:ui-contract` in `apps/desktop`;
  - `npm run typecheck` in `apps/desktop`;
  - `npm run build` in `apps/desktop`;
  - snapshot browser a 1440x900 su `http://127.0.0.1:1420/`.

Perche': durante lo streaming il testo puo' contenere Markdown incompleto; i
renderer pesanti devono aspettare la fine della risposta. Le azioni messaggio
servono, ma non devono competere con il contenuto principale della chat.

### Fase 19 - Composer avanzato minimale

- Aggiunto stop streaming lato UI:
  - durante una risposta compare il pulsante `Interrompi risposta`;
  - la chat smette di mostrare delta/finali tardivi per quella richiesta;
  - la risposta resta marcata come interrotta localmente.
- Aggiunta crescita controllata del textarea fino a 180px, mantenendo il
  composer ancorato e senza spingere fuori la chat.
- Aggiunta selezione allegati locale nel composer:
  - nome file;
  - dimensione;
  - rimozione prima dell'invio.
- Gli allegati non vengono ancora inviati al backend: serve prima un Tauri
  command dedicato con policy privacy/redazione.
- Aggiunti suggerimenti prompt contestuali:
  - appaiono solo mentre l'utente sta scrivendo;
  - non occupano spazio nella chat inattiva.
- Verifiche:
  - `npm run test:ui-contract` in `apps/desktop`;
  - `npm run typecheck` in `apps/desktop`;
  - `npm run build` in `apps/desktop`;
  - snapshot browser a 1440x900.

Perche': il composer deve diventare uno strumento operativo, ma non deve
diventare una toolbar rumorosa. Stop, allegati e suggerimenti servono alla chat
complessa; devono pero' rimanere contestuali e subordinati alla risposta.

### Fase 20 - Stop streaming reale e cancellazione cooperativa Gemma

- Aggiunto `request_id` opzionale al payload locale `GenerateRequest`.
- Il composer continua a interrompere subito la UI, ma ora chiama anche il core
  Tauri con `cancel_chat_prompt_stream`.
- Il core Tauri:
  - espone il command `cancel_chat_prompt_stream`;
  - mantiene un set di stream cancellati;
  - blocca delta successivi;
  - non registra una risposta finale dopo cancellazione;
  - inoltra best-effort la cancellazione al runtime Gemma.
- Il client runtime locale (`RuntimeClient`) ora espone `cancel_generation` e
  riconosce eventi streaming di tipo `error`.
- Il runtime Python Gemma:
  - espone `POST /cancel_generation`;
  - traccia `request_id` cancellati;
  - durante `/generate_stream` emette `generation_cancelled` e termina il loop;
  - libera il lock di generazione nel `finally`.
- Limite noto: e' cancellazione cooperativa tra token/chunk. Se `mlx-vlm` e'
  bloccato dentro la generazione di un singolo step, lo stop effettivo avviene
  appena il controllo torna al loop Python.
- Verifiche:
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chat_prompt_stream`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `cargo test -p local-first-subagents`;
  - `python -m unittest tests.test_mlx_gemma4_server`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`.

Perche': una chat usabile deve poter fermare davvero una risposta lunga. Solo
nascondere il loading lato UI non basta: Gemma continuerebbe a usare risorse e
potrebbe inquinare lo stato con finali tardivi.

### Fase 21 - Allegati chat come artifact locali

- Esteso il read model chat con `attachments` redatti per messaggio.
- Aggiunto contratto frontend `ChatAttachmentInput`:
  - path locale;
  - nome display;
  - MIME type;
  - size.
- Il composer ora prova a leggere il path locale esposto da Tauri (`File.path`):
  - se disponibile, passa l'allegato al core;
  - se non disponibile, mostra che l'allegato funziona solo dall'app Tauri e
    blocca l'invio con errore locale invece di creare un riferimento finto.
- Il core Tauri registra gli allegati nel `LocalComputerSessionManager` come
  artifact:
  - massimo 8 allegati per messaggio;
  - massimo 50 MB per allegato;
  - solo file locali;
  - preview locale solo per immagini entro 5 MB;
  - path e contenuto non vengono esposti nel messaggio chat.
- I messaggi utente mostrano chip allegati con:
  - nome redatto;
  - tipo;
  - dimensione.
- Test aggiunto:
  - l'allegato viene registrato come artifact del Computer locale;
  - il messaggio chat non contiene il path raw.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `git diff --check`;
  - snapshot browser a 1440x900.

Perche': gli allegati sono parte della chat operativa, ma devono rispettare il
principio local-first. La chat conserva riferimenti redatti e metadata, mentre
il contenuto resta sul filesystem locale e gli artifact vivono nel Computer
locale.

### Fase 22 - Azione messaggio: rigenera risposta

- Aggiunta l'azione `Rigenera` sulle risposte assistant.
- L'azione resta dentro la barra azioni del messaggio, visibile su hover/focus,
  per non competere con il contenuto principale della risposta.
- La rigenerazione recupera il messaggio utente precedente e lo reinvia al core
  locale nello stesso flusso streaming della chat.
- Gli allegati gia' mostrati nel messaggio utente vengono conservati nella UI
  come riferimenti redatti durante la rigenerazione.
- Scelta privacy: la rigenerazione non riapre automaticamente i path raw degli
  allegati, perche' la chat persistente conserva solo metadata redatti. Il
  riuso effettivo del contenuto allegato andra' gestito dal layer artifact /
  Brain quando colleghiamo l'ingestione completa.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `git diff --check`.

Perche': le azioni messaggio sono parte della chat production-ready. Prima di
aggiungere quote/edit/copy avanzati, rigenerare una risposta consente di testare
il ciclo piu' importante: riprendere una richiesta esistente senza sporcare la
conversazione con controlli invasivi.

### Fase 23 - Azione messaggio: continua risposta

- Aggiunta l'azione `Continua` sulle risposte assistant.
- L'azione usa lo stesso flusso streaming locale della chat, senza creare un
  nuovo pannello o una nuova modalita' operativa.
- Il prompt visibile all'utente resta breve (`Continua`), mentre il prompt
  interno passato a Gemma include il contesto della risposta precedente e chiede
  di proseguire senza ripetere.
- L'azione resta nella stessa `message-action-bar` di copia/rigenera, quindi
  compare solo quando il messaggio e' attivo/leggibile e non compete con la
  risposta.
- Verifiche:
  - test contratto prima fatto fallire su `continueAssistantResponse`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `git diff --check`.

Perche': continuare una risposta lunga o incompleta e' un comportamento base di
una chat seria. Va risolto nella superficie conversazionale prima di tornare a
orchestrazione, tool e task complessi.

### Fase 24 - Quote/reply nel composer

- Aggiunta l'azione `Rispondi` sui messaggi della chat.
- Quando l'utente risponde a un messaggio, il composer mostra una card leggera
  con:
  - ruolo del messaggio citato;
  - anteprima redatta e accorciata;
  - pulsante per rimuovere la citazione.
- Il testo visibile nel thread resta solo quello scritto dall'utente.
- Il prompt interno passato a Gemma include invece il contesto citato, cosi' la
  risposta puo' riferirsi al messaggio corretto senza costringere l'utente a
  copiare/incollare.
- La card e' dentro il composer, non nella timeline o nel Computer locale, per
  mantenere la chat come centro dell'esperienza.
- Verifiche:
  - test contratto prima fatto fallire su `replyToMessage`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `git diff --check`;
  - controllo browser con click su `Rispondi` e screenshot del composer.

Perche': una chat che deve sostenere task lunghi e risposte tecniche deve poter
ancorare una nuova richiesta a un messaggio specifico. Questo riduce ambiguita'
senza introdurre un planner visibile o una UI piu' pesante.

### Fase 25 - Feedback utile/non utile persistente

- Aggiunto feedback `useful` / `not_useful` sui messaggi assistant.
- Il feedback non resta solo nello stato React: viene salvato nel read model
  persistente della chat tramite il core Tauri.
- Aggiunto command locale `chat_message_set_feedback`.
- Il core valida i valori ammessi:
  - `useful`;
  - `not_useful`;
  - `null` per rimuovere il feedback.
- Il feedback e' ammesso solo su messaggi assistant, non su prompt utente o
  messaggi di stato.
- La UI usa due icone discrete nella `message-action-bar`, senza testo visibile,
  per non rubare attenzione alla risposta.
- Test aggiunto:
  - il feedback viene persistito;
  - il testo del messaggio non cambia;
  - il feedback puo' essere rimosso.
- Verifiche:
  - test contratto prima fatto fallire su `setMessageFeedback`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chat_message_feedback`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `npm run build`;
  - `git diff --check`;
  - controllo browser della barra azioni.

Perche': il feedback e' un segnale importante per migliorare ranking, memoria e
apprendimento futuro. Va raccolto in modo leggero, ma deve essere persistente e
validato dal core locale.

### Fase 26 - Salva messaggio in memoria

- Aggiunta azione `Salva in memoria` sui messaggi assistant.
- L'azione non e' solo UI:
  - crea una `MemoryEvent` locale con payload redatto;
  - crea una `MemoryRecord` candidate nel Memory Core;
  - collega l'evento come evidence della candidate;
  - salva sul messaggio chat il `saved_memory_ref`.
- Il salvataggio e' idempotente lato chat: se il messaggio ha gia' un
  `saved_memory_ref`, non crea una seconda candidate.
- La memoria usa:
  - `memory_type = chat_note`;
  - `privacy_domain = chat`;
  - `sensitivity = private`;
  - metadata redatti con `thread_id`, `message_id` e source locale.
- Esteso il read model chat con `saved_memory_ref`.
- Esteso il filtro dashboard memoria per includere il dominio `chat`.
- Aggiunto command Tauri `chat_message_save_to_memory`.
- La UI mostra un'icona discreta nella barra azioni, attiva quando il messaggio
  e' gia' stato salvato.
- Test aggiunto:
  - crea candidate memory;
  - marca il messaggio con `saved_memory_ref`;
  - espone il dominio `chat` nel dashboard;
  - evita duplicazione su secondo salvataggio.
- Verifiche:
  - test contratto prima fatto fallire su `saveMessageToMemory`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chat_message_save_to_memory`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `npm run build`;
  - `git diff --check`;
  - controllo browser della barra azioni.

Perche': la chat deve alimentare memoria e apprendimento senza automatismi
opachi. Salvare esplicitamente una risposta come candidate memory crea un ponte
controllato tra conversazione e Memory Core.

### Fase 27 - Azioni messaggio compatte, task e automazioni

- Rifinita la `message-action-bar`:
  - visibili solo azioni frequenti: `Rispondi`, `Copia`, `Continua`;
  - azioni operative dietro menu `...`;
  - feedback utile/non utile spostato nel menu;
  - i messaggi utente non mostrano azioni operative assistant-only.
- Aggiunte suggestions contestuali sotto l'ultima risposta assistant:
  - `Approfondisci`;
  - `Salva nota`;
  - `Crea task`;
  - `Crea automazione`.
- Aggiunto command Tauri `chat_message_create_task`:
  - crea task `chat_followup`;
  - input raw non salvato;
  - checkpoint redatto;
  - marca il messaggio con `linked_task_id`;
  - idempotente se il task e' gia' stato creato.
- Aggiunto command Tauri `chat_message_create_automation`:
  - crea `AutomationCandidateRecord` nel Memory Core;
  - evidence event redatto;
  - `privacy_domain = chat`;
  - `sensitivity = private`;
  - autonomia iniziale `1`, risk `low`;
  - marca il messaggio con `linked_automation_ref`;
  - idempotente se la proposta esiste gia'.
- Esteso il read model chat con:
  - `linked_task_id`;
  - `linked_automation_ref`.
- Test aggiunti:
  - creazione task da messaggio assistant;
  - creazione automation candidate da messaggio assistant;
  - idempotenza di entrambi.
- Verifiche:
  - test contratto prima fatto fallire su menu/task/automation/suggestions;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chat_message_create`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `npm run build`;
  - `git diff --check`;
  - controllo browser con menu `...` aperto.

Perche': la chat ora puo' trasformare una risposta in lavoro persistente senza
aprire subito orchestrazioni complesse. Il menu mantiene la risposta al centro,
mentre task e automazioni restano locali, redatti e tracciabili.

### Fase 28 - Test reale Gemma chat e diagnosi tempi

- Verificato runtime locale Gemma 4 MLX su `http://127.0.0.1:8765`.
- Stato iniziale osservato:
  - processo Python gia' in ascolto sulla porta `8765`;
  - `/health` raggiungibile;
  - modello inizialmente non caricato.
- Misure reali:
  - prima richiesta `/generate`: `TIME_TOTAL=11.879s`;
  - `load_seconds=8.947s`;
  - generazione effettiva prima richiesta: `elapsed_seconds=1.365s`;
  - seconda richiesta a modello caldo: `TIME_TOTAL=0.402s`,
    `elapsed_seconds=0.388s`;
  - streaming `/generate_stream`: `TIME_TOTAL=1.549s`,
    `elapsed_seconds=1.184s`.
- Conclusione tecnica:
  - Gemma non e' lento a modello caldo per prompt brevi;
  - la percezione di lentezza deriva soprattutto dal cold start e da come la UI
    comunica lo stato di caricamento;
  - la chat semplice usa gia' lo streaming dedicato, separato dal percorso
    Brain/planner.
- Verifica visuale:
  - preview web a `1440x900`;
  - risposta al centro;
  - composer fisso;
  - computer locale nascosto finche' non ci sono dettagli, approvazioni o task
    operativi visibili.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `cargo test --manifest-path crates/process-manager/Cargo.toml`.

Perche': prima di continuare con tool e orchestrazione era necessario separare
la lentezza reale del modello dalla UX. Il prossimo intervento deve rendere il
cold start esplicito: runtime che si avvia/precarica all'apertura, stato chiaro
"Gemma in caricamento", e primo token mostrato appena arriva.

### Fase 29 - Warmup runtime Gemma all'avvio Tauri

- Aggiunto endpoint locale `POST /warmup` nel runtime Gemma MLX.
- Il warmup carica il modello senza generare testo:
  - usa `GemmaRuntime.get_model()`;
  - restituisce `loaded`, `load_seconds`, `elapsed_seconds`, `model`,
    `local_first`;
  - rimane idempotente perche' `get_model()` carica una sola volta.
- Aggiunto contratto Rust `RuntimeWarmupResponse` in `crates/subagents`.
- Aggiunto `RuntimeClient::warmup()` verso `/warmup`.
- Aggiunto comando Tauri `runtime_warmup`.
- L'app React chiama `coreBridge.warmupRuntime("llm-gemma4-mlx")` solo quando
  gira dentro Tauri, non nella preview web.
- Durante il warmup la pill del runtime diventa:
  - `Gemma 4 MLX`;
  - stato `running`;
  - dettaglio `Caricamento modello locale in corso`.
- A warmup completato la pill torna `ready` e viene ricaricato il read model
  runtime.
- Verifiche:
  - test Python endpoint/runtime warmup;
  - test Rust runtime client;
  - test contratto UI per warmup;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path crates/subagents/Cargo.toml`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`.

Perche': la prima richiesta non deve sembrare una chat lenta. Il modello puo'
richiedere circa 9 secondi di cold start, quindi l'app deve pagare quel costo
all'apertura e renderlo leggibile come stato di runtime, non come blocco
inaspettato della conversazione.

### Fase 30 - Contesto conversazionale nella chat semplice

- Corretto un problema reale emerso in UI:
  - utente: `fammi un esempio di codice in rist`;
  - assistant chiedeva il linguaggio;
  - utente: `rust`;
  - assistant ripartiva da zero e chiedeva di nuovo cosa fare.
- Causa:
  - `submit_chat_prompt` passava al runtime solo l'ultimo messaggio;
  - Gemma non vedeva la conversazione precedente.
- Fix:
  - il core Tauri costruisce un `runtime_prompt` con gli ultimi messaggi
    utente/assistant della chat;
  - il contesto viene inviato solo al modello;
  - il read model continua a salvare come messaggio utente solo il testo pulito
    appena scritto, non il prompt contestualizzato.
- Rafforzato il prompt di sistema della chat:
  - se la richiesta e' chiara, risponde direttamente;
  - se l'utente chiede un esempio di codice e indica il linguaggio, fornisce
    direttamente un esempio breve e completo.
- Test aggiunto:
  - due turni `fammi un esempio di codice` -> `rust`;
  - il prompt runtime contiene contesto e nuovo messaggio;
  - la chat persistita contiene solo i messaggi utente puliti.
- Prova reale con Gemma caldo:
  - con contesto e `rust`, risposta ottenuta:
    `Ecco un esempio semplice in Rust:` seguito da blocco `rust`;
  - niente ulteriore domanda di chiarimento.

Perche': la chat deve comportarsi come una conversazione, non come singole
richieste isolate. Questo e' il prerequisito prima di rendere affidabili tool,
task e orchestrazione.

### Fase 31 - Rendering codice dedicato nella chat

- Corretto un problema UI emerso con una risposta reale:
  - Gemma ha prodotto `fn main() { println!("Hello, world!"); }` come testo
    semplice;
  - la chat lo mostrava come paragrafo, non come blocco codice.
- Rafforzato il prompt della chat:
  - quando include codice, deve usare sempre blocchi markdown fenced con
    linguaggio, per esempio `rust`.
- Rafforzato `RichMessage` lato frontend:
  - normalizza righe Rust stand-alone non fenced;
  - le trasforma in blocchi ```rust prima del rendering markdown;
  - i blocchi senza linguaggio ma multilinea diventano blocchi `text`, non
    inline code.
- Aggiornato il contratto UI per impedire regressioni sul rendering di codice
  non fenced.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_chat_prompt`.

Perche': una chat operativa deve trattare codice, markdown e diagrammi come
contenuti strutturati. Non possiamo dipendere solo dalla perfetta formattazione
del modello.

### Fase 32 - Code block completo e azioni contestuali per tipo risposta

- Corretto il caso in cui una `}` finale restava fuori dal blocco codice:
  - il normalizzatore ora riconosce anche continuazioni Rust come `}` e `};`;
  - la chiusura viene inclusa nello stesso blocco ```rust.
- Introdotta classificazione leggera del contenuto messaggio in UI:
  - `user`;
  - `system`;
  - `text`;
  - `code`;
  - `diagram`.
- La barra azioni non e' piu' identica per ogni risposta:
  - le risposte testuali mantengono `Continua`, task e automazioni;
  - le risposte codice non propongono subito `Crea task` o `Crea automazione`;
  - le risposte codice espongono suggerimenti dedicati:
    `Spiega codice`, `Migliora codice`, `Salva nota`.
- Aggiornato il contratto UI per bloccare regressioni su:
  - normalizzazione della chiusura Rust;
  - classificazione contenuto;
  - azioni contestuali codice.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_chat_prompt`.

Perche': l'utente deve vedere azioni coerenti con cio' che sta guardando. Una
risposta di codice deve privilegiare lettura, copia e iterazione sul codice, non
azioni operative generiche.

### Fase 33 - QA autonomo chat markdown e azioni contenuto

- Eseguiti test reali contro Gemma caldo su:
  - codice Rust;
  - tabella Markdown;
  - diagramma Mermaid.
- Risultati:
  - il codice Rust viene prodotto correttamente con blocco fenced `rust`;
  - le tabelle Markdown sono renderizzabili dal pipeline GFM;
  - Mermaid viene prodotto correttamente, ma risposte troppo lunghe possono
    arrivare incomplete se il limite token e' basso.
- Fix UI aggiuntivi:
  - i blocchi fenced senza linguaggio vengono normalizzati a `text`, quindi
    restano blocchi codice e non inline code;
  - le risposte diagramma hanno azioni contestuali dedicate:
    `Spiega diagramma`, `Modifica diagramma`, `Salva nota`;
  - le risposte incomplete mantengono affordance di continuazione tramite
    euristiche semplici:
    fence non chiusa, parentesi aperta finale, lista/heading troncata.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_chat_prompt`.

Perche': il centro dell'app e' la risposta. Il sistema deve capire quando sta
mostrando testo, codice o diagrammi e proporre solo azioni coerenti con quel
contenuto.

### Fase 34 - Metriche token nella chat e rilevamento troncamenti

- Propagate le metriche reali di generazione dal runtime Gemma fino alla UI:
  - `prompt_tokens`;
  - `generation_tokens`;
  - `prompt_tps`;
  - `generation_tps`;
  - `elapsed_seconds`;
  - `max_tokens`.
- Aggiornato il core Tauri:
  - le risposte chat ora trasportano testo + metriche;
  - i messaggi assistant salvati nello stato mantengono le metriche;
  - lo streaming mantiene le metriche anche dopo il messaggio finale.
- Aggiornato il frontend:
  - `ChatMessage` espone le metriche;
  - il pulsante `Continua` viene mostrato quando la risposta arriva vicina al
    limite token, oltre alle euristiche su markdown incompleto.
- Aggiornato il contratto UI per bloccare regressioni su `maxTokens` e sul
  rilevamento `generationTokens >= maxTokens`.
- Verifiche:
  - `cargo fmt`;
  - `npm run build`;
  - `git diff --check`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_chat_prompt`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime_snapshot_lists_default_sidecars_without_env`;
  - `npm run typecheck`;
  - `npm run test:ui-contract`.

Perche': il limite token e' del runtime/inferenza, non della UI. Senza metriche
non possiamo distinguere una risposta breve da una risposta tagliata, quindi
l'utente non capisce quando deve continuare la generazione.

### Fase 35 - Continuazione pulita della chat Gemma

- Separato il prompt usato dal runtime dal testo visibile nello storico chat:
  - la UI puo' inviare un'istruzione tecnica breve a Gemma;
  - il core Tauri salva solo il testo visibile scelto per l'utente.
- `Continua` ora usa un prompt runtime esplicito:
  - continua dal punto interrotto;
  - non ripete parti gia' scritte;
  - mantiene lingua e formato.
- `Continua` non viene piu' mostrato su ogni risposta testuale:
  - appare quando la risposta sembra incompleta;
  - le risposte complete mantengono l'azione piu' corretta `Approfondisci`.
- Aggiunto un avviso leggero e non tecnico quando la risposta sembra troncata.
- Aggiunto test core per garantire che:
  - il runtime riceve il prompt tecnico;
  - la conversazione persistita mostra solo `Continua`;
  - il prompt tecnico non sporca la cronologia visibile.
- Verifiche:
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_chat_prompt_can_use_hidden_runtime_prompt_and_store_visible_text`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_chat_prompt`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `cargo fmt`;
  - `npm run build`.

Perche': la chat deve restare leggibile. Le istruzioni operative servono al
modello, ma non devono comparire come messaggi utente nello storico, altrimenti
l'esperienza diventa confusa e poco naturale.

### Fase 36 - QA reale chat Gemma e prompt base ottimizzato

- Eseguita una suite reale contro il runtime Gemma locale su:
  - ora corrente;
  - calcolo semplice;
  - codice Rust;
  - tabella Markdown;
  - diagramma Mermaid;
  - risposta lunga;
  - follow-up in inglese;
  - continuazione.
- Problemi trovati:
  - `che ore sono?` non poteva funzionare bene senza data/ora locale nel prompt;
  - `quanto fa 6*3?` ha risposto `24` con il prompt precedente;
  - le risposte lunghe arrivano correttamente a `max_tokens`, quindi il rilevamento
    di troncamento e `Continua` e' necessario.
- Fix applicato:
  - il prompt base della chat include ora la data/ora locale corrente;
  - il prompt base contiene una regola breve per aritmetica semplice;
  - la temperatura chat e' stata portata a `0.0` per ridurre risposte casuali;
  - il prompt e' stato compattato per ridurre latenza sui prompt semplici.
- Misure indicative dopo il fix:
  - `che ore sono?`: circa 1.7s, risposta corretta dal contesto temporale;
  - `quanto fa 6*3?`: circa 0.8s, risposta `18`;
  - codice Rust: circa 2.6s, blocco fenced `rust` corretto.
- Aggiornato `time` con feature `local-offset` nel runtime Tauri per esporre
  l'ora locale, non solo UTC.
- Verifiche:
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chat_prompt_includes_local_time_and_arithmetic_guidance`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_chat_prompt`;
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `cargo fmt`;
  - `npm run build`.

Perche': prima di riattaccare Brain/tool/browser serve una chat Gemma base
credibile. Le richieste semplici devono sembrare immediate e corrette, non task
macchinosi.

### Fase 37 - Context budget e compressione locale del prompt chat

- Analizzato il pattern OpenHuman/TokenJuice come riferimento, senza copiarne
  lo stack.
- Aggiunto crate `crates/context-compression` con contratti locali:
  - `ContextKind`;
  - `ContextItem`;
  - `CompressionPolicy`;
  - `ContextCompressor`;
  - metriche `input_chars`, `output_chars`, token stimati, ratio e redaction.
- Il compressore ora copre:
  - output shell, preservando errori/fallimenti/tail e deduplicando righe rumorose;
  - testo browser, preservando titolo/URL puliti e risultati utili;
  - cronologia chat, comprimendo contesto vecchio e mantenendo gli ultimi turni;
  - JSON tool output, con redaction ricorsiva di chiavi sensibili.
- La redaction avviene prima della compressione e rimuove email, token, API key,
  password e query string sensibili.
- Collegato il compressore al prompt builder della chat Tauri:
  - la cronologia recente non viene piu' inviata grezza quando supera il budget;
  - i dettagli vecchi e lunghi vengono collassati;
  - l'ultimo scambio utile resta disponibile a Gemma.
- Aggiunto test core per garantire che una conversazione lunga venga compressa
  prima del runtime senza sporcare lo storico visibile.
- Verifiche:
  - `cargo test -p local-first-context-compression`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_chat_prompt`.

Perche': una chat locale con Gemma deve restare veloce e coerente anche dopo
molti messaggi. Il contesto non puo' crescere senza controllo, e tool/browser
devono poter passare solo risultati sintetizzati, redatti e utili.

### Fase 38 - Context budget su Computer locale e audit tool

- Esteso l'uso di `crates/context-compression` oltre la chat:
  - `local-computer-session` comprime ora l'excerpt terminale del read model;
  - `capabilities` comprime i risultati tool grandi salvati nell'audit.
- Il Computer locale non espone piu' solo le ultime righe terminale:
  - preserva errori e fallimenti importanti;
  - deduplica righe rumorose;
  - mantiene marker `context compressed`;
  - redige token/API key anche dopo compressione.
- L'audit dei tool/connettori mantiene invariati i risultati piccoli.
- Per output grandi, l'audit salva un payload `compressed=true` con testo
  redatto e metriche di compressione, senza cambiare il risultato restituito al
  caller.
- Aggiunti test dedicati:
  - terminal excerpt lungo con failure e segreti;
  - audit tool grande con token sensibile.
- Verifiche:
  - `cargo test -p local-first-local-computer-session read_model`;
  - `cargo test -p local-first-capabilities facade`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml local_computer_snapshot_is_redacted_for_ui`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml local_computer_smoke_test_records_real_shell_output`.

Perche': quando browser, shell, MCP e connettori produrranno output reali, non
possiamo far crescere audit, prompt e UI con payload grezzi. La compressione
deve stare nei boundary locali, non solo nella chat.

### Fase 39 - Context budget nel Brain orchestrator

- Collegato `crates/context-compression` anche al crate `orchestrator`.
- Il prompt del planner Brain ora comprime e redige prima di chiamare Gemma:
  - conversation summary;
  - memory context;
  - tool catalog compact cards;
  - loaded tool details.
- Aggiunti budget configurabili in `OrchestratorBudgets`:
  - `max_conversation_summary_chars`;
  - `max_memory_context_chars`;
  - `max_tool_cards_context_chars`;
  - `max_loaded_tool_context_chars`.
- I default mantengono prompt piccoli, ma ora possono essere tarati dal runtime
  o dalla UI senza modificare il builder.
- Aggiunto test end-to-end sul Brain:
  - contesto memoria/tool molto lungo;
  - token e email sensibili;
  - verifica che il prompt al runtime contenga `context compressed`;
  - verifica che non passino segreti grezzi.
- Verifiche:
  - `cargo test -p local-first-orchestrator`.

Perche': il Brain e' il punto piu' delicato per costo token e qualita' della
decisione. Deve vedere contesto utile e compatto, non payload lunghi o dati
sensibili provenienti da memoria, tool registry o connettori.

### Fase 40 - Osservabilita' del context budget

- Aggiunto `ContextBudgetUsage` nel contratto orchestrator.
- L'audit runtime del Brain espone ora, senza payload raw:
  - label del contesto;
  - kind compresso;
  - input/output chars;
  - token stimati prima/dopo;
  - ratio di compressione;
  - numero di redazioni;
  - flag compressed/redacted.
- Il planner prompt continua a ricevere solo testo compresso/redatto, ma le
  metriche vengono propagate in `OrchestratorAudit`.
- `OrchestratorAuditStore` persiste `context_budget_json` con migrazione
  idempotente per database gia' esistenti.
- `OrchestratorRunDetail` espone il budget alla UI senza includere testo del
  contesto o output tool raw.
- Redatta anche la descrizione dei tool nel read model audit, per evitare che
  segreti accidentali nei metadata dei provider arrivino alla UI.
- La UI Brain Audit mostra un riepilogo leggero:
  - quanti contesti sono stati compressi;
  - token stimati prima/dopo;
  - numero di redazioni;
  - ratio sintetica nel pannello statistiche.
- Verifiche:
  - `cargo test -p local-first-orchestrator`;
  - `npm run typecheck`;
  - `npm run test:ui-contract`.

Perche': comprimere senza osservabilita' rende difficile capire se Gemma riceve
troppo poco, troppo rumore o dati sensibili. Le metriche permettono debug e UX
trasparente senza esporre payload raw.

### Fase 41 - Lazy rich rendering della chat

- Separato il rendering avanzato dei messaggi chat:
  - `RichMessage.tsx` ora e' una shell leggera;
  - `RichMessageRenderer.tsx` contiene markdown, codice, GFM, sanitize e
    Mermaid.
- Il renderer pesante viene caricato con `React.lazy` solo quando il messaggio
  contiene markdown, codice, tabelle, link markdown o pattern simili.
- I messaggi di testo semplice restano renderizzati senza caricare
  `react-markdown`, `remark-gfm`, `rehype-sanitize` o Mermaid.
- Aggiunto fallback semplice per evitare flash vuoti durante il caricamento del
  renderer avanzato.
- Aggiornato `vite.config.ts` con `manualChunks` per separare il blocco markdown
  dal chunk principale.
- Risultato build:
  - chunk iniziale app circa 281 kB minificati;
  - markdown circa 170 kB in chunk separato;
  - Mermaid resta lazy e granulare per diagrammi.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - verifica browser a 1440x900 su `http://127.0.0.1:1420/`.

Perche': la chat deve poter gestire markdown, codice e diagrammi, ma una
risposta testuale semplice non deve pagare il costo dei renderer complessi.
Questo mantiene l'esperienza piu' reattiva senza rinunciare alla ricchezza dei
messaggi quando serve.

### Fase 42 - Metriche di latenza per messaggio chat

- Esteso `PromptMessageMetrics` con metriche operative opzionali:
  - `prompt_build_seconds`;
  - `time_to_first_token_seconds`;
  - `total_elapsed_seconds`;
  - `runtime_status_before`.
- Il core Tauri misura ora il percorso reale del submit chat:
  - tempo di preparazione prompt/contesto;
  - stato runtime Gemma prima della richiesta;
  - tempo fino al primo delta streaming;
  - tempo totale del roundtrip.
- Le metriche vengono salvate nel read model chat insieme al messaggio
  assistant, quindi restano disponibili dopo refresh o riapertura.
- La UI espone le prestazioni nel menu compatto del messaggio, non nel corpo
  della risposta:
  - la risposta rimane il focus;
  - i dettagli sono disponibili quando serve debug;
  - il menu mostra "Tempo al primo token", "Generazione", "Totale",
    "Prompt build" e "Runtime prima".
- Aggiornati bridge TypeScript e mapping UI per mantenere il contratto coerente.
- Verifiche:
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`.

Perche': prima vedevamo solo lentezza percepita. Ora possiamo distinguere se il
problema e' avvio/runtime Gemma, costruzione prompt, attesa del primo token,
generazione o rendering UI. Questo e' necessario prima di ottimizzare ancora.

### Fase 43 - Probe ripetibile della latenza chat Gemma

- Aggiunto `scripts/chat_latency_probe.py`.
- Il probe chiama il runtime locale `/generate_stream` e misura:
  - stato runtime prima del test;
  - tempo al primo token;
  - tempo totale;
  - metriche runtime Gemma;
  - preview redatta dell'output.
- Aggiunto target `make chat-latency`.
- Aggiunto `--repeat` per misurare piu' run in ordine stabile.
- Il report viene scritto in JSONL:
  - `reports/chat_latency_probe.jsonl`;
  - `reports/chat_latency_probe_repeat.jsonl` per run ripetuti.
- Aggiornato `make test-python` per eseguire tutti i test Python via discovery.
- Risultati reali con runtime gia' carico:
  - primo run: media primo token 1,809s, media totale 3,752s;
  - repeat 2x: media primo token 0,236s, media totale 2,183s;
  - prompt brevi: circa 0,54-0,66s totali;
  - codice breve: circa 5,3s perche' arriva al limite `max_tokens=160`;
  - throughput generazione stabile intorno a 30-34 token/s.
- Verifiche:
  - `.venv-mlx/bin/python -m unittest tests/test_chat_latency_probe.py`;
  - `.venv-mlx/bin/python scripts/chat_latency_probe.py --repeat 2 --out reports/chat_latency_probe_repeat.jsonl`.

Perche': ora abbiamo un benchmark leggero e ripetibile per distinguere lentezza
percepita, spike isolati, runtime caldo/freddo e risposte semplicemente troppo
lunghe. Il dato suggerisce che, con Gemma gia' carico, il collo di bottiglia
principale non e' il primo token ma il numero di token generati.

### Fase 44 - Budget compatto per la prima risposta chat

- Ridotto il budget token della chat diretta da 768 a 320 token.
- Aggiornato il prompt runtime della chat:
  - prima risposta compatta;
  - 1-4 paragrafi brevi o blocco codice essenziale;
  - risposte lunghe complete ma continuabili.
- Non e' stato aggiunto routing a regex o intent euristico: il limite e'
  conservativo e uniforme per la prima risposta.
- Il flusso "Continua" gia' presente resta il modo esplicito per estendere una
  risposta lunga o troncata.
- Aggiunto test sul responder chat per verificare che il runtime riceva davvero
  il budget compatto.
- Verifiche:
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime_chat_responder_uses_compact_default_token_budget`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `cargo fmt`.

Perche': i benchmark hanno mostrato primo token veloce con runtime caldo, ma
latenza totale proporzionale ai token generati. Limitare la prima risposta rende
la chat piu' reattiva e lascia all'utente il controllo dell'approfondimento.

### Fase 45 - Riavvio Tauri e verifica post-budget

- Riavviata l'app Tauri per caricare il backend Rust aggiornato: il limite
  `CHAT_MAX_TOKENS=320` non puo' essere applicato solo con HMR React.
- Stato dopo riavvio:
  - Vite attivo su `127.0.0.1:1420`;
  - app `target/debug/local-first-desktop` attiva;
  - runtime Gemma MLX attivo e gia' `loaded` su `127.0.0.1:8765`.
- Verificata la UI web a 1440x900:
  - nessun errore console;
  - sidebar, thread e composer dentro viewport;
  - composer ancorato e utilizzabile.
- Eseguito probe runtime dopo l'ottimizzazione:
  - `reports/chat_latency_probe_after_320.jsonl`;
  - repeat 2x, 6 richieste;
  - media primo token 0,313s;
  - media totale 2,220s;
  - prompt brevi intorno a 0,58-1,14s;
  - caso codice ancora circa 5,2s perche' il probe diretto usa
    `max_tokens=160`.

Nota: il probe misura il runtime `/generate_stream` diretto, mentre il limite
320 e' applicato nel percorso Tauri chat. Il test prodotto finale va quindi
fatto dalla finestra Tauri aperta, usando il menu Prestazioni sui messaggi per
leggere `time_to_first_token`, totale e stato runtime.

### Fase 46 - Stabilizzazione chat in anteprima web

- Corretto il percorso di streaming quando la UI viene aperta nel browser
  Vite (`http://127.0.0.1:1420`) invece che nella webview Tauri:
  - la UI non chiama piu' `@tauri-apps/api/event.listen` se mancano gli
    internals Tauri;
  - l'anteprima web usa un listener locale e chiama direttamente il runtime
    Gemma su `127.0.0.1:8765`;
  - le richieste restano local-first e non usano API cloud.
- Aggiunto CORS solo per origini locali del dev preview:
  - `http://127.0.0.1:1420`;
  - `http://localhost:1420`;
  - `tauri://localhost`.
- Reso diagnostico-only il refresh dei read model dopo una risposta chat:
  se il refresh Tauri non e' disponibile in browser preview, la risposta gia'
  ottenuta da Gemma resta visibile e non viene sostituita da un messaggio di
  errore di sistema.
- Verifica reale effettuata nel browser locale con prompt `quanto fa 6*3`:
  - risposta: `6 moltiplicato per 3 fa 18.`;
  - nessun `transformCallback`;
  - nessun `Cannot read properties`;
  - nessun `Failed to fetch`.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `.venv-mlx/bin/python -m unittest tests.test_mlx_gemma4_server.MlxGemma4ServerTests.test_app_allows_localhost_browser_preview_cors tests.test_chat_latency_probe`.

Perche': durante i test rapidi il browser preview deve comportarsi in modo
abbastanza fedele alla app Tauri. Il bug non era nella comprensione di Gemma,
ma nel ponte UI/runtime quando mancavano gli internals Tauri.

### Fase 47 - Popover prestazioni sopra il composer

- Corretto il menu contestuale dei messaggi quando si aprono le metriche
  "Prestazioni" vicino al composer.
- Il menu ora calcola lo spazio disponibile rispetto all'area scroll della chat,
  non solo rispetto al viewport:
  - apre verso il basso quando c'e' spazio;
  - apre verso l'alto quando rischia di finire sotto il composer o fuori
    dall'area visibile;
  - si aggiorna su resize e scroll.
- Aumentato lo `z-index` del popover e aggiunto un limite di altezza solo come
  fallback, senza rendere il menu pesante.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`.

Perche': le metriche devono essere consultabili senza costringere l'utente a
scrollare o perdere il contesto della risposta.

### Fase 48 - Azioni messaggio solo contestuali

- Rimossa la riga sempre visibile di suggerimenti sotto l'ultima risposta
  (`Approfondisci`, `Salva nota`, `Crea task`, `Crea automazione`).
- La action bar del messaggio resta leggera e compare solo su hover/focus:
  - `Rispondi`;
  - `Copia`;
  - menu `...` quando il messaggio ha azioni operative.
- Le azioni operative ora vivono solo nel menu compatto:
  - testo: `Approfondisci`, `Salva in memoria`, `Crea task`,
    `Crea automazione`, feedback e metriche;
  - codice: `Spiega codice`, `Migliora codice`, memoria, feedback e metriche;
  - diagrammi: `Spiega diagramma`, `Modifica diagramma`, memoria, feedback e
    metriche;
  - risposte incomplete: `Continua` appare nel menu al posto di
    `Approfondisci`.
- Rimosse le classi CSS della riga contestuale non piu' usata.
- Aggiunti contratti UI per impedire il ritorno della duplicazione.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `cargo test --workspace`;
  - `make test-python`;
  - verifica browser su `http://127.0.0.1:1420/`: nessuna
    `.contextual-suggestion-row`, azioni operative presenti solo nel menu.

Perche': la risposta deve restare il centro visivo della chat. Le azioni sono
necessarie, ma devono essere accessibili senza trasformare ogni messaggio in una
toolbar permanente.

### Fase 49 - Feedback immediato dopo Invio

- Aggiunto uno stato visibile nel thread appena l'utente invia un prompt.
- La chat ora mostra una card leggera con indicatore animato e stato:
  - `Prompt ricevuto`;
  - `Gemma sta pensando`;
  - `Gemma sta scrivendo` appena arriva il primo token.
- Lo stato vive dentro la conversazione, non solo nel composer, cosi' l'utente
  vede subito che Invio o il pulsante di invio sono stati presi in carico.
- Lo stato sparisce quando arriva la risposta finale o quando la generazione
  viene interrotta.
- Aggiunti contratti UI per mantenere:
  - `streamStatus`;
  - componente `AssistantThinkingState`;
  - stile dedicato `.assistant-thinking-state`.
- Verifica browser reale su `http://127.0.0.1:1420/`:
  - dopo 250 ms dal submit appare `Gemma sta pensando`;
  - a risposta completata lo stato sparisce e resta solo il messaggio finale.
- Correzione specifica per Tauri:
  - prima di invocare il runtime via IPC, la UI attende due frame di rendering
    con `waitForAssistantStatusPaint`;
  - questo evita che la webview sembri ferma mentre l'IPC locale parte subito;
  - Tauri/Vite sono stati riavviati dopo la modifica.
- Rafforzamento successivo dopo test Tauri:
  - aggiunto `ComposerSubmitStatus`, un banner ancorato dentro il composer;
  - aggiunto stato locale `handoffPending` che si attiva nel momento esatto in
    cui l'utente preme Invio, prima che il parent o Tauri rispondano;
  - il banner viene sostituito dallo stato runtime reale quando `streamStatus`
    arriva, poi sparisce a risposta conclusa;
  - verifica browser: entro 100 ms dal submit sono visibili sia lo stato nel
    composer sia lo stato nel thread.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `cargo test --workspace`;
  - `make test-python`.

Perche': una chat che resta ferma dopo Invio sembra bloccata anche quando il
runtime sta lavorando. Il feedback immediato rende il sistema percepibile e
riduce l'incertezza senza aggiungere rumore permanente.

### Fase 50 - Streaming Tauri non bloccante

- Analizzato il problema di UX Tauri: non era principalmente un problema di
  rendering WKWebView, ma il fatto che la generazione Gemma passava dentro un
  command Tauri sincrono.
- Rifatto il bridge nativo:
  - nuovo command `submit_chat_prompt_stream_start`;
  - il command valida e ritorna subito;
  - la generazione viene eseguita in background con
    `tauri::async_runtime::spawn_blocking`;
  - i token continuano ad arrivare con `chat_stream_delta`;
  - il risultato finale arriva con `chat_stream_done`;
  - gli errori arrivano con `chat_stream_error`.
- Il bridge TypeScript mantiene l'API `submitChatPromptStream`, ma internamente
  registra gli eventi `done/error`, avvia il job Tauri e risolve la Promise solo
  quando arriva l'evento finale.
- Rimossi i workaround visuali che peggioravano l'esperienza:
  - `waitForAssistantStatusPaint`;
  - `handoffPending`;
  - `ComposerSubmitStatus`;
  - CSS `.composer-submit-status`.
- Lo stato di attesa resta solo nel thread, tramite `AssistantThinkingState`,
  cosi' la risposta resta il centro dell'esperienza.
- Aggiornato il contratto UI per impedire regressioni verso command bloccanti o
  banner duplicati nel composer.
- Riavviato Tauri dopo la modifica.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `cargo test --workspace`;
  - `make test-python`;
  - `git diff --check`;
  - verifica browser su `http://127.0.0.1:1420/`: nessun
    `.composer-submit-status`, console senza errori.

Perche': il fix corretto e' architetturale. Il frontend non deve aspettare una
chiamata IPC lunga per poter comunicare che l'assistente sta lavorando; Tauri
deve solo avviare il job e poi streammare eventi.

### Fase 51 - Fluidita' streaming in WKWebView

- Dopo test utente, il flusso Tauri non risultava ancora fluido.
- Misurato il runtime Gemma diretto con `scripts/chat_latency_probe.py`:
  - 6 casi;
  - primo token medio 0.23s;
  - totale medio 2.18s;
  - runtime gia' `loaded`.
- Conclusione: il collo non era Gemma, ma il rendering/event-loop della UI.
- Correzioni:
  - durante lo streaming `RichMessage` bypassa sempre il renderer markdown e
    usa testo leggero;
  - il renderer markdown/diagrammi/codice viene usato solo dopo la risposta
    finale;
  - i delta di streaming vengono bufferizzati con `requestAnimationFrame`, cosi'
    React non ridisegna la chat per ogni micro-delta;
  - il frame pendente viene cancellato su stop, errore e finalizzazione.
- Aggiornato il contratto UI per mantenere:
  - bypass rich rendering durante streaming;
  - `scheduleStreamRender`;
  - cancellazione con `cancelAnimationFrame`.
- Riavviato Tauri dopo la modifica.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `git diff --check`;
  - probe runtime: `reports/chat_latency_probe_latest.jsonl`.

Perche': una chat deve dare la percezione di scrittura progressiva. Markdown,
code block e diagrammi sono necessari, ma vanno applicati dopo la generazione,
non su ogni token in arrivo.

### Fase 52 - Streaming locale alla chat

- Dopo ulteriore test utente, la chat risultava ancora poco fluida.
- Individuato un secondo collo di bottiglia frontend:
  - ogni delta aggiornava lo stato globale `App.tsx`;
  - questo faceva aggiornare anche preview thread/sidebar;
  - lo scroll lanciava animazioni `smooth` ripetute durante la generazione.
- Correzioni:
  - introdotto `optimisticMessages` locale in `ChatView`;
  - durante lo streaming i delta aggiornano solo la vista chat locale;
  - `App.tsx` viene aggiornato solo a cancellazione, errore o risposta finale;
  - lo scroll durante lo streaming usa `auto`, non `smooth`;
  - le animazioni smooth restano solo per cambi non-streaming.
- Aggiornato il contratto UI per impedire regressioni:
  - streaming locale alla chat;
  - buffering frame;
  - niente smooth scroll ripetuto durante streaming.
- Riavviato Tauri dopo la modifica.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_chat_prompt_stream -- --nocapture`;
  - `git diff --check`.

Perche': il rendering progressivo deve essere isolato dal resto della shell.
La sidebar, le preview delle chat e i read model non devono ridisegnarsi su ogni
token.

### Fase 53 - Typewriter buffer per percezione fluida

- Dopo test utente, lo streaming era migliorato ma ancora non abbastanza
  fluido.
- Correzione:
  - il testo in arrivo dal runtime resta in un buffer interno;
  - `streamDisplayText` e' separato dall'array dei messaggi;
  - la UI mostra il testo con un cadence esplicito
    `STREAM_TYPEWRITER_INTERVAL_MS`;
  - ogni tick mostra una porzione controllata di caratteri invece di seguire
    fedelmente i chunk grezzi del runtime;
  - il typewriter e' cancellabile con `cancelTypewriterRender`.
- Il messaggio streammato resta stabile nella lista; cambia solo il testo
  visibile. Questo riduce jitter da chunk irregolari e da riconciliazione React.
- Aggiornato il contratto UI per mantenere:
  - `streamDisplayText`;
  - `scheduleTypewriterRender`;
  - `cancelTypewriterRender`;
  - costanti di cadence esplicite.
- Riavviato Tauri dopo la modifica.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_chat_prompt_stream -- --nocapture`;
  - `git diff --check`.

Perche': i delta del modello non arrivano con ritmo visivamente uniforme.
Decouplare ricezione e visualizzazione rende la chat piu' simile a un prodotto
maturo: stabile, prevedibile, senza salti.

### Fase 54 - Nessun dump finale sopra il typewriter

- Test utente: la risposta iniziava bene, poi si fermava e infine appariva tutta
  insieme.
- Root cause trovata in `ChatView`:
  - alla fine dello stream veniva chiamato
    `setStreamDisplayText(result.assistant_message.text || streamedText)`;
  - questo bypassava il typewriter e scaricava il testo finale in un colpo.
- Correzione:
  - aggiunto `waitForTypewriterDrain`;
  - quando arriva il risultato finale, il testo finale viene messo nel buffer
    `streamedText`;
  - la risposta viene committata nei messaggi finali solo dopo che il typewriter
    ha mostrato tutto il buffer;
  - il contratto UI vieta esplicitamente il dump finale diretto.
- Riavviato Tauri dopo la modifica.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_chat_prompt_stream -- --nocapture`;
  - `git diff --check`.

Perche': la percezione di fluidita' si rompe se il modello conclude prima della
UI e il messaggio finale sostituisce il buffer. Il commit finale deve attendere
la visualizzazione progressiva.

### Fase 55 - Cadence typewriter bounded

- Test utente: il flusso era quasi corretto, ma restava una piccola latenza a
  meta' risposta.
- Root cause probabile:
  - il typewriter drenava percentuali grandi del backlog;
  - raggiungeva il buffer troppo presto;
  - poi attendeva il prossimo chunk creando una micro-pausa visibile.
- Correzione:
  - rimosso il drain percentuale `Math.ceil(remaining * 0.34)`;
  - aggiunto `typewriterSliceSize`;
  - slice bounded: 2, 4, 6 o 8 caratteri in base al backlog;
  - `STREAM_TYPEWRITER_MAX_CHARS` ridotto da 28 a 8.
- Aggiornato il contratto UI per impedire il ritorno a burst percentuali.
- Riavviato Tauri dopo la modifica.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_chat_prompt_stream -- --nocapture`;
  - `git diff --check`.

Perche': per sembrare fluida, la chat deve scrivere con ritmo regolare, non
correre sul backlog e poi fermarsi in attesa del modello.

### Fase 56 - Decisione Desktop Chat HTTP Gateway

- Dopo i test Tauri, la direzione di micro-ottimizzare ancora lo streaming via
  `invoke` e' stata fermata.
- Decisione fissata:
  - la chat deve passare da un gateway HTTP Rust locale;
  - il gateway espone API prodotto su `127.0.0.1`;
  - la UI usa `fetch` e stream browser NDJSON/SSE;
  - `invoke` Tauri resta solo per funzioni native discrete;
  - Gemma Python/MLX resta locale e viene chiamato dietro al Rust Core;
  - token locale, CORS stretto, bind loopback e read model redatti sono
    requisiti obbligatori.
- Creata ADR `docs/decisions/0004-desktop-chat-http-gateway.md`.
- Aggiornati:
  - `PROJECT.md`;
  - `docs/architecture/system-map.md`;
  - `docs/architecture/final-roadmap.md`.

Perche': la chat e' il prodotto percepito. Se lo streaming dipende da Tauri IPC
e da workaround React/typewriter, l'esperienza resta fragile e a scatti. Un
gateway HTTP locale usa il trasporto naturale della WebView, rende la UI
testabile anche in browser e prepara artifact, preview e payload grandi senza
serializzarli dentro `invoke`.

### Fase 57 - Primo slice Desktop Chat HTTP Gateway

- Implementato `apps/desktop/src-tauri/src/gateway.rs`.
- Il gateway:
  - si avvia dentro Tauri;
  - usa un runtime Tokio dedicato in un thread `desktop-chat-gateway`, per non
    dipendere dal reactor durante `setup`;
  - fa bind solo su `127.0.0.1` con porta dinamica;
  - genera un token locale per sessione app;
  - applica CORS ristretto a origini locali/Tauri;
  - espone `GET /api/health`;
  - espone thread/messages endpoints;
  - espone `POST /api/chat/threads/{thread_id}/messages/stream`;
  - espone `POST /api/chat/streams/{request_id}/cancel`.
- Aggiunto command bootstrap `desktop_gateway_config` per passare alla UI solo
  `base_url` e token del gateway.
- Aggiunto `apps/desktop/src/lib/chatApi.ts`.
- `coreBridge.submitChatPromptStream` ora delega a `chatApi` quando gira in
  Tauri:
  - invio prompt via `fetch`;
  - lettura stream NDJSON con `ReadableStreamDefaultReader`;
  - delta propagati ai listener locali;
  - done restituisce il `PromptSubmissionResult` esistente;
  - cancel passa dal gateway HTTP.
- Il fallback browser preview verso Gemma diretto resta solo quando mancano gli
  internals Tauri.
- I vecchi command/event Tauri per chat streaming restano nel core come percorso
  transitorio finche' il gateway non viene verificato in Tauri reale e ripulito.
- Verifiche:
  - RED iniziale: `npm run test:ui-contract` falliva per assenza di
    `src/lib/chatApi.ts`;
  - `npm run test:ui-contract`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml gateway -- --nocapture`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -- --test-threads=1`.
- Verifica runtime manuale:
  - Tauri dev riavviato;
  - processo `local-first-desktop` in ascolto su loopback con porta dinamica;
  - `GET /api/health` senza token risponde `401 unauthorized`, confermando che
    il gateway non e' aperto senza bootstrap locale.

Nota: la suite Rust Tauri parallela ha mostrato una flake preesistente su un
test prompt-plan approval; lo stesso test passa isolato e la suite passa con
`--test-threads=1`.

Perche': questo applica la decisione di non usare piu' `invoke`/event IPC come
trasporto primario della chat. La webview ora usa il canale naturale del browser
per lo stream, mentre Rust Core continua a possedere stato, policy, metriche e
runtime locale.

### Fase 58 - Chat API completa su gateway locale

- Spostate sul gateway HTTP locale anche le operazioni chat non-stream:
  - lista thread;
  - creazione thread;
  - selezione thread;
  - pin/unpin;
  - archive/unarchive;
  - delete;
  - snapshot messaggi;
  - feedback messaggio;
  - save-to-memory;
  - create-task;
  - create-automation.
- Esteso `apps/desktop/src-tauri/src/gateway.rs`:
  - `PATCH /api/chat/threads/{thread_id}` ora gestisce `selected`, `pinned` e
    `status`;
  - `DELETE /api/chat/threads/{thread_id}`;
  - `POST /api/chat/messages/{message_id}/create-automation`.
- Esteso `apps/desktop/src/lib/chatApi.ts` con i metodi thread/action.
- `coreBridge` ora delega la chat a `chatApi` invece di usare `invoke`.
- Rimossi dalla registrazione Tauri i command legacy chat/thread/stream:
  - thread snapshot;
  - message snapshot;
  - message actions;
  - thread actions;
  - submit chat prompt non-stream;
  - stream start/event path.
- Rimosso dal Core il command/event path `chat_stream_delta/done/error`.
- Soppressi gli warning dev del vecchio percorso non-stream usato solo dai test,
  cosi' il rebuild Tauri resta leggibile.
- Verifiche:
  - RED iniziale: `npm run test:ui-contract` falliva finche' `coreBridge` non
    usava `chatApi.chatMessages`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml gateway -- --nocapture`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -- --test-threads=1`;
  - `git diff --check`.
- Tauri dev riavviato con successo dopo la migrazione; il gateway e' in ascolto
  su loopback con porta dinamica e senza token risponde `401 unauthorized`.

Perche': fermarsi allo stream non bastava. Se thread e azioni messaggio
restavano su `invoke`, la chat avrebbe continuato ad avere due canali con due
semantiche diverse. Ora il boundary chat e' unico: HTTP locale per la superficie
chat, `invoke` solo per funzioni native e moduli non ancora migrati.

### Fase 59 - Output lunghi, scroll streaming e continuazione automatica

- Analizzato il problema emerso con prompt tipo:
  `scrivimi un esempio di codice Rust di 200 righe`.
- Root cause:
  - lo scroll seguiva soprattutto l'array di messaggi, ma durante lo streaming
    cambia un buffer separato `streamDisplayText`;
  - il budget chat era ancora troppo basso per output lunghi/codice;
  - la continuazione era una normale azione manuale, quindi creava una nuova
    mini-conversazione invece di completare lo stesso risultato.
- Aggiornato il runtime chat:
  - budget default chat portato a 768 token;
  - budget esteso per codice/output lunghi;
  - budget massimo 4096 token per richieste esplicite di codice lungo;
  - timeout esteso per risposte lunghe.
- Aggiunto endpoint HTTP locale:
  - `POST /api/chat/messages/{message_id}/continue/stream`;
  - usa lo stesso canale NDJSON/fetch;
  - appende la continuazione allo stesso messaggio assistant nel read model;
  - non aggiunge un messaggio utente "Continua".
- Aggiornati frontend e bridge:
  - `chatApi.continueChatMessageStream`;
  - `coreBridge.continueChatMessageStream`;
  - auto-continua fino a 2 volte se le metriche indicano truncation;
  - stato visibile `auto-continue-status` nel messaggio;
  - fallback manuale `Continua` visibile fuori dal menu a tre puntini;
  - scroll agganciato anche a `streamDisplayText`.
- Aggiunti test/contratti:
  - UI contract per scroll buffer, auto-continue, fallback visibile e gateway
    continuation;
  - test Rust per budget lungo codice;
  - test Rust per append continuation nello stesso messaggio.
- Verifiche eseguite:
  - RED: `npm run test:ui-contract` falliva su `scrollToLatestMessage`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml continue_chat_message_stream_appends_to_existing_assistant_message -- --test-threads=1`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -- --test-threads=1`.

Perche': per una chat usabile la risposta deve restare il centro
dell'esperienza. Se il modello arriva al limite token, il sistema deve
continuare in modo leggibile e nello stesso risultato, non scaricare sul
utente una sequenza di azioni "Continua" poco evidenti.

### Fase 60 - Streaming lungo senza blocchi di rendering

- Dopo test utente su output Rust lungo, la continuazione automatica proseguiva
  fino alla fine ma la UI continuava a bloccarsi a tratti.
- Misura diretta su runtime MLX:
  - prompt: `scrivimi un esempio di codice Rust di 200 righe`;
  - primo token: ~0.28s;
  - durata totale: ~65s;
  - token generati: ~2017;
  - delta ricevuti: 763;
  - gap principali intorno a 0.3-0.55s.
- Conclusione: il runtime streamma davvero; il blocco percepito era nel
  frontend. Durante lo streaming `RichMessage` ricostruiva paragrafi e span su
  tutto il testo a ogni tick, costo crescente con output lunghi.
- Correzione:
  - aggiunto `StreamingTextMessage`;
  - durante lo streaming si renderizza un singolo nodo testo con
    `white-space: pre-wrap`;
  - il renderer markdown/diagrammi/codice resta disattivato fino alla risposta
    finale;
  - ottimizzato anche `PlainTextMessage` evitando split ripetuti delle righe.
- Verifiche:
  - RED: `npm run test:ui-contract` falliva per assenza di
    `StreamingTextMessage`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`.

Perche': per output lunghi non possiamo far dipendere la fluidita' da un
renderer markdown incrementale. Lo streaming deve essere prima di tutto un
flusso testo leggero; la formattazione ricca arriva solo quando il messaggio e'
stabile.

### Fase 61 - Stream chat su WebSocket locale

- Test utente dopo Fase 60: la UI mostrava subito i primi caratteri e poi
  restava bloccata anche con pochissimo testo renderizzato.
- Nuova diagnosi:
  - il runtime MLX diretto streamma;
  - il renderer React leggero non spiega un blocco dopo pochi caratteri;
  - il sintomo e' compatibile con buffering di `fetch` streaming dentro
    WKWebView/Tauri su macOS.
- Decisione tecnica:
  - non migrare subito a Electron;
  - spostare il canale token da HTTP `fetch` NDJSON a WebSocket locale;
  - mantenere HTTP JSON per snapshot, thread, azioni e fallback/debug.
- Implementato:
  - abilitato `axum` feature `ws`;
  - aggiunto `GET /api/chat/stream/ws`;
  - autenticazione tramite token locale del gateway su query string;
  - protocollo WS con messaggio iniziale `{ kind: "submit" | "continue", ... }`;
  - eventi WS `accepted`, `delta`, `done`, `error` uguali al contratto NDJSON;
  - `chatApi.submitChatPromptStream` e `continueChatMessageStream` ora usano
    `new WebSocket(...)`;
  - gli endpoint HTTP `/messages/stream` e `/continue/stream` restano fallback.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml gateway -- --nocapture`;
  - `npm run build`.

Perche': se il problema e' buffering HTTP della WebView, continuare a rifinire
React non basta. WebSocket e' il canale piu' adatto per stream token lunghi in
una desktop webview mantenendo Tauri e il core locale.

### Fase 62 - Lettura byte-level dello stream Python nel client Rust

- Test utente dopo WebSocket: lo stream restava comunque bloccato.
- Nuova ipotesi verificata sul codice:
  - lo stream dalla WebView al gateway non basta se il gateway riceve gia'
    delta in ritardo dal runtime Python;
  - `RuntimeClient::generate_stream` usava `BufReader::lines()` sopra
    `reqwest::blocking::Response`;
  - questo introduce un altro punto di buffering non necessario tra Python MLX
    e Rust Core.
- Correzione:
  - rimosso `BufReader::lines()`;
  - introdotta lettura incrementale con `Read::read` su buffer byte;
  - parsing NDJSON progressivo: mantiene un buffer stringa e processa ogni
    riga appena arriva il newline;
  - aggiunto test unitario per righe NDJSON spezzate su chunk separati.
- Verifiche:
  - `cargo test -p local-first-subagents stream_parser_accepts_split_ndjson_chunks -- --test-threads=1`;
  - `cargo test -p local-first-subagents --test runtime_client -- --test-threads=1`;
  - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `git diff --check`.

Perche': ora il percorso lungo e' coerente end-to-end: Python genera NDJSON,
Rust legge byte incrementali, gateway invia WebSocket, React renderizza testo
leggero durante lo streaming.

### Fase 63 - Streaming UI senza typewriter React in Tauri

- Test utente dopo Fase 62: in Tauri lo stream mostrava pochi caratteri, poi
  restava bloccato e infine appariva la risposta completa.
- Diagnosi eseguita:
  - probe diretto sul gateway WebSocket desktop
    `ws://127.0.0.1:<porta>/api/chat/stream/ws`;
  - prompt lungo: `scrivimi un esempio di codice Rust di 300 righe`;
  - risultato: primo delta 1,26s, 504 chunk, 5.225 caratteri, 0 gap sopra 2s,
    totale 50,4s.
- Root cause aggiornata:
  - runtime Python, client Rust e gateway WebSocket streammano correttamente;
  - il blocco e' nel rendering della WebView Tauri;
  - il typewriter precedente faceva micro-update React e scroll su piccoli
    slice di testo, saturando il main thread di WKWebView su output lunghi.
- Correzione:
  - rimosso il typewriter timer-based dal percorso caldo;
  - durante lo streaming React crea solo il messaggio e lo stato iniziale;
  - i delta vengono accumulati e dipinti con `requestAnimationFrame` in un
    singolo nodo testo dedicato (`streamingTextRef`);
  - scroll automatico agganciato al paint del nodo, non a ogni `setState`;
  - a fine stream React torna a renderizzare il messaggio stabile con markdown,
    codice e diagrammi;
  - aggiornato il contratto UI per bloccare regressioni verso typewriter
    timer-based in Tauri.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`.

Perche': se il canale token e' fluido fuori dalla webview, la UI non deve
passare ogni token da riconciliazione React. Il rendering live resta volutamente
grezzo e leggero; la qualita' markdown arriva quando il testo e' completo.

### Fase 64 - Transcript virtualizzato e startup solo thread attivo

- Input utente: analisi performance esterna con ipotesi principale su DOM
  non virtualizzato, markdown pesante e caricamento troppo ampio dello
  scrollback.
- Diagnosi accettata:
  - il blocco non e' piu' nel trasporto;
  - `ChatView` renderizzava l'intero `threadMessages.map(...)`;
  - `App` caricava i messaggi di tutti i thread all'avvio;
  - lo stream live riscriveva testo crescente e forzava scroll continuo.
- Correzione:
  - aggiunto `@tanstack/react-virtual`;
  - introdotta virtualizzazione delle righe messaggio nel transcript;
  - overscan contenuto e stime diverse per user/assistant/output lunghi;
  - lo stream live resta su nodo testo dedicato, ma ora usa append incrementale
    invece di riscrivere tutto `textContent`;
  - la riga streaming viene ridimensionata con stima progressiva, non con
    layout measure a ogni token;
  - autoscroll solo se l'utente e' gia' vicino al fondo;
  - startup desktop: carica solo i messaggi del thread attivo, gli altri thread
    caricano i messaggi on-demand alla selezione;
  - aggiornato il contratto UI per impedire regressioni a render full
    scrollback o preload di tutti i thread.
- Verifiche:
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `npm run build`.

Perche': questa e' la prima correzione strutturale coerente con i dati. Se
anche dopo DOM virtualizzato e stream append-only Tauri resta non fluido, allora
il confronto con Electron diventa un benchmark architetturale serio, non una
reazione al sintomo.

### Fase 65 - Diagnostica stream dentro WebView Tauri

- Test utente dopo Fase 64: comportamento invariato.
- Interpretazione:
  - il full scrollback non e' la causa primaria del freeze percepito durante lo
    stream;
  - serve distinguere tra due casi:
    1. WebView riceve i delta ma non dipinge;
    2. WebView riceve/consegna gli eventi WebSocket solo a fine risposta.
- Implementato:
  - endpoint locale `POST /api/chat/streams/:request_id/debug`;
  - il gateway logga i checkpoint solo quando `LOCAL_FIRST_STREAM_DEBUG=1`;
  - `chatApi` invia checkpoint `ws_open`, `client_received_delta`,
    `client_received_done`;
  - `ChatView` invia checkpoint `paint_first_delta`,
    `paint_frame_checkpoint`, `paint_done_before_commit`;
  - riavviata Tauri con `LOCAL_FIRST_STREAM_DEBUG=1`.
- Verifiche:
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`.

Perche': dopo piu' ottimizzazioni senza effetto visibile, la prossima decisione
deve basarsi su un confine misurato dentro la WebView, non su ipotesi.

### Fase 66 - Paint stream sincrono, senza requestAnimationFrame

- Risultato della diagnostica Fase 65:
  - `client_received_delta` arrivava regolarmente per tutta la generazione;
  - `paint_first_delta` arrivava subito;
  - i checkpoint schedulati con `requestAnimationFrame` arrivavano solo a fine
    stream, insieme a `client_received_done`.
- Conclusione:
  - WebSocket e callback JS ricevono i token;
  - il problema e' l'affidamento a `requestAnimationFrame` per il paint live in
    WKWebView/Tauri durante lo stream;
  - RAF viene affamato o rimandato fino alla fine della generazione.
- Correzione:
  - `scheduleStreamingPaint` ora dipinge sincronicamente nel callback
    WebSocket;
  - mantiene append incrementale sul nodo testo dedicato;
  - rimossa la dipendenza da `streamingPaintFrameRef`;
  - checkpoint debug rinominato in `paint_checkpoint`;
  - aggiornato il contratto UI per vietare regressioni su RAF nel percorso hot
    dello streaming.
- Verifiche:
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`.

Perche': in questa WebView il browser non garantisce frame RAF intermedi
durante la generazione, mentre il callback WebSocket arriva. Per una chat locale
la priorita' e' mostrare progressivamente testo, anche rinunciando a una
cadence animata.

### Fase 67 - Streaming visibile: scroll pin e indice virtuale stabile

- Risultato diagnostica dopo Fase 66:
  - `dom_chars` cresceva durante lo stream, quindi il testo veniva scritto nel
    DOM;
  - `scrollTop` restava 0 mentre `scrollHeight` cresceva molto;
  - `virtual=-1`, quindi il resize virtualizzato non trovava l'indice del
    messaggio streaming nella closure corrente.
- Conclusione:
  - il testo veniva aggiornato, ma la viewport non seguiva la crescita della
    risposta;
  - l'utente vedeva l'inizio della risposta e poi il resto cresceva sotto la
    parte visibile, dando ancora percezione di blocco.
- Correzione:
  - aggiunto `streamingUserPinnedRef`: durante uno stream appena inviato la chat
    resta ancorata in fondo;
  - se l'utente scrolla molto verso l'alto, il pin viene rilasciato;
  - aggiunto `streamingMessageIndexRef` per non dipendere da closure React
    vecchie quando si ridimensiona la riga virtualizzata;
  - debug DOM arricchito con `pinned` e indice virtuale stabile.
- Verifiche:
  - `npm run typecheck`;
  - `npm run test:ui-contract`.

Perche': ora abbiamo separato tre livelli: token ricevuti, DOM aggiornato,
viewport che segue. Il problema osservato era nel terzo livello.

### Fase 68 - Stop patch Tauri e benchmark Electron

- Test utente dopo Fase 67: esperienza invariata, la risposta appare ancora in
  blocco dopo circa un minuto.
- Stato misurato:
  - la WebView riceve delta durante tutta la generazione;
  - il DOM cresce durante tutta la generazione;
  - nonostante questo l'esperienza visiva resta non accettabile.
- Decisione:
  - interrompere le micro-correzioni su Tauri/WKWebView;
  - creare una shell Electron dev non invasiva per confronto reale usando la
    stessa UI React;
  - se Chromium rende lo stream fluido, la chat desktop deve migrare a Electron
    o avere una superficie Chromium dedicata.
- Implementato:
  - aggiunto `electron` come dev dependency;
  - aggiunto `apps/desktop/electron/main.cjs`;
  - aggiunto `apps/desktop/scripts/electron-dev.mjs`;
  - aggiunto script `npm run electron:dev`;
  - Electron avviato con `contextIsolation`, `sandbox`, `nodeIntegration=false`;
  - aggiornato il contratto UI per mantenere disponibile il benchmark.
- Verifiche:
  - `npm run typecheck`;
  - `npm run test:ui-contract`.

Perche': dopo avere provato e misurato trasporto, DOM, virtualizzazione e
scroll, il rischio maggiore e' continuare a perdere giorni su WKWebView senza
migliorare il prodotto. Serve un confronto Chromium sullo stesso frontend.

### Fase 65 - Analisi performance rendering chat aggiornata

- Riletto il contesto durevole e corretto il piano precedente: il codice non e'
  piu' nella fase "nessuna virtualizzazione"; `ChatView` usa gia'
  `@tanstack/react-virtual`.
- Evidenza locale aggiornata:
  - streaming token via gateway WebSocket locale in `chatApi.ts` e
    `gateway.rs`;
  - streaming live dipinto con `requestAnimationFrame` su `streamingTextRef`,
    fuori dalla riconciliazione React per ogni delta;
  - transcript virtualizzato con stime di altezza e `measureElement`;
  - commit finale ancora costoso per messaggi ricchi: `RichMessageRenderer`
    normalizza tutto il testo e poi usa `react-markdown`, `remark-gfm`,
    `rehype-sanitize`, code block UI e Mermaid;
  - rischio tecnico TanStack: il codice usa anche `resizeItem` sulla riga
    streaming, mentre la documentazione avverte di non combinare cambio manuale
    dimensione e `measureElement` sullo stesso item.
- Ricerca aggiornata al 2026-05-26:
  - Tauri usa WebView2/Chromium su Windows, WKWebView/WebKit su macOS e
    WebKitGTK su Linux;
  - controllate issue Tauri su large DOM Linux, memory/resize Linux, freeze
    Linux e comportamenti macOS Intel;
  - controllate alternative: Electron, TanStack Virtual, Virtuoso Message List,
    Wails e Flutter desktop.
- Decisione raccomandata:
  - restare su Tauri e completare l'architettura rendering chat misurata;
  - non passare a Electron finche' benchmark UI non dimostra che il residuo e'
    specifico della WebView Tauri dopo ottimizzazioni frontend.
- Aggiornati:
  - `docs/plans/2026-05-26-chat-rendering-performance.md`;
  - `docs/benchmarks/chat-rendering-performance.md`;
  - `docs/architecture/final-roadmap.md`.
- Verifiche fresche:
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `python -m unittest tests/test_chat_latency_probe.py`;
  - WebKit locale macOS: `21624.2.5.11.4`.

Perche': la scelta Tauri/Electron non va presa sul sintomo. Ora il collo va
misurato con benchmark UI: DOM montato, frame time, long task, commit Markdown,
scroll anchoring e differenza browser preview/Tauri/Electron.

### Fase 69 - Rimozione Tauri e desktop shell Electron

- Test utente dopo il benchmark Electron: lo streaming nello stesso frontend
  React e' fluido in Chromium/Electron, mentre in Tauri/WKWebView restava
  percepito come bloccato anche quando WebSocket e DOM ricevevano i delta.
- Decisione applicata:
  - Tauri e' rimosso dal desktop app;
  - `apps/desktop/src-tauri` e' eliminato;
  - `@tauri-apps/api`, `@tauri-apps/cli` e lo script `npm run tauri` sono
    rimossi da `apps/desktop/package.json`;
  - `npm run electron:dev` diventa l'entrypoint desktop di sviluppo.
- Aggiunta shell Electron in:
  - `apps/desktop/electron/main.cjs`;
  - `apps/desktop/scripts/electron-dev.mjs`.
- Sicurezza Electron iniziale:
  - `contextIsolation: true`;
  - `sandbox: true`;
  - `nodeIntegration: false`;
  - niente tag `<webview>`;
  - navigazioni esterne aperte nel browser di sistema.
- `coreBridge.ts` non importa piu' API Tauri e non usa `invoke`.
- `chatApi.ts` usa fallback locali per thread/messaggi finche' il gateway Rust
  autonomo non verra' estratto.
- La chat continua a usare il runtime Gemma locale diretto per mantenere
  streaming reale e fluido durante la migrazione.
- Aggiornati:
  - `PROJECT.md`;
  - `docs/architecture/system-map.md`;
  - `docs/architecture/final-roadmap.md`;
  - `docs/decisions/0004-desktop-chat-http-gateway.md`;
  - `docs/decisions/0005-electron-desktop-shell.md`;
  - `apps/desktop/scripts/check-ui-contract.mjs`.

Perche': la chat e' la superficie principale del prodotto. Dopo aver verificato
che runtime, gateway, WebSocket e DOM ricevevano dati ma la WebView Tauri non
dava un'esperienza fluida, continuare con micro-fix su WKWebView non era piu'
pragmatico. Electron diventa la shell, mentre le responsabilita' native vanno
riportate in un gateway Rust autonomo e in crate riusabili.

### Fase 70 - Pulizia streaming chat dopo migrazione Electron

- Corretto il bug per cui la risposta streammata restava visibile durante la
  generazione ma spariva al refresh finale:
  - `chatApi.commitChatPromptResult` salva messaggio utente e risposta assistant
    nello store locale Electron;
  - `chatApi.commitChatContinuationResult` aggiorna lo stesso messaggio durante
    le continuazioni automatiche.
- Rimosso dal percorso chat il workaround nato per Tauri/WKWebView:
  - niente piu' `streamingTextRef` e append manuale su text node DOM;
  - lo stream visibile passa dallo stato React `optimisticMessages`;
  - gli update sono throttled con `requestAnimationFrame`;
  - `RichMessage` gestisce anche il rendering streaming come testo semplice,
    mentre il renderer Markdown completo resta per il commit finale.
- Aggiornato il contratto UI per imporre:
  - persistenza del risultato prima del refresh;
  - streaming visibile dentro lo stato React;
  - divieto di bypassare React con text node manuali.

Perche': dopo il passaggio a Electron, i workaround specifici per WKWebView
creavano due fonti di verita' per la risposta: DOM manuale durante lo stream e
messaggi React al commit. La chat deve avere un solo modello mentale e tecnico:
messaggi nello stato/read model, con streaming come aggiornamento progressivo
dello stesso messaggio.

### Fase 71 - Analisi CoderSteroids rendering chat Electron

- Eseguita analisi field-depth del rendering chat Electron in
  `docs/plans/2026-05-26-electron-chat-rendering-field-report.md`.
- Mappa attuale:
  - Electron carica la UI React/Vite in `BrowserWindow` con `sandbox`,
    `contextIsolation` e `nodeIntegration=false`;
  - `ChatView` aggiorna lo stream nello stato React locale
    `optimisticMessages`, throttled con `requestAnimationFrame`;
  - `RichMessage` usa un singolo nodo testo durante lo streaming;
  - il renderer Markdown completo e' lazy e parte solo a risposta conclusa;
  - il transcript Electron base usa document flow con `threadMessages.map`,
    senza virtualizzazione.
- Evidenza runtime fresca:
  - `npm run typecheck`: ok;
  - `npm run test:ui-contract`: ok;
  - `python -m unittest tests/test_chat_latency_probe.py`: ok;
  - `npm run build`: ok, con warning su chunk grandi;
  - runtime Gemma locale su `127.0.0.1:8765/health`: ok e loaded;
  - ispezione Playwright su `http://127.0.0.1:1420/`: nessun errore console;
  - prompt Markdown/codice breve renderizzato con 0 long task osservati,
    `requestAnimationFrame` p95 circa 14.2 ms e 1 code block finale.
- Limite dichiarato:
  - l'ispezione automatizzata e' stata su Chromium/Vite, non su una sessione
    Electron strumentata;
  - Electron e' stato avviato contro il dev server senza errori terminale, ma
    manca ancora cattura automatica di console, screenshot e performance del
    `BrowserWindow`.
- Conclusione:
  - il problema non e' piu' dimostrare che Electron streamma nel caso piccolo;
  - il rischio principale e' non avere benchmark su scrollback grande, commit
    finale Markdown/code/Mermaid, memoria e profilo Electron reale.
- Prossima azione consigliata:
  - implementare `bench:chat-render` per browser preview ed Electron;
  - misurare `tiny`, `long-markdown`, `large-scrollback`, `streaming-4k`,
    `code-heavy` e `mermaid-heavy`;
  - decidere solo dopo i numeri se servono row split/memo, virtualizzazione
    bounded, cache Markdown o preprocessing fuori dal percorso caldo.

### Fase 71 - Rimozione virtualizzazione transcript dal percorso base Electron

- Dopo test utente, le risposte potevano ancora sovrapporsi ai messaggi
  precedenti.
- Causa piu' probabile: la lista virtualizzata usava righe assolute con altezze
  dinamiche; durante streaming/commit il posizionamento poteva basarsi su misure
  obsolete.
- Decisione:
  - rimuovere `@tanstack/react-virtual` dal desktop app;
  - sostituire `.virtual-thread` / `.virtual-message-row` con
    `.thread-message-list` / `.thread-message-row` in normale document flow;
  - aggiornare il contratto UI per vietare la virtualizzazione nel percorso
    base Electron.

Perche': la chat deve prima essere corretta e prevedibile. La virtualizzazione
potra' tornare solo dopo benchmark e con test visuali specifici; nel prodotto
base Electron non deve introdurre rischio di overlap tra messaggi.

### Fase 72 - Contesto recente nella chat Electron

- Dopo il riavvio Electron, richieste ellittiche come "dimmene un'altra" non
  usavano la risposta precedente perche' il fallback Electron chiamava Gemma con
  il solo prompt corrente.
- Aggiunto `chatApi.recentChatContext(threadId, limit)`:
  - legge gli ultimi messaggi user/assistant del thread locale;
  - esclude il messaggio seeded di ready;
  - tronca ogni messaggio lungo per non gonfiare troppo il prompt.
- `coreBridge.submitBrowserRuntimeChatPromptStream` passa il contesto recente a
  `browserChatPrompt`.
- Il prompt locale ora include una sezione esplicita `Contesto recente della
  chat` e una regola per risolvere riferimenti come "un'altra", "continua" o
  "quello di prima".
- Aggiornato il contratto UI per obbligare il fallback Electron a usare il
  contesto recente finche' il gateway Rust autonomo non ripristina il prompt
  builder completo.

Perche': nella migrazione da Tauri al fallback Electron avevamo salvato la
cronologia a UI/read model, ma non la stavamo usando nella chiamata al runtime.
Una chat senza contesto rompe subito l'esperienza conversazionale.

### Fase 73 - JuicePrompt locale nel fallback Electron

- Aggiunto `apps/desktop/src/lib/contextBudget.ts` come adattamento TypeScript
  temporaneo del pattern OpenHuman/TokenJuice per il fallback Electron.
- Il modulo espone `buildJuicePromptChatContext`:
  - redige email, bearer token, API key, password, secret e token comuni;
  - redige parametri query sensibili negli URL;
  - limita ogni messaggio a un budget locale;
  - comprime il contesto vecchio con marker `[context compressed: earlier chat]`;
  - preserva gli ultimi turni della conversazione.
- `chatApi.recentChatContext` ora passa sempre da questo budget/compressore
  prima di inviare contesto al prompt builder.
- `coreBridge.browserChatPrompt` dichiara al runtime che il contesto e' gia'
  stato redatto e compresso con budget stile JuicePrompt locale.
- Aggiornato il contratto UI per impedire regressioni: il fallback Electron non
  deve tornare a inviare cronologia grezza.

Perche': il crate Rust `context-compression` resta la soluzione definitiva, ma
finche' il gateway autonomo non e' estratto la chat Electron deve comunque
avere contesto limitato, redatto e stabile. Questo chiude il buco introdotto
dalla rimozione del core Tauri senza bloccare l'esperienza utente.

### Fase 74 - Prompt builder Rust estratto per Electron

- Aggiunto crate `crates/desktop-gateway` come primo pezzo del Desktop HTTP
  Gateway Rust autonomo.
- Endpoint locali loopback:
  - `GET /api/health`;
  - `POST /api/chat/build_prompt`.
- Il gateway usa direttamente `local-first-context-compression`:
  - riceve il contesto recente raw dal renderer Electron;
  - redige e comprime in Rust con `ContextKind::ChatHistory`;
  - costruisce il prompt runtime con sezione `Contesto recente della chat`;
  - preserva riferimenti conversazionali come "dimmene un'altra" senza
    lasciare la responsabilita' al fallback TypeScript.
- `coreBridge.ts` prova prima il gateway Rust per costruire il prompt e poi
  streamma ancora verso Gemma su `/generate_stream`; se il gateway non e'
  raggiungibile mantiene il fallback TypeScript per non rompere la chat.
- `chatApi.ts` espone anche `rawRecentChatContext`, cosi' il renderer non deve
  piu' comprimere prima di passare dati al core.
- `scripts/electron-dev.mjs` avvia automaticamente
  `cargo run -p local-first-desktop-gateway` prima di Electron quando il gateway
  non e' gia' in ascolto su `127.0.0.1:18765`.
- Aggiornato il contratto UI per imporre:
  - crate gateway nel workspace;
  - endpoint `/api/chat/build_prompt`;
  - uso di `ContextCompressor` nel gateway;
  - fallback TypeScript solo come percorso di continuita'.

Perche': il fallback `contextBudget.ts` era utile per chiudere subito il buco
di contesto dopo la rimozione di Tauri, ma non deve diventare architettura
definitiva. Il prompt building, la redazione e il token budget devono stare nel
core locale Rust; Electron deve restare shell UI e streaming client.

### Fase 75 - Streaming chat migrato nel Desktop Gateway

- Esteso `crates/desktop-gateway`:
  - `POST /api/chat/generate_stream`;
  - `POST /api/chat/cancel_generation`.
- Il gateway ora riceve prompt + contesto raw, costruisce il prompt runtime con
  `local-first-context-compression` e inoltra lo stream a Gemma
  `/generate_stream` senza bufferizzare l'intera risposta (`Body::from_stream`).
- `coreBridge.ts` ora prova prima `/api/chat/generate_stream` sul gateway Rust;
  il percorso diretto renderer -> Gemma resta solo fallback se il gateway non e'
  raggiungibile.
- La cancellazione chiama sia il gateway sia il runtime diretto come fallback
  compatibile con le sessioni in corso.
- Aggiunto test Rust per il payload runtime dello stream:
  - clamp `max_tokens` e `temperature`;
  - preservazione del contesto recente;
  - prompt finale con `Contesto recente della chat`.
- Smoke reale eseguito:
  - gateway locale su `127.0.0.1:18765`;
  - runtime Gemma gia' in ascolto su `127.0.0.1:8765`;
  - `curl -sN /api/chat/generate_stream` con "quanto fa 6*3?" ha prodotto
    delta `18` e done con metriche token/memoria.

Perche': il renderer non deve possedere il trasporto runtime definitivo. Con
questo slice Electron resta client dello stream, ma il confine prodotto passa
dal gateway Rust locale: prompt budget, redazione e proxy NDJSON sono nello
stesso punto, pronto per token locale, CORS ristretto, persistenza thread e
Brain.

### Fase 76 - Thread e messaggi persistenti nel Desktop Gateway

- Aggiunto store SQLite locale al `crates/desktop-gateway`:
  - tabella `chat_threads`;
  - tabella `chat_messages`;
  - tabella `settings` per `active_thread_id`.
- Il DB usa `LOCAL_FIRST_DESKTOP_GATEWAY_DB` se presente, altrimenti
  `~/.local-first-personal-assistant/desktop-gateway.sqlite`.
- Nuovi endpoint chat persistenti:
  - `GET /api/chat/threads`;
  - `POST /api/chat/threads`;
  - `POST /api/chat/threads/{thread_id}/select`;
  - `POST /api/chat/threads/{thread_id}/pin`;
  - `POST /api/chat/threads/{thread_id}/archive`;
  - `POST /api/chat/threads/{thread_id}/unarchive`;
  - `DELETE /api/chat/threads/{thread_id}`;
  - `GET /api/chat/threads/{thread_id}/messages`;
  - `POST /api/chat/threads/{thread_id}/messages/commit_prompt_result`;
  - `POST /api/chat/threads/{thread_id}/messages/{message_id}/commit_continuation_result`.
- `apps/desktop/src/lib/chatApi.ts` ora prova prima il gateway per thread,
  messaggi, pin, archive/delete e commit dei risultati; mantiene una cache
  locale solo come fallback e per il context builder sincrono della UI.
- Aggiunto test Rust `store_seeds_and_commits_chat_messages`.
- Smoke HTTP su DB temporaneo verificato:
  - seed thread;
  - create thread;
  - read ready message;
  - commit user/assistant;
  - thread title aggiornato a `quanto fa 6*3`;
  - message count a 3.

Perche': la chat non puo' essere credibile se al riavvio perde contesto e
thread. Questo sposta il read model minimo nel core locale Rust, mantenendo
Electron come client e preparando Brain, task e audit su una cronologia stabile.

### Fase 77 - Token locale e CORS ristretto per Desktop Gateway

- Aggiunto token bearer locale opzionale al `crates/desktop-gateway`:
  - env `LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN`;
  - tutti gli endpoint `/api/chat/*` richiedono
    `Authorization: Bearer <token>` quando il token e' configurato;
  - `/api/health` resta pubblico e indica `auth_required`.
- `apps/desktop/scripts/electron-dev.mjs` genera un token random a ogni avvio
  se non viene fornito via env:
  - passa `LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN` al gateway;
  - passa `VITE_LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN` al renderer Vite.
- Aggiunto `apps/desktop/src/lib/gatewayConfig.ts`:
  - URL gateway unico;
  - header `Authorization` centralizzato per `chatApi` e `coreBridge`.
- Rimosso il fallback diretto chat renderer -> Gemma per stream/cancel:
  - `coreBridge` usa `/api/chat/generate_stream`;
  - `coreBridge` usa `/api/chat/cancel_generation`;
  - se il gateway non e' raggiungibile la chat fallisce in modo esplicito,
    invece di bypassare il confine Rust.
- Sostituito `CorsLayer::permissive()` con allowlist esplicita:
  - `http://127.0.0.1:1420`;
  - `http://localhost:1420`;
  - `http://127.0.0.1:1421`;
  - `http://localhost:1421`;
  - override singolo via `LOCAL_FIRST_DESKTOP_ALLOWED_ORIGIN`.
- Smoke HTTP con token verificato:
  - health pubblico con `auth_required: true`;
  - `/api/chat/threads` senza token -> `401`;
  - `/api/chat/threads` con bearer token e origin Vite -> `200`;
  - CORS response include `access-control-allow-origin:
    http://127.0.0.1:1420`.

Perche': dopo aver spostato prompt, stream e persistenza nel gateway, lasciare
un bypass diretto dal renderer a Gemma avrebbe reso fragile il confine
architetturale. Ora la chat passa dal gateway locale Rust; il prossimo hardening
e' lifecycle/packaging del gateway e poi collegamento Brain.

### Fase 78 - Runtime e contesto consolidati nel Desktop Gateway

- Esteso `crates/desktop-gateway` con endpoint runtime protetti dallo stesso
  token locale della chat:
  - `GET /api/runtime/health`;
  - `POST /api/runtime/warmup`;
  - `POST /api/runtime/shutdown`.
- `coreBridge.ts` non chiama piu' direttamente `127.0.0.1:8765`:
  - health runtime passa dal gateway;
  - warmup passa dal gateway;
  - stop/restart passano da shutdown/warmup gateway;
  - il contratto UI fallisce se ricompare il bypass renderer -> Gemma.
- Il gateway usa `local-first-process-manager`:
  - registra `llm-gemma4-mlx` dal `SidecarProcessCatalog`;
  - usa `.venv-mlx/bin/python runtimes/mlx-gemma4/server.py`;
  - mantiene il registry processi in
    `~/.local-first-personal-assistant/process-registry.sqlite` o
    `LOCAL_FIRST_PROCESS_REGISTRY_DB`;
  - se `/api/runtime/warmup` non trova Gemma in health, prova ad avviare il
    runtime prima di chiamare `/warmup`.
- `electron-dev.mjs` controlla se il gateway gia' in ascolto e' compatibile con
  il token corrente; se non lo e', termina il listener sulla porta e avvia un
  gateway fresco. Questo evita sessioni Electron collegate a gateway vecchi.
- Il commit delle risposte streaming e delle continuazioni ora viene `await`ato
  prima che `ChatView` ricarichi i messaggi dal read model. Prima era
  fire-and-forget e poteva causare perdita apparente della risposta, contesto
  mancante al turno successivo o refresh su snapshot vecchio.
- Aggiornati i contratti UI per imporre:
  - endpoint runtime nel gateway;
  - assenza di chiamate dirette renderer -> Gemma;
  - commit chat atteso prima del refresh.
- Smoke verificato su gateway temporaneo `127.0.0.1:18766`:
  - `/api/health` pubblico con `auth_required: true`;
  - `/api/chat/threads` senza token -> `401`;
  - `/api/chat/threads` con token -> `200`;
  - `/api/chat/build_prompt` conserva il contesto per follow-up come
    `dimmene un'altra`;
  - `/api/runtime/health` proxy verso Gemma loaded;
  - runtime health espone `pid`, owner porta, memoria totale e memoria/cpu
    processo quando `lsof`/`ps` sono disponibili;
  - `/api/runtime/warmup` con Gemma gia' esterno restituisce `200` e non crea
    duplicati;
  - `/api/chat/generate_stream` con `quanto fa 6*3?` produce delta `18` e done
    con metriche runtime.
- Verifiche finali:
  - `cargo test -p local-first-desktop-gateway`;
  - `cargo check --workspace`;
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `npm run build`;
  - `git diff --check`.

Perche': il problema osservato dopo Electron non era solo visuale. La UI aveva
streaming fluido, ma il read model poteva rientrare in uno stato vecchio dopo il
refresh e il runtime lifecycle era ancora parzialmente fuori dal boundary Rust.
Ora chat, contesto, stream, cancel, runtime controls e autostart passano dallo
stesso gateway locale. Il prossimo blocco e' packaging/diagnostica del runtime
Python/MLX e poi collegamento dei read model non-chat.

### Fase 79 - Rifinitura rendering chat dopo test utente

- Corretto rendering delle bubble utente:
  - lo stile della bubble ora si applica solo al contenitore diretto del
    messaggio utente;
  - i paragrafi interni non ricevono piu' padding/background duplicati;
  - `overflow-wrap` sulle bubble utente usa `break-word`, evitando parole corte
    impilate verticalmente come `s` / `i`.
- Corretto rendering markdown dei blocchi codice generati da Gemma:
  - `RichMessageRenderer` ripara fence duplicati come un secondo ````rust`
    emesso dentro un blocco gia' aperto;
  - il renderer evita di spezzare quel caso in molti blocchi `rust`/`text`.
- Corretto join delle continuazioni automatiche:
  - `joinContinuationText` rimuove prefissi gia' presenti quando il modello
    ripete l'inizio del chunk successivo;
  - questo riduce duplicazioni nei messaggi lunghi completati con `Continua`.
- Aggiornato il contratto UI per coprire:
  - riparazione fence duplicati;
  - overlap trimming nelle continuazioni.
- Verifiche:
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `npm run build`.

Perche': dopo il passaggio a Electron lo streaming e i tempi sono migliorati,
ma l'esperienza chat restava fragile su output reali di Gemma: codice lungo con
fence imperfetti e bubble utente troppo strette su risposte brevi. La soluzione
resta nel layer UI/rendering, non nel runtime.

### Fase 80 - Runtime diagnostics UI

- Aggiunto piano operativo:
  - `docs/plans/2026-05-27-runtime-diagnostics-ui.md`.
- Estesa la sezione Settings -> Runtime locale:
  - stato sintetico di Gemma;
  - porta;
  - PID;
  - memoria processo / memoria totale;
  - CPU;
  - duplicati;
  - azioni avvia/riavvia/ferma con icone;
  - pulsante `Copia diagnostica`.
- Estesi i read model TypeScript:
  - `RuntimeControl.totalMemoryMb`;
  - `RuntimeControl.availableMemoryMb`;
  - mapping da `RuntimeControlItem.total_memory_mb` e
    `available_memory_mb`.
- La diagnostica copiata contiene solo stato tecnico redatto:
  - health;
  - process id;
  - porta/PID;
  - memoria/CPU;
  - messaggio runtime.
  Non include prompt utente, raw payload o segreti.
- Aggiornato il contratto UI per imporre layout diagnostico e copia
  diagnostica.
- Verifica visiva con Playwright:
  - desktop `1365x900`: sezione Runtime leggibile, metriche compatte, azioni
    allineate;
  - mobile `390x844`: metriche a due colonne e azioni sotto al dettaglio senza
    overflow orizzontale.
- Verifiche:
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `npm run build`;
  - `cargo check --workspace`.

Perche': dopo aver reso il gateway owner del runtime, l'utente deve poter
capire cosa e' acceso, quale processo occupa la porta, quante risorse usa e
copiare una diagnostica utile senza aprire terminale o console.

### Fase 81 - Runtime logs redatti nel gateway

- Esteso `ProcessManager` con lettura limitata dei log catturati dal
  supervisor locale.
- Aggiunto endpoint gateway:
  - `GET /api/runtime/logs`.
- L'endpoint restituisce solo log redatti:
  - ultimi 80 record;
  - stream `stdout`/`stderr`;
  - token, bearer, password e secret mascherati.
- Se Gemma e' gia' avviato fuori dal gateway, la UI non mostra piu' errori
  interni come `process not found`; mostra invece uno stato leggibile:
  runtime esterno, log gestiti non disponibili.
- Estesa Settings -> Runtime locale:
  - pannello `Log runtime`;
  - ultime righe redatte quando il processo e' gestito;
  - fallback esplicito quando il runtime e' esterno;
  - copia diagnostica include anche la sezione log redatta.
- Aggiornato il contratto UI per imporre la presenza del pannello log e della
  route `/api/runtime/logs`.
- Verifiche:
  - `cargo test -p local-first-process-manager -p local-first-desktop-gateway`;
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `npm run build`;
  - `git diff --check`;
  - verifica browser su `http://127.0.0.1:1420/`, Settings -> Runtime locale:
    nessun errore console, nessuna stringa tecnica `process not found` esposta.

Perche': la diagnostica runtime non basta se Gemma fallisce in avvio o resta
in uno stato ambiguo. I log devono essere visibili dall'app, ma sempre redatti e
senza esporre prompt, payload o segreti.

### Fase 82 - Lifecycle Electron/gateway allineato a produzione

- Spostata la responsabilita' di avvio del Desktop Gateway dentro
  `apps/desktop/electron/main.cjs`.
- Electron ora:
  - genera o riceve `LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN`;
  - espone al renderer solo `gatewayUrl` e `gatewayToken` tramite preload
    isolato (`contextBridge`);
  - avvia o riusa il gateway locale;
  - in dev usa `cargo run -p local-first-desktop-gateway`, quindi ricompila il
    gateway quando Rust cambia;
  - in packaged usa `LOCAL_FIRST_DESKTOP_GATEWAY_BIN` o
    `resources/bin/local-first-desktop-gateway`;
  - termina il gateway gestito su `before-quit`.
- Semplificato `scripts/electron-dev.mjs`:
  - avvia Vite;
  - pulisce listener gateway stale sulla porta;
  - avvia Electron;
  - non gestisce piu' token/gateway in parallelo.
- Aggiornato `gatewayConfig.ts`:
  - usa il preload Electron in app packaged;
  - conserva fallback `VITE_LOCAL_FIRST_DESKTOP_GATEWAY_*` per test/dev;
  - normalizza l'URL gateway.
- Gateway CORS:
  - aggiunto origin `null` per consentire renderer `file://` packaged;
  - la protezione resta sul bearer token locale e su bind loopback.
- Smoke production-like:
  - `npm run build`;
  - avvio Electron senza `LOCAL_FIRST_DESKTOP_URL`, quindi da `dist/index.html`;
  - porta gateway separata `18766`;
  - richiesta autorizzata a `/api/chat/threads` OK;
  - richiesta senza token a `/api/chat/threads` restituisce `401`;
  - chiusura Electron libera la porta gateway.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `cargo test -p local-first-desktop-gateway`;
  - `npm run build`;
  - `git diff --check`.

Perche': il comportamento dev e packaged devono convergere. La chat non deve
dipendere da variabili Vite per autenticarsi al gateway locale, e il lifecycle
del processo Rust deve essere governato dalla shell desktop che l'utente avvia.

### Fase 83 - Log processi persistenti e runtime assets packaged

- Esteso `LocalProcessSupervisor`:
  - `with_log_dir(path, capacity)`;
  - scrittura JSONL redatta dei log di processo;
  - retention a righe;
  - lettura dei log persistenti anche dopo restart del supervisor.
- I log persistenti redigono marker sensibili prima di scrivere su disco:
  - `token=`;
  - `Authorization:`;
  - `Bearer `;
  - `password=`;
  - `secret=`;
  - chiavi `sk-*` / `sk_proj_*`.
- Il Desktop Gateway ora configura il supervisor con:
  - `LOCAL_FIRST_PROCESS_LOG_DIR`, se presente;
  - fallback `~/.local-first-personal-assistant/logs/processes`;
  - retention default 2.000 righe.
- Il Desktop Gateway supporta `LOCAL_FIRST_GEMMA_PYTHON_VENV`:
  - in dev resta `.venv-mlx`;
  - in packaged Electron puo' puntare alla venv bundlata.
- Electron passa al gateway:
  - `LOCAL_FIRST_PROCESS_LOG_DIR` sotto `app.getPath("userData")`;
  - `LOCAL_FIRST_GEMMA_PYTHON_VENV` se trova `resources/.venv-mlx`;
  - `LOCAL_FIRST_WORKSPACE_ROOT` diverso tra dev e packaged.
- Aggiunto test:
  - `local_supervisor_persists_redacted_logs_with_retention`.
- Verifiche:
  - `cargo fmt`;
  - `cargo test -p local-first-process-manager -p local-first-desktop-gateway`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `git diff --check`;
  - smoke dev: `npm run electron:dev` avvia Electron, Electron avvia il gateway,
    crea la directory log processi e `/api/chat/threads` senza token risponde
    `401`.

Perche': i log diagnostici non devono vivere solo in RAM. Se il runtime Python
fallisce, l'app deve poter mostrare l'ultimo output redatto dopo refresh o
restart, senza chiedere all'utente di aprire terminali o cercare processi.

### Fase 84 - Layout risorse packaging Electron

- Aggiunto script:
  - `apps/desktop/scripts/prepare-package.mjs`.
- Aggiunti script npm:
  - `package:prepare`;
  - `package:smoke`.
- `package:prepare`:
  - esegue `npm run build`;
  - esegue `cargo build -p local-first-desktop-gateway --release`;
  - prepara `apps/desktop/.package/resources`;
  - copia `target/release/local-first-desktop-gateway` in `resources/bin`;
  - copia `runtimes/mlx-gemma4` in `resources/runtimes/mlx-gemma4`;
  - collega `.venv-mlx` come symlink per smoke locale;
  - supporta `--copy-venv` quando serve produrre una cartella autosufficiente.
- Electron supporta ora `LOCAL_FIRST_DESKTOP_RESOURCES_DIR`:
  - permette smoke locale senza Vite e senza app bundle;
  - usa `resources/bin/local-first-desktop-gateway`;
  - usa `resources/.venv-mlx` se presente.
- Smoke production-like eseguito:
  - frontend caricato da `dist/index.html`;
  - gateway release avviato da `.package/resources/bin`;
  - runtime assets presenti in `.package/resources/runtimes/mlx-gemma4`;
  - gateway su porta `18766`;
  - `/api/health` OK;
  - `/api/chat/threads` con token OK;
  - `/api/chat/threads` senza token `401`;
  - chiusura Electron libera la porta.
- Verifiche:
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `cargo test -p local-first-process-manager -p local-first-desktop-gateway`;
  - `npm run package:prepare`;
  - `git diff --check`.

Perche': prima avevamo un'app dev funzionante, ma non un layout riproducibile
per avvicinarci al packaging reale. Ora esiste una directory risorse verificata
che rispecchia il futuro bundle Electron.

### Fase 85 - Read model non-chat nel Desktop Gateway

- Esteso `crates/desktop-gateway` con store locali persistenti:
  - `TaskStore`;
  - `LocalComputerSessionStore`;
  - `MemoryFacade` su `SQLiteMemoryStore`;
  - `CapabilityRegistryStore`.
- Aggiunti endpoint protetti da bearer token:
  - `GET /api/tasks/queue`;
  - `GET /api/tasks/{task_id}`;
  - `POST /api/approvals/{approval_id}/approve`;
  - `POST /api/approvals/{approval_id}/reject`;
  - `GET /api/local-computer/sessions/{session_id}`;
  - `GET /api/memory/dashboard`;
  - `GET /api/capabilities/snapshot`.
- Il task endpoint usa `TaskUiReadModel` e restituisce solo dati UI-safe:
  stati, priorita', approval, resource usage, checkpoint e metadata redatti.
- Il local computer endpoint usa `LocalComputerReadModel` e mantiene la policy
  multiutente/workspace.
- Il memory endpoint usa `MemoryUiReadModel` con richiesta desktop:
  domini `local`, `personal`, `work`, `browser`, sensibilita' massima
  `private`, `allow_raw_payload=false`, `allow_export=false`.
- Il capability endpoint legge il registry locale e semina i default minimi
  local-first:
  - provider `browser`;
  - grant locale per `browser`/`local`;
  - connection `browser-local`;
  - tool cache per health, tabs, snapshot, navigate, act e screenshot.
- `apps/desktop/src/lib/coreBridge.ts` ora legge task, approvals, sessioni
  computer, memoria e capability dal gateway HTTP locale.
- `apps/desktop/src/App.tsx` mappa dashboard memoria e capability snapshot in
  UI state, usando i mock solo come fallback se il gateway non risponde.
- `apps/desktop/scripts/electron-dev.mjs` genera ora un token condiviso fra
  Vite ed Electron:
  - Electron continua a ricevere il token via preload isolato;
  - il browser dev diretto riceve `VITE_LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN`;
  - evita 401 ripetuti quando si apre `http://127.0.0.1:1420/` fuori dalla
    finestra Electron.
- Verifiche:
  - `cargo fmt`;
  - `cargo check -p local-first-desktop-gateway`;
  - `cargo test -p local-first-desktop-gateway`;
  - `cargo test -p local-first-task-runtime -p local-first-local-computer-session`;
  - `cargo test -p local-first-memory -p local-first-capabilities`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `git diff --check`;
  - smoke HTTP gateway su porta `18767`:
    - `/api/tasks/queue` senza token `401`;
    - `/api/tasks/queue` con token OK;
    - `/api/local-computer/sessions/missing-session` con token `null`;
    - `/api/memory/dashboard` con token OK;
    - `/api/capabilities/snapshot` con token OK e provider browser locale;
    - `/api/capabilities/snapshot` senza token `401`.
  - smoke browser dev su `http://127.0.0.1:1420/` dopo restart Electron:
    UI caricata, token Vite applicato e nessun loop di 401.

Perche': la shell Electron non deve piu' ragionare su mock per le aree di base.
Chat, runtime, task, computer locale, memoria e capability ora passano tutti dal
Desktop Gateway Rust, con confine local-first e dati redatti.

### Fase 86 - Task operativi creati dalla chat

- Collegato il primo percorso operativo reale sopra il Desktop Gateway:
  - `POST /api/chat/threads/{thread_id}/messages/commit_prompt_result`
    riconosce in modo conservativo i prompt operativi e crea un task locale;
  - `POST /api/chat/threads/{thread_id}/messages/{message_id}/create_task`
    permette la creazione esplicita di un task da un messaggio;
  - il messaggio assistant viene collegato al `task_id` persistente;
  - la chat rilegge la sessione Computer locale reale dal gateway dopo il
    commit.
- Il task creato usa `TaskStore` persistente, risorse dichiarate e governance:
  - `browser_task` per navigazione/prenotazioni/ricerca web;
  - `shell_task` per operazioni terminale/file;
  - `computer_task` come fallback operativo;
  - risorse `ComputerSession`, `BrowserSession` e/o `ShellSession`.
- Sicurezza e privacy:
  - il prompt raw non viene salvato nell'input task;
  - il goal task viene compattato/redatto;
  - i task operativi auto-creati richiedono approval prima di usare browser,
    terminale o azioni locali;
  - l'approval non autorizza login, acquisti, invii o pagamenti automatici.
- Aggiunta sincronizzazione task/sessione Computer:
  - prima dell'approvazione la sessione e' `waiting_user`;
  - approvando, il task torna in coda e la sessione diventa
    `running/approved`;
  - rifiutando, il task viene cancellato e la sessione diventa
    `cancelled/rejected`;
  - la timeline Computer registra eventi redatti di richiesta/conferma/rifiuto.
- Verifiche:
  - `cargo fmt`;
  - `cargo check -p local-first-desktop-gateway`;
  - `cargo test -p local-first-desktop-gateway`;
  - `cargo test -p local-first-task-runtime -p local-first-local-computer-session`;
  - `npm run test:ui-contract`;
  - `npm run typecheck`;
  - `npm run build`;
  - `git diff --check`;
  - smoke HTTP gateway su porta `18768`:
    - prompt treno operativo crea task, approval e sessione Computer;
    - messaggio chat collegato al `task_id`;
    - approval pending visibile in `/api/tasks/queue`;
    - sessione Computer `waiting_user/waiting_user`;
    - dopo approve, task in `queued` e sessione
      `running/approved`.

Perche': prima la chat poteva rispondere con Gemma ma non materializzava lavoro
duraturo. Ora una richiesta operativa produce uno stato persistente governabile:
task, approval, sessione Computer, timeline e collegamento al messaggio.

### Fase 87 - Primo executor locale read-only

- Aggiunto il primo executor locale nel Desktop Gateway:
  - `POST /api/tasks/run_next`;
  - consuma il primo task `queued` approvato;
  - marca il task `running`, poi `completed` o `failed`;
  - scrive checkpoint redatto nel `TaskStore`;
  - aggiorna sessione Computer, progress e timeline;
  - pubblica un messaggio risultato nella chat collegato al `task_id`.
- Supporto iniziale per task read-only:
  - `browser_task` avvia il sidecar locale `runtimes/browser-automation`
    via stdio, apre una pagina/search URL in headless, raccoglie snapshot e
    salva URL/snapshot in checkpoint e timeline;
  - `local_shell_task` esegue solo comando read-only `date` quando il task e'
    chiaramente una richiesta di ora/data;
  - `local_task` supporta calcoli aritmetici semplici senza strumenti esterni.
- La UI ora chiama l'executor dopo approval:
  - `coreBridge.runPromptPlanReadySteps` usa `/api/tasks/run_next`;
  - le approval vengono associate sia al `task_id` sia al
    `computer_session_id`, quindi appaiono nella chat corretta;
  - dopo approve la chat refresh-a task, Computer session e messaggi.
- Sicurezza:
  - nessuna azione browser write;
  - nessun click/submit/login/pagamento;
  - browser sidecar usato solo per open/snapshot read-only;
  - output terminale e URL passano dal read model redatto.
- Verifiche:
  - `cargo fmt`;
  - `cargo check -p local-first-desktop-gateway`;
  - `cargo test -p local-first-desktop-gateway`;
  - `cargo test -p local-first-task-runtime -p local-first-local-computer-session -p local-first-browser-automation`;
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `npm run build`;
  - `git diff --check`;
  - smoke HTTP gateway su porta `18768`:
    - prompt treno crea task+approval;
    - approve mette il task in coda;
    - `/api/tasks/run_next` completa il task browser read-only;
    - task detail `completed` con checkpoint `browser_read_only`;
    - sessione Computer `completed/approved`, progress `3/3`, URL redatto;
    - timeline include `computer_browser_snapshot`;
    - chat riceve messaggio risultato collegato al task.

Perche': questo e' il primo punto in cui il sistema non solo risponde, ma
esegue un lavoro locale governato e osservabile. Rimane volutamente read-only:
gli step write/destructive andranno introdotti solo con policy/approval piu'
granulari.

### Fase 88 - Preview artifact reali per il Computer locale

- Esteso l'executor browser read-only:
  - dopo `open` + `snapshot` produce anche uno screenshot PNG;
  - salva l'artifact nel `LocalComputerSessionStore`;
  - collega l'artifact all'evento `computer_browser_snapshot`;
  - valorizza `preview_frame_ref` nel read model Computer.
- Aggiunto endpoint protetto dal Desktop Gateway:
  - `GET /api/local-computer/sessions/{session_id}/artifacts/{artifact_id}/preview`;
  - legge solo artifact della sessione/user/workspace corrente;
  - restituisce `data:image/png;base64,...` per la preview UI.
- Aggiornata la UI Electron:
  - `coreBridge.localComputerArtifactPreview` ora chiama il gateway locale;
  - la card Computer e la live view possono mostrare la miniatura reale del
    browser invece dello skeleton.
- Verifiche:
  - `cargo fmt`;
  - `cargo check -p local-first-desktop-gateway`;
  - `cargo test -p local-first-desktop-gateway`;
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `npm run build`;
  - `git diff --check`;
  - smoke gateway su porta `18768`:
    - task browser read-only completato;
    - artifact screenshot creato con byte > 0;
    - `preview_frame_ref` presente;
    - endpoint preview restituisce `data:image/png;base64,...`.

Perche': la parte "Computer" deve far vedere cosa e' successo, non solo
raccontarlo. Questo avvicina l'esperienza al modello Manus: risultato in chat
centrale, ma evidenza visiva consultabile quando serve.

### Fase 89 - Executor governato e browser multi-fonte resiliente

- Rafforzato l'executor del Desktop Gateway:
  - prima di eseguire acquisisce un lease locale con owner
    `desktop-gateway-executor`;
  - recupera lease scaduti prima di scegliere il prossimo task;
  - passa dal `ResourceGovernor` con limiti conservativi;
  - se le risorse non bastano marca il task `waiting_resource`;
  - a completamento o errore rilascia sempre lease e risorse.
- Esteso il task browser read-only:
  - per richieste treno controlla ricerca web, Trenitalia e Italo;
  - conserva nel checkpoint una lista di `sources` con stato per fonte;
  - se una fonte fallisce, registra errore redatto e continua con le altre;
  - fallisce solo quando nessuna fonte browser e' raggiungibile;
  - genera la preview PNG dalla prima pagina aperta con successo.
- Smoke reale:
  - prompt treno Napoli-Milano crea task+approval;
  - approve mette il task in coda;
  - `/api/tasks/run_next` completa il task;
  - checkpoint `browser_read_only` contiene tre fonti:
    `Ricerca web:completed`, `Trenitalia:completed`, `Italo:failed`;
  - l'errore Italo HTTP/2 non blocca il task;
  - endpoint preview restituisce `data:image/png;base64,...`;
  - `resource_usage` torna vuoto dopo l'esecuzione.
- Verifiche:
  - `cargo fmt`;
  - `cargo check -p local-first-desktop-gateway`;
  - `cargo test -p local-first-desktop-gateway`;
  - `cargo test -p local-first-task-runtime -p local-first-local-computer-session -p local-first-browser-automation`;
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `npm run build`;
  - `git diff --check`.

Perche': i task lunghi e multipli devono essere eseguiti senza doppie
esecuzioni e senza saturare risorse locali. Inoltre il browser deve comportarsi
come uno strumento operativo robusto: una fonte fragile non deve cancellare il
risultato quando altre fonti sono disponibili.

### Fase 90 - Worker background per task approvati

- Aggiunto piano operativo
  `docs/plans/2026-05-27-background-task-worker.md`.
- Aggiunto worker background nel Desktop Gateway:
  - parte insieme al gateway;
  - controlla la coda ogni secondo;
  - usa `TaskScheduler` per rispettare priorita', `not_before` e dipendenze;
  - usa lease `desktop-gateway-background-worker`;
  - usa resource governance gia' introdotta;
  - esegue task approvati senza chiamata manuale dalla UI;
  - aggiorna contatori e ultimo stato executor.
- Aggiunto endpoint locale protetto:
  - `GET /api/tasks/executor`;
  - espone stato sintetico UI-safe del worker.
- Aggiornata la UI Electron:
  - non chiama piu' automaticamente `/api/tasks/run_next` dopo approval;
  - mantiene `run_next` come fallback/debug esplicito;
  - poll locale ogni 2.5s per queue, detail e chat read model, cosi' il
    risultato scritto dal worker appare senza intervento utente.
- Test-first:
  - aggiornato `test:ui-contract` prima del codice;
  - fallimento iniziale atteso:
    `expected src/lib/coreBridge.ts to contain /api/tasks/executor`.
- Smoke reale:
  - creato task browser da prompt treno;
  - approvato task;
  - nessuna chiamata a `/api/tasks/run_next`;
  - worker ha portato il task da `queued` a `completed`;
  - checkpoint `browser_read_only` con fonti multiple;
  - Computer session `completed`;
  - messaggio chat finale collegato al task;
  - `completed_count` worker incrementato;
  - risorse rilasciate.
- Verifiche:
  - `cargo fmt`;
  - `cargo check -p local-first-desktop-gateway`;
  - `cargo test -p local-first-desktop-gateway`;
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `npm run build`;
  - `git diff --check`.

Perche': l'utente non deve capire quando premere "continua" per far partire un
task approvato. L'approvazione deve sbloccare la coda, poi il sistema deve
procedere autonomamente entro limiti locali, con stato osservabile ma non
invadente.

### Fase 91 - Checkpoint intermedi durante l'esecuzione

- Aggiunto piano operativo
  `docs/plans/2026-05-27-task-progress-checkpoints.md`.
- Il Desktop Gateway ora scrive checkpoint/eventi intermedi mentre il task e'
  in esecuzione:
  - `execution_started`;
  - `browser_runtime_starting`;
  - `browser_runtime_ready`;
  - `browser_source_started`;
  - `browser_source_completed`;
  - `browser_source_failed`;
  - `browser_synthesis_started`.
- Il browser executor registra ogni fonte nella timeline Computer:
  - ricerca web;
  - Trenitalia;
  - Italo o errore redatto se non raggiungibile.
- Il checkpoint finale resta `browser_read_only`, quindi il dettaglio task
  continua a puntare al risultato finale invece che a uno step intermedio.
- Smoke reale:
  - task treno approvato;
  - worker automatico;
  - timeline popolata durante l'esecuzione;
  - almeno sei eventi `browser_source_*`;
  - ultima risposta in chat collegata al task;
  - risorse rilasciate.
- Verifiche:
  - `cargo fmt`;
  - `cargo check -p local-first-desktop-gateway`;
  - `cargo test -p local-first-desktop-gateway`;
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `npm run build`;
  - `git diff --check`.

Perche': l'esperienza utente deve far capire che il sistema sta lavorando,
senza costringere l'utente a leggere log tecnici. La risposta finale resta il
centro, ma il Computer locale ora racconta il percorso in modo consultabile.

### Fase 92 - Risposta finale pulita per task browser

- Aggiunto piano operativo
  `docs/plans/2026-05-27-task-final-answer.md`.
- Introdotta struttura `TaskFinalAnswer` nel Desktop Gateway:
  - titolo;
  - summary;
  - risultato;
  - fonti controllate;
  - limiti;
  - prossimo passo.
- La chat non riceve piu' dump raw degli snapshot browser:
  - rimossi blocchi ` ```text ` dal risultato task browser;
  - rimossi estratti lunghi dalla risposta finale;
  - errori tecnici sidecar/ANSI restano fuori dalla chat.
- I dati tecnici restano nel checkpoint e nel Computer locale:
  - `sources`;
  - stato fonte;
  - errori redatti;
  - artifact screenshot.
- Aggiunta sanitizzazione delle sequenze terminali ANSI in
  `redact_sensitive_text`.
- Test:
  - `browser_final_answer_keeps_snapshot_dump_out_of_chat`;
  - `runtime_log_redaction_strips_terminal_control_sequences`.
- Smoke reale:
  - prompt treno;
  - worker automatico;
  - risposta finale contiene `Ricerca treni completata`, fonti, limiti e
    prossimo passo;
  - nessun dump snapshot;
  - nessuna sequenza terminale nella chat.
- Verifiche:
  - `cargo fmt`;
  - `cargo test -p local-first-desktop-gateway`;
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `npm run build`;
  - `git diff --check`.

Perche': l'utente deve leggere una risposta, non un log. I dettagli tecnici
sono utili per audit e ispezione, ma devono restare nel Computer locale e nei
checkpoint redatti.

### Fase 93 - Correzione UX Computer e browser visibile

- Corretto bug UI: la card Computer locale spariva dopo il completamento del
  task perche' veniva renderizzata solo con approval attive, run manuale, smoke
  o dettaglio aperto.
- La chat ora mantiene visibile il Computer locale quando la sessione ha
  timeline o artifact, anche se il task e' completato e la card e' collassata.
- L'approval mostra esplicitamente l'ambito:
  - `Solo questa volta` attivo;
  - `Regola fissa` visibile ma non ancora abilitata;
  - nota che le regole fisse richiederanno policy dedicate.
- Il browser automation gestito dal gateway non forza piu' headless:
  - default desktop `LOCAL_FIRST_BROWSER_HEADLESS` assente => browser visibile;
  - smoke/test possono usare `LOCAL_FIRST_BROWSER_HEADLESS=1`.
- Verifiche:
  - `cargo fmt`;
  - `cargo test -p local-first-desktop-gateway`;
  - `npm run typecheck`;
  - `npm run test:ui-contract`;
  - `npm run build`;
  - smoke gateway con `LOCAL_FIRST_BROWSER_HEADLESS=1`: task treno completato,
    timeline Computer con 16 eventi, artifact screenshot presente.

Perche': per task operativi l'utente deve vedere che esiste una sessione
Computer consultabile anche dopo la risposta. Inoltre e' importante distinguere
approvazioni temporanee da regole fisse: non dobbiamo far sembrare persistente
un consenso che oggi e' solo per la singola esecuzione.

### Fase 94 - Browser form draft per task treno

- Aggiunto piano operativo
  `docs/plans/2026-05-27-browser-form-draft.md`.
- Corretto il limite segnalato dall'utente: il browser apriva i siti ma non
  compilava nessun form.
- Il sidecar browser ora include anche placeholder/id/data-testid/autocomplete
  e title nei nomi dei ref interattivi, mantenendo il testo visibile prima
  dell'id per bottoni e link.
- Il Desktop Gateway estrae una bozza treno conservativa da prompt come
  "Napoli Milano il 10 giugno verso le 9":
  - partenza;
  - arrivo;
  - data;
  - ora.
- Per fonti operatore (`Trenitalia`, `Italo`) il gateway prova a compilare i
  campi riconoscibili con `browser.act` `kind=fill`:
  - non preme Cerca/Continua;
  - non invia form;
  - non fa login;
  - non effettua acquisti o pagamenti.
- L'approval iniziale ora esplicita che autorizza solo lettura e compilazione
  bozza senza invio; click/submit/login/pagamenti restano fuori e richiedono
  un livello successivo.
- Aggiunti checkpoint Computer locale:
  - `browser_form_draft_started`;
  - `browser_form_draft_completed`;
  - `browser_form_draft_blocked`.
- La risposta finale distingue tra:
  - form compilato in bozza;
  - form non compilabile per campi non riconoscibili;
  - fonti non raggiungibili;
  - prossimo step con conferma esplicita.
- Test aggiunti:
  - estrazione bozza treno;
  - mapping ref semantici verso campi form senza submit;
  - snapshot sidecar con placeholder.
- Verifiche:
  - `cargo test -p local-first-desktop-gateway`;
  - `npm --prefix runtimes/browser-automation test`;
  - `npm --prefix runtimes/browser-automation run typecheck`;
  - `npm --prefix apps/desktop run typecheck`;
  - `npm --prefix apps/desktop run test:ui-contract`;
  - `npm --prefix apps/desktop run build`;
  - `git diff --check`.
- Smoke tecnico live:
  - Trenitalia espone `partenza` e `arrivo` come textbox;
  - `browser.act fill` compila la bozza almeno su quei campi;
  - Italo in headless ha restituito `ERR_HTTP2_PROTOCOL_ERROR`, quindi resta
    trattato come fonte non raggiungibile in quella sessione.

Perche': il primo browser operativo non puo' limitarsi a "guardare" pagine.
Serve un livello intermedio sicuro tra lettura e azioni mutative: compilare una
bozza visibile senza avanzare workflow, cosi' l'utente vede progresso reale ma
mantiene controllo su click, submit e acquisti.

### Fase 95 - Browser controller pulito ispirato a Homun

- Allineato il progetto alla decisione dell'utente: Homun e' un riferimento
  interno da cui prendere il browser funzionante, ma non va copiato interamente
  perche' l'obiettivo e' una versione piu' pulita e meno complessa.
- Il piano operativo e' in
  `docs/plans/2026-05-27-homun-inspired-browser-controller.md`.
- Il sidecar `runtimes/browser-automation` ora tratta `fill_form` come azione
  batch reale:
  - compila piu' campi in una sola chiamata;
  - restituisce `filledRefs` e `failedRefs`;
  - fallisce solo se nessun campo viene compilato.
- `browser.act` supporta anche `snapshot_after` snake_case oltre a
  `snapshotAfter`, cosi' Rust e TypeScript restano allineati.
- Snapshot automatico esteso a `press_key`, `select_option` e `scroll`, oltre a
  `click` e `type`.
- La policy Rust ora blocca `press_key` con `Enter`/`Return`, mentre consente
  `fill_form` come bozza non-submit.
- Il Desktop Gateway usa `fill_form` batch per la bozza treno e traduce il
  risultato in campi compilati/falliti, invece di orchestrare ref per ref.
- Test aggiunti/aggiornati:
  - `fill_form` batch su fixture locale;
  - `type` che fa emergere autocomplete;
  - `select_option`;
  - mapping risultato batch nel gateway;
  - policy per `press_key`.
- Verifiche:
  - `npm --prefix runtimes/browser-automation test`;
  - `npm --prefix runtimes/browser-automation run typecheck`;
  - `cargo test -p local-first-browser-automation`;
  - `cargo test -p local-first-desktop-gateway`.

Perche': il gateway non deve conoscere tutti i dettagli del DOM. Deve chiedere
al browser capability azioni operative alte e ricevere snapshot/risultati
redatti. Questo ci avvicina al comportamento funzionante di Homun mantenendo
una base piu' semplice da far crescere.

### Fase 96 - Approval URL e modalita browser

- Portata nel progetto una seconda idea utile da Homun: approval URL con scelta
  tra singola esecuzione e regola persistente.
- Aggiunto `BrowserUrlPolicyStore` in `crates/browser-automation`:
  - SQLite locale;
  - regole per `user_id`, `workspace_id`, origin URL e azione;
  - scope `once` non persistito;
  - scope `always` persistito;
  - modalita browser `auto`, `visible`, `headless`.
- Il Desktop Gateway apre `browser-url-policy.sqlite` sotto
  `~/.local-first-personal-assistant`, configurabile con
  `LOCAL_FIRST_BROWSER_POLICY_DB`.
- L'endpoint approve accetta ora opzioni opzionali:
  - `scope`;
  - `browser_visibility`.
- Quando l'utente approva `always`, il gateway salva regole locali per i domini
  coinvolti nel task browser corrente.
- Se tutti i domini browser del task sono gia' approvati, il task puo' evitare
  la nuova approval iniziale di sola navigazione/bozza.
- La scelta `visible/headless/auto` viene salvata nel checkpoint del task e
  usata per impostare `BROWSER_AUTOMATION_HEADLESS` quando parte il sidecar.
- La UI approval inline mostra:
  - `Solo questa volta`;
  - `Sempre per questi URL`;
  - `Auto`;
  - `Visibile`;
  - `Headless`.
- Test aggiunti:
  - normalizzazione origin URL;
  - grant `once` non persistente;
  - grant `always` persistente con visibility.

Perche': l'utente deve poter ridurre conferme ripetitive senza perdere
controllo. Le regole sono locali, scoped per dominio/azione e non autorizzano
submit, login, pagamento o invio dati: quei passaggi restano approval separate.

### Fase 97 - Operational-first per task autonomi

- Corretto un errore di direzione UX: per richieste operative non deve partire
  prima una normale risposta Gemma che chiede preferenze generiche.
- Aggiunto endpoint gateway
  `/api/chat/threads/{thread_id}/messages/submit_operational_prompt`:
  - se il prompt richiede azioni locali, salva il messaggio utente;
  - aggiunge un acknowledgement operativo;
  - crea task, approval e sessione Computer locale;
  - lascia al worker/executor la risposta finale con dati raccolti.
- La UI Electron prova prima il percorso operativo; se il gateway risponde che
  non e' un task, usa la chat Gemma in streaming come prima.
- Per i task treno il browser ora prova a proseguire oltre la sola bozza:
  - compila i form riconoscibili;
  - cerca un controllo sicuro di ricerca risultati;
  - preme solo controlli tipo `Cerca`/`Mostra risultati`;
  - blocca login, registrazione, acquisto, pagamento, prenotazione finale o
    invio dati sensibili.
- La risposta finale treno diventa proattiva: se legge opzioni, le evidenzia e
  chiede quale l'utente vuole prenotare, invece di fermarsi a "posso
  procedere".
- Aggiornata la copy dell'approval: autorizza lettura, compilazione form e
  ricerca risultati, ma non autorizza login, scelta finale, pagamento o acquisto.
- Test aggiunti:
  - policy click ricerca sicura contro click di acquisto/pagamento;
  - acknowledgement operativo per richiesta treno;
  - risposta finale che chiede quale opzione prenotare.
- Verifiche:
  - `cargo test -p local-first-desktop-gateway`;
  - `npm --prefix apps/desktop run typecheck`;
  - `npm --prefix apps/desktop run test:ui-contract`;
  - `git diff --check`.

Perche': l'assistente deve essere autonomo fino al punto sicuro. Il flusso
corretto e': capire la richiesta, usare strumenti locali, raccogliere dati,
formattare la risposta e chiedere conferma sulla decisione successiva. Chiedere
preferenze prima di aver raccolto opzioni reali rende il prodotto equivalente a
una ricerca manuale.

### Fase 98 - Piano operativo persistente per browser task

- Analizzato Homun come riferimento interno per il flusso operativo:
  - cognition plan-first;
  - piano esplicito con criteri di successo;
  - browser task come loop continuo, non come sotto-task indipendenti;
  - completion solo dopo verifica del risultato.
- Aggiunto nel Desktop Gateway un primo `OperationalPlan` serializzabile:
  - `intent_type`;
  - autonomia;
  - tool previsti;
  - step con stato;
  - vincoli;
  - success criteria;
  - stop conditions;
  - approval gates;
  - schema dati atteso.
- Per richieste treno il piano ora include step espliciti:
  - comprendere tratta/data/orario;
  - aprire fonti;
  - compilare form;
  - cercare opzioni;
  - estrarre risultati;
  - rispondere chiedendo quale opzione prenotare.
- Il piano viene salvato in `TaskRecord.input_json` e nei checkpoint redatti,
  cosi' UI e read model possono mostrare cosa il sistema sta tentando di fare.
- L'approval iniziale ora riassume il piano e i gate, invece di chiedere una
  conferma generica.
- Il task treno non viene piu' marcato completato se non estrae almeno una
  opzione leggibile. In quel caso:
  - la risposta non dice "ricerca completata";
  - il checkpoint contiene `success_criteria_met=false`;
  - il task va in `waiting_external_event` con motivo esplicito;
  - il Computer locale resta consultabile con snapshot/artifact.
- Test aggiunti:
  - piano treno con step/gate/success criteria;
  - criteri di successo treno negativi se non ci sono opzioni;
  - criteri di successo positivi solo con righe opzione contenenti orario e
    operatore/tratta.
- Verifica:
  - `cargo test -p local-first-desktop-gateway`.

Perche': il bug osservato dall'utente non era UI ma architettura: senza un
piano operativo verificabile l'executor puo' solo aprire pagine e sintetizzare,
anche quando non ha davvero ottenuto il risultato. Questo e' il primo taglio
per sostituire gli hardcoded executor con un browser loop guidato da piano.

### Fase 99 - Browser task end-to-end con prompt completo e risultati reali

- Corretto un bug bloccante del flusso operativo: il `TaskRecord.goal` resta
  volutamente compatto per UI/privacy, ma l'executor browser usava quel titolo
  troncato come sorgente di verita'. Ora il task salva `prompt_redacted` in
  `input_json` e l'executor usa `task_effective_goal()` per planning, target,
  parsing tratta/data/orario e risposta finale.
- Aggiunto un `TaskExecutorRegistry` nel Desktop Gateway per evitare dispatch
  fragile via string matching e preparare il wiring uniforme di browser,
  capability, subagent e fallback legacy.
- Aggiunto `PlanContextStore` lato task-runtime per risolvere gli output dei
  task dipendenti dai checkpoint redatti, primo pezzo per piani multi-step con
  passaggio stato esplicito.
- Migliorato il browser sidecar:
  - attende stabilizzazione pagina dopo click/snapshot;
  - supporta `selectOption` per campi select/combobox;
  - test fixture con risultati client-side ritardati.
- Per il caso treni:
  - aggiunto target TrovaTreno come fonte aggregatrice leggibile;
  - compilazione stazioni con preferenza per `Napoli Centrale` e
    `Milano Centrale`;
  - URL risultati diretto con `data=2026-06-10` e `ora=09%3A00`;
  - parsing righe compatte tipo `FR 9310 08:55 13:54`;
  - risposta finale non sovrastima fonti senza opzioni affidabili.
- Test reale via gateway/Electron headless eseguito sul prompt:
  `Devo prenotare un treno Napoli Milano il 10 giugno verso le 9, trova opzioni ma non acquistare nulla`.
  Risultato: task completato, TrovaTreno aperto con data/orario corretti,
  47 treni trovati, opzioni estratte (`FR 9310 08:55 13:54`,
  `IT 9924 09:20 14:09`, `FR 9524 08:40 13:39`, ecc.), nessun login,
  acquisto o pagamento.
- Verifiche:
  - `cargo fmt --all`;
  - `cargo test -p local-first-desktop-gateway`;
  - `npm --prefix apps/desktop run typecheck`;
  - `npm --prefix runtimes/browser-automation run typecheck`;
  - `npm --prefix runtimes/browser-automation test -- tests/browser_fixture.test.ts`.

Perche': il sistema deve agire come agente autonomo fino al prossimo gate
realmente sensibile. L'utente non deve approvare micro-step inutili ne'
ricevere una risposta che dice "ho cercato" senza opzioni verificabili.

### Fase 100 - Piano operativo ispezionabile per capire dove si blocca l'agente

- Problema osservato: dal comportamento UI non era chiaro se il fallimento
  fosse dovuto al modello, al piano, al browser o a un singolo sito. Il piano
  precedente era troppo macro (`compilare form`, `cercare opzioni`) e non
  permetteva di capire se l'agente avesse davvero tentato TrovaTreno,
  Trenitalia e Italo.
- Il piano treno ora viene generato come tasklist dettagliata per fonte:
  - aprire ricerca web;
  - aprire, compilare, cercare ed estrarre da TrovaTreno;
  - aprire, compilare, cercare ed estrarre da Trenitalia;
  - aprire, compilare, cercare ed estrarre da Italo;
  - consolidare opzioni;
  - rispondere e chiedere il prossimo gate.
- Ogni step ha un id stabile (`source_trovatreno_search`,
  `source_trenitalia_extract`, `source_italo_fill`, ecc.) e stato leggibile:
  `[ ]` pending, `[-]` running, `[x]` done, `[!]` blocked.
- Ogni checkpoint di avanzamento ora include anche
  `operational_plan_markdown`, cosi' possiamo leggere il piano senza
  interpretare JSON.
- A fine task viene creato un artifact markdown locale
  `artifact_<task>_operational_plan`, insieme allo screenshot browser.
- Test reale eseguito sul prompt treno:
  - TrovaTreno: aperto, compilato, ricerca avviata, opzioni estratte;
  - Trenitalia: aperto e compilato, ma estrazione opzioni bloccata per assenza
    di righe affidabili nello snapshot;
  - Italo: aperto, ma compilazione bloccata per assenza di campi form
    riconoscibili;
  - task completato perche' il criterio minimo e' soddisfatto da TrovaTreno
    con opzioni reali.
- Verifiche:
  - `cargo fmt --all`;
  - `cargo test -p local-first-desktop-gateway`;
  - `npm --prefix apps/desktop run typecheck`.

Perche': prima di migliorare la capacita' dell'agente dobbiamo poter osservare
il suo ragionamento operativo. Se fallisce, deve essere ovvio se il problema e'
nel piano, nel tool, nel sito o nel criterio di successo.

### Fase 101 - Piano operativo visibile nella UI

- Verifica sul task reale dell'utente:
  - il backend aveva creato il piano dettagliato e l'artifact markdown;
  - la UI continuava a sembrare uguale perche' il read model del Computer
    locale esponeva solo titolo/sottotitolo degli eventi e scartava il markdown
    del piano.
- Aggiunto `markdown_redacted` agli item della timeline del read model locale.
- La redazione del markdown ora preserva le righe, invece di comprimere tutta
  la tasklist in una singola riga; altrimenti la UI non puo' parsare gli step.
- La Chat UI ora mostra un riquadro `Piano operativo` sotto la risposta, con:
  - conteggio step completati/bloccati;
  - step bloccati principali;
  - step chiave come estrazione TrovaTreno, Trenitalia e Italo.
- Verifica visuale con Playwright su `http://127.0.0.1:1420/`:
  il riquadro `Piano operativo` appare e mostra `12 completati · 4 bloccati`,
  con blocchi su `Estrarre opzioni da Trenitalia`, `Compilare Italo`,
  `Cercare risultati su Italo`, `Estrarre opzioni da Italo`.
- Verifiche:
  - `cargo fmt --all`;
  - `cargo test -p local-first-local-computer-session`;
  - `cargo test -p local-first-desktop-gateway`;
  - `npm --prefix apps/desktop run typecheck`.

Perche': senza visibilita' del piano l'utente non puo' capire se il sistema ha
ragionato male o se uno specifico tool/sito si e' bloccato.

### Fase 102 - Diagnosi browser confrontata con Homun

- Analizzato Homun in dettaglio:
  - `src/tools/browser.rs` usa un BrowserTool unico sopra Playwright MCP;
  - ogni `navigate`, `click`, `type`, `scroll` restituisce uno snapshot fresco;
  - il tool compatta lo snapshot, annota l'ordine dei campi, rileva banner
    privacy/cookie, gestisce ref stale, loop/stuck state e switch
    headless/visible;
  - `BrowserTaskPlanState` decide approval URL, modalita' headless/visible,
    retry budget e loop detection.
- Diagnosi sul nostro executor:
  - il browser sidecar era gia' capace di snapshot dopo alcune azioni, ma il
    gateway calcolava i campi form prima dell'autocomplete delle stazioni e
    tentava poi un batch fill su ref/stato non piu' affidabile;
  - Trenitalia espone data e ora come `button`/widget calendario, non come
    textbox/combobox compilabili; quindi riusciamo a selezionare le stazioni,
    ma lasciamo data e ora di default;
  - Italo, dopo accettazione cookie, espone i controlli principali come
    `button`/widget custom; non ci sono textbox affidabili per partenza/arrivo
    nello snapshot del nostro sidecar.
- Correzioni applicate:
  - `fill_form` nel sidecar ora produce snapshot automatico come pattern Homun;
  - lo snapshot non classifica piu' `input type=button` come textbox;
  - i nomi campo includono anche `value`, label associate e testo vicino;
  - il gateway accetta banner privacy/cookie safe (`Accetta`/`Accept all`) e
    acquisisce snapshot aggiornato;
  - dopo autocomplete stazioni il gateway rivaluta i campi form dalla pagina
    aggiornata e salva checkpoint `browser_form_fields_refreshed` con
    candidate refs.
- Test reale dopo le correzioni:
  - TrovaTreno resta completo e produce 47 opzioni;
  - Trenitalia: cookie accettato, stazioni selezionate, ma data/orario restano
    widget button (`28 Mag 2026`, `Seleziona orario 8:00`) e richiedono un
    loop azione->snapshot->decisione o adapter specifico;
  - Italo: cookie accettato, i campi visibili nel testo pagina non sono esposti
    come textbox/combobox compilabili; l'executor deterministico quindi blocca
    correttamente invece di fare fill su un bottone.
- Verifiche:
  - `npm --prefix runtimes/browser-automation run typecheck`;
  - `npm --prefix runtimes/browser-automation test`;
  - `cargo fmt --all`;
  - `cargo test -p local-first-desktop-gateway`;
  - run reale gateway sul prompt Napoli-Milano 10 giugno ore 9.

Perche': il problema non e' Gemma e non e' solo Playwright. Il blocco nasce
dal fatto che il nuovo progetto ha un executor browser deterministico troppo
semplice, mentre Homun usava un loop operativo con snapshot fresco dopo ogni
azione e guard decisionale. La prossima implementazione deve portare quel
pattern, non aggiungere altri riconoscimenti hardcoded sito per sito.

### Fase 103 - Analisi dettagliata OpenClaw browser automation

- Clonato OpenClaw in `/tmp/openclaw` e analizzato il commit
  `00fb15253cbdfacec3cd2c34a22ace4d753c6184`.
- Creato report:
  `docs/research/2026-05-28-openclaw-browser-automation-analysis.md`.
- Confermato che OpenClaw usa un singolo tool modello `browser` con schema
  action-based (`open`, `snapshot`, `act`, `tabs`, `screenshot`, `dialog`,
  ecc.), non un set di executor hardcoded per sito.
- Pattern principale:
  - `snapshot` prima di agire;
  - azione stretta via `act`;
  - stesso `targetId`;
  - ref Playwright `aria-ref` quando possibile;
  - nuovo snapshot dopo azione/navigazione/modale;
  - recovery esplicita su ref stale e dialog blocker.
- Dettaglio tecnico rilevante:
  - OpenClaw usa `page.ariaSnapshot({ mode: "ai" })` e preserva refs `eN`;
  - `refLocator()` risolve refs con `page.locator("aria-ref=eN")`;
  - fallback role/name usa `getByRole(... exact: true)` e `nth` per duplicati;
  - le routes `/act` e `/snapshot` applicano policy URL, dialog state e
    controllo post-navigazione.
- Diagnosi aggiornata:
  - il nostro blocco su Trenitalia/Italo non si risolve con altre regex sui
    campi;
  - serve portare il browser operating loop OpenClaw/Homun:
    `snapshot -> decide action -> act -> snapshot -> verify -> next action`.
- Decisione:
  - prossimo lavoro browser: aggiungere snapshot AI/aria refs al sidecar,
    poi spostare la logica fuori da `desktop-gateway/src/main.rs` verso un
    `browser_loop` guidato dal piano e validato da policy.

Perche': OpenClaw conferma la stessa lezione vista in Homun. Il browser non va
trattato come "compila questi campi una volta"; va trattato come una sessione
stateful osservabile, con il modello/controller che decide un passo alla volta
su snapshot corrente e il core che valida sicurezza e completamento.

### Fase 104 - Primo porting concreto OpenClaw/Homun browser loop

- Aggiornato `runtimes/browser-automation`:
  - `browser.snapshot` usa di default Playwright
    `page.ariaSnapshot({ mode: "ai" })`;
  - i refs Playwright `eN` vengono preservati e risolti con
    `page.locator("aria-ref=eN")`;
  - resta fallback legacy DOM/locator se lo snapshot AI fallisce;
  - la risposta snapshot ora include `refsMode`, `snapshotFormat` e `stats`;
  - `browser.act` continua a produrre snapshot fresco post-azione e ora ritorna
    anche metadati di formato/ref.
- Estesa la fixture browser locale:
  - autocomplete stazione;
  - date picker custom aperto da bottone;
  - risultati asincroni post-click.
- Aggiunto test sidecar che verifica il loop reale:
  - snapshot AI;
  - type su campo autocomplete via ref;
  - nuovo snapshot con suggerimento;
  - click suggerimento via `aria-ref`;
  - click date picker;
  - selezione data da snapshot aggiornato.
- Aggiunto `crates/browser-automation/src/browser_loop.rs`:
  - `BrowserLoopRequest`;
  - `BrowserObservation`;
  - `BrowserLoopDecision`;
  - `BrowserLoopPlanner`;
  - `BrowserLoopRunner`;
  - `BrowserLoopIteration`;
  - payload compatto per audit senza dump raw snapshot.
- Il loop Rust impone il contratto corretto:
  - opzionale `browser.open`;
  - `browser.snapshot` con `snapshot_format=ai` e `refs_mode=aria`;
  - una sola `browser.act` per iterazione;
  - `snapshot_after=true` forzato dal runner;
  - decisione successiva solo dopo nuova osservazione.
- Verifiche:
  - `npm run typecheck` in `runtimes/browser-automation`;
  - `npm test` in `runtimes/browser-automation`: 31 test verdi;
  - `cargo test -p local-first-browser-automation`: 20 test verdi;
  - `cargo test -p local-first-desktop-gateway train -- --nocapture`: 8 test
    train/gateway verdi.

Perche': questo non completa ancora il task reale Trenitalia/Italo, ma cambia
il basamento tecnico nel punto giusto. Ora il sidecar espone refs Playwright AI
come OpenClaw e il core ha un runner che impedisce il vecchio errore
"calcolo campi una volta e provo batch fill". Il prossimo passaggio e' cablare
questo runner al gateway/Brain per sostituire il blocco legacy dentro
`desktop-gateway/src/main.rs`.

### Fase 105 - Gateway cablato al browser loop controller

- Aggiunto `crates/desktop-gateway/src/browser_loop_controller.rs`.
- Il modulo introduce `RuntimeBrowserLoopPlanner`:
  - usa il runtime locale Gemma via `JsonRuntime`;
  - costruisce un prompt operativo con goal, URL, snapshot AI corrente,
    hash, ref mode e iterazioni recenti;
  - il modello puo' restituire solo `act`, `complete` o `blocked`;
  - la risposta viene validata prima di passare al browser;
  - azioni ammesse: `click`, `type`, `press_key`, `select_option`, `scroll`,
    `wait`;
  - refs non presenti nello snapshot corrente vengono rifiutati.
- Il gateway ora usa il nuovo percorso per task treno/browser quando
  `LOCAL_FIRST_BROWSER_LOOP_CONTROLLER` non e' `0`/`false`.
- Il percorso legacy resta disponibile disattivando:
  `LOCAL_FIRST_BROWSER_LOOP_CONTROLLER=0`.
- `execute_browser_loop_read_only_task`:
  - avvia sidecar browser;
  - usa `BrowserLoopRunner::from_client`;
  - apre fonti con target id stabile;
  - fa decidere una micro-azione per volta a Gemma;
  - salva checkpoint compatti `browser_loop_iteration`;
  - produce screenshot e piano operativo come prima;
  - marca completion solo se il loop produce output o success criteria reali.
- Verifiche:
  - `cargo test -p local-first-desktop-gateway browser_loop_controller -- --nocapture`;
  - `cargo test -p local-first-desktop-gateway`: 36 test verdi;
  - `cargo test -p local-first-browser-automation`: 20 test verdi;
  - `npm run typecheck` in `runtimes/browser-automation`;
  - `npm test` in `runtimes/browser-automation`: 31 test verdi.
- Stato runtime reale:
  - Gemma non era inizialmente in ascolto su `127.0.0.1:8765`;
  - avvio manuale con `.venv-mlx/bin/python runtimes/mlx-gemma4/server.py`;
  - `/health` OK con modello non caricato;
  - `/warmup` OK: `load_seconds=3.548`, `elapsed_seconds=4.742`;
  - processo chiuso dopo la verifica per non lasciare runtime appesi.
  - non e' ancora stato eseguito un test live sui siti reali con il planner
    Gemma, perche' va fatto tramite gateway/app per salvare artifact e
    timeline leggibili.

Perche': questo e' il primo cablaggio reale del loop OpenClaw/Homun nel gateway.
Il vecchio batch-fill non e' piu' il percorso principale per i task treno: il
controller vede uno snapshot corrente, sceglie una sola azione, poi aspetta un
nuovo snapshot prima di proseguire. Rimane da fare il test live con Gemma
avviato e correggere il prompt/azioni sulla base degli artifact reali, non a
tentativi ciechi.

### Fase 106 - Test reale browser loop e primo task treno end-to-end

- Eseguito test gateway reale con Gemma caldo e browser visibile su:
  `Devo prenotare un treno Napoli Milano il 10 giugno verso le 9, trova opzioni ma non acquistare nulla`.
- Prima prova fallita in modo utile:
  - il task rimaneva `running` per troppo tempo;
  - il planner inviava snapshot troppo grandi a Gemma;
  - ogni decisione costava migliaia di token di prefill;
  - il loop poteva chiudere una fonte senza opzioni reali.
- Correzioni introdotte:
  - snapshot decisionale compatto in `browser_loop_controller`;
  - solo ultime tre iterazioni nel prompt planner;
  - `browser.snapshot` AI limitato a `max_chars`;
  - fonti treno ordinate prima su fonti dirette, poi ricerca web;
  - TrovaTreno aperto con URL parametrizzato da draft tratta/data/ora;
  - completion valida solo con opzioni treno verificate;
  - fallback di estrazione righe risultato dallo snapshot quando il planner non
    chiude esplicitamente ma i risultati sono visibili;
  - pulizia delle righe risultato per non mostrare refs/snapshot raw o CTA di
    acquisto.
- Test reale finale:
  - approval piano richiesta e approvata;
  - browser ha aperto TrovaTreno con
    `da=Napoli+Centrale`, `a=Milano+Centrale`, `data=2026-06-10`,
    `ora=09:00`;
  - risposta finale prodotta in chat con opzioni reali:
    Frecciarossa 08:55, Italo 09:20, Frecciarossa 08:40, Frecciarossa 08:25,
    Italo 08:20, Frecciarossa 09:55, Frecciarossa 09:56, Frecciarossa 07:45;
  - nessun login, selezione treno, pagamento o acquisto;
  - task queue finale vuota, nessuna approval pendente.
- Verifiche:
  - `cargo test -p local-first-desktop-gateway train -- --nocapture`;
  - `cargo test -p local-first-desktop-gateway browser_loop_controller -- --nocapture`;
  - `cargo test -p local-first-browser-automation browser_loop -- --nocapture`;
  - test live gateway + Gemma + browser reale su dati TrovaTreno.

Perche': questo e' il primo caso in cui il flusso operativo arriva davvero a
una risposta utile end-to-end. Non e' ancora un agente browser generale:
Trenitalia/Italo restano piu' fragili e il loop deve ancora avere progress
streaming durante l'esecuzione. Pero' il criterio corretto e' ora stabilito:
non si dichiara successo senza risultati reali e la risposta finale e' il
centro dell'esperienza, con Computer locale come audit.

### Fase 107 - Prova diretta via sistema su Trenitalia e ItaloTreno

- Richiesta utente: testare tramite il nostro sistema, non con Playwright
  esterno, due prompt separati:
  - `Guarda direttamente su Trenitalia treni Napoli Milano il 10 giugno verso
    le 9, trova opzioni ma non acquistare nulla`;
  - `Guarda direttamente su ItaloTreno treni Napoli Milano il 10 giugno verso
    le 9, trova opzioni ma non acquistare nulla`.
- Primo problema trovato e corretto:
  - i prompt con `Guarda direttamente su Trenitalia/ItaloTreno...` creavano un
    piano browser corretto, ma `task_kind_for_prompt` li classificava come
    `local_task`;
  - risultato: il worker completava subito senza aprire browser;
  - fix: `task_kind_for_prompt` e `resources_for_prompt` ora riconoscono
    `trova opzioni`, `treno`, `trenitalia`, `italo`;
  - test aggiunto in
    `operational_prompt_prefilter_is_conservative_but_task_aware`.
- Routing fonti:
  - se il prompt cita solo Trenitalia, il target e' solo Trenitalia;
  - se il prompt cita solo Italo/ItaloTreno, il target e' solo Italo;
  - test aggiunto in `explicit_train_operator_request_uses_only_that_source`.
- Test reale dopo il fix:
  - Entrambi i task sono diventati `browser_task`;
  - approvazione piano richiesta e approvata;
  - nessun login, acquisto o pagamento.
- Esito Trenitalia:
  - aperto `https://www.trenitalia.com/`;
  - il loop ha cliccato ripetutamente lo stesso ref (`e89`) senza progresso;
  - poi ha digitato Napoli/Milano/data nello stesso ref (`e103`) invece di
    avanzare sui campi giusti;
  - dopo 10 iterazioni: `max browser loop iterations reached`;
  - task concluso come `waiting_external_event`, senza inventare risultati.
- Esito ItaloTreno:
  - aperto `https://www.italotreno.com/it`;
  - il loop ha iniziato a digitare partenza/arrivo;
  - ha gestito cookie solo dopo alcuni input;
  - ha cliccato ripetutamente lo stesso controllo search-like (`e118`);
  - non ha gestito data/ora in modo affidabile;
  - dopo 10 iterazioni: `max browser loop iterations reached`;
  - task concluso come `waiting_external_event`, senza inventare risultati.
- Verifiche:
  - `cargo test -p local-first-desktop-gateway operational_prompt_prefilter_is_conservative_but_task_aware -- --nocapture`;
  - `cargo test -p local-first-desktop-gateway train -- --nocapture`;
  - test live gateway + Gemma + browser reale per Trenitalia e ItaloTreno.

Perche': il test chiarisce il prossimo problema reale. Il loop generico ora
parte sulla fonte richiesta, ma Gemma non basta come unico controller per form
complessi: servono guardie deterministiche di progresso, riconoscimento campi
per nome/ruolo, gestione cookie prima della compilazione, e step planner piu'
vincolati per data/ora/autocomplete. TrovaTreno funziona perche' URL e risultati
sono leggibili; Trenitalia/Italo richiedono adapter browser/form piu' solidi.

### Fase 108 - Porting mirato del contratto browser OpenClaw

- L'utente ha chiarito che OpenClaw funziona bene e che dobbiamo copiarne la
  meccanica operativa, non continuare a fare tentativi casuali.
- Analisi locale su `/tmp/openclaw`:
  - licenza MIT;
  - estensione browser basata su Playwright/CDP;
  - snapshot AI/aria con ref persistenti;
  - azioni validate (`click`, `type`, `fill`, `select`, `wait`, `batch`);
  - snapshot dopo le azioni;
  - stale-ref recovery esplicitata nelle skill;
  - timeout bounded e guardie contro navigazioni/azioni pericolose;
  - `urls=true` per includere link visibili nello snapshot quando serve
    disambiguare la navigazione.
- Porting fatto nel nostro runtime:
  - il planner browser ora puo' usare `fill_form` con piu' campi visibili in
    un'unica micro-azione;
  - validazione lato gateway: ogni campo di `fill_form` deve avere ref presente
    nello snapshot corrente e valore stringa;
  - il prompt del controller esplicita che, davanti a piu' campi dello stesso
    form, deve preferire `fill_form` invece di una sequenza fragile di `type`;
  - il runner browser ora marca iterazioni `no_progress` quando URL e snapshot
    hash non cambiano dopo un'azione;
  - dopo due iterazioni senza progresso il loop si blocca con motivo esplicito,
    invece di consumare tutte le iterazioni cliccando lo stesso controllo;
  - snapshot browser supporta `urls=true`, appende i link visibili e accetta ref
    Playwright non solo nel formato `eN`;
  - il loop richiede snapshot AI con `urls=true`.
  - il loop espone un observer per iterazione: il gateway ora salva checkpoint
    Computer locale mentre l'azione avviene, non solo a fine fonte.
- Test aggiunti:
  - loop si ferma dopo azioni ripetute senza progresso;
  - il controller accetta `fill_form` solo con ref correnti;
  - il controller rifiuta `fill_form` con ref stale;
  - il runtime browser include link visibili nello snapshot con `urls=true`.
- Verifiche passate:
  - `npm run typecheck` in `runtimes/browser-automation`;
  - `npm test -- --run` in `runtimes/browser-automation` (32 test);
  - `cargo test -p local-first-browser-automation --test browser_loop -- --nocapture`;
  - `cargo test -p local-first-desktop-gateway browser_loop_controller -- --nocapture`;
  - `cargo test -p local-first-desktop-gateway train -- --nocapture`.

Perche': questo porta dentro il pezzo piu' importante del pattern OpenClaw:
un browser tool con contratto stretto, snapshot freschi, ref validati e blocco
esplicito quando non c'e' progresso. Non rende ancora Trenitalia/Italo
production-ready, ma elimina il comportamento peggiore: loop ciechi e azioni
monocampo quando il form espone piu' controlli compilabili.

### Fase 109 - OpenClaw come riferimento browser principale

- Chiarimento utente: OpenClaw funziona bene, e la licenza consente il riuso;
  quindi non dobbiamo limitarci a prendere spunti superficiali.
- Decisione registrata:
  - `docs/decisions/0006-openclaw-browser-runtime-reference.md`;
  - OpenClaw diventa il riferimento principale per il browser runtime;
  - possiamo riusare metodologia e codice MIT, mantenendo notice/attribuzione
    quando copiamo parti sostanziali.
- Piano operativo registrato:
  - `docs/plans/2026-05-28-openclaw-browser-parity.md`;
  - sequenza: hardening sidecar, recovery rules, fixture parity tests, real-site
    validation, UI/observability.
- Roadmap aggiornata:
  - il prossimo blocco non e' piu' "aggiungere euristiche sito-specifiche";
  - il prossimo blocco e' parita' metodologica OpenClaw: action schema,
    stale-ref recovery, cookie/banner preflight, tab hygiene, dialog blocker,
    wait predicates bounded e extractor strutturati.

Perche': serve una direzione unica. Il progetto nasce per essere piu' pulito di
Homun, ma non deve reinventare un browser agent da zero quando OpenClaw ha gia'
un modello libero e testato. Il vincolo resta: porting a slice, senza importare
tutta la complessita' del loro plugin system.

### Fase 110 - Primo slice di parita' OpenClaw nel runtime browser

- Esteso il runtime browser Playwright con primitive operative piu' vicine a
  OpenClaw:
  - `hover`;
  - `scroll_into_view`;
  - `wait` con `text`, `textGone`, `selector`, `url`, `loadState`, timeout
    bounded e delay bounded;
  - `batch` con limite di profondita' e numero massimo di azioni.
- Aggiunta normalizzazione errori nel sidecar:
  - timeout classificato come `BROWSER_ACTION_TIMEOUT`;
  - dialog come `BROWSER_DIALOG_BLOCKED`;
  - ref stale resta `BROWSER_STALE_REF`;
  - batch troppo grande/profondo come errore non retryable.
- Il sidecar ora restituisce snapshot fresco anche dopo hover, scroll,
  scroll-into-view, wait e batch, cosi' il loop non ragiona su DOM vecchio.
- Aggiunto preflight sidecar per overlay cookie/consenso comuni:
  - preferisce rifiuto/solo necessari quando disponibile;
  - gestisce OneTrust (`#onetrust-reject-all-handler`,
    `#onetrust-accept-btn-handler`) anche quando il banner non emerge come ref
    utile nello snapshot AI;
  - viene eseguito su open, navigate, snapshot e act.
- Aggiornata la policy Rust:
  - azioni osservative (`hover`, `scroll_into_view`, `wait`) non richiedono
    approval;
  - `batch` eredita approval se contiene azioni manuali come click o submit.
- Aggiornato il browser loop:
  - se un'azione fallisce con `BROWSER_STALE_REF`, il runner fa snapshot
    immediato, registra `stale_ref_recovered` e continua con refs correnti;
  - il prompt del controller ora spiega cookie/banner preflight, hover,
    scroll_into_view e stale-ref recovery.
- Test aggiunti:
  - fixture browser per hover, scroll_into_view, rich wait e batch;
  - fixture treni end-to-end con cookie banner, autocomplete stazioni, date
    picker, time select, click Cerca, wait asincrono e opzioni estratte;
  - fixture overlay OneTrust-like che dimostra che il click sull'elemento
    sottostante non viene bloccato dal banner;
  - policy Rust per azioni osservative e batch con click;
  - recovery stale-ref nel browser loop;
  - validazione controller per nuove azioni.
- Diagnostica reale:
  - Trenitalia espone oggi nello snapshot AI campi accessibili per partenza,
    arrivo, andata, orario e CERCA;
  - prima del preflight, il click sul suggerimento `Napoli Centrale` veniva
    intercettato da OneTrust;
  - dopo il preflight, la prova diretta su Trenitalia compila/seleziona
    correttamente Napoli Centrale e Milano Centrale;
  - Italo in headless ha fallito in apertura con `ERR_HTTP2_PROTOCOL_ERROR`,
    quindi richiede fallback/profilo browser prima del form.
- Verifiche passate:
  - `npm run typecheck` in `runtimes/browser-automation`;
  - `npm test -- --run` in `runtimes/browser-automation` (37 test);
  - `cargo test -p local-first-browser-automation --test policy -- --nocapture`;
  - `cargo test -p local-first-browser-automation --test browser_loop -- --nocapture`;
  - `cargo test -p local-first-desktop-gateway browser_loop_controller -- --nocapture`;
  - `cargo test -p local-first-desktop-gateway train -- --nocapture`.

Perche': questo chiude il primo gap concreto emerso dalla comparazione con
OpenClaw: il browser deve avere azioni granulari ma robuste, snapshot dopo ogni
azione, errori interpretabili e recovery deterministica su ref stale. Non basta
ancora per Trenitalia/Italo end-to-end: il prossimo pezzo e' completare data,
orario, click CERCA ed estrazione opzioni su Trenitalia, poi introdurre fallback
per Italo quando il browser headless viene rifiutato o chiude la connessione.

### Fase 111 - Fallback automatico headless -> visible per siti che bloccano headless

- Implementato fallback nel `BrowserSessionManager`:
  - `browser.open` e `browser.navigate` provano prima con il profilo corrente;
  - se il profilo assistant e' headless e la navigazione fallisce con errori di
    protocollo/connessione tipici del blocco headless (`ERR_HTTP2_PROTOCOL_ERROR`,
    `ERR_CONNECTION_RESET`, `ERR_EMPTY_RESPONSE`, ecc.), il runtime chiude il
    contesto, riavvia l'assistant profile in visible e ritenta una sola volta;
  - il risultato espone `headless: false` e `fallbackFromHeadless: true`.
- Il fallback non si attiva su timeout generici: una pagina lenta non deve
  aprire automaticamente una finestra visibile.
- Allargato il dismiss overlay per cookie banner con solo pulsante `ACCETTA`.
- Test aggiunti:
  - classificazione errori headless-only;
  - fixture overlay con pulsante `ACCETTA`.
- Diagnostica reale Italo:
  - prima falliva in headless con `ERR_HTTP2_PROTOCOL_ERROR`;
  - ora apre in visible con `fallbackFromHeadless: true`;
  - lo snapshot mostra campi `Parti da`, `Arriva a`, `Andata`, `Passeggeri` e
    `Cerca`;
  - il banner cookie viene rimosso (`hasCookie: false` nella prova).

Perche': questo mantiene l'esperienza autonoma. Se un sito rifiuta headless, il
sistema non deve fermarsi subito: deve passare a browser visibile, rendere
osservabile il computer locale e continuare finche' resta entro i gate sicuri.

### Fase 112 - Port metodologico OpenClaw del browser loop

- Stop ai tentativi sito-specifici come percorso primario: con
  `LOCAL_FIRST_BROWSER_LOOP_CONTROLLER` attivo, `browser_task` passa sempre dal
  loop observe -> act -> observe; il vecchio executor read-only guidato da
  euristiche resta solo fallback.
- Allineato il contratto azioni del sidecar a OpenClaw:
  - aggiunti nomi canonici `fill`, `select`, `press`, `scrollIntoView`,
    `clickCoords`, `evaluate`, `resize`, `close`;
  - mantenuti alias legacy (`fill_form`, `select_option`, `press_key`,
    `scroll_into_view`) per compatibilita';
  - `type` usa typing reale per supportare autocomplete; `fill` usa fill diretto
    per campi stabili.
- Allineato lo snapshot al modello OpenClaw:
  - aggiunti `mode=efficient`, `interactive`, `compact`, `depth`;
  - lo snapshot del browser loop ora include controlli interattivi compatti e
    completi, non piu' filtrati da parole chiave come treni/date/prezzi;
  - questo evita di perdere giorni di calendario, option menu o pulsanti non
    previsti dalle euristiche.
- Aggiornato il planner Rust:
  - prompt OpenClaw-style: stable tab, latest refs, one action, narrow act,
    blocker esplicito, niente login/dati personali/pagamenti senza gate;
  - azioni ammesse canoniche e schema validato;
  - validazione ref/selector per le azioni compatibili.
- Verifiche passate:
  - `npm run typecheck` in `runtimes/browser-automation`;
  - `npm test -- --run` in `runtimes/browser-automation` (38 test);
  - `cargo test -p local-first-browser-automation -- --nocapture`;
  - `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway browser_loop_controller -- --nocapture`;
  - `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway operational_prompt_prefilter_is_conservative_but_task_aware -- --nocapture`.

Perche': il blocco reale non era "Trenitalia difficile", ma che stavamo ancora
mescolando un loop agentico con euristiche specifiche. OpenClaw funziona perche'
il modello riceve un contratto stabile e snapshot freschi, non perche' conosce
un sito. Il prossimo test deve usare il nostro sistema con Gemma e verificare
direttamente se il planner riesce a seguire questo contratto su Trenitalia e
ItaloTreno; se fallisce, il punto da misurare sara' la capacita' del planner, non
piu' la mancanza delle primitive browser.

### Fase 113 - Fix warmup Gemma per browser loop

- Il test reale diretto su Trenitalia del 28 maggio 2026 alle 15:30 non e'
  fallito per il sito o per Playwright: il checkpoint
  `browser_loop_source_failed` riportava `Connection refused` su
  `http://127.0.0.1:8765/generate_json`.
- Root cause: il browser loop usava Gemma come planner JSON ma non verificava
  ne' avviava il runtime prima di chiamarlo; l'errore veniva poi presentato
  all'utente come fonte non raggiungibile.
- Modificato `crates/desktop-gateway/src/main.rs`:
  - `generate_stream` fa `ensure_runtime_available` prima di chiamare
    `/generate_stream`;
  - `execute_browser_loop_read_only_task` aggiunge checkpoint
    `planner_runtime_starting` e `planner_runtime_ready`;
  - il task executor usa `ensure_runtime_available_for_task` sincrono prima di
    avviare il browser loop;
  - timeout di bootstrap runtime portato a 120s per non fallire durante il
    primo caricamento a freddo del modello.
- Modificato `crates/desktop-gateway/Cargo.toml` per abilitare
  `reqwest/blocking`, necessario al worker sincrono.
- Dopo un nuovo test, trovata una seconda root cause: il process registry
  conservava uno snapshot `running` con PID morto (`2554`), quindi
  `ensure_runtime_started` non rilanciava Gemma e restava fermo in attesa di
  health.
- Modificato `crates/process-manager/src/manager.rs`:
  - per `RuntimeControlStatus::ManagedRunning` verifica lo snapshot reale del
    supervisor;
  - se il processo supervisionato non esiste e la porta runtime non e'
    occupata, registra `Stopped` e avvia un nuovo processo;
  - se esiste un listener esterno, evita duplicati.
- Aggiunto test
  `ensure_runtime_started_recovers_stale_running_snapshot_without_listener`.
- Verifiche passate:
  - `cargo test -p local-first-process-manager --test runtime_control -- --nocapture`;
  - `cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway browser_loop_controller -- --nocapture`;
  - `npm run typecheck` in `apps/desktop`.

Perche': il sistema deve essere autonomo anche nel bootstrap dei propri pezzi
locali. Se il planner non e' pronto, il task non deve mascherare il problema
come fallimento del sito: deve avviare Gemma o mostrare un errore di runtime
esplicito. Il prossimo test su Trenitalia deve distinguere runtime, planner e
browser con checkpoint separati.

### Confronto modelli per il loop + kimi-k2.6 raggiunge i RISULTATI

Pulizia: i run multipli lasciavano sidecar/Chromium ORFANI (il kill del parent
harness non uccideva i figli) -> competizione sul profilo. Da gestire nel
teardown (kill del process-group). Per ora pulizia manuale.

Confronto (loop osserva->agisci, Compact, retry attivo, max_tokens 6000):
- qwen3-vl:235b-cloud: capace ma LENTISSIMO (Full ~impraticabile); 2 iter corrette.
- minimax-m2.7:cloud: reasoning; con max_tokens basso -> content vuoto; con 6000
  una run raggiunse i risultati, ma tende a INCASTRARSI ripetendo lo stesso click.
- kimi-k2.6:cloud: MIGLIORE. reasoning ma JSON affidabile (~16s/call con
  max_tokens 6000). Run: form completo (Napoli/Milano/data/ora) -> handoff ->
  PAGINA RISULTATI lefrecce.it -> scroll dei treni. Stop a iter18 perche' ha
  tentato `evaluate` (JS) -> BLOCCATO dal gate sicurezza, dopo fatica a cliccare
  una card (overlay intercetta il pointer).

CONCLUSIONE: la ricerca Napoli->Milano FUNZIONA end-to-end fino ai risultati,
affidabile, con kimi-k2.6 + i fix loop (retry/resample, max_tokens, Compact).
Ritocchi residui per "raccogli opzioni e fermati": (1) guidare il modello a
ESTRARRE/riportare le opzioni alla results page invece di cliccare i dettagli;
(2) robustezza click su card con overlay (lefrecce); (3) teardown sidecar pulito
(process-group kill). Config consigliata loop: OLLAMA_MODEL=kimi-k2.6:cloud,
BROWSER_CONTEXT_PROFILE=compact, MAX_TOKENS>=6000, PLANNER_TIMEOUT>=120, ATTEMPTS=4.

### kimi + fix #1/#2: teardown OK, no evaluate, ma estrazione opzioni da fare

Run kimi-k2.6 dopo i fix (prompt results-page + no evaluate; teardown graceful):
- TEARDOWN: confermato 0 sidecar / 0 chromium orfani dopo l'uscita (fix Drop:
  chiudi stdin -> sidecar EOF -> manager.stop() -> exit; + handler SIGTERM/SIGINT).
- PROMPT: il modello NON ha piu' tentato evaluate ne' espanso i dettagli.
- Form -> handoff -> RESULTS PAGE lefrecce raggiunta in modo affidabile.
- MA: niente decision:complete; ha scrollato e il guard no_progress ha fermato
  il loop. Le opzioni treno NON emergono nello snapshot COMPACT della SPA
  lefrecce (Aurelia, au-target, rendering dinamico) -> il modello non trova nulla
  da estrarre.

BLOCCO RESIDUO (non modello, non robustezza): qualita' snapshot sulla results
page. Prossimi tentativi: (a) profilo Full SOLO sulla results page (le option row
sopravvivono) o un profilo "results-aware"; (b) wait-for-options piu' lungo (la
SPA carica le soluzioni async; iter con wait 5s e' andato in timeout); (c)
snapshot mirato alla region dei risultati. Config modello confermata: kimi-k2.6.

### OBIETTIVO RAGGIUNTO — ricerca Trenitalia end-to-end con opzioni reali

kimi-k2.6 + profilo FULL (unica variabile cambiata da Compact): completed=true.
Opzioni estratte: FRECCIAROSSA 9310 09:00->14:19 5h19 1 cambio da 67,90€;
FRECCIAROSSA 9628 09:55->14:35 4h40 diretto da 65,90€. Fermato prima della
selezione, come da goal.

TESI VALIDATA (utente): il design era sovra-vincolato per far girare gemma4
(Compact snapshot, regole prescrittive, piano statico, context piccole). Quei
tagli DANNEGGIANO i modelli capaci. Prova: l'unico cambio Compact->Full ha
sbloccato l'estrazione. NB: il profilo e' GIA' auto-selezionato dal
context_window (Full per >=32k); ero io a forzare Compact via env inseguendo la
velocita' del 235B. Default gia' corretto per modelli capaci.

DIREZIONE (capable-first): non forzare Compact; riservare Compact/Minimal ai soli
modelli locali piccoli. Alleggerire le regole del prompt del loop (tenere solo i
guardrail di SICUREZZA: no login/pagamento/dati personali, no evaluate) e dare
piu' contesto. I task `act` statici del Brain restano inadatti all'interazione:
l'interazione va al loop osserva->agisci. Config che funziona: kimi-k2.6, profilo
auto (Full), max_tokens>=6000, timeout>=120, attempts=4.
