# Turn Contract — chi possiede il turno

> Documento **vivo e corto**. Aggiornato quando cambia il contratto, non a ogni pezza.
> Estende i [CAPISALDI](CAPISALDI.md) #2 e #6 al pezzo che oggi crea ambiguità.
> Inventario converge/kill: [superpowers/2026-07-27-foundations-and-kill-list.md](superpowers/2026-07-27-foundations-and-kill-list.md).
> Piano di convergenza: [superpowers/plans/2026-07-27-turn-contract-convergence.md](superpowers/plans/2026-07-27-turn-contract-convergence.md).
> Recovery browser: [design](superpowers/specs/2026-07-28-browser-checkpoint-recovery-design.md)
> e [checklist operativa/verifiche](superpowers/plans/2026-07-28-browser-checkpoint-recovery.md).

**Ultimo aggiornamento: 2026-07-30 (restart HITL/browser, terminal adoption, model override).**

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

`Running` non è nominale: nasce da `AttemptStarted(owner_id, fencing_token)` nel
journal. Dopo un crash, una nuova lease può sostituire l'owner soltanto con fence
strettamente maggiore tramite `AttemptReclaimed`; un semplice `FenceAdvanced` è
vietato mentre la revisione è Running. Il gateway committa l'outcome con l'API
stretta che richiede un attempt Running al fence del contratto. La lease persiste una
generazione immutabile separata dall'heartbeat: anche se lo stesso `worker_id` riacquisisce
il task, il vecchio watchdog, dispatch o commit non può operare sulla nuova lease. Una
lease ancora attiva non è riacquisibile neppure dallo stesso owner: ogni task ha un solo runner.

`WaitingUserApproval`, `WaitingTime`, `WaitingResource`, delivery state del messaggio
e objective status sono proiezioni. `Parked` non viene più prodotto dal nuovo loop:
resta leggibile soltanto nel bridge di recovery dei record steering precedenti.

## Sequenza operativa di riferimento

1. La sorgente (`interactive`, channel, automation, connector) costruisce lo stesso
   input e lo accoda al broker; prompt e placeholder visibile sono persistiti insieme.
   L'eventuale override modello del composer fa parte dell'input durevole della execution:
   ogni revisione lo conserva salvo un nuovo override esplicito nella wake. Un valore
   `provider::model` deve risolvere un provider abilitato e una voce presente nel catalogo;
   non modifica il binding di ruolo persistente.
   I task `proactive_prompt` ricevono gia alla creazione uno scope thread deterministico
   derivato da task id e sorgente; i record legacy senza scope vengono normalizzati nello
   stesso modo prima di costruire il contratto.
2. Il worker acquisisce task, risorse e lease; il runtime crea o carica il contratto
   autorevole, confronta il fencing token e registra `AttemptStarted`. Una revisione
   Running lasciata da un worker perso viene reclamata atomicamente solo da una
   lease con fence maggiore.
3. Il runtime controlla il budget prima del dispatch e non registra retry il cui wake
   raggiunge o supera la deadline. Il registry risolve soltanto kind esatti o prefissi
   registrati e consegna all'adapter un `ExecutionAdapterContext`, mai `AppState`; il
   context entra nel dominio registrato senza esporre store o client generici.
4. Ogni effetto non-read viene autorizzato e registrato prima del dispatch; replay,
   esito incerto e compensazione usano la receipt, non il testo del modello. La
   receipt è identificata dalla chiamata logica (`execution + operation + call_id`),
   mentre l'hash degli argomenti verifica il payload ma non deduplica due intenti distinti.
   `EffectHost` è l'unico modulo gateway che prepara, reclama e completa receipt:
   tool generici, `use_computer`, `browser_act`, `browser_rehydrate` e delivery canale
   entrano nello stesso host. Sandbox, Vault, connector gate, browser safety e payment
   approval restano gate di dominio più stretti, non protocolli alternativi.
   Per le capability, prepare e claim sono una sola transazione che verifica task running,
   owner, generazione della lease, revisione e fencing token autorevoli. Gli output di projection sono invece
   legati atomicamente alla revisione/fence e al claim outbox corrente, perché possono essere
   rigiocati dopo il terminal. `EffectHost` rifiuta un adapter output senza quel claim e la
   stessa transazione verifica il claim prima di preparare o reclamare la receipt.
5. Il runtime valida e committa esattamente un outcome per la revisione. La stessa
   transazione crea una riga `execution_projection_outbox` per ogni projector registrato,
   legata a execution, revisione e kind; l'outbox non duplica outcome o payload sensibili.
6. Il projector reclama la riga outbox con owner, process generation e claim token,
   carica la revisione esatta dal journal e aggiorna task, run, messaggio, objective,
   HITL e UI. L'evento terminale con `projection_ref` è l'ack finale. Dopo crash un
   nuovo process generation reclama un claim precedente solo dopo la sua finestra di
   validità. Il worker rinnova il claim ogni 30 secondi, verifica il token prima di
   ogni adapter output e il guard RAII cancella l'heartbeat anche se la projection
   viene cancellata o va in panic. Ogni drain, incluso il replay di startup, gira in un task supervisionato: un panic
   degrada la health ma non termina il supervisor; dopo la finestra di validità il claim
   e reclamabile anche nella stessa process generation. Per lo stesso execution e projector,
   la revisione N+1 non e reclamabile finche ogni revisione precedente non e `Completed`;
   gli endpoint notificano l'unico supervisor e non avviano drain concorrenti.
   `projection_ref` rende atomico l'ack nel journal anche per
   gli eventi terminali; una proiezione parziale o già ackata converge
   idempotentemente senza rieseguire l'adapter.
   Gli errori del trasporto stream sono eventi `Activity`, non terminali logici. Solo
   l'outcome canonico proietta il terminale. Un vecchio terminale stream
   `Done | Error | Cancelled` privo di `projection_ref` puo essere adottato atomicamente
   soltanto dalla projection dello stesso kind; terminali di tipo diverso restano
   conflitti di invariante.
7. Un outcome sospeso registra un solo wake. La delivery atomica risolve anche la
   projection `thread_hitl_waits` collegata al messaggio sorgente, crea la revisione
   successiva con checkpoint e payload e richiama lo stesso `execute`. Il wait UI non
   possiede un secondo percorso di resume e non puo restare aperto dopo la wake canonica.
8. Dopo crash, una revisione senza outcome viene recuperata secondo lease/receipt;
   un effetto `Started` diventa `Uncertain`, mai un retry implicito.
   Per delivery canale e remote approval, la receipt completata o incerta conserva canale,
   contesto e fingerprint SHA-256 del destinatario tentato, mai il destinatario in chiaro;
   questa evidenza non entra nell'identita stabile della chiamata.
   La risoluzione verificata `Applied` completa la receipt; `NotApplied` la riporta a
   `Prepared`, rendendo sicuro un nuovo dispatch con la stessa identità/idempotency key.
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
Per capability e subagent il runtime normalizza il formato prodotto
`allowed_actions` nella `ExecutionPolicy` canonica; il vecchio formato a flag resta
solo compatibilità. Prima del dispatch `ExecutionAdapterContext` verifica che tutti
gli effetti dichiarati dal task siano contenuti nel contratto autorevole. Una
violazione termina come `Failed(permanent, execution_policy_denied)` senza invocare
l'adapter. `approved_automation` richiede autonomia almeno 4 e nessuna approval
esplicita per diventare `Preauthorized`.
Per `chat_turn`, anche il campo broker `approval` entra nella stessa policy:
`read_only` non può essere ampliato da metadati residui; `full` e `confirm` rendono
rappresentabili le tre classi mutanti con approval `OnRequest`; `autonomous` usa
`Preauthorized`. Objective contract e gate di dominio possono sempre restringere.
Selezionare un'opzione o digitare in un form esterno è `external_write` anche senza
submit; vietare conferma/acquisto/pagamento non trasforma le azioni preparatorie in read.
`read` e `request_authorization` restano sempre disponibili perché non mutano stato.

Il validator confronta ogni deliverable con la sua classe esatta:
`external_action → external_write`, `artifact → artifact_creation`,
`code_change → filesystem_write`. Una classe vietata non invalida una classe distinta
esplicitamente consentita. Sul resume Choice/Clarify la decisione resta `same_objective`,
mantiene obiettivo, mode e revisione del contratto e non può sostituire l'obiettivo con
il testo della risoluzione. La lista `allowed_actions_json` della fase corrente può
restringersi senza cambiare tale identità: non amplia la policy e non invalida checkpoint
appartenenti allo stesso obiettivo.

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

Ogni `browser_act` accettato dal safety gate e ogni `browser_rehydrate` reclama una
receipt immediatamente prima della RPC mutante. Navigate, snapshot, screenshot, tabs,
dialog e `browser_done` restano receipt-free. Un errore sidecar non classificabile
dopo l'invio produce `Uncertain`; uno stale ref riconosciuto come non applicato chiude
la receipt con `applied=false`. Le receipt browser non persistono snapshot o valori
form: conservano solo un replay notice e metriche non sensibili. Il browser restituisce
lo stesso `ToolOutcome` generale delle altre capability: una receipt incerta sospende
subito il loop e non viene ridotta a testo interpretabile dal modello.

Checkpoint e ciphertext vengono eliminati idempotentemente su terminal objective, revisione
sostitutiva, archive/delete thread, delete workspace e scadenza; la pulizia scadenze parte anche a
startup. Gli eventi del run registrano solo tier, generation, conteggi e reason tipizzata. Le pulizie
senza un run proprietario usano tracing strutturato `browser_checkpoint_cleared`, evitando di creare
un secondo owner terminale.

Al riavvio il renderer monta gli effetti che leggono thread, messaggi, wait e activity solo dopo
l'apertura del gate di autenticazione. Il backend resta la SoT: transcript e choice card vengono
ricostruiti dalle projection, non mantenuti da stato React sopravvissuto al processo.

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
11. Vietati adapter wildcard: un kind sconosciuto produce e committa
    `Failed(permanent, unsupported_execution_kind)`, senza fallback locale.
12. Il task non può ampliare gli effetti del contratto: il context nega prima del
    dispatch ogni classe dichiarata ma assente dalla policy autorevole.
13. Una deadline scaduta termina come `Failed(permanent,
    execution_deadline_exceeded)` senza invocare l'adapter; un backoff non può creare
    un wake alla deadline o oltre.
14. Una sospensione user non è proiettata finché payload HITL e `OpenWork` non sono
    persistiti. Errori di store, lock o serializzazione mantengono la proiezione
    pendente e rigiocabile; non sono convertiti in snapshot vuoti.
15. La risposta verso Telegram/WhatsApp è un `external_write` con receipt legata alla
    revisione di proiezione. Un replay riusa `Completed`; un invio interrotto diventa
    `Uncertain` e non viene ripetuto implicitamente. La proiezione resta senza ack
    terminale finché la receipt non viene risolta; il replay del projector la chiude
    solo dopo `Applied` o dopo un nuovo invio consentito da `NotApplied`.
16. Il bootstrap non avvia worker su una migrazione DB fallita o su outcome committati
    che il projector non riesce a rigiocare. Una wake `At` fuori dal range temporale
    fallisce la proiezione invece di perdere `not_before` e rendere subito eseguibile il task.
17. Nessun call site gateway fuori da `effect_host.rs` può invocare direttamente
    `prepare_effect_receipt`, `claim_effect_receipt` o `complete_effect_receipt`.
    La delivery canale è ammessa come output dell'adapter solo per un contratto
    `chat_turn` con source `channel` e thread scope coincidente; non amplia i tool del modello.
18. Timeout, join failure e trasporti falliti di un write connector sono
    `UnknownRemoteOutcome`: la receipt diventa `Uncertain` e il loop si sospende. Telegram
    può fare rebind e retry solo su connect failure precedente al dispatch; timeout o risposta
    persa non vengono mai inviati una seconda volta nello stesso claim.
19. Il resolver operativo usa `GET /api/effects/uncertain` e
    `POST /api/effects/{receipt_ref}/resolve`. Verifica l'ownership utente, aggiorna
    receipt e wake nella stessa transazione quando il turno è sospeso, e rigioca le
    proiezioni terminali senza fabbricare una wake quando l'effetto appartiene all'output adapter.
    La risoluzione e il replay sono single-flight per receipt; un concorrente attende il leader
    e riceve `409` invece di reclamare di nuovo una receipt `Started`.
20. `OutcomeCommitted` e projection outbox sono una sola transazione. Il worker non
    scandisce più tutta la storia committata: reclama solo righe `pending` dovute o
    claim appartenenti a un process generation precedente.
21. `pending → claimed → completed|pending|blocked` è l'unico lifecycle della delivery
    di proiezione. Un worker può completare, ritentare o bloccare solo con owner,
    generation e token del claim corrente. `blocked` non ha timeout automatico.
22. `Applied` e `NotApplied` aggiornano receipt, wake e righe outbox bloccate nella
    stessa transazione. Il gateway può quindi osservare soltanto receipt incerta con
    projection bloccata oppure receipt risolta con projection nuovamente `pending`.
23. Il commit canonico non attende il projector: notifica il worker e restituisce lo
    stesso outcome anche se una proiezione propria o altrui deve essere ritentata. Al
    boot gli outcome già committed vengono proiettati prima di abortire i soli run
    rimasti senza outcome; un errore viene esposto in health e ripreso dal worker.
24. Solo `chat_turn` possiede le transizioni lifecycle di task e agent run.
    `proactive_prompt` può riusare il projector per superfici visibili senza chiudere
    prematuramente lease o run del runner non-chat.
25. Risposte di canale e notifiche di approvazione remota sono adapter output dello
    stesso `EffectHost`. Un errore verificato prima dell'invio riporta la receipt a
    `Prepared`; timeout e risposte sidecar `5xx` sono esiti remoti ambigui e bloccano
    l'outbox su receipt fino a risoluzione. L'identità della notifica di approvazione
    usa approval id e thread, non le preferenze correnti di canale/destinatario; una
    card scaduta viene marcata `expired` prima di qualsiasi dispatch.

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
