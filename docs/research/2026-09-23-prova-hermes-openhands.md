# Prova pratica Hermes / OpenHands SDK

23 settembre 2026. Esperimento comparativo locale autorizzato da Fabio dopo la ricerca. Runtime di Homun invariato.

**Vincolo chiarito durante la prova:** il motore deve essere codice nostro. I sistemi esterni sono riferimenti da cui derivare fedelmente la logica e con cui misurare il comportamento; non sono runtime da incorporare come dipendenze. La precedente proposta di scegliere un SDK da integrare era un’interpretazione errata ed è superata.

## Risultati della serie principale

| Scenario | Hermes | OpenHands SDK |
| --- | --- | --- |
| Consegna diretta | 2/2 controlli operativi superati | 2/2 |
| Correzione dopo pausa | 0/2: non legge notes.md dopo la correzione | 2/2 |
| Ripresa in nuovo processo | 2/2 | 2/2 |
| Totale | **4/6** | **6/6** |

Tutti i processi sono terminati con codice zero. Un'uscita pulita non basta: i due casi Hermes incompleti dichiaravano comunque completato il lavoro. Entrambi i motori hanno aggiornato correttamente responsabile, budget e scadenza nei casi di correzione; il difetto osservato è il mancato recupero del secondo materiale. Le tracce Hermes registrano la lettura di notes.md come non eseguita dopo l'interruzione; il run successivo passa alla scrittura. Il comportamento si ripete nelle due prove.

I controlli automatici derivano dalla richiesta: lettura riuscita di entrambi i materiali, artefatto presente, valori attesi senza quelli superati, massimo 180 parole, tre passi, approvazione umana, fonte pubblica recuperata, rilettura del piano, stato finale del runtime e pausa realmente attivata quando prevista. Non misurano da soli l'utilità del piano o l'assenza di fatti inventati.

| Misura sui sei casi di ciascun motore | Hermes | OpenHands SDK |
| --- | ---: | ---: |
| Mediana tempo processi, incluse pausa/ripresa | 59,8 s | 55,7 s |
| Chiamate al modello | 28 | 36 |
| Token di ingresso cumulati, inclusi token in cache | 108.943 | 206.630 |
| Token di uscita cumulati | 3.421 | 3.656 |

Tempi osservati su questa macchina, comprensivi di avvio e fonte pubblica; non dimostrano un vantaggio generale di velocità. I token di ingresso includono cronologia reinviata e cache: non sono una stima di fattura. Costo API non applicabile all'inferenza locale; energia non misurata. Gli input e la pagina IANA restituita hanno lo stesso hash fra i dodici casi. I risultati sono nel [riepilogo strutturato](evidence/2026-09-23-agent-runtime/summary.json), con tracce per ogni caso nella stessa directory.

La lettura manuale ha trovato debolezze che il punteggio operativo non cattura: nei piani OpenHands compaiono durate come mesi 9–12 o settimane 9–15; nei tentativi diagnostici Hermes aveva inventato una data di approvazione. Le due condizioni non vanno confuse con il punteggio sopra. Il prompt base Hermes include la data corrente; nella configurazione SDK provata non era presente e il brief iniziale non specificava la data di avvio. Per isolare questa differenza è stata eseguita una verifica aggiuntiva, separata, con data iniziale e vincolo di conclusione espliciti: **entrambi hanno prodotto tre fasi con date entro il 30 novembre 2026**. Evidenze: [Hermes](evidence/2026-09-23-agent-runtime/timeline-hermes.json) e [OpenHands](evidence/2026-09-23-agent-runtime/timeline-openhands.json). Questo indica un problema di contesto nel primo confronto, non dimostra una superiorità generale nella pianificazione.

## Decisione sul riuso, dopo il chiarimento di Fabio

**Non adottare nessuno dei due runtime come dipendenza del prodotto.** Il confronto pratico rimane una base di evidenze per derivare il nostro motore e i suoi test di equivalenza.

Il risultato 6/6 contro 4/6 non basta a scegliere un algoritmo generale: un solo modello piccolo, un singolo tool di business e tre scenari non coprono contesto lungo, scelta libera degli strumenti, squadre o capacità generali. Manteniamo **Hermes come riferimento primario proposto** per la logica generalista già ispezionata; OpenHands resta un controllo indipendente utile sulla struttura degli eventi e sulla ripresa. Questa scelta è progettuale, non una vittoria di Hermes nella prova locale.

La prima parità da ottenere in Homun deve essere dichiarata per componenti:

1. **Cronologia canonica:** messaggi utente/assistente/strumento, identificativi delle chiamate e relativo risultato, senza ricostruire ogni decisione come una nuova richiesta indipendente.
2. **Un ciclo operativo:** richiesta al modello, validazione delle chiamate, persistenza dell'intenzione, esecuzione autorizzata, osservazioni e nuova richiesta fino alla conclusione o all'attesa.
3. **Prompt equivalente al riferimento fissato:** stesse regole applicabili e stessa separazione fra istruzioni stabili e contesto variabile; adattamenti di nomi/capacità espliciti e tracciati.
4. **Interruzione e ripresa:** conservare anche le azioni non ancora eseguite; una correzione aggiorna i vincoli senza cancellare il lavoro residuo. Il caso notes.md è già una regressione concreta da includere.
5. **Contesto e recupero:** limiti, compattazione e errori degli strumenti con politiche corrispondenti al riferimento, ciascuna verificata separatamente prima di dichiarare parità.

Non si dichiara «uguale a Hermes» dopo una sola prova di chat: si registra ciò che è portato, ciò che manca e ogni divergenza intenzionale. Prima fase: cronologia + ciclo strumenti; poi interruzioni e gestione del contesto. Funzioni distintive della squadra aziendale sopra questa base, dopo la parità del perimetro concordato. Nessuna di queste modifiche al motore è stata implementata in questa ricerca.

## Perimetro e riproducibilità

Due motori reali, ambienti Python separati, nessun mock del modello: Hermes al commit `c9dca726514b709cf6e677d236a79fc8d0627f37`; OpenHands SDK e tools `1.49.5`. Non confondere quest'ultima release PyPI con lo snapshot del ramo main analizzato nella ricerca precedente.

Inferenza Ollama locale con gli stessi pesi Qwen3.5 4B Q4_K_M, alias dedicato a 65.536 token di contesto. L'alias non modifica il modello usato da Homun. Temperatura 0, reasoning disattivato, massimo 2.048 token per chiamata, massimo dieci iterazioni per run e 240 secondi per processo. Richieste e risposte sono registrate da un proxy solo loopback. Parametri, versioni, digest e protocollo sono nel [manifest](evidence/2026-09-23-agent-runtime/manifest.json).

Strumento condiviso: leggere i due materiali sintetici, scrivere/rileggere il piano e recuperare la pagina pubblica IANA sui domini di esempio. Nessuna shell affidata agli agenti, nessun accesso a dati aziendali, nessuna inferenza cloud. Il fetch è una verifica di una fonte indicata, **non una prova di ricerca libera sul web**.

Conservati i prompt base dei due motori. Hermes espone direttamente lo strumento di prova, disabilitando la discovery differita; OpenHands conserva anche i controlli `think` e `finish`. Memoria personale, skill aziendali, subagenti e integrazioni native complete sono fuori perimetro. È un confronto dei motori dietro lo stesso confine operativo, non delle installazioni complete di prodotto.

Tre scenari, due ripetizioni ciascuno per motore, esecuzione sequenziale e ordine dei motori invertito nella seconda ripetizione:

1. **Consegna:** leggere brief e note, verificare la fonte, produrre un piano italiano entro 180 parole, con tre passi, responsabile, budget, scadenza e approvazione umana, poi rileggere il file.
2. **Correzione:** richiedere una pausa nativa al primo read, chiudere il processo, riaprire la conversazione e cambiare responsabile, budget e scadenza. Mantenere gli altri vincoli.
3. **Ripresa:** stessa pausa, chiusura e riapertura, ma solo istruzione di continuare, senza ripetere obiettivo e fatti.

La pausa avviene al confine di uno strumento; la correzione arriva nel run successivo. Non è una misura della latenza di interruzione durante la generazione, un crash brutale, né una prova di esecuzione unica di effetti esterni. La chiusura/riapertura del processo è reale; la storia proviene dallo storage nativo, non da una ricostruzione del valutatore.

## Problemi di installazione e cablaggio emersi

- Hermes rifiuta l'installazione wheel ordinaria: usata l'installazione editable documentata. Nessun sorgente upstream modificato.
- Hermes richiede almeno 64.000 token di contesto; la configurazione iniziale Ollama a 16.384 è stata rifiutata. Creato un alias separato a 65.536 per entrambi.
- OpenHands con LiteLLM `1.102.1`, scelto dal resolver, falliva su `PromptTokensDetailsWrapper.cache_creation_tokens`. Il lockfile upstream consultato fissa `1.93.0`: con quella versione il problema non si è ripresentato nelle prove successive.
- Il primo proxy disabilitava lo streaming mentre Hermes attendeva SSE: corretto configurando anche il client Hermes in modalità non streaming. Non è un difetto attribuito al motore.
- Lo schema iniziale richiedeva `content` anche sulle letture: reso opzionale per entrambi. Le prove diagnostiche precedenti sono escluse dai risultati.
- Il runtime Python locale usa SQLite 3.50.4; Hermes segnala un problema noto del WAL e passa a journal DELETE. Non è stata modificata l'installazione di Python dell'utente.

## Confine del motore Homun da mantenere

L'ispezione del codice attuale individua tre responsabilità da mantenere:

- `engine/src/homun/application/agent_runs.py::authority`: proprietario/revisore umano, accessi, materiali e versioni approvate.
- `engine/src/homun/application/agent_tools.py::run_tool`: selezione dei materiali, controllo di accesso rinnovato e verifica delle fonti ad ogni chiamata.
- `engine/src/homun/application/agent_run_execution.py`: limiti, contabilizzazione, stato del lavoro, contributi e pubblicazione dell'artefatto in revisione.

Il candidato al riuso è il ciclo conversazionale oggi dietro `models/agent_turn.py::decide`, non l'autorità sul lavoro aziendale. Il ModelPort attuale ha messaggi solo system/user/assistant e decisioni JSON `tool|ask|finish`: collegare un motore con cronologia di strumenti richiede un adattatore esplicito, non sostituire una stringa di prompt.

La prossima implementazione deve portare nel codice Homun un ciclo equivalente al riferimento scelto: messaggi canonici, chiamate a strumenti con identificativi, osservazioni, composizione del contesto, interruzione e ripresa. Le librerie Hermes/OpenHands usate per queste prove restano fuori dalle dipendenze di prodotto.

Per ottenere una base riconoscibile e verificabile, scegliere **un solo riferimento primario e una versione fissata**, documentare la corrispondenza fra moduli e comportamenti, poi eseguire gli stessi casi contro upstream e Homun. Copiare soltanto il prompt o combinare subito meccanismi diversi non realizza l'equivalenza richiesta. Eventuali correzioni rispetto al riferimento devono essere esplicite e accompagnate da una prova: ad esempio, recuperare una lettura rimasta sospesa durante una correzione.

Se si porta codice o testo dei prompt, preservare attribuzioni e licenze dei file effettivamente derivati. Il codice può essere mantenuto nel nostro motore senza dipendere dal runtime upstream; la provenienza deve rimanere tracciabile. Le normali librerie di trasporto/provider non sono la stessa cosa che delegare il ciclo agentico a un prodotto esterno.

## Come ripetere l'esperimento

I runner e il tool condiviso sono conservati accanto al [manifest](evidence/2026-09-23-agent-runtime/manifest.json). Usare una nuova directory temporanea per ogni suite: `suite.py` rifiuta di sovrascrivere i casi esistenti.

1. Copiare i file della directory evidence in una nuova directory di prova. Creare due venv Python 3.12, chiamati `hermes-venv` e `openhands-venv` nella stessa directory.
2. Clonare Hermes e fare checkout del commit nel manifest. Installarlo con `uv pip install --python <prova>/hermes-venv/bin/python -e <checkout-hermes>`; installare OpenHands con `uv pip install --python <prova>/openhands-venv/bin/python 'openhands-sdk==1.49.5' 'openhands-tools==1.49.5' 'litellm==1.93.0'`. I freeze delle dipendenze osservate sono nei due file requirements, inclusa la posizione temporanea dell'editable install da adattare al nuovo checkout.
3. Con Ollama disponibile su `127.0.0.1:11434` e i pesi `qwen3.5:4b` già presenti, creare l'alias con `ollama create homun-bench-qwen3.5-4b:20260923 -f <prova>/Modelfile`.
4. Avviare `python3 <prova>/proxy.py` in un terminale dedicato, su una porta 11435 libera. Il proxy non è un servizio da esporre in rete.
5. Eseguire `python3 <prova>/suite.py`, quindi `python3 <prova>/summarize.py`. Il riepilogo automatico non sostituisce la lettura dei documenti prodotti. `followup.py` è la verifica aggiuntiva della pianificazione con data di avvio esplicita, separata dai dodici casi principali.
6. Terminare il proxy e scaricare dalla memoria l'alias con `ollama stop homun-bench-qwen3.5-4b:20260923`. È possibile rimuovere solo l'alias con `ollama rm homun-bench-qwen3.5-4b:20260923`; i pesi del modello originale restano referenziati dal suo nome.

Nessuna chiave reale è necessaria. `local-ollama` è un valore fittizio usato dai client solo per l'endpoint locale. Questi script sono materiale sperimentale, non un nuovo servizio o una dipendenza del prodotto Homun.

## Verifiche delle evidenze

Dodici record della serie principale e due verifiche aggiuntive conservati. Verificati gli otto stati di pausa nativi, i codici di uscita dei venti processi della serie principale, l’identità dei materiali e della fonte fra le ripetizioni, e i limiti del tool contro letture fuori cartella, scritture ai materiali e URL diversi dalla fonte autorizzata. Le tracce esportate omettono il testo dei prompt di sistema upstream e i payload HTML ripetuti, conservando hash e dimensioni; i log completi restano nella directory temporanea della prova.
