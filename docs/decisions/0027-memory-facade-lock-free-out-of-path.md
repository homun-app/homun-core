# ADR 0027 — Memory facade lock-free (out-of-path): rimuovere il `Mutex<MemoryFacade>` globale, pool WAL come unico path

- **Stato:** Proposed
- **Data:** 2026-07-09
- **Relazioni:** **completa/realizza [ADR 0022](0022-memory-as-out-of-path-service.md)** ("memory as an
  out-of-path service"); **motivato dal gateway-freeze del 2026-07-09** (backtrace del processo congelato,
  memoria `homun-gateway-freeze-resilience`); tocca il **Caposaldo #1** (un solo `MemoryFacade`, il layer
  condiviso) e la scelta del flag `HOMUN_MEMORY_POOL`. Non introduce un secondo store: converge sull'unico.

## Contesto — il difetto strutturale

Il 2026-07-09 un turno con un modello **locale lento/a freddo** (gemma4 in cold-load, path local-first
legittimo — Caposaldo #2) ha fatto andare **ogni** endpoint HTTP del gateway a HTTP 000 — anche una `/health`
apparentemente lock-free — con 0% CPU e i worker tokio parcheggiati nel kernel; solo un kill+respawn ha
recuperato. Un `sample` del processo congelato (ambiente reale: `~/.homun` dell'utente) ha **pinnato la causa**:

- `AppState.memory_facade: Arc<Mutex<MemoryFacade>>` — un **`std::sync::Mutex` globale attorno all'intero
  facade**, con `fn lock_memory_facade(state) = state.memory_facade.lock()` chiamato da **83 call-site** in
  `main.rs`, **inclusi gli handler HTTP di axum**.
- Nel backtrace, tre stack raggiungono **contemporaneamente**
  `… → lock_memory_facade → std::sync::…Mutex::lock → __psynch_mutexwait`: (a) `axum::serve::handle_connection`
  (ecco perché *ogni* richiesta HTTP si blocca), (b) `memory_project_briefing`, (c) un `Handle::block_on`.
- Il *context-build/briefing* del turno tiene quel lock a lungo (op di memoria + chiamate embed/modello sul
  gemma a freddo); nel frattempo tutti gli handler HTTP si incanalano nello **stesso** mutex → freeze totale.

Il codice stesso indica che il lock è **rimovibile**:

- **Tutti i metodi di `MemoryFacade` sono `&self`** (16 su 16; zero `&mut self`) → il facade non richiede
  accesso esclusivo.
- **Lo store (`SQLiteMemoryStore`) è già `Sync`** e gestisce la concorrenza da solo (`Single` = `Mutex<Connection>`
  interno; `Pooled` = WAL con writer dedicata + N reader). Il commento nel codice è esplicito: *"non aggiunge
  contesa reale in Single mode **perché il facade è comunque dietro un mutex**"* — cioè l'unica contesa è il
  mutex esterno.
- **`recall` fa già le chiamate al modello OFF-lock** (`embed_query` async fuori dal guard; commento: *"il
  `MutexGuard` non attraversa un await"*). Il pattern corretto esiste — non è generalizzato.

Il timeout headers/connect sul client modello (fix di resilienza parallelo, 2026-07-09) **mitiga** — sblocca
invece di appendere per sempre — ma **non** rimuove la causa: anche con timeout, tenere un lock globale per
qualche secondo (un briefing lecito su modello locale) stalla tutto l'HTTP per quei secondi.

## Decisione

La memoria diventa davvero **out-of-path** (ADR 0022): nessun lock globale sul path caldo dell'HTTP, nessuna
chiamata al modello sotto lock. Tre mosse coordinate:

1. **Rimuovere il `Mutex` esterno del facade** → `AppState.memory_facade: Arc<MemoryFacade>`. Le 83
   `lock_memory_facade(state)?` diventano accesso diretto `&state.memory_facade`; `lock_memory_facade` sparisce.
   La concorrenza vive **dentro lo store**, per-operazione, per il tempo della singola query — mai attraverso
   una chiamata al modello. *(Vincolo: i pochi call-site che oggi usano il guard per una sequenza
   read-modify-write **atomica** vanno riespressi come operazione atomica dello store o un write-lock stretto;
   la maggioranza sono op singole → sostituzione meccanica.)*
2. **Far atterrare il pool WAL come unico path** (`HOMUN_MEMORY_POOL` promosso a default/incondizionato,
   variante `Single` ritirata). In WAL le **letture sono concorrenti** e solo le **scritture** serializzano
   (brevemente): gli handler HTTP di lettura non contendono più con il write di un turno.
3. **Generalizzare la disciplina off-lock** (già in `recall`) a briefing/context-build: `lock → snapshot →
   unlock → (chiamata modello OFF-lock) → lock → write`. Con il facade `&self` + lock nello store, nessun codice
   gateway tiene più un guard del facade attraverso una chiamata modello — la proprietà cade fuori quasi da sé.

Layer di supporto (backstop, non la cura):

4. **Timeout sul client modello** (headers/connect) — già fatto nel fix di resilienza. Invariante: nessuna
   chiamata di rete illimitata.
5. **Liveness lock-free + cancel indipendente dal modello**: `/health` non deve toccare il facade; `DELETE
   /turns` deve funzionare anche durante un turno lento (oggi passava dallo stesso funnel e si bloccava).

## Conseguenze

- **Positivo:** letture di memoria concorrenti; nessun funnel globale; un turno con modello locale lento gira
  **mentre** l'utente apre altre chat, vede il progresso e **cancella** — il requisito local-first (Caposaldo #2)
  è rispettato *anche sotto latenza*. Realizza l'"out-of-path" dell'ADR 0022.
- **Costo:** modifica meccanica su ~83 call-site (`lock_memory_facade(state)?` → `&state.memory_facade`), da
  fare behavior-preserving e verificata dal compilatore; il ritiro di `Single` semplifica lo store. L'unico
  punto di attenzione è la manciata di read-modify-write atomici (vanno resi op atomiche dello store).
- **Convergenza:** non è un secondo store né un band-aid; è il **completamento dell'ADR 0022** (il pool e il
  service erano costruiti ma default-OFF, e il Mutex esterno non era mai stato tolto). Il freeze è il **costo
  concreto** di non averli fatti atterrare.

## Alternative scartate

- **Solo il timeout sul modello** (lo stato attuale del fix): mitiga (recupera invece di appendere) ma lascia il
  lock globale sul path HTTP → un briefing lento continua a stallare l'HTTP per la durata dell'hold.
- **Bufferizzare/spostare il logging (ipotesi stdout-pipe):** falsificata dal backtrace (contesa su mutex, non
  `write()`; il gateway congelato aveva stdout su file). Non è la causa.
- **Tenere il `Mutex<MemoryFacade>` coarse e "solo non tenerlo troppo a lungo":** fragile — dipende dalla
  disciplina di 83 call-site e non dà letture concorrenti. Rimuovere il lock è più semplice E più corretto.

> Implementazione: coordinare con la sessione/fix di resilienza (`homun-gateway-freeze-resilience`). Il timeout
> è già landato come backstop; questo ADR è la cura di radice. Gate: i test del pool WAL esistono (Tappa 2) +
> un `health_stays_live` che tenga specificamente il lock del **memory-facade**.
