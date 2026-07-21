# Decision 0018: Harness adattivo — inner loop libero per modelli capaci, sub-agent sotto trigger, memoria come substrato

Date: 2026-06-26

## Status

**Superseded in parte (2026-07-21).** La parte runtime "adaptive scaffolding floor" è stata
ritirata: toggle, setting, profili, telemetria e ramificazioni per tier sono stati rimossi in favore
di un solo agent loop canonico. Vedi
[`2026-07-21-remove-adaptive-scaffolding-floor-design.md`](../superpowers/specs/2026-07-21-remove-adaptive-scaffolding-floor-design.md).
Restano validi come principi indipendenti l'envelope uniforme di sicurezza, le scritture
single-threaded dei sub-agent e la memoria come substrato di apprendimento.

La decisione originale estendeva e **correggeva un'assunzione implicita** della
[0016](0016-harness-owned-task-engine-cross-model.md): la 0016 ha reso il floor di
orchestrazione **uniforme** (vincola tutti per proteggere i modelli deboli). Questa
ADR aggiunge il pezzo mancante: **il vincolo dentro l'inner loop deve scalare
inverso alla capacità del modello** — restare per i deboli, allentarsi per i
capaci — altrimenti combattiamo il miglioramento dei modelli invece di cavalcarlo.

Si aggancia anche alla [0012](0012-automations-trigger-action.md) /
[Evented Automations](../superpowers/specs/2026-06-26-evented-automations-design.md)
per definire come i sub-agent girano **dentro un trigger** senza violare i capisaldi.

## Perché questa decisione esiste

La 0016 stabilisce, correttamente, che control-flow / stato / formato sono
dell'harness e che il prodotto deve reggere su modelli deboli/locali. È vera e
resta in vigore. Ma la sua implementazione attuale applica lo **stesso**
scaffolding a **ogni** modello: verificato in codice, `ModelTier` non raggiunge mai
la decisione di scaffolding (`route_capability(prompt: &str)` non vede il modello;
`scaffolding_tier` dipende solo dal tipo di richiesta).

Conseguenza: un modello frontier viene incanalato negli stessi slot pensati per
gemma4. Questo:

1. **lascia capacità sul tavolo** sui modelli forti (li sotto-utilizziamo);
2. è una **scommessa implicita contro il miglioramento dei modelli**: lo scaffolding
   uniforme è un asset che si deprezza (il valore cala a ogni generazione di modelli
   locali che migliora, il costo di manutenzione resta).

## Lo stato dell'arte (ricerca, fonti primarie, giugno 2026)

Tre fonti indipendenti, tre angoli diversi, **stessa indicazione**: l'harness deve
possedere tutto ciò che sta **intorno** al loop; l'**inner loop di ragionamento**
resta **model-driven**, tanto più quanto il modello è capace.

- **Anthropic, "Building Effective Agents"**: *"Workflows are systems where LLMs and
  tools are orchestrated through predefined code paths. Agents are systems where LLMs
  dynamically direct their own processes and tool usage."* → i workflow per task
  ben definiti (il nostro `make_deck` è esattamente questo, e resta giusto); gli
  agent per flessibilità, con il modello che guida e stopping conditions di codice.
- **Browser Use, "The Bitter Lesson of Agent Frameworks"**: *"Start with maximal
  capability, then restrict"* — *"Give the LLM as much freedom as possible, then
  vibe-restrict based on evals"* — *"frameworks fail not because models are weak, but
  because their action spaces are incomplete"*. È l'inverso di "vincola in slot",
  ma **vale per i modelli capaci**.
- **Oracle / R. Alake, "The Agent Loop Decoded" (3 livelli)**: il framework distingue
  ciò che cambia (lo scaffolding **attorno** al loop: memoria, contesto, tool
  discovery, sicurezza, feedback) da ciò che **non** cambia (*"The inner loop —
  assembling context, invoking the model, and acting — has not changed. What has
  changed is everything around it"*). Al Livello 3 la domanda è *"programmatic vs
  agent-triggered"*: l'harness fa in automatico memoria/contesto/sicurezza; il
  **modello** decide il ragionamento e le azioni.

### Dove siamo, misurato su questo metro

Per lo scaffolding **attorno** al loop, Homun è già un sistema di **Livello 3**:

| Componente Livello 3 | In Homun |
|---|---|
| Memory-aware (encode/store/retrieve/inject/forget), N tipi | recall ibrido RRF + 7 tipi + candidate→confirmed + tombstone (caposaldo #1) |
| Semantic tool discovery (toolbox vettoriale) | `find_capability` / Tool Search / registry BM25 (caposaldo #7) |
| Context engineering (compaction, tool-output offload) | `local-first-context-compression`, compaction F3 |
| Idempotency | double-execution guard + lease/heartbeat (Durable Task Runtime) |
| Human-in-the-loop come stop deliberato | approval gates / takeover |
| Feedback → memoria | per-step outcome write-back + cattura del PERCHÉ (caposaldo #12) |

Su tutto questo **non divergiamo: siamo avanti**. L'unica divergenza reale è il
caposaldo #6 ("il modello riempie slot vincolati") applicato **dentro** l'inner loop
**a tutti i tier uniformemente**. Quello è il pezzo da rendere adattivo.

## Decisione

### Pilastro 1 — Separare "attorno al loop" da "dentro il loop"

- **Attorno al loop (Pavimento, uguale per tutti):** identità-piano runtime-owned,
  monotonìa, limitatezza, involucro tool-call valido + parsing tollerante, memoria
  nel loop, registry capability, context engineering, approval. Resta **invariato per
  ogni tier**. È la parte Livello-3 che ci dà ragione: non si tocca.
- **Dentro il loop (Manopole, scalano inverse alla capacità):** quanto il modello è
  incanalato in slot. Diventa **funzione del `ModelTier`**.

### Pilastro 2 — Le Manopole tier-adaptive

Risolto il `ModelTier` del modello del turno (oggi si ferma a `model_registry.rs`,
va portato fino alla decisione di scaffolding), un `ScaffoldProfile` puro mappa il
tier su quattro manopole:

| Manopola | Tier debole (Fast) | Tier capace (Reasoning) |
|---|---|---|
| Formato | grammatica/schema forzato | tool-calling nativo |
| Workflow bias | forza workflow (`make_deck` one-shot) | agentic, tool granulari |
| Granularità slot | un task = un nodo, slot stretti | piano libero, slot ampi |
| Verifica/repair | sempre | on-risk |

Invariante chiave: **man mano che i modelli locali migliorano, si riclassificano
verso l'alto** → l'architettura **smette automaticamente di mettere scaffolding
quando il modello se lo merita**. Così cavalchiamo il bitter lesson invece di
combatterlo, senza tradire la 0016 (i deboli restano protetti).

Il rischio/approvazione resta un **terzo asse ortogonale**: più capace ≠ meno gate
sulle azioni irreversibili. Le approval scalano col rischio dell'azione, mai con la
bravura del modello.

### Pilastro 3 — Sub-agent sotto trigger: manager-child, write single-threaded

Le [Evented Automations](../superpowers/specs/2026-06-26-evented-automations-design.md)
eseguono l'azione di una regola attraverso lo **stesso** engine (`run_agent_turn`),
che può già emettere step `PlanStepKind::SubagentTask`. Quindi "sub-agent nei
trigger" **non è un meccanismo nuovo**: è il path sub-agent esistente, con quattro
vincoli che derivano dai capisaldi e dalla ricerca.

Stato dell'arte sui sub-agent (Cognition, *"Don't Build Multi-Agents"* →
*"Multi-Agents: What's Actually Working"*): la decomposizione **parallela con
scritture** è fragile (*"actions carry implicit decisions that conflict"*); ciò che
funziona è *"multiple agents contribute intelligence to a task while **writes stay
single-threaded**"* — fan-out per **leggere/raccogliere**, scrittura
**single-threaded**. È esattamente il caposaldo #1 (un solo `MemoryFacade`).

Regole per i sub-agent spawnati da un trigger:

1. **Topologia manager-child.** Il turno principale del trigger è il "manager"
   single-threaded: possiede il piano, le scritture (memoria/artifact) e
   l'approval. Può fare **fan-out di sub-agent read/gather** (classifica intento,
   ricerca contatto, raccoglie contesto); le **decisioni con effetto esterno non**
   si parallelizzano. Classificazione `read_gather` vs `write_decide` derivata
   **deterministicamente da `allowed_actions`** (caposaldo #7), implementata in
   `crates/orchestrator/src/subagent_workflow.rs::subagent_write_mode`:
   - `Read` / `Draft` → **`read_gather`**, fan-out ammesso. **Draft è
     parallel-safe**: è una *proposta* senza effetto esterno (es. il workflow
     canonico `Planner→Risk→Memory‖Tool→Review` fa fan-out di proposte Draft che
     ReviewAgent riconcilia **prima** di qualsiasi esecuzione). *Questo corregge il
     default iniziale "Draft single-threaded": il workflow canonico lo falsifica.*
   - `WriteWithConfirmation` / `ApprovedAutomation` (scrittura esterna reale) →
     **`write_decide`**, single-threaded. `validate_single_threaded_writes` (in
     `validate_plan`) rifiuta fail-closed due `write_decide` paralleli: uno deve
     dipendere transitivamente dall'altro.
2. **Ereditarietà dell'envelope, fail-closed.** *(Già implementato:
   `subagent_workflow.rs:51-126`.)* Il `permission_envelope` del sub-agent deriva
   da `request.policy_context` (connettori da `enabled_providers`,
   `max_autonomy_level`, `allowed_actions`), e `allowed_actions_for_step` **ERRORE**
   se uno step chiede un'azione fuori dalla policy → un sub-agent **non può mai
   allargare** il perimetro. Resta da verificare nel gateway che il path
   automazione→Brain passi come `policy_context` la **policy effettiva risolta**
   (global → channel → contact perimeter → **project access** → rule → capability →
   approval); il resolver esiste (`resolve_project_contact_policy`).
3. **Visibilità.** Gli step sub-agent compaiono nel run visibile del thread
   proprietario (no background nascosto, requisito della spec evented). Approval di
   uno step sub-agent con side-effect esterno **escala al medesimo gate** della
   regola, non si auto-approva.
4. **Floor adattivo (Fase S) anche qui, ma conservativo.** Il `ModelTier` del modello
   risolto per il sub-agent governa il suo scaffolding (un trigger di background può
   girare su un modello debole/cheap → slot stretti; o escalare a un capace per una
   classificazione difficile → libero). **`repair`/`required_keys` restano ON per
   tutti i tier**: l'output del sub-agent alimenta lo step successivo senza umano, è
   meno tollerante della chat.

### Pilastro 4 — Opportunità: la memoria come substrato di apprendimento

Tesi finale di Oracle: *"The agent loop and the training loop are converging. The
memory layer is where they meet… well-engineered memory produces better training
signals. Design your memory layer accordingly."* Il nostro motore di memoria (PERCHÉ
+ grafo causale + outcome per-step, caposaldo #12) non è solo recall: è un potenziale
**substrato di continual learning** che i prodotti "solo model+tools+loop" non hanno
(la loro esperienza evapora a fine sessione). Non è un commitment di build in questa
ADR; è una **direzione di prodotto** da tenere esplicita: ogni write-back ben
strutturato oggi è dato di apprendimento domani.

## Conseguenze

Positive:

- Risolviamo la tensione 0016-vs-bitter-lesson: floor per i deboli, libertà per i
  capaci, degrado automatico dello scaffolding mentre i modelli crescono.
- I sub-agent sotto trigger riusano il path esistente con vincoli espliciti
  (manager-child, envelope ereditato, write single-threaded) → niente swarm fragile,
  niente store parallelo, niente leak di progetto.
- La memoria acquista una seconda tesi di valore (substrato di apprendimento).

Rischi / mitigazioni:

- **Misclassificazione di tier** → default `Balanced`; stretta a runtime sui
  fallimenti; rollout in `shadow` (calcola+logga, non agisce) prima di `on`.
- **Rimozione tool per tier** può cambiare comportamento → dietro flag, eval
  bi-popolazione (gemma4 invariato **e** capace più libero).
- **Envelope dei sub-agent** è codice di sicurezza → fail-closed, test dedicati su
  "sub-agent non allarga il perimetro del trigger".

## Sequenza incrementale (dietro flag, verde a ogni passo)

1. ✅ **Primitivo:** `tier` su `ResolvedRole` + `tier_for()`/`tier_for_model()`;
   `ModelTier` risolto nel turno; modulo `scaffold` (`ScaffoldProfile`/`scaffold_for`).
   Controllo: **setting persistito** `runtime-settings.json::adaptive_floor`
   (`off` default | `shadow` | `on`), esposto in Settings → Model per task come
   toggle "Floor di scaffolding adattivo (Sperimentale)"; l'env
   `HOMUN_ADAPTIVE_FLOOR` **sovrascrive** il setting (dev/test). API
   `GET/POST /api/runtime/settings`. Risolto una volta per turno
   (`adaptive_floor_mode()`), niente I/O nel hot loop.
2. ✅ **Prima manopola — verifica:** `verify_depth` tier-aware (capace → on-risk
   sugli step senza azione esterna; debole → always).
3. ✅ **Router tier-aware:** `relax_route_for_tier` — il capace non è forzato nel
   workflow one-shot (`make_deck`/`make_document` restano offerti); debole/balanced
   invariati.
4. ⃠ **Formato: MOOT** — la chat usa già tool-calling nativo; i percorsi
   strutturati/subagente vogliono il floor uniforme (caposaldo #6). Niente manopola
   formato: rischio senza guadagno.
5. ✅ **Fase S — sub-agent:** ✅ envelope ereditato fail-closed (già esistente) +
   ✅ guard single-threaded-writes (`validate_single_threaded_writes`, 5 test).
   **Verifica wiring conclusa (2026-06-26):** i trigger **non** passano dal Brain —
   `execute_proactive_prompt_task` → `run_agent_turn_into_message` →
   `stream_chat_via_openai` (loop model-driven), gated da `tool_policy`
   (`autonomous`/`full`/`read_only` dalla regola) + perimetro contatto
   (`contact_turn_context`) + project access verificato **prima** del fire
   (`channel_project_contact_policy` → `authorized`/`can_trigger`). Quindi un
   trigger non si decompone in subagenti del Brain: il guard+envelope coprono già
   l'unico path che li genera (chat→`create_task`→Brain, `policy_context` da
   `registry.policy_context`). "Sub-agent sotto trigger" resta **forward-looking**:
   da implementare solo SE i trigger verranno instradati nel Brain. Bonus: poiché i
   trigger usano `stream_chat_via_openai`, l'adaptive floor (Fasi 0-2) si applica
   già anche a loro.
6. ☐ **(Opzionale) Stretta a runtime + probe al primo uso** se l'euristica di tier
   sbaglia in produzione.

Gate di regressione trasversale: `scripts/eval_suite.py` vs `gemma4:latest` resta il
contratto bi-popolazione. Telemetria `{tier, profile, esito}` nel `tool_trace` da
Fase 1 (prerequisito della stretta a runtime e di un futuro router appreso).

## Riferimenti

- [0016 — harness-owned task engine cross-modello](0016-harness-owned-task-engine-cross-model.md)
- [0008 — OrchestratorBrain come planner unico](0008-orchestrator-brain-single-planner.md)
- [0012 — automazioni trigger → azione](0012-automations-trigger-action.md)
- [Evented Automations & Project Access design](../superpowers/specs/2026-06-26-evented-automations-design.md)
- [Architettura agent-loop (Pavimento / Manopole)](../architecture/agent-loop.md)
- [CAPISALDI](../CAPISALDI.md) — #1 (memoria layer unico), #6 (slot vincolati),
  #7 (registry capability), #10 (evented automations), #12 (PERCHÉ + apprendimento)
- Ricerca SOTA (fonti primarie, giugno 2026): Anthropic "Building Effective Agents";
  Browser Use "The Bitter Lesson of Agent Frameworks"; R. Alake / Oracle "The Agent
  Loop Decoded — Three Levels"; Cognition "Don't Build Multi-Agents" + "Multi-Agents:
  What's Actually Working".
