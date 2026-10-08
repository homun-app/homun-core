# Homun — Assistenti operativi per piccole aziende

Piattaforma in italiano dove un'azienda senza reparto informatico crea assistenti (bot) e automazioni. Il cuore del prodotto è composto da tre sole cose; tutto il resto è un plugin che si aggiunge dal mercato.

Marchio: nome **Homun** (homun.app). Loghi forniti: wordmark chiaro (inchiostro #101917) e scuro (panna #F4F1EE), con punto teal #157A6E. Il teal diventa il colore principale dell'interfaccia e il wordmark compare in testata; favicon ricavato dal logo. Controllo il tono del sito homun.app per coerenza.

Grafica: direzione "Alpine frost calm" scelta — sfondo chiaro con luci diffuse, pannelli translucidi, testo Manrope; al posto del blu di esempio si usa il teal Homun, verde per "in corso", ambra per "in pausa".

## Il core (sempre presente)

1. **Chat con i bot** — un bot generico che non sa fare nulla di specifico da solo: acquisisce capacità dai plugin attivi nel progetto.
2. **Pipeline e automazioni** — costruttore in stile IFTTT: "quando succede questo → fai questo". Semplice come IFTTT nella lettura, con la possibilità di più passaggi in fila come n8n, ma senza grafo da disegnare e senza codice.
3. **Dashboard componibile** — la home non è fissa: l'utente scegle i riquadri da mostrare. Sempre disponibili i riquadri "bot e agenti attivi" e "pipeline in esecuzione"; ogni plugin installato aggiunge i suoi riquadri, che l'utente può attivare, spostare e togliere.

## Tutto il resto è plugin

Email, calendario, fatture e solleciti, monitoraggio siti, **analisi concorrenti**, documenti, messaggistica: nessuno di questi è una funzione fissa del prodotto. Ogni plugin porta con sé tre cose:

- gli **strumenti** che il bot può usare in chat,
- i **blocchi** utilizzabili come innesco o azione nelle pipeline,
- i **riquadri** che l'utente può aggiungere alla dashboard.

Aggiungere un servizio nuovo in futuro significa aggiungere un plugin, non toccare il core.

## Accessi e privacy

- **Azienda → Progetti**: i dati vivono dentro un progetto. Un progetto è visibile solo a chi è invitato: chat, pipeline, riquadri, plugin collegati e report restano separati fra progetti.
- **Plugin per progetto**: i collegamenti (per esempio una casella email) si attivano su un singolo progetto e non sono visibili agli altri.
- **Ruoli**: Titolare (fatturazione, membri, tutti i progetti), Gestore (installa plugin, crea bot e pipeline nei suoi progetti), Collaboratore (usa e chatta, non modifica le pipeline), Ospite (sola lettura).

## Pagine

1. **Dashboard componibile** — riquadri scelti dall'utente; modalità "modifica dashboard" per aggiungere/togliere/riordinare.
2. **Chat** — conversazione con un bot, elenco chat a lato, pannello "Attività strumenti" che mostra in chiaro cosa il bot ha fatto. Ogni chat ha il suo indirizzo per ritrovarla nel progetto.
3. **Pipeline** — elenco pipeline con stato; editor a passaggi: un innesco in cima, poi le azioni in fila, con condizione opzionale ("solo se…"). Scelta di inneschi e azioni limitata ai plugin installati, ognuno descritto in italiano semplice. Attiva/pausa, prova a mano, storico esecuzioni con esito di ogni passaggio.
4. **Mercato plugin** — catalogo con descrizione di cosa il bot potrà fare, installazione per progetto, gestione dei collegamenti.
5. **Team e ruoli** — inviti, ruoli, progetti visibili a ciascuno.
6. **Pagina pubblica di presentazione** con accesso e registrazione (email/password + Google).

## Come funziona sotto (parte tecnica)

- Lovable Cloud per accessi, dati, file e lavori pianificati. Ogni tabella filtra per progetto e appartenenza: l'isolamento è imposto dal database, non solo dall'interfaccia. Ruoli in tabella separata con funzione di controllo.
- Tabelle: organizations, projects, project_members, bots, plugin_installations, plugin_credentials, conversations, messages, tool_calls, pipelines, pipeline_steps, pipeline_runs, run_step_logs, dashboard_widgets, audit_log. I dati specifici di un plugin (es. concorrenti e rilevazioni) vivono in tabelle del plugin, sempre legate al progetto.
- **Registro plugin** lato codice: ogni plugin dichiara i suoi strumenti (per la chat), i suoi blocchi innesco/azione (per le pipeline) e i suoi riquadri (per la dashboard). Chat, pipeline e dashboard leggono da questo registro, quindi non conoscono i singoli servizi.
- Esecuzione pipeline: lavoro pianificato lato server con limite di elementi per esecuzione, blocco anti-doppia-esecuzione, registrazione di ogni passaggio, ripresa dopo errori e stop automatico in caso di errori ripetuti.
- Modelli linguistici e chiamate ai servizi esterni sempre lato server; le credenziali dei plugin salvate cifrate e mai esposte al browser.
- **Componenti chat già pronti**: la conversazione usa AI Elements (la libreria ufficiale di componenti dell'AI SDK): trascrizione con scorrimento automatico, testo in arrivo con formattazione, allegati e file, blocchi di codice, attività degli strumenti con dettagli richiudibili, campo di scrittura. Non riscrivo da zero questi pezzi; li personalizzo con i colori Homun.
- **App desktop**: l'interfaccia è la stessa dell'app web e viene confezionata come applicazione per Mac e Windows con Electron, in modo che il prodotto si apra come un programma. Il confezionamento avviene alla fine, quando l'interfaccia è pronta; le funzioni che richiedono il computer dell'utente (in futuro la registrazione dello schermo) diventano possibili proprio grazie a questa scelta.

## Fase 1 (questa costruzione)

Core completo: accessi e ruoli, azienda e progetti isolati, chat con bot funzionante e attività strumenti (con AI Elements), costruttore pipeline in stile IFTTT con esecuzione reale pianificata, dashboard componibile, mercato plugin con installazione per progetto, team e inviti. Marchio Homun applicato.

Plugin inclusi per dimostrare l'architettura: **Email**, **Calendario**, **Monitoraggio siti**, **Analisi concorrenti** (con report periodici), **Fatture e solleciti**.

## Fase 2 (dopo)

- **Confezionamento e distribuzione desktop**: build firmata per Mac e Windows e aggiornamenti automatici.
- **Registrazione a video per insegnare un compito**: diventa possibile nell'app desktop; richiede la parte che cattura lo schermo e ripete i clic. In Fase 1 al suo posto: "insegna a parole o con screenshot" — carichi gli screenshot dei passaggi e li descrivi, il bot ne ricava la procedura.
- Plugin verso gestionali di fatturazione italiani e fatturazione elettronica.
- Plugin creati da terzi e condivisi nel mercato.
- Piani e limiti d'uso per azienda.

## Cosa mi serve da te

- Quali caselle email e calendari usate (Google, Microsoft o altro), per il primo collegamento reale.
