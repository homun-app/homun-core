# Mac Apps Beta per macOS e comunicazione pubblica — Design

**Data:** 2026-07-21

**Stato:** design approvato in conversazione; specifica scritta in revisione utente

**Ambito:** integrazione progressiva di Host Computer Control nell'app Homun, lancio beta macOS Apple Silicon e comunicazione coerente sul sito

**Spec tecnica di riferimento:** `docs/superpowers/specs/2026-07-21-host-computer-control-design.md`

## Sintesi

Homun manterrà due superfici di esecuzione distinte:

- **Contained Computer** resta il computer Docker isolato per browser, shell e contenuti non fidati.
- **Mac Apps — Beta** permette a Homun di osservare o controllare applicazioni reali del Mac, ma soltanto dopo un opt-in generale, i permessi macOS e un'autorizzazione esplicita per la singola app.

Mac Apps sarà inclusa nella normale applicazione macOS, non in un installer separato. Sarà disponibile inizialmente soltanto su Apple Silicon, disattivata per impostazione predefinita e incapace di registrare tool agentici finché il beta opt-in non è attivo. Windows e Linux continueranno a mostrare e usare esclusivamente il Contained Computer.

La base tecnica già presente nel branch `fabio/host-computer-control` non verrà integrata come un unico blocco. Sarà riallineata alla versione corrente di `main`, verificata per confini funzionali e portata in tranche progressive. Il sito verrà aggiornato in un repository separato soltanto quando la build installata avrà superato i gate reali macOS.

## Decisioni approvate

1. Un solo pacchetto Homun per macOS: nessun installer beta separato.
2. Mac Apps è una funzione beta, visibile ma spenta per impostazione predefinita.
3. Il consenso è a strati: opt-in beta generale, permessi TCC di macOS e grant Homun per singola applicazione.
4. I grant distinguono **Observe** e **Control**.
5. Il manager delega a un worker isolato; non riceve direttamente i tool granulari né gli snapshot completi.
6. Password manager, login, autorizzazioni di sistema, campi sicuri e input nel Terminale host sono sempre bloccati.
7. L'input fisico dell'utente sospende immediatamente l'automazione.
8. Screenshot, alberi Accessibility e contenuti sensibili restano locali e bounded; il modello riceve solo una proiezione semantica redatta e riferimenti locali controllati.
9. La prima beta supporta esclusivamente macOS Apple Silicon.
10. Homepage, documentazione inglese e italiana e changelog comunicano la funzione insieme alla prima release realmente verificata.

## Obiettivi

- Rendere utilizzabile la capacità esistente senza indebolire il confine local-first e deny-by-default di Homun.
- Fare in modo che attivazione, autorizzazioni, stato e arresto siano comprensibili anche senza conoscenze tecniche.
- Evitare che il nuovo backend crei un secondo agent loop o un percorso privilegiato esterno alle policy canoniche.
- Integrare il branch esistente in modo revisionabile, mantenendo build e test verdi dopo ogni tranche.
- Pubblicare affermazioni sul sito soltanto quando corrispondono al comportamento della build firmata e installata.

## Non obiettivi della prima beta

- Supporto Intel, Universal Binary, Windows UI Automation o Linux AT-SPI.
- Controllo remoto del Mac o accesso da una sessione Homun diversa.
- Registrazione video continua o memoria visuale globale del desktop.
- Automazione di login, permessi macOS, credenziali, password manager, Terminale o shell host.
- Accesso indiscriminato a tutte le applicazioni dopo il solo opt-in generale.
- Routing di browser e shell dal Contained Computer alle app host.
- Telemetria cloud obbligatoria o invio di screenshot a un modello locale o a provider esterni.
- Promesse pubbliche di compatibilità con ogni applicazione macOS.

## Architettura approvata

```text
Chat e manager Homun
  -> use_computer(goal, app?)
      -> worker Mac Apps isolato
          -> policy, grant, approval, redazione e journal nel Rust Core
              -> helper macOS nativo firmato
                  -> Accessibility / ScreenCaptureKit / CGEvent
                      -> sola applicazione esplicitamente autorizzata
```

Il manager vede un solo ingresso di alto livello. I tool `computer_*` restano confinati al worker host-only. Il worker usa il loop canonico con budget e deadline propri e restituisce una sintesi compatta con provenance; snapshot voluminosi, tentativi intermedi e indici degli elementi non entrano nella conversazione principale.

L'helper Swift esegue primitive native ma non prende decisioni autonome. Grant, classificazione del rischio, approval, redazione e audit restano nel Rust Core. L'helper non espone porte di rete e comunica attraverso IPC locale autenticato.

Il Contained Computer resta separato e invariato:

```text
Browser e shell isolati
  -> sessione Docker
      -> CDP / noVNC / sandbox
```

## Stato e gating della beta

Mac Apps possiede una macchina a stati canonica per utente locale. Soltanto opt-in e grant persistono; gli stati operativi vengono ricostruiti live a ogni avvio:

```text
unsupported  piattaforma o architettura non supportata
disabled     disponibile ma opt-in generale spento
setup        opt-in acceso, permessi macOS incompleti
ready        permessi effettivi validi, nessuna sessione attiva
active       worker e app autorizzata in uso
paused       input utente, lock, revoca o stop ha sospeso la sessione
error        helper o protocollo non disponibile; fail-closed
```

Regole vincolanti:

- A beta disattivata, i tool e il worker Mac Apps non vengono registrati né suggeriti al modello.
- Attivare la beta non concede automaticamente Accessibility, Screen Recording o accesso ad alcuna app.
- I permessi sono considerati validi soltanto dopo una verifica live dell'helper; il click nelle Impostazioni di Sistema non basta.
- Disattivazione, logout dall'account Homun e factory reset cancellano lo stato operativo e fermano tutte le sessioni.
- Il factory reset elimina beta opt-in, grant, journal, socket e artifact effimeri. I record TCC gestiti da macOS vengono soltanto spiegati, non alterati silenziosamente.

## Flusso utente

### Attivazione

1. In `Settings → Computer`, l'utente vede due sezioni distinte: **Contained Computer** e **Mac Apps — Beta**.
2. L'utente attiva volontariamente Mac Apps.
3. Homun mostra lo stato di Accessibility e Screen Recording senza aprire prompt automatici.
4. Su azione esplicita, Homun apre la corretta sezione delle Impostazioni di Sistema.
5. Al ritorno nell'app, lo stato viene aggiornato automaticamente e riverificato dall'helper, senza richiedere un refresh manuale.

### Autorizzazione delle app

1. Homun elenca soltanto app eleggibili e ne risolve bundle identifier, path canonico e identità firmata.
2. L'utente sceglie una singola app e assegna **Observe** o **Control**.
3. **Observe** consente stato semantico e, quando necessario e consentito, screenshot della finestra autorizzata; non consente effetti.
4. **Control** include Observe e le azioni ammesse dalla policy. Gli effetti conseguenziali continuano a richiedere approval action-time.
5. Un cambio di path o identità firmata invalida il grant persistente.
6. La revoca ferma immediatamente le sessioni relative e invalida snapshot e riferimenti effimeri.

### Uso in chat

La card Computer indica sempre:

- superficie attiva: `Contained` oppure `Mac`;
- applicazione e finestra correnti;
- stato: osservazione, azione, attesa approvazione, pausa o errore;
- livello del grant utilizzato;
- comandi visibili `Pausa`, `Interrompi` e `Prendi controllo`;
- eventuale acquisizione di uno screenshot, sempre indicata come locale.

La UI usa la superficie piatta già adottata nel pannello Computer: separatori funzionali, nessuna cascata di contenitori e nessun gergo di protocollo nell'esperienza principale.

## Dati, privacy e memoria

L'helper produce uno stato locale composto da albero Accessibility bounded e, solo quando serve, screenshot della finestra target. Prima di raggiungere il modello, il Rust Core applica una proiezione semantica redatta.

Sono sempre esclusi:

- valori di `AXSecureTextField` e contenuti mascherati;
- password, token, chiavi, codici e credenziali riconoscibili;
- contenuti di app o finestre protette;
- porzioni non necessarie alla richiesta corrente;
- raw tree, coordinate globali e bytes dello screenshot dal journal e dalla memoria.

Gli screenshot restano artifact locali effimeri con quota e scadenza. Non diventano automaticamente allegati, memoria personale o memoria di progetto e, nella prima beta, i loro byte non vengono inviati né a un modello locale né a un provider cloud. Il modello riceve soltanto la proiezione semantica redatta e un riferimento locale non risolvibile dal provider. Se Accessibility non fornisce informazioni sufficienti, Homun chiede il takeover o termina il passo con una spiegazione: il fallback visuale verso un modello è rinviato a una valutazione futura separata.

Questa regola restringe intenzionalmente la spec tecnica di riferimento per il lancio beta: ogni percorso già predisposto per consegnare screenshot a un modello deve restare disabilitato.

Il journal locale conserva solo app canonica, finestra redatta, classe di azione, grant, approval, esito e timestamp. Serve per spiegare cosa è accaduto, non per ricostruire il contenuto dell'app.

## Sicurezza e comportamento in errore

- **Permesso mancante:** nessuna scorciatoia o retry nascosto; la UI spiega il permesso e offre l'apertura delle Impostazioni di Sistema.
- **App non autorizzata:** il worker non osserva né agisce e richiede un grant esplicito.
- **Target protetto:** hard deny prima dell'IPC, anche in presenza di grant o approval.
- **Operazione irreversibile o esterna:** approval immediatamente prima dell'effetto; la negazione non produce azioni residue.
- **Cambio app, finestra o focus:** l'azione viene annullata, lo snapshot invalidato e lo stato riacquisito; nessun replay automatico di una mutazione.
- **Input fisico:** la coda si ferma e la sessione entra in pausa; riparte soltanto dopo un gesto esplicito dell'utente.
- **Lock, sleep o cambio utente:** sospensione fail-closed e invalidazione di sessione, snapshot e focus.
- **Crash dell'helper:** un solo restart bounded; tutte le sessioni precedenti restano invalide.
- **Errore non recuperabile:** messaggio comprensibile in chat con causa e azione suggerita, senza esporre dettagli sensibili.
- **Stop globale:** disponibile durante ogni stato attivo e capace di interrompere l'intera superficie Mac Apps.

## Integrazione progressiva

Il branch esistente viene riallineato al `main` corrente e integrato in tranche ordinate. Ogni tranche deve poter essere revisionata e verificata senza dipendere dall'attivazione pubblica della successiva.

1. **Foundation e contratti:** crate Rust, protocollo IPC, framing, helper minimo e fixture.
2. **Osservazione nativa:** permessi, inventario app/finestre, snapshot semantic-first, screenshot e redazione.
3. **Azioni e sicurezza:** azioni atomiche, grant Observe/Control, policy, protected targets, approval e takeover.
4. **Agent loop e stato:** worker isolato, `use_computer`, journal, Local Computer Session e gateway API.
5. **Prodotto beta:** opt-in generale, UI Settings/chat, stato reattivo, revoca, stop e factory reset.
6. **Distribuzione:** helper annidato firmato, hardened runtime, notarizzazione, verifica del package e architettura arm64.
7. **Sito e lancio:** homepage, guide EN/IT e changelog dopo il superamento dei gate installati.

Il merge non deve trascinare modifiche estranee presenti in altri checkout. Dopo il riallineamento, i commit possono essere ricostruiti o raggruppati per questi confini se ciò rende la revisione più affidabile; non è richiesto preservare la forma storica dei trenta commit del branch.

## Sito e documentazione

Il repository del sito mantiene grafica, componenti, tipografia e struttura attuali.

### Homepage

La sezione oggi dedicata a `The local computer` chiarisce che Homun offre due superfici complementari:

- **Contained Computer:** Docker isolato con browser e shell, disponibile sulle piattaforme già supportate.
- **Mac Apps — Beta:** applicazioni reali autorizzate singolarmente, solo macOS Apple Silicon, disattivata di default.

Il testo non userà promesse come “controlla tutto il Mac”. La promessa pubblica è: “Homun può osservare o utilizzare soltanto le app che autorizzi”. Il link principale conduce alla guida dedicata.

### Guide inglese e italiana

La guida `local-computer` resta la fonte per il Contained Computer. Una nuova guida dedicata a Mac Apps Beta spiega:

- requisiti e disponibilità;
- attivazione e disattivazione;
- Accessibility e Screen Recording;
- differenza tra Observe e Control;
- approval, takeover, stop e revoca;
- app e superfici sempre escluse;
- dati semantici che possono raggiungere un modello locale o cloud e screenshot che restano locali;
- risoluzione degli errori comuni;
- limiti della prima beta.

La versione italiana è equivalente nei contenuti e non una sintesi ridotta.

### Changelog

La prima release beta dichiara:

- macOS Apple Silicon only;
- funzione inclusa ma spenta per impostazione predefinita;
- permessi macOS e grant per singola app;
- principali protezioni e limiti;
- collegamento alla guida;
- distinzione esplicita dal Contained Computer.

Il sito non viene pubblicato prima della disponibilità della release corrispondente, per evitare una promessa non ancora scaricabile.

## Strategia di test

### Gate automatici

- tutti i test del crate host-computer;
- contratti del worker isolato e regressione dell'engine;
- test gateway per stato, grant, policy, revoca e journal;
- test Swift per protocollo, Accessibility, screenshot, target protetti e takeover;
- test desktop per opt-in, aggiornamento reattivo, packaging, firma e factory reset;
- UI contract, typecheck, build e `git diff --check` sui file toccati;
- verifica che beta disattivata significhi tool non registrati, non soltanto UI nascosta.

### Gate visuali

La pagina `Settings → Computer` e la card Chat Computer vengono controllate nella vera app a 1280×800, 1440×900 e 1728×1117, con:

- piattaforma non supportata;
- beta spenta;
- permessi incompleti;
- helper pronto;
- nessun grant, grant Observe e grant Control;
- sessione attiva, pausa per takeover ed errore.

Non sono ammessi clipping orizzontali, controlli sovrapposti, contenitori annidati superflui o stati che richiedono refresh manuale.

### Gate fisici macOS

Su un workspace usa-e-getta e una build installata:

1. concedere e revocare realmente Accessibility e Screen Recording;
2. osservare almeno una app AppKit e una SwiftUI;
3. eseguire un'azione reversibile su almeno tre app differenti, inclusi un browser e un editor;
4. negare e approvare un effetto conseguenziale verificando esecuzione singola;
5. prendere il controllo con mouse e trackpad reali durante un'azione;
6. cambiare finestra, chiudere l'app e riavviare l'helper;
7. verificare hard deny su password manager, autenticazione e Terminale;
8. revocare un grant durante la sessione;
9. eseguire logout dall'account Homun, disattivazione beta e factory reset;
10. aggiornare dalla versione precedente e verificare stato e compatibilità.

### Gate della release firmata

La build arm64 candidata deve essere firmata, notarizzata e installata. L'helper annidato deve avere Team ID coerente, hardened runtime, entitlements ammessi, ticket notarile e handshake autenticato. Un gate non eseguibile per credenziali o ambiente viene dichiarato **non verificato**, mai verde.

### Gate del sito

- build e link check del sito;
- route EN/IT raggiungibili dalla homepage e dalla navigazione docs;
- contenuti equivalenti e requisiti coerenti con la release;
- controllo responsive e visuale sulle larghezze già usate dal sito;
- nessuna dichiarazione di disponibilità su Intel, Windows o Linux.

## Criteri di accettazione della beta

La beta può essere pubblicata soltanto quando:

1. è inclusa nella normale app macOS arm64 e resta spenta dopo installazione pulita o factory reset;
2. nessun tool Mac Apps è disponibile al modello prima dell'opt-in;
3. permessi macOS, grant per-app e approval action-time sono confini distinti e verificati;
4. Observe non può produrre effetti e Control non può superare hard deny o approval;
5. revoca, stop, input fisico, lock e disattivazione lasciano zero azioni residue;
6. raw snapshot, secure field e byte degli screenshot non raggiungono modello, chat, journal o memoria;
7. l'agent loop canonico delega al worker isolato senza esporre tool granulari al manager;
8. il Contained Computer continua a funzionare senza regressioni;
9. firma, notarizzazione, aggiornamento e factory reset passano sulla build installata;
10. i test TCC reali e almeno tre app reali passano su Apple Silicon;
11. UI e messaggi d'errore sono verificati visivamente e non richiedono refresh manuale;
12. homepage, guide EN/IT e changelog descrivono esattamente la capacità verificata.

## Ordine di pubblicazione

1. Integrare e verificare il codice in un branch aggiornato.
2. Produrre una release candidate macOS arm64 firmata e notarizzata.
3. Completare i gate fisici e visuali sull'app installata.
4. Integrare e verificare il sito senza pubblicarlo anticipatamente.
5. Pubblicare la release desktop.
6. Pubblicare immediatamente il sito e il changelog coordinati.
7. Verificare download, updater, guida EN/IT e claim homepage dalla versione pubblica.

Il fallimento di un gate Mac Apps blocca la funzione beta o la release che la dichiara; non deve compromettere la disponibilità del Contained Computer.
