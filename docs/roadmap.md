# Roadmap Operativa

> Stato aggiornato al 2026-06-05.
> - Cronologia dettagliata degli interventi: `docs/work-memory.md`.
> - Roadmap strategica per fasi: `docs/architecture/final-roadmap.md`.
> - Mappa componenti: `docs/architecture/system-map.md`.
>
> Questo file risponde a una sola domanda: **dove siamo e cosa viene dopo.**
> Non e' un changelog (quello e' work-memory) ne' la visione (quella e'
> `PROJECT.md`).

## North Star

Un personal assistant **local-first** desktop (macOS/Win/Linux) che non e' una
chat passiva: osserva, capisce richieste naturali, sceglie strumenti in modo
governato, esegue task anche lunghi con coda/approval/checkpoint, mostra cosa fa
(Chat + Local Computer) e costruisce memoria verificabile. Modello mentale: un
apprendista che osserva, propone, esegue con permesso e diventa maestro
operativo.

## Svolta architetturale corrente: capable-first

Il design iniziale era **sovra-vincolato per far girare Gemma4 locale**: snapshot
browser Compact, prompt prescrittivi a molte regole, budget di contesto minuscoli,
piano statico. Tesi validata sul campo: **quei tagli danneggiano i modelli
capaci** (l'unico passaggio Compact->Full ha sbloccato l'estrazione opzioni nei
test treno end-to-end).

Direzione adottata (de-gemma / capable-first):

- **Provider registry + ruoli** (`orchestrator` / `browser` / `memory`) -> modello,
  con binding `auto` o esplicito. Lo stato dell'arte cloud (GLM, MiniMax, Kimi,
  DeepSeek via OpenAI-compat / Ollama cloud) e' di prima classe; MLX/Gemma resta
  come **fallback locale per modelli piccoli**, non come default.
- **Budget di contesto adattivi** alla context-window del modello attivo
  (soglia capace ~32k): niente piu' clamp di contenuto essenziale sui modelli
  capaci. Il compressore torna a essere ottimizzazione, non gate.
- **Brain ON di default** sui backend capaci; le euristiche keyword
  (piano/target/draft) restano solo come stampella del path MLX piccolo.
- **Prompt browser lean** (stile OpenClaw): solo identita', execution-bias e
  guardrail di **sicurezza** hard-enforced via tool policy; via le 14 regole
  prescrittive.

## Prodotto & business model: core agnostico + addon (ADR 0011)

Direzione di prodotto (dettaglio in `docs/decisions/0011-agnostic-core-addon-ecosystem.md`):

- **Core agnostico, valore negli addon.** Il core resta domain-neutral ed espone
  primitivi (canali, browser, memoria, task runtime, approval, scheduler,
  esecutore di procedure). Tutta la verticalita' vive negli **addon** fuori dal
  core — prerequisito per un ecosistema.
- **Land-and-expand.** Oggi: assistente personale (adozione). Domani: **addon**
  (nostri o di partner) che lo trasformano in strumento di lavoro verticale.
- **Addon = "process skill"**: trigger + passi (deterministici/agente) + dati &
  config + punti di approvazione + binding canale. Tre origini, una forma:
  installati / scritti dall'utente / **generati** (loop apprendista).
- **La generazione emette CONFIG, non codice per-cliente.** Domini regolati
  (fatturazione: SdI/IVA/numerazione) = **componenti vettati configurati**, non
  generati da zero. La generazione brilla sul bespoke. Spettro: config dichiarativa
  > script in sandbox > MAI app/codice per-cliente.
- **Personalizzazione bounded, solo-prompt ("contratto di personalizzazione").**
  Ogni addon dichiara zona **bloccata** (invarianti: contratto-dati, calcoli,
  campi fiscali) e zona **aperta** (etichette, campi opzionali, layout, testo
  documenti, default). La personalizzazione e' un **overlay-dato** autorato via
  prompt, **validato** contro gli invarianti, in **anteprima + reversibile
  (versionato)** e **upgrade-safe** (si riapplica quando il componente e'
  aggiornato centralmente → niente fork-snowflake).
- **Non-goal:** non SaaS multi-tenant (resta single-tenant/self-hostable); non
  generare app/codice arbitrario per-cliente; non un flow-builder (n8n-style).

### Definition of done — "core come addon-host"

Il core e' "pronto agli addon" (NON serve tutta la visione) quando ha:
1. il loop **assistente personale** solido (chat + browser + memoria + canali) — quasi fatto;
2. i **primitivi che un addon compone** = passi 2-5 del gap audit (hardening
   runtime, profondita' d'esecuzione, feedback loop, scheduling);
3. l'**astrazione process-skill/addon + il meccanismo del contratto di
   personalizzazione** (design nuovo), estratto da **UN addon vettato reale
   (fatturazione)** end-to-end.

Auto-apprendimento e cloud NON sono prerequisiti dell'addon-host: arrivano dopo.

## Stato attuale: fondamenta solide

Pilastri completati e in esercizio (dettaglio task in work-memory):

- **Gateway Rust + chat**: HTTP locale loopback su `127.0.0.1`, token 0600, CORS
  stretto, streaming, cancel, read model redatti. Chat con Markdown/codice/
  tabelle, syntax highlighting, immagini+vision, edit messaggio + branch picker,
  modello attivo visibile e override per-messaggio.
- **Composer**: toolbar, skill picker, improve-prompt, selettore modello inline,
  `@`-file context, dettatura (faster-whisper).
- **Memoria (M0-M5, M3b)**: schema universale, estrazione + auto-conferma, grafo
  entita'/relazioni/decisioni, memoria di thread, UX di gestione, recall tool.
- **Contatti (M6-M7)**: schede contatto, identity resolution cross-canale, merge
  consistente e self-protected, fatti distillati con grounding temporale.
- **Canali (C0-C5)**: WhatsApp (wa-rs + QR) e Telegram (sidecar Bot API) sullo
  stesso `ChannelProvider`; inbound -> memoria -> bozza, auto-reply con allowlist
  e approval. **M8**: l'inbound diventa un thread-agente con tool read-only.
  **Real-time push** (`/api/events`): un inbound crea la scheda e l'app ci si
  sposta in tempo reale. **Resilienza offline (2026-06-05)**: i messaggi mandati
  a sistema spento vengono ripresi ed eseguiti al ritorno — auto-reconnect dei
  canali all'avvio, offset Telegram persistito (forward-before-advance), inoltro
  sidecar->gateway con retry (at-least-once). **Recupero WhatsApp via history-sync**:
  i messaggi consegnati al telefono mentre il bot era offline vengono ripresi
  dall'history-sync di wa-rs e auto-risposti, con 3 guardie anti-spam (recency
  ~48h + watermark per-contatto + dedup durevole per message_id). Limite residuo:
  la finestra in cui le piattaforme inviano backlog/history-sync.
- **Artifacts & Files**: cartella montata host<->container, tool
  `create_artifact`/`save_artifact`, versioning, edit in-app, download + gestione.
- **Sidebar IA (M9)**: progetti reali + Personale sempre attivo + modale nuovo
  progetto.
- **Browser capable-first (rewrite stile OpenClaw)**: il modello principale guida
  **tool granulari** (`browser_navigate/snapshot/act/screenshot/tabs/dialog`)
  dentro il suo loop, con sessione per-thread, gate di sicurezza condiviso
  (`browser_safety.rs`), multi-tab, gestione dialoghi, no-progress nudge,
  set-of-marks e vision. E' il default in chat.
- **Build hygiene**: `incremental=false` + `scripts/cargo-gc.sh` per tenere
  `target/` snello.

## Fase corrente

**Consolidare il capability layer e il browser capable-first.** Le fondamenta ci
sono; il lavoro vivo e' affidabilita' del browser su siti reali (form complessi,
estrazione tabellare, recovery) con modelli capaci, e la coerenza del registry
ruoli/modelli.

## Debito tecnico / fronti aperti

1. **Doppio motore browser.** RISOLTO (2026-06-05): rimosso il `browser_task`
   durevole e il planner legacy (`browser_loop_controller.rs`, `RuntimeBrowserLoopPlanner`,
   `brain_adapter.rs`, `browse_web`). Il browser e' guidato SEMPRE inline
   dall'agente coi tool granulari (motore unico).
2. **Ruolo browser su modello vision.** RISOLTO (2026-06-05): ruolo `browser` =
   `minimax-m3:cloud` (vision + tools, context 1M). Set-of-marks e screenshot ora
   vengono effettivamente consumati dal modello.
3. **Packaging / notarization macOS.** Da scegliere il packager finale
   (`electron-builder` o equivalente) e formalizzare firma/notarization, con
   lifecycle gateway equivalente al dev (token, autostart, shutdown su quit).
4. **Doc drift.** Mantenere allineati `roadmap.md`, `system-map.md`,
   `final-roadmap.md` quando cambia lo stato (questo riallineamento e' il primo
   passo).

## Blockers

- Packaging produzione: lifecycle gateway packaged equivalente al dev e scelta
  packager/notarization macOS non ancora chiusi.

## Next Action (priorita')

Ordine consigliato, rivedibile; razionale accanto a ciascuna voce.

1. ~~**Ruolo browser su modello vision**~~ FATTO (2026-06-05): ruolo `browser` =
   `minimax-m3:cloud` (vision). Debito #2 chiuso; set-of-marks/screenshot attivi.
   La priorita' #1 effettiva diventa quindi la voce successiva.
2. ~~**Browser durevole sul motore granular**~~ FATTO (2026-06-05): rimosso il
   path durevole + planner legacy; browser inline-only (motore unico). Debito #1
   chiuso. La priorita' #1 effettiva diventa la voce successiva.
3. **Affidabilita' browser su siti reali** (ora priorita' #1). Extractor
   strutturati per tabelle/listbox, cookie/banner preflight, stale-ref recovery,
   wait predicates bounded.
4. **Packaging / notarization macOS**. Necessario per distribuire, ma l'app e'
   ancora single-dev: importante, non urgente rispetto al core. Chiude #3.
5. **Auto-apprendimento** (gated: solo dopo eventi reali affidabili). Salvare
   come memoria utente solo preferenze stabili emerse da task confermati, con
   anti-esfiltrazione e privacy domain.
6. **Deployment cloud / always-on (self-hostable).** Far girare gateway + sidecar
   su un host sempre acceso (mini-PC/VPS dell'utente), con l'app desktop/web come
   client. Sblocca i canali 24/7 senza buchi: WhatsApp ricevuto anche a portatile
   spento (il companion resta sempre online → niente `count: 0`), Telegram idem,
   proattivita' continua. Vincolo di valore: restare **single-tenant /
   self-hostable** ("la tua istanza, i tuoi dati") per non tradire il local-first;
   NON un SaaS multi-tenant. L'architettura e' gia' pronta (il gateway e' un
   servizio HTTP, l'app un client). Da fare: TLS + auth reale (oggi loopback +
   token), gestione segreti, esposizione di rete sicura, packaging server.

## Gap di sistema (audit 2026-06-05, verificato sul codice)

Audit a ventaglio (8 revisori per dimensione) + verifica avversariale. Tema
dominante: **"costruito ma non cablato"** — piu' sottosistemi esistono e sono
unit-testati ma non vengono mai invocati in produzione. I prossimi grandi
guadagni sono **chiudere i loop**, non scrivere nuovi sottosistemi.

Stato: agente **reattivo** competente (chat + browser). Lontano dalla visione
"apprendista che osserva, propone, agisce in proattivita'".

Gap verificati, per tema:

- **Proattivita' (il salto verso la visione)** — 3 pezzi che vanno insieme:
  - primitiva di **schedulazione/ricorrenza** assente (niente cron/RRULE nel task
    model, niente invii programmati; `schedule_hint` salvato ma mai consumato). HIGH.
  - **auto-apprendimento** tutto codificato ma **mai innescato**: manca il
    substrato di **ingestione eventi** (solo `contact_merge` registra un evento)
    che alimenta routine inference -> proposte di automazione. HIGH (gated).
  - **UI di controllo** (Learning/Automations/Memory) ancora **mock**. MEDIUM.
- **Profondita' d'esecuzione (oltre il browser)**:
  - l'agente fa **solo browser**; shell/file/takeover esistono nel Local Computer
    session manager (con `ShellCommandPolicy` + approval gia' pronti) ma **non
    esposti come tool**. HIGH.
  - **niente feedback/replanning**: il Brain pianifica una volta e non osserva i
    risultati intermedi (il cascade di fallimento sui dipendenti FUNZIONA gia';
    manca il replanning mid-stream). HIGH.
- **Robustezza runtime** (fix piccoli su roba esistente): `heartbeat()` mai
  chiamato (task >5min rischiano scadenza lease), `deadline/expires_at` non
  applicati, nessun **cancel/abort** sicuro di un task Running, `ResourceGovernor`
  istanziato ma inattivo. HIGH.
- **Hardening / always-on** (gate per il cloud): niente TLS/auth reale (loopback+
  token), niente signing/notarization, niente e2e test, logging strutturato,
  rate limiting, rotazione segreti; **data lifecycle** incompleto (delete workspace
  lascia orfani, niente export utente, niente retention/GC -> SQLite crescono
  all'infinito). HIGH/MEDIUM.
- **Ecosistema / reach**: MCP **solo stdio** (no HTTP/SSE), nessun provider HTTP
  generico, grant **per-tool** assenti, canali **1:1** (no gruppi/broadcast),
  solo WhatsApp+Telegram. MEDIUM.
- **Trascurati minori**: onboarding/first-run wizard, import dati.

Sequenza consigliata (ordine di dipendenza vera):
1. **Affidabilita' browser su siti reali** (gia' Next Action #1; nessuna nuova
   architettura).
2. **Hardening runtime**: heartbeat + deadline + cancel cooperativo (prerequisito
   di tutto cio' che e' long-running/proattivo).
3. **Loop di feedback task->Brain** (replanning + osservazione mid-stream +
   rollback subagenti): un solo canale risolve piu' buchi.
4. **Profondita' d'esecuzione**: esporre shell/file + takeover come tool (riusa
   policy + approval esistenti).
5. **Primitiva di proattivita'**: ricorrenza + timezone nel task model + tick che
   materializza le occorrenze + UI scheduling.
6. **Auto-apprendimento** su substrato eventi reale + UI di controllo (XL; dipende
   da 2-5).
7. **Production hardening** per l'always-on (TLS/auth, logging, e2e, export/delete,
   retention) -> sblocca il cloud che chiude davvero il buco canali-offline.
8. **Ecosistema** per ultimo: MCP HTTP/SSE, provider HTTP generico, grant per-tool,
   gruppi/altri canali.

Nota: i passi 2->6 sono il binario verso la **proattivita'**; il cloud (passo 7 /
Next Action #6) ne e' l'**abilitatore** 24/7, non un extra.

## Loop agentico di core: plan(success-criteria) -> act -> verify-by-execution -> replan

Primitivo trasversale (consolida i passi 3-4) e cuore dell'"assistente che fa anche
codice". Stato dell'arte confermato (Claude Code/Codex/Cursor/SWE-bench, giugno
2026): un harness MINIMO + modello capace + **verifica per esecuzione** batte i
planner complessi.

Forma del loop (agnostica, nel core):
1. **Comprendi + pianifica** con **criteri di successo espliciti** (cosa significa
   "fatto" in modo verificabile) — niente piano = niente verifica.
2. **Agisci** (tool) e **osserva** ogni risultato (gia' presente nel tool-loop del turno).
3. **Verifica ESEGUENDO**, non interrogando il modello: lancia un check/predicato e
   leggi l'esito reale. Per il codice = build/test/lint; per il browser = righe
   risultato presenti; per la fattura = campi obbligatori validi.
4. **Replan / auto-correggi** sul fallimento (rifeed dell'errore); **stop** quando i
   criteri sono soddisfatti. Replanning periodico per contrastare la deriva.
5. **Governance**: approval sui passi rischiosi, round limitati, tracciabilita' del
   piano e delle decisioni.

Principio di design: il **core fornisce il loop** (plan/verify/replan, agnostico);
l'**addon dichiara COSA verificare** (il predicato). Coding = primo banco di prova,
riusando il contained-computer come workspace dev (run build/test). Coerente con
ADR 0011 (il "cosa" sta nell'addon, il "come" nel core) e con lo SOTA (semplicita'
+ verify-by-execution). NON ricostruire un planner barocco.
