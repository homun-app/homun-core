# Metodologia di lavoro — Homun

> **Leggimi all'inizio di OGNI sessione**, insieme a [CAPISALDI.md](CAPISALDI.md) (i principi
> che non si violano) e [STATO.md](STATO.md) (dove siamo adesso). Questo file è l'**operating
> manual**: COME si lavora. È durevole e cambia di rado. Data: 2026-06-27.

## Perché esiste

Per non perdere informazioni tra sessioni/compattazioni e per non ricostruire il contesto da
zero ogni volta. Tre documenti, tre domande:
- **CAPISALDI.md** → *cosa non si viola mai* (principi).
- **METHODOLOGY.md** (questo) → *come si lavora* (metodo).
- **STATO.md** → *dove siamo / cosa è fatto / come ripartire* (stato vivo, aggiornato a ogni sessione).

E la **mappa**: [architecture/](architecture/) (com'è fatto), [decisions/](decisions/) (perché
abbiamo deciso), [plans/](plans/) (il piano corrente).

## I principi di lavoro

### 1. Convergenza, non duplicazione (la regola madre)
Homun ha il difetto sistemico di **due implementazioni per cosa**, la canonica dormiente
(vedi [il piano](plans/2026-06-27-foundations-up-convergence.md)). Quindi:
- **Mai una terza implementazione.** Si **cabla la canonica** e si **ritira il parallelo**
  (o si cancella il dormiente con decisione esplicita).
- **Niente cerotti su un design sbagliato**: prima si capisce a quale strato/contratto
  appartiene un problema (la mappa `architecture/`), poi si interviene lì.

### 2. Igiene del codice (man mano, non a fine progetto)
- **Codice morto**: quando si tocca un'area, si **rimuove** ciò che non serve più (funzioni,
  rami, flag, file non referenziati). Una capability ritirata sparisce, non resta "per ogni
  evenienza".
- **Dimensione file**: limite **soft ~1500 righe**, **hard ~2500**. Oltre, si **splitta** per
  responsabilità (moduli). Bersaglio noto: `crates/desktop-gateway/src/main.rs` (~52k righe) va
  modularizzato **incrementalmente** quando si tocca un'area (es. estrarre `browser`, `memory`,
  `plan`, `mcp`, `composio`, `model_io` in moduli propri).
- **Qualità**: nomi chiari, niente duplicazione logica, errori tipizzati (no `String` opache),
  funzioni piccole con una responsabilità. Migliorare *l'area che si tocca*, senza refactor
  globali a sorpresa.

### 3. Commenti (è open-source: deve essere leggibile)
- **Commenti in inglese** nel codice (coerenza col codebase); **doc in italiano**.
- Ogni **modulo** e ogni **funzione non banale**: un commento che spiega il **PERCHÉ** (la
  ragione/il vincolo), non solo il *cosa*. Gli invarianti e i gotcha vanno scritti.
- L'**API pubblica** dei crate è documentata (`///`). La densità dei commenti segue il codice
  circostante: chiarire le decisioni e i trabocchetti, non narrare l'ovvio.

### 4. Disciplina della documentazione (niente codice fuori dalla mappa)
- Ogni modifica significativa **aggiorna la pagina `architecture/` del sottosistema** (+ il suo
  Mermaid) e **cita il caposaldo** che serve/ripristina.
- Le **decisioni** diventano ADR in `decisions/` (numerati, immutabili).
- `architecture/*.md` descrive la **realtà attuale**, comprese le divergenze dai capisaldi.
- **⭐ IL CODICE FA FEDE, NON I DOCUMENTI (la regola madre della documentazione).** Prima di
  basarti su un'affermazione di un doc/ADR/STATO sullo *stato del sistema*, **verificala sul codice**
  (grep/read): i doc driftano, il codice è la verità. Se divergono, **il codice vince** → correggi o
  annota il doc. Distinzione: gli **ADR** sono record storici della DECISIONE (non si riscrivono —
  se superati, si marcano `SUPERSEDED`), ma i **doc di stato-corrente** (STATO, `confronto-*`,
  `architecture/*`) devono combaciare col codice, e ciò che non è più vero **va rimosso/corretto**.
  I **riferimenti di riga** (`main.rs:NNNN`) sono best-effort e invecchiano a ogni edit: mai fidarsi
  del numero, ri-`grep` il simbolo. Prima di *descrivere* l'architettura (specie tra sessioni),
  verifica flag/default sul codice — non citare a memoria dai doc.

### 5. Disciplina dei test (bottom-up, gated)
- Si costruisce **dal basso**: non si lavora su uno strato finché quello sotto non è un **punto
  fermo** (contratto + test verde). Ogni passo del piano è gated.
- Ogni fix/feature porta un **test** (unit dove possibile; contract-test per i tool;
  fixture per-provider per la normalizzazione).
- Gate locali noti: `cargo test -p <crate>`, `npm run test:ui-contract`, `npm run build`,
  `python3 scripts/pre_release_gate.py`.

### 6. Disciplina di sessione (continuità / anti-compattazione)
- **A inizio sessione**: leggere CAPISALDI + METHODOLOGY + STATO + il piano corrente. La memoria
  (`MEMORY.md`) punta qui.
- **Durante**: aggiornare le pagine `architecture/` toccate; commit puliti e atomici su `main`
  (no trailer Co-Authored-By); push quando l'utente lo chiede.
- **A fine sessione / prima di compattare**: **aggiornare [STATO.md](STATO.md)** — cosa fatto,
  dove siamo, prossimo passo, e il **prompt di ripartenza** pronto da copiare. STATO.md resta
  **conciso** (è uno stato, non un changelog: lo storico va in `archive/`).

## Checklist

**Inizio sessione**
- [ ] Letti CAPISALDI, METHODOLOGY, STATO, piano corrente.
- [ ] So qual è il prossimo passo (da STATO) e a quale strato/caposaldo appartiene.

**Mentre lavoro**
- [ ] L'intervento è sulla canonica (no terza impl); ho rimosso il morto che ho toccato.
- [ ] File sotto i limiti (o l'ho splittato); commenti sul perché aggiornati.
- [ ] Aggiornata la pagina `architecture/` + Mermaid; citato il caposaldo; test verde.

**Fine sessione**
- [ ] Commit/push fatti; STATO.md aggiornato (fatto / dove siamo / prossimo / prompt ripartenza).

## Vincoli operativi del progetto

- Commit diretti su `main`; **no** trailer `Co-Authored-By`. Release = commit + tag → CI builda
  draft (non pubblicata finché non si pubblica esplicitamente). Vedi i vincoli in STATO.md.
- Build/test locali e log: vedi [DEVELOPMENT.md](DEVELOPMENT.md) e STATO.md.
