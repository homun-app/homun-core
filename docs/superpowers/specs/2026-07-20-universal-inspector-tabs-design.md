# Design — Workspace laterale universale a schede

Data: 2026-07-20. Stato: **approvato a livello di design**.

## Decisione

La visualizzazione laterale di Homun diventa un vero workspace strutturale, non più un
pannello flottante sovrapposto alla conversazione. Quando è aperto, il contenuto centrale
si divide inizialmente in due aree bilanciate: conversazione a sinistra e workspace a
destra.

Il workspace usa schede cliccabili, chiudibili e riordinabili. File, artefatti e viste
operative condividono lo stesso contenitore, ma mantengono contenuto, stato e azioni
specifici. La larghezza scelta dall'utente è globale; schede, ordine e selezione sono
isolate per singola attività.

Le decisioni approvate sono:

- divisione iniziale 50/50;
- ridimensionamento tramite un separatore reale tra le colonne;
- larghezza ricordata globalmente per tutte le viste;
- schede ricordate separatamente per ogni attività;
- apertura senza duplicati della stessa risorsa;
- selezione, chiusura e riordinamento delle schede;
- chiusura del workspace come operazione di nascondimento, non di distruzione;
- modalità focus esplicita, che usa tutta l'area centrale senza chiudere le schede;
- passaggio a una vista singola su finestre strette;
- isolamento e autorizzazione rivalidati durante il ripristino delle schede.

## Problema corrente

Il `Workbench` attuale è un elemento `position: absolute` con larghezza predefinita di
circa 520 px. La conversazione simula il docking aggiungendo spazio a destra, ma il pannello
non partecipa realmente al layout.

Questo genera quattro problemi:

1. la conversazione e il pannello possono risultare compressi o sovrapposti;
2. l'anteprima degli artefatti contiene un'ulteriore griglia interna con elenco laterale,
   sottraendo altro spazio al documento;
3. la larghezza non viene conservata;
4. ogni vista si comporta come un pannello isolato, anziché come parte di un workspace
   coerente.

Il riferimento osservato in Codex/ChatGPT usa invece un pannello di dettaglio persistente
come fratello della conversazione, con separatore, tab strip e adattamento interno basato
sulla larghezza disponibile.

## Obiettivi

1. Rendere leggibili file e artefatti senza sovrapposizioni o colonne annidate permanenti.
2. Consentire di lavorare su più risorse senza perdere quelle già aperte.
3. Dare a tutte le viste laterali un unico comportamento prevedibile.
4. Preservare isolamento tra attività e progetti.
5. Conservare i componenti e i flussi dati esistenti, limitando la modifica al contenitore
   e allo stato di presentazione.
6. Supportare mouse, trackpad e tastiera.
7. Rendere il contenitore estendibile a nuove viste senza dover ricostruire il layout.

## Non obiettivi

- Nessun nuovo editor di file o artefatti.
- Nessuna modifica alla memoria, ai permessi o ai formati dei dati.
- Nessuna condivisione delle schede tra attività differenti.
- Nessuna scheda temporanea che sostituisce implicitamente quella precedente.
- Nessun browser incorporato nuovo in questa slice: un browser esistente o futuro potrà
  usare lo stesso contratto di scheda.
- Nessuna sincronizzazione cloud dello stato del workspace.

## Architettura del layout

### Colonne reali

Con il workspace aperto, `active-task-layout` usa due colonne reali:

```text
┌─────────────────────────────┬─┬─────────────────────────────┐
│ conversazione               │↔│ workspace a schede          │
│ topbar + messaggi + composer│ │ tab strip + contenuto attivo│
└─────────────────────────────┴─┴─────────────────────────────┘
```

La colonna della conversazione contiene topbar, thread e composer. Il workspace occupa
l'intera altezza utile e possiede una propria tab strip. Il separatore è parte del layout,
non una maniglia sospesa sopra il contenuto.

La geometria consigliata è:

- rapporto iniziale: `0.5` dello spazio disponibile;
- larghezza minima conversazione: 420 px;
- larghezza minima workspace: 420 px;
- larghezza massima workspace: spazio disponibile meno la larghezza minima della chat;
- persistenza del rapporto, con clamp ai limiti correnti quando la finestra cambia.

Il rapporto è preferito ai pixel assoluti perché mantiene una proporzione utile passando
da una finestra a un'altra. La preferenza è globale e può essere salvata con una chiave
versionata come `homun.inspector.width-ratio.v1`.

### Relazione con la Working Island

L'attuale Working Island non deve creare una terza colonna. Quando il workspace è aperto,
l'isola viene nascosta. Fonti, attività, piano, subagenti e sessione computer possono essere
aperte come viste del workspace, riusando i loro dati e componenti attuali.

Quando il workspace è chiuso, l'isola può continuare a fornire il riepilogo compatto
esistente. Aprire una sua sezione porta alla corrispondente scheda senza duplicarla.

## Modello delle schede

Lo stato viene governato da un reducer con operazioni esplicite, evitando combinazioni di
booleani indipendenti.

```ts
type InspectorTabKind =
  | "file"
  | "artifact"
  | "memory"
  | "graph"
  | "sources"
  | "goals"
  | "activity"
  | "plan"
  | "execution"
  | "subagents"
  | "computer";

type InspectorTab = {
  id: string;
  kind: InspectorTabKind;
  resourceKey: string;
  title: string;
  projectId?: string;
  workspaceId?: string;
  payload: Record<string, string>;
};

type InspectorWorkspaceState = {
  open: boolean;
  focused: boolean;
  activeTabId: string | null;
  tabs: InspectorTab[];
};
```

`resourceKey` è la chiave di deduplicazione. Un file usa il suo identificatore canonico o
percorso normalizzato; un artefatto il proprio id; una vista singleton una chiave stabile
come `activity:<threadId>`.

Il reducer espone almeno:

- `openTab(descriptor)`: seleziona la scheda esistente o la aggiunge;
- `activateTab(tabId)`;
- `closeTab(tabId)`: attiva la vicina più prevedibile;
- `moveTab(tabId, targetIndex)`;
- `showWorkspace()` e `hideWorkspace()`;
- `toggleFocus()`;
- `restoreWorkspace(validatedState)`.

Tutti i punti di ingresso esistenti devono chiamare `openTab`; nessun componente deve
modificare direttamente l'array delle schede.

## Comportamento della tab strip

- Il click seleziona una scheda.
- Il pulsante di chiusura rimuove solo quella scheda.
- Il trascinamento cambia l'ordine e lo conserva per l'attività.
- Aprire una risorsa già presente porta in primo piano la scheda esistente.
- Chiudendo la scheda attiva viene selezionata prima quella alla sua destra, altrimenti
  quella a sinistra.
- Chiudendo l'ultima scheda il workspace mostra uno stato vuoto con il pulsante `+`; non è
  obbligatorio chiudere automaticamente la colonna.
- Il pulsante `+` apre un menu delle viste e delle risorse disponibili.
- Quando manca spazio, la striscia scorre orizzontalmente e un menu di overflow elenca
  tutte le schede.
- Riordinamento, chiusura e attivazione sono disponibili anche da tastiera.

Le schede sono persistenti finché l'utente non le chiude. Questa prima versione non usa il
modello editoriale “preview temporanea/pin”, perché renderebbe meno prevedibile l'apertura
dei contenuti.

## Contenuto delle schede

`InspectorWorkspace` fornisce solo shell, tab strip, resize e ciclo di vita. Ogni tipo di
scheda viene reso da un adapter che riusa i componenti attuali.

```text
InspectorWorkspace
├── InspectorTabStrip
├── InspectorResizeHandle
└── InspectorContentOutlet
    ├── FileInspector
    ├── ArtifactInspector
    ├── MemoryInspector / GraphInspector
    └── OperationalInspector
```

Ogni adapter dichiara:

- titolo, icona e breadcrumb;
- azioni contestuali;
- contenuto principale;
- stati loading, empty, missing, denied ed error;
- eventuale callback di ridimensionamento.

L'anteprima occupa tutta la superficie sotto la tab strip e la propria toolbar. L'elenco
permanente degli artefatti nella seconda colonna interna viene sostituito da un selettore
compatto o dal menu `+`. Aprire un artefatto crea o seleziona la sua scheda.

Il cambio di scheda conserva almeno durante la sessione:

- posizione di scorrimento;
- selezione interna;
- eventuale sottovista;
- stato di caricamento già risolto quando sicuro riutilizzarlo.

## Persistenza e isolamento

La larghezza è una preferenza globale. Lo stato delle schede è invece memorizzato per
`threadId` e include la provenienza di progetto necessaria alla rivalidazione.

Lo stato persistito contiene soltanto descrittori minimi e riferimenti, non copie del
contenuto. Al ripristino:

1. si carica lo stato della sola attività corrente;
2. ogni descrittore viene risolto nuovamente;
3. si controllano progetto, workspace e autorizzazioni correnti;
4. le schede non più disponibili o autorizzate non vengono riaperte;
5. nessun riferimento viene trasferito automaticamente a un'altra attività.

Cambiare attività salva lo stato corrente e carica quello della destinazione. Nascondere il
workspace preserva le schede; chiuderle le rimuove dallo stato persistito.

## Responsive

La decisione responsive deve dipendere dalla larghezza reale dell'area centrale, non solo
dalla larghezza della finestra. Una container query o un equivalente segnale misurato
attiva la modalità singola sotto circa 920–960 px utili.

In modalità singola:

- il workspace sostituisce temporaneamente la conversazione nell'area centrale;
- non è un overlay sopra la chat;
- il pulsante indietro/chiudi torna alla conversazione;
- sidebar e navigazione principale restano governate dal normale layout dell'app;
- tab strip e contenuto usano tutta la larghezza disponibile.

La toolbar interna usa anch'essa la propria larghezza disponibile per spostare azioni
secondarie nel menu overflow.

La modalità focus applica lo stesso layout a pannello singolo anche su una finestra ampia.
Uscire dalla modalità focus ripristina il rapporto precedente; non altera ordine, selezione
o contenuto delle schede.

## Ridimensionamento e accessibilità

Il separatore usa Pointer Events per mouse e trackpad. Durante il drag:

- vengono disabilitati selezione del testo e transizioni;
- la dimensione aggiornata viene applicata senza ricostruire i contenuti;
- la preferenza viene salvata al termine, non a ogni movimento;
- grafo e canvas ricevono un segnale finale di refit.

Il separatore espone `role="separator"`, orientamento verticale e valori min/max/corrente.
Le frecce modificano la larghezza a passi regolari; `Home` e `End` applicano i limiti.

La tab strip implementa il pattern ARIA tabs:

- un solo tab nel normale ordine di tabulazione;
- frecce per cambiare tab;
- `Enter`/`Space` per attivare;
- scorciatoia accessibile per chiudere;
- riordinamento disponibile con controlli da tastiera, non solo drag and drop.

## Errori e casi limite

- File eliminato: scheda conservata con stato `missing`, azioni Ricarica e Chiudi.
- Permesso revocato: contenuto rimosso e scheda non ripristinata; se la revoca avviene mentre
  è aperta, mostra stato `denied` senza dati precedenti riutilizzabili.
- Formato non supportato: metadata e azioni disponibili, con messaggio esplicito.
- Caricamento fallito: errore locale alla scheda, senza compromettere le altre.
- Identificatore duplicato: `resourceKey` seleziona l'istanza già aperta.
- Riduzione improvvisa della finestra: clamp del rapporto o passaggio alla modalità singola.
- Nessuna scheda: stato vuoto funzionale, non superficie bianca.

## Strategia di implementazione

La modifica viene introdotta per slice verificabili:

1. stato/reducer e test di deduplicazione, chiusura, ordine e persistenza;
2. layout a due colonne e separatore accessibile;
3. shell a schede e migrazione delle viste operative esistenti;
4. file e artefatti come schede per risorsa, eliminando la colonna interna permanente;
5. responsive, ripristino validato e rifinitura visuale.

I vecchi booleani `artifactsOpen`, `workbenchTab` e lo stato locale della larghezza vengono
rimossi o adattati dietro il nuovo reducer. La migrazione non cambia i contratti backend.

## Verifica

I test di contratto UI che oggi impongono il pannello flottante devono prima essere
aggiornati per descrivere il nuovo comportamento.

La copertura minima comprende:

- apertura iniziale 50/50;
- larghezza globale persistita e clamp sicuro;
- apertura multipla senza duplicati;
- attivazione, chiusura e riordinamento;
- stato separato per attività;
- mancato ripristino di risorse non autorizzate;
- apertura dalle entry point attuali;
- resize con pointer e tastiera;
- modalità singola su area stretta;
- conservazione dello scroll tra schede;
- refit di grafo e canvas;
- loading, empty, missing, denied, unsupported ed error;
- assenza della seconda colonna permanente nell'anteprima artefatti.

La verifica finale usa l'app reale almeno in tre geometrie: desktop ampio, desktop medio e
area centrale stretta. Vanno aperte e alternate almeno le viste file, artefatto, memoria,
grafo, fonti, piano, attività ed esecuzione. Non basta verificare il DOM: contenuti,
scrollbar, toolbar, menu e trascinamento devono essere osservati nel rendering effettivo.

## Criteri di accettazione

La funzionalità è completa quando:

1. la conversazione non viene coperta dal workspace;
2. ogni contenuto usa l'intera superficie utile della propria scheda;
3. larghezza e schede vengono ripristinate secondo gli scope approvati;
4. nessuna risorsa viene duplicata o ripristinata fuori dal proprio perimetro;
5. tutte le operazioni principali sono disponibili senza mouse;
6. il layout rimane leggibile nelle tre geometrie di verifica;
7. build, test mirati e controllo visuale dell'app installata risultano realmente verdi.
