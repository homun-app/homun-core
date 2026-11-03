# Changelog

Le note di ogni versione di Homun stanno qui: la sezione della versione
pubblicata finisce nel corpo della GitHub Release (da cui l'app mostra il
«cosa cambia» quando propone un aggiornamento). Formato: `## [x.y.z] — data`,
sezioni H2 e un punto per riga.

## [Prossima]

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
