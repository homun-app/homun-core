# Consolidamento dei percorsi — 16 settembre 2026

## Implementazione

Home usa StudioWorkForm, come chat, calendario e progetti. Eliminato il salvataggio speciale del preventivo e la revisione separata del percorso rapido. Gli incarichi nuovi passano da prepareDelegation: gli agenti partono in stage salvo una responsabilità esplicita; il revisore configurato viene usato in assenza di una scelta nell'incarico. Le persone non ricevono policy da agente.

Il modulo comune permette contributi da altre persone/agenti: crea una richiesta collegata, conserva la scadenza, mette in attesa il lavoro principale. Il contributo non comporta automaticamente condivisione del progetto o dei suoi file.

Procedure: scelta della responsabilità, collegamenti alla raccolta, criteri e limite per passaggio. Ripetere un compito conserva input, riferimenti, policy, metodo e limite come un unico incarico, evitando di moltiplicare il budget per ogni voce della checklist. Le attese puntuali non vengono copiate: un avviso invita a modellare i contributi ricorrenti come passaggi della procedura. La nuova esecuzione azzera l'avanzamento del metodo.

Il riepilogo mostra limite remoto e disponibilità del consumo, distinguendo valori simulati e consumo reale non disponibile. Ricevere un input non vale come metodo di lavoro durante lo stage.

## Verifica

Browser, partendo da `?empty=1`:
- Creato Ada descrivendo responsabilità e nome, senza progetti o bot preimpostati.
- Affidato dalla Home un compito con metodo e limite 0,50 €.
- Consegnato un file, richiesta una correzione, nuova revisione e approvazione.
- Convertito il compito in procedura a intervalli; budget e metodo conservati; prova manuale creata; secondo avvio rifiutato finché la prima prova resta aperta.
- Creato un compito che aspetta Fabio; aperta la richiesta generata, consegnato un file, accettata la consegna nel compito principale.

71 test passati: nuova copertura per policy predefinita, contesto senza perdita, richieste collegate, pipeline con materiali/metodo/budget, budget negativo e stage dopo una consegna. TypeScript, lint mirato e build verificati. Screenshot in output/playwright/unified-*.png.

## Confine del prototipo

Questa è una base coerente per una prima esecuzione del motore, non una certificazione dell'intero prodotto. Non sono stati collaudati tutti i permessi multiutente o centinaia di progetti in questa verifica. Timer, invio di messaggi, lettura delle fonti e controllo della spesa reale non sono attivi. Procedure e dati restano nella sessione.

Il prossimo incremento deve essere una singola esecuzione reale (es. cartella di log → relazione → revisione → costo), mantenendo questi oggetti e stati. Il motore dovrà proporre un piano, verificare le fonti e chiedere solo le informazioni mancanti. La compilazione manuale della demo non è il modello finale dell'automazione.
