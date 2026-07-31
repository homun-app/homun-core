# Design — Provider Usage Infographic

Data: 2026-07-21. Stato: **approvato in conversazione**.

## Decisione

La nuova chat mostra un riepilogo Usage compatto e prevalentemente grafico; la pagina
`Settings → Usage` resta lo spazio di analisi completo. Entrambe le superfici leggono
esclusivamente dati reali registrati da Homun e condividono la stessa semantica.

Provider e modello non sono dimensioni indipendenti: l'identità primaria è la rotta
effettiva `provider → modello`. Lo stesso modello eseguito tramite Ollama Local, Ollama
Cloud, OpenRouter o un altro provider produce rotte distinte con consumi, costi, limiti
e affidabilità separati.

La nuova chat non mostra più il marchio Homun. Mantiene un solo saluto tipografico,
breve e variabile, seguito da un calendario di attività in stile contribution graph.

## Obiettivi

1. Rendere Usage professionale, leggibile e visivamente informativo.
2. Mostrare soltanto valori reali e dichiarare esplicitamente assenza o incompletezza.
3. Conservare l'attribuzione corretta `provider → modello` in aggregazioni e dettagli.
4. Dare alla nuova chat un'infografica compatta senza competere con il composer.
5. Rendere `Settings → Usage` uno spazio analitico completo ma non una raccolta di card.
6. Mantenere dark theme, accento teal, tipografia precisa e pochi bordi funzionali.
7. Verificare il risultato nell'app reale a larghezze desktop e compatte.

## Non obiettivi

- Non replicare pixel per pixel Claude o GitHub.
- Non generare dati dimostrativi, interpolati o retroattivi.
- Non unire costi riportati, stimati, non fatturati e sconosciuti.
- Non nascondere provider, copertura o provenienza per semplificare l'interfaccia.
- Non cambiare automaticamente il routing del modello dai suggerimenti Usage.
- Non introdurre una dipendenza grafica se SVG e CSS accessibili sono sufficienti.

## Semantica dei dati

### Rotta di inferenza

Ogni aggregato per modello usa la chiave composta:

```text
provider_id + model_id
```

La UI presenta la chiave come `Provider → Modello`. Un nome modello uguale con provider
diversi produce righe e quote diverse. La classifica generale può mostrare provider e
modelli separatamente, ma la rotta dominante deve provenire da una singola aggregazione
composta: non può essere costruita accostando due dominanti indipendenti.

### Serie giornaliera

Il ledger SQLite resta canonico. Un read model giornaliero espone, per ciascuna data:

- chiamate logiche e tentativi;
- token input, output, reasoning e cache;
- costo con provenienza separata;
- copertura Usage e copertura costi;
- rotta `provider → modello` dominante;
- esiti riusciti, falliti e interrotti.

I giorni compresi nella copertura ma senza eventi valgono zero. Le date precedenti a
`coverage_started_at` sono `unavailable`, non zero. Nessun endpoint o componente crea
valori di esempio.

### Intensità

La cella giornaliera usa i token totali come metrica primaria. I livelli cromatici sono
calcolati dalla distribuzione reale del periodo selezionato con una scala robusta a
outlier, così un picco non rende indistinguibili gli altri giorni. La legenda dichiara
la metrica. Zero e indisponibile hanno aspetto e descrizione differenti.

## Nuova chat

### Saluto

Il marchio SVG e il sottotitolo fisso vengono rimossi. Resta una sola riga con una frase
breve scelta da un catalogo localizzato e curato. La scelta considera:

- fascia oraria locale;
- nome dell'account, quando disponibile;
- presenza di un progetto attivo;
- nuova sessione o ritorno nell'app;
- lingua dell'interfaccia.

La frase scelta resta stabile per l'intera vita del componente o del thread. Non cambia
a ogni render, refresh dei dati o cambio del periodo Usage. Il catalogo mantiene tono
caldo, professionale e personale, con limiti di lunghezza che preservano una sola riga.
Quando il nome manca, si usa una variante grammaticalmente completa senza placeholder.

### Infografica compatta

Il pannello ha un'unica superficie larga quanto il composer e contiene:

1. selettore `7 giorni / 30 giorni / Tutto`;
2. pochi valori primari: chiamate, token, costo e copertura;
3. calendario giornaliero a intensità teal;
4. rotta dominante `provider → modello`;
5. collegamento a `Settings → Usage`.

Il grafico è l'elemento principale; etichette e valori lo supportano senza creare una
tabella tecnica. Lo stato vuoto spiega che la raccolta inizia dalla prima chiamata
registrata e non mostra una dashboard piena di zeri.

### Interazione del calendario

Ogni cella è raggiungibile con mouse e tastiera. Hover o focus apre un callout con:

- data locale completa;
- chiamate e tentativi;
- token totali e loro ripartizione essenziale;
- costo con provenienza;
- rotta dominante del giorno;
- indicatore di copertura quando incompleta.

Il callout non altera il layout, non resta tagliato ai bordi e non contiene dati assenti
mascherati da zero. Il click porta a Settings con il giorno o intervallo corrispondente
già selezionato quando il routing lo consente.

## Settings → Usage

La pagina completa usa lo stesso calendario e la stessa scala semantica. La struttura è
una singola superficie editoriale con separatori, spaziatura e fondi tonali funzionali:

- intestazione compatta con periodo e copertura;
- calendario giornaliero principale;
- riepilogo di token, chiamate, costi ed esiti;
- classifica delle rotte `provider → modello`;
- vista Provider con quota, costo, limiti, sorgente e reset quando disponibili;
- vista Modelli che mantiene sempre visibile il provider;
- vista Processi per chat, memoria, automazioni, presentazioni e altre attività;
- suggerimenti solo se supportati da dati sufficienti.

Costi riportati dal provider, stimati da catalogo, stimati manualmente, non fatturati e
sconosciuti restano separati nel dato e nella presentazione. Un budget manuale non viene
mai etichettato come limite del provider.

## Gerarchia visiva

- Dark theme e teal sono il default.
- Il saluto usa una dimensione autorevole ma non monumentale e una sola riga.
- Il calendario ha densità e contrasto maggiori dei valori testuali.
- Le metriche secondarie usano numeri tabulari e label brevi.
- Una sola superficie principale; niente card dentro card.
- Bordi solo per separatori funzionali, focus e controllo segmentato.
- Stati hover, focus e selezione non dipendono soltanto dal colore.
- Animazioni limitate a transizioni brevi; nessun effetto assimilabile a refresh continuo.

## Responsive

Su desktop il calendario e i riepiloghi condividono una composizione orizzontale. A
larghezze compatte le metriche passano sotto il calendario e la route dominante può
andare su una seconda riga senza sovrapporsi. Le celle mantengono una dimensione minima
interagibile; se una cronologia molto lunga non entra, il viewport del calendario resta
navigabile senza comprimere i giorni fino a renderli illeggibili.

La verifica visiva deve includere almeno:

- desktop ampio;
- finestra circa 1280 px;
- pannello Settings compatto;
- nome e route lunghi;
- tooltip vicino a ogni bordo;
- tema dark e, come regressione, tema light.

## Stati ed error handling

- Loading: mantiene l'ultimo dato valido e mostra solo un indicatore discreto.
- Empty: messaggio informativo, nessun falso zero.
- Partial: grafico disponibile con copertura dichiarata.
- Error: mantiene l'ultimo dato valido e offre retry non bloccante.
- Provider o modello mancante: route etichettata come incompleta, mai ricostruita per
  supposizione.
- Storico anteriore alla telemetria: cella indisponibile e spiegazione nel callout.

## Strategia di test

### Rust e API

- aggregazione giornaliera per finestra e timezone;
- separazione di rotte con stesso `model_id` e provider diversi;
- distinzione zero/unavailable;
- route dominante derivata da eventi della stessa coppia;
- cost provenance e copertura conservate;
- periodi vuoti, outlier e date al confine.

### TypeScript e componenti

- saluto localizzato stabile tra render e refresh;
- fallback senza nome;
- livelli di intensità deterministici e robusti agli outlier;
- callout con dati del giorno selezionato;
- navigazione da tastiera e focus visibile;
- stati loading, empty, partial ed error;
- route provider-modello mai separata o troncata senza accesso al valore completo.

### Verifica reale

- avvio del gateway e della UI con il database Usage reale;
- controllo che endpoint e valori mostrati coincidano;
- ispezione nel browser dell'app alle larghezze target;
- hover, focus, click, cambio periodo e apertura Settings;
- screenshot finali provenienti esclusivamente dall'app implementata.

## Criteri di accettazione

La modifica è completa quando:

1. nessuna anteprima o fixture appare come dato reale;
2. Home mostra una frase variabile ma stabile e non mostra più il marchio;
3. il calendario usa eventi reali e distingue zero da non coperto;
4. hover e focus espongono dettagli reali del giorno;
5. provider e modello sono aggregati e mostrati come coppia effettiva;
6. Ollama Local, Ollama Cloud e altri provider restano separati anche con lo stesso modello;
7. Settings offre viste coerenti per route, provider, modello e processo;
8. costi e copertura mantengono la loro provenienza;
9. layout, tooltip e tipografia sono verificati nell'app reale alle larghezze target;
10. test mirati, typecheck e gate di regressione applicabili sono verdi.
