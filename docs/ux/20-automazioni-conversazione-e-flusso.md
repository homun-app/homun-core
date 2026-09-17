# Automazioni: conversazione e flusso

## Direzione UX
Un’unica bozza modificabile attraverso chat e blocchi visuali. I dettagli di avvio o di un passaggio si aprono su richiesta, senza esporre inizialmente tutti i campi. Collaboratori selezionabili con il componente condiviso: ricerca per competenze e curriculum consultabile sul posto. Riordino tramite trascinamento o pulsanti accessibili.

## Comportamento del prototipo
- Il prompt usa il componente condiviso basato su AI Elements, con allegati.
- La chat prepara una proposta da confermare: suddivide soltanto righe, punto e virgola, “poi” e “quindi”. Non interpreta semanticamente la richiesta.
- I comandi esatti `@` e `/progetto`, senza allegati, aprono le scelte contestuali. I pulsanti rendono le scelte accessibili senza conoscere comandi.
- Avvio manuale, giorni/orari, intervalli ed eventi restano configurabili. Il riepilogo del blocco riflette la bozza.
- Salva conserva la procedura nella sessione. Prova manuale genera incarichi collegati, senza esecuzioni esterne. La chat rimane disponibile passando da Componi a Prove.
- Ogni passaggio conserva materiali, responsabile, supervisione, criteri di riuscita e budget previsti dal modello esistente.

## Limiti e motore futuro
Non è un interprete AI: non deduce orari, strumenti o responsabili dal testo. Nessuna schedulazione reale, persistenza duratura, condizione o ramo parallelo. Il motore dovrà proporre modifiche strutturate alla stessa bozza, chiedere soltanto i dati mancanti e verificare strumenti, permessi e supervisione prima dell’attivazione. Il risultato di un passaggio oggi è una dipendenza dimostrativa, non un trasferimento reale di dati tra strumenti.

## Verifica eseguita
Browser: due passaggi da chat, assegnazione a Elio e Vera, riordino tramite drag e pulsanti, avvio ogni 30 minuti, apertura del singolo dettaglio, salvataggio e prova con primo incarico da fare e secondo in attesa. Controllati desktop e viewport mobile; nessun overflow orizzontale. Dodici test su pipeline e delega superati; TypeScript, lint dei componenti modificati e build del prototipo superati.

## Iterazione: chat principale e riferimenti durante la scrittura

Il composer condiviso accetta un catalogo di riferimenti. In Automazioni, digitare `@` apre subito collaboratori e progetti ricercabili. Frecce, Invio ed Escape gestiscono la scelta senza inviare il messaggio. I riferimenti selezionati sono consultabili sotto il testo e arrivano alla proposta con ID e tipo; i collaboratori usano la scheda condivisa. I documenti non sono ancora nel menu; rimangono disponibili gli allegati.

Il riepilogo sostituisce il diagramma inizialmente visibile. “Mostra passaggi e riordina” espone il flusso esistente. Per la simulazione sono riconosciuti i collaboratori selezionati con @ e la formula “ogni mattina/giorno alle HH[:MM]”; i giorni si modificano dal riepilogo. È una trasformazione limitata, non comprensione AI: revisioni citate nella frase diventano passaggi, non una politica di approvazione inferita. Una nuova proposta aggiunge passaggi, non riscrive automaticamente quelli esistenti.

Verifica browser: composizione tramite menu e tastiera di Elio, progetto Qualità e backlog, Vera e Fabio; tre passaggi assegnati, ore 09:00 e scelta lunedì-venerdì. Fabio non appartiene al progetto demo: l’avviso compare sul passaggio e il salvataggio è bloccato. Cambiando esplicitamente il responsabile con uno idoneo il salvataggio riesce. Verificati apertura/chiusura del diagramma, TypeScript, lint e build. Il riposizionamento del cursore dopo una menzione è sincrono al rendering, per non interrompere la digitazione veloce.
