# Design — New Chat Six-Month Usage Layout

Data: 2026-07-21. Stato: **approvato in conversazione**.

## Decisione

La nuova chat separa il periodo dell'infografica dal periodo del riepilogo. Il
calendario mostra sempre le ultime 26 settimane, mentre i controlli
`7 giorni / 30 giorni / Tutto` aggiornano esclusivamente metriche, rotta dominante e
suggerimenti. Il composer torna nella posizione operativa standard, ancorato in basso.

Questa specifica integra e restringe la sezione “Nuova chat” di
`2026-07-21-provider-usage-infographic-design.md`; non modifica la pagina
`Settings → Usage`.

## Obiettivi

1. Rendere la heatmap immediatamente leggibile come cronologia semestrale stabile.
2. Mantenere numeri e costi filtrabili senza far cambiare forma al grafico.
3. Riportare il prompt in basso, nella stessa posizione usata durante la conversazione.
4. Mostrare esclusivamente dati reali e distinguere chiaramente giorni non coperti e
   giorni coperti senza attività.
5. Conservare tooltip, accessibilità, attribuzione `provider → modello` e responsive.

## Layout della nuova chat

La griglia principale mantiene tre righe: top bar, contenuto flessibile e composer. La
modalità vuota non aggiunge più una quarta riga di bilanciamento e non colloca il
composer nel blocco centrale.

Nel contenuto flessibile:

- il benvenuto occupa un gruppo tipografico di due righe nella parte superiore;
- la prima frase è il messaggio principale, grande e autorevole, per esempio
  `Buongiorno, Fabio.`;
- la seconda frase è un invito più piccolo e discreto, per esempio
  `Da dove vogliamo cominciare?`;
- il ritorno a capo è strutturale e non dipende dal wrapping automatico del testo;
- l'infografica segue il benvenuto con un margine verticale ampio e resta centrata
  orizzontalmente, senza apparire accatastata sotto il testo;
- il composer rimane ancorato al margine inferiore della finestra;
- aprendo un thread con messaggi non avviene alcun salto strutturale del composer.

Su viewport compatte il contenuto può scorrere verticalmente, ma il composer resta
l'ultimo elemento della griglia e non viene reinserito nel blocco del saluto.

### Ritmo e gerarchia tipografica

Il gruppo di benvenuto e l'infografica non formano una singola card. La gerarchia usa
spazio e tipografia, non contenitori aggiuntivi:

- frase principale: peso medio, dimensione fluida circa 28–34 px e interlinea compatta;
- invito secondario: circa 14–16 px, peso normale e colore attenuato;
- distanza tra le due righe: 8–10 px;
- distanza tra il benvenuto e l'infografica: fluida, indicativamente 36–72 px;
- distanza inferiore libera: appartiene al contenuto e non spinge il composer, che
  resta nella propria riga ancorata in basso.

Sotto i 760 px le dimensioni e il margine verticale possono ridursi, ma le due righe
mantengono contrasto gerarchico e non vengono fuse. Le frasi localizzate devono restare
brevi; quando una traduzione va a capo, il testo secondario inizia comunque su una riga
separata.

## Finestra del calendario

La heatmap della nuova chat rappresenta sempre 26 colonne settimanali, inclusa la
settimana corrente. Inizia dal primo giorno locale della settimana di 25 settimane fa
e termina oggi: contiene quindi da 176 a 182 giorni reali, senza celle future. Le celle
restano ordinate per settimana e giorno come nell'attuale contribution graph.

La UI recupera la serie giornaliera con la finestra dati più ampia già disponibile e
ritaglia localmente le ultime 26 settimane. Non viene aggiunto un nuovo valore al
contratto backend `UsageWindow`, perché la finestra semestrale è una scelta di
presentazione esclusiva della Home.

I giorni vengono classificati così:

- prima di `coverage_started_at`: `unavailable`;
- durante la copertura senza eventi: `zero`;
- durante la copertura con eventi reali: `active` con intensità calcolata sui token.

Non vengono interpolati eventi, token, costi o rotte. Quando la raccolta è appena
iniziata, la maggior parte della griglia è correttamente visibile come non disponibile.

## Filtri e flusso dati

I controlli `7 giorni / 30 giorni / Tutto` continuano a determinare:

- chiamate, token, costo e qualità del dato;
- rotta dominante `provider → modello`;
- suggerimento Usage contestuale.

Non determinano più le celle della heatmap. Il componente mantiene quindi due flussi
espliciti:

1. riepilogo e suggerimenti caricati per il periodo selezionato;
2. serie giornaliera semestrale caricata indipendentemente.

Un cambio filtro non svuota, ricrea o comprime la heatmap. Refresh ed errori di uno dei
due flussi non cancellano l'ultimo dato valido dell'altro.

## Responsive e interazione

Su desktop la heatmap occupa la parte principale della superficie e le metriche restano
a destra. Le 26 colonne mantengono celle e spaziature leggibili; quando non entrano, il
calendario usa uno scorrimento orizzontale discreto e parte posizionato sulle settimane
più recenti.

Su larghezze compatte le metriche passano sotto il grafico. Tooltip da mouse e focus da
tastiera continuano a mostrare data, uso, costo e rotta reale senza essere tagliati dal
contenitore.

## Stati ed errori

- La heatmap mantiene l'ultima serie valida durante il refresh.
- Se la serie semestrale fallisce, il riepilogo filtrato resta utilizzabile e compare un
  retry non bloccante.
- Se il riepilogo fallisce, la heatmap resta visibile.
- Prima del primo evento reale non vengono mostrate metriche inventate né celle attive.
- I dati parziali mantengono l'avviso di copertura già previsto.

## Strategia di test

1. Test unitario: la finestra Home occupa 26 colonne settimanali, parte dal primo giorno
   locale della settimana prevista e termina oggi senza date future.
2. Test unitario: giorni anteriori alla copertura sono `unavailable`, quelli coperti ma
   vuoti sono `zero`.
3. Test di contratto: la nuova chat richiede la serie giornaliera indipendentemente dal
   filtro del riepilogo.
4. Test di layout: la modalità vuota usa la riga composer inferiore e non la griglia
   centrata a quattro righe.
5. Test di struttura: benvenuto principale e invito secondario sono elementi distinti,
   con classi tipografiche e riga semantica separate.
6. Test interazione: cambiare `7d / 30d / Tutto` aggiorna i numeri ma non il numero o le
   date delle celle.
7. Verifica nell'app reale a viewport desktop e compatta, inclusi ritmo verticale,
   ancoraggio del composer, scroll orizzontale,
   tooltip ai bordi e focus da tastiera.

## Criteri di accettazione

La correzione è completa quando:

1. il prompt è visivamente ancorato in basso in ogni nuova chat;
2. il benvenuto presenta una frase principale grande e un invito secondario più piccolo;
3. l'infografica è separata dal benvenuto da un margine ampio e resta centrata;
4. la heatmap mostra sempre 26 settimane reali, indipendentemente dal filtro numerico;
5. i filtri aggiornano metriche e suggerimenti senza ricostruire il grafico;
6. i periodi non coperti non sono rappresentati come zero o attività;
7. il calendario resta leggibile e navigabile alle larghezze target;
8. test mirati, typecheck, build e verifica renderizzata dell'app sono verdi.
