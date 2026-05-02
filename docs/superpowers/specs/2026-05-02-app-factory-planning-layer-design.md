# App Factory Planning Layer Design

Data: 2026-05-02
Status: approvata per pianificazione

## Obiettivo

Inserire una fase obbligatoria di pianificazione prima della creazione o modifica di un'app App Factory.

Homun non deve passare direttamente dal prompt al blueprint. Deve prima comportarsi come un analista funzionale: identificare dominio, utenti, dati, campi dinamici, workflow, viste, permessi, automazioni e capability Homun necessarie. Quando una decisione business e' ambigua o impatta la struttura dell'app, deve fare una domanda mirata invece di assumere una soluzione fragile.

La promessa prodotto diventa:

> "Descrivo un'app interna. Homun la progetta, mi fa le domande importanti, poi compone l'app usando moduli e componenti gia' pronti."

## Problema Attuale

App Factory oggi puo' creare app funzionanti e ha strumenti atomici per alcune modifiche, ma il modello tende ancora a ragionare troppo vicino al blueprint:

- crea enum statiche dove servono tabelle gestibili;
- tratta campi di stato come input utente invece che come workflow;
- aggiunge viste senza capire se devono essere operative o solo liste;
- prova a riscrivere blueprint completi quando basterebbe una trasformazione locale;
- spreca iterazioni su errori di schema invece di cambiare strategia.

L'esempio delle sale riunioni mostra il problema: "Sala A, Sala B" non e' necessariamente una select statica. Se l'azienda deve aggiungere, rinominare, disattivare o autorizzare sale, "sala" e' una entita' di dominio con una vista di gestione e una relazione verso le prenotazioni.

## Principio Guida

Ogni campo deve essere classificato prima di essere modellato.

Per ogni campo candidato, il planner deve chiedersi:

- il valore cambia nel tempo?
- un utente business deve gestirlo da interfaccia?
- il valore e' condiviso da piu' record o entita'?
- serve disattivarlo senza perdere storico?
- servono permessi separati per leggerlo o modificarlo?
- serve cercarlo, filtrarlo, aggregarlo o collegarlo ad altri dati?
- e' un dato inserito dall'utente, un dato di sistema o uno stato di workflow?

Se la risposta indica gestione autonoma, il campo non deve diventare una enum statica: deve diventare una lookup entity o una relazione.

## Approcci Considerati

### Approccio A: piu' tool atomici

Continuare ad aggiungere tool come `add_app_view` o `extract_lookup_entity`.

Vantaggi:

- riduce gli errori di blueprint;
- migliora rapidamente i casi noti;
- e' utile per modifiche incrementali.

Limiti:

- non risolve la scelta iniziale sbagliata;
- richiede di scoprire ogni errore tramite tentativi;
- il modello puo' usare il tool giusto troppo tardi.

### Approccio B: planner conversazionale prima del blueprint

Introdurre una fase esplicita in cui il modello produce un piano applicativo, evidenzia assunzioni e fa domande mirate sulle ambiguita' importanti.

Vantaggi:

- migliora la qualita' dell'app prima della creazione;
- riduce app "solo form";
- rende la demo piu' forte perche' Homun sembra ragionare sul business;
- guida il modello verso tool atomici corretti.

Limiti:

- puo' rallentare i prompt semplici;
- richiede regole chiare su quando chiedere e quando assumere.

### Approccio C: generazione automatica sempre piu' aggressiva

Il modello inferisce tutto senza fare domande, creando entita', viste e workflow completi.

Vantaggi:

- effetto demo rapido;
- meno interruzioni.

Limiti:

- alta probabilita' di app sbagliate;
- difficile correggere a valle;
- rischia di creare strutture inutili o troppo complesse.

## Scelta Raccomandata

Adottare l'approccio B, con supporto dell'approccio A.

Il planner diventa obbligatorio per app nuove e modifiche strutturali. I tool atomici restano il meccanismo operativo usato dopo la decisione. Per richieste semplici e a basso rischio, il planner puo' fare assunzioni conservative e procedere senza domande, ma deve comunque classificare internamente campi e moduli.

## Pipeline Proposta

### 1. Intent Classification

Classificare la richiesta:

- nuova app;
- modifica semplice;
- modifica strutturale;
- aggiunta dati o record;
- configurazione capability;
- richiesta non supportata.

Esempi:

- "crea app ticket interni" => nuova app;
- "aggiungi campo motivo dettagliato" => modifica semplice;
- "gestisci i nomi delle sale e collega la select" => modifica strutturale;
- "aggiungi vista calendario" => modifica semplice se l'entita' ha date, strutturale se manca il concetto di evento.

### 2. Domain Analysis

Estrarre:

- attori e ruoli;
- entita' principali;
- azioni utente;
- regole di ownership;
- stati e transizioni;
- viste operative;
- dati esterni o capability Homun richieste.

Output interno:

```json
{
  "domain": "prenotazione_sale",
  "actors": ["admin", "employee"],
  "entities": ["booking", "room"],
  "workflows": [],
  "views": ["calendar", "room_management"],
  "capabilities": []
}
```

### 3. Field Classification

Ogni campo viene classificato in una categoria:

- `user_input`: compilato dall'utente;
- `system`: generato o protetto dal server;
- `workflow_state`: stato modificabile solo da transizioni;
- `lookup_static`: enum stabile e raramente modificabile;
- `lookup_dynamic`: entita' gestibile da UI;
- `relation`: riferimento a un'altra entita';
- `computed`: calcolato dal runtime;
- `bridge_backed`: proveniente da contatti, knowledge, canali o altri sistemi Homun autorizzati.

Regole:

- `workflow_state` non deve apparire nei form standard;
- `lookup_dynamic` deve produrre entita', vista di gestione e relazione;
- `bridge_backed` richiede capability esplicita;
- `computed` non e' editabile;
- ogni relation deve puntare a una entita' esistente o da creare nella stessa operazione.

### 4. Ambiguity Detection

Il planner deve fermarsi e fare una domanda quando l'ambiguita' cambia la struttura dell'app.

Domande da fare:

- "Le sale devono essere una lista gestibile o una lista fissa?"
- "Chi puo' modificare le sale?"
- "Le prenotazioni richiedono approvazione o sono confermate subito?"
- "Gli utenti dell'app sono separati da Homun o derivati da contatti/profili?"
- "Il calendario deve permettere drag and drop o solo consultazione?"
- "I ticket devono essere assegnati a persone specifiche o solo a gruppi?"

Domande da evitare:

- dettagli cosmetici non bloccanti;
- nomi tecnici di blueprint;
- scelte che possono avere default sicuri.

### 5. Planning Output

Prima del blueprint, il planner produce una sintesi breve:

```text
Creo un'app Prenotazione Sale con:
- Booking: titolo, sala, data inizio, data fine, note.
- Sala: nome, capienza, attiva.
- Sala sara' gestibile da admin e selezionabile nelle prenotazioni.
- Vista calendario operativa con spostamento prenotazioni.
- Employee crea e vede le proprie prenotazioni; admin vede tutto.
Assunzione: niente workflow di approvazione.
```

Se non ci sono ambiguita' bloccanti, il modello procede. Se ci sono, chiede massimo una domanda alla volta.

### 6. Blueprint Generation

Il blueprint viene generato solo dopo il planning output.

Il planner deve preferire moduli Blueprint v1:

- `identity` per utenti, ruoli e ownership;
- `data` per entita', campi, relazioni e lookup;
- `workflow` per stati e transizioni;
- `navigation` per menu e viste;
- `dashboard` per KPI;
- `calendar` per eventi operativi;
- `homun_access` per bridge verso profili, contatti, knowledge, canali, skill e tool.

### 7. Tool Selection

Per app nuove:

- usare `create_internal_app` con blueprint completo.

Per app esistenti:

- campo semplice: `add_app_field`;
- vista semplice: `add_app_view`;
- enum/select da rendere gestibile: `extract_lookup_entity`;
- capability: `configure_app_capabilities`;
- modifica ampia: prima planning output, poi `update_internal_app` solo se gli strumenti atomici non bastano.

`update_internal_app` e' l'ultima scelta, non la prima.

## Criteri Per Chiedere Domande

Il planner deve chiedere quando almeno una di queste condizioni e' vera:

- la scelta cambia il modello dati;
- la scelta cambia chi puo' vedere o modificare i dati;
- la scelta abilita accesso a dati Homun;
- la scelta introduce notifiche o canali esterni;
- la scelta cambia il workflow;
- la scelta impatta la demo o l'uso quotidiano dell'app.

Il planner puo' assumere quando:

- il default e' reversibile con un tool atomico;
- la scelta e' puramente visuale;
- la richiesta e' esplicita;
- il dominio ha una convenzione ovvia e a basso rischio.

## Esempio: Sale Riunioni

Prompt:

```text
Crea un'app per prenotare sale riunioni.
```

Planning consigliato:

- `booking` e' entita' principale;
- `room` deve essere proposta come lookup dinamica, non enum statica, perche' le sale aziendali cambiano e devono essere gestite;
- `calendar` e' una vista operativa naturale;
- `employee` crea prenotazioni proprie;
- `admin` gestisce sale e vede tutte le prenotazioni.

Domanda se il prompt e' minimale:

```text
Vuoi che le sale siano gestibili da una vista dedicata, cosi' puoi aggiungerle e rinominarle, oppure basta una lista fissa iniziale?
```

Se l'utente dice "gestibile", blueprint:

- entita' `room`;
- entita' `booking`;
- campo `booking.room_id` relation a `room`;
- vista `Sale`;
- vista `Calendario`;
- permessi admin su `room`;
- permessi employee read su `room` e create/read:own su `booking`.

## Esempio: Ticket Interni

Prompt:

```text
Crea un'app per ticket interni.
```

Planning consigliato:

- `ticket` e' entita' principale;
- `status` e' `workflow_state`;
- `priority` puo' essere enum statica;
- `category` puo' essere lookup dinamica se l'azienda gestisce categorie;
- `assignee` e' relation verso utenti app o support group;
- `kanban` e' vista naturale;
- employee crea e vede i propri ticket;
- support vede ticket assegnati o aperti;
- admin vede tutto.

Domanda se necessaria:

```text
Le categorie ticket devono essere gestibili da admin o uso una lista standard iniziale?
```

## Esempio: Ferie E Permessi

Prompt:

```text
Crea un'app per ferie e permessi.
```

Planning consigliato:

- `leave_request` e' entita' principale;
- `status` e' `workflow_state`, non input;
- `type` puo' essere enum statica iniziale;
- `employee` crea e vede le proprie richieste;
- `approver` approva o rifiuta;
- `calendar` e dashboard sono viste naturali;
- eventuali festivita' o policy aziendali sono knowledge/capability, non campi manuali.

Domanda se necessaria:

```text
Le richieste devono essere approvate da un responsabile o basta registrarle come confermate?
```

## Iteration Budget

Il limite iterazioni non va semplicemente alzato in modo indiscriminato.

Il comportamento corretto e':

- se gli strumenti stanno producendo progresso reale, estendere il budget;
- se ci sono errori di schema ripetuti, cambiare strategia;
- se il modello prova piu' volte `update_internal_app` con errori simili, forzare una fase di replanning;
- se esiste un tool atomico coerente, usarlo prima di continuare;
- se manca un tool, rispondere con una limitazione chiara invece di consumare tentativi.

Per App Factory, gli errori ripetuti di validazione blueprint devono essere considerati un segnale di pianificazione sbagliata, non solo un problema di JSON.

## UX Conversazionale

La chat deve restare fluida:

- una domanda alla volta;
- massimo 2-3 opzioni concrete;
- niente termini tecnici come `lookup_entity` se non richiesti;
- spiegare le assunzioni in linguaggio business;
- dopo la conferma, procedere senza riepiloghi lunghi.

Esempio buono:

```text
Per le sale posso fare due cose: lista fissa veloce oppure gestione completa con vista Sale. Per un'azienda sceglierei gestione completa. Procedo cosi'?
```

Esempio da evitare:

```text
Vuoi una enum field o una relation field verso una lookup entity con view table?
```

## Impatto Sul Codice

La pianificazione puo' essere introdotta senza cambiare subito il runtime delle app.

Componenti previsti:

- `app_factory::planning`: strutture per piano, classificazione campi e decisioni;
- `PlanningReport`: output serializzabile usato dal tool/skill;
- `Ambiguity`: elenco di domande bloccanti;
- aggiornamento `skills/app-factory/SKILL.md` per rendere il planning obbligatorio;
- test su prompt tipici per verificare classificazioni e tool suggeriti;
- integrazione successiva con agent loop per rilevare ripetizione di errori blueprint.

## Criteri Di Successo

La feature e' considerata pronta quando:

- una richiesta "prenotazione sale riunioni" propone o crea `room` come entita' gestibile;
- una richiesta "aggiungi vista calendario" usa `add_app_view` quando possibile;
- una richiesta "gestisci nomi sale e collega la select" usa `extract_lookup_entity`;
- un campo `status` in app con approvazione viene classificato come workflow state;
- il modello fa una domanda quando una scelta cambia dati, ruoli, workflow o capability;
- il modello non produce file YAML/HTML come risultato finale di creazione app;
- i test coprono almeno sale riunioni, ticket interni e ferie/permessi.

## Fuori Scope

- generazione di codice custom;
- marketplace moduli;
- designer visuale drag and drop;
- AI che modifica direttamente HTML/CSS delle app generate;
- SSO enterprise;
- migrazione automatica di tutte le app gia' create.

## Decisione

Implementare App Factory Planning Layer come fase obbligatoria e leggera:

1. classificare richiesta;
2. analizzare dominio;
3. classificare campi;
4. chiedere solo le domande strutturali;
5. generare blueprint o scegliere tool atomico;
6. usare il runtime esistente.

Questo mantiene la velocita' demo, ma alza molto la qualita' percepita: Homun non sembra piu' un generatore di form, ma un sistema che capisce come costruire un'app aziendale coerente.
