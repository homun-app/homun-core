# Miglioramento percorso incarico
Direzione approvata: pannello laterale, schede con passaggio attuale e blocco, home sintetica, assegnazione dalla conversazione e risultato leggibile.
1. Usare un dialog laterale nativo con focus contenuto, Escape e ritorno al controllo di apertura.
2. Migliorare schede con progresso, passaggio attuale e segnalazione deterministica di scadenza vicina/in ritardo.
3. Aggiungere materiali, note e risultato locale al singolo incarico. Non dichiarare risultati generati né invii esterni.
4. Riutilizzare il form dalla conversazione, anche precompilato da una nota scritta dall'utente.
5. Ridurre duplicazioni in home e mostrare prima scadenze urgenti e azioni necessarie.
6. Verificare TypeScript/build e browser: focus, chiusura, materiali, risultato, conversione nota e mobile.

## Verifica completata
- TypeScript, lint dei componenti modificati e build prototipo superati.
- Browser: pannello laterale, chiusura Escape, focus nel dialog e ripristino sulla scheda di apertura.
- Browser: allegato locale presente anche dopo riapertura, sblocco e checklist, risultato manuale visibile nella scheda completata.
- Browser: nota della chat convertita in form precompilato con Marta responsabile, salvataggio e apertura dettaglio.
- Mobile: dialog largo 390 px e contenuto largo 390 px, senza overflow orizzontale; screenshot ispezionato.
- Home: eliminato elenco duplicato degli incarichi, aggiunte scadenze di oggi e risultati degli incarichi; attività del bot apre l'incarico attivo.

Resta un prototipo: la nota non viene interpretata da AI; la scadenza va confermata nel form, i file non sono analizzati e i risultati sono inseriti manualmente. Nessuna esecuzione, notifica o collaborazione esterna. Dati conservati fino al ricaricamento.
