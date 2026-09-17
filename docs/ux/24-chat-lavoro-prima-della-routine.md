# Un lavoro prima di una routine

Accesso: Automazioni → Prova la chat semplice con Elio. Sostituisce l’ingresso della precedente simulazione Piano con Elio, mantenuta nel codice come riferimento.

## Percorso obiettivo
Richiesta singola → una domanda sulla bacheca → risultato con fonti → richiesta successiva dell’utente. Solo dopo il risultato è possibile trasformare il controllo in routine. La chat e il risultato sono nello stesso spazio; non esistono tab di configurazione o pulsanti prova/salva iniziali.

Due seguiti guidati:
- Assegna a Giulia e sposta in lavorazione: proposta concreta e conferma; aggiorna il risultato fittizio mantenendo la dipendenza aperta.
- Ripeti ogni mattina: propone orario e giorni, poi registra la routine nel centro Attività esistente. Ripete soltanto il controllo, non la precedente modifica della scheda.

## Limiti
Scenario dichiaratamente simulato con due bacheche. La chat riconosce solo i seguiti dimostrati; non interpreta richieste generiche. Nessuna azione esterna. La conversazione si azzera uscendo, mentre la routine registrata resta nello stato condiviso fino al reload. Non sono ancora definiti accessi e connessioni reali, costi stimati e errori operativi.

## Verifica
Browser: richiesta → Prodotto → risultato → conferma modifica → conferma ricorrenza → apertura della routine condivisa con orario e fonte corretti. Controllo visivo della schermata risultato. TypeScript e lint superati; build prototipo superata.
