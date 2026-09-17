# Homun conversazionale — copertura funzionale

> Inventario storico, aggiornato per successive iterazioni. Per lo stato della consegna, il salvataggio locale e le verifiche attuali vedere [Prototipo conversazionale — consegna v1](27-prototipo-conversazionale-consegna.md). Le limitazioni descritte nelle prime sezioni possono essere state superate.

Direzione confermata da Fabio il 17 settembre 2026: mantenere la nuova UX conversazionale e prevedere tutte le capacità della versione Studio precedente. Questo documento è un inventario del codice e una proposta di collocazione, non una certificazione di funzionamento né di prontezza del motore.

## Regola di prodotto
Chat per chiedere, chiarire e decidere. Pannello destro per stato attuale e azione successiva. Raccolte e ricerca per ritrovare. Il dettaglio viene aperto quando serve; una capacità avanzata non viene eliminata perché la schermata iniziale è minimale.

La nuova bozza è ancora un esperimento separato con dati in memoria. Non ha ancora la parità funzionale della versione precedente. La versione precedente resta disponibile come riferimento.

## Inventario e collocazione
| Capacità presente o rappresentata nello Studio | Copertura della nuova bozza | Collocazione prevista |
| --- | --- | --- |
| Creazione e personalizzazione agente, ruolo, curriculum, competenze e tono | Collaboratori dimostrativi fissi; profilo sintetico | Creazione in chat, scheda riutilizzabile di agente con dettagli modificabili |
| Persone reali, inviti e ruoli | Persone dimostrative nel team | Invito proposto in chat; identità e accessi in scheda/impostazioni |
| Team, coordinatore, assegnazioni, filtri, drag and drop | Team e coordinatore; niente trascinamento o gestione completa membri salvati | Conversazione di team, membri nel pannello, selettore condiviso e ricercabile |
| Progetti, obiettivi, squadra, responsabilità | Collegamento team/progetto/lavori basilare | Conversazione di progetto, contesto e attività nel pannello |
| Compiti, scadenze, priorità, modifiche e assegnazioni | Tre percorsi guidati, scadenza semplice | Proposta di lavoro unica e modificabile, chat del compito |
| Dashboard oggi, calendario, Kanban trascinabile | Assenti nella nuova versione | Viste del lavoro apribili nello spazio destro/ampio, stesso stato della chat |
| Dipendenze, contributi, solleciti tra persone e agenti | Contributo locale a un lavoro, senza grafo tra lavori | Richiesta assegnata, notifica e consegna; chiusura della sola dipendenza pertinente |
| Conversazioni, allegati e riferimenti a compiti/progetti | Chat e allegati; note team/progetto; riferimenti limitati | Composer comune, menzioni selezionabili, contesto esplicito e filtri |
| Raccolta di file, cartelle, note e collegamenti multiprogetto | Allegati per lavoro e ricerca nomi; raccolta assente | Materiali nel contesto e raccolta globale unica, niente duplicati per progetto |
| Permessi di risorse, progetti e strumenti | Assenti; spazio demo unico | Accessi nella scheda, riepilogo prima della condivisione; ricerca filtrata dagli accessi |
| Risultati, fonti, anteprime, versioni, feedback e approvazione | Anteprime testuali simulate e annotazioni di revisione | Risultato apribile nel pannello, visualizzatori per tipo; conferma distinta dall'invio |
| Formazione per attività, supervisore e autonomia selettiva | Etichetta fissa “in formazione” | Politica per compito/attività, spiegabile e modificabile dalla scheda |
| Automazioni manuali, orari, giorni, intervalli e trigger evento | Quattro frequenze predefinite e avvio simulato | Creazione dalla chat o dal lavoro; dettagli temporali/trigger quando necessari |
| Pipeline, passaggi, responsabili, blocchi, prova e storico | Solo copia di scenario per simulare un'esecuzione | Piano generato in chat; mappa visiva opzionale; esecuzioni distinte e tracciate |
| Plugin/marketplace, configurazione, abilitazione per agente e permessi | Assente | Collegamento proposto nel momento del bisogno; raccolta plugin e scheda connessione |
| Modelli locali/remoti, preferenze per agente e scelta/escalation | Nessuna configurazione reale | Impostazioni e scheda agente; decisioni del motore ancora da completare |
| Costi per agente/lavoro, stime, budget e limiti | €0 demo, nessuna contabilità | Indicatore discreto; stima/limite prima del lavoro; dettaglio in impostazioni |
| Notifiche, elementi da verificare, attese | Badge da gestire per contributi e risultati | Centro attenzione condiviso tra chat e altre viste, apertura diretta dell'azione |
| Impostazioni generali, dati/connessioni, notifiche, persone/accessi | Solo informazioni sulla demo | Accesso dal profilo, categorie dedicate senza ingombrare la chat |
| Ricerca globale | Ricerca testuale di oggetti e messaggi della nuova bozza | Cmd/Ctrl-K; accesso al contesto esatto; comprensione semantica solo col motore |

Riferimenti principali: StudioWorkbench, StudioSettings, StudioAccess, StudioTraining, StudioSchedule, StudioDocuments, StudioMarketplace, StudioProcedures, StudioAutomationCanvas, StudioMemberPicker, StudioConversation, StudioContribution e lib/studio-pipelines. Nuova bozza: ConversationWorkspace, ConversationSpace, ConversationSearch.

## Ordine di completamento
1. **Oggetti e componenti comuni**: persone/agenti, team, progetti, lavori, messaggi, materiali, richieste, risultati. Un'unica fonte dello stato; selettori e schede riutilizzati.
2. **Lavoro quotidiano completo**: riferimenti in chat, compiti modificabili, contributi/dipendenze, notifiche, risultati e viste calendario/Kanban.
3. **Condivisione e strumenti**: raccolta unica, accessi, clienti/utenti esterni, plugin e connessioni.
4. **Delega affidabile**: formazione per attività, supervisione, pipeline e trigger completi, esecuzioni e gestione degli errori.
5. **Controllo operativo**: modelli, budget/costi, notifiche e dati. La specifica dei modelli può evolvere, il punto di accesso UX deve esserci.

## Criterio di accettazione per ogni capacità
Non basta che ci sia un pulsante. Verificare: avvio dalla chat; proposta comprensibile; modifica senza perdere contesto; stato e responsabile chiari; gestione di dati mancanti/errori; risultato ritrovabile; coerenza fra chat, pannello, raccolte e ricerca; permessi non ampliati implicitamente. Includere un caso con molti elementi e uno con un contributo umano.

Non riprodurre meccanicamente ogni schermata o avviso dello Studio: preservare la capacità e sostituire i passaggi inutili con un'interazione coerente. Le fixture catalogo/log/ricerca non devono limitare il modello del prodotto a tre settori.

## Primo incremento: gestione e profili — 17 settembre 2026

Implementato nella nuova versione:
- modifica e cancellazione di team, progetti e ricorrenze; annullamento senza salvataggio;
- modifica membri e coordinatore, scioglimento team con scollegamento dei progetti;
- eliminazione progetto con conservazione delle conversazioni senza progetto;
- curriculum modificabile, ruolo, specializzazioni e tono degli agenti;
- ricerca collaboratori per ruolo e competenze, indicizzazione nella ricerca globale;
- scheda membro da sidebar, elenco e membri del team;
- assegnazione/rimozione di plugin da un catalogo dimostrativo, con stato connessione da configurare.

Verifiche browser: creazione e modifica team, rimozione membro, cambio coordinatore; modifica curriculum e ricerca per nuova specializzazione; assegnazione Trello; annullamento modifica progetto; eliminazione team e progetto senza perdere lavoro; modifica automazione in pausa e cancellazione preservando il lavoro di origine. Controllo visivo a 1280×720. TypeScript e build passano; lint senza errori, un avviso fast-refresh sul file che esporta anche spacePeople.

Non ancora coperti: creazione/invito/eliminazione definitiva identità, curriculum integrato in ogni picker, marketplace e credenziali, permessi effettivi e autonomia per attività. Le modifiche sono in memoria e si perdono al ricaricamento. I plugin non accedono a dati esterni.

## Secondo incremento: Plugin ed eliminazione agenti

Sezione Plugin nella sidebar: catalogo ricercabile, aggiunta e rimozione dallo spazio, assegnazioni sincronizzate con i profili. Ricerca guidata anche dal composer. Catalogo dimostrativo, connessioni effettive non implementate.

Elimina agente dalla scheda con conferma: rimozione da elenco, riferimenti, selezioni e team; coordinamento lasciato da assegnare; plugin scollegati; ricorrenze dell’agente in pausa. Conversazioni conservate e nuove esecuzioni bloccate. Non si tratta di cancellazione dei messaggi storici.

Verificati nel browser: assegnazione e rimozione plugin sincronizzate, annullamento eliminazione agente, eliminazione con storico conservato e ricorrenza in pausa, team con nuovo coordinatore da scegliere, assenza dell’agente eliminato nel picker plugin. Controllo visivo del marketplace. TypeScript e build completati.

## Terzo incremento: compiti e raccolta materiali

Compiti: elenco, Kanban e calendario mensile condividono i lavori della chat. Scadenze modificabili, ricerca per lavoro/collaboratore/progetto e apertura della conversazione sulla sua prossima azione. Trascinamento supportato per revisione→approvato e approvato→revisione; altre transizioni richiedono contributo o risultato nella conversazione. Nessuna esecuzione esterna viene generata da un cambio stato.

Materiali: importazione file/cartelle con percorsi, note creabili e modificabili, scaricamento, rimozione, collegamento a più progetti e a lavori. Allegati delle chat nella medesima raccolta, riferimenti alle note nel pannello lavoro, ricerca globale. Identità degli allegati stabili anche rimuovendo altri file. Associazioni ai progetti organizzative, non autorizzazioni. Mancano ancora ACL, cartelle vuote, anteprime multiformato e sincronizzazione.

Browser: scadenza e calendario, nota collegata alla conversazione, import cartella, allegato riutilizzato senza duplicato, risultato simulato e approvazione mediante trascinamento, transizione non valida bloccata, modifica nota, associazione a due progetti, rimozione senza perdere il riferimento al materiale restante. Controllo visivo 1280×720; risolto overflow pagina, profilo sidebar fisso e azioni compatte. TypeScript/build passano; lint senza errori.

La parità non è completa: restano prioritarie creazione membri, accessi, formazione per attività, pipeline/eventi, costi/modelli e settings. I lavori sono ancora i tre scenari guidati e i dati durano solo nella sessione.

## Quarto incremento: nuovo agente e incarico libero

Da Squadra → Crea collaboratore, oppure dalla chat iniziale con “crea un agente”, descrizione conservata nel curriculum e scheda confermabile con nome, ruolo, specializzazioni, tono. Nomi duplicati bloccati. Il nuovo agente compare in ricerca, team, selezioni plugin e sidebar; utilizza la stessa scheda, modifica ed eliminazione.

Dalla scheda → Affida un lavoro: richiesta libera, allegati, contributo, consegna dimostrativa, revisione e approvazione. Anche @nome nella chat iniziale crea un incarico libero. Il testo è conservato, non interpretato da un modello: piano generico e consegna dichiaratamente dimostrativa. Non dimostra ragionamento, sufficienza dei materiali o esecuzione del compito.

Browser: Nora per acquisti, richiesta libera confronto offerte per 20 computer, contributo e arrivo risultato simulato; prova distinta su nome duplicato, assegnazione plugin sincronizzata e inserimento in team. Controllo visivo primo incarico. TypeScript/build passano, lint senza errori. Invito delle persone e controllo autonomia per attività restano da portare.

## Quinto incremento: persone e inviti dimostrativi

Crea collaboratore distingue Agente AI e Invita una persona. Nome, email validata, ruolo e curriculum; nome ed email già in uso bloccati. Invito pendente, accettazione simulata e revoca/rimozione. Le persone pendenti non sono selezionabili nei nuovi team; una volta accettate partecipano a team misti e possono coordinare. Profili umani distinti dagli agenti, senza autonomia/plugin AI. Nessuna email inviata, nessun account creato e nessuna autorizzazione server applicata.

Browser: invito Paolo, blocco selezione prima dell’accettazione, accettazione, team con Marta e Paolo coordinatore, validazione email e revoca. TypeScript e build passano. Le chat tra utenti e l’assegnazione di incarichi a persone restano da collegare; le menzioni manuali di persone nella chat generale esplicitano questo limite invece di assegnare silenziosamente a un agente.

## Sesto incremento: incarichi e conversazioni delle persone

Scheda persona attiva → Affida un lavoro, richiesta libera, scadenza e assegnazione esplicita. In alto, Vista demo permette di impersonare i membri umani per provare le richieste personali: destinatario riceve Nuovo incarico, richiedente riceve Verifica il risultato dopo consegna.

Chat umana con autore esplicito e allegati; nessuna risposta automatica attribuita alla persona. Consegna esplicita dell’ultimo testo scritto dal destinatario, richiesta di revisione, nuova consegna e approvazione del richiedente. Il risultato è il testo realmente inserito nella demo, non un artefatto AI preconfezionato. Controlli di consegna/verifica distinti per attore; bacheca richiede il richiedente per la verifica dei lavori umani.

Browser: Fabio assegna a Giulia; vista Giulia e notifica, messaggio/consegna, vista Fabio e notifica, revisione, blocco reinvio del vecchio testo, nuova consegna, approvazione e notifica rimossa. Controllo visivo. TypeScript, lint e build passano.

Limiti: cambio utente di simulazione, non login o autorizzazione; raccolta e navigazione ancora condivise nella demo. Nessun invio reale. Mancano controllo accessi completo, richieste strutturate di contributo tra più persone, versioni degli allegati e persistenza. Il limite delle chat/incarichi umani indicato nell’incremento precedente è superato da questo percorso.

## Incremento 7 — Supervisione per incarico

Ogni lavoro di un agente distingue risultato da verificare e consegna autonoma. Il richiedente sceglie un supervisore umano attivo; le notifiche di revisione seguono quel destinatario. Approvazione nel pannello e spostamento in bacheca verificano la vista utente demo. Le consegne autonome riportano «Consegnato», senza attribuire approvazioni umane. Cambiare modalità su una bozza già in revisione non la approva automaticamente. Nessun cambiamento globale all'agente, apprendimento o permesso esterno è implicato.

Verificato nel browser: Fabio assegna a Marta con Giulia supervisore; Fabio non può approvare, Giulia riceve la notifica e approva; un secondo incarico autonomo termina come consegnato, senza pulsante di approvazione. TypeScript, lint e build del prototipo passano. Restano simulazioni in memoria: autorizzazioni reali, formazione per categoria di compito e supervisori agenti sono ancora da realizzare.

## Incremento 8 — Incarichi liberi dal progetto

La chat di un progetto selezionato crea incarichi liberi per agenti o persone tramite @nome, sostituendo i tre pulsanti di esempio. Senza un unico destinatario valido conserva testo e allegati e mostra una scelta ricercabile per nome, ruolo e specializzazioni. Il progetto viene associato al lavoro; file e note già collegati al progetto vengono referenziati nei nuovi incarichi, senza duplicare i file. Le conversazioni umane espongono anche il ritorno al progetto e le note collegate.

Verificato nel browser: richiesta senza destinatario e ricerca per ruolo, creazione incarico Marta e ritorno al progetto; nota associata al progetto, incarico via @Giulia, nota disponibile nella conversazione e lavoro elencato nel progetto. Controllo visivo; TypeScript/build passano, lint senza errori (avviso fast-refresh preesistente). Nessun modello interpreta la richiesta; collegamenti organizzativi della demo, non permessi. L'inclusione materiali avviene alla creazione, non sincronizza automaticamente i lavori esistenti.

## Incremento 9 — Esecuzioni e risultati delle ricorrenze

Ogni prova di una ricorrenza crea un incarico distinto numerato, con data, collegamento all'automazione, progetto, materiali, contributo iniziale e supervisione ereditati dal lavoro di origine. Non eredita vecchie scadenze, risultati o approvazioni. L'automazione espone lo storico con stato e apertura diretta della conversazione. Pausa e collaboratore non disponibile bloccano nuove prove.

Le notifiche includono i risultati conclusi destinati al richiedente, distinguendo consegna autonoma e approvazione umana. Aprire il risultato lo segna come letto per la vista utente corrente; la richiesta di verifica resta distinta. I messaggi indicano l'autore quando registrato.

Verifiche browser: ricorrenza supervisionata da Giulia, approvazione negata a Fabio, approvazione Giulia e notifica risultato Fabio; ricorrenza autonoma, apertura dalla notifica, storico con due esecuzioni indipendenti e pausa che disabilita la prova. Controllo visivo 1280×720. TypeScript e build passano, lint senza errori (avviso fast-refresh preesistente). Non sono implementati timer, eventi esterni, esecuzione AI o persistenza. I materiali ereditati sono quelli del lavoro di origine al momento della prova.

## Incremento 10 — Richieste di contributo

Richiesta visibile nel lavoro con destinatario e contenuto necessario. Le richieste iniziali senza materiali sono assegnate al richiedente e riassegnabili; dal lavoro pronto si può chiedere un ulteriore contributo. Notifiche personali e stato «Aspetta Nome» identificano il blocco. Il destinatario può consegnare testo/link, allegati, cartelle o riferimenti dalla raccolta; consegna e autore vengono registrati in chat. La consegna chiude la richiesta e riporta il lavoro a pronto, senza valutare semanticamente il contenuto.

Per un destinatario agente viene creato un incarico collegato. Il lavoro principale riprende quando il contributo raggiunge lo stato concluso (con revisione se prevista); il risultato rimane apribile dalla richiesta risolta. Nessuna esecuzione AI automatica è simulata come reale.

Browser: richiesta iniziale riassegnata da Fabio a Giulia, notifica personale e risposta in chat; contributo richiesto a Elio, completamento supervisionato, ripresa del lavoro Marta e link risultato; caricamento file e successivo riutilizzo dalla raccolta senza duplicato. Controllo visivo, TypeScript, lint e build passano. Limiti: una richiesta pendente per lavoro; solleciti, scadenze della richiesta, richieste parallele e verifica semantica del contributo restano da completare. Autorizzazioni simulate nella vista utente, nessun invio esterno.

## Incremento 11 — Catalogo plugin condiviso in overlay

Un solo componente ConversationPluginCatalog, aperto dalla sezione Plugin o dal profilo agente, con ricerca per nome/attività, categorie e filtro origine Composio/MCP/Skill/Aziendale. Dodici voci illustrative con metadati; non rappresentano connettori operativi o disponibilità verificata nei provider. Aggiunta multipla senza chiudere, stato aggiunto/collegato, destinazione esplicita e sincronizzazione profilo/spazio. La pagina Plugin elenca gli strumenti aggiunti; la scoperta avviene nell'overlay condiviso. Dialog modale nativo, focus iniziale sulla ricerca, Esc e ripristino focus, lista scorrevole e layout responsivo.

Browser: filtro MCP + Dati e file, ricerca Cartelle locali, aggiunta allo spazio; profilo Marta, filtro Skill, collegamento Revisione documenti, ricerca vuota e reset, Escape, conferma assegnazione sincronizzata nella pagina Plugin. Screenshot controllato a 1280×720. TypeScript, lint e build passano. Import di endpoint/pacchetti privati, credenziali, autorizzazioni e cataloghi remoti restano da implementare nel motore.

## Piano modificabile per passaggi — 17 settembre 2026

Il caso guidato catalogo con Marta, controllo prezzi Vera e approvazione umana ora usa una lista di passaggi identificati, con responsabile, risultato simulato e compito collegato. Il piano appare subito sotto il titolo, con progressione e approvazione finale. Si possono inserire, rinominare, riassegnare, eliminare e riordinare i passaggi futuri con frecce o trascinamento. I passaggi conclusi mantengono risultato e storico.

Il selettore collaboratori è quello condiviso (avatar, ruolo, competenze, scheda). La creazione inline richiede nome e specializzazione, seleziona il nuovo agente e lo aggiunge alla squadra. Nessun motore o provisioning reale.

Chat dimostrativa: «Aggiungi Cercare immagini dopo Preparare la bozza con @Vera» e «Sposta Preparare la bozza prima di Controllare i prezzi» producono una proposta con Applica/Annulla. Il riconoscimento è limitato a queste forme, non è interpretazione AI generale. Altri scenari conservano il comportamento precedente; il nuovo editor è attualmente collegato al caso coordinato catalogo.

Verifiche browser: creazione inline traduttore, inserimento e riordino manuale; aggiunta e riordino via chat; modifica durante esecuzione dopo un passaggio concluso; quattro passaggi simulati e approvazione; trascinamento. Controllo finale senza errori console. TypeScript, lint dei componenti modificati e build prototype superati. Stato solo nella sessione; nessuna esecuzione esterna.

### Estensione del piano ai nuovi incarichi degli agenti

Il piano viene ora inizializzato anche negli esempi ricerca/log e negli incarichi liberi; il caso Marta/Vera mantiene i suoi responsabili specifici. La richiesta iniziale usa titolo e istruzioni dello scenario e accetta testo, link o allegati. Le indicazioni scritte nella chat prima dell'avvio vengono conservate come contributo iniziale. La demo verifica solo la presenza del contributo, non la sua sufficienza. I sotto-passaggi coordinati non generano notifiche autonome di attesa/consegna: il lavoro principale resta il riferimento.

Verificati nel browser: ricerca con brief testuale fino ad approvazione, log con allegato e primo passaggio, incarico libero con contributo in chat; typecheck, lint e build superati. L'esecuzione ricorrente e gli incarichi umani conservano il flusso precedente. Nessuna persistenza o interpretazione AI reale.

### Seguito del lavoro nella conversazione

La demo permette ora di simulare una domanda durante un passaggio. La richiesta compare in chat, blocca il proseguimento, notifica il destinatario e accetta la risposta dal compositore oppure dal componente contributo. Il piano segnala l'attesa; la risposta chiude la richiesta e consente la ripresa.

I risultati dei passaggi sono apribili in riquadri nella chat. La consegna finale offre Apri risultato e Approva bozza nella conversazione. Una richiesta di revisione testuale in fase di verifica aggiunge un passaggio futuro e incrementa la versione, mantenendo lo storico concluso. Le forme esplicite Aggiungi/Sposta continuano a proporre modifiche da applicare al piano.

Sidebar: i sotto-compiti coordinati sono raggiungibili dai risultati dei passaggi e dalla raccolta Compiti, ma non appaiono come conversazioni autonome nelle sezioni progetti/senza progetto.

Verifica browser: catalogo, avvio con indicazioni, domanda sulla lingua, risposta in chat, tre passaggi, apertura della consegna, revisione aggiuntiva, nuova anteprima e approvazione (5/5). Una sola conversazione in sidebar. Nessun errore console; typecheck, lint componenti e build prototype superati. Risposte, risultati e correzioni restano dimostrativi, non elaborazioni AI reali.

### Piani nelle esecuzioni ricorrenti

Ogni esecuzione simulata ricrea il piano del lavoro di origine con nuovi identificatori di passaggi e sotto-compiti, zero completamenti e nessun risultato/approvazione ereditato. Riprende materiali, contesto e responsabili. Passaggi privi di un collaboratore disponibile impediscono l'avvio con spiegazione. Se mancano informazioni, la nuova esecuzione contiene una richiesta al richiedente, risolvibile in chat. I sotto-compiti non sono proposti come lavori da ripetere nel selettore delle automazioni.

Verifiche browser: due esecuzioni dello stesso catalogo con avanzamenti indipendenti e origine ancora approvata; ricerca ricorrente priva di brief, risposta in chat e ripresa del primo passaggio. Typecheck, lint e build superati. La pianificazione resta simulata e manuale, senza scheduler o modello collegato.

### Demo popolata e accesso diretto al contesto

Aprire `prototypes/conversations.html?work-demo=busy` per 18 lavori su tre progetti, con bozze, attività in corso, richieste, revisioni, consegne approvate e tre ricorrenze. Il parametro mantiene separata la demo dal normale avvio vuoto. Ogni lavoro ha una cronologia dimostrativa e una consegna intitolata al proprio incarico.

Compiti offre Tutti/Richiede te/In corso/Risultati. Le schede aprono la conversazione; il pulsante dettagli mantiene accessibili le azioni esistenti. Le richieste e le consegne ricevono scroll e focus quando aperte; i risultati di ricerca messaggi portano al messaggio esatto, senza timeout concorrenti.

Verifiche: 18 schede, 6 interventi richiesti, 6 risultati; apertura richiesta e consegna da Compiti, richiesta da notifiche e messaggio specifico da ricerca; controllo della consegna del catalogo inglese. Ultima prova senza errori console. Typecheck, lint e build superati. Fixture locale, nessuna persistenza o attività reale.
