# Ingresso conversazionale e riepilogo del lavoro

Stato: approvato dall’utente; implementazione e verifica nativa in corso.

## Problema verificato

Il frontend usa text.slice(0, 100) come titolo e il messaggio intero come obiettivo. La demo rende disponibile il confronto CSV senza una fase di scelta del collaboratore. Il riepilogo destro ripete la richiesta e mostra permanentemente un textarea con scorrimento dentro un pannello che scorre. Barre tecniche occupano spazio prima della conversazione.

## Direzione raccomandata

La conversazione raccoglie una richiesta, che resta conservata integralmente come messaggio. Homun prepara una proposta di lavoro, senza assegnare né eseguire automaticamente. La proposta contiene un titolo breve, un obiettivo orientato al risultato, materiali necessari, vincoli espliciti e un collaboratore suggerito con motivazione basata sulle capacità realmente disponibili. Eventuali informazioni mancanti sono domande, non valori inventati.

Esempio:
- Titolo: Confronto listini agosto–settembre.
- Obiettivo: Individuare variazioni di prezzo e anomalie tra i due listini e consegnare un report verificabile.
- Vincoli: SKU esatto, nessuna conversione valutaria, anomalie separate.
- Output: report e CSV del confronto.
- Collaboratore: suggerito dal catalogo reale sulla base delle capacità; nessun nome fisso nel codice.

Se nessun collaboratore è adeguato, Homun propone un profilo da creare e distingue le capacità già disponibili da quelle mancanti. Creare un profilo non installa strumenti e non concede permessi. Si confermano profilo e affidamento; eventuali nuove autorizzazioni restano esplicite. Possibile mantenere Homun come coordinatore quando sufficiente, senza creare un agente per ogni richiesta.

## Percorso

1. Richiesta libera con eventuali materiali.
2. Proposta in chat: comprensione, risultato, collaboratore consigliato, motivazione e informazioni mancanti.
3. Conferma dell'affidamento oppure modifica della proposta. Eventuali dati o materiali mancanti rimangono visibili: l'affidamento non equivale ad autorizzare l'esecuzione e non deve bloccare il successivo caricamento dei file.
4. Preparazione dell'azione concreta sui materiali e approvazione secondo la policy vigente. Non duplicare una conferma se la proposta già approvata vincola esattamente azione, fonti, limiti e revisione; cambiamenti sostanziali richiedono nuova approvazione.
5. Esecuzione con aggiornamenti comprensibili.
6. Consegna nella conversazione e revisione umana.

Il confronto CSV usa il motore deterministico esistente, le stesse fonti immutabili e lo stesso workflow durevole. Nessuna seconda pipeline per la nuova UX.

## Titolo e obiettivo

Sintesi strutturata attraverso il provider configurato: titolo indicativamente 4–8 parole, obiettivo di una o due frasi, vincoli separati. Limiti validati lato dominio. Il titolo è un'etichetta; non autorizza azioni. L'obiettivo proposto diventa accordo operativo dopo conferma. La richiesta originale non viene sovrascritta. Una rinomina manuale non viene successivamente sostituita dal modello. Se il provider fallisce: etichetta provvisoria esplicita e errore recuperabile, senza obiettivo inventato o assegnazione silenziosa.

## Pannello destro

Riepilogo compatto: titolo, stato in italiano, risultato atteso, responsabile, prossimo passo, materiali e consegna. Niente textarea permanente. Modifica su richiesta tramite vista dedicata; testo normale e dettagli espandibili in lettura. Evitare scorrimenti annidati; la chat resta la superficie principale. Su finestre strette il riepilogo si apre come pannello a richiesta. Stato motore discreto, diagnostica e aggiornamento manuale nei dettagli tecnici; eventuale errore che blocca il lavoro rimane visibile.

## Confini dei moduli

- Interpretazione strutturata: richiesta → bozza, senza mutazioni operative.
- Raccomandazione: catalogo reale di agenti/capacità → suggerimento motivato.
- Servizio di conferma: revisione, autorità, assegnazione e persistenza.
- Presentazione: scheda proposta in chat e riepilogo compatto condividono gli stessi dati.

Riutilizzare contratti e comandi esistenti quando applicabili. Non aumentare i limiti dei moduli di orchestrazione e non riutilizzare dati della simulazione.

## Alternative considerate

Solo sintesi e CSS: migliora la leggibilità ma lascia irrisolto l'affidamento. Procedura guidata a schermate: esplicita ma frammenta la conversazione. Raccomandata la proposta conversazionale con riepilogo compatto, coerente con il prodotto.

## Accettazione

La demo deve partire da una richiesta naturale: titolo breve, obiettivo distinto, proposta del collaboratore motivata, nessuna assegnazione anticipata, caricamento contestuale dei materiali, approvazione coerente e risultato reale. Verificare catalogo senza agente adatto, provider indisponibile, modifica manuale del titolo, proposta obsoleta e riavvio. Verifica nella finestra nativa a dimensioni normali e ridotte: niente titolo troncato a metà frase nel riepilogo, textarea permanente o scorrimenti annidati. Il lavoro già completato non viene rieseguito o riassegnato durante la revisione della UX.
