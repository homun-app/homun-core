# Ricevute durevoli delle chiamate esterne

Aggiornamento successivo: la riapprovazione delle consegne dopo cambiamenti del
lavoro è ora implementata e verificata nel [rapporto dedicato](2026-09-23-external-delivery-verifica.md).
I limiti sotto descrivono lo stato della prima tranche.

## Comportamento implementato

Il percorso MCP supervisionato salva l'intento prima dell'IO e l'intera ricevuta
prima della pubblicazione dell'artifact. Una seconda approvazione di una chiamata
completata restituisce lo stesso artifact. Una pubblicazione interrotta riparte
dalla ricevuta senza ridispatch. Risultati di errore dello strumento rimangono
ricevute distinte dai guasti di trasporto.

Un guasto di trasporto diventa `outcome_unknown`, non un fallimento che consenta
un retry automatico. L'intento rimasto in esecuzione dopo un arresto è riconosciuto
come incerto al successivo controllo dopo 30 secondi; prima resta in corso.
Non si catturano `SystemExit`/`KeyboardInterrupt`. Non c'è una scansione automatica
all'avvio: il controllo avviene tramite la stessa operazione/API esposta dalla UI.

Il digest approvato comprende versione del lavoro e hash della configurazione
server, inclusi endpoint, comando, argomenti, ambiente, header e allowlist. Solo
proprietario o revisore umano può approvare. Una mutazione blocca prima dell'IO;
una nuova proposta sostituisce quelle obsolete ancora non eseguite. Gli ID di
comando non possono sovrascrivere operazioni precedenti o cambiare argomenti.

La UI mostra esiti incerti, errori e pubblicazioni pendenti; il pulsante di ripresa
pubblica esclusivamente la ricevuta. I dettagli privati della ricevuta non sono
inclusi nella risposta pubblica; gli errori di trasporto non espongono endpoint
o credenziali. Il contenuto testuale dello strumento diventa l'artifact previsto.

## Evidenza

`engine/tests/test_external_receipts.py` verifica replay di approvazione,
configurazione mutata, collisione ID, argomenti cambiati, esito incerto, errore
strumento, `SystemExit`, lavoro mutato durante IO, ripresa della pubblicazione,
e sostituzione di proposte obsolete.

La fixture di runtime esegue un vero processo stdio MCP che incrementa un file.
Dopo il risultato si inietta un errore di pubblicazione, si ricrea il contesto
Homun dalla stessa SQLite e si riprende. Risultato: un artifact, contatore esterno
uguale a **1**, ricevuta strutturata conservata. È una prova locale senza servizi
pubblici, non un'attestazione su ogni server MCP o su un arresto dell'intero OS.

La revisione indipendente ha riprodotto il blocco delle proposte obsolete;
la correzione è coperta da due regressioni. Il resto del contratto è specifico
della persistenza Homun, senza introdurre Hermes come runtime.

Verifica: **768 test engine passati, 1 saltato** nella suite completa;
**47 test mirati passati** dopo la correzione finale, inclusa la prova stdio con
ripresa da SQLite. **216 test web passati**, typecheck e build riusciti, OpenAPI
allineato, architettura 0 errori (35 avvisi dimensionali preesistenti).

## Limiti aperti

- Una ricevuta con versione del lavoro ormai diversa resta conservata ma non
  pubblicabile: manca ancora il percorso di riapprovazione della sola consegna.
- Un esito incerto richiede verifica sul servizio prima di una nuova azione.
  Non si promette exactly-once distribuito: l'arresto dopo l'effetto e prima del
  salvataggio della ricevuta lascia intenzionalmente un'incertezza.
- Il pin riguarda la configurazione dichiarata, non il contenuto del programma
  server o lo schema MCP scoperto. Schema/grant binding, riconciliazione e
  collegamento al ciclo adattivo restano requisiti aperti H36/H40.
- Le vecchie proposte senza pin richiedono una nuova proposta; nessun consenso
  viene ricostruito retroattivamente.

App installata e deployment invariati. La parità completa H01–H46 resta aperta.
