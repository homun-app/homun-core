# Decision 0020: Convergenza del loop chat sull'OrchestratorBrain — l'harness possiede il control flow

Date: 2026-06-27

## Status

Proposed. Esegue il **passo 5 ("Convergenza con OrchestratorBrain")** rimasto aperto dalla
[0016](0016-harness-owned-task-engine-cross-model.md), alla luce di un'analisi strutturale
del loop di produzione (2026-06-27). Si appoggia alla [0018](0018-adaptive-harness-subagents-triggers.md)
(Pavimento/Manopole, inner loop libero per i capaci) e abilita il fan-out di sub-agent con tool.

## Perché questa decisione esiste

Un'analisi a quattro assi del loop live (`stream_chat_via_openai`, `crates/desktop-gateway/src/main.rs`)
ha trovato un quadro coerente: **il design ADR è sano, ma il principio portante della 0016 —
"l'harness possiede il loop; il modello non possiede mai il control flow" — è l'unico pezzo NON
cablato.** Il sistema porta **due motori** che lo implementano a metà:

1. **Produzione** = `stream_chat_via_openai`: loop **model-driven** guidato da un prompt-prosa.
   L'harness possiede il *recinto* (budget, no-progress/wander/repeat break, ceiling, rimozione
   tool sull'ultimo round, rifiuti read-only, conferme di scrittura, gate F2 `verify_step_complete`,
   sintesi-fallback). Il modello possiede lo *sterzo*: se pianificare, quale tool, quando "done",
   quando fermarsi. Il piano è avvolto in `ExecutionPlan` ma `merge_execution_plan` chiama ancora
   dentro `merge_plan` che fa **match per TITOLO** (`main.rs` ~:6747) → l'identità inferita dal testo,
   che la 0016 invariante #3 vietava, sopravvive sotto la vernice.
2. **`crates/orchestrator`** (`OrchestratorBrain`): piano tipizzato con `step_id` stabili + DAG
   `depends_on` (`types.rs`). Ma è **dormiente come driver**: `execute_plan` (`brain.rs` ~:166)
   itera gli step **una volta, lineare, ignorando `depends_on`**; valida piani statici (`make_deck`)
   e accoda task durabili, non guida mai un turno chat. I subagenti (`crates/subagents/runner.rs`)
   sono **slot-filler** (`generate_json` singolo, niente tool/browser/multi-round).

### I sintomi discendono da qui

- **I piani non vanno avanti** (risposta completa accanto a un piano 0/4): il deliverable esce dai
  canali **final-round / forced-synthesis** dove i tool del piano sono rimossi dal payload
  (`main.rs` ~:19210, ~:22924) e al modello si dice di NON aggiornare il piano → bypassa la macchina
  a stati. In più F2 è un giudice severo affamato di `step_evidence` (azzerato ad ogni step) → uno
  step fatto via composizione/ragionamento non ha evidenze → "done" resta bloccato su "doing". Il
  piano **narra, non guida**: `depends_on`/`kind`/`risk` sono inerti (`main.rs` ~:6681).
- **Stesso prompt + stesso modello → risultati diversi**: temperatura 0 (nessun `seed`) dà un seme
  piccolo, ma il control-flow ramificato lo **amplifica**: profilo browser ephemeral (cookie freschi
  → pagine/snapshot diversi), pianifica-o-no (un token ribalta il regime di budget), numero di turni
  variabile (confirm-gating fa partire continuazioni). Non è sampling inevitabile: è struttura.

## Decisione

**Convergere: instradare il turno chat attraverso un `OrchestratorBrain` reso un vero esecutore di
DAG, in modo che l'harness possieda il control flow.** L'operazione è **fasata e dietro flag**
(`HOMUN_ORCHESTRATED_CHAT`, default OFF) per non rompere il motore #1, che resta il fallback finché
ogni fase non è validata. Nessun "big bang": ogni fase è shippabile e misurabile da sola.

### Invarianti da preservare (0016 §invarianti, 0018 capisaldi)

- **Identità non inferita**: `step_id` assegnato UNA volta dal runtime; mai ricostruito da match per
  titolo. → cancellare il title-matcher di `merge_plan` quando il driver è il Brain.
- **Monotonicità**: uno step `done` (verificato) non torna mai indietro.
- **Boundedness**: budget per-step + ceiling restano (riusare F1).
- **Inner loop libero per i capaci** (0018): dentro uno step, un modello capace guida liberamente;
  i deboli ricevono slot vincolati. Il Brain possiede *attorno* allo step (quale step, quando done,
  stop), il modello riempie *dentro*.
- **Scrittura single-threaded** + envelope ereditato fail-closed per i sub-agent (già in
  `subagent_workflow.rs`, riusare).
- **Memoria**: ogni recall/write-back passa dall'unico `MemoryFacade`.

### Le fasi

**Fase 0 — questo documento.** Roadmap + invarianti + criteri di validazione.

**Fase 1 — Driver DAG minimo, un solo step tool-capace, dietro flag.**
Un nuovo esecutore (`orchestrated_chat`) che: (a) chiama il planner UNA volta → piano con `step_id`
stabili (pianificazione **deterministica**, niente pianifica-o-no); (b) schedula per `depends_on`
(topologico); (c) per ogni step esegue un **inner loop bounded che riusa il dispatch tool esistente**
(browser incluso) scoperto a `goal` + `allowed_actions` dello step; (d) **l'ESECUTORE marca done**
dopo `verify_step_complete` (non il modello) → i piani avanzano per costruzione; (e) streama progresso
+ sintesi finale. Obiettivo: dimostrare "harness possiede il control flow" su un task reale (es. il
briefing) con piano che traccia il lavoro 1:1.

**Fase 2 — Sub-agent con tool (read/gather).** Dare ai sub-agent accesso ai tool via la stessa
capability facade, così uno step `SubagentTask` può davvero browsare/cercare. Sblocca la 0018
Pilastro 3 e prepara il parallelo.

**Fase 3 — Fan-out parallelo.** Step indipendenti del DAG eseguiti in concorrenza (sul pool
`task-runtime` o tokio), con isolamento browser per-contesto (multi-tab/sidecar) e riconciliazione
in-turn via il `MemoryFacade`. È il "Codex-style" richiesto.

**Fase 4 — Ritiro del title-matcher + convergenza piena.** Quando il Brain guida di default,
cancellare `merge_plan` (title) e il prompt-prosa di control-flow dal motore #1; il modello-loop
resta solo come modalità "inner loop libero" *dentro* uno step.

### Criteri di validazione (per fase)

- Piano traccia il lavoro: a fine turno il piano è coerente con il deliverable (niente 0/4 con
  risposta completa).
- Riproducibilità: stesso prompt/modello → stessa **struttura di piano** ed esiti vicini (la varianza
  residua è solo contenuto browsato, non control-flow).
- Nessuna regressione sui task già validati (briefing, ricerca multi-step) col flag ON vs il motore #1.

## Rischi

- Riscrive il cuore: mitigato dal flag + fallback al motore #1 + validazione per fase.
- Lo scheduler DAG e l'esecuzione step tool-capace **non esistono** oggi → Fase 1 è un build, non un
  wire-up. Stima onesta: multi-sessione.
- I modelli deboli sul planner: riusare lo `json_schema` strict + repair già shippato (0016 Fase 1,
  `openai_compat.rs`).

## Conseguenze

Chiude il divario che la 0016 ha aperto e che ogni guard aggiunta al motore #1 allarga. Rende
plan-progression e (gran parte del) non-determinismo proprietà **strutturali risolte**, non toppe.
Abilita il fan-out di sub-agent (Fase 3) sullo stesso grafo. Finché il flag è OFF, comportamento
invariato.
