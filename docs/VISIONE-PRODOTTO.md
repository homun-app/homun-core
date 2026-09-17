# Homun — visione del prodotto e base per il piano

Aggiornato: 16 settembre 2026.

Questo documento raccoglie la discussione con Fabio. Le sezioni distinguono
gli indirizzi espressi dall'utente dalle proposte ancora da validare.
Non è una specifica tecnica approvata né un'autorizzazione a implementare il motore.

## 1. Visione e destinatari

Homun permette di creare una propria squadra di collaboratori AI e affidarle
lavori aziendali. Il pubblico prioritario sono piccole aziende, anche con un
titolare e circa cinque collaboratori, senza reparto IT e con poco tempo.
L'obiettivo è velocizzare i processi, ridurre dimenticanze e migliorare la
qualità del lavoro senza richiedere competenze di programmazione.

Questa versione evolve il precedente progetto in ../app. Fabio vuole un
approccio differente dall'interfaccia di un agente per sviluppatori: il centro
del prodotto è la squadra e il suo lavoro. Il precedente Homun è una fonte di
componenti ed esperienza da valutare, non un'architettura da trasferire integralmente.

## 2. Indirizzi espressi da Fabio

### Collaboratori

- Un unico concetto di bot, personalizzabile con responsabilità, istruzioni,
  strumenti, modelli e memoria propria.
- I bot sono agnostici rispetto al settore: i casi d'uso sono esempi di
  configurazione, non tipi di bot distinti nel prodotto.
- Possibilità di dirigere personalmente i bot oppure affidarsi a un coordinatore.
- Il coordinatore è a sua volta un bot che organizza il lavoro.
- Un bot specializzato può controllare il lavoro degli altri e produrre resoconti.
- La squadra deve poter lavorare con clienti e fornitori.

### Lavori, procedure e avanzamento

- I bot devono seguire un metodo ripetibile: passaggi ordinati e checklist.
- Deve essere possibile distinguere un passaggio eseguito da uno verificato.
- Il metodo deve permettere adattamenti quando cambiano le condizioni.
- Automazioni e pipeline servono a realizzare processi, anche ricorrenti.
- Una vista tipo kanban deve rendere visibili lavori, avanzamento e attese,
  comprese dipendenze da altri bot o interlocutori.
- Scadenze, pianificazione e calendario devono essere considerate nella UX.

### Memoria, progetti e clienti

- Ogni bot ha memoria propria.
- Ogni progetto ha memoria condivisa e un vault di informazioni e documenti.
- Un progetto può essere legato a un cliente, con cartelle e informazioni dedicate.
- È prevista la gestione degli utenti e la possibilità di accesso del cliente
  alle informazioni che gli vengono rese disponibili.
- Confini di accesso e separazione delle conoscenze devono essere definiti.

### Modelli misti e costi

- Modelli locali per i compiti più semplici, per ridurre i costi.
- Libertà di collegare modelli remoti.
- Un bot può cambiare modello durante il lavoro oppure coinvolgere un altro
  agente dotato di un modello dedicato.
- L'identità del collaboratore non coincide con un singolo modello.
- È fondamentale sapere quanto costa realmente ogni bot/dipendente.
- La gestione dei costi è un elemento centrale del prodotto.

### Strumenti ed estensioni

- Strumenti generali: ricerca web, browser, terminale, file e accesso ai servizi.
- Plugin per capacità specializzate e collegamenti.
- Email e numerose integrazioni di base devono essere incluse gratuitamente;
  Fabio ha citato anche Slack.
- WhatsApp, Telegram e chat sul sito sono canali previsti o da esplorare.
- In futuro: telefonia, aggiornamento di siti web e ulteriori attività aziendali.
- Il catalogo esatto delle integrazioni iniziali non è deciso.

### Desktop e apprendimento tramite dimostrazione

- App scaricabile con preparazione automatizzata delle dipendenze in base al sistema.
- Rilevamento dell'ambiente e configurazione locale devono richiedere poco lavoro all'utente.
- In una fase successiva, insegnare operazioni mostrando come aprire applicazioni,
  compilare form, svolgere ricerche e seguire sequenze di azioni.
- Prima ipotesi per questa capacità: macOS e componente Swift per le funzioni native;
  Windows e Linux saranno valutati successivamente.
- Docker è stato menzionato come possibile ambiente di esecuzione, non è una
  dipendenza obbligatoria già scelta.

## 3. Modello di distribuzione e ricavi

Indirizzo espresso: piattaforma open source completa e gratuita.

- Bot, automazioni, pipeline, ricerca e strumenti fondamentali devono poter
  essere usati senza acquistare moduli.
- Il core deve permettere di realizzare il lavoro; le estensioni offrono
  specializzazioni o integrazioni facoltative.
- Esempi: motori di scrittura specializzati, moduli di fatturazione,
  creazione di template, connettori specifici.
- Possibili ricavi: vendita di piccoli moduli, plugin personalizzati,
  assistenza, marketplace e donazioni.
- Il modulo WhatsApp a 5 euro era un esempio esplorativo, non un prezzo deciso.
- Priorità iniziale: favorire adozione e uso effettivo.
- Licenza, prezzi, commissioni, servizi e confine esatto dei moduli a pagamento
  restano da definire. Non ereditare automaticamente la licenza del vecchio repository.
- Gratuità del software e costo di modelli remoti/servizi esterni devono essere
  distinguibili nella comunicazione e nel prodotto.

## 4. Casi d'uso emersi

### Manutenzione tecnica — esperienza personale di Fabio

Collegarsi a un server via SSH, controllare i log nelle cartelle, estrarre gli
errori, individuare il codice nel repository locale, correggere, pubblicare e
testare online. Utile per verificare capacità e procedure; non deve orientare
da solo la UX destinata alle aziende non tecniche.

### Ricerca e produzione editoriale

Controllare notizie ogni giorno e preparare articoli, seguendo un metodo e una
possibile revisione.

### Progetti software e sito

Controllare i progetti su GitLab e aggiornare il sito web.

### Amministrazione e scadenze

Verificare emissione o mancanza di fatture, tenere traccia delle scadenze e
segnalare situazioni che richiedono un intervento.

### Acquisti e mercato

Ricercare aggiornamenti su problemi relativi a componenti acquistati,
confrontare fornitori e prezzi, valutare alternative e osservare i concorrenti.

### Preventivi e appuntamenti — esempio guida UX accettato

Richiesta in arrivo, raccolta dei dati mancanti, bozza di preventivo, revisione,
invio e seguito della risposta/scadenza. È una proposta per il primo percorso
UX, accettata da Fabio come esempio: i bot restano agnostici. La prima
specifica proposta è in [ux/01-primo-collaboratore.md](ux/01-primo-collaboratore.md).

## 5. Impostazione tecnica: orientamenti, non scelte definitive

Il repository homun2 è oggi un prototipo UX con React/TanStack Start e Supabase.
Fabio ha chiarito che Supabase e il backend attuale potranno essere sostituiti.
La priorità attuale è definire interfaccia, elementi necessari e comportamento.

Fabio preferisce esplorare un approccio più semplice, usando componenti Python
esistenti ed evitando di ricostruire tutto in Rust. Ollama o un sistema analogo
è un candidato per i modelli locali. Librerie, runtime, modelli e database
devono ancora essere scelti.

Ricognizione statica effettuata in ../app: workspace con 20 moduli Rust,
Electron/React, componenti separati per browser e canali, servizio macOS Swift,
dipendenze Python per FastAPI/Pydantic/MLX e contratti per misurare l'inferenza.
Questo non costituisce verifica runtime né prova di riutilizzabilità diretta.

Proposte dell'assistente ancora da valutare: motore Python, Pydantic AI,
SQLite e cartelle locali, Python distribuito o gestito privatamente dall'app
tramite strumenti come uv, Docker richiesto soltanto da capacità specifiche.

## 6. Proposte funzionali da validare nella UX

- Separare procedura riutilizzabile, piano del singolo incarico e registro
  dell'esecuzione.
- Scheda del lavoro con risultato atteso, responsabile, passaggi, verifiche,
  scadenza, dipendenze, allegati e costo.
- Possibili stati: da fare, in corso, in attesa, da verificare, completato.
  Errori, annullamenti e interruzioni devono trovare una rappresentazione coerente.
- Rendere esplicito chi/cosa blocca un lavoro e quando riprenderlo.
- Distinguere adattamento del singolo piano da modifica della procedura condivisa.
- Mostrare costo del singolo bot e costo complessivo dell'incarico, includendo
  cambi modello, tentativi e deleghe senza doppio conteggio.
- Politiche dei modelli: automatico, solo locale o personalizzato; criteri,
  budget e confini dei dati da definire.
- Un controllo ricorrente senza anomalie può registrare l'esito; un'anomalia
  può generare un incarico visibile in bacheca.
- Progressione semplice: partire dal bisogno dell'utente, proporre un
  collaboratore e una procedura, mostrare configurazioni avanzate su richiesta.

## 7. Percorso proposto verso un piano

Questo è un ordine di lavoro candidato, senza date o impegni di implementazione.

1. Rivedere questo brief e risolvere le prime scelte strutturali.
2. Scegliere un caso d'uso guida e descriverlo dall'avvio al risultato.
3. Definire navigazione ed elementi: squadra, collaboratore, progetto/vault,
   lavori, dettaglio incarico, procedure, strumenti e costi.
4. Realizzare un prototipo navigabile sui componenti UX esistenti, dopo aver
   concordato il comportamento del percorso.
5. Provare successo, dati mancanti, errore, delega, cambio modello,
   approvazione, budget insufficiente e interruzione/ripresa.
6. Verificare la stessa struttura con altri casi d'uso aziendali.
7. Ricavare i contratti necessari al motore e confrontare librerie/componenti.
8. Costruire una prima esecuzione completa collegata alla UX, poi estendere.

## 8. Questioni ancora aperte

- Squadra a livello azienda assegnabile a più progetti o squadra indipendente per progetto?
- Ulteriori casi con cui verificare la generalità del percorso preventivi scelto?
- Rapporto tra azienda, progetto, cliente e postazione locale?
- Quali attività sono autonome e quali richiedono intervento umano?
- Come vengono create, corrette e versionate procedure e memorie?
- Quali dati sono condivisi con clienti e altri collaboratori?
- Dove eseguire lavori e scadenze quando il computer è spento o sospeso?
- Come servire più utenti e dispositivi mantenendo l'esperienza locale semplice?
- Quali capacità e integrazioni includere nella prima distribuzione?
- Quali componenti del vecchio Homun recuperare direttamente?
- Quali modelli superano prove concrete sui compiti scelti e sull'hardware supportato?
- Come presentare costo effettivo, stime, limiti e utilizzo locale?

## 9. Stato della discussione

È stato concordato l'orientamento a una UX semplice centrata sui collaboratori.
La sequenza dettagliata sopra è una proposta da discutere. Non è stato ancora
approvato un piano di implementazione del motore, un framework o un modello.
Questo documento preserva il contesto per riprendere il lavoro senza trattare
idee esplorative come decisioni già prese.

## 10. Affidabilità, formazione e revisione dei risultati

Gli indirizzi del 16 settembre sono raccolti in [Motore: affidabilità e formazione](MOTORE-AFFIDABILITA-E-FORMAZIONE.md).
L’agente può essere in formazione su alcune attività e autonomo su altre.
Il feedback umano deve alimentare esperienze riutilizzabili, con ambito e versioni
espliciti; approvare un risultato non concede automaticamente maggiore autonomia.
La revisione deve mostrare risultati eterogenei attraverso una struttura comune
con anteprime adatte al formato e apertura esterna quando necessaria.
Il documento distingue richieste confermate, proposte operative e scelte ancora aperte.
