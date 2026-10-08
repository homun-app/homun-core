# Hermes e Homun: come si usano e che cosa semplificare

23 settembre 2026. Homun: commit `8b7658b2` integrato su `main`.
Hermes: documentazione ufficiale live consultata in questa data e due racconti
diretti di utenti. Non è un benchmark: Hermes non è stato installato o provato
in questa analisi, i racconti non sono misure indipendenti né rappresentano
tutta la comunità. Per Homun usiamo codice, prove del consolidamento e rapporti
datati; non abbiamo ripetuto qui tutti i percorsi con modelli reali.

> Aggiornamento successivo: questo confronto conserva lo snapshot `8b7658b2`.
> Uso diretto, ciclo adattivo sui materiali, onboarding e contributi sono stati
> aggiunti nella [tranche operativa](2026-09-23-homun-operativo-verifica.md).
> L’aggiunta non certifica parità di strumenti o qualità con Hermes.

## La differenza da valutare

**Ipotesi di prodotto:** Homun può rendere semplice affidare e verificare un
risultato aziendale conservando obiettivo, fonti e responsabilità. Il vantaggio
va dimostrato nell'uso: avere più oggetti di dominio non lo dimostra.

Hermes oggi propone una conversazione operativa accessibile da più superfici:
Desktop, terminale e gateway condividono il nucleo dell'agente. Il Desktop
mostra attività degli strumenti, file allegati e anteprime accanto alla chat.
Il confronto corretto include questa esperienza grafica, non soltanto una CLI.
[Documentazione Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop).

Entrambi possono avere agenti specializzati e controllo umano. Evitiamo quindi
la contrapposizione assoluta “Hermes autonomo, Homun supervisionato”: contano
quali decisioni il prodotto fa prendere, quando e con quali conseguenze.

## Come viene introdotto Hermes

Il quickstart fa scegliere il provider, completare una conversazione concreta
e verificare che la sessione si riprenda. Solo dopo introduce gateway, strumenti
aggiuntivi e automazioni. La lezione per Homun è un primo risultato circoscritto
prima della configurazione di una squadra completa.
[Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart).

Il percorso di apprendimento è organizzato anche per scopo: programmazione,
assistente su messaggistica, automazioni e bot specialisti. Questo permette
alla persona di entrare dal proprio bisogno. Per Homun una scelta iniziale
come “confronta due file” o “prepara una relazione” potrebbe essere più utile
di una spiegazione preventiva di progetti, capacità, procedure e team.
È una proposta da verificare, non una modifica già decisa.
[Learning path](https://hermes-agent.nousresearch.com/docs/getting-started/learning-path).

Bot Mode non richiede una configurazione completa per iniziare: crea un bot da
nome, ruolo e descrizione, con opzioni avanzate separate. Bot e gruppi hanno
chat persistenti; menzioni ed escalation all'utente rendono visibile chi deve
intervenire. Un gruppo ha limiti di turni e messaggi. Per Homun il riferimento
utile è rendere collaboratori e responsabilità leggibili quando servono, senza
obbligare l'utente a progettare un organigramma per il primo lavoro.
[Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode).

## Due usi raccontati da chi lo utilizza

La raccolta ufficiale è un punto di scoperta di casi, non una prova della loro
frequenza o affidabilità. Abbiamo aperto i post originali dei due esempi sotto.
[User Stories](https://hermes-agent.nousresearch.com/docs/user-stories).

| Caso raccontato | Percorso descritto dall'autore | Lezione per Homun |
| --- | --- | --- |
| Idee disordinate → documento | Dettatura con uno strumento esterno, testo in un topic Telegram, outline e sviluppi delle idee, Markdown locale, poi documento collaborativo Proof su richiesta | Accettare una richiesta incompleta, produrre presto una bozza leggibile, lasciare il giudizio alla persona. Non attribuire a Hermes la dettatura dello strumento esterno |
| Segnalazioni → selezione quotidiana | Ricerche salvate sui portali inviano annunci a una casella dedicata; un cron legge gli avvisi, applica criteri personali e invia una sintesi; la persona decide chi contattare | Un ingresso affidabile e criteri chiari possono valere più di un agente che naviga liberamente. Separare raccolta, filtro e decisione |

Fonti dirette: [idee → documenti](https://www.reddit.com/r/hermesagent/comments/1ut8o53/i_dictate_messy_ideas_into_my_phone_and_hermes/),
[casella dedicata → selezione](https://www.reddit.com/r/hermesagent/comments/1v06ap3/i_gave_hermes_its_own_inbox_now_it_scouts/).
Il secondo autore racconta anche che il tentativo iniziale di cercare sui siti
era fragile e restituiva dati già vecchi. È un'esperienza individuale; non è
una misura comparativa dei browser agentici.

## Riutilizzo, memoria e ricorrenza

Le skill Hermes sono procedure caricate quando pertinenti e possono essere
create o modificate dall'agente. Esiste un gate opzionale che conserva le
modifiche in attesa di approvazione. Homun possiede procedure staged/approved
usate dalla sintesi, ma non va dichiarato equivalente all'intero ecosistema
Hermes di skill, script e distribuzione. La domanda UX è: dopo una correzione,
come capisce l'utente se ha cambiato questo risultato o il metodo futuro?
[Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).

Hermes distingue memoria sintetica del profilo, procedure e ricerca delle
sessioni precedenti. La documentazione segnala che una promessa testuale di
ricordare non prova una scrittura persistente. Per Homun l'esito dovrebbe essere
visibile: informazione salvata, ambito, stato di approvazione e utilizzo futuro.
Questo è un criterio di analisi, non una certificazione del richiamo semantico
attuale. [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).

Il cron Hermes può avviare attività isolate, associare skill e consegnare
risultati su canali configurati; supporta anche script senza modello. In Homun
la routine crea lavori supervisionati: non equivale a consegnare automaticamente
un report già eseguito e approvato. La UI deve far capire cosa accadrà alla
prossima scadenza e quale intervento resterà umano.
[Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron).

## Gli stessi bisogni, percorsi diversi

| Bisogno | Hermes documentato | Homun oggi | Confine da rendere chiaro |
| --- | --- | --- | --- |
| Fare una domanda | Conversazione con eventuali strumenti | Classificazione domanda/lavoro; una domanda può restare chat | Nessun accordo obbligatorio per una risposta semplice; qualità della classificazione da valutare |
| Confrontare due listini | Agente usa file/strumenti disponibili per risolvere il compito | Capacità deterministica CSV, proposta approvata, report/CSV da verificare | I campi e i vincoli del confronto devono risultare comprensibili prima dell'avvio |
| Preparare una relazione | File, skill e strumenti nel contesto della conversazione | Sintesi con modello dell'assegnatario, materiali e procedure approvate | Bozza testuale con provenienza; non promessa di impaginazione DOCX/PDF o dati esterni non acquisiti |
| Lavorare con specialisti | Bot/profili, gruppi, menzioni e deleghe | Profili, team e assegnazione delle fasi | La presenza dei team non dimostra una conversazione multi-bot equivalente a Bot Mode |
| Ripetere un'attività | Cron esegue e consegna secondo configurazione | “Rendi ripetibile” da lavoro concluso, cadenza e nuovi lavori supervisionati | Creazione del lavoro distinta da esecuzione, revisione e invio |
| Estendere gli strumenti | Toolset, plugin, MCP e skill | Catalogo MCP, dichiarazione/allowlist, prova e approvazione dell'esecuzione | Esecuzione MCP non ancora coperta dallo stesso recupero DBOS dei tool locali |
| Riprendere dopo giorni | Sessioni persistenti e ricerca dello storico | Lavoro persistente con stato, piano, materiali e artifact | L'utente deve riconoscere risultato, blocco e prossima azione senza rileggere tutta la chat |

Evidenza Homun: [stato corrente](../STATO.md),
[prove](2026-09-23-consolidamento-verifica.md),
[guida d'uso](../USO-HOMUN.md). Le celle Hermes sintetizzano le fonti vicine alle
sezioni precedenti; la tabella non attribuisce un esito di benchmark.

## Dove usare Homun adesso

Tre prove iniziali ragionevoli, con dati sintetici prima di un pilot:

1. **Ufficio acquisti:** confrontare due listini con SKU compatibili, ottenere
   differenze e report, verificare eccezioni. È il caso con evidenza più concreta.
2. **Responsabile operativo:** caricare note o documenti supportati e ottenere
   una bozza di relazione con vincoli e fonti. Capacità implementata; la qualità
   sul dominio aziendale va misurata, non dedotta dai test con provider finti.
3. **Attività ricorrente:** trasformare un lavoro riuscito in modello di routine,
   osservare il lavoro generato e ripetere la supervisione. Non presentarlo come
   monitoraggio automatico di posta o siti senza connettori e prove dedicate.

Email, Telegram, pubblicazione esterna, ricerca autonoma estesa e collaborazione
fra installazioni sono esigenze da progettare/verificare, non funzionalità
implicite perché esiste MCP. Homun non va ristretto ai CSV: quel caso è un primo
metro di accettazione per un prodotto più generale.

## Base per la discussione UX, senza decidere ancora il redesign

La mia ipotesi è ridurre ciò che l'utente deve conoscere, conservando il dominio
che garantisce persistenza e controllo. Le decisioni da discutere sono:

- **Ingresso:** partire dalla richiesta e dai materiali; proporre progetto e
  collaboratore al momento utile. Verificare quando la configurazione è necessaria.
- **Decisione umana:** distinguere chiarimento, autorizzazione ed esito da
  verificare. Misurare quante conferme ripetono la stessa decisione; accorparle
  richiede un contratto preciso, non semplicemente togliere i pulsanti.
- **Vista del lavoro:** obiettivo, stato e prossima azione devono restare chiari
  anche quando piano, fonti e dettagli tecnici sono richiusi.
- **Riutilizzo:** partire da un lavoro riuscito e mostrare cosa si riusa, cosa
  cambia e quali dati serviranno la prossima volta.
- **Lessico:** valutare “strumenti” e “procedure” al posto di MCP, capability e
  skill nel percorso ordinario; mantenere i nomi tecnici dove si configura.

Prima di cambiare UI: walkthrough dei tre casi, poi test con persone del target.
Registrare completamento senza aiuto, tempo al primo risultato utile, richieste
di chiarimento, numero di conferme, cambi di schermata e capacità di riprendere
un lavoro. Nessun valore di partenza è stato misurato qui. L'analisi successiva
deve produrre una mappa degli attriti e una proposta piccola da discutere con Fabio.
