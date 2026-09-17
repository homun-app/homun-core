# Home conversazionale — prova UX

## Struttura

La Home apre Chat per i nuovi accessi. Chat/Dashboard è uno switch persistente; la dashboard mantiene Oggi, Kanban e Calendario. La preferenza Chat/Dashboard viene ricordata nel browser. La vista interna della dashboard si conserva nella sessione.

La conversazione è montata stabilmente: cambiare schermata conserva messaggi, proposte non confermate, testo da inviare, allegati e contesto. Dalle schede di progetto e incarico «Continua con Homun» porta il relativo contesto in chat. Il composer permette testo e file.

## Interazioni dimostrative

- Creare un collaboratore con nome e responsabilità: compare nella squadra canonica.
- Creare un progetto con obiettivo e membri: stesso archivio usato dalla sezione Progetti.
- Affidare un incarico con allegati, progetto, responsabile, scadenza e limite facoltativi: usa la normalizzazione comune, incluso stage predefinito.
- Chiedere stato dei lavori, attese, approvazioni e costi: risposte tratte dai dati locali, con compiti apribili. Le schede collegate riflettono lo stato attuale.
- Nessuna creazione prima della conferma della proposta. Gli allegati accompagnano anche l’azione suggerita subito dopo il messaggio.

## Evidenze

Browser: creazione di Luce e Cliente Rossi dalla chat e comparsa in sidebar; conservazione della bozza nel cambio vista; progetto → chat contestuale; file allegato → cambio Kanban → chat → incarico; incarico → chat contestuale; ritorno alla stessa vista Kanban. Verificata continuità degli allegati anche scegliendo l’azione suggerita dopo l’invio. Schermo da 390px controllato con sidebar chiusa, senza overflow orizzontale.

Screenshot: chat-home-start.png, chat-created-objects.png, chat-task-context.png, chat-mobile.png in output/playwright.

## Limiti espliciti

Nessun modello collegato. Il riconoscimento delle richieste è dimostrativo e limitato a poche intenzioni; le altre richieste ricevono opzioni senza fingere di essere eseguite. Non sono implementati tutti i comandi di modifica, automazione o gestione permessi via chat. La persistenza della conversazione vale per i cambi vista, non per il reload. Il motore dovrà sostituire l’interpretazione simulata e usare gli stessi comandi/autorizzazioni dell’interfaccia.
