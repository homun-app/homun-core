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
