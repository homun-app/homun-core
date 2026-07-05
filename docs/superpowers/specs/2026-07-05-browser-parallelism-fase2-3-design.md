# Browser Parallelism — Fase 2 & 3 (Design Follow-up)

> **Status:** Design (in attesa di validazione della Fase 1 in produzione)
> **Spec di riferimento:** `docs/superpowers/specs/2026-07-05-turn-queue-broker-design.md` (§ "Concorrenza — Livello 3")

## Contesto

La Fase 1 (`2b5653d5`) ha introdotto:
- `chat_turn_resource_requirements()` → ogni chat_turn dichiara `BrowserSession(1)`
- `TurnEventKind::Queued` → visibilità della coda browser
- Governor limit=1 (già esistente) serializza i turni

La Fase 1 risolve le **corse critiche nascoste** sul browser condiviso. Le Fasi 2-3 introducono **parallelismo reale** mantenendo la correttezza.

## Fase 2 — Limite adattivo N (context condiviso, RAM dinamica)

**Obiettivo:** Permettere fino a N turni browser concorrenti (N scalato in base alla RAM disponibile), usando il context Chromium condiviso (warm). Parallelismo reale per automazioni indipendenti, con il caveat documentato che i turni condividono tab/cookie.

### Prerequisiti (devono essere veri in produzione)
- La Fase 1 è stabile: nessuna regressione di affidabilità, i turni in `WaitingResource` si sbloccano correttamente.
- Il `browse_web_lock` inline (`main.rs:26516`) non causa deadlock con il governor.

### Componenti

1. **`adaptive_browser_limit()`** (nuovo helper in `main.rs`):
   - Legge `sysinfo` per la memoria libera (crate `sysinfo` da aggiungere come dipendenza, o `/proc/meminfo` su Linux / `vm_stat` su macOS via `sysctl`).
   - Soglie: `> 4 GB liberi → max(3, HOMUN_BROWSER_PARALLEL)`, `1-4 GB → 2`, `< 1 GB → 1`.
   - Ricalcolato ad ogni tick del worker (come `active_llm_concurrency` oggi).
   - Sostituisce il limite fisso `BrowserSession = 1` in `effective_task_resource_limits()`.

2. **Sostituire `browse_web_lock` con un semaforo di concorrenza**:
   - `tokio::sync::Semaphore::new(adaptive_limit())` long-lived in `AppState`.
   - I 7 call site (`main.rs:21430-22076`) acquisiscono un permit invece del mutex esclusivo.
   - Il permit si rilascia a fine tool-call (come oggi il guard).

3. **Rimuovere il double-gating** (opzionale, se la Fase 1 dimostra che il governor basta):
   - Una volta che il semaforo è affidabile, il governor è ridondante. Oppure tenerli entrambi (governor per la visibilità `WaitingResource`, semaforo per il gating effettivo).

### Rischi
- **Context condiviso = collisioni**: due turni che navigano lo stesso sito si pestano i piedi su tab/cookie. Accettabile per automazioni indipendenti, NON per turni che fanno ricerche correlate.
- **`sysinfo` crate**: aggiunge una dipendenza. Alternativa: parsing di `/proc/meminfo` o `sysctl hw.memsize` via `std::process::Command`.

### Test
- e2e: tre turni su tre thread, ognuno fa una chiamata browser breve. Verificare che almeno 2 girano in parallelo (timestamp dei `done` eventi < soglia).
- Test di degradazione: simulare RAM bassa → limite scende a 1 → i turni tornano seriali.

---

## Fase 3 — Isolamento context (true parallelismo, isolamento completo)

**Obiettivo:** Ogni turno ha il suo `BrowserContext` isolato (tab/cookie/storage separati). Parallelismo reale senza collisioni.

### Prerequisiti
- La Fase 2 è stabile.
- È stato affrontato il **regresso di affidabilità documentato** (`main.rs:46650-46654`): context freddi → consent/geo walls → worker "wander and burns iterations".

### Componenti

1. **Attivare `HOMUN_BROWSER_ISOLATED_CONTEXT=1` di default** (solo per i turni browser concorrenti, non per i singoli):
   - Modifica `browser_sidecar_env_with_headless` (`main.rs:46655-46660`) per attivarlo quando il limite adattivo > 1.

2. **Pre-warming dei context** (mitigazione del regresso):
   - Seeded cookies: copiare i cookie del context warm (default) nei context isolati al momento della creazione.
   - O un pool di context pre-creati e "scaldati" con le pagine di consenso comuni.

3. **Multiplexare il sidecar** (opzione a, più efficiente in RAM):
   - Refactor del protocollo stdio: `request_id` (già esiste) + registry `oneshot` lato Rust + loop non-seriale lato Node (`server.ts:273-275`).
   - `BrowserTransport::send` diventa async.
   - O mantenere N sidecar (opzione b, più RAM ma zero refactor protocollo).

### Rischi
- **Il regresso di affidabilità è reale** (misurato dall'autore). Richiede tuning (pre-warming, cookie seeding, geo defaults).
- **Refactor async del transport** (opzione a) propaga a client, executor, 7 call site, test mock — è il costo maggiore.

### Quando fare la Fase 3
Solo se la Fase 2 mostra che il parallelismo con context condiviso causa problemi reali (turni che si corrompono a vicenda). Se la Fase 2 funziona per i tuoi casi d'uso, la Fase 3 può restare come future work.

---

## Decisione differita

**Non procedere con Fase 2-3 ora.** Prima:
1. Validare la Fase 1 in produzione (qualche giorno di utilizzo reale con `HOMUN_TURN_BROKER=on`).
2. Verificare che il browser gating non causi deadlock o regressioni.
3. Identificare se il problema reale è "limite=1 troppo restrittivo" (→ Fase 2) o "turni si pestano i piedi" (→ Fase 3).

Se la Fase 1 basta (la maggior parte dei casi d'uso non ha turni browser concorrenti), fermarsi lì.
