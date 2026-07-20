# Design — Stabilizzazione interazioni dell'Inspector universale

Data: 2026-07-20. Stato: **approvato a livello di design**.

## Contesto

La prima implementazione dell'Inspector universale ha introdotto colonne reali, schede
persistenti e adapter comuni per file, artefatti e viste operative. La verifica nell'app
ha però evidenziato quattro difetti collegati:

1. l'anteprima torna periodicamente all'inizio e dà l'impressione di aggiornarsi di
   continuo;
2. lo scroll verticale non è affidabile;
3. quando le schede sono numerose, titolo e pulsante di chiusura si sovrappongono;
4. il trascinamento non comunica quale scheda è in movimento né dove verrà inserita.

Questa tranche stabilizza le interazioni senza cambiare il modello persistito delle
schede, le autorizzazioni o i contratti backend.

## Diagnosi verificata

### Aggiornamento periodico

`App` aggiorna i read model operativi ogni 2,5 secondi. Il risultato dei messaggi viene
salvato come un nuovo array anche quando è semanticamente identico a quello già presente.
La nuova identità riattiva il caricamento del catalogo artefatti in `ChatView`; il catalogo
aggiornato produce nuovi oggetti, la scheda attiva ricostruisce l'anteprima e la posizione
di scorrimento viene persa.

La correzione deve partire dalla sorgente: un polling senza cambiamenti non deve produrre
nuovo stato React. La vista non deve compensare con ritardi, animazioni o salvataggi
artificiali dello scroll.

### Scroll

Il pannello della scheda nasconde l'overflow mentre alcuni adapter creano propri
contenitori scrollabili annidati. Nel caso artefatto il reset periodico aggrava il problema
riportando il contenuto in cima. Ogni scheda deve avere un solo proprietario dello scroll
verticale per i contenuti documentali e a elenco.

Le viste immersive che possiedono naturalmente un viewport interno, come iframe, canvas o
terminali, possono mantenere il proprio scroll isolato, ma devono dichiararlo
esplicitamente.

### Schede compresse

La scheda usa attualmente un flex item restringibile, mentre titolo e chiusura hanno
larghezze minime indipendenti. Quando manca spazio il contenitore diventa più stretto dei
figli, che invadono la scheda adiacente. Le schede devono conservare una larghezza minima
coerente e lasciare che sia la striscia a scorrere orizzontalmente.

### Feedback del trascinamento

Il trascinamento conserva coordinate e applica il nuovo ordine soltanto al rilascio. Non
esiste stato visuale di trascinamento. La scheda deve mostrare presa, sorgente e destinazione
senza riordinare continuamente il DOM durante il movimento.

## Decisione

Si adotta una stabilizzazione strutturale ma circoscritta:

- deduplicazione semantica dei messaggi prima di aggiornare lo stato globale;
- catalogo artefatti aggiornato solo quando cambia realmente il contenuto rilevante;
- un'unica superficie di scroll per ogni scheda documentale;
- tab strip con schede non comprimibili, titoli ellittici e overflow orizzontale;
- drag con sorgente attenuata, cursore `grabbing` e indicatore di inserimento;
- riordinamento definitivo soltanto al rilascio.

Non viene introdotta virtualizzazione delle schede: il menu `Open tabs` esistente e lo
scroll orizzontale sono sufficienti per la scala prevista.

## Flusso degli aggiornamenti

Il polling confronta il nuovo snapshot dei messaggi con quello corrente usando i campi che
determinano il rendering: identificatore, ruolo, testo, allegati, eventi strutturati,
metriche e timestamp. Se non esistono differenze, mantiene il riferimento corrente e non
causa un render discendente.

Quando arriva un cambiamento reale:

1. `ChatView` riceve il nuovo snapshot;
2. il catalogo degli artefatti viene ricaricato una sola volta;
3. il catalogo uguale al precedente conserva gli oggetti correnti;
4. la preview attiva viene ricaricata soltanto se cambia la risorsa selezionata o la sua
   revisione effettiva;
5. una rivalidazione dovuta al focus continua a fallire in modo chiuso e può rimuovere il
   contenuto precedente, come richiesto dal confine di autorizzazione.

Il miglioramento prestazionale non deve indebolire la sicurezza: revoca, cambio di
workspace e cambio di revisione autorizzativa conservano la priorità rispetto allo stato
visuale.

## Proprietà dello scroll

`inspector-tab-panel` diventa la superficie di scroll predefinita e conserva il proprio
`scrollTop` finché la scheda rimane montata. Gli adapter documentali e gli elenchi non
creano un secondo scroll verticale.

Il contratto è:

- documento Markdown, codice, diff, tabelle, file e liste: scroll della scheda;
- PDF/HTML incorporato, canvas, grafo e terminale: viewport gestito dall'adapter;
- cambio scheda: posizione conservata separatamente dal DOM già montato;
- refresh dati senza cambiamenti: nessuna modifica della posizione;
- refresh reale della stessa risorsa: mantenimento della posizione entro il nuovo limite;
- revoca o risorsa mancante: sostituzione con stato locale e posizione azzerata.

La scrollbar rimane sottile e discreta; non vengono aggiunte cornici o card interne.

## Tab strip

Ogni tab è un'unità non comprimibile con:

- larghezza minima sufficiente per titolo e chiusura;
- larghezza massima contenuta;
- titolo `min-width: 0`, ellissi e tooltip completo;
- pulsante di chiusura fuori dal flusso del testo e sempre raggiungibile;
- tab attiva portata automaticamente nell'area visibile;
- striscia orizzontalmente scrollabile, senza comprimere tutte le tab;
- menu `Open tabs` come accesso rapido all'intero insieme.

Rotella e trackpad devono continuare a scorrere il contenuto quando il puntatore è nel
pannello. Lo scorrimento orizzontale della tab strip è limitato alla striscia stessa.

## Trascinamento

Durante un drag valido:

1. dopo una piccola soglia la sorgente riceve lo stato `dragging`;
2. il cursore globale diventa `grabbing`;
3. la destinazione mostra una linea verticale prima o dopo la scheda più vicina;
4. avvicinandosi ai bordi la striscia scorre lentamente;
5. al rilascio viene emessa una sola operazione `moveTab`;
6. `pointercancel`, perdita del focus e smontaggio ripuliscono tutti gli stati transitori.

Un click sotto soglia continua ad attivare la scheda. Il trascinamento non deve attivare la
regione nativa di movimento della finestra. Il riordinamento da tastiera rimane invariato.

## Accessibilità

- La scheda trascinata espone `aria-grabbed` durante il gesto.
- L'indicatore visivo non sostituisce i comandi `Alt+Freccia` già disponibili.
- La tab attiva rimane l'unica nel normale ordine di tabulazione.
- La chiusura mantiene il focus sulla vicina prevedibile.
- La riduzione del movimento non altera il feedback essenziale: opacità e indicatore
  restano disponibili senza animazioni.

## Gestione errori e autorizzazioni

- Errori temporanei del catalogo non eliminano schede o contenuti già autorizzati.
- Una risposta esplicitamente non autorizzata rimuove subito il contenuto precedente.
- Risorsa mancante, errore e formato non supportato restano stati distinti.
- Risposte asincrone precedenti non possono sovrascrivere una rivalidazione più recente.
- Nessun contenuto di file o artefatto viene copiato nello stato persistito delle schede.

## Strategia di test

La correzione segue test-first e include:

1. confronto tra snapshot messaggi uguali e realmente differenti;
2. assenza di un nuovo catalog fetch per polling semanticamente invariato;
3. conservazione dell'identità del catalogo quando il risultato non cambia;
4. contratto CSS che impedisce compressione e sovrapposizione delle tab;
5. stato drag, indicatore di inserimento, cleanup e riordino singolo al rilascio;
6. proprietario unico dello scroll per file, artefatti e liste;
7. mantenimento della posizione passando tra due schede;
8. test reali nell'app a larghezza ampia, media e stretta.

La prova manuale finale deve durare più di un ciclo di polling e verificare che:

- lo scroll non torni in cima dopo almeno dieci secondi;
- la preview non lampeggi né mostri `Carico…` senza un cambiamento reale;
- almeno otto schede non si sovrappongano;
- il drag mostri sorgente e destinazione prima del rilascio;
- il riordino, il click e la chiusura continuino a funzionare;
- una rivalidazione autorizzativa reale continui a fallire in modo chiuso.

## Criteri di accettazione

La tranche è completa quando:

1. nessun polling invariato ricostruisce la preview;
2. lo scroll resta stabile tra polling e cambi di scheda;
3. titoli e pulsanti non si sovrappongono con molte schede;
4. il drag è visivamente comprensibile e non muove la finestra;
5. le viste mantengono il design minimale approvato;
6. test automatici, build e verifica reale nell'app risultano verdi.
