# Agentic Platform Readiness

Verificato 2026-08-31 dopo test su app installata `v0.1.1096` con profilo reale
e confronto rapido con Codex, OpenCode, OpenClaw e pattern Manus-like.

Questo documento ridefinisce il benchmark di Homun: non un coding agent puro,
ma una piattaforma agentica local-first per automatizzare processi aziendali.
La parte coding deve funzionare bene, ma e' una capability dentro un core piu'
ampio: chat, run durevoli, browser/computer, approval, automation, memoria,
privacy, modelli, skill, MCP/addon e canali.

## North Star

Homun deve essere giudicato come "business process agent workbench":

- un utente descrive un processo operativo, anche ambiguo o lungo;
- Homun lo trasforma in run durevoli con step, strumenti, ricevute e stato
  canonico;
- ogni azione rischiosa passa da approval strutturata, non da testo del modello;
- automation e addon possono ripetere il processo senza ereditare stato sporco;
- memoria, Vault e privacy spiegano cosa viene usato, cosa viene bloccato e
  quale modello riceve quale contesto;
- la UI mostra la verita' del runtime, non una seconda interpretazione locale.

## Competitor Signal

Codex insegna disciplina operativa: ambienti isolati, task paralleli,
integrazioni, subagent/skill/MCP, review e stato riproducibile. Homun non deve
copiarne la UX da coding, ma deve copiarne l'affidabilita' del ciclo
`input -> run -> tool -> diff/effect -> review -> terminale`.

OpenCode, dal codice pubblico, ha una separazione chiara fra agenti `plan` e
`build`, subagent `general`, permission prompt e session execution durevole. La
lezione per Homun e' avere modalita' operative esplicite anche per business
processes: `Analizza`, `Esegui`, `Automatizza`, `Sorveglia`.

OpenClaw, dal codice pubblico, e' piu' vicino alla direzione Homun: Gateway come
control plane per sessioni, tool, eventi e canali; plugin/skill/model providers;
Control UI; onboarding; scenari QA estesi per canali, media, approval,
subagent, modelli e recovery. La lezione e' che l'affidabilita' nasce da una
matrice di scenari reali, non da soli unit test.

Manus e' il riferimento di prodotto: delega autonoma di processi completi con
browser/tool/artifact e output consegnabile. Per Homun la differenza deve essere
local-first, privacy, addon governati e approval verificabile.

## Stato Osservato

La `v0.1.1096` installata parte, e' firmata/notarizzata, il gateway risponde,
modelli/skill/MCP/automation sono enumerabili e il profilo `all` dello smoke ha
passato quasi tutto. Il coding smoke reale ha modificato un piccolo workspace,
ha chiesto escalation shell, ha ripreso dopo approvazione e ha chiuso con test
verdi.

Il punto debole non e' "manca tutto"; e' che alcuni owner canonici non impediscono
ancora stati impossibili:

- `S8` payment approval ha completato con testo simulato mentre mancava una
  Payment Approval Card strutturata e c'era `browser_budget_exceeded`;
- esistono residui storici nel DB reale: run vecchi `running`, messaggi
  `streaming`, task `waiting_user_approval`, effetti incerti;
- `/api/integrity/audit` ora espone una prima sezione `runtime` read-only per
  lifecycle debt, ma non ha ancora repair preview/apply per riconciliare lo
  storico reale;
- approval inline come `SANDBOX_ESCALATE` non e' proiettata nella stessa coda
  canonica delle approval;
- il selettore modello non deve confondere `Unavailable` con `Auto`: il bottone
  ora mostra la risoluzione `Auto -> role -> provider/model` quando il runtime
  context e' disponibile, ma resta da completare la spiegazione del routing nei
  dettagli Settings/dashboard;
- le automation hanno un primo dry-run HTTP non mutante: valida schedule/event e
  `next_run` senza creare rule o task, e risponde solo con metadata non
  sensibili;
- i subagent hanno gia' queue/lease/retry/checkpoint, ma per task lunghi serve
  ancora delega broker-owned, proiezione parent/child e result delivery
  idempotente;
- il click Browser nella island ora e' cablato come richiesta PiP/dock: mantiene
  chiusa la side island e chiude l'inspector invece di aprire la colonna
  `computer`.

## Classi Di Stabilita'

Ogni fix deve chiudere una classe, non un singolo sintomo:

| Classe | Invariante |
| --- | --- |
| Lifecycle | un run non puo' risultare completato se esistono errori terminali di tool o budget non riconciliati |
| Approval | nessuna azione sensibile e' valida se esiste solo testo modello e non un oggetto approval canonico |
| Recovery | dopo crash, resume o approval, lo stato canonico deve convergere a completed/failed/blocked senza righe appese |
| Model routing | `Auto` deve mostrare role, provider, modello risolto e motivo; `Unavailable` solo se nessun modello usabile esiste |
| Browser/computer | budget/stall/iframe/non-interactive devono produrre stato blocked/retryable, non successo testuale |
| Automation | trigger, run, retry, dedupe, history e dry-run devono essere separati dalla chat interattiva |
| Addon/MCP | ogni tool esterno ha permessi, schema, provenance, budget, disabilitazione e test di compatibilita' |
| Memory/privacy | dati sensibili non arrivano al modello sbagliato; memoria/Vault mostrano provenance e redaction |
| UX projection | la UI consuma il read model canonico e non deduce stato da marker o copy locale |

## Slice Prioritarie

1. Lifecycle integrity gate.
   Prima slice completata: `scripts/audit_homun_state.py` e
   `/api/integrity/audit.runtime` rilevano run `running` senza task attivo,
   messaggi assistant `streaming` appesi, task approval senza oggetto canonico
   e browser budget terminali su task completati. Restano da aggiungere repair
   preview/apply, effetti incerti e integrazione nel gate kernel dopo
   classificazione del rumore reale.

2. Approval contract hardening.
   Rendere impossibile chiudere `S8` con testo simulato: Payment Approval Card,
   shell escalation, connector write e browser/payment devono essere oggetti
   canonici. Se manca l'oggetto, il terminale e' `blocked` o `failed`, non
   `completed`.

3. Unified Run Center.
   La UI deve avere un centro unico per run, approval, retry, logs, effetti,
   automazioni e browser state. Le island restano shortcut, ma il click Browser
   e' stato riportato a shortcut PiP diretto, senza apertura della colonna
   inspector.

4. Model routing clarity.
   Prima slice UI completata: il composer non mostra `Unavailable` come scelta
   quando il prossimo turno e' `Auto`, e la label puo' esporre la rotta risolta
   dal runtime context. Restano da mostrare il motivo della scelta, fallback,
   local/cloud e cosa manca per `image_generation` o altri ruoli non risolti.

5. Scenario Lab business-first.
   Aggiungere scenari live realistici: lead CRM da email a spreadsheet,
   preventivo/fattura con approval, ricerca web con report e fonti, riunione
   calendario con follow-up, support ticket multi-step, browser checkout senza
   pagamento, automazione ricorrente con dry-run e coding maintenance con test.
   Addon/MCP restano fuori da questa slice: vanno studiati in una sessione
   dedicata con modello di permessi, installazione, compatibilita' e governance.

6. Long-task delegation.
   Portare `subagent.*` vicino a Codex: la delega deve essere broker-owned e
   fail-visible, la proiezione kernel deve esporre child id/checkpoint/result
   redatti, e la consegna al parent thread deve passare da outbox idempotente.
   Il budget limita una run, non l'objective.

## Task Lunghi

Il budget delle azioni non deve essere il limite dell'obiettivo. Deve limitare
solo un singolo turno o una singola esecuzione, per evitare loop ciechi,
consumo incontrollato o azioni ripetute senza progresso.

Per avvicinarsi alla robustezza di Codex/Manus serve un livello superiore:

- `Objective`: obiettivo durevole, anche multi-giorno o multi-settimana;
- `Run`: una sessione esecutiva breve, con budget, modello, toolset e log;
- `Checkpoint`: stato verificabile dopo ogni run, con prossimo passo esplicito;
- `Wake`: ripresa pianificata o richiesta da evento/automation/user approval;
- `Receipt`: prova di effetti, file, browser, connector, memoria o errore;
- `Supervisor`: decide se continuare, parcheggiare, chiedere approval o fallire.

OpenCode usa `steps` come limite di agent: all'ultimo step disabilita i tool e
obbliga una risposta testuale di riepilogo. Ha pero' input/sessioni durevoli e
un coordinator che serializza i drain per sessione e coalesca i wake. Questo e'
corretto per un coding turn, ma non basta per un processo aziendale lungo.

Homun deve tenere budget bassi per run e continuita' alta per objective:

```text
objective mensile
  -> run 1: scoperta e piano, budget 20 azioni
  -> checkpoint: cosa e' stato provato, cosa manca
  -> wake: domani / dopo approval / dopo evento CRM
  -> run 2: esegui prossimo step, budget 20 azioni
  -> checkpoint ...
```

Regola di prodotto: quando finisce il budget, Homun non deve "morire". Deve
salvare checkpoint, mostrare stato `parked`/`waiting`/`blocked`, e proporre o
programmare la prossima ripresa. Solo i loop senza progresso devono fermare
l'obiettivo.

## Readiness Bar

Non tagliare una nuova versione pubblica come "distribuibile" finche':

- `pre_release_gate.py`, `kernel_regression_gate.py`, `audit_homun_state.py` e
  scenario lab core sono verdi su profilo isolato;
- app installata reale passa almeno: chat, memoria, privacy/Vault, modelli,
  automation, MCP/addon, browser/PiP, approval e coding smoke;
- nessuno scenario puo' passare tramite testo simulato quando l'owner canonico
  richiede un evento/oggetto strutturato;
- la dashboard spiega sempre cosa e' in corso, cosa e' bloccato, quale modello
  sta lavorando e quale azione richiede consenso.

Il prossimo lavoro concreto dopo lifecycle/model/dry-run e' scegliere una slice
fra repair preview/apply, Browser PiP diretto o long-task delegation. Senza
questi owner, continueremo a scoprire bug dal vivo per caso invece di bloccare
le classi di regressione prima della chat reale.
