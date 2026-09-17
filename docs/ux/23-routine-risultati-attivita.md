# Dalla creazione al risultato

## Percorso implementato nella demo
Le simulazioni email e piano registrano una routine condivisa al momento della conferma. La routine resta disponibile nella lista Automazioni uscendo dallo scenario. Il centro Attività nella testata è accessibile da chat e dashboard. Il pannello risultato si apre sopra la vista corrente, senza cambiare conversazione.

Apri automazione mostra configurazione confermata, fonte, supervisione, pausa/ripresa e cronologia. “Simula risultato in arrivo” genera un’esecuzione distinta con ID e timestamp e incrementa i non letti. La dashboard Oggi mostra gli stessi risultati; aprirli li marca letti ma non verificati. “Segna come verificato” aggiorna lo stato condiviso senza autorizzare azioni esterne.

## Confini
Nessuno scheduler: gli arrivi sono provocati esplicitamente dal pulsante demo. Niente notifiche di sistema o email. Stato in memoria fino al ricaricamento. Costo reale non disponibile. Una routine per ciascuno dei due scenari; una nuova conferma aggiorna quella routine. Le esecuzioni sono fixture, non risultati reali. Questo percorso copre le due simulazioni, non unifica ancora il vecchio editor di procedure, il Kanban e il registro degli incarichi. Non comprende filtri per progetto/agente o preferenze di notifica.

## Verifiche browser
Email: conferma → dettaglio → risultato simulato → Home chat con badge 1 → apertura → verifica → dashboard con stesso risultato verificato. Ulteriore prova: ritrovare la routine in Automazioni, pausa che disabilita la generazione, ripresa e seconda esecuzione distinta. TypeScript e build superati; lint senza errori, avviso Fast Refresh per l’export del context hook.

## Obiettivo motore
Routine ed esecuzioni devono avere identità distinte. Notifica, dashboard e cronologia devono puntare alla stessa esecuzione. Lettura, verifica e autorizzazione sono stati diversi. I risultati futuri dovranno mantenere snapshot delle fonti e della configurazione usata, costo e prove consultabili. Le preferenze di notifica e la destinazione del risultato dovranno essere configurabili senza interrompere conversazioni non pertinenti.

## Apertura del risultato: pagina dedicata
“Apri risultato” ora chiude il dialog e mostra una pagina nel contenuto principale, mantenendo la vista precedente montata. Ritorno esplicito e navigazione laterale consentono di uscire. Routine e centro Attività restano dialoghi; il risultato non lo è più.

La pagina contiene fonte dimostrativa, verifica separata, chat e seguito contestuale: bozza di risposta modificabile per le email, proposta di spostamento con conferma per Trello. Conversazione, bozza e stato della scheda simulata sono conservati per ID di esecuzione nello stato condiviso fino al reload. Nessuna creazione di task o invio reale. Le azioni linguistiche riconosciute sono esempi limitati, non interpretazione AI generale.

Verifica browser email: apertura senza dialog, richiesta bozza, modifica, ritorno, riapertura dal centro Attività con testo conservato. TypeScript e build superati.
