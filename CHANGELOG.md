# Changelog

Le note di ogni versione di Homun stanno qui: la sezione della versione
pubblicata finisce nel corpo della GitHub Release (da cui l'app mostra il
«cosa cambia» quando propone un aggiornamento). Formato: `## [x.y.z] — data`,
sezioni H2 e un punto per riga.

## [0.3.1001-beta.3] — 2026-11-11

Il turno di Trello con 11 card di approvazione e nessuna risposta: chi legge
per rispondere a ciò che hai chiesto non chiede più a ogni passo.

### Approvazioni

- **In Automatico il bot non chiede più per ogni lettura che serve a ciò che
  hai chiesto.** Un modello controlla ogni azione sulla tua richiesta: fa
  passare quello che serve (anche i passi che non hai detto) e ti chiede
  solo quando va chiaramente oltre e non si annulla facilmente: scrivere a
  qualcuno che non hai nominato, pagare, cancellare, pubblicare. Le tue
  regole continuano a venire prima — e ora servono per allargare, non per
  far funzionare l'Automatico.
- **Per le letture dirette c'è «Per questo turno».** Se consenti una
  richiesta diretta di lettura a un'app (per esempio le tue board di
  Trello), le altre letture della stessa app fino a fine turno passano
  senza chiedere di nuovo. Le scritture continuano a chiedere ogni volta.
- **Un nome scritto male non apre più una card.** Se il bot chiama uno
  strumento che non esiste, riceve subito l'errore con i nomi giusti più
  vicini: niente consensi salvati per cose mai esistite.
- **Le card si leggono.** Il titolo delle richieste dirette non contiene
  più l'indirizzo intero (che restava su una riga sola e allargava la
  chat): l'indirizzo completo si vede una volta sola, negli argomenti, e va
  a capo.
- **Il controllo automatico risponde più spesso al primo colpo e aspetta
  abbastanza il modello.** Se la risposta del controllo arriva incompleta,
  il bot riprova una volta da solo invece di aprirti una card; e il
  controllo ha dieci secondi di tempo, non più cinque.

### Connessioni e aggiornamenti

- **Meno interruzioni quando la connessione con un'app cade.** Se una
  lettura già approvata muore per una connessione chiusa, il bot si
  riconnette e la ripete una volta da solo, senza una card nuova per ogni
  tentativo; le scritture non si ripetono mai da sole.
- **Le note dell'aggiornamento si leggono.** Nel dialogo «È disponibile
  Homun…» non si vedono più i tag dell'HTML: elenchi puntati, righe e
  accenti come devono essere, e le note lunghe si tagliano pulite con un
  invito ad aprirle tutte.

## [0.3.1001-beta.2] — 2026-11-10

Correzioni e ritocchi dalla prova della beta.1 sul Mac: l'aggiornamento che
non partiva dall'app copiata a mano, e le cose che chiedevi dopo averla usata.

### Aggiornamenti

- **Se apri Homun fuori da Applicazioni (dal dmg o dai Download), adesso te
  lo dice.** Da lì l'aggiornamento automatico non può sostituire l'app: Homun
  chiede di spostarsi in Applicazioni e lo fa da solo, chiedendoti conferma
  se ci trovi già una tua copia (chat e impostazioni non cambiano). Se
  rispondi «Non ora», l'app funziona lo stesso ma gli aggiornamenti restano
  spenti: in Impostazioni › Generali trovi il motivo e il bottone per
  riprovarci quando vuoi.
- Chi aveva copiato l'app a mano si era ritrovato un Homun di troppo acceso
  in background anche dopo aver chiuso tutto: quello sbagliato ora viene
  fermato e riparte quello giusto.

### Impostazioni

- **Una sola ✕, che non scappa.** Nelle Impostazioni la ✕ scorreva via col
  contenuto e in «App e skill» ce n'erano due sovrapposte: adesso ce n'è
  una, sempre visibile, in ogni scheda.
- **La lingua si sceglie da un elenco.** Al posto dei pulsantini, il menu
  che usi già per la finestra di consegna: «Sistema», «Italiano»,
  «English». Le prossime lingue entreranno lì, senza bottoni in più.

### Il tuo bot

- **Il modello sta nel profilo del bot.** Sotto il nome, nel pannello a
  destra: vedi quale modello usa (o «Come gli altri») e cliccando lo cambi
  lì, senza aprire il foglio delle impostazioni. Anche l'avviso «Configura
  prima un provider e un modello…» in chat porta direttamente alla scelta
  del modello di quel bot.
- **Gli avvisi ripetuti si raggruppano.** Se lo stesso avviso arriva due
  volte di fila lo vedi una volta sola, con un piccolo «×2» accanto.

## [0.3.1001-beta.1] — 2026-11-10

La prima versione del canale di prova: chi vuole vedere Homun 0.3 prima
degli altri può farlo in sicurezza, senza che niente cambi per chi aspetta
la stabile (e senza toccare Homun 2).

### Aggiornamenti

- **«Ricevi le versioni di prova»**: in Impostazioni › Generali, sotto
  «Controlla aggiornamenti». Acceso, le versioni di prova arrivano subito,
  senza riavvio; spento, non compaiono mai. Chi ne installa una continua a
  riceverle finché non esce la versione stabile.
- Le versioni di prova possono avere difetti: per questo le scegli tu, una
  volta sola, e le puoi spegnere quando vuoi. Chi non le chiede (incluso
  Homun 2) continua a vedere solo le stabili.

### App

- La finestra «App» è più semplice: cerca, collegate, tutte le app e le skill
  dei bot — le opzioni da sviluppatore stanno nel foglio «Per sviluppatori».
- Con la tua chiave Composio (piano gratuito) colleghi più di mille app:
  Gmail, Slack, HubSpot e molte altre, attivate una volta sola.
- Ogni app dice da dove passano i suoi dati («Diretta» o «Tramite Composio»),
  e le azioni seguono le regole di sempre: letture libere, invii in bozza,
  scritture con carta di approvazione.

## [0.3.1001] — 2026-11-03

Correzioni dal confronto con Rakazo e dalla prova d'installazione della
0.3.1000.

## Fixes

- **Le email verso i server di posta aggiunti a mano partono davvero.** Se
  colleghi un server che non è nel catalogo, ogni invio diventa comunque una
  bozza che vedi prima di confermare; e se c'è un solo strumento d'invio per
  quel canale, la bozza sa già come usarlo. Prima l'email restava ferma e
  l'errore arrivava solo al clic su Invia.
- **I messaggi automatici non passano più per tuoi.** Il giro che il bot fa
  al tuo rientro e le routine programmate compaiono in chat come piccole
  righe di sistema («⏱ Routine «Backup»», «Al tuo rientro»), non come se li
  avessi scritti tu.
- **Una routine che chiedi tu nasce con un solo consenso.** Prima il bot la
  creava in pausa e poi serviva un'altra conferma per attivarla; adesso una
  sola scheda ti mostra nome, orario e prompt, e approvando la routine parte.
- **Le correzioni a metà lavoro arrivano subito.** Se scrivi mentre un bot è
  occupato, il messaggio entra nel lavoro in corso invece di aspettare la
  fine in coda.
- **Il pannello del bot non copre più la chat.** Con la finestra stretta il
  pannello si affianca stringendo la barra laterale; quando proprio non c'è
  spazio, diventa un foglio sopra la chat, con il resto oscurato.
- **I tuoi messaggi hanno sempre lo stesso colore.** Le bolle a destra della
  chat non prendono più il colore del bot: la chat resta neutra come nelle
  app di messaggistica, e il colore del bot resta alla mascotte e
  all'identità del bot.
- **Con il pannello aperto resta solo la ✕.** Il bottone in alto a destra
  sparisce quando il pannello è già aperto (non due comandi per la stessa
  cosa) e alla chiusura il focus torna a lui.
- **La pillola col nome del bot apre e chiude il pannello.** Un clic sulla
  scritta in alto al centro mostra o nasconde il pannello del bot (nella
  squadra, quello dei membri); il resto della fascia continua a
  trascinare la finestra.

## [0.3.1000] — 2026-11-02

Homun torna: questa versione è il rinnovo completo di Homun 2, con la squadra
di bot che vive sul tuo Mac. **Le conversazioni e i bot di Homun 2 non vengono
importati: restano dove sono**, in `~/Library/Application Support/Homun2`
(apribile dal Finder la prima volta che apri la nuova app), e puoi conservarli
o cancellarli quando vuoi.

## Highlights

- **Un rinnovo, non un'importazione.** Homun 0.3 è la stessa app di sempre —
  stesso bundle, stesso aggiornamento automatico — con il motore rifatto: i
  bot, le routine, la cassaforte e il computer dei bot girano tutti in locale.
- **Il daemon è più sicuro.** Il processo che tiene in vita i bot quando
  chiudi la finestra ora è l'app stessa (niente più modalità «Node spoglio»):
  le build firmate spegnono quel vettore, e le chiavi della cassaforte sono
  legate alla firma dell'app — un altro programma che prova a leggerle fa
  comparire la richiesta di macOS.
- **Docker e git si trovano anche fuori dal Terminale.** Aprire l'app dal
  Finder non tocca più il percorso del box: se manca Docker Desktop, l'app te
  lo dice in parole con il link per installarlo.
- **Aggiornamenti mai in silenzio.** Quando c'è una versione nuova l'app te lo
  dice, scarichi guardando l'avanzamento e scegli se riavviare subito o
  installare alla chiusura. Il controllo parte solo nell'app installata.

## Fixes

- **Le finestre di dialogo si allargano davvero**: le Impostazioni occupano
  ora fino a 1080 px e «Nuovo bot» non sfora più in orizzontale.
- **La pagina è servita dall'app stessa** (protocollo `homun://`), non da
  `file://`, con i permessi del browser chiusi al minimo indispensabile.

## [Unreleased]

## Highlights

- **Il computer dei bot (Docker) resta un requisito** della prima versione
  firmata; la macchina virtuale inclusa nell'app arriva in una versione
  successiva.
