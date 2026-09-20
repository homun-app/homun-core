# Slice motore: contesto conversazionale autorizzato

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

19 settembre 2026. Implementazione circoscritta derivata dal [confronto agentico](2026-09-19-agent-systems-lessons.md); nessun nuovo framework, schema database, componente grafico o accesso provider reale.

## Comportamento

L'interpretazione e l'estrazione del piano ricevono la stessa selezione dei messaggi precedenti della conversazione: massimo 8 messaggi interi e 12.000 caratteri. L'ordine deriva dalla sequenza degli eventi persistiti; il messaggio corrente e gli eventi successivi al suo inserimento sono esclusi dallo storico. Il testo originale della richiesta corrente passa invariato al modello, senza duplicazione nello storico. Oltre 16.000 caratteri l'interpretazione restituisce un errore di validazione; il messaggio già ammesso resta persistito. Sono limiti di caratteri, non una stima o garanzia di token del provider.

I messaggi troppo grandi vengono omessi interamente; messaggi precedenti più piccoli possono ancora entrare. Un avviso condiviso chiarisce al modello che vede estratti e indica quanti messaggi autorizzati sono stati omessi per limite. Le fonti negate non compaiono neppure in questo conteggio. Nessun riepilogo viene generato e il transcript non viene modificato dal compositore.

`ConversationContext` contiene la vista effimera. `ContextManifest` contiene soltanto ID delle fonti selezionate, sequenze, hash dei testi, risorse autorizzate, limiti e conteggio delle omissioni. Viene persistito nel risultato del comando e nell'evento `message.interpreted`, sfruttando i payload JSON esistenti. La provenienza delle risorse è transitiva: una risposta derivata da un messaggio relativo a un progetto conserva quel riferimento per i controlli di lettura successivi. Non vengono persistiti testi aggiuntivi o ID di fonti negate.

## Confine di accesso e pubblicazione

Prima di leggere lo storico, la conversazione e ogni lavoro collegato devono essere leggibili dall'attore. Più lavori collegati producono un errore esplicito di ambiguità, senza sceglierne uno arbitrariamente. Ogni evento candidato passa dalla policy di lettura condivisa prima che il suo testo venga selezionato.

La consegna ricarica lo stato dopo l'ammissione e prima dell'interpretazione. Prima dell'eventuale estrazione del piano vengono ricontrollati tutti i riferimenti selezionati sullo stato corrente. Il commit della risposta ricontrolla autorizzazione, identità e hash delle fonti. Il replay di un comando completato applica lo stesso controllo; i risultati legacy privi di manifest controllano almeno il lavoro attualmente collegato. Nessun lock o transazione resta aperto durante la generazione del modello.

Una revoca durante una chiamata già iniziata non può ritirare il contesto già inviato: impedisce la pubblicazione del risultato e la successiva estrazione del piano. La slice non introduce cancellazione del provider o un gate per ciascun retry interno della libreria. Per storico legacy senza riferimenti di provenienza non si inventano fonti mancanti: valgono le policy note della conversazione, del lavoro collegato e degli eventi.

## Adattatori e verifiche

Il contratto `MessageInterpretation`, gli intent e `ModelPort` restano invariati. Il parametro di contesto è opzionale per i chiamanti esistenti. I percorsi JSON mantengono i messaggi precedenti con ruoli nativi; l'adattatore di output strutturato converte i soli ruoli utente/assistente in messaggi Pydantic AI. Il parametro del costruttore `Agent` è stato corretto da `output_retries` a `retries`, compatibile con la versione installata; il relativo test esercita un vero `FunctionModel` senza rete.

Il provider fake continua a classificare deterministicamente il solo input corrente: riceve il manifest tramite l'orchestrazione, ma non simula comprensione linguistica della conversazione. Una prova fake dimostra continuità e contratti, non qualità del modello. L'adattatore generico `complete_chat` non è stato ampliato: questa slice collega lo storico al percorso di interpretazione/estrazione esistente.

Test dedicati: `engine/tests/test_conversation_context.py` e `engine/tests/test_context_model_adapters.py`. Coprono fonti negate, revoca dopo ammissione/durante modello/prima del piano, replay attuale e legacy, ambiguità, limiti, input originale, ordine persistito, separazione dello storico, identità delle fonti, provenienza transitiva e ruoli nativi/fallback dei provider. L'integrazione applicazione confezionata e i test dell'intero motore sono verifiche separate dal test deterministico degli adattatori.
