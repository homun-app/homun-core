# Esperienza obiettivo: delegare un riepilogo email

Questa prova è uno scenario UX scritto, senza interpretazione AI. Accesso: Automazioni → Prova la nuova esperienza · Email con Vera.

## Percorso
1. Richiesta: ogni mattina alle 8 Vera riassume le email.
2. Risposta concreta: sintesi privata in Homun, nessuna risposta ai mittenti.
3. Unica informazione mancante: scegliere una casella dimostrativa.
4. Orario e giorni modificabili direttamente nella proposta.
5. Prova: risultato leggibile, con fonte apribile.
6. Correzione guidata: mostrare soltanto urgenze.
7. Conferma: attivazione simulata, con possibilità di pausa.

## Contratto per il motore
- Conservare integralmente l’intento; chiedere soltanto dati mancanti.
- Rappresentare proposta, configurazione e risultato con gli stessi oggetti, senza ricompilazione manuale.
- Prima dell’attivazione mostrare risultato, destinazione, strumenti e accessi richiesti, supervisione e costo stimato quando disponibile.
- Una prova deve avere evidenze consultabili, non soltanto un messaggio di successo.
- Le correzioni dell’utente devono aggiornare la specifica di lavoro verificabile. Non equivalgono ad addestramento automatico del modello.
- Cambiare una configurazione invalida la prova precedente; prima di riattivare si verifica il nuovo risultato.
- In stage i risultati rimangono da verificare. Nessun invio è implicito.

## Confini del prototipo
Caselle, email, anteprima e attivazione sono fittizie e in memoria. Il testo libero non viene interpretato: il percorso email resta dichiaratamente predefinito. Le scelte guidate permettono di valutare la UX senza inventare una comprensione del linguaggio. Il percorso separato non crea procedure nel precedente editor.

## Verifiche
Percorso browser: blocco della prova senza casella; scelta Ufficio; anteprima; fonte; solo urgenze; conferma e pausa. TypeScript e lint superati. Restano da progettare nello stesso linguaggio UX: collegamento di una casella reale, credenziali scadute, email assenti, costo/budget e ripresa dopo errori.
