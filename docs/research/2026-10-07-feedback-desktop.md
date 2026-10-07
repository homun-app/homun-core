# Feedback desktop del 7 ottobre — triage

Prima sessione di test dell'app Electron (workspace desktop dedicato).
Ogni punto con root cause verificata nel codice.

## Sistemati in sessione

1. **Popover "?" illegibile** — si apriva con `left:-120px` sconfinando dalla
   sidebar, finendo sotto il contenuto (stacking). Fix: popover contenuto
   nella sidebar + `.cw-sidebar` con stacking sopra il main
   (`conversation-workspace.css`).
2. **Progetti con nomi duplicati** — `_project_create` non validava nulla.
   Fix: nomi univoci tra progetti attivi (case-insensitive, trim), valido
   anche sul rename; l'auto-create da conversazione **riusa** il progetto
   omonimo (i titoli dei lavori generano nomi ripetuti di continuo).
   Test: `test_project_uniqueness.py` (4).
3. **Suddivisione Oggi/Ieri fittizia in "Senza progetto"** — due difetti:
   bucket a 24 ore scorrevoli invece che giorni di calendario, e i work
   del motore **non avevano data** (`startedAt` era riempito solo dalla
   simulazione) → fallback che li sparpagliava in base all'indice di lista
   (`now - i*8h` — inventato). Fix: `startedAt` portato da `updated_at`/
   `created_at` del motore nel bridge; raggruppamento per giorno di
   calendario locale; senza data → "Precedenti" (label onesta, niente
   "Settimana scorsa" per tutto il resto).
4. **Connettori: errore invisibile** — l'errore veniva mostrato con
   `HomunErrorNotice` **in cima alla pagina**, fuori viewport quando si è
   scesi nella lista; e il popup aperto col gesto utente restava bianco
   quando il flusso OAuth falliva. Fix: `act()` ritorna l'esito → il popup
   fallito si chiude; la notice viene portata in vista con scroll.

## Differiti (servono decisioni/design)

5. **Compiti: gestione e filtri incomprensibili** — i filtri chiedono "me"
   in un contesto mono-utente. Da rifare dopo il multiutente. **Visione
   dichiarata dall'utente**: il multiutente NON è più utenti sullo stesso
   computer, ma **utenti su macchine diverse che condividono memorie,
   azioni ecc.** — architettura da progettare (federazione/relay tra
   engine, non solo sessioni multiple locali).
6. **Automazioni non creabili** — root cause: la vista "Automazioni" di
   ConversationSpace gira su `SpaceData.routines` **simulate** (modifica
   locale); le routine vere del motore esistono (`EngineRoutineCreator`)
   ma sono montate solo nel pannello lavoro. Da collegare: la vista
   Automazioni deve usare le routine del motore (Fonte: motore, AGENTS.md).
7. **Connettori duplicati con i canali** — il catalogo connettori include
   le stesse piattaforme dei canali (whatsapp, telegram…): unificare le
   due voci o etichettare il doppio ruolo.

## Non ancora toccati

Il test era "solo alcune delle cose più evidenti": al prossimo giro
convocare una passata completa (documenti, squadre, materiali, ricerca).
