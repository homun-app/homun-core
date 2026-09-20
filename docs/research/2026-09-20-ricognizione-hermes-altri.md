# Ricognizione aggiornata: Hermes e altri sistemi agentici

**Data:** 20 settembre 2026, dopo la conclusione del passo C (registro capacità + lettura materiale).
**Scopo:** verificare se l'upstream ha evoluto le lezioni che guidano Homun e affinare il passo D. Nessuna modifica al codice in questa tranche: è analisi con raccomandazioni.

## Hermes

**Snapshot aggiornato:** `6882320d5909` (HEAD del 20 settembre 2026; precedente `ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998`). **38.712 commit nuovi**, 1.339 file toccati: il repo si muove a velocità tale che la ricognizione per temi (non per commit) è l'unico metodo sostenibile. Aree più toccate: desktop/TUI, test, gateway; i temi che ci interessano restano centrali (log con "approval": 828, "budget": 755, "compaction": 649, "token": 2.756).

### 1. Approvazioni: modalità come configurazione di profilo, smart review fail-closed

- Tre modalità persistenti: `manual`, `smart`, `off` (`hermes_cli/approval_mode.py`). È **configurazione del profilo, non stato della conversazione**: cambiare modalità non ricostruisce l'agente né muta il prompt/schema dei tool — dichiarato esplicitamente per preservare il prefisso di prompt-cache.
- La modalità "smart" delega la revisione di comandi flaggati a un modello di decisione (plugin di catalogo `jev-approvals`): risponde solo APPROVE/DENY/ESCALATE, non può generare testo, **fallisce in chiuso verso ESCALATE** (verso l'umano) a ogni errore upstream, e documenta in modo esplicito cosa lascia la macchina e verso chi (disclosure).

**Per Homun:** il pattern fail-closed-verso-l'umano e la disclosure sono il riferimento giusto se un giorno introduceremo politiche di approvazione configurabili; anche la disciplina "la modalità non tocca il prompt" coincide con la nostra separazione policy/contratto. Confermato il divario di prodotto: Homun fa decidere l'umano, non un modello terzo — non adottiamo lo smart-approval esterno.

### 2. Budget: contatori per agente, delegati con cap inferiore, riconciliazione delta/cumulativa

- `agent/iteration_budget.py`: budget di iterazioni **per agente** thread-safe con consume/refund; il parent ha cap 500, **ogni subagente 50** — la delega ha limiti propri e la somma può eccedere il cap del parent (scelta esplicita).
- `hermes_state_usage.py`: contabilità token per sessione con **cinque contatori** (input, output, cache_read, cache_write, reasoning) più costo stimato, scritti da un writer in background con coalescing e **due percorsi di riconciliazione**: delta (per-chiamata) e cumulativo (gateway), con SQL pinneto da test.

**Per Homun (passo D):** è la conferma più utile. Il nostro `UsageAttempt` ledger esiste già; il design del budget per lavoro dovrebbe adottare: contatori separati (inclusi i token di cache, che oggi non tracciamo), **budget distinti per delegati con cap propri inferiori a quello del lavoro**, reserve/reconcile atomiche (già in roadmap), e gestione esplicita delle due fonti di verità (delta per chiamata vs cumulativo del provider) — "uso sconosciuto resta sconosciuto" resta la nostra regola.

### 3. Contesto: micro-compaction come opzione, con il costo dichiarato

- `website/docs/developer-guide/micro-compaction.md`: compressione incrementale (un scambio alla volta dopo ogni turno) **disattivata di default**, perché ogni passaggio **riscrive lo storico già inviato e rompe il prefisso di prompt-cache a ogni turno** — costo che per alcuni setup supera il beneficio. Presentata come opzione di tuning, non come comportamento di base.

**Per Homun (passo D, contesto):** la lezione si è raffinata. Hermes paga il prezzo che la nostra lezione 1 (selezione/sintesi non riscrivono la storia) evita: il nostro transcript event-sourced è più rigido ma non rompe nulla. Raccomandazione confermata e rafforzata: se compattiamo, la sintesi è un **artifact separato con provenienza** (versione, hash, intervallo di messaggi coperti) e il transcript canonico resta intatto; il contesto composto per la chiamata sceglie fra transcript e sintesi, mai li riscrive.

### 4. Memoria

Fix di consistenza sulle scritture batch (abort transazionale di `current_entries`): niente di architetturale, ma coerente con la nostra disciplina transazionale.

## Altri sistemi (check web, proporzionato)

- **Letta — Context Repositories (feb 2026):** memoria ricostruita come **repository git-based con versionamento programmatico**, "memory agents" e "memory skills". È la convergenza più significativa verso la nostra lezione 5 (memoria/procedure versionate con provenienza e revisione): valida la direzione e offre il modello di riferimento per il futuro store di procedure/skill di Homun — versioni e diff come artifact, non modifiche libere.
- **OpenHands — Planning Agent (mar 2026):** modalità Piano/Codice esplicite prima dell'esecuzione. Parallelo diretto al nostro intake (proposta → conferma → esecuzione): il pattern "pianifica prima, poi esegui" si sta affermando come prassi di prodotto.
- **Microsoft Agent Framework 1.0 GA (apr–giu 2026):** maturazione e stabilizzazione; nessuna nuova lezione per noi.

## Esito per Homun

**Nessuna lezione ritirata; due raffinate e una aggiunta:**

1. *Raffinata — budget (lezione 4):* contatori granulari inclusi i token di cache; cap propri per i delegati, inferiori al cap del lavoro; riconciliazione delta/cumulativa esplicita.
2. *Raffinata — approvazioni (lezione 3):* se introduciamo politiche configurabili: fail-closed verso l'umano, disclosure di ciò che esce dalla macchina, e la modalità vive nella configurazione del workspace senza toccare i contratti.
3. *Aggiunta — costo del cache-prefix:* ogni meccanismo che riscrive lo storico inviato (compaction, sync silenziosi) rompe il caching del provider: il costo va dichiarato e misurato, non subito per default.

**Conferme di rotta:** transcript canonico immutabile + contesto composto (più forte dell'approccio Hermes); memoria/procedure come versioni con diff (Letta); proposta-prima-di-esecuzione come prassi (OpenHands, e il nostro intake).

**Non adottato deliberatamente:** approval decisionale di terze parti, modello single-tenant di profilo, monolite desktop-first, loop autonomo universale.

**Per il passo D l'ordine raccomandato resta:** budget persistito per lavoro con riserve atomiche e contatori granulari → estensione del contesto autorizzato con sintesi-artifact (mai riscrittura) → delega operativa con cap propri.

Fonti consultate: clone locale aggiornato a `6882320d5909`; [Letta Context Repositories](https://www.letta.com/blog/context-repositories); [Letta memory blocks](https://www.letta.com/blog/memory-blocks); [OpenHands Software Agent SDK](https://github.com/All-Hands-AI/software-agent-sdk) e aggiornamento Planning Agent (mar 2026); [Microsoft Agent Framework 1.0 GA](https://devblogs.microsoft.com).
