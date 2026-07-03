# Agent-mode plan disambiguation — design (finding 1.2 / C)

Data: 2026-07-03. Stato: **approvato** (brainstorming). Prossimo: writing-plans.

## Problema (verificato sul codice, non dai doc)

Il system prompt di engine #1 contiene **due direttive PLAN_PROPOSE contraddittorie**:

1. **Blocco PLAN base** — `crates/desktop-gateway/src/main.rs` (~riga 23098), appeso in `format!` in
   modo **incondizionato** (ogni modalità): *«for a non-trivial MULTI-STEP task … FIRST propose the
   plan and STOP».*
2. **Blocco PLAN MODE** — `main.rs` (~riga 23219), appeso **solo** quando `mode=="plan"`: *«for ANY
   non-trivial request FIRST propose a plan … and STOP».*

Il #2 è quindi **ridondante**: il #1 forza già «proponi-e-fermati» anche in modalità `agent`. Ma il
toggle UI (`ChatMode = "agent" | "plan" | "ask" | "debug"`, `ChatView.tsx:3497`) promette che **Plan**
è la modalità che «waits for OK before acting» e **Agent** è quella che agisce. Il prompt fa invece
comportare **agent come plan** per qualsiasi cosa multi-step.

Conseguenze:
- **Correttezza generale:** agent mode non onora il proprio contratto (esegue → invece si ferma).
- **Modelli deboli (finding 1.2):** l'eval girava in agent mode (default `unwrap_or("agent")`,
  `main.rs:23217`); gemma4:12b **ha obbedito** al #1 (PLAN_PROPOSE + stop) e il turno si è **fermato**.
  Non un errore del modello: un prompt miscalibrato. Il *nudge* tier per redirigere alla delega è già
  stato **falsificato e revertito** (STATO 1.2 blocker #1) → il fix non è «spingere di più», è
  **rimuovere la competizione**.

Nota: `spawn_subagent` è flag-off e **non** descritto nel prompt → la competizione LIVE è solo
PLAN_PROPOSE vs update_plan. I subagenti restano ortogonali/fuori scope.

## Decisione

- **Agent (default) / debug:** eseguono **operativo** — creano un piano con `update_plan` (objective +
  step) e lo **eseguono** nello stesso turno, un passo alla volta, piano vivo, **senza** fermarsi per
  approvare il piano. L'approvazione resta per le **AZIONI rischiose** (asse approval, già esistente),
  non per il fatto di avere un piano.
- **Plan:** **propone-e-si-ferma** (PLAN_PROPOSE + STOP), esegue solo dopo approvazione.
- **Ask:** invariato (nessun tool).
- **Eccezione unica in agent/debug:** se l'utente chiede **esplicitamente** di vedere/approvare/creare
  un piano prima, il modello emette `‹‹PLAN_PROPOSE››` e si ferma (trigger **utente**, non indovinato).

## Approccio: B — condizionale nel CODICE (non nel prompt)

Scartato **A** (un blocco con la condizione «in plan proponi, altrimenti esegui»): lascerebbe una
condizione che il **modello debole deve ragionare** — proprio il fallimento che ADR 0018 / caposaldo #2
evitano. In B è l'**harness** a scegliere la direttiva per modalità: il modello debole in agent **non
vede mai** l'istruzione «propose the plan and STOP», quindi non ci si può bloccare (caposaldo #2/#6 —
l'harness possiede il control-flow, offre meno da sbagliare).

## Design

### Seam puro

`plan_directive_for_mode(mode: &str) -> &'static str` (nuovo; beside il prompt builder, o piccolo
modulo). Ritorna una `&'static str` (const literal → niente escaping `{{`/`}}` da `format!`; le graffe
JSON degli esempi restano letterali):

- `"ask"` → `""` (nessun piano; ask non ha tool).
- `"plan"` → **PLAN_MODE opener** (propone-e-STOP) **+** corpo operativo condiviso (per l'esecuzione
  post-approvazione).
- `_` (agent / debug / default) → **agent opener** (esegui operativo + eccezione utente-esplicita)
  **+** corpo operativo condiviso.

Composizione DRY: `AGENT_OPENER + OPERATIONAL_BODY`, `PLAN_OPENER + OPERATIONAL_BODY`; il corpo
operativo è **una** costante condivisa.

### Testi (completi, no placeholder)

**OPERATIONAL_BODY (condiviso agent+plan):**
> Use update_plan to CREATE or revise the plan (with an `objective`/goal and steps); use step_advance
> to move ONE step's status (doing→done) by its id WITHOUT re-sending the plan, so steps never
> duplicate. The plan is shown to the user as a CARD — do NOT repeat it in prose (at most one line of
> context). For single-step requests no plan is needed. STEP-AT-A-TIME: work ONE step at a time — do,
> then VERIFY that step's result (file written, search returned usable results, build/render
> succeeded), and only THEN mark it `done`. Give each step a `done_criterion` (the concrete checkable
> proof it's finished): a step you mark done is INDEPENDENTLY verified against its evidence before it
> counts — if it isn't actually complete you'll be told and must keep working. Your working budget
> RESETS every time a step is verified complete, so a long task can run as long as it KEEPS CLOSING
> steps — never rush or skip verification, and never mark a step done before its result exists.
> RESUMING: if the conversation ALREADY shows an in-progress plan (some steps done, others not),
> CONTINUE it — re-emit with update_plan keeping completed steps done, and proceed from the first
> not-done step; do NOT restart from scratch or re-propose.

**AGENT_OPENER (agent/debug/default):**
> PLAN: for a non-trivial MULTI-STEP task (development, refactor, involved research, actions with
> effects), CREATE an operational plan with update_plan (set its `objective`) and EXECUTE it in THIS
> turn, one step at a time — do NOT stop to ask approval of the plan itself; just start working.
> Irreversible/risky ACTIONS are gated separately by the approval system, not by proposing a plan.
> ONLY if the user EXPLICITLY asks to see, approve, create, or test a plan FIRST: emit on its own line
> `‹‹PLAN_PROPOSE››{"summary":"objective in brief","steps":["step 1","step 2"]}‹‹/PLAN_PROPOSE››`
> (valid JSON) and STOP, executing after approval.

**PLAN_OPENER (plan):**
> PLAN MODE (chosen by the user): for ANY non-trivial request FIRST propose a plan — emit on its own
> line `‹‹PLAN_PROPOSE››{"summary":"objective in brief","steps":["step 1","step 2"]}‹‹/PLAN_PROPOSE››`
> (valid JSON) — and STOP. The user will see Accept/Edit; EXECUTE the plan ONLY in the NEXT turn after
> approval; if they ask for changes, revise and re-propose.

### Wiring

- **Rimuovi** il blocco base incondizionato (`main.rs` ~23098–23125).
- **Rimuovi** l'arm `"plan" =>` che appende il vecchio blocco #2 (~23219–23222) dal `match mode`
  (~23218). Gli arm `"ask"` e `"debug"` restano (testo mode-specifico), MA il piano non è più lì.
- **Appendi una sola volta** `plan_directive_for_mode(&mode)` dopo il bind di `mode` (`main.rs:23217`),
  se non vuoto: `if !d.is_empty() { system = format!("{system}\n\n{d}"); }`. Ordine: dopo gli altri
  blocchi, coerente con oggi.
- `ask` → stringa vuota → nessun piano (e il drop dei tool a ~23976 resta).

### Confini / unità

- Il seam è **puro** (mode→testo), niente `AppState`, niente I/O → unit-test deterministici.
- Nessun altro comportamento cambia: plan/ask/debug preservati; agent passa da «proponi-e-fermati» a
  «esegui operativo». Tier-adattivo (ADR 0018) e subagenti **non** toccati.

## Error handling / edge

- `mode` sconosciuto/None → `unwrap_or("agent")` già a monte → arm `_` (operativo). Fail-safe.
- Piano già in corso / messaggio di continuazione: la **plan-precedence** esistente (`main.rs` ~23151,
  tier- e flag-independent) continua a valere → il control-flow del piano attivo non regredisce.
- Modalità plan invariata → nessuna regressione della UX di approvazione (card GOAL+STEPS).

## Testing

- **Unit (seam puro):**
  - `plan_directive_for_mode("agent")` **non** contiene «propose the plan and STOP» e **contiene**
    «EXECUTE it in THIS turn» + «update_plan».
  - `plan_directive_for_mode("debug")` = stessa direttiva operativa di agent (non propone-e-ferma).
  - `plan_directive_for_mode("plan")` **contiene** «PLAN MODE» + «STOP» + il corpo operativo.
  - `plan_directive_for_mode("ask")` == `""`.
  - agent e plan condividono `OPERATIONAL_BODY` (entrambi contengono «STEP-AT-A-TIME» + «RESUMING»).
- **Runtime eval (caposaldo #2, gemma4:12b locale, gateway debug):**
  - il prompt multi-step di 1.2 in **agent mode** → emette `update_plan` ed **esegue** (niente
    PLAN_PROPOSE+stop; il turno non si ferma).
  - lo stesso in **plan mode** → **PLAN_PROPOSE + STOP** (invariato).
  - `ask` → nessun tool; `debug` → esegue (systematic) senza fermarsi a proporre.
- Gate: `cargo test -p desktop-gateway` (o il target del crate), build del gateway.

## Caposaldi

- #2 (harness possiede il control-flow, funziona sul tier debole): la decisione plan-vs-execute è
  dell'harness per modalità; il debole non ragiona più una condizione.
- #6 (stato/control-flow di codice; il modello riempie slot vincolati): una direttiva coerente per
  modalità, decisa nel codice.
- #9 (workspace agentico, superfici spiegabili): agent onora il contratto del suo toggle.

## Non-goal (dichiarati)

- Tier-adattività ADR 0018 (debole→direttiva più stringata) — follow-up, non in questa slice.
- `spawn_subagent` / orchestrazione delega — flag-off, ortogonale.
- Cambi alla UX del toggle o alla card di approvazione.
