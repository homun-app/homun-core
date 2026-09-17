# Simulazione UX: commessa con eventi e intervalli

## Metodo
Navigazione reale del prototipo il 15 settembre 2026, impersonando il titolare di una piccola azienda. Nessun motore o evento esterno attivo. Le transizioni dello stato sono state effettuate manualmente. Gli scenari temporali sotto sono una simulazione ragionata, non esecuzioni osservate.

## Scenario
Progetto Fornitura Rossi: Marta prepara il preventivo entro venerdì alle 15. Giulia carica il listino. Vera verifica i prezzi ogni due ore, lunedì-venerdì, tra le 09 e le 17. Marta usa il risultato valido, Fabio approva, poi avviene l'invio. Se cambia il listino, la bozza va rivalutata.

## Prove effettuate e risultati
1. Scritta la richiesta completa nella chat di Marta, convertita in incarico: tutto il testo diventa titolo, scadenza vuota; intervallo, condizioni e approvazione non sono strutturabili.
2. Creato progetto con Marta e Vera: possibile scegliere squadra e responsabilità; manca una sequenza operativa condivisa.
3. Creati incarichi per Vera e Marta nello stesso progetto: presenti nel Kanban, nell'agenda e nel progetto.
4. Aggiunta attesa di Marta verso Vera: possibile indicare agente e motivo, impossibile scegliere l'incarico/risultato specifico atteso.
5. Segnato completato l'incarico di Vera senza un risultato: consentito. Marta resta bloccata; nessun passaggio automatico né cronologia della consegna.
6. Agenda: la frase “ogni 2 ore” resta nel titolo; nessuna prossima esecuzione. Data prevista, scadenza e ricorrenza non sono rappresentate insieme.
7. Progetto con due incarichi ancora descritto come “primo lavoro da definire”: corretto il riepilogo per mostrare quantità e stati effettivi degli incarichi.
8. Home: un'attività di Marta apriva l'incarico ma riportava “Preparazione del collaboratore”: corretto il testo del collegamento.

## Cosa manca all'esperienza
- Una scheda di conferma dell'intento: obiettivo, responsabile, materiali, avvio, scadenza, approvazione. Le informazioni dedotte dalla chat devono essere verificabili; quelle mancanti vanno chieste.
- Separazione tra regola ricorrente e singola esecuzione: finire un controllo non significa disattivare il monitoraggio.
- Dipendenza da un risultato concreto e dalla sua versione, anziché dal solo nome di un agente.
- Distinzione tra attesa prevista e intervento urgente. Se Vera sta lavorando normalmente, non è una richiesta da mostrare al titolare.
- Prossima azione spiegata: evento atteso, prossimo controllo, motivo della pausa, responsabile dello sblocco.
- Controlli della routine: pausa/riprendi, ultima esecuzione, prossima esecuzione, costo e limite.
- Diario del lavoro: attivazione, passaggio di consegne, errore, approvazione, risultato. Le note manuali non bastano.
- Azioni di approvazione esplicite (approva, chiedi modifiche), legate alla versione del risultato.

## Simulazione temporale proposta
| Momento | Evento | Comportamento da rendere visibile |
|---|---|---|
| Lunedì 09:00 | Routine attivata | Vera controlla i prezzi; prossimo controllo 11:00; costo del controllo e della routine distinti |
| 09:10 | Listino ancora assente | Marta aspetta Giulia; nessun tentativo ripetuto di produrre il preventivo |
| 10:20 | Listino caricato | Identificare il documento e la versione; verificare requisiti prima di dichiarare sbloccato il lavoro |
| 11:00 | Nuovo controllo prezzi | Se il precedente è ancora in corso, mostrare la politica di sovrapposizione; proposta iniziale: saltare il doppione |
| 11:05 | Vera consegna prezzi | Marta riceve quel risultato e procede se anche il listino è valido |
| 12:00 | Arriva di nuovo lo stesso evento | Nessun preventivo duplicato; mostrare l'evento riconosciuto come già gestito |
| Giovedì 16:00 | Nuovo listino dopo approvazione | Segnalare modifica dei materiali; rivalutare la bozza e richiedere nuova approvazione se cambia |
| Venerdì 12:00 | Manca approvazione | Richiesta a Fabio con scadenza alle 15 e risultato da leggere |
| Venerdì 15:00 | Scadenza superata | Esporre ritardo e causa; nessun invio implicito |
| Sabato | Fuori finestra lavorativa | Routine in attesa fino a lunedì, non “bloccata” |
| In qualsiasi momento | Budget esaurito | Pausa esplicita, importo e azione per riprendere; nessuna escalation di costo nascosta |
| Riavvio dopo stop | Esecuzioni perse | Rendere chiaro se recuperare una sola esecuzione o saltare; nessun recupero incontrollato |

## Proposta UX prioritaria
Nel pannello incarico usare sezioni progressive:
1. Obiettivo e risultato atteso.
2. “Quando parte”: appena possibile, a una data, a intervalli, quando accade qualcosa.
3. “Di cosa ha bisogno”: file, accessi e risultati di altri incarichi.
4. “Prima di consegnare”: chi approva e quale azione è autorizzata.
5. “Cosa succede dopo”: sintesi leggibile della prossima transizione.

Esempio di sintesi, con valori da confermare:
“Vera controlla ogni 2 ore, lun–ven 09–17, fuso Europe/Rome. Marta prepara la bozza quando riceve listino e prezzi verificati. Fabio approva prima dell'invio. Se un controllo è già in corso, il successivo viene saltato.”

Home: decisioni dell'utente e rischi concreti; Kanban: singoli incarichi/esecuzioni; calendario: scadenze e prossime esecuzioni con legenda e filtro, evitando centinaia di schede future.

## Prossimo esperimento
Prototipare una sola catena completa con regole configurabili e comandi esplicitamente dimostrativi: “simula arrivo file”, “avanza di 2 ore”, “simula consegna di Vera”, “approva”. Verificare prima il comportamento con eventi ripetuti, materiali mancanti, esecuzione lenta e limite di costo. Mantenere il dominio agnostico: il preventivo è un caso di prova, non un tipo rigido di bot.

## Iterazione autonoma successiva
Implementato un laboratorio di comportamento nel dettaglio incarico, sotto “Quando e come parte” → “Prova il comportamento”. Le regole sono configurabili; gli eventi e l'orologio sono simulati e il diario spiega attese, duplicati, sovrapposizioni, errori, approvazione e budget. La scheda di lavoro rimane distinta dalla singola prova.

Preparati i Settings con cinque aree: spazio, modelli, costi/limiti, notifiche, dati/connessioni. I modelli possono essere registrati come riferimenti locali/remoti e associati come principale/alternativo ai collaboratori. Nessuna credenziale o connessione reale.

Verifiche: 31 test automatici, comprendenti 30 casi nominati e 500 sequenze di 30 eventi. Prove browser su dipendenze, eventi duplicati, intervalli, budget, errori, pausa/ripresa, revisione e modifiche post-approvazione; mantenimento di impostazioni e prove durante la navigazione; layout desktop/mobile. TypeScript e build prototipo superati.

Le prove hanno portato a ulteriori correzioni: avvio manuale non innescato dal semplice arrivo di un file; prossimo controllo mai lasciato nel passato dopo un avvio a intervalli; scelta di dipendenze cicliche impedita; azioni di revisione visibili anche quando l'anteprima del risultato è chiusa; completamento richiede un risultato e passaggi verificati; modifica di risultato/materiali riporta in lavorazione.

Ancora da collegare al futuro motore: credenziali protette, provider reali, calendario e fusi orari effettivi, schedulazione persistente, eventi da plugin, consegna reale tra incarichi con versioni, enforcement dei permessi, misurazione dei costi, notifiche, backup. Le impostazioni sono proposte UX; non applicano policy al simulatore, che ha un budget e un orologio separati.
