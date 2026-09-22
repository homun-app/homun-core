# Proposta di design — Piano multi-fase (raccolta → confronto → sintesi)

> Stato: **fetta 1 implementata e verificata end-to-end** (vedi §9). Le domande
> aperte del §7 sono state risolte con le opzioni raccomandate: fasi dichiarate
> dal modello e validate dal motore (a); ack unico accordo+fasi; proposta con
> [Avvia] nel pannello + promemoria una-tantum in chat ([Non ora] = semplicemente
> non agire, la notifica resta in chat); scala fasi sempre nel pannello, in chat
> i messaggi di svolta; artefatto finale della sintesi = testo revisionabile.
> Riferimenti: priorità 1 di `docs/handoff/2026-09-21-prompt-nuova-chat.md`;
> gap «chiusura con esito» emerso dall'audit UX 2026-09-22 (D7).

## 1. Il gap, in una frase

Oggi un lavoro o è **eseguibile in un passo** (confronto CSV / lettura materiale: piano
monofase, esecuzione, revisione, chiusura) o è **preparazione senza esecuzione** (accordo,
«Cosa serve ora», chiusura senza esito). Manca il percorso intermedio: un lavoro che dichiara
**fasi con più collaboratori e passaggi visibili**, dove l'umano approva i punti di svolta e
il lavoro si chiude **con un risultato**.

## 2. Cosa riusiamo così com'è (non si inventa nulla di nuovo)

| Pezzo | Dove esiste già | Note |
|---|---|---|
| Piano con passi, dipendenze, assegnatari | `plan.propose` / `plan.accept` / `plan.revise` (motore, testati) | `PlanStep`: title, assignee_id, depends_on, output_expected, status |
| Avvio supervisionato | `work.start` (passa in RUNNING, primo passo in esecuzione) | già ammesso solo con intake confermato |
| «Tocca a te» per passi umani | `work.request/provide_contribution` + `pending_contribution` già mostrato in UI | è il meccanismo raccolta-contributi |
| Esecuzione + revisione + chiusura con esito | flusso `compare_csv` esistente (`work.submit_artifact` → `work.review` → COMPLETED) | da generalizzare oltre il confronto |
| Notifica «il lavoro propone qualcosa» | sistema **followup** già in UI (campanella + riepilogo) | canale per la proposta automatica del passo |
| Vocabolario UI dei piani | `ConversationCatalogPlan` della demo («X/N completati», riordino, assegna) | da portare in modalità motore |
| Lettura del piano da UI | `GET /v1/works/{id}` restituisce già `plan` | nessuna nuova lettura |

**Principio guida** (dagli appunti di prodotto): l'intake non esegue mai, propone; ogni
transizione che consuma risorse o produce effetti passa da una conferma umana esplicita.

## 3. Il percorso utente (cosa vede, cosa approva, come si chiude)

### 3a. L'accordo dichiara le fasi

La **proposta di lavoro** guadagna una sezione «Fasi del lavoro» quando il risultato richiesto
ha passaggi naturali (es. raccolta → confronto → sintesi). Ogni fase: titolo, chi se ne occupa
(collaboratore esistente o profilo da creare), cosa produce, cosa serve per partire.

- **Cosa vede**: la card della proposta con le fasi in colonna, come una scala; l'ultima fase
  dichiara il risultato finale (= «Risultato atteso» già presente, senza duplicazioni).
- **Cosa approva**: come oggi, un'unica conferma («Conferma e affida» / «Crea il collaboratore
  e affida»). Confermando l'accordo si confermano anche le fasi: all'utente non chiediamo
  due ack separati lo stesso concetto.
- Dietro le quinte: la conferma dell'intake invoca `plan.propose` con le fasi come passi
  (`depends_on` a catena) e `plan.accept`. Il lavoro va in READY con piano v1. Nessun nuovo
  stato.

### 3b. Fase di raccolta: «Cosa serve ora» per fase + proposta automatica del passo

La scheda «Cosa serve ora» diventa **per fase corrente**: mostra i materiali attesi dalla fase
(aperti), quelli già caricati, e chi è in carico.

- **Cosa vede**: «Fase 1 di 3 · Raccolta — servono i listini marzo e giugno: 1 di 2 caricati».
- **Cosa fa**: trascina/allega i file nella conversazione, come oggi; oppure risponde in chat.
- **La proposta automatica (la prima fetta richiesta)**: quando i materiali attesi dalla fase
  di raccolta ci sono tutti, il **lavoro propone da solo il passo eseguibile** tramite un
  followup: «Ho tutto quello che serve per il confronto: lo avvio?» con [Avvia il confronto]
  e [Non ora]. La lettura dei materiali resta nell'archivio del progetto.
- **Cosa approva**: l'avvio del passo, mai implicito. Se l'utente ignora la proposta, il
  lavoro resta fermo e la notifica resta raggiungibile dalla campanella e dal pannello.

### 3c. Esecuzione con passaggi visibili

Durante l'esecuzione la chat e il pannello mostrano la **scala delle fasi** con stato
(completato / in corso / in attesa / da te), l'assegnatario di ciascuna e il tempo trascorso
dove rilevante. Ogni cambio di fase lascia in chat un messaggio verificabile («Confronto
completato: 214 differenze trovate. Passo a Elena per la sintesi.»).

- **Cosa vede**: la stessa scala in tre posti coerenti — chat, pannello riepilogo, vista
  Compiti (stato «In corso · fase 2 di 3»).
- **Cosa approva**: i passi **eseguibili** si avviano con la conferma del 3b; i passi
  **umani** (es. «chiedi conferma dei prezzi sospetti al titolare») usano il meccanismo
  «tocca a te» già esistente (richiesta di contributo in chat + pannello).
- **Errori**: un passo che fallisce mostra l'errore tipizzato sul passo, con [Riprova] e
  [Salta] (salta = `plan.revise` che rimuove il passo, mai silenzioso).

### 3d. Sintesi e chiusura con esito (chiude il gap D7)

L'ultima fase produce l'**artefatto finale** (report, bozza, riepilogo) che passa per la
revisione umana già esistente: [Approva e concludi] / [Richiedi correzioni].

- **Cosa vede**: il risultato in chat con anteprima/download, la scala completa verde.
- **Come si chiude**: «Approva e concludi» porta il lavoro a **Completato** (stato terminale
  vero, non più solo «Chiuso senza eseguire»). La chiusura senza esecuzione resta disponibile
  come azione secondaria in qualsiasi momento («Chiudi il lavoro»).
- La scheda lavoro conclusa mostra: risultato, chi l'ha prodotto, fasi percorse con i propri
  artefatti intermedi (audit leggero).

## 4. Da dove nascono le fasi (decisione da validare)

Due opzioni per dichiarare le fasi nell'intake:

- **(a) Le dichiara il modello** nella proposta (estensione dello schema dell'intake:
  `plan_steps` facoltativo: titolo, capacità richiesta, materiale atteso, output atteso) e
  **il motore le valida e le rinforza**: ogni fase deve mappare su una capacità reale
  (`compare_csv`, `read_material`, `general`-umana) o viene rifiutata onestamente.
- (b) Le deriva il motore dalla capacità (niente campo nuovo), ma perde la libertà di
  dichiarare «raccolta umana → confronto → sintesi» con assegnatari diversi.

**Proposta: (a)**, con vincolo stretto: massimo 5 fasi, ogni fase con capacità nota, assegnatario
risolvibile (regola del collaboratore in carica già fissata da D1/D12). Il prompt dell'intake
già oggi rifiuta di promettere capacità inesistenti: la stessa onestà vale per le fasi.

## 5. Prima fetta (da validare prima di tutto il resto)

**«Quando i file della raccolta ci sono tutti, il lavoro propone da solo il passo eseguibile.»**

Scope della fetta 1:

1. Schema intake + prompt: `plan_steps` facoltativo (validazione motore, come sopra).
2. Conferma intake → `plan.propose` + `plan.accept` con le fasi (senza UI nuove: la conferma
   è quella di oggi, la card mostra le fasi in sola lettura).
3. Lettura materiali attesi dalla fase corrente (dal catalogo capacità: `ready` /
   `eligible_materials`, già calcolati dal motore e oggi nascosti solo al modello).
4. Followup di proposta automatica quando la fase è sazia + azione [Avvia il passo] che fa
   `work.start` (o l'avvio del passo successivo) con conferma.
5. Scala fasi essenziale nel pannello riepilogo (stato per fase, nessun riordino).

**Fuori dalla fetta 1** (esplicitamente): riordino/revisione del piano da UI, catene di
letture multiple per fase, budget per fase, più artefatti per fase. La fetta 1 deve già
permettere il percorso completo raccolta → confronto → sintesi → chiusura con esito per il
caso «due listini + un documento».

## 6. Casi limite (già previsti dai comandi esistenti)

- **Revisione dell'accordo dopo il via**: la chat continua a funzionare; una modifica che
  tocca le fasi genera `plan.revise` (i passi completati restano storia, i nuovi si accodano;
  mai riscrittura in posto — già regola del motore).
- **Cambio collaboratore a fasi in corso**: passa da `plan.revise` con nuovo assegnatario per
  i passi non completati; le regole D1/D12 proteggono la continuità del collaboratore in
  carica salvo cambio dichiarato.
- **Annullamento**: «Chiudi il lavoro» già cancella gli intenti in corsa (`cancel_work_intents`).
- **Fallimento passo**: stato FAILED sul passo + errore tipizzato; [Riprova] ri-propone
  `work.start` del passo; [Salta] fa `plan.revise`.
- **409/versione**: recupero guidato già implementato in questa sessione.

## 7. Domande aperte per la validazione

1. Confermi l'opzione **(a)** del §4 (fasi dichiarate dal modello, validate dal motore)?
2. La conferma dell'accordo che **contiene** anche le fasi (un solo ack) ti sta bene, o vuoi
   un ack separato per il piano (come già fa oggi compare_csv con proposta+accettazione)?
3. Nella proposta automatica del passo: bottone solo [Avvia] o anche [Non ora] con promemoria?
4. La scala fasi in chat: sempre visibile o solo nei cambi di fase (messaggio) + pannello?
5. Per la «sintesi» di lavori `general`: l'artefatto finale nella fetta 1 è **testo in chat
   revisionabile** ( Approva/Richiedi correzioni) oppure vuoi già il concetto di documento?

## 8. Cosa serve dopo la validazione (stima d'impatto, non impegno)

- Motore: estensione schema/prompt intake + collaudi della proposta automatica (la logica di
  readiness esiste già); nessun nuovo comando.
- Web: card fasi in sola lettura (riuso del lessico `ConversationCatalogPlan`), pannello
  scala fasi, azione followup [Avvia il passo], stato Compiti «fase N di M».
- Test: percorsi end-to-end raccolta→sintesi su superficie web e desktop (la shell Electron
  ora è automatizzabile).

## 9. Fetta 1: com'è stata realizzata (2026-09-22)

Motore:
- `models/intake.py`: `PlanStepDraft` (tollerante nella forma, stretto nel senso:
  capability del registro, assegnatario risolvibile) + `IntakeBrief.plan_steps`
  (max 5) + `plan_steps` dichiarabile in `changed_fields`; sintesi con un retry
  rigoroso quando il modello non produce JSON conforme (i piccoli modelli locali
  a volte avvolgono lo schema in prosa).
- `application/intake.py`: validazione assegnatari (nome vuoto = collaboratore
  del brief); alla conferma, fasi → `plan.propose` + `plan.accept` (catena di
  dipendenze, lavoro → Pronto) nella stessa transazione dell'ack.
- `application/plan_readiness.py` (nuovo): prontezza per progetto della prima
  fase eseguibile + annuncio in chat una sola volta per titolo di fase
  («Ho tutto quello che serve per …»), agganciato a `material_ingest` dopo il
  commit (un fallimento dell'annuncio non mente mai sull'upload riuscito).
- `routes/reads.py`: la lista lavori espone il piano corrente (scala fasi senza
  round-trip per lavoro); `routes/intake.py`: `plan_steps` nel trasporto.

Web:
- Card proposta: sezione «Fasi del lavoro» (titolo, capacità, attese, assegnatario)
  con nota dell'ack onesto; «Fasi» nelle etichette di diff/campi invariati.
- Pannello riepilogo: regione «Fasi del lavoro» con stato per fase e assegnatario,
  aiuto onesto sui materiali mancanti e azione **[Avvia: …]** (gating:
  lavoro Pronto + materiali sufficienti per la capacità della fase).
- `work.start` esposto via `startEngineWork` + `useEngineWorkspace.startWork`.

Verifica: suite motore 463 verdi (test nuovi: conferma→piano accettato a catena,
assegnatario irrisolto → errore onesto, precisazione che aggiunge fasi, annuncio
una-tantum, prontezza per progetto); `npm run check` verde. Percorso dal vivo su
web: richiesta multi-fase → precisazione «suddividi in fasi» (canale necessario
quando il modello piccolo omette le fasi) → card con fasi → conferma (Pronto) →
progetto da chat + 2 CSV → annuncio automatico → [Avvia] → «In corso».

Fuori dalla fetta 1 (prossimi passi): esecuzione delle fasi oltre il primo
`work.start` (collegamento ai flussi lettura/confronto esistenti), avanzamento
automatico al passo successivo, riordino/revisione del piano da UI, chiusura
«con esito» dell'ultima fase, budget per fase.

## 10. Fetta 2: avanzamento delle fasi e chiusura con esito (2026-09-22)

Motore:
- `work.review` (approve) con fasi ancora in attesa **avanza** invece di completare:
  il lavoro torna Pronto, la fase successiva parte solo con il nuovo via esplicito;
  messaggio onesto in chat («Fase verificata e completata. Prossima: «X»…»).
  L'approve dell'ultima fase resta COMPLETED con messaggio di chiusura
  («Lavoro completato: … nessun invio esterno») — il gap D7 dell'audit è chiuso.
- `work.provide_contribution` segna la propria fase come riuscita e annuncia la
  successiva (o invita alla consegna finale se è l'ultima).
- La lista lavori espone anche l'artefatto corrente (`latest_artifact`).

Web:
- Card «RISULTATO DA VERIFICARE» generica in chat per qualsiasi lavoro in
  revisione (titolo, contenuto, azioni di revisione) — non più solo per il
  confronto CSV.
- Etichette di revisione consapevoli delle fasi: «Approva e passa a «X»» vs
  «Approva il risultato e concludi il lavoro».
- Pannello: «Consegna il risultato» quando tutte le fasi hanno esito e manca
  l'artefatto finale (textarea → `work.submit_artifact` → revisione → completato).

Verifica dal vivo (profilo reale, provider Ollama): raccolta avviata → esito fase 1
in revisione → «Approva e passa a «Confronto prezzi e SKU»» → messaggio di
avanzamento → Avvia fase 2 → sintesi in revisione → «Approva il risultato e
concludi» → **Completato** con risultato in archivio. Suite: motore 465 verdi,
web 193 verdi, `npm run check` verde, budget architettura rispettato.

Nota: il lavoro dimostrativo «Confronto listini marzo-giugno» (completato, con
progetto e materiali) è lasciato volutamente nell'archivio reale come esempio
visibile; si rimuove su richiesta.

## 11. Fetta 3: le fasi eseguibili viaggiano coi loro strumenti reali (2026-09-22)

Motore (`application/phase_execution.py`, condiviso da confronto e lettura):
- Un accordo «general» con una fase `compare_csv`/`read_material` **ammette lo
  strumento su quella fase** (la capability dell'intake non forza più il lavoro
  intero); il tool non crea un secondo piano monofase: la scala delle fasi È il
  piano, la proposta si aggancia alla versione corrente.
- **L'approvazione dello strumento è il via della fase** (work.start del passo,
  quando il lavoro è ancora Pronto); l'esecuzione reale consegna l'artefatto
  della fase e la revisione umana avanza come nella fetta 2.

Web:
- La UI dello strumento giusto compare sulla fase corrente (`PhaseTool` in
  chat): selezione CSV → prepara → «Approva ed esegui confronto» → report.
- Proprietà della revisione per provenienza: l'artefatto lo revisiona la fase
  che lo ha prodotto (il tool per il report del confronto; la card generica per
  le consegne umane); i report sostituiti lo dicono esplicitamente.
- «Consegna il risultato» dell'ultima fase umana la avvia e la chiude
  (Pronto → In corso → In revisione → Completato).
- Un lavoro collegato al progetto solo via conversazione vede i materiali
  (stessa regola `work_project_ids` del motore, nelgi snapshot web).

Verifica dal vivo: proposta con fasi (confronto + sintesi), Aurora creata,
progetto da conversazione, due CSV → seleziona → prepara → «Approva ed esegui
confronto» → esecuzione reale («1 aumento, 1 nuovo, 1 rimosso…») → approvazione
che avanza alla sintesi → consegna → «Lavoro completato». Suite: motore 466,
web 193, `npm run check` verde.
