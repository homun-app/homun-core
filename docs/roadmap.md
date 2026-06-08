# Roadmap Operativa

> Stato aggiornato al 2026-06-07.
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

Stato (2026-06-06):
- punti 1-2: **fatti** (vedi passi 2/4/5 sopra: runtime, esecuzione+verifica sul
  repo reale, proattività con scheduling).
- punto 3: **in corso** —
  - crate `local-first-process-skill` (modello addon + contratto open/locked +
    `validate_overlay`/`apply_overlay` + fixture `invoicing_example`, 5 test). FATTO.
  - store gateway (`process_skills.rs`: addon installati + overlay per-istanza,
    JSON, seed fattura) + tool `list_addons`/`show_addon`/`customize_addon` (il
    contratto in azione: modifiche ai campi bloccati rifiutate e spiegate). FATTO.
  - Restano: l'**esecutore VETTATO fatturazione** end-to-end (bozza reale) e la
    **generazione** (apprentice loop: l'osservazione genera una process-skill
    rivedibile).

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

**Consolidare il capability layer, il browser capable-first e la UX di chat.** Le
fondamenta ci sono; il lavoro vivo e' affidabilita' del browser su siti reali (form
complessi, estrazione tabellare, recovery) con modelli capaci, e la coerenza del
registry ruoli/modelli. La **chat** e' ora matura: schede d'azione in-chat
(autorizza cartella, connect-card), **allegati analizzabili** (immagini/testo/PDF
testo+scansione via pdfium→vision, persistiti nel thread), **Workbench** (pannello
destro a tab File/Artefatti/Attivita'/Piano) e routing modelli coerente
(selettore = ruolo orchestratore, fallback su 401, provider Ollama Cloud).

## Test da fare — verifica manuale in sospeso (sessione MCP, 2026-06-07)

Lavoro consegnato (build + test verdi; backend verificato headless dove
deterministico) ma **da provare con le mani** nell'app — UI e chiamate
model-driven non sono verificabili headless. Commit: `9853162`, `4c53edc`,
`7a3d2c5`, `167b379`, `9a32256` (+ Docker/sandbox: `161973c`, `87aee68`,
`992ebe8`, `efd15fa`).

1. **MCP in chat** (`9853162`): collega un server MCP e in chat chiedi qualcosa
   che usi i suoi tool. Atteso: il modello scopre i tool via `find_connected_tools`,
   i **read** girano diretti (con timeout), i **write** mostrano la card di
   conferma `‹‹MCP_CONFIRM››`. Da verificare anche `read_only` (canali) blocca le write.
2. **Catalogo MCP** (`167b379` + anteprima `d71fd40`): Impostazioni → Connettori
   → **Catalogo MCP** → cerca `playwright`. Clic **"Dettagli"** → anteprima
   (descrizione completa, versione, "Pagina del progetto", "cosa ti serve",
   comando). Poi Connetti; prova `filesystem` (chiede una directory) e `github`
   (token, campo segreto). Atteso: badge "Ufficiale" automatico, anteprima leggibile,
   form parametri/segreti funzionante. NB: la tool-list reale appare DOPO il
   connect (limite registry — vedi nota nel commit).
   - **Server REMOTI (http, `9d70e0c`)**: la maggior parte del catalogo è remota
     (streamable-HTTP). Cercane uno con endpoint, "Dettagli" mostra "Endpoint" e
     gli eventuali header/token richiesti → Connetti. Atteso: discovery dei tool
     e uso in chat come per gli stdio.
3. **Disconnect** (`7a3d2c5`): dal dettaglio di un server MCP → "Disconnetti"
   (con conferma) → sparisce dai collegati.
4. **Meta-tool `suggest_capabilities`** (`9a32256`): in chat *"voglio automatizzare
   un browser, cosa posso collegare?"* → atteso: il modello chiama il tool e
   propone Playwright MCP + skill/Composio pertinenti, con come collegarli.
   - **Connect-card cliccabili** (`715792e`): quegli stessi suggerimenti ora sono
     una scheda con un pulsante per item. Atteso: **Skill** → "Installa" la mette
     subito; **MCP** senza parametri → "Connetti" diretto, con parametri/segreti →
     "Configura" apre il form inline (stdio: env/arg; http: header) → "Connetti";
     **Composio** → "Collega" apre l'OAuth nel browser. Dopo il connect l'item
     mostra "Collegato"; **ricaricando la chat resta "Collegato"** (no ri-offerta),
     gli altri item restano attivi. Niente giro in Impostazioni.
5. **Docker OS-aware + igiene** (`161973c`/`efd15fa`): con Docker chiuso, avvia
   una skill → atteso auto-start (no fallback immediato al browser); `/tmp` del
   container è tmpfs; dopo ~30min idle il container `homun-cc` viene riciclato.

6. **Filesystem nativo + routing (`d61c3ef` + fix prompt)**: in chat *"elenca le
   cartelle in Projects"* (o un path assoluto). Atteso: l'assistente usa
   `list_directory` (nativo) — non la sandbox, non `list_files` — e per cartelle
   non ancora autorizzate invita ad aggiungerle in Impostazioni → Destinazioni.
   Prima dava una non-risposta ("Sono pronto") o cercava nella sandbox: il fix di
   prompt-routing dovrebbe averlo corretto (verifica anche un nome NUDO senza path).

7. **Allegati analizzabili** (`edbeba2`): graffetta o trascina un file in chat e
   chiedi di analizzarlo. Atteso: **immagini** → viste dal modello vision; **testo/
   codice/csv/md** → contenuto iniettato nel prompt; **PDF nativi** → testo dal
   layer pdfium; **PDF scansione** (es. patente) → pagine rese in immagini e passate
   al vision. Prima: chip "path non disponibile" + invio bloccato ("Path locale non
   disponibile in questa shell") perché Electron 42 ha rimosso `File.path` — ora si
   usa `webUtils.getPathForFile`.
   - **PREREQUISITO PDF**: serve la libreria nativa pdfium. Una volta sola, esegui
     `bash scripts/fetch-pdfium.sh` (scarica il prebuilt bblanchon in
     `~/.local-first-personal-assistant/pdfium/`). Senza, immagini/testo funzionano
     ma i PDF rispondono con un messaggio chiaro "motore PDF non disponibile".
   - **Persistenza nel thread** (`1d7e719`): l'allegato è ingerito UNA volta e
     salvato sul thread (tabella `thread_attachments`); a ogni turno il contenuto
     (testo + immagini, con cap) e un MANIFEST vengono re-iniettati. Atteso: alleghi
     UNA volta, poi "il file"/"e la scadenza?" funzionano nei turni successivi SENZA
     riallegare; se citi un file non allegato, il modello chiede di allegarlo invece
     di frugare in sandbox/cartelle. NB: serve UN attach andato a buon fine (chip
     "patente.pdf" visibile) per innescare la persistenza.

8. **Workbench** (`02fa31f`→`0d974ca`): icona in alto a destra → pannello a tab.
   **File**: file caricati in chat + (in progetto) albero della cartella, click su un
   file → viewer con syntax highlight + toggle **± Diff** (git working↔HEAD).
   **Attivita'**: task del thread, **✕** annulla i bloccati. **Piano**: piano operativo.
   Trascina il bordo per allargare / pulsante schermo intero. Computer resta sopra il
   composer.
9. **Routing modelli / 401** (`84432aa`→`c8bd089`): il selettore del composer mostra il
   modello del **ruolo orchestratore**; aggiungi il provider **Ollama Cloud** (chiave da
   ollama.com/settings/keys) e lega i ruoli a provider autenticati; un 401 si auto-ripara
   sul binding orchestratore. Ruolo **Coding** per le chat di progetto.

**Verificato dall'utente (2026-06-08):** allegati PDF (testo+scansione) + persistenza,
routing modelli/401 + Ollama Cloud, Workbench/selettore → OK.

Esito atteso: il pilastro **MCP** è "usabile in chat + sfogliabile + gestibile +
suggerito"; la **chat** è "schede d'azione + allegati analizzabili + workbench". Annotare
qui i difetti emersi dal test reale.

### Schede azione in-chat (direzione UX — richiesta utente)
Le azioni vivono in chat, non in Impostazioni: l'assistente mostra una scheda inline
col pulsante per fare la cosa. Pattern condiviso coi confirm-card Composio/MCP.
- **Autorizza cartella**: FATTO (`1b86cb6`): cartella non autorizzata → scheda
  ‹‹FS_AUTHORIZE›› con [Autorizza ed elenca] → aggiunge la cartella + mostra il
  contenuto inline. (Completa la scelta "autorizzate + lettura altrove con conferma".)
- **Connect-card in chat**: FATTO (`715792e`): i suggerimenti di `suggest_capabilities`
  ora sono *cliccabili* — scheda ‹‹CONNECT_SUGGEST›› con un pulsante per item
  (Skill→installa, MCP→connetti con form parametri/segreti stdio|http, Composio→OAuth).
  Persistenza via `/api/connect/mark` (riscrive il messaggio → item "Collegato" al
  reload, gli altri restano attivi). In attesa di test manuale (vedi "Test da fare").
- **Workbench (pannello destro a tab)**: FATTO (`02fa31f`→`0d974ca`): un'unica icona
  apre File / Artefatti / Attivita' / Piano (vedi "Fatti — sessione 2026-06-08"). Tab
  **File** = caricati in chat + albero progetto + viewer con **git diff**; **Attivita'**
  con **annulla** task; ridimensionabile + schermo intero. Allegati **analizzabili e
  persistiti** (PDF testo+scansione via pdfium→vision). Verificato dall'utente.
- (write nativa su file con conferma: rimane.)
- **Secret-store** per i token MCP (oggi `env` raw nel registry — gap audit).
- **Read-timeout** nel transport stdio (`mcp.rs`): oggi il timeout protegge il
  turno, non il thread blocking su `read_line`.
- **Allowlist "esegui sempre"** per le write MCP (oggi confermano sempre).
- **Transport HTTP/SSE**: FATTO (streamable-HTTP, `9d70e0c`) — i server REMOTI
  del registry (~75%) ora sono collegabili, auth via header/token mostrata nel
  form. Resta: OAuth-remote (consenso, stile Composio) come follow-up.

## Debito tecnico / fronti aperti

0b. **Ollama: API NATIVA `/api/chat` (streaming + tool insieme).** RISOLTO
   (2026-06-08, `674ab4f`). Causa radice dei fallimenti con Ollama (browser non
   estrae, documenti falliti): il layer OpenAI-compat `/v1` **scarta i tool-call in
   streaming** (ollama#12557, OpenClaw#11828, opencode#20995) — il mio passaggio a
   `stream:true` su `/v1` aveva rotto i tool con Ollama. Fix provider-aware: i provider
   Ollama (locale `:11434` e cloud `ollama.com`) ora usano la NATIVA `/api/chat`
   (NDJSON, streaming + tool insieme, come Zed); gli altri restano su `/v1`.
   `build_chat_payload` ricostruisce la shape giusta anche sul fallback;
   `collect_ollama_native_stream` parsa NDJSON → stessa body shape; `to_ollama_messages`
   converte multimodale/tool_calls. Timeout: first-token 300s + idle 180s, ceiling
   3600s (un total-timeout a metà stream = il "error decoding response body" di
   reqwest#2839). Verificato: 5 `recall_memory` dispatchati via streaming nativo, no
   drop/errori. **Disciplina ollama-rs (2026-06-08)**: confrontato con
   `pepperoni21/ollama-rs` (riferimento) → allineati su endpoint/NDJSON/shape/options;
   adottato il loro vincolo `stream` MUST be false coi tool (tool rounds = singola
   richiesta non-streamata, affidabile; stream solo nel round finale senza tool per i
   token live), `keep_alive "10m"` (modello locale caldo), e il "remaining buffer" per
   la risposta single-object. **Browser = motore unico**: il ruolo `browser` era legato
   a `ollama-locale/minimax-m3:cloud` (cloud-model-su-locale, rotto) → slegato (auto) →
   `browser_openai_stream_config` ritorna None per auto → il browser usa l'orchestratore
   (verificato: 0 "Passo al modello browser"). Per "error decoding response body"
   intermittente: client streaming HTTP/1.1 + no-pool + diagnostica live.
   **DA FIXARE (memoria!)**: il ruolo `memory` in auto risolve a
   `ollama-locale/minimax-m3:cloud` (rotto) → l'estrazione memoria gira su un endpoint
   che fallisce → **la memoria potrebbe non imparare**. Causa: l'auto-router accoppia un
   modello `:cloud` col provider LOCALE invece che cloud. Fix: legare `memory` a
   ollama-cloud, o correggere l'accoppiamento provider del router.

0. **Streaming dall'upstream del modello.** RISOLTO (2026-06-08, `e87afc4`). Causa dei
   timeout: chat con `"stream": false` + cap sul tempo TOTALE → un modello lento/
   ragionatore (es. nemotron-3-ultra su Ollama cloud) sforava (Zed non ha il problema
   perché STREAMA). Fix: `stream:true` + consumo SSE (`resp.bytes_stream`) con
   **timeout di INATTIVITÀ** per-chunk (`LOCAL_FIRST_MODEL_IDLE_TIMEOUT_SECS`, default
   180s) invece del cap totale; `reassemble_openai_stream` ricompone i delta
   (content + tool_call dai frammenti) nella forma non-streaming → resto del loop,
   sanificazione e marker INVARIATI; fallback al JSON pieno se il provider ignora
   stream. Verificato end-to-end col modello reale (delta+done, no timeout) + unit su
   reassemble. **Token live nell'UI: FATTO** (2026-06-08): `collect_openai_stream`
   emette ogni `delta.content` live al sink mentre arriva; `coreBridge` rende il `Done`
   autorevole (testo finale sanificato sostituisce l'anteprima grezza). Verificato:
   risposta in 20 delta token-by-token + 1 done. Conseguenza UX: i marker ‹‹ACT›› di
   attività sono ora transitori (collassano nel messaggio finale pulito, coerente col
   reload).

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

Aggiornato 2026-06-08. Ordine consigliato, rivedibile.

**Fatti — sessione 2026-06-08 (chat UX + allegati + routing modelli):**
- **Allegati end-to-end** (`edbeba2`→`1d7e719`): cattura path via `webUtils.getPathForFile`
  (Electron 42 ha rimosso `File.path`); trasporto allegati nel body `generate_stream`;
  ingestione `attachments.rs` — immagini→vision, testo/codice, **PDF**: testo dal layer
  pdfium e, per le scansioni, pagine **rese in immagini** (pdfium→vision). **Persistenza
  nel thread** (`thread_attachments` + manifest re-iniettato): allega una volta, il file
  resta nei turni successivi. Hardening (TOCTOU/SVG), smoke pdfium reale. Verificato
  dall'utente: OK.
- **Connect-card cliccabili** (`715792e`): i suggerimenti di `suggest_capabilities`
  diventano schede d'azione (install skill / connect MCP con form / link Composio) con
  persistenza `/api/connect/mark`.
- **Workbench** (`02fa31f`→`0d974ca`): un'unica icona borderless apre un pannello destro
  a tab — **File** (caricati in chat + albero cartella progetto navigabile + viewer con
  syntax highlight e **git diff** working↔HEAD), **Artefatti**, **Attivita'** (task del
  thread, con **annulla**), **Piano** (piano operativo). Ridimensionabile + schermo intero.
  Computer resta dock sopra il composer.
- **Memoria del "perché" (decisioni, generica)** (`39f0db6`→`aad5d0c`): ogni azione
  consequenziale di un turno (modifica file/documenti, comandi, azioni su connettori)
  produce una traccia che alimenta l'estrattore → registra DECISIONI (cosa+perché,
  scope progetto) riusando il layer M3b esistente; bypassa la salienza per i turni che
  agiscono. + tool **`record_decision`** (perché intenzionale: rationale/alternative/
  affects) + direttiva: PRIMA di editare codice/documenti richiama la memoria, DOPO una
  scelta non banale registrala. Vale per QUALSIASI dominio (codice, preventivo cliente,
  dati), non solo coding. Obiettivo: ricordare il perché di ogni scelta, non
  ri-scandagliare i file.
- **Routing modelli / 401** (`84432aa`→`c8bd089`): il selettore del composer ora rispecchia
  il **ruolo orchestratore** (non l'`active_model` del provider); **fallback automatico
  su 401** al binding manuale; **ruolo Coding** (chat di progetto); router "sicuro" che
  evita i `:cloud` non autenticati; preset provider **Ollama Cloud** (chiave in-app, no
  `ollama signin`); messaggio 401 azionabile. Verificato dall'utente: OK.

**Fatti in precedenza:** affidabilita' browser (stale-ref auto-recovery); hardening
runtime (deadline/expires; governor); **proattivita' completa** (scheduling + calendar/tz,
esecutore `proactive_prompt`, list/cancel); **esecuzione+verifica sul repo reale**
(file tools path-jailed + `run_in_project`); **addon-host** dormiente; **MCP nel loop
chat** + catalogo registry + connect/disconnect + transport HTTP; **filesystem nativo**
(`list_directory`/`read_text_file` + scheda autorizza-cartella).

**DIREZIONE (decisione 2026-06-06):** prima una **release ufficiale come assistente
personale solido** — skill, **Composio (1000+ connettori)**, MCP. Gli **addon
(ADR 0011) restano fondazione PRONTA ma DORMIENTE** (gated off, `LOCAL_FIRST_ADDONS=1`):
si studiano e attivano DOPO la prima release, senza stravolgere nulla. Mappa dello
stato dei 3 layer: i path discovery/esecuzione/approval sono cablati; i buchi sono
**completamento, gestione, onboarding**.

Verso la prima release:
1. **Composio OAuth end-to-end** — PARZIALE (verificato 2026-06-08). In
   **Impostazioni → Connettori → Composio** il flusso è COMPLETO:
   `ComposioToolkitBrowser.connect` apre il browser + poll `connected_accounts`
   ogni 3s fino ad ACTIVE + refresh toolkit (SettingsView.tsx:1492-1527). Buco: le
   **connect-card in chat** (`linkComposio`, ComposioReconnectCard) aprono l'URL e
   si fermano ("autorizza e riprova"), senza poll né refresh, con `markConnected`
   ottimistico → da allineare al poll di Settings.
2. **Errori azionabili + token.** PARZIALE (2026-06-08): il **401 del modello** ora ha
   messaggio azionabile (`:cloud` → `ollama signin`/chiave) + **fallback automatico**
   al binding orchestratore + preset **Ollama Cloud** (`9d63b88`/`84432aa`/`c8bd089`).
   Resta: mappare gli errori **Composio/MCP/skill** ("401 → ricollega", "429 → rate
   limit") e rotazione/scoping del token gateway.
3. **MCP: usabile + sfogliabile + gestibile.** FATTO in gran parte (2026-06-07,
   in attesa di test manuale — vedi "Test da fare"): MCP **cablato nel loop chat**
   (discovery + dispatch, read auto / write con conferma, timeout sulle call);
   **catalogo da registry ufficiale** (`registry.modelcontextprotocol.io`) con
   connect-from-preset (parametri/segreti) in Settings; **connected-list +
   disconnect** (chiude l'"add-only"); **meta-tool `suggest_capabilities`**
   (scoperta unificata MCP+Skill+Composio); transport **streamable-HTTP** (server
   remoti del registry collegabili, `9d70e0c`). Restano: secret-store per i token,
   read-timeout nel transport, OAuth-remote (vedi follow-up).
4. **Onboarding first-run.** Wizard connettori (Composio prima, poi MCP/skill) cosi'
   il nuovo utente non parte da schermate vuote.
5. **Skill: gestione.** Install dal marketplace fluido, rilevamento update, override
   security consapevole (oggi blocco opaco).
6. **Status connettori + audit.** Dashboard stato (Composio/MCP attivi, tool count,
   account collegati) + log esecuzioni tool.
7. **Hardening release.** Packaging, retention/GC degli store, export/delete.

DOPO la prima release (ADR 0011): esecutore addon fatturazione end-to-end +
generazione (apprentice loop). Il loop di core (plan→verify→replan), la proattivita'
e l'esecuzione sul repo reale — gia' fatti — restano i primitivi su cui gli addon
si compongono.

Rifiniture trasversali: UI scheduling (oggi a voce), takeover desktop, approval-gate
opzionale su `run_in_project`.

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
   - FATTO in parte (2026-06-06): `run_in_sandbox` (shell arbitraria in sandbox
     Docker isolata + security scan) **sganciato da has_skills** → disponibile in
     ogni turno app; descrizione + direttiva di sistema orientate a
     **verify-by-execution** (build/test/lint, output reale, itera). Il loop
     inline `act→osserva→verifica→itera` ora è operativo per l'agente.
   - Assistente-codice sul **repo reale** (modello Claude-Code) FATTO (2026-06-06):
     tool file in-place `read_file`/`write_file`/`edit_file`/`list_files`
     **path-jailed** alla cartella di progetto (`WorkspaceRecord.folder`), +
     `run_in_project` (shell sul repo reale, cwd=cartella, timeout, security-scan)
     per build/test sul codice vero. La sandbox resta per browser + script
     usa-e-getta. Loop completo: list/read → edit/write → run/test → itera.
   - Restano: **takeover** desktop, **approval gate** opzionale su run_in_project,
     e il **replanning dei task DURABILI** (passo 3: feedback task→Brain, distinto
     dal loop inline).
5. **Primitiva di proattivita'**: ricorrenza + timezone nel task model + tick che
   materializza le occorrenze + UI scheduling.
   - FATTO (2026-06-06): `TaskRecord.recurrence` + modulo `recurrence` (interval
     spec) + `TaskScheduler::next_recurrence` (materializza l'occorrenza al
     completamento) + esecutore `proactive_prompt` (agent turn read-only consegnato
     nel thread «Pianificato» con push `/api/events`) + tool `schedule_task(goal,
     every)`. Worker attivo di default (poll 1s). Anche deadline/expires applicati.
     Gestione **conversazionale** completa: `list_scheduled_tasks` +
     `cancel_scheduled_task` (un ricorrente non è più inarrestabile).
   - Ricorrenza **calendar-anchored + timezone DST-aware** (jiff): "daily@08:00",
     "weekly@mon@09:30" con `timezone` IANA. FATTO.
   - Restano: **UI** dedicata (oggi gestibile a voce), verifica live end-to-end.
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
