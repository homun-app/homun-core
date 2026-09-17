# Homun Studio — direzione visiva

Richiesta: distaccarsi dalla grafica precedente, interfaccia moderna e semplice che
riveli strumenti e metodo al bisogno. Prototipo autonomo sulla preview esistente,
senza cambiare tema globale o backend. Palette carta chiara, inchiostro, accenti
menta/lilla/albicocca; squadra persistente, centro dedicato al lavoro e dettagli
progressivi. Caso illustrativo log/Trello/Mattermost/wiki.

Interazioni: selezione collaboratore, revisione lavoro con evidenze e piano,
configurazione metodo/costi/voce, aggiunta collaboratore locale, note in chat.
Verificare build, desktop/mobile, stati e azioni principali in browser.

## Esito verificato

Realizzato StudioWorkbench con stile isolato nella preview, mantenendo intatti
la route applicativa e il tema globale. Browser desktop 1440 e mobile 390:
revisione piano, evidenze espandibili, modifica metodo/tono, nota locale,
creazione di Ada con responsabilità libera e accesso da navigazione mobile.
Nessun overflow orizzontale nei viewport verificati. Screenshot in output/playwright.
TypeScript, lint e build app/preview completati. Il primo test del tono usava un
selettore label troppo stretto: ripetuto con il nome accessibile del textbox.

Limiti: dati e stati dimostrativi in memoria della pagina; nessuna connessione,
nessun generatore AI, nessuna esecuzione o costo reale. La route autenticata non
è stata cambiata né verificata dal browser in questa iterazione.

## Rifinitura dopo approvazione grafica

Fabio approva la direzione visiva e chiede di perfezionarla. Conservati palette,
struttura e identità. Aumentati dimensione e contrasto dei testi secondari, uniformati
controlli e spaziature dei lavori. Lo stato rivisto aggiorna anche la scheda principale;
la lista è denominata lavoro della squadra con numero esplicito dei lavori da rivedere.
Apertura sezioni dalla cima, blocco scroll con dialogo aperto, ritorno del focus alla
chiusura, aria-pressed sui filtri e safe-area della navigazione mobile.

Verificati tipi, lint, build preview, revisione completa con CTA aggiornata, chiusura
Escape del dialogo e overflow mobile 390/390. Screenshot desktop/mobile ispezionati.
