# Stato del progetto — sintesi audit (mattina 2026-06-13)

> Prodotto in autonomia la notte del 2026-06-12 da un audit a ventaglio (8 agenti read-only,
> uno per dominio) che ha riconciliato `docs/roadmap.md` con la **realtà del codice**.
> Scopo: darti a colpo d'occhio **cosa abbiamo / cosa è rotto / cosa va fatto / cosa migliorare**.
> Confidenza: alta sui verdetti "fatto/non iniziato"; le righe ⚠️ sono **da verificare live**
> (gli agenti leggono il codice, non lo eseguono). I file:line sono indicativi (±qualche riga).

---

## TL;DR

- Il sistema è **molto più completo di quanto dica la roadmap**: ~95% dei pilastri "reattivi"
  (chat, memoria, canali, browser, connettori, sicurezza) sono **fatti e funzionanti**.
- **Il problema vero è la PROATTIVITÀ** (Homun check-in): costruita ma non consegna. Causa
  probabile **doppia** — (1) gate che saltano in silenzio senza log, (2) **`heartbeat()` mai
  chiamato** → il task del check-in può scadere a metà. Da diagnosticare **strumentando i gate**.
- **Deriva roadmap** in entrambe le direzioni: cose segnate TODO sono fatte (Composio #1, #2, #6);
  cose segnate "fatte" non lo sono davvero (heartbeat #78, onboarding Homun, ResourceGovernor nel facade).
- **Veri blocker per la release**: packaging/notarization macOS (0%), heartbeat loop, pulizia
  dati on-delete + retention SQLite. Il resto è rifinitura.

---

## 1. Cosa abbiamo — funzionante (per pilastro)

| Pilastro | Verdetto | Note sintetica |
|---|---|---|
| **Chat / streaming / UX** | ✅ ~95% | OpenAI-compat + **Ollama nativo `/api/chat`** (NDJSON, stream+tool), idle-timeout per-chunk, token live, markdown/code/tabelle, immagini+vision, edit+branch, auto-title. |
| **Composer** | ✅ | toolbar, skill picker, improve-prompt ✨, selettore modello inline, @-file, dettatura whisper. |
| **Allegati** | ✅ | cattura `webUtils.getPathForFile`, ingest (immagini→vision, testo/codice, **PDF testo+scansione** pdfium), **persistenza nel thread** + manifest re-iniettato. |
| **Workbench** | ✅ | pannello destro a tab: File (+git diff), Artefatti, Attività (+cancel), Piano, Memoria; ridimensionabile/fullscreen. |
| **Artifacts & Files** | ✅ (− anteprima PDF) | create/save_artifact, versioning, edit in-app, download; PDF authoring (printpdf). Manca solo l'**anteprima PDF in-app** (nice-to-have). |
| **Memoria & grafo** | ✅ ~95% | M0–M6, F1–F6, dedup **semantico** (embeddings nomic, coseno 0.85), consolidamento deterministico, wiki come 3ª gamba, grafo proiezione rigenerabile, forget per argomento. |
| **Contatti** | ✅ | rubrica A–Z, identity resolution cross-canale, merge self-protected, profili da grafo + provenienza. |
| **Canali (WhatsApp/Telegram)** | ✅ ~95% | C0–C5, inbound→memoria→bozza, auto-reply allowlist, **resilienza offline** (reconnect, offset Telegram forward-before-advance, history-sync WhatsApp + 3 guardie anti-spam). |
| **Approvazione remota + per-contatto** | ✅ | deliver_remote_approval (Telegram bottoni / WhatsApp codice), execute_pending_approval, response_mode (automatic/approve/silent). |
| **Sicurezza** | ✅ | perimetro anti-esfiltrazione (contact_only + can_see_contacts/calendar **fail-closed al dispatch**), dati a riposo 0600 (umask+sweep), segreti cifrati XChaCha20. |
| **Browser capable-first** | ✅ | tool granulari (navigate/snapshot/act/screenshot/tabs/dialog), safety gate condiviso, set-of-marks, vision, sessione per-thread. Legacy (browse_web/RuntimeBrowserLoopPlanner/brain_adapter) **rimosso**. |
| **Contained computer** | ✅ | run_in_sandbox (shell Docker + scan), run_in_project (file path-jailed + build/test sul repo), filesystem nativo, idle reaper 30min. |
| **Grafo-codice (Graphify)** | ✅ backend (UI da verificare live) | import entità/relazioni + `query_code_graph`; mappa progetto on-open (da provare nell'app). |
| **Connettori (Composio/MCP)** | ✅ ~95% | OAuth end-to-end con poll+auto-detect, connect-card in chat, errori azionabili (Composio+MCP), **status + log attività** (#6), Tool Search/find_capability (core piccolo + deferred), suggest_capabilities. |
| **Date/orari** | ✅ | orologio tz-aware, temporal.rs (intento→jiff), resolve_datetime + guardrail submit, TZ nel container. |
| **Loop agentico core** | ✅ inline | plan(update_plan)→act→**verify-by-execution**(run_in_project/test)→record_decision. Non è un orchestratore separato: è il loop del turno (coerente con ADR 0008). |
| **Memoria del "perché"** | ✅ | record_decision + cattura automatica dalle azioni del turno + proiezione wiki. |

**Coerenza ADR:** 12/13 ADR coerenti col codice. Eccezioni: **0011** (addon-host) dormiente by-design; **0008** (Brain) ok ma OperationalPlan resta read-model ibrido (cosmetico).

---

## 2. ⚠️ Rotto o sospetto — DA AFFRONTARE (priorità)

### 2.1 🔴 PROATTIVITÀ HOMUN — non consegna (la tua segnalazione)
**Tutto è costruito e cablato, ma i check-in non arrivano.** Nessun log sui gate → invisibile *perché* salta.
Sospetti in ordine di probabilità (da confermare strumentando):

1. **`heartbeat()` MAI chiamato durante l'esecuzione del task** (CROSS-FINDING dall'audit runtime).
   `LeaseManager.heartbeat()` esiste ed è unit-testato, ma `run_next_task_once` esegue UNO step e non
   lo invoca mai (`crates/desktop-gateway/src/main.rs` ~15157; lease.rs:45-69). Un check-in che fa
   `recall_memory` + ragiona può superare il lease → task requeued/scaduto → **mai consegnato**.
   ⚠️ NB: il task #78 è segnato "fatto" ma heartbeat non è agganciato. **Primo sospetto forte.**
2. **Coda curiosità vuota → skip silenzioso** (`main.rs` ~16129): se `next_pending_curiosity()` è vuota,
   il task ritorna completed senza messaggio. Mining (`mine_curiosities`) rende 0 se memoria personale
   vuota/sparsa o se tutto è dedup-ato. Su install nuova = sempre vuota.
3. **Gate idle / orario / random**: idle in-memory (`seconds_since_user_activity` ~12387) azzerato al
   riavvio; gate 9–22 + 45% random → ~24% degli slot saltano comunque. Combinati possono bloccare quasi sempre.
4. **Recurrence non ri-materializzata**: se `next_recurrence` (scheduler.rs:136-161) ritorna None, il task
   gira una volta e si ferma. Da verificare che `homun_proactive_set` crei una schedule con recurrence valida
   (manca `recurrence_tz`, ~main.rs:1349 → possibile off-by-hour).

**▶ Prima azione domani (P0): STRUMENTARE.** Aggiungere `eprintln!`/log su OGNI gate (skip + motivo),
sul poll del worker, sullo stato del lease e sull'esito del mining. Una sola esecuzione osservata rivela la
causa reale. Poi: agganciare heartbeat nel loop task + (se serve) forzare mining/relax gate.

### 2.2 🟡 Onboarding (#4) — saluto superficiale, non intervista
`homun_greet` esiste (intro + nome + lavoro/vita) ma è **one-shot**; il loop intervista→memoria è
**implicito** via M2 (`is_salient_exchange`, main.rs:3162). Gap: niente intervista guidata multi-turno
(famiglia/ruolo/interessi/obiettivi), niente "ecco cosa ho appreso" + prime curiosità. Prerequisito:
mini "primi passi" statico (modello/chiave → connettori), perché l'onboarding conversazionale richiede un modello.

### 2.3 🟡 Altri "fatto-ma-no" / fragili (da verificare)
- **ResourceGovernor nel facade** (task #79 "fatto"): l'audit lo trova attivo nel worker task ma **non passato
  alla CapabilityFacade** (default) → i tool Composio/MCP non passano dal gate risorse. Verificare.
- **Embeddings best-effort**: se Ollama è giù, il dedup semantico degrada in silenzio → duplicati si accumulano.
- **Wiki sync mono-direzionale** (SQL→file): un'edit utente del wiki può essere sovrascritta al refresh.
- **Read-timeout stdio MCP**: il timeout protegge il turno, non il thread bloccato su `read_line`.
- **Webhook inbound sidecar non valida il token**: qualsiasi processo locale può forgiare un inbound.

---

## 3. Deriva della roadmap (allineare il documento)

**Segnato TODO/parziale ma in realtà FATTO** (la roadmap è indietro):
- **#1 Composio connect-card in chat** poll+auto-detect → FATTO (`9048459`). ✅ già corretto oggi.
- **#2 errori connettori azionabili** (Composio+MCP) → FATTO (`c72da86`). ✅ già corretto oggi.
- **#6 status + audit connettori** → FATTO (`67e8cc1`+frontend). ✅ già corretto oggi.
- **Homun (curiosità/mining/automazioni)** → costruito (ma proattività non gira, vedi §2.1).

**Segnato FATTO ma in realtà NO** (la roadmap è avanti):
- **#78 heartbeat** → la primitiva c'è, **non è chiamata** in esecuzione. ⚠️
- **Onboarding Homun "FATTO"** (roadmap §391-397) → solo saluto, non intervista. ⚠️
- **#79 ResourceGovernor nel facade** → forse non passato alla facade. ⚠️ (verificare)
- **Addon-host (ADR 0011) "FATTO"** → fondamenta + fixture sì, **esecutore fatturazione + generazione NO**
  (dormiente by-design, post-release).

---

## 4. Veri blocker per la prima release

1. **Packaging + notarization macOS — 0%.** Nessun `electron-builder`/config firma. Senza, **non si distribuisce**.
   Serve account Apple Developer + staging del binario gateway in `.app/Contents/Resources/bin` + lifecycle testato.
2. **Heartbeat loop** (vedi §2.1): senza, ogni task lungo (proattività, browser, inference) rischia di scadere.
3. **Pulizia dati on-delete + retention SQLite.** `delete_workspace` lascia **orfani** (chat/memoria non potate);
   nessun GC/VACUUM → i .sqlite crescono illimitati. Export parziale (solo memoria, non thread/contatti/settings).
4. **(UX) Onboarding first-run**: oggi schermata vuota → serve almeno il mini "primi passi" + l'intervista Homun.

Post-release / cloud (non blocker ora): token scoping+rotazione, TLS, logging strutturato, e2e, SQLCipher.

---

## 5. Migliorabile (SOTA) — top pick (oltre ai blocker)

- **Stato epistemico in memoria** (search ≠ fatto): oggi recall mischia fatti utente e risultati di ricerca →
  campo `epistemic_source`. Riduce i "ha programmato un viaggio" dedotti da una ricerca prezzi.
- **Consolidamento su TUTTI i tipi + re-embed periodico**: oggi consolida 4 tipi e 0 nel personale (parafrasi vive).
- **MCP**: secret-store per i token (oggi metadata JSON in chiaro, non cifrati come Composio), always-allow per le
  write MCP, OAuth-remote.
- **Regenerazione grafo incrementale** (oggi all-or-nothing, costo su memoria grande).
- **ChannelProvider trait** (oggi dispatch a stringa sparso): abilita nuovi canali + testabilità.
- **Coda outbound persistente** per i canali (oggi fire-and-forget: messaggi persi se il sidecar è giù).
- **Trash/recovery memoria** (i soft-deleted restano per sempre, invisibili e non recuperabili).

---

## 6. Piano sessione di domani (ordine consigliato)

**Tema:** la proattività è la radice; l'onboarding ci si appoggia (alimenta la memoria che la proattività consuma).

1. **DIAGNOSI proattività (P0)** — strumentare tutti i gate + worker + lease + mining (log), avviare, osservare UNA
   esecuzione reale. Confermare quale dei sospetti §2.1 è la causa.
2. **FIX proattività** — molto probabile: agganciare `heartbeat()` nel loop task (chiude anche il blocker #78);
   poi, secondo i log, sistemare gate/coda/recurrence. Verificare che il check-in arrivi nel thread `homun`.
3. **Onboarding-intervista** — trasformare `homun_greet` in intervista guidata multi-turno che riempie la memoria
   (riusa greet+M2+mining) + "ecco cosa ho appreso" + prime curiosità/automazioni. Aggiungere il mini "primi passi".
4. **Allineare `roadmap.md`** alle correzioni §3 (drift in entrambe le direzioni).
5. (Quando vorrai la release) **packaging/notarization** + **pulizia dati on-delete/retention**.

---

### Appendice — dove guardare (file chiave per domani)
- Proattività: `crates/desktop-gateway/src/main.rs` ~16020 (`execute_proactive_prompt_task`), ~1317
  (`homun_proactive_set`), ~12387 (`seconds_since_user_activity`), ~15157 (`run_next_task_once`),
  `crates/task-runtime/src/scheduler.rs:136` (`next_recurrence`), `lease.rs:45`.
- Onboarding: `main.rs` ~1082 (`HOMUN_GREETING_GOAL`), ~1090 (`homun_greet`), ~787 (`mine_curiosities`), ~3162 (M2).
- Release: `apps/desktop/electron/main.cjs` (lifecycle gateway), `apps/desktop/package.json` (no electron-builder),
  `main.rs` `delete_workspace` (~26728), retention (assente).
