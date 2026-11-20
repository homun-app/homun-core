# Changelog

Le note di ogni versione di Homun stanno qui: la sezione della versione
pubblicata finisce nel corpo della GitHub Release (da cui l'app mostra il
«cosa cambia» quando propone un aggiornamento). Formato: `## [x.y.z] — data`,
sezioni H2 e un punto per riga.

## [0.3.1001-beta.15] — 2026-11-20

I bot cercano meglio sul web, e i server npm sono chiusi in un recinto vero.

### Correzioni

- **Il bot cerca prima di aprire:** non inventa più indirizzi di pagine o
  di siti. Parte da una ricerca o dalla home del sito e usa la sua ricerca.
- **Quando una pagina non si apre, il bot dice perché:** indirizzo
  inesistente, pagina non trovata, sito che blocca l'accesso automatico o
  sito in manutenzione. Dice «mi bloccano» solo quando è vero.
- **Il bot non si ferma più mentre aspetta un suo aiutante:** ti dà un
  aggiornamento e riprende da solo quando l'aiutante ha finito.
- **Nei campi di ricerca con suggerimenti** (per esempio la stazione di
  partenza) il bot sceglie tra le opzioni proposte invece di inviare a
  vuoto.
- **Server MCP da npm più sicuri:** partono solo quando il computer
  isolato non ha altre uscite verso internet. Il nome del pacchetto è
  controllato con le regole di npm, e il filtro di rete non si può aggirare
  cambiando il nome del sito nella richiesta.

## [0.3.1001-beta.14] — 2026-11-20

Homun si apre sempre, e collega i server MCP che usi già.

### Novità

- **«Importa da Cursor, Claude o ZCode»** nella finestra Server MCP: scegli
  quali server portare in Homun, e token e chiavi finiscono cifrati.
- **I server MCP che girano sul tuo Mac accettano le variabili** (indirizzi,
  token, team), con i valori segreti salvati cifrati. Homun trova `npx` e
  `node` anche quando li hai installati con fnm o nvm.
- **Il bot può proporti un server MCP da npm** quando un servizio non è nel
  catalogo: vedi pacchetto, versione, autore e download prima di
  confermare. Gira nel computer isolato, con la rete aperta solo verso il
  servizio che deve usare, e la versione resta fissa finché non approvi un
  aggiornamento.

### Correzioni

- **Homun si apre sempre al primo clic:** dal Dock o riaprendo l'app,
  la finestra ricompare anche se l'avevi chiusa.
- **All'avvio la finestra non resta più vuota:** dice che sta avviando o
  aggiornando il motore, e dopo un po' offre «Riprova».
- **Il bot non scambia più una pagina web per un server MCP** e ti indica
  la strada giusta per collegarlo.

## [0.3.1001-beta.13] — 2026-11-20

Collegare i tuoi strumenti è più facile da trovare.

### Novità

- **«Server MCP» ha una finestra sua,** nel menu in basso accanto a
  «Skill». Se usi già Cursor o Claude, sono gli stessi server: li
  aggiungi qui con lo stesso comando o lo stesso indirizzo.
- **Se un'app non c'è nel catalogo, il bot non si arrende:** ti chiede se
  hai un server MCP per quel servizio e ti porta con un bottone dove
  aggiungerlo.

### Correzioni

- **Il campo di scrittura non si deforma più con i testi lunghi:** da due
  righe in su il testo va a tutta larghezza e i bottoni scendono sotto.
- **Nella barra di sinistra chi sta lavorando sale in cima,** subito dopo
  chi aspetta te.

## [0.3.1001-beta.12] — 2026-11-20

La barra di sinistra rifinita.

### Correzioni

- **La barra di sinistra è più compatta e ordinata:** testo più piccolo,
  righe più basse, numeri arancio senza riquadro e pulsanti in alto più
  leggeri.
- **I segni di stato sono più discreti:** puntini e pallino più piccoli,
  con un'onda sottile quando un bot aspetta te.

## [0.3.1001-beta.11] — 2026-11-20

Una barra più pulita per chi ha tanti bot, e l'icona nuova.

### Novità

- **La barra di sinistra è più sobria:** una riga per nome, senza
  anteprime. Le squadre hanno il loro piccolo robottino, i bot un pallino
  del loro colore. In alto restano Nuovo, Bot, Da approvare, Attività e
  Libreria.
- **Lo stato si vede da un piccolo segno animato**, lo stesso della
  mascotte: i puntini quando un bot lavora, il pallino arancio quando
  aspetta te, un saltello quando ha finito. Con «Riduci movimento» del Mac
  restano fermi.
- **Chi aspetta te sta in cima** e ogni sezione mostra i più recenti, con
  «Mostra tutti» per il resto. L'ultimo messaggio lo vedi passandoci
  sopra con il mouse.
- **L'icona nuova di Homun,** nel Dock e nella barra dei menu.

### Correzioni

- **«Da approvare» non copre più la chat:** si chiude con «Chiudi» o
  scegliendo un bot, una squadra, la Libreria o l'Attività.

## [0.3.1001-beta.10] — 2026-11-20

Squadre di bot più autonome e tutte le richieste in un posto solo, in
vista della prima versione pubblica.

### Novità

- **«Da approvare»: tutte le richieste in un posto.** Una voce in cima
  alla barra di sinistra raccoglie quello che i bot, le squadre e i loro
  aiutanti ti chiedono, con chi lo chiede e perché. Ogni richiesta si
  decide da lì o dalla chat in cui è nata.
- **Le richieste restano in cima alla chat** finché c'è qualcosa da
  decidere: vedi le due più urgenti senza doverle cercare. Se Homun non è
  in primo piano, ti arriva una notifica.
- **Squadre più autonome nel computer dei bot.** Una squadra crea file e
  lancia comandi nel suo computer isolato senza chiederti ogni volta. Nella
  scheda «Autonomia» scegli quanto fa da sola. Dati tuoi, pagamenti, invii
  verso fuori, azioni sul Mac ed eliminazione di bot chiedono sempre a te.
- **Una chat di squadra che racconta il lavoro:** vedi gli scambi tra i
  bot, i file e i documenti prodotti, e le richieste nel punto in cui sono
  nate.
- **Il pannello «Il team»** mostra cosa fa ogni bot, chi aspetta te e
  cosa ha prodotto la squadra.
- **Quando un bot chiede qualcosa a un altro, la risposta torna da sola**
  a chi ha chiesto, che prosegue il lavoro.
- **«Consenti per questa missione»** lascia proseguire una squadra su un
  sito per 8 ore. Non vale mai per pagamenti e dati tuoi, né dopo che un
  bot ha letto contenuti non fidati.

### Correzioni

- **I documenti della Libreria si aprono** anche con una squadra aperta.
- **La chat di squadra non si blocca più** mentre i bot lavorano.
- **Gli aiutanti dei bot rispondono nella tua lingua.**
- **Un bot tolto da una squadra perde subito i permessi** che aveva in
  quella squadra.

## [0.3.1001-beta.9] — 2026-11-18

Più semplice da usare, in vista della prima versione pubblica.

### Novità

- **La barra di sinistra si apre e si chiude da un bottone** sempre
  visibile in alto, accanto ai semafori, anche quando è stretta.
- **«Libera spazio» libera davvero:** toglie la cache di costruzione del
  computer dei bot, mostra che sta lavorando e dice quanto spazio hai
  recuperato.
- **«Compatibile OpenAI» più completo:** un nome per riconoscerlo, la
  chiave facoltativa per i server che non la chiedono e il modello da
  scrivere a mano quando il server non ne dà l'elenco. È «locale» solo se
  l'indirizzo è sul tuo computer o sulla tua rete.
- **Le approvazioni salvate valgono per il bot:** «Consenti sempre» vale
  per il bot che l'ha chiesto, senza più doppioni. In Impostazioni ›
  Approvazioni le trovi divise per bot.

### Correzioni

- **La finestra a parte dello schermo non fa più sparire Homun:** ha una
  barra sempre visibile e «Riporta in Homun» rimette lo schermo al suo
  posto.
- **«Ho finito» si vede sempre** quando controlli lo schermo, anche con la
  finestra bassa: prende il posto di «Prendi il controllo».
- **Sotto i messaggi resta solo «Copia»**, che ora conferma con una spunta.
- **I loghi di Anthropic e OpenAI sono quelli giusti** e si leggono nei due
  temi.
- **«Elimina» nella Cassaforte cancella davvero** login, segreti e
  contatti.

## [0.3.1001-beta.8] — 2026-11-16

Lo schermo del bot sempre a vista e i lavori lunghi che non si fermano a
metà, dalla prova della beta.7.

### Novità

- **La card «Computer» mostra lo schermo vero:** mentre il bot usa il
  browser vedi cosa sta facendo, dal vivo. Guardare non accende niente e
  non tiene acceso il browser.
- **Lo schermo in una finestra a parte:** «Stacca» lo apre in una piccola
  finestra sempre in primo piano, che puoi spostare e ridimensionare;
  «Riporta qui» lo rimette nella scheda Computer.
- **Il bot ti mostra le foto che cattura** nel suo computer, nella stessa
  galleria della chat.

### Correzioni

- **I lavori lunghi non si fermano più a metà:** il bot ha molti più passi
  a disposizione e si ferma prima solo se ripete la stessa azione senza
  andare avanti.
- **Quando si ferma, il bot risponde sempre:** dice cosa ha fatto, cosa ha
  trovato e cosa resta; scrivi «continua» per andare avanti.

## [0.3.1001-beta.7] — 2026-11-16

Gli aiutanti del bot e le richieste di conferma, dalla prova della beta.6.

### Correzioni

- **Le richieste di un aiutante arrivano in chat:** compaiono sotto la
  card «Aiutante», con la notifica, e le confermi da lì. Anche dal pannello
  dell'aiutante ora la conferma funziona.
- **La card «Aiutante» si segue:** dice quando aspetta te, cosa sta facendo
  in quel momento, da quanto lavora e quanti passi ha fatto.
- **Una richiesta scaduta non torna uguale:** il bot sa che non hai
  risposto, non che hai rifiutato, e non la ripropone identica.
- **Nel computer dei bot i comandi girano senza chiedere**, anche in
  «Chiedi»: è isolato dal Mac. Chiedono ancora i comandi con un segreto e
  lo scambio di file col Mac; sul Mac non cambia niente.
- **Il bot sa che nel suo computer i comandi non vanno su internet** e per
  il web usa la lettura delle pagine o il browser.

## [0.3.1001-beta.6] — 2026-11-16

Le correzioni dalla prova della beta.5 installata da zero.

### Correzioni

- **Il computer dei bot preparato dalla guida si usa davvero.** Prima i
  comandi giravano comunque sul Mac; chi ha già la beta.5 lo trova sistemato
  al primo avvio. In Impostazioni › Generali › Computer dei bot scegli
  «Dove girano i comandi».
- **Il bot legge tutti gli annunci di una pagina**, non solo il primo, e
  non rilegge la stessa pagina a vuoto.
- **Le foto in chat:** il bot ti mostra le immagini della pagina che ha
  letto. Le scarica lui, così il sito non vede il tuo indirizzo.
- **Il bot dice il vero:** un assistente interrotto non risulta finito, e
  un'azione non riuscita non diventa «fatto».
- **Dopo aver collegato un'app il bot ne trova subito gli strumenti.**
- **Una cosa da ricordare che aspetta la tua conferma** compare in chat
  con il bottone per aprirla.

## [0.3.1001-beta.5] — 2026-11-15

### Novità

- **Il computer dei bot funziona senza Docker** su macOS 26 o successivo,
  con Apple container. Docker resta per chi lo preferisce.
- **«Spazio su disco» nelle Impostazioni:** cosa occupa e come liberarlo.
- **Più account per la stessa app** (per esempio due caselle Gmail), e il
  bot sa subito quale hai collegato.
- **Una guida che porta da zero a un bot pronto**, computer del bot
  compreso; i messaggi senza modello ripartono da soli.
- **La card «Computer» dice il vero:** Acceso, In attesa, In avvio, Spento.

### Correzioni

- **Il browser del bot raggiunge internet con Apple container** e riparte
  dopo un riavvio del Mac.

## [0.3.1001-beta.4] — 2026-11-12

Quattro cose che hai chiesto dopo la beta.3.

### Novità

- **Un solo «Nuovo», e il bot si presenta.** Dal «+» crei il bot con nome e
  aspetto: è lui a chiederti a cosa serve, a scriversi la descrizione e a
  partire. Le squadre nascono in chat, e puoi ancora partire da un modello.
- **Il bot sa quali app hai collegato.** Trello, Gmail, i server che hai
  aggiunto: li usa subito, senza cercare un connettore nuovo ogni volta.

### Correzioni

- **Le note dell'aggiornamento si leggono e i bottoni restano visibili.**
- **La creazione dalla chat è più pulita:** le risposte, le anteprime, le
  richieste ai bot e le routine col bottone «Attiva» a portata di clic.

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
