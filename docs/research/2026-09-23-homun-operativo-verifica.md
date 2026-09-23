# Homun operativo: consegna e verifica

23 settembre 2026. Tranche successiva ad `a2d420c8`, branch di lavoro
`fabio/homun-squadra-operativa`. Sorgente locale; non è una nuova release desktop.

## Obiettivo e perimetro consegnato

Homun deve poter essere usato direttamente, mentre l'azienda può costruire
progressivamente una squadra. Un confronto CSV non definisce il prodotto.
Questa tranche rende operativi i due ingressi e un primo passaggio tra bot e persona:

- Una richiesta eseguibile non richiede più un profilo artificiale. Homun usa la
  connessione attiva, conserva il proprietario umano e consegna in revisione.
- Il ciclo adattivo decide tra letture, ricerche, consultazioni, chiarimenti e
  consegna. Osservazioni, fonti/versioni, limiti, approvazione e ripresa sono persistenti.
- L'onboarding salva contesto aziendale e propone una squadra. La conferma crea
  profili e team, senza collegare strumenti o concedere accessi implicitamente.
- Una squadra scelta nel lavoro permette consultazioni effettive del modello
  dei collaboratori. Il risultato torna al coordinatore e consuma budget.
- Un destinatario umano può rispondere a una richiesta tramite un portale ristretto.
  La risposta sblocca l'esecuzione che l'aveva richiesta. Credenziale temporanea,
  revoca, destinatario e versione del lavoro restano vincolati alla richiesta.
- La revisione conserva artifact e fasi riuscite, inserisce una nuova fase e
  non salta le attività successive. Un errore del provider consente un nuovo
  tentativo con nuova proposta e autorizzazione.

Gli strumenti adattivi disponibili sono `list_materials`, `read_material`,
`search_materials` e, con squadra selezionata, `consult_collaborator`.
Non include ancora web, shell, MCP generici, ricerca/installazione di agenti
pronti o collaborazione distribuita. Non è una dichiarazione di parità con Hermes.

## Verifica automatica

Sul sorgente della tranche, Python 3.13 dell'ambiente esistente:

- Suite motore: **608 passati, 1 saltato**; include runtime HTTP/DBOS, riapertura
  del contesto persistente, materiale cambiato, pausa durante il modello, limiti,
  proposta obsoleta, fasi, revisione intermedia, consultazioni e portale umano.
- Suite web: **211 passati**; typecheck, build web e build prototipo riusciti.
- Desktop: **11 passati**. Non equivalgono a installazione o upgrade sul Mac.
- OpenAPI rigenerato e controllato; architettura **0 errori, 35 avvisi** di dimensione.
- Review indipendenti del percorso diretto, onboarding, contributi e ciclo adattivo;
  rilievi corretti e regressioni rieseguite. Diff senza errori di whitespace.

Restano gli avvisi build sui chunk, una deprecazione Starlette/AnyIO e il debito
lint globale già documentato. Nessuna formattazione massiva del legacy.

## Verifica con modello reale e interfaccia

Profilo sintetico separato in `/tmp`, motore su loopback, browser Playwright e
modello locale Ollama `qwen3.5:4b`; nessun dato dell'app installata modificato.

1. Onboarding dell'officina: salvataggio persistente, proposta, conferma e
   comparsa dei collaboratori nella barra laterale verificati nel browser.
   La prima prova aveva chiesto due ruoli nel testo e ricevuto sei; corretto il
   prompt e aggiunto un numero esplicito opzionale, validato dal motore.
   La seconda prova ha prodotto due ruoli pertinenti (scadenze e note operative).
2. Richiesta diretta di nota operativa: accordo, preparazione, esecuzione con
   Ollama e artifact in revisione, senza creare un agente. La prima bozza dava
   troppo peso agli obiettivi aziendali: ora il modello riceve anche le richieste
   originali e istruzioni esplicite sulla loro priorità. La qualità del modello
   resta da misurare su più casi; la modifica non certifica da sola il contenuto.
3. Caso adattivo predisposto via API con documento sintetico e destinatario
   nominativo: esecuzione reale, osservazioni persistite e attesa del contributo.
   Risposta dal portale browser dopo riavvio del motore, ripresa, lettura del
   documento e consegna in revisione verificate. Il modello ha chiesto una seconda
   conferma non necessaria e la prima consegna riportava la scadenza corretta ma
   non integrava il nome fornito dalla persona. Il contesto ora conserva domanda
   e risposta anche nelle revisioni; il prompt chiede di integrare entrambe le fonti.
   La prima revisione ha tentato di leggere usando il nome file come id ed è
   stata bloccata. Dopo aver fornito gli id delle fonti fin dalla prima decisione,
   un nuovo tentativo reale ha consegnato versione 2 con scadenza e Marta Rossi
   correttamente integrate, senza altre domande. Il testo conteneva ancora newline
   letterali e provenienza duplicata: qualità/formattazione da perfezionare,
   non correttezza del ciclo da confondere con qualità della consegna.
   Il setup API è distinto dall'intake conversazionale provato al punto 2.
4. Nuova richiesta adattiva dal composer: proposta `agent_run` prodotta da
   Ollama, conferma, pannello “Lavora con Homun”, squadra opzionale e creazione
   di Paolo prova come destinatario selezionato verificati nel browser.

## Limiti che contano per il prodotto

Il portale attribuisce la risposta al destinatario dichiarato attraverso il
possesso del link: non autentica una persona con account verificato. Il browser
del destinatario deve raggiungere pagina e motore. Non sono stati aperti server
sulla rete né configurati tunnel o invii. I colleghi non hanno ancora una inbox
condivisa tra installazioni.

L'onboarding è un modulo opzionale con proposta revisionabile: non è ancora
un'intervista interamente in chat. I profili dichiarano competenze; non installano
capabilities. Le consultazioni AI leggono le osservazioni autorizzate e non
avviano sottoagenti con strumenti indipendenti. Tutto resta soggetto al modello,
ai budget e al catalogo disponibile.

## Analisi UX da condurre sul lavoro reale

Misurare il tempo al primo risultato utile, le decisioni comprese, i passaggi
ridondanti e la capacità di riprendere dopo una pausa. Scenari da usare:

| Scenario | Risultato utile | Attrito da osservare |
| --- | --- | --- |
| Chiedo una bozza una tantum | Documento pronto da correggere | Accordo, prepara e avvia sono tre passaggi; capire quando accorparli |
| Descrivo la mia azienda | Piccola squadra comprensibile | Linguaggio dei ruoli, numero proposto, separazione persone/bot |
| Affido un lavoro alla squadra | Un esito coordinato | Chi lavora, perché viene consultato, quali dati vede |
| Serve un dato a Marta | Domanda chiara e risposta riutilizzata | Link e raggiungibilità locale, identità, attesa visibile al proprietario |
| Correggo una consegna | Nuova versione con modifiche richieste | Differenze tra versioni, fase corrente, numero di approvazioni |
| Torno dopo due giorni | So cosa è pronto e cosa dipende da me | Chat, Compiti e Documenti devono dare lo stesso prossimo passo |

La nicchia da validare è la continuità del lavoro con persone e AI: contesto,
responsabilità, passaggi di mano e risultati riutilizzabili. Il numero di bot o
di schermate non è una misura del valore.
