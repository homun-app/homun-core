# Turn Contract — chi possiede il turno

> Documento **vivo e corto**. Aggiornato quando cambia il contratto, non a ogni pezza.
> Estende i [CAPISALDI](CAPISALDI.md) #2 e #6 al pezzo che oggi crea ambiguità.
> Inventario converge/kill: [superpowers/2026-07-27-foundations-and-kill-list.md](superpowers/2026-07-27-foundations-and-kill-list.md).
> Piano di convergenza: [superpowers/plans/2026-07-27-turn-contract-convergence.md](superpowers/plans/2026-07-27-turn-contract-convergence.md).
> Recovery browser: [design](superpowers/specs/2026-07-28-browser-checkpoint-recovery-design.md)
> e [checklist operativa/verifiche](superpowers/plans/2026-07-28-browser-checkpoint-recovery.md).

**Ultimo aggiornamento: 2026-07-29 (journal, wake, receipt e resume canonici).**

---

## Invariante (una riga)

In ogni istante del turno, **esattamente uno** tra `runtime | adapter | user/evento`
possiede il control-flow. La verità autorevole è la revisione nel journal
`ExecutionContract -> ExecutionOutcome`; task status, agent run, messaggio e UI sono
proiezioni ricostruibili, non owner indipendenti.

## Always Contract (legge)

Non N protocolli per kind. Un solo ingresso e quattro soli esiti:

```text
ExecutionRuntime::execute(ExecutionContract)
  -> Completed(output, continuation?)
   | Suspended(WakeCondition, CheckpointEnvelope)
   | Cancelled(reason)
   | Failed(class, code, redacted_detail)
```

Una ripresa consegna un `WakeDelivery`, incrementa `revision` e `fencing_token`,
referenzia il checkpoint esatto e richiama lo stesso `execute` con lo stesso
`execution_id`. Nessun adapter possiede una API di continuazione alternativa.

`HitlEnvelope` è l'estensione dati usata dal loop quando il wake dipende dall'utente:

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
| Wait Free aperto + resolution per kind | consegna `WakeCondition::User` sullo stesso execution; la revisione ripresa costruisce `ResumeBinding(continue_current_work)` |
| Confirm Hold | Approval API → `WakeCondition::Approval` sullo stesso execution |
| Nessun wait | Semantic/routing normale |

Steer (`Applying #n`) = solo mid-flight mentre il modello possiede il turno. **Mai** ResumeBinding.

## Fasi canoniche

```text
Ready -> Running
  -> Suspended(User | Approval | At | Signal | Resource | ModelAvailable | EffectResolution)
  -> Ready(revision N+1, checkpoint + WakeDelivery)
  -> Completed | Failed | Cancelled
```

`WaitingUserApproval`, `WaitingTime`, `WaitingResource`, delivery state del messaggio
e objective status sono proiezioni. `Parked` non viene più prodotto dal nuovo loop:
resta leggibile soltanto nel bridge di recovery dei record steering precedenti.

## Sequenza operativa di riferimento

1. La sorgente (`interactive`, channel, automation, connector) costruisce lo stesso
   input e lo accoda al broker; prompt e placeholder visibile sono persistiti insieme.
2. Il worker acquisisce task, risorse e lease; il runtime crea o carica il contratto
   autorevole e confronta il fencing token.
3. L'adapter del `kind` esegue il proprio dominio senza scrivere stati lifecycle.
4. Ogni effetto non-read viene autorizzato e registrato prima del dispatch; replay,
   esito incerto e compensazione usano la receipt, non il testo del modello.
5. Il runtime valida e committa esattamente un outcome per la revisione.
6. Il projector aggiorna task, run, messaggio, objective, HITL e UI. Se fallisce,
   startup/recovery lo rigioca dal journal senza rieseguire l'adapter.
7. Un outcome sospeso registra un solo wake. La delivery atomica crea la revisione
   successiva con checkpoint e payload; il worker richiama lo stesso `execute`.
8. Dopo crash, una revisione senza outcome viene recuperata secondo lease/receipt;
   un effetto `Started` diventa `Uncertain`, mai un retry implicito.
9. Storie troppo lunghe possono chiudere il parent e creare atomicamente un child
   `continue-as-new`; rollback di dominio usa child compensation in ordine inverso.

## Elementi base (stesso scheletro per ogni kind)

| Elemento | Ruolo |
|---|---|
| `HitlEnvelope` + `AwaitingUser` | Stop: ownership → user. Nessun nudge/synthesis/tool. Free = thread libero; Hold = approval. |
| `UserResolution` | Click/RPC tipizzato che consegna il wake della revisione sospesa. |
| `ResumeBinding` | La revisione successiva **deve** riprendere `open_work`, non creare un nuovo obiettivo; passa dal normale `validate_decision`. |
| `OpenWork` | Carrier versionato della copia di recovery del contratto, piano residuo, capability e continuazione browser (warm o checkpoint). Non è una seconda SoT: il record objective attivo vince quando disponibile. |
| `CheckpointEnvelope` | Identità execution/revision/kind, objective, wake esatto, receipt associati e riferimento al payload persistito. |
| `EffectReceipt` | Stato durevole `Prepared -> Started -> Completed/Failed/Uncertain -> Compensated`; un `Started` interrotto non viene ritentato alla cieca. |

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

Il validator confronta ogni deliverable con la sua classe esatta:
`external_action → external_write`, `artifact → artifact_creation`,
`code_change → filesystem_write`. Una classe vietata non invalida una classe distinta
esplicitamente consentita. Sul resume Choice/Clarify la decisione resta `same_objective`,
mantiene la stessa revisione e non può sostituire l'obiettivo con il testo della risoluzione.

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
- sessione browser warm, disponibilità/generazione del checkpoint e capability hint;
- nessun valore form, selector, target CDP, URL nuovo o riferimento segreto (il campo URL resta solo per compatibilità legacy e non viene più popolato).

Sul resume il record objective attivo ha precedenza; altrimenti vale lo snapshot. Un
wait legacy senza entrambi usa il fallback read-only. `selected_capability` viene
azzerata per `execution_shape=agent_loop`, così la ripresa non aggira il validator.

## Browser long-running e recovery

Il browser estende lo stesso objective/effect/resume contract; non possiede un loop o uno stato
terminale separato. Dopo ogni osservazione confermata (`snapshot` o post-`act`) il gateway salva:

- metadati revision-fenced in `browser_checkpoints`;
- identità esatta `browser_epoch + cdp_target_id`, URL/origin e generation;
- valori soltanto per controlli form ammessi, bounded e cifrati nel file dedicato
  `browser-checkpoint-secrets.json` (mai nel DB, journal, OpenWork o risultato tool).

Alla perdita del sidecar, la pagina CDP condivisa resta viva. Il sidecar successivo prova una sola
volta, in ordine:

1. `adopted_live_page`: stessa epoch, target CDP e origin;
2. `draft_available`: target perso, URL riaperto e manifest opaco disponibile;
3. `degraded_url_only`: URL riaperto senza draft utilizzabile.

Ogni recovery forza uno snapshot nuovo e generation monotona prima di qualsiasi altra azione. La
RPC incerta che ha perso il client **non viene mai ritentata automaticamente**. Il recovery produce
`NoProgress`: il modello deve osservare e decidere esplicitamente il passo successivo.

`browser_rehydrate` è `external_write`, non compare nei tool read-only e accetta solo mapping scelti
esplicitamente tra ref freschi e controlli draft opachi. Il gateway decripta internamente, scrive solo
campi ancora vuoti e compatibili, poi forza un nuovo snapshot. Non esegue click, submit, booking,
login, pagamento o replay di bundle. Password, payment/card/CVV, file, hidden, contenteditable,
cross-origin, ambigui e fuori limite sono esclusi fail-closed.

Checkpoint e ciphertext vengono eliminati idempotentemente su terminal objective, revisione
sostitutiva, archive/delete thread, delete workspace e scadenza; la pulizia scadenze parte anche a
startup. Gli eventi del run registrano solo tier, generation, conteggi e reason tipizzata. Le pulizie
senza un run proprietario usano tracing strutturato `browser_checkpoint_cleared`, evitando di creare
un secondo owner terminale.

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
4. Ripresa **solo** via `WakeDelivered` sulla stessa execution; `ResumeBinding` è la ricostruzione semantica interna della nuova revisione.
5. Prima di aggiungere un meccanismo: **estende** `HitlEnvelope.kind` oppure **non entra**.
6. Attesa macchina = `Suspended(ModelAvailable|Resource)`; attesa persona = `Suspended(User|Approval)`.
7. Sul resume: **vietata** discovery a freddo se esiste sessione warm o checkpoint attivo.
8. Nessun path può costruire un `ValidatedSemanticDecision` di resume senza validator.
9. Nessun tool viene esposto o eseguito fuori dalle classi effetto del contratto.
10. Solo il projector del journal può completare/cancellare task, run, messaggio e obiettivo, con revisione attesa.

## Mapping oggi → contratto

| Oggi | Destino |
|---|---|
| `hitl::HitlEnvelope` + `classify_no_tools_stop` | **KEEP** — chokepoint Always |
| `‹‹AWAIT_USER››` + legacy CHOICES/CLARIFY/confirm | **KEEP** — normalizzano |
| `thread_hitl_waits` + `try_resume_open_wait` | **COMPATIBILITY PROJECTION** — conserva UI/OpenWork; il resume autorevole è il wake del journal |
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
3. Resolution → `WakeDelivered` e revisione N+1 dello stesso execution; quindi ResumeBinding, mai `new_objective`.
4. OpenWork.browser warm o checkpoint → `browse` resta live e no cold discovery; davvero morto → harness dichiara.
5. Confirm Hold invariato.
6. Messaggio con wait Free aperto **non** crea steering `Applying #n`.
7. Resume conserva policy effetti e Memory/Vault intent senza escalation.
8. Policy mista espone ed esegue solo le classi autorizzate.
9. Outcome commit completa la revisione corrente; un wake apre N+1; una revisione stale non transiziona né ripete effetti.
