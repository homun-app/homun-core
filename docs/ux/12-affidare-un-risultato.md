# Affidare un risultato — prova UX
16 settembre 2026.

Da Home, “Affida un risultato” apre una richiesta libera e una proposta modificabile.
“Prova: preventivo con Marta e Giulia” prepara un esempio completo. Il testo libero
non viene interpretato da un modello: viene mantenuto come richiesta e si possono
scegliere responsabile, materiale, interlocutore e scadenza. L’interfaccia lo dichiara.

Affidare crea insieme compito e richiesta collegata con scadenza. Il dettaglio
compatto mostra situazione e prossima decisione; metodo e pannello completo sono
secondari. “Prova il seguito” simula la risposta con file: completa la richiesta,
collega il materiale e rende disponibile una bozza dimostrativa da approvare.
Non legge il contenuto del file, non calcola un preventivo e non invia nulla.
La simulazione di materiale mancante registra un’eccezione nel compito e nella Home.

Verificato nel browser: assegnazione esempio, risposta con file, revisione,
approvazione, eccezione persistente dopo chiusura/riapertura e layout a 390 px.
TypeScript, lint, build e 58 test esistenti passano.
La prova browser è l’evidenza specifica del nuovo percorso.

Obiettivo della prova: due decisioni del titolare, affidamento e approvazione,
salvo eccezioni. I controlli del simulatore rappresentano eventi esterni e non
vanno contati come azioni del titolare nella futura esecuzione reale.
Il percorso compatto riguarda i nuovi incarichi creati con questa modalità.
Gli altri incarichi mantengono la vista completa.

Da valutare con l’utente: comprensibilità della proposta e autonomia autorizzata,
qualità della transizione da conversazione libera a incarico e utilità del
riepilogo compatto. Nessuna affermazione di validazione con utenti esterni.
