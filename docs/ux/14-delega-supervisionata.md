# Delega supervisionata: verifica del 16 settembre

## Percorso implementato

1. Collaboratore → Dettagli → Formazione: attività, ambito e livello. Nuove attività in stage; eliminare ambito o titolo ritira l'autonomia proposta.
2. Assegna: obiettivo, criterio di riuscita facoltativo e responsabilità del profilo. La policy viene copiata nell'incarico, senza cambi retroattivi quando il profilo viene modificato.
3. Materiali: caricamento di file/cartelle con percorsi; riferimenti esterni; collegamento a documenti, note e cartelle già in raccolta mediante ID e versione. Il selettore considera accesso di Fabio e del responsabile. La cartella collegata mostra contenuti attuali accessibili, senza duplicarli.
4. Revisione: testo/codice come testo inerte, immagini raster in pagina, PDF apribile, download per gli altri formati. Le anteprime vengono lette solo quando aperte. File grandi di testo limitati a 200 KB.
5. Correzione: motivazione richiesta e registrata nel compito. Approvazione senza promozione automatica. Lo stage richiede un metodo prima dell'avvio simulato; i passaggi incompleti impediscono la conclusione.

## Prove effettuate

- Browser: profilo Elio, nuova attività, scelta supervisione, assegnazione con criteri e cartella di log, apertura del contenuto e riferimento wiki.
- Browser: consegna di file, revisione motivata, ritorno in revisione, approvazione, verifica che il livello del profilo sia rimasto invariato.
- Browser: cartella importata nella raccolta, collegata a un nuovo incarico, apertura del file senza ricaricarlo; layout a 390 px senza overflow orizzontale.
- Browser: stage senza metodo blocca l'avvio; aggiunta di un passaggio rende disponibile l'avvio simulato.
- Suite: 64 test (inclusi stage senza metodo e revisione richiesta anche se una vecchia regola non richiedeva approvazione); TypeScript, lint sui file modificati e build.

## Cosa non dimostrano queste prove

Nessun agente ha eseguito il lavoro. Le connessioni esterne, l'apprendimento, l'applicazione dei permessi e il budget reale richiedono il motore. Un riferimento esterno non viene verificato automaticamente. I file caricati restano in memoria e non sono sincronizzati. Le anteprime non sono editor universali.

Il collegamento alla raccolta risolve il riutilizzo nell'incarico; allegati di chat e risultati hanno ancora File locali e non una identità/versione universale. I task creati dal percorso rapido dimostrativo e dalle procedure non ereditano ancora le responsabilità del profilo. Prima di congelare i contratti del motore vanno uniformati questi ingressi e validato il primo avvio senza dati demo. Non dichiarare chiusa tutta la UX sulla base di questo percorso.

## Contratti da mantenere nel motore

- Incarico: obiettivo, criteri, responsabile, partecipanti, scadenza, fonti, policy selezionata/versione e limite di costo.
- Materiale: identità stabile, versione, posizione, accesso effettivo, disponibilità; snapshot delle fonti usate per ogni esecuzione.
- Esecuzione: piano proposto, autorizzazioni per azione, stato dei passaggi, evidenze, consumo e motivo di arresto. Il motore propone il metodo per evitare compilazione manuale obbligatoria.
- Consegna: artefatti versionati, fonti e verifiche, revisore e feedback associati alla versione esatta. Le correzioni restano esempi candidati alla formazione, non promozioni automatiche.

## Aggiornamento successivo
Il percorso rapido, la normalizzazione degli incarichi e il trasporto di contesto nelle procedure sono stati consolidati; prova di primo avvio completata. Vedi `15-percorsi-unificati.md` per evidenze e limiti aggiornati.
