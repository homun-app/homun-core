# Decision 0016: Harness-owned task engine — orchestrazione robusta cross-modello

Date: 2026-06-21

## Status

> **EMENDATA dalla [0021](0021-single-guarded-loop-planning-as-tool.md) (2026-06-29).** L'**obiettivo**
> di questa ADR è confermato (l'harness possiede il control flow; deve reggere sul tier locale/debole).
> Il **meccanismo** è corretto: niente motore plan-execute separato, e niente slot-filling JSON
> sull'intero turno (l'evidenza — *"Let Me Speak Freely?"*, *"The Format Tax"* — mostra che forzare
> l'output strutturato **danneggia il ragionamento** dei modelli deboli; il degrado entra dal *prompt*,
> non dal decoder). Si realizza con **un loop unico guardato** + constrained decoding solo
> sull'estrazione finale del tool. Vedi la 0021.

Proposed (originale). Estende e completa la [0008](0008-orchestrator-brain-single-planner.md)
(un solo orchestratore in produzione) aggiungendo il requisito mancante:
**l'orchestrazione deve reggere anche con modelli deboli/locali**, non solo con i
frontier (Claude/GPT/Gemini).

## Il requisito di prodotto (perché questa decisione esiste)

Homun è local-first e multi-modello. La tesi di prodotto:

> Una risposta **scadente** data da un modello meno potente è accettabile.
> **Non riuscire a creare il piano o a seguire i task è un fallimento di design.**

Se l'orchestrazione regge solo con 3 modelli cloud, Homun è una demo, non un
prodotto. La qualità dell'output è una proprietà del *modello*; la **ripetibilità
dell'orchestrazione** (il piano si crea, gli step si seguono, il task si chiude)
deve essere una proprietà dell'**harness**, indipendente dal modello.

### Principio non negoziabile: il motore è il prodotto (niente stampella cloud)

Instradare l'orchestrazione su un modello cloud "capace ma economico" è un
**escamotage** e va **rifiutato come requisito**. Se un utente ha una macchina
abbastanza potente deve poter far girare **tutto in locale**, orchestrazione
compresa. Il valore di Homun deve stare nel **motore**, non nel modello noleggiato
dietro: *"se prendi Usain Bolt e gli cambi la tuta, è ancora Usain Bolt"* — un
prodotto che corre solo perché gli metti dietro un modello potente non è un
prodotto, è un wrapper come tanti.

Conseguenza vincolante: il cloud resta una **libera scelta** dell'utente, **mai**
una condizione perché il piano si crei. Il design si valuta sul caso **full-local**.

### Tier di modelli di base (curato, non "qualsiasi modello")

"Indipendente dal modello" **non** significa "qualsiasi modello": sotto una certa
soglia non si crea nemmeno un piano. Definiamo un **tier di base** — requisiti
minimi e una **matrice di modelli locali testati** (tipo lista di compatibilità
hardware). Requisiti minimi:

- supporto a **structured output / grammatica** (Ollama `format: <schema>` / GBNF
  via llama.cpp) — così l'harness **impone** il formato anche a modelli **non**
  addestrati al tool-calling (è proprio questo che fa sì che un 3B vincolato batta
  un 70B libero: la grammatica forza i token, non serve che il modello "sappia"
  chiamare i tool);
- context window minima ragionevole;
- capacità di seguire istruzioni brevi e di riempire uno slot JSON.

Tra i modelli che rientrano nel tier ci sono **Gemma 3/4, Qwen 7B+, Llama 3.1 8B**
e simili: **non possiamo escluderli**. Su questi il prodotto deve funzionare, e li
testiamo nella CI/eval.

### Onestà: cosa il motore garantisce vs cosa resta legato al modello

Per non ri-cadere nell'overclaim (vedi il caso Fase 1), distinguiamo:

| Proprietà | Chi la garantisce | Vale su un 7B/Gemma? |
|---|---|---|
| Formato sempre valido (tool call/piano a schema, niente `<tool_call>` come testo) | **Harness** (constrained decoding) | **Sì, 100%** |
| Control-flow (segue gli step, niente gonfiore, si ferma quando finito) | **Harness** (piano runtime-owned + id + stop di codice) | **Sì, 100%** |
| Qualità del piano per **task noti** (deck, ricerca, …) | **Harness** (workflow dichiarativi: il piano è NOSTRO, il modello riempie slot) | **Sì, 100%** |
| Qualità del piano per **task aperti/novel** | **Modello** (l'harness lo restringe con decomposizione + verifica + repair) | **Degradata, non rotta** |

Solo l'ultima riga resta legata al modello — ed è accettabile per tesi ("risposta
scadente OK"). Le prime tre **devono** valere su tutto il tier, ed è ciò che rende
Homun un prodotto e non un wrapper.

### Evidenza dal campo (caso deck, build 1038)

Con un modello locale debole (kimi via Ollama), generando un deck:

- il **piano si è gonfiato a 11–12 step** con titoli quasi-duplicati ("Render
  deck", "Render deck → pptx", "Assemble deck.json → render deck");
- il modello ha **ignorato il segnale "DONE"** che `render_deck` gli aveva già
  restituito e ha continuato;
- ha eseguito **azioni-spazzatura post-completamento**: una `str_replace` via
  connettore MCP filesystem su un **path inventato** (`/Users/fabio/Projects/deck.html`),
  che ha aperto una confirmation card;
- ha fatto **trapelare `<tool_call name="run_in_sandbox">` come testo** in chat;
- ha prodotto immagini con **testo storpiato** ("AIDDAPITY PIANTISIT").

Tutti questi sono **failure mode documentati dei modelli deboli** dentro un agent
loop model-driven (perdita di stato, duplicazione todo, ignorare lo stop, tool
call non validi emessi come prosa). Non sono bug isolati: sono il sintomo di un
**design model-driven**.

## Lo stato dell'arte (ricerca, fonti primarie)

Convergenza netta tra tutte le fonti: **la ripetibilità dell'esecuzione è una
proprietà dell'harness, non del modello.** Si ottiene spostando *control flow*,
*stato* e *enforcement del formato* fuori dal modello e dentro codice
deterministico.

- **Anthropic, "Building Effective Agents"**: i *workflow* (LLM orchestrati da
  percorsi di codice predefiniti) vanno preferiti agli *agent* (LLM che dirigono
  il proprio processo) finché bastano; il loop autonomo è l'ultima risorsa, e
  comunque con *stopping conditions* di codice.
- **12-Factor Agents** — Factor 8 "Own your control flow", Factor 5/12 "unify &
  externalize state" (`(state, input) → next_state`), Factor 10 "small focused
  agents".
- **Manus** (context engineering): il `todo.md` è riscritto a ogni step ma la
  **verità del progresso è il file, non la memoria del modello**; filesystem come
  memoria esternalizzata e ripristinabile.
- **LangGraph / DSPy / OpenAI Agents SDK / CrewAI Flows**: tutti i sistemi
  production-hardened convergono su **control flow di codice + stato
  esternalizzato**. CrewAI ha *aggiunto* uno strato a stati; AutoGen è stato
  *riscritto* event-driven — entrambi *via* dalla chiacchiera agentica libera.
- **Constrained decoding** è la singola leva più alta per i modelli deboli: con
  output vincolato a grammatica/JSON-Schema un **Llama-3.2-3B batte un Llama-3.1-70B
  non vincolato** sul function calling; OpenAI riporta **100% di aderenza allo
  schema vs ~86%** senza; TinyAgent porta un 7B da 41% a 83% (constrained +
  fine-tune). Il modello *letteralmente non può* emettere un token che rompe lo
  schema.

Decisioni che contano di più per la robustezza cross-modello, in ordine:

1. **L'harness possiede il loop**; il modello non possiede mai il control flow.
2. **Piano come stato runtime** (sorgente unica); crea-una-volta poi avanza; il
   modello è read-only sul piano.
3. **Constrained decoding di default** su ogni emissione critica per
   l'orchestrazione (locale e cloud).
4. **Job per-step minimo + contesto isolato per-step.**
5. **Gate di verifica di codice + repair limitato**; mai fidarsi del "done"
   auto-dichiarato.
6. **Launch/pause/resume durabili** con checkpoint + idempotenza.

## Cosa abbiamo già (mappa del codice attuale)

Sorprendentemente, **gran parte del motore giusto esiste già** — ma non è il
percorso di produzione, e gli manca lo strato cross-modello.

### Due implementazioni di piano in parallelo

1. **Produzione** — `stream_chat_via_openai` (`crates/desktop-gateway/src/main.rs`):
   loop **model-driven**. Il modello sceglie i tool, decide gli step, segue la
   prosa delle skill, decide l'ordine. Il runtime possiede budget, verifica (F2),
   anti-reset. Il piano canonico è un `Vec<serde_json::Value>` e il merge
   **abbina per titolo** (`merge_plan`, `tkey = trim().to_lowercase()`,
   `main.rs:4339`): il titolo è generato liberamente dal modello → ogni
   riformulazione = step nuovo appeso → **gonfiore**. L'identità è *inferita* dal
   testo del modello → fragile per costruzione.

2. **Esistente ma morto in produzione** — `crates/orchestrator`
   (`OrchestratorBrain`): planner con **`ExecutionPlan` / `PlanStep`**
   (`types.rs:119,156`) che ha già tutto ciò che serve:
   - `step_id` **stabile** (identità non inferita dal titolo);
   - `depends_on` → **DAG** (non solo lista lineare);
   - `kind` ∈ `CapabilityCall | MemoryLookup | SubagentTask | DirectAnswer`;
   - `execution_policy` ∈ `Immediate | DurableTask | AskApproval`;
   - `risk_level`, `requires_user_approval`, `contract`, `goal`, `agent_id`
     (sub-agent), `timeout_seconds`, `max_tokens`;
   - **parsing lenient già pensato per modelli deboli**: un `agent_id` inventato
     non fa crashare il piano (→ generic worker, `PlanStepWire`), azioni
     sconosciute scartate (`lenient_allowed_actions`);
   - `MemoryContextProvider` (`memory.rs`) → memoria nel loop by design;
   - `subagent_workflow.rs`, `tool_index.rs`, `audit.rs`.
   - chiede già lo schema: `json_schema: Some(planner_schema())` (`brain.rs:272`).

La 0008 ha già deciso di promuovere il Brain a orchestratore unico. **Questa ADR
NON lo contraddice: lo completa**, aggiungendo il pezzo che la 0008 non copriva
(la robustezza dell'output cross-modello) e lo strato di esecuzione dichiarativa.

### Il vero buco cross-modello (confermato in codice)

`crates/inference/src/openai_compat.rs:48-52`:

```rust
// (OpenAI, OpenRouter, Ollama local AND cloud). The stricter
// `json_schema` response_format is NOT accepted by ollama.com/v1
"response_format": { "type": "json_object" },
```

Il planner **chiede** lo schema stretto, ma il layer di inference lo **declassa a
`{"type":"json_object"}`** perché l'endpoint OpenAI-compat `/v1` di Ollama non
accetta il `json_schema`. `json_object` garantisce solo "JSON valido", **non**
"conforme allo schema". Quindi sul percorso locale **lo schema non è imposto** →
il modello debole emette JSON valido ma fuori-schema → si rompe l'orchestrazione.

**Questo è esattamente il punto #3 della ricerca (constrained decoding) mancante.**
Ollama supporta nativamente structured outputs via `/api/chat` con il campo
`format: <json schema>` (dal Dic 2024), e llama.cpp supporta grammatiche GBNF. Il
nostro codice non li usa.

### Le skill sono solo prosa

`SKILL.md` = frontmatter (name/description) + **istruzioni in prosa Markdown**.
Non c'è nessuna parte dichiarativa che il runtime esegua: il modello legge il
testo e *decide* come seguirlo (`use_skill` inietta la prosa, `main.rs:11558`).
Per un modello debole "leggi 100 righe e seguile nell'ordine giusto" è
inaffidabile. È la radice del comportamento erratico del caso deck.

## Decisione

Adottare un **task engine posseduto dall'harness**: il codice possiede control
flow, stato del piano e formato di output; **il modello riempie slot vincolati**.
Una riga:

> richiesta → router → (Workflow mode | Agent mode) sul **singolo `ExecutionPlan`
> runtime-owned con `step_id` stabili) → esecuzione guidata dal codice con
> output del modello **imposto a schema/grammatica su ogni percorso (anche
> Ollama)** → gate di verifica + repair limitato → memoria nel loop a ogni step.

### Tre invarianti (non negoziabili, valgono in tutti i contesti)

1. **Monotonìa** — uno step verificato `done` non si riapre mai.
2. **Limitatezza** — riportare un avanzamento non può mai far crescere il piano.
3. **Identità non inferita** — non si deduce "qual è lo step" dal testo che il
   modello rimanda. L'identità è `step_id`, posseduto dal runtime.

Né il merge-per-titolo attuale né un merge posizionale soddisfano la #3. Lo
soddisfa solo un piano i cui id sono assegnati dal runtime e mai ricostruiti dal
re-invio del modello.

### Pilastro 1 — Un solo modello di piano: `ExecutionPlan` runtime-owned

Convergere sul `ExecutionPlan`/`PlanStep` del crate `orchestrator` come **unica**
rappresentazione. Ritirare il `merge_plan` per-titolo di `main.rs`. Il piano:

- è generato **una volta** (o ri-pianificato esplicitamente come operazione
  dedicata), poi il modello **non rimanda più la lista** per segnare progresso;
- vive come **stato di prima classe** (in memoria nel turno + persistito nel
  `TaskStore` per durabilità/resume — già esistente, 0008/0015);
- il progresso si riporta con un'azione minima e monotòna che referenzia
  `step_id` (o avanza il cursore), non re-inviando titoli;
- il `done` lo assegna il **runtime** dopo la verifica, mai il modello.

`update_plan` (il tool attuale) viene sostituito da due operazioni distinte:
`plan_propose(steps)` (crea/ri-pianifica, una volta) e `step_advance(step_id,
status)` (minimale, monotòna). Questo dissolve la domanda "la chiave è stabile?":
non c'è più chiave-da-titolo.

### Pilastro 2 — Due modalità di esecuzione sullo stesso engine

Il control flow è **sempre** del codice. Ciò che cambia è quanto il piano è noto
in anticipo:

- **Workflow mode (task strutturati: skill/plugin con step noti).** Il runtime
  guida una pipeline **dichiarata**; il modello viene chiamato solo per riempire
  lo **slot di contenuto** di ogni step (es. "scrivi i bullet di questa slide come
  JSON"). Non può gonfiare (piano fissato), non può riaprire (cursore monotòno),
  non può saltare (lo decide il codice). È il caso `create-presentations`:
  `get_brand → genera immagini → render_deck → consegna`, 4 step di **codice**.

- **Agent mode (task aperti: esplorazione, richieste ad-hoc).** Il loop resta, ma
  con: piano runtime-owned (crea-una-volta + avanza-per-id), **tool call imposti a
  schema**, stop posseduto dal codice (le tre invarianti valgono comunque).

Un **router** sceglie la modalità: skill con manifest dichiarativo → workflow
mode; altrimenti → agent mode. Tutte e due le modalità sono lo **stesso engine
condiviso** (chat / canali / automazioni — vedi Pilastro 6).

**Implementazione: un solo grafo, non due percorsi.** Per evitare di duplicare la
logica, "workflow" e "agent" non sono due code path separati: sono **lo stesso
grafo d'esecuzione**. Un task aperto è semplicemente *"un piano con un nodo =
mini-loop agentico limitato"*. È il modello di LangGraph/DSPy (un'unica
astrazione a grafo; il loop è un *tipo di nodo*). Così c'è un solo esecutore da
mantenere, testare e rendere robusto.

### Pilastro 3 — Strato di robustezza cross-modello: output IMPOSTO ovunque

È il pezzo nuovo e più importante. Su **ogni emissione critica per
l'orchestrazione** (piano, tool call, verdetto di verifica) l'output del modello
è vincolato allo schema, su tutti i percorsi:

- **Cloud** (OpenAI/compat che lo supportano): `response_format` con
  `json_schema` strict.
- **Locale Ollama**: usare l'endpoint nativo `/api/chat` con `format: <json
  schema>` invece del `/v1` che declassa a `json_object`; oppure grammatica GBNF
  via llama.cpp. Smettere di declassare a `json_object`.
- **Fallback**: se un backend non supporta né schema né grammatica, restano il
  parsing lenient (già presente) + repair limitato, ma è l'eccezione, non la
  norma.

Questo è ciò che trasforma "robusto su Claude" in "robusto su un 7B". Elimina
all'origine: tool call non validi, JSON malformato, `<tool_call>` trapelato come
prosa, piano fuori-schema.

### Pilastro 4 — Skill dichiarative (retro-compatibili)

Il frontmatter di `SKILL.md` acquisisce una sezione **opzionale** `workflow:` —
step machine-readable con `action`, schema dell'input (lo slot che il modello
riempie) e `done_criterion`. Il runtime esegue quel workflow (Pilastro 2).
Le skill **senza** `workflow:` restano pura prosa ed eseguono in agent mode →
**zero rotture** per le skill esistenti. `create-presentations` diventa la prima
skill dichiarativa.

Analogia WordPress (già nel north-star del prodotto): il plugin **dichiara** la
capability/struttura, il core **orchestra**.

### Pilastro 5 — Verifica + repair limitato (mai fidarsi del self-report)

Mantenere il gate F2 (`verify_step_complete`) come gate di codice. Aggiungere:
repair **limitato** (N tentativi) che **cambia strategia** tra un tentativo e
l'altro (re-plan o escalation a un modello più forte), invece di ripetere identico
(failure mode dei modelli deboli). Mai marcare `done` su sola dichiarazione del
modello.

### Pilastro 6 — Memoria nel loop, sempre, un solo layer

Ogni step instrada **recall prima / write-back dopo** attraverso l'**unico**
`MemoryFacade` condiviso (`MemoryContextProvider` del crate orchestrator esiste
già). Vale anche per i sub-agent (`PlanStepKind::SubagentTask`, contesto isolato):
il loro recall/write-back passa dal **medesimo** engine di memoria, **mai** da uno
store parallelo. È il differenziatore del prodotto e non va duplicato.

### Pilastro 7 — Condiviso su tutte le superfici

`generate_stream` (chat) e `run_agent_turn` (canali/automazioni) chiamano lo
stesso engine (già così). Le due modalità e lo strato di enforcement valgono
identici ovunque: decks, ricerca, coding, canali, automazioni.

## Conseguenze

Positive:

- L'orchestrazione diventa una proprietà dell'harness → **ripetibile cross-modello**.
- Un solo modello di piano (`ExecutionPlan`), id stabili, DAG → niente gonfiore,
  niente loop di rigenerazione, niente identità inferita.
- Le skill diventano eseguibili dal runtime → comportamento deterministico anche
  con modelli deboli; resta lo spazio prosa per i task aperti.
- Completa la 0008 (un solo orchestratore) con il pezzo cross-modello mancante.

Rischi:

- Refactor ampio del prompt-path di produzione (lo stesso rischio della 0008).
- L'enforcement locale (Ollama `/api/chat` `format` / GBNF) va implementato e
  testato sui backend reali.
- Migrazione del formato skill (mitigata: `workflow:` è opzionale, le skill prosa
  continuano a funzionare).

## Sequenza incrementale (sicura, verde a ogni passo, dietro flag)

Ordine per impatto sulla robustezza cross-modello (vedi ranking ricerca):

1. **Enforcement output sul percorso locale** (Pilastro 3). Ollama `/api/chat`
   `format: <schema>` (o GBNF) per piano / tool call / verifica; smettere il
   declassamento a `json_object` in `openai_compat.rs`. *È la leva singola più
   alta e la più isolata da spedire.* Dietro flag, fallback al comportamento
   attuale.
2. **Piano = `ExecutionPlan` runtime-owned con `step_id`** nel prompt-path:
   `plan_propose` + `step_advance` al posto di `update_plan`/`merge_plan`.
   Ritirare il merge-per-titolo. (Soddisfa le tre invarianti.)
3. **Skill dichiarative** (`workflow:` opzionale) + **Workflow mode runner**;
   migrare `create-presentations` come prima skill dichiarativa.
4. **Router workflow|agent** + verifica/repair limitato (Pilastro 5).
5. **Convergenza con `OrchestratorBrain`** (completa la 0008): il Brain come
   generatore di `ExecutionPlan`, durabilità/resume via `TaskStore`,
   sub-agent come step.
6. **Memoria nel loop a ogni step** uniformata sull'unico `MemoryFacade`
   (Pilastro 6), inclusi i sub-agent.

Ogni passo dietro flag con fallback; build/test verdi a ogni checkpoint.

## Riferimenti

- [0008 — OrchestratorBrain come planner unico](0008-orchestrator-brain-single-planner.md)
- [0009 — capability execution containment](0009-capability-execution-containment.md)
- [0011 — agnostic core + add-on ecosystem](0011-agnostic-core-addon-ecosystem.md)
- [0015 — durable task heartbeat/retention/export](0015-durable-task-heartbeat-retention-export.md)
- Ricerca SOTA (fonti primarie): Anthropic "Building Effective Agents" e
  "Multi-agent research system"; 12-Factor Agents; Manus "Context Engineering";
  LangGraph; DSPy; OpenAI Structured Outputs; NVIDIA "SLMs are the Future of
  Agentic AI"; TinyAgent; survey constrained decoding (XGrammar/Outlines).
