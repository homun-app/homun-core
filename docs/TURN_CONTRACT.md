# Turn Contract — chi possiede il turno

> Documento **vivo e corto**. Aggiornato quando cambia il contratto, non a ogni pezza.
> Estende i [CAPISALDI](CAPISALDI.md) #2 e #6 al pezzo che oggi crea ambiguità.
> Inventario converge/kill: [superpowers/2026-07-27-foundations-and-kill-list.md](superpowers/2026-07-27-foundations-and-kill-list.md).
> Piano di convergenza: [superpowers/plans/2026-07-27-turn-contract-convergence.md](superpowers/plans/2026-07-27-turn-contract-convergence.md).

**Ultimo aggiornamento: 2026-07-28 (contratto generale objective/effect/resume/terminal).**

---

## Invariante (una riga)

In ogni istante del turno, **esattamente uno** tra `model | harness | user` possiede
il control-flow. Quella verità è di **codice** (stato tipizzato + task status), non di
prosa nel messaggio né di card UI-only.

## Always Contract (legge)

Non N protocolli per kind. Un solo tipo + chokepoint:

```text
HitlEnvelope {
  kind: Choice | Clarify | Confirm | Vault | Payment | PlanPropose,
  payload: Value,
  hold_policy: Free | Hold,
  source_marker: String,   // CHOICES / CLARIFY / AWAIT_USER / …
}
```

Wire preferito: `‹‹AWAIT_USER››{ "kind":"choice"|…, … }‹‹/AWAIT_USER››`.
Legacy (`CHOICES`, `CLARIFY`, `MCP_CONFIRM`, …) **normalizzano** nello stesso envelope
(`crates/engine/src/hitl.rs`).

### Fine di ogni round senza tool — esattamente una

| Esito | Condizione | Effetti |
|---|---|---|
| `AwaitingUser(envelope)` | `classify_no_tools_stop` → `Await` | Stop. Vietati: tool, plan-nudge, reconcile-done sullo step “attendi”, `forced_synthesis`. Persist wait Free. UI = Waiting. |
| `NudgeEmit(kind)` | Prosa chiede all’utente **senza** envelope | Al più un nudge a emettere la card — **mai** ownership user |
| `Continue` / `Delivered` / `Synthesize` | Nessun envelope; harness decide | Synth solo se `!AwaitingUser && !Parked` |

**Invariante dura:** domanda in prosa senza envelope ⇒ **NON** è wait.

### Ogni messaggio utente successivo

| Caso | Comportamento |
|---|---|
| Wait Free aperto + resolution per kind | `try_resume_open_wait` → ResumeBinding (`continue_current_work`) |
| Confirm Hold | Approval API sullo stesso task |
| Nessun wait | Semantic/routing normale |

Steer (`Applying #n`) = solo mid-flight mentre il modello possiede il turno. **Mai** ResumeBinding.

## Fasi canoniche

```text
Running
  → AwaitingUser(envelope) // human-in-the-loop — ferma loop e scheduler-ready
  → Resuming(wait_id)      // risoluzione strutturata → bind OpenWork (stesso lavoro)
  → Parked(ModelUnavailable) // attesa macchina (steering/model-down) — ≠ AwaitingUser
  → Synthesizing           // solo se !AwaitingUser && !Parked
  → Delivered | Failed | Cancelled
```

## Elementi base (stesso scheletro per ogni kind)

| Elemento | Ruolo |
|---|---|
| `HitlEnvelope` + `AwaitingUser` | Stop: ownership → user. Nessun nudge/synthesis/tool. Free = thread libero; Hold = approval. |
| `UserResolution` | Click/RPC tipizzato (opzione, approve, clarify text). |
| `ResumeBinding` | Il turn successivo **deve** riprendere `open_work`, non “nuovo obiettivo” / discovery a freddo; passa dal normale `validate_decision`. |
| `OpenWork` | Carrier versionato della copia di recovery del contratto, piano residuo, capability e sessione browser (warm). Non è una seconda SoT: il record objective attivo vince quando disponibile. |

**Estensioni (dati, non protocolli):**

- `kind=Choice` → options; resolution = option match; `hold=Free`
- `kind=Clarify` → free text; `hold=Free`
- `kind=Confirm` → approval API; `hold=Hold`
- `OpenWork.browser` / `.plan` / `.capability` → campi del resume

Il browser **non** è il contratto. Prosa che chiede dati/scelta **non** è wait.

## Contratto objective ed effetti

`ObjectiveContractRecord` è la SoT per thread e conserva la richiesta utente completa
entro un limite, non la sola sintesi del router. La sintesi resta in
`scope_json.semantic_decision` per routing e osservabilità.

`allowed_actions_json` è la policy tipizzata autorevole. `mode` è descrittivo e serve
solo come fallback per record legacy con lista vuota. Metadati malformati o assenti
falliscono chiusi su `read + request_authorization`.

| Classe | Esempi | Gate aggiuntivo |
|---|---|---|
| `read` | letture, ricerca, planning, `browse` | Browser action lattice per le azioni nella pagina |
| `filesystem_write` | file/patch/comandi progetto, memoria durevole | sandbox/path jail/policy esistenti |
| `artifact_creation` | documenti, deck, immagini, salvataggio artifact | pipeline artifact esistente |
| `external_write` | connector write, messaggi, automazioni, computer/browser action | approval/perimeter/browser safety; pagamento one-use invariato |

Esposizione iniziale, discovery dinamica e dispatch consultano la stessa policy.
Selezionare un'opzione o digitare in un form esterno è `external_write` anche senza
submit; vietare conferma/acquisto/pagamento non trasforma le azioni preparatorie in read.
`read` e `request_authorization` restano sempre disponibili perché non mutano stato.

Il preflight semantico ritenta una sola volta un JSON troncato/invalido con budget
compatibile con modelli reasoning. Una contraddizione tra ricerca memoria e il solo flag
di ottimizzazione `standalone_choice_request` disattiva il flag, senza perdere l'intero
contratto in un fallback read-only.

## OpenWork durevole

Ogni wait Free salva in `open_work_json`:

- `schema_version`;
- revisione, obiettivo completo, mode, allowed/forbidden effects;
- `MemoryIntent`, incluso il solo intento Vault (mai valori segreti);
- completion contract;
- al massimo 12 step non conclusi con soli campi noti;
- stato browser, URL se disponibile e capability hint.

Sul resume il record objective attivo ha precedenza; altrimenti vale lo snapshot. Un
wait legacy senza entrambi usa il fallback read-only. `selected_capability` viene
azzerata per `execution_shape=agent_loop`, così la ripresa non aggira il validator.

## Convergenza terminale

Il broker proietta lo stato objective alla stessa frontiera che consegna il risultato:

| Esito turn | Stato objective |
|---|---|
| risposta finale consegnata, nessun wait | `completed` |
| cancel utente | `cancelled` |
| Choice/Clarify Free, Confirm/Vault/Payment Hold | resta `active` |
| park, errore retryable, nessuna risposta | resta `active` |

La transizione è protetta da `revision`: un turn vecchio non può chiudere un obiettivo
sostitutivo più recente. Lo stato del thread può restare `active`, perché descrive la
conversazione e non il lavoro in corso.

## Regole d’oro (anti-sovrapposizione)

1. **Un solo ingresso** in `AwaitingUser`: `classify_no_tools_stop` → envelope validato.
2. In `AwaitingUser`: **niente** tool rounds, nudge piano, `forced_synthesis`, auto-`step_advance` su step “scegli…”.
3. UI: `waiting` / Waiting…, **non** Working/writing.
4. Ripresa **solo** via ResumeBinding (`try_resume_open_wait`). Click Choice/Clarify = nuovo turn + wait consumato.
5. Prima di aggiungere un meccanismo: **estende** `HitlEnvelope.kind` oppure **non entra**.
6. `Parked` (macchina) ≠ `AwaitingUser` (persona).
7. Sul resume: **vietata** discovery a freddo se `OpenWork` vivo.
8. Nessun path può costruire un `ValidatedSemanticDecision` di resume senza validator.
9. Nessun tool viene esposto o eseguito fuori dalle classi effetto del contratto.
10. Solo il broker terminale può completare/cancellare l’obiettivo, con revisione attesa.

## Mapping oggi → contratto

| Oggi | Destino |
|---|---|
| `hitl::HitlEnvelope` + `classify_no_tools_stop` | **KEEP** — chokepoint Always |
| `‹‹AWAIT_USER››` + legacy CHOICES/CLARIFY/confirm | **KEEP** — normalizzano |
| `thread_hitl_waits` + `try_resume_open_wait` | **KEEP** — Free resume unico |
| `TurnOutcome.awaiting_user` | **KEEP** — SoT tipizzata; Free marker iniettato se manca; gateway persiste Free wait da outcome |
| `needs_clarification` bool | **REMOVED** — Clarify steering è `awaiting_user=Clarify Free` |
| Prompt-only `CHOICE RESUME` | **RETIRED** come SoT |
| Domanda in prosa senza card | **VIETATO** come wait — solo `NudgeEmit` |

## Cosa non è questo contratto

- **Memoria** → `MemoryFacade`.
- **Piano runtime** → `canonical_plan_value` / `LoopState.plan`.
- **Transport** → WS live.
- **Booking/Trenitalia special-case** → vietato.

## Gate di review (obbligatorio)

> “Questo introduce un **secondo** modo di fermare o riprendere il turno?”
> Se sì → rifiuto, o consolidamento esplicito in questo file.

## Test minimo Always (non del dominio booking)

1. Qualsiasi `HitlEnvelope` → zero tool/nudge/synthesis dopo; wait persistito; UI waiting.
2. Prosa senza envelope → al più un nudge-to-emit; **non** wait.
3. Resolution → ResumeBinding; ≠ `new_objective`.
4. OpenWork.browser caldo → no cold discovery; morto → harness dichiara.
5. Confirm Hold invariato.
6. Messaggio con wait Free aperto **non** crea steering `Applying #n`.
7. Resume conserva policy effetti e Memory/Vault intent senza escalation.
8. Policy mista espone ed esegue solo le classi autorizzate.
9. Delivery completa la revisione corrente; wait/park/no-answer restano active; revisione stale non transiziona.
