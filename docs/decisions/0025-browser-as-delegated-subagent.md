# ADR 0025 — Il browser come sotto-agente delegato (goal → risposta), il manager resta il driver

- **Stato:** **Accepted — COMPLETO** (2026-07-09, `a183a736`) — un solo path browser (`browse(goal)`
  ricorsivo su `engine::agent_loop::run_turn`), nessun flag; il model-switch mid-turn e il flag
  `HOMUN_CHAT_BROWSE_SUBAGENT` sono rimossi. *(Testo sotto = decisione originale, immutata.)*
- **Data:** 2026-07-07
- **Relazioni:** estende ADR 0021 (loop unico guardato, planning-as-a-tool); **richiede ADR 0024**
  (engine-extraction dal monolite: il loop dev'essere un motore richiamabile per poterlo invocare
  ricorsivamente); realizza la direzione "subagents come substrato d'esecuzione per step
  indipendenti" (ADR 0018); converge il path browser della chat sul contratto
  `SubagentTask → SubagentResult` che già esiste in `crates/subagents` ma è usato solo dal
  drive/orchestrator (dormiente).

## Contesto — il difetto attuale

Nel path chat il browser è esposto come **tool granulari** (`browser_navigate`/`click`/`type`,
flag `HOMUN_CHAT_BROWSER_GRANULAR`). Alla **prima** chiamata browser, il *driver model*
**switcha** al modello browser (es. minimax) **per il resto del turno**
(`main.rs`, ramo browser: "switch the driver model for the rest of this (browsing) turn").

Conseguenze osservate (e debuggate a lungo):

1. **Il manager sparisce.** Il modello che ha emesso il piano non è più attivo → il piano si
   **congela** alla frontiera (nessuno chiama `step_advance`), e la sintesi finale la fa pure il
   modello browser (debole).
2. **Contesto inquinato.** Snapshot, click, reasoning del modello browser entrano nel contesto
   principale → da qui i marker parrottati / il flood `‹‹/REASONING›` di minimax.
3. **Verifica nel posto sbagliato.** "L'informazione è corretta?" dovrebbe deciderla il modello
   capace ricevendo una risposta; oggi non c'è un punto naturale dove farlo.

Sono stati aggiunti **cerotti** — corretti come sintomo, sbagliati come layer:
- `enforce_monotonic_plan_progress` (chiude i `doing` stantii),
- `reconcile_final_plan_marker_on_delivery` (chiude il piano alla consegna),
- `try_advance_frontier_from_evidence` (l'harness avanza il piano indovinando dall'evidenza
  verificata),
- `StreamMarkerFilter` / `balance_reasoning_markers` (ripulisce il flood del modello browser).

Tutti compensano il fatto che **il manager perde il controllo del turno**. Il CAPISALDO dice:
*niente cerotti su un design sbagliato — trova il layer giusto*. Il layer giusto è: il browser
deve essere uno **strumento incapsulato**, non un dirottamento del turno.

## Decisione

Il browser diventa un **sotto-agente delegato "goal → risposta"**. Il manager (il loop unico
guardato, motore #1) **resta il driver per tutto il turno** e chiama il browser come **una singola
capability** che riceve un obiettivo e restituisce **solo la risposta** (+ stato/evidenza). Il
manager giudica la risposta, avanza il proprio piano, prosegue.

Riusiamo il contratto che **già esiste** (`crates/subagents/src/types.rs`):

```
SubagentTask   { task_id, parent_task_id, agent_id, goal, input, contract,
                 permission_envelope, budgets }
SubagentResult { task_id, agent_id, status(Succeeded|Failed|Cancelled|TimedOut),
                 output, errors, metrics, audit }
```

### Il tool visto dal manager

```
browse(goal: string, hints?: {url?, container?}) -> BrowseResult
```

`BrowseResult` (in `SubagentResult.output`):
```
{
  found:      bool,          // l'informazione è stata ottenuta?
  answer:     string,        // il valore estratto (o "" se !found)
  sources:    string[],      // URL effettivamente visitati (per "Fonti")
  confidence: "high"|"low",  // autovalutazione del sotto-agente
  note?:      string         // es. "non disponibile su Polymarket"
}
```

- **Una chiamata per esigenza-informativa** (tipicamente uno step del piano). Bloccante: è un solo
  round di tool per il manager, come oggi una `browser_navigate` — ma dentro c'è un intero loop.
- **Fallimento first-class:** se l'obiettivo non è ottenibile, `status=Failed` / `found=false`
  con `note` → il manager marca lo step `blocked` o risponde "non disponibile", **senza thrashing**.

### Il sotto-agente browser NON è una macchina nuova: è il loop agentico, ricorsivo

Il ciclo *Percezione → Ragionamento/Pianificazione → Azione → Osservazione/Verifica →
termina-o-ripete* **esiste già** (motore #1, `run_agent_turn_into_message`). Il sotto-agente
browser è **quello stesso loop guardato, invocato ricorsivamente** su un sotto-obiettivo, con:

- **toolset** = solo i tool browser,
- **modello** = il browser model (economico),
- **contesto ISOLATO** (proprio, non quello del manager).

Conseguenze:
- La **condizione d'arresto** NON è un problema nuovo: è il normale *Observe/Verify → terminate*
  del loop ("obiettivo raggiunto? → estraggo la risposta e ritorno"; budget esaurito → ritorno
  best-effort con `found=false`). Nessuna macchina d'arresto ad hoc.
- **Nessun forced-JSON per step** (danneggia i modelli deboli — ADR 0016 emendato): loop ReAct
  vero; **solo il ritorno** (`BrowseResult`) è strutturato.
- **Contesto isolato** → snapshot/click/reasoning restano dentro il sotto-loop; al manager torna
  **solo** `BrowseResult`. Da solo elimina il flood marker e l'inquinamento di contesto sul path
  principale.
- **Memoria** attraverso l'unico `MemoryFacade` (CAPISALDO): recall per hint/URL, write-back del
  ritrovamento come entità.

**Prerequisito — ADR 0024 (engine-extraction, Proposed).** Oggi il loop è un **monolite legato a
un thread di chat** (`run_agent_turn_into_message(state, thread_id, prompt, …)`), non un
`run_loop(goal, tools, model, context) → result` richiamabile. È **per questo** che il browser è
stato incastrato con un **model-switch dentro l'unica istanza** invece che con un **loop annidato**:
il motore non è estratto. Estrarre il loop guardato in un motore parametrizzato (ADR 0024) rende
`browse` **banale** — una chiamata ricorsiva al motore con {sotto-goal, tool browser, contesto
isolato}. ADR 0024 e 0025 sono un **unico arco**: *estrai il motore, poi usalo ricorsivamente*.

### La verifica del manager ("capire se l'informazione è corretta")

Ricevuto `BrowseResult`, il manager (modello capace):
1. **verifica** che `answer` soddisfi il criterio dello step (riusa `verify_step_complete`, o un
   giudizio inline nel loop principale);
2. se ok → `step_advance(done)` e passa al prossimo;
3. se no → **riemette `browse`** con un obiettivo raffinato (retry limitati);
4. esauriti i retry → marca lo step `blocked`.

È **qui** che la verifica F2 vive correttamente: il modello capace che giudica una risposta
ritornata, non un giudice bullonato durante il browsing.

## Cosa si RITIRA (converge, don't duplicate)

- **Il model-switch** del ramo browser (il manager non lascia mai il turno).
- **`try_advance_frontier_from_evidence`** (l'harness non deve più indovinare: il manager avanza
  il piano perché riceve ogni risposta).
- I **tool granulari** browser restano visibili **solo dentro** il sotto-agente; il manager vede
  solo `browse`. (Il flag `HOMUN_CHAT_BROWSER_GRANULAR` diventa un dettaglio interno del sotto-agente.)
- Il `browse SubagentTask` del drive/orchestrator dormiente e questo path convergono sullo **stesso**
  contratto → si ritira la parallela, non la si replica.

`reconcile_final_plan_marker_on_delivery`, `enforce_monotonic_plan_progress`, `StreamMarkerFilter`
restano come **rete di sicurezza** (difesa in profondità), ma smettono di essere il meccanismo
primario.

## Rollout (bottom-up, gated, behavior-preserving)

Flag `HOMUN_CHAT_BROWSE_SUBAGENT` (default OFF finché non validato live).

0. **(Prerequisito) Estrazione del motore — ADR 0024.** Estrarre il loop guardato in
   `run_loop(goal, tools, model, context, budgets) → LoopResult` richiamabile. Behavior-preserving:
   il turno di chat diventa il primo chiamante. Senza questo, i passi sotto ricadono nel model-switch.
1. **Executor = motore ricorsivo.** `browse` invoca `run_loop` con {sotto-goal, tool browser,
   browser model, contesto isolato} e mappa `LoopResult → SubagentResult`/`BrowseResult`. Test:
   goal→answer, isolamento del contesto, `found=false` su obiettivo impossibile.
2. **Tool manager.** Esporre `browse` come tool del loop unico; instradare le esigenze-informative
   lì. Tool granulari dietro il flag come fallback. Test: il manager riceve `BrowseResult` pulito.
3. **Verifica + routing.** Il manager verifica la risposta e instrada al piano (done/retry/blocked).
   Test: risposta sbagliata → retry; impossibile → blocked.
4. **Flip default ON**; ritirare model-switch + auto-advance. Test di regressione sulla query
   Polymarket (piano che sale in tempo reale, contesto pulito, "non disponibile" gestito).

Ogni passo porta il suo test (metodologia: bottom-up, gated).

## Conseguenze

**Positive**
- Il piano avanza perché lo guida il **manager capace** (niente modello debole, niente harness che
  indovina). Progresso mid-turn reale e corretto — *per costruzione*, non per patch.
- **Contesto pulito**: il rumore browser resta incapsulato → sparisce la classe di bug
  marker/flood/parrotting sul path principale.
- Verifica al posto giusto → migliore affidabilità del "l'informazione è corretta".
- **Costo probabilmente inferiore**: il manager non viene reinvocato a ogni click (li fa il modello
  economico); vede solo obiettivi + risposte. Si aggiungono le chiamate di verifica (che comunque
  abbiamo già).
- Coerente con ADR 0021 (una capability delegata **del** loop unico, non un secondo motore).

**Costi / rischi**
- **Condizione d'arresto** del sotto-agente = dove sta la qualità; un modello browser debole può
  restituire una risposta **sbagliata con sicurezza** → la **verifica del manager è essenziale**,
  non opzionale (mitigazione già nel design).
- **Granularità dell'obiettivo:** uno `browse` per step è pulito, ma uno step può richiedere più
  pagine. Da decidere: `browse` per-step vs per-esigenza, con budget di navigazione interno.
- **Latenza:** una `browse` è un intero sotto-loop; il manager attende. Accettabile (già così oggi).
- Refactor non banale del ramo browser del loop (non solo un flag).

## Domande aperte

1. `browse` per **step del piano** o per **singola esigenza informativa**? (Impatta la granularità
   del progresso e il budget interno.)
2. La condizione d'arresto: giudizio del modello del sotto-agente, un estrattore leggero sullo
   snapshot, o entrambi?
3. Quanti retry raffinati prima di `blocked`? Chi raffina l'obiettivo — il manager o il sotto-agente?
4. Il sotto-agente browser gira in-process (come oggi motore #1) o come task del `task-runtime`
   (durabile, come il drive)? In-process è più semplice e coerente con ADR 0021.
