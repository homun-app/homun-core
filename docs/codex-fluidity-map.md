# Codex → Homun: mappa di fluidità (grounded sul codice reale di Codex)

> **Fonte = il codice reale di Codex 0.142.5** su disco (`/Users/fabio/Projects/codex`): binario Rust `Resources/codex`
> (prompt + tool + delega estratti via `strings`) + `app.asar` (host/RPC). Non i doc di confronto. Data: 2026-07-03.
> Metodo: 5 agenti paralleli, una dimensione ciascuno; sintesi con giudizio (priorità per ROI/rischio, flag sui
> conflitti con decisioni Homun, onestà su dove Homun è già avanti). I `file:line` sono best-effort → ri-`grep` i simboli.

## Tesi in una riga
Codex resta fluido con **tre discipline**: (1) **parla meno** (regole anti-chiacchiera esplicite + assumi-non-chiedere),
(2) **offre meno tool per turno** (core piccolo + il resto dietro discovery), (3) **il piano orchestra una delega
NON-bloccante** (critical-path locale + sidecar in parallelo, "wait" di rado). Homun ha le capacità ma manca di tutte e
tre → turni lunghi e narrati, ~60 tool/turno (~5k token, ~3 min di primo round sui modelli deboli), 3-4 affordance di
decomposizione che competono con un fan-out sequenziale bloccante.

---

## Roadmap prioritizzata (per ROI/rischio → il tuo nord: fluido / performante / scalabile)

### 🟢 Ondata 1 — Quick wins, basso rischio, alta fluidità (giorni)
1. **Disciplina del prompt** (FLUIDO). Aggiungere le regole anti-chiacchiera di Codex + bias assumi-non-chiedere +
   prose-first; comprimere il METODO a 5 step. Solo testo di system prompt, **zero rischio architetturale**, stimato
   **−40-60% lunghezza turno** a parità d'informazione. → §1.
2. **Snellire il set di tool** (PERFORMANTE). Partizionare a un core piccolo sempre-attivo + differire il resto (già
   c'è `find_capability`/capability_corpus); differire i 6 tool browser finché l'intento non li chiede; comprimere le
   description. Stimato **−75% token-tool → −150-300ms (di più sui modelli deboli, dove il prompt-eval domina)**. → §2.
3. **Approved command prefixes** (FLUIDO). Ogni approvazione *insegna*: approvato `npm install` una volta, non si
   richiede più (per-sessione o persistente). Riduce l'attrito da per-chiamata a per-pattern. → §4.

### 🟡 Ondata 2 — Fluidità strutturale (il cuore; medio-grande)
4. **Separare PLAN_PROPOSE da update_plan** + **il piano orchestra la delega** (FLUIDO). PLAN_PROPOSE solo per azioni ad
   alto rischio (world-state); `update_plan` operativo di default (no blocco). Gli step del piano marcati "sidecar"
   diventano ciò che si delega → **risolve il finding del 2026-07-03** (le affordance non competono più; il piano è la
   fonte unica di decomposizione). → §3.
5. **Fan-out async NON-bloccante** (PERFORMANTE+SCALABILE). Sostituire il `for`-loop `block_in_place` sequenziale con
   `tokio::spawn` in parallelo + un tool `wait_subagents` chiamato *di rado* → latenza da `somma(figli)` a
   `max(locale, figli)`; il manager lavora sul critical-path mentre i figli girano. È il vero fix di fluidità dei
   subagenti. → §3.
6. **Streaming a item tipizzati** (FLUIDO percepito). Emettere eventi `item/started|delta|progress|completed` (specie
   **tool progress**: "sto eseguendo…") invece dei soli delta di testo → la UI mostra i tool in corso invece di una
   pausa cieca. → §5.

### 🔵 Ondata 3 — Più avanti / allineato alla roadmap
7. **AGENTS.md** istruzioni scoped/layered (= Fase 4.2 roadmap) + semantica `untrusted` (allowlist deny-by-default). → §4.

### 🚫 NON fare (o già fatto) — giudizio applicato
- **Agenti gerarchici (depth >1):** proposto dagli agenti, ma **confligge** con la scelta di sicurezza deliberata
  depth-1 ([[subagents]]) e con l'evidenza single-loop (non moltiplicare gli agenti). Rimandato, non ora.
- **Realizzare `on-failure` a fondo:** Codex stesso lo **deprecà** ("use on-request or never") → non rincorrere una
  feature morta. Basta il resolver che già c'è.
- **Skill confirmation policies:** **GIÀ FATTE** (Fase 0.3, 2026-07-03) — gli agenti le elencavano come mancanti.
- **Memoria:** Homun è **avanti** su Codex (§6) → non copiare all'indietro.

---

## §1 — Prompt & comportamento (agente 1)
**Codex (dal binario), regole che Homun NON ha:**
> "Do not begin responses with conversational interjections or meta commentary. Avoid openers such as 'Done', 'Got
> it', 'Great question', 'You're right to call that out'."
> "You avoid cheerleading, motivational language, or artificial reassurance, or any kind of fluff… communicate what is
> necessary — not more, not less."
> "Assume the user wants you to make changes… it's bad to output your proposed solution in a message, you should go
> ahead and actually implement." · Final answer: "favor conciseness… do not default to bullets… if it turns into a
> changelog, compress it."

**Homun (verificato):** il chat system prompt (`main.rs`, catena `let system = …`) è ~4300 parole con un **METODO
rigido a 5 step** (UNDERSTAND→CRITERIA→CLARIFICATIONS→EXECUTE→SYNTHESIZE) + blocchi condizionali sovrapposti e **nessuna
regola anti-narrazione** → il modello narra il processo ("ora chiamo find_capability…") e chiede troppo.

**Cambi concreti:** (a) preambolo anti-fluff; (b) METODO 5→2 step ("agisci; se manca un parametro bloccante, UNA domanda
mirata, altrimenti procedi con default dichiarati; appena hai dati sufficienti, sintetizza"); (c) bias
assumi-non-chiedere; (d) RESPONSE STYLE prose-first (tabelle solo se ≥3 campi×3 righe). Tutte chirurgiche, non toccano
le capacità.

## §2 — Set di tool / anti-bloat (agente 2)
**Codex:** core piccolo sempre-attivo; il resto **differito** dietro `find_capability` + auto-retrieve per-intento
(pochi tool pertinenti pre-caricati per messaggio); description **terse, action-first**. Browser NON nel core.

**Homun (verificato):** ~35-40 tool native **sempre** + fino a 24 MCP + 4 Composio = **~60 schemi/turno (~5k token)**;
**nessun narrowing per-step** nel loop agentico (solo sul route workflow); i 6 tool browser partono anche su task non-web;
description più lunghe/prescrittive. La macchina di progressive-disclosure (`find_capability`, capability_corpus)
**esiste già** ma non snellisce il set base.

**Cambi concreti:** partizionare `CORE_TOOL_NAMES` in un TIER-1 minimo (~8) sempre-attivo + differire il resto;
differire i tool browser finché l'intento li chiede (come Composio con l'auto-retrieve); comprimere le description
(spostare i "come usarlo" nel system prompt). *(Nota: verificare che `CORE_TOOL_NAMES`/`prune_tools_for_workflow_route`
siano simboli Homun prima di citarli — un agente ha in parte confuso Codex↔Homun.)*

## §3 — Piano + delega + async (agente 3) — IL CUORE
**Codex (verbatim):**
> "First, form a succinct high-level plan. Identify immediate blockers on the **critical path** vs **sidecar tasks**
> that can run in parallel… explicitly decide what to do **locally right now** before delegating."
> "Do not delegate urgent blocking work when your next step depends on it… keep the critical path moving locally."
> "Call **wait_agent very sparingly**… **while the subagent runs in the background, do meaningful non-overlapping work
> immediately**. Do not wait by reflex." · Tool: `spawn_agent` (non-bloccante, nomi gerarchici `/root/task1/task_3`),
> `wait_agent` (join selettivo), `fork_turns=none|all` (contesto).

**Homun (verificato):** TRE affordance che competono — `PLAN_PROPOSE` (approval, **STOPPA il turno**), `update_plan`
(operativo), `spawn_subagent` (**fan-out SEQUENZIALE bloccante**, `block_in_place`, depth-1). Il system prompt ordina
"per task multi-step FIRST propose the plan and STOP" → il modello si ferma e non arriva a delegare (finding 2026-07-03).

**Cambi concreti:** (A) **il piano orchestra la delega** — step marcati `sidecar:true` → delegati; il piano è la fonte
unica. (B) **fan-out async** `tokio::spawn` + `wait_subagents` di rado. (D) **PLAN_PROPOSE solo alto-rischio**,
`update_plan` operativo di default. → le tre affordance diventano un flusso solo, non-bloccante.
**Flag di giudizio:** la proposta "agenti gerarchici depth>1" NON si adotta ora (confligge con la scelta depth-1).

## §4 — Approval / sandbox / config (agente 4)
**Codex:** due assi ortogonali (sandbox fisica: read-only/workspace-write/danger; approval UX:
untrusted/on-failure/on-request/never); **approved command prefixes** (allowlist che *impara* dalle approvazioni);
**AGENTS.md** globale per istruzioni scoped; escalation su fallito ("policy decision… escalation action").

**Homun (verificato):** assi + enum + **enforcement sandbox** (Seatbelt macOS, Landlock Linux) **spediti** (ADR 0023,
Fasi 0.1-0.3, incl. **skill confirmation policies già fatte**). Stub: semantica ricca `on-failure`/`untrusted`,
approved-prefixes, AGENTS.md.

**Cambi concreti (per fluidità):** **approved command prefixes** (ondata 1 — il win vero: meno card di approvazione);
`untrusted` allowlist; **AGENTS.md** (= Fase 4.2). **Flag:** `on-failure` è deprecato in Codex → non realizzarlo a fondo.

## §5 — Streaming / responsività (agente 5)
**Codex:** protocollo a **item tipizzati** — `item/started`, `item/{agentMessage|plan|reasoning}/delta`,
`item/tool/call`, **`item/mcpToolCall/progress`** (progresso mentre il tool gira), `item/completed`,
`turn/plan/updated`. La UI mostra "in esecuzione…" senza aspettare il risultato.

**Homun (verificato):** solo `GenerateStreamEvent::Delta { text }` (+ marker inline). L'esecuzione dei tool è **opaca**
alla UI → pausa cieca durante bash/browser lunghi.

**Cambi concreti:** aggiungere varianti item-level (`ItemStarted/Delta/Progress/Completed`) + emettere **tool progress**
durante l'esecuzione. Alta fluidità *percepita*, medio sforzo.

## §6 — Memoria: dove Homun è GIÀ AVANTI (non copiare all'indietro) (agente 5)
- **Consolidamento 3-fasi off-lock** (prepare sync → LLM senza lock → apply sync): il lock non attraversa mai un
  `await`. Invariante **più forte** dell'heartbeat di Codex.
- **Isolamento scope a compile-time** (`MemoryScope` come arg del trait) vs ownership a runtime di Codex.
- **Briefing ibrido sempre-attivo** con generation-counter vs consolidamento solo-reattivo di Codex.
- **Dedup** nel learn (Jaccard) che Codex non mostra.
→ Semmai prendere solo l'idea di **schedulare il consolidamento** (soglia sul generation-counter), non l'architettura.

---

## Nota di metodo
Questa mappa è grounded sul **codice reale di Codex**, non sui doc. Prima di implementare un qualsiasi punto, ri-`grep`
i simboli Homun citati (i `file:line` invecchiano) — [[il codice fa fede, non i documenti]]. Ondata 1 è tutta a basso
rischio e alto ROI sul nord "fluido"; da lì si sale verso lo strutturale (piano/delega/async) che è anche dove converge
il lavoro sui subagenti (ADR 0025) e l'estrazione motore (ADR 0024).
