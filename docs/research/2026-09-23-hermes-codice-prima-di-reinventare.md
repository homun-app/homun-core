# Hermes come base tecnica per Homun

> Aggiornamento di indirizzo del 23 settembre: Fabio ha chiarito che vuole un motore Homun proprio, derivato dalla logica di un riferimento consolidato. Le ipotesi sotto di incorporare un runtime/SDK esterno sono superate; il confronto resta utile per scegliere e riprodurre il comportamento di riferimento. Vedi la [prova pratica](2026-09-23-prova-hermes-openhands.md).

23 settembre 2026. Decisione di metodo ribadita da Fabio: prima esaminare e
riutilizzare sistemi consolidati, poi progettare ciò che distingue Homun.
Il confronto di prodotto precedente non sostituisce questa analisi del codice.

## Riferimenti verificati

Snapshot upstream: `c9dca726514b709cf6e677d236a79fc8d0627f37`, acquisito dal
repository ufficiale NousResearch/hermes-agent. Ispezione statica del sorgente,
non installazione, benchmark o prova di superiorità del modello.

- [prompt_builder.py](https://github.com/NousResearch/hermes-agent/blob/c9dca726514b709cf6e677d236a79fc8d0627f37/agent/prompt_builder.py): identità predefinita, regole operative, istruzioni condizionali per modelli/strumenti, guida alle skill.
- [system_prompt.py](https://github.com/NousResearch/hermes-agent/blob/c9dca726514b709cf6e677d236a79fc8d0627f37/agent/system_prompt.py): composizione in livelli stable/context/volatile e riuso durante la sessione.
- [conversation_loop.py](https://github.com/NousResearch/hermes-agent/blob/c9dca726514b709cf6e677d236a79fc8d0627f37/agent/conversation_loop.py): orchestrazione della conversazione, scelta fra round strumenti e risposta testuale.
- [turn_tool_round.py](https://github.com/NousResearch/hermes-agent/blob/c9dca726514b709cf6e677d236a79fc8d0627f37/agent/turn_tool_round.py): validazione/deduplicazione delle chiamate, persistenza prima dell'esecuzione, risultati strumenti e recupero.
- [turn_request_assembly.py](https://github.com/NousResearch/hermes-agent/blob/c9dca726514b709cf6e677d236a79fc8d0627f37/agent/turn_request_assembly.py): messaggi e strumenti preparati per il provider.
- [LICENSE](https://github.com/NousResearch/hermes-agent/blob/c9dca726514b709cf6e677d236a79fc8d0627f37/LICENSE): MIT nel repository; prima di incorporare file verificare anche provenienza/licenze dei componenti e preservare le attribuzioni richieste.

## Prima differenza concreta

Hermes non si riduce a un singolo prompt. Compone istruzioni in funzione del
contesto e delle capacità, conserva una conversazione con chiamate e risultati
strumenti e gestisce il round operativo con moduli dedicati. Le regole operative
includono ricerca delle informazioni disponibili prima di chiedere chiarimenti,
conservazione degli identificativi e verifica della consegna. Alcuni blocchi
sono condizionali al modello: copiarli integralmente non equivale a riprodurre
il comportamento di Hermes.

Homun in `models/agent_turn.py` ricostruisce per ogni decisione due messaggi,
con obiettivo, catalogo e osservazioni serializzati nel messaggio utente, poi
interpreta il JSON `tool|ask|finish`. È una soluzione portabile ma diversa dal
protocollo di conversazione/tool calling di Hermes. Non abbiamo ancora misurato
quanto questa differenza spieghi gli errori osservati con Qwen 4B.

## Decisioni da prendere prima della prossima implementazione

| Area | Valutazione necessaria | Direzione iniziale |
| --- | --- | --- |
| Esecuzione | Riusare Hermes come componente oppure adattare i suoi moduli? | Confrontare dipendenze, API, aggiornabilità e confine con DBOS; non introdurre due proprietari dello stato |
| Prompt e contesto | Quali blocchi vengono realmente inviati con il modello scelto? | Ricostruire il prompt effettivo e adottare la composizione esistente dove applicabile |
| Strumenti e messaggi | Chiamate native, risultati correlati, errori correggibili | Preferire protocolli consolidati a un nuovo schema proprietario senza vantaggio misurato |
| Recupero | Risposta vuota, argomento errato, overflow, interruzione | Studiare implementazione e test upstream prima di aggiungere altre regole ad hoc |
| Squadra aziendale | Contesto organizzativo, persone, responsabilità, consegne | Concentrare qui lo sviluppo specifico di Homun |

La prossima prova deve usare gli stessi compiti, modello, informazioni e strumenti
nei due sistemi. Misurare risultato corretto, richieste ripetute, chiamate, costo,
tempo e recupero. Separare l'effetto del prompt da quello del protocollo e dal
modello: una prova Homun con Qwen 4B non dimostra equivalenza con altre configurazioni.

Questa analisi cambia l'ordine delle priorità: audit e scelta di riuso prima di
ulteriori correzioni isolate dei prompt o ampliamenti del ciclo proprietario.
Non modifica il runtime né decide già una sostituzione con Hermes.
